import path from "node:path";
import { randomUUID } from "node:crypto";
import { validateModelEffort } from "./model-capabilities.js";
import type { CodexSupervisor } from "./codex/process.js";
import type { ProjectRegistry } from "./projects.js";
import type { DisplayPrefsStore } from "./display-prefs.js";
import type { AttachmentStore } from "./attachments.js";
import { isDefiniteAppServerRejection } from "./codex/rpc.js";
import type { RequestParams } from "./protocol.js";
import type { ThreadSourceKind } from "../../../protocol/v2/ThreadSourceKind.js";
import type { SandboxPolicy } from "../../../protocol/v2/SandboxPolicy.js";
import type { UserInput } from "../../../protocol/v2/UserInput.js";
import { runScript, scriptChangeResult, scheduleServiceRestart, serviceStatus, recentLogs, syncCatalog } from "./admin.js";
import { TurnDefaults } from "./turn-defaults.js";
import { Terminals } from "./terminals.js";

/**
 * Curated RPC surface exposed to the browser. The gateway authenticates every
 * WebSocket (token cookie + trusted-host allowlist — see auth-token.ts) and
 * sits on loopback behind a TLS reverse proxy with forward-auth. Anything not
 * on this list is unreachable from a browser — e.g. fs/* beyond
 * readDirectory, process/spawn stay gateway-internal.
 */

/** Sanitize a client-supplied pagination limit: integer, clamped, NaN/∞-safe. */
function clampLimit(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

const MAX_PATH_CHARS = 4096;
const MAX_ID_CHARS = 256;
const MAX_MODEL_CHARS = 256;
const MAX_CURSOR_CHARS = 4096;
const MAX_TEXT_CHARS = 2 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_TURN = 32;
const MAX_TERMINAL_WRITE_BYTES = 64 * 1024;

/** Protocol enum ThreadSourceKind — anything else would be rejected (or worse,
 * interpreted unexpectedly) by the app-server. */
const SOURCE_KINDS = new Set<ThreadSourceKind>([
  "cli", "vscode", "exec", "appServer",
  "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown",
]);

export interface ApiContext {
  supervisor: CodexSupervisor;
  workspaceRoot: string;
  gatewayVersion: string;
  projects: ProjectRegistry;
  displayPrefs: DisplayPrefsStore;
  attachments: AttachmentStore;
  providerInfo(): { mode: "openai" | "zhipu" | "custom"; efforts: string[] };
  /** The provider-info reader itself (admin: catalog sync needs live config). */
  providerReader?: { readModeAndModel(): { mode: string; model: string }; customEndpoint(): { baseUrl: string; ctx: number; vision: boolean } | null };
  /** Active turn id the gateway has seen for a thread (turn/interrupt fallback). */
  activeTurnFor?(threadId: string): string | null;
  clientCount?(): number;
  turnDefaults?: Pick<TurnDefaults, "resolve">;
  terminals?: Terminals;
  /** Assigned by the authenticated WebSocket handler, never from RPC params. */
  terminalOwner?: string;
  /** Called after a thread is deleted, so per-thread state can be cleaned. */
  onThreadDeleted?: (threadId: string) => void;
  /** Broadcast a gateway-synthetic notification to all browsers. */
  notify(method: string, params: unknown): void;
}

function requireString(value: unknown, field: string, maxLength = MAX_PATH_CHARS): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing required field: ${field}`);
  if (value.length > maxLength) throw new Error(`${field} is too long (max ${maxLength} characters)`);
  if (value.includes("\0")) throw new Error(`${field} contains a NUL character`);
  return value;
}

function optionalString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireString(value, field, maxLength);
}

function requireEnum<T extends string>(value: unknown, field: string, allowed: ReadonlySet<T>): T {
  const text = requireString(value, field, 64);
  if (!allowed.has(text as T)) throw new Error(`${field} has an unsupported value`);
  return text as T;
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function requireBase64(value: unknown, field: string, maxBytes: number): string {
  const text = requireString(value, field, Math.ceil(maxBytes / 3) * 4);
  if (
    text.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(text)
  ) {
    throw new Error(`${field} is not valid base64`);
  }
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  if ((text.length / 4) * 3 - padding > maxBytes) throw new Error(`${field} exceeds the ${maxBytes}-byte limit`);
  return text;
}

const APPROVAL_POLICIES = new Set(["untrusted", "on-request", "never"] as const);
const THREAD_SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"] as const);
const LOGIN_TYPES = new Set(["chatgptDeviceCode"] as const);

function defaultShellArgv(): string[] {
  if (process.platform === "win32") return [process.env.ComSpec ?? "cmd.exe"];
  return [process.env.SHELL ?? "/bin/bash"];
}

/**
 * Composer sandbox presets → codex SandboxPolicy objects. Keeping the mapping
 * server-side means browsers can only pick curated levels, never inject an
 * arbitrary policy.
 */
const SANDBOX_PRESETS = {
  // Read-only filesystem but LAN/internet sockets allowed (curl/ping/SSH probes).
  network: { type: "readOnly", networkAccess: true },
  // No sandbox at all — the approval policy is the only remaining gate.
  full: { type: "dangerFullAccess" },
} satisfies Record<string, SandboxPolicy>;

/** Pinned protocol uses string; actual support comes from the selected model. */
function requireEffort(value: unknown, field: string): string {
  const effort = requireString(value, field, 32);
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(effort)) throw new Error(`${field} has an unsupported identifier`);
  return effort;
}

type Handler = (params: Record<string, unknown>, ctx: ApiContext) => Promise<unknown>;

const handlers: Record<string, Handler> = {
  "app/status": async (_params, ctx) => {
    const provider = ctx.providerInfo();
    return {
      gatewayVersion: ctx.gatewayVersion,
      codexState: ctx.supervisor.state,
      workspaceRoot: ctx.workspaceRoot,
      providerMode: provider.mode,
      reasoningEfforts: provider.efforts,
      autoCompactThreshold: ctx.displayPrefs.get().autoCompactThreshold,
    };
  },

  // ---- projects (gateway-managed working-directory registry) ----

  "projects/list": async (_params, ctx) => ({ projects: await ctx.projects.list() }),

  "projects/add": async (params, ctx) => {
    const target = requireString(params?.path, "path", MAX_PATH_CHARS);
    return { project: await ctx.projects.add(target, params?.create === true) };
  },

  "projects/remove": async (params, ctx) => {
    await ctx.projects.remove(requireString(params?.path, "path"));
    return { ok: true };
  },

  "projects/touch": async (params, ctx) => {
    await ctx.projects.touch(requireString(params?.path, "path"));
    return { ok: true };
  },

  // ---- timeline display prefs (server-persisted, shared by all browsers) ----

  "displayPrefs/get": async (_params, ctx) => ctx.displayPrefs.get(),

  "displayPrefs/set": async (params, ctx) => {
    const result = ctx.displayPrefs.set(params);
    // Tell every connected browser so their UI updates without a refresh.
    ctx.notify("displayPrefs/updated", result);
    return result;
  },

  // ---- message attachments (browser uploads, referenced by turn/start) ----

  "attachment/upload": async (params, ctx) => {
    const name = requireString(params?.name, "name", 255);
    const base64 = requireBase64(params?.base64, "base64", ctx.attachments.maxFileBytes);
    if (params?.kind !== undefined && params.kind !== "image" && params.kind !== "file") {
      throw new Error("kind must be image or file");
    }
    const kind = params?.kind as "image" | "file" | undefined;
    return ctx.attachments.save(name, base64, kind);
  },

  "attachment/read": async (params, ctx) => ctx.attachments.read(requireString(params?.path, "path")),

  "attachment/delete": async (params, ctx) => {
    const target = requireString(params?.path, "path");
    await ctx.attachments.removeUnreferenced(target);
    return { ok: true };
  },

  // ---- read-only directory listing for the project picker ----

  "fs/readDirectory": async (params, ctx) =>
    ctx.supervisor.request("fs/readDirectory", { path: requireString(params?.path, "path") }),

  "model/list": async (params, ctx) =>
    ctx.supervisor.request("model/list", {
      cursor: optionalString(params?.cursor, "cursor", MAX_CURSOR_CHARS),
      // absent/invalid limit → undefined (server default = full set); a
      // present limit is clamped NaN/∞-safe.
      limit: typeof params?.limit === "number" && Number.isFinite(params.limit)
        ? clampLimit(params.limit, 1, 200, 200)
        : undefined,
    }),

  "account/read": async (_params, ctx) => ctx.supervisor.request("account/read", {}),

  "account/login/start": async (params, ctx) =>
    ctx.supervisor.request("account/login/start", {
      type: requireEnum(params?.type, "type", LOGIN_TYPES),
    }),

  "account/login/cancel": async (params, ctx) =>
    ctx.supervisor.request("account/login/cancel", {
      loginId: requireString(params?.loginId, "loginId", MAX_ID_CHARS),
    }),

  "thread/list": async (params, ctx) => {
    // The server defaults to "interactive" sources only, which hides threads
    // created through app-server (this WebUI). Ask for every user-facing kind.
    if (Array.isArray(params?.sourceKinds) && params.sourceKinds.length > SOURCE_KINDS.size) {
      throw new Error(`sourceKinds has too many entries (max ${SOURCE_KINDS.size})`);
    }
    const sourceKinds: ThreadSourceKind[] = Array.isArray(params?.sourceKinds)
      ? params.sourceKinds.filter((k: unknown): k is ThreadSourceKind => typeof k === "string" && SOURCE_KINDS.has(k as ThreadSourceKind))
      : [];
    const kinds: ThreadSourceKind[] = sourceKinds.length > 0 ? sourceKinds : ["cli", "vscode", "exec", "appServer"];
    // Server-side sort must match what the sidebar displays — the frontend
    // must NOT re-sort paginated results (cursor order is opaque).
    const body: RequestParams<"thread/list"> = {
      sortKey: "updated_at",
      sortDirection: "desc",
      limit: clampLimit(params?.limit, 1, 100, 50),
      sourceKinds: kinds,
    };
    // Cursors are opaque. Never truncate one into a different token.
    const cursor = optionalString(params?.cursor, "cursor", MAX_CURSOR_CHARS);
    if (cursor) body.cursor = cursor;
    // Search: trim, empty → omitted, max 200 chars (server searches titles).
    if (typeof params?.searchTerm === "string" && params.searchTerm.trim()) {
      body.searchTerm = params.searchTerm.trim().slice(0, 200);
    }
    // Archived: boolean toggle (default = current/unarchived).
    if (typeof params?.archived === "boolean") body.archived = params.archived;
    // Per-project filter: the sidebar scopes sessions to the selected cwd.
    if (typeof params?.cwd === "string" && params.cwd) body.cwd = requireString(params.cwd, "cwd", MAX_PATH_CHARS);
    return ctx.supervisor.request("thread/list", body);
  },

  "thread/start": async (params, ctx) => {
    const body: RequestParams<"thread/start"> = {};
    const requestedCwd = optionalString(params?.cwd, "cwd", MAX_PATH_CHARS) ?? ctx.workspaceRoot;
    const registeredCwd = await ctx.projects.resolveRegistered(requestedCwd);
    if (!registeredCwd) throw new Error("cwd must be an existing registered project");
    body.cwd = registeredCwd;
    const model = optionalString(params?.model, "model", MAX_MODEL_CHARS);
    if (model) body.model = model;
    if (params?.approvalPolicy !== undefined && params.approvalPolicy !== null && params.approvalPolicy !== "") {
      body.approvalPolicy = requireEnum(params.approvalPolicy, "approvalPolicy", APPROVAL_POLICIES);
    }
    if (params?.sandbox !== undefined && params.sandbox !== null && params.sandbox !== "") {
      body.sandbox = requireEnum(params.sandbox, "sandbox", THREAD_SANDBOX_MODES);
    }
    return ctx.supervisor.request("thread/start", body);
  },

  "thread/resume": async (params, ctx) =>
    ctx.supervisor.request("thread/resume", { threadId: requireString(params?.threadId, "threadId", MAX_ID_CHARS) }),

  "thread/read": async (params, ctx) =>
    ctx.supervisor.request("thread/read", {
      threadId: requireString(params?.threadId, "threadId", MAX_ID_CHARS),
      // includeTurns gives the FULL rollout history — thread/resume's initial
      // page is summary-viewed and page-capped, which truncated old messages.
      ...(params?.includeTurns === true ? { includeTurns: true } : {}),
    }),

  "thread/archive": async (params, ctx) => {
    const threadId = requireString(params?.threadId, "threadId", MAX_ID_CHARS);
    const result = await ctx.supervisor.request("thread/archive", { threadId });
    ctx.onThreadDeleted?.(threadId);
    return result;
  },

  "thread/unarchive": async (params, ctx) =>
    ctx.supervisor.request("thread/unarchive", { threadId: requireString(params?.threadId, "threadId", MAX_ID_CHARS) }),

  "thread/delete": async (params, ctx) => {
    const threadId = requireString(params?.threadId, "threadId", MAX_ID_CHARS);
    // Read the thread first so its attachment references can be cleaned up.
    // includeTurns is required — without it the response has no items and
    // cleanupForThread() would find nothing to delete.
    let threadData: unknown = null;
    try {
      threadData = await ctx.supervisor.request("thread/read", { threadId, includeTurns: true });
    } catch {
      /* thread may already be gone; nothing to clean */
    }
    ctx.attachments.beginThreadDeletion(threadId);
    let result;
    try { result = await ctx.supervisor.request("thread/delete", { threadId }); }
    catch (error) {
      if (isDefiniteAppServerRejection(error)) ctx.attachments.cancelThreadDeletion(threadId);
      throw error;
    }
    ctx.attachments.cleanupForThread(threadId, threadData ?? {});
    ctx.onThreadDeleted?.(threadId);
    return result;
  },

  "mcpServerStatus/list": async (params, ctx) => {
    const body: RequestParams<"mcpServerStatus/list"> = {};
    const cursor = optionalString(params.cursor, "cursor", 4096);
    const threadId = optionalString(params.threadId, "threadId", MAX_ID_CHARS);
    if (cursor) body.cursor = cursor;
    if (threadId) body.threadId = threadId;
    if (params.limit != null) body.limit = clampLimit(params.limit, 1, 200, 200);
    if (params.detail != null) body.detail = requireEnum(params.detail, "detail", new Set(["full", "toolsAndAuthOnly"] as const));
    return ctx.supervisor.request("mcpServerStatus/list", body);
  },

  "thread/name/set": async (params, ctx) =>
    ctx.supervisor.request("thread/name/set", {
      threadId: requireString(params?.threadId, "threadId", MAX_ID_CHARS),
      name: requireString(params?.name, "name", 200),
    }),

  "turn/start": async (params, ctx) => {
    // Empty text is valid for attachment-only messages (the Composer allows
    // sending files without typing anything); completely empty turns are not.
    let text = typeof params?.text === "string" ? params.text : "";
    if (text.length > MAX_TEXT_CHARS) throw new Error(`text is too long (max ${MAX_TEXT_CHARS} characters)`);
    if (text.includes("\0")) throw new Error("text contains a NUL character");
    if (params?.attachments !== undefined && !Array.isArray(params.attachments)) {
      throw new Error("attachments must be an array");
    }
    if (Array.isArray(params?.attachments) && params.attachments.length > MAX_ATTACHMENTS_PER_TURN) {
      throw new Error(`too many attachments (max ${MAX_ATTACHMENTS_PER_TURN})`);
    }
    const hasAttachments = Array.isArray(params?.attachments) && params.attachments.length > 0;
    if (!text.trim() && !hasAttachments) throw new Error("missing required field: text");
    // UserInput.text requires the text_elements field on the wire.
    const input: UserInput[] = [];
    const attachmentPaths: string[] = [];
    if (Array.isArray(params?.attachments)) {
      const fileNotes: string[] = [];
      for (const att of params.attachments) {
        if (!att || typeof att !== "object") throw new Error("attachment entry must be an object");
        let attachmentPath = requireString(att.path, "attachment.path", MAX_PATH_CHARS);
        if (att.kind !== undefined && att.kind !== "image" && att.kind !== "file") {
          throw new Error("attachment.kind must be image or file");
        }
        if (att.kind === "image") {
          // Upload kind is not authoritative: reapply the stricter image cap
          // and filesystem-identity checks at the point localImage is built.
          attachmentPath = ctx.attachments.validateImageForSend(attachmentPath);
        } else if (!ctx.attachments.isOwned(attachmentPath)) {
          throw new Error(`附件路径不在上传目录内: ${attachmentPath}`);
        }
        attachmentPaths.push(attachmentPath);
        const name = optionalString(att.name, "attachment.name", 255) ?? path.basename(attachmentPath);
        if (att?.kind === "image") {
          // codex handles localImage natively (vision MCP for text-only models).
          input.push({ type: "localImage", path: attachmentPath });
        } else {
          // mention UserInput is not expanded server-side; tell the model where
          // the file lives so it can read it with its own file tools.
          fileNotes.push(`[附件 ${name}] 位于服务器路径: ${attachmentPath}`);
        }
      }
      if (fileNotes.length) text += `\n\n${fileNotes.join("\n")}`;
    }
    if (text.length > MAX_TEXT_CHARS) throw new Error(`text with attachment notes is too long (max ${MAX_TEXT_CHARS} characters)`);
    input.unshift({ type: "text", text, text_elements: [] });
    const body: RequestParams<"turn/start"> = {
      threadId: requireString(params?.threadId, "threadId", MAX_ID_CHARS),
      input,
    };
    // Browser null means project/provider default. The pinned app-server treats
    // null as no change, so resolve and send actual values instead.
    if (params?.model !== null) {
      const model = optionalString(params?.model, "model", MAX_MODEL_CHARS);
      if (model) body.model = model;
    }
    if (params?.approvalPolicy != null && params.approvalPolicy !== "") {
      body.approvalPolicy = requireEnum(params.approvalPolicy, "approvalPolicy", APPROVAL_POLICIES);
    }
    if (params?.effort != null && params.effort !== "") {
      body.effort = requireEffort(params.effort, "effort");
    }
    if (params?.sandbox != null && params.sandbox !== "") {
      const sandbox = requireString(params.sandbox, "sandbox", 32);
      if (!Object.hasOwn(SANDBOX_PRESETS, sandbox)) throw new Error("sandbox has an unsupported value");
      body.sandboxPolicy = SANDBOX_PRESETS[sandbox as keyof typeof SANDBOX_PRESETS];
    }
    if (["model", "approvalPolicy", "sandbox", "effort"].some((key) => params[key] === null)) {
      let effortModel = body.model ?? undefined;
      if (params.effort === null && params.model !== null && !effortModel) {
        // Partial clients can reset effort while retaining the current model.
        effortModel = (await ctx.supervisor.request("thread/resume", { threadId: body.threadId })).model;
      }
      const defaults = await ctx.turnDefaults!.resolve(body.threadId, effortModel);
      if (params.model === null) body.model = defaults.model;
      if (params.approvalPolicy === null) body.approvalPolicy = defaults.approvalPolicy;
      if (params.sandbox === null) body.sandboxPolicy = defaults.sandbox;
      if (params.effort === null) {
        if (!defaults.reasoningEffort) throw new Error("无法解析默认推理强度，请明确选择后重试");
        body.effort = defaults.reasoningEffort;
      }
    }
    // An explicit browser override must be advertised by this model. A null
    // reset instead uses the pinned server's effective default, which can be
    // valid even when an unprobed/non-reasoning model advertises no overrides.
    // Still send that concrete default to clear a previous sticky effort.
    if (body.effort && params.effort !== null) await validateModelEffort(ctx.supervisor, body.threadId, body.model ?? undefined, body.effort);
    const reservation = attachmentPaths.length ? ctx.attachments.reservePaths(body.threadId, attachmentPaths) : null;
    try {
      const result = await ctx.supervisor.request("turn/start", body);
      if (reservation) ctx.attachments.settleReservation(reservation, true);
      return result;
    } catch (error) {
      // Only a JSON-RPC error proves rejection. After a lost response keep a
      // conservative reference to the real thread until its history is removed.
      const definite = isDefiniteAppServerRejection(error);
      if (reservation) ctx.attachments.settleReservation(reservation, !definite, !definite);
      if (!definite && error instanceof Error) {
        Object.assign(error, { delivery: "unknown" });
      }
      throw error;
    }
  },

  "turn/interrupt": async (params, ctx) => {
    const threadId = requireString(params?.threadId, "threadId", MAX_ID_CHARS);
    // turnId is optional: after a page refresh the browser may not know the
    // active turn id — fall back to the one the gateway saw on turn/started.
    let turnId = typeof params?.turnId === "string" && params.turnId
      ? requireString(params.turnId, "turnId", MAX_ID_CHARS)
      : null;
    if (!turnId && ctx.activeTurnFor) turnId = ctx.activeTurnFor(threadId);
    if (!turnId) throw new Error("没有正在进行的回合（刷新后首次发送前无法停止）");
    return ctx.supervisor.request("turn/interrupt", { threadId, turnId });
  },

  "thread/compact/start": async (params, ctx) => {
    const threadId = requireString(params?.threadId, "threadId", MAX_ID_CHARS);
    try { return await ctx.supervisor.request("thread/compact/start", { threadId }); }
    catch (error) {
      if (error instanceof Error && !isDefiniteAppServerRejection(error)) Object.assign(error, { delivery: "unknown" });
      throw error;
    }
  },

  /**
   * Opens a PTY shell on the server. `processId` is client-supplied on this
   * protocol, so the gateway mints one and hands it back immediately — the
   * underlying `command/exec` response only resolves at process exit, so it
   * must not be awaited here. Streamed bytes arrive via
   * `command/exec/outputDelta` notifications meanwhile.
   */
  "terminal/exec": async (params, ctx) => {
    // Never enqueue an untracked shell across an app-server restart. Unlike a
    // normal request, a terminal is leased to this exact live connection epoch.
    if (ctx.supervisor.state !== "ready") throw new Error("app-server is not ready; retry opening the terminal after restart");
    const rows = boundedInteger(params?.rows, 2, 500, 24);
    const cols = boundedInteger(params?.cols, 2, 500, 80);
    const requestedCwd = optionalString(params?.cwd, "cwd", MAX_PATH_CHARS) ?? ctx.workspaceRoot;
    const cwd = await ctx.projects.resolveRegistered(requestedCwd);
    if (!cwd) throw new Error("terminal cwd must be an existing registered project");
    const processId = ctx.terminals!.create(ctx.terminalOwner!, params.processId);
    ctx.notify("terminal/started", { processId });
    const epoch = ctx.terminals!.epoch;
    // The terminal intentionally provides a shell with the service account's
    // OS permissions, independent of turn sandbox settings. Fix its argv/env
    // and limit the initial cwd to registered projects; this is not an OS jail.
    void ctx.supervisor
      .request("command/exec", {
        command: defaultShellArgv(),
        processId,
        tty: true,
        streamStdoutStderr: true,
        disableTimeout: true,
        // Deliberate administrator terminal, not an accidental dependency on
        // whatever turn sandbox happens to be configured in this generation.
        sandboxPolicy: { type: "dangerFullAccess" },
        cwd,
        size: { rows, cols },
      })
      .then((res: any) => {
        if (epoch !== ctx.terminals!.epoch) return;
        ctx.terminals!.finish(processId, epoch);
        // Deferred final response: the PTY session has ended. Tell the browsers.
        const exitCode = Number.isSafeInteger(res?.exitCode) && res.exitCode >= -2_147_483_648 && res.exitCode <= 2_147_483_647
          ? res.exitCode : null;
        ctx.notify("terminal/exited", { processId, exitCode });
      })
      .catch((err: Error) => {
        if (epoch !== ctx.terminals!.epoch) return;
        ctx.terminals!.finish(processId, epoch);
        const message = (typeof err?.message === "string" ? err.message : "terminal command failed").slice(0, 2_000);
        process.stderr.write(`[gateway] terminal ${processId} failed: ${message}\n`);
        ctx.notify("terminal/exited", { processId, exitCode: null, error: message });
      });
    return { processId };
  },

  "terminal/write": async (params, ctx) => {
    const processId = requireString(params?.processId, "processId", MAX_ID_CHARS);
    ctx.terminals!.require(ctx.terminalOwner!, processId);
    await ctx.supervisor.request("command/exec/write", {
      processId,
      deltaBase64: requireBase64(params?.base64, "base64", MAX_TERMINAL_WRITE_BYTES),
    });
    return { ok: true };
  },

  "terminal/resize": async (params, ctx) => {
    const processId = requireString(params?.processId, "processId", MAX_ID_CHARS);
    ctx.terminals!.require(ctx.terminalOwner!, processId);
    await ctx.supervisor.request("command/exec/resize", {
      processId,
      size: {
        rows: boundedInteger(params?.rows, 2, 500, 24),
        cols: boundedInteger(params?.cols, 2, 500, 80),
      },
    });
    return { ok: true };
  },

  "terminal/terminate": async (params, ctx) => {
    await ctx.terminals!.terminate(ctx.terminalOwner!, requireString(params?.processId, "processId", MAX_ID_CHARS));
    return { ok: true };
  },

  // ---- admin: WebUI access to the deploy scripts (settings panel) ----
  // Same authenticated-WS gate as every other method; script paths are fixed,
  // parameters travel as env vars — never as shell strings.

  "admin/status": async (_params, ctx) => {
    const { mode, model } = ctx.providerReader?.readModeAndModel() ?? { mode: "openai", model: "" };
    return { providerMode: mode, currentModel: model, ...await serviceStatus(ctx.supervisor.state, ctx.clientCount?.() ?? 0) };
  },

  "admin/logs": async (params) => ({ logs: await recentLogs(clampLimit(params?.lines, 10, 300, 80)) }),

  "admin/service/restart": async () => {
    void scheduleServiceRestart().catch((error) => process.stderr.write(`[admin] restart failed: ${error.message}\n`));
    return { ok: true, restarting: true, note: "服务将在约 1 秒后重启，页面会自动重连" };
  },

  "admin/catalog/sync": async (_params, ctx) => {
    if (!ctx.providerReader) throw new Error("admin 未接线（providerReader 缺失）");
    const result = await syncCatalog(ctx.providerReader as any);
    if (result.restartRequired) void scheduleServiceRestart().catch((error) => process.stderr.write(`[admin] restart failed: ${error.message}\n`));
    return {
      ok: result.code === 0,
      mode: result.mode,
      changed: result.changed === true,
      restartRequired: result.restartRequired === true,
      restarting: result.restartRequired === true,
      executionPending: result.executionPending === true,
      output: result.output.slice(-8000),
    };
  },

  "admin/provider/switch": async (params) => {
    const mode = requireString(params?.mode, "mode");
    if (!["openai", "zhipu", "custom"].includes(mode)) throw new Error("mode 必须是 openai/zhipu/custom");
    let result: { code: number; output: string };
    if (mode === "openai") {
      result = await runScript("providers/openai/setup.sh", {});
    } else if (mode === "zhipu") {
      const suppliedKey = typeof params?.zhipuKey === "string" && params.zhipuKey
        ? requireString(params.zhipuKey, "zhipuKey", 16_384)
        : "";
      if (!suppliedKey && !process.env.Z_AI_API_KEY) {
        throw new Error("缺少智谱 API Key（设置里填写或服务器 env 提供）");
      }
      // An existing key is already inherited under its canonical env name and
      // read from ENV_FILE by the setup script. Only a user-supplied rotation
      // needs the transient ZHIPU_KEY migration variable.
      const env: Record<string, string> = suppliedKey ? { ZHIPU_KEY: suppliedKey } : {};
      if (typeof params?.model === "string" && params.model) env.ZHIPU_MODEL = requireString(params.model, "model", MAX_MODEL_CHARS);
      result = await runScript("providers/zhipu-coding-plan/setup.sh", env);
    } else {
      const baseUrl = requireString(params?.customBaseUrl, "customBaseUrl", 2048);
      if (/[\u0000-\u001f\u007f]/.test(baseUrl)) throw new Error("customBaseUrl must not contain control characters");
      let parsedUrl: URL;
      try { parsedUrl = new URL(baseUrl); } catch { throw new Error("customBaseUrl must be a valid URL"); }
      if (!/^https?:$/.test(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
        throw new Error("customBaseUrl must be an http(s) URL without credentials, query, or fragment");
      }
      const model = requireString(params?.customModel, "customModel", MAX_MODEL_CHARS);
      const customKey = params?.customApiKey === undefined || params.customApiKey === ""
        ? ""
        : requireString(params.customApiKey, "customApiKey", 16_384);
      result = await runScript("providers/custom-openai/setup.sh", {
        CUSTOM_BASE_URL: baseUrl,
        CUSTOM_MODEL: model,
        ...(customKey ? { CUSTOM_API_KEY: customKey } : {}),
        ...(params?.customCtx !== undefined
          ? { CUSTOM_CTX: String(boundedInteger(params.customCtx, 1024, 16_777_216, 131_072)) }
          : {}),
        ...(params?.customVision === true ? { CUSTOM_VISION: "1" } : {}),
        ...(params?.customEffort !== undefined && params.customEffort !== ""
          ? { CUSTOM_EFFORT: requireEffort(params.customEffort, "customEffort") }
          : {}),
      });
    }
    const status = scriptChangeResult(result);
    if (status.restartRequired) void scheduleServiceRestart().catch((error) => process.stderr.write(`[admin] restart failed: ${error.message}\n`));
    return { ok: status.code === 0, changed: status.changed === true, restartRequired: status.restartRequired === true, restarting: status.restartRequired === true, executionPending: status.executionPending === true, output: status.output.slice(-8000) };
  },

  // Kept as a read-only compatibility response for older browser bundles.
  // Root-only edge mutation has no place in either supported service account.
  "admin/edge/config": async () => ({
    ok: false,
    changed: false,
    restartRequired: false,
    restarting: false,
    output: "Caddy/Authelia 是 root 级系统配置，网页不提供此权限。请在服务器运行：sudo codex-harness edge（自定义实例请使用其管理命令）",
  }),
};

export function makeDispatcher(ctx: ApiContext) {
  const owner = randomUUID();
  const terminals = ctx.terminals ?? new Terminals((processId) => ctx.supervisor.request("command/exec/terminate", { processId }));
  terminals.connect(owner);
  const shared = { ...ctx, terminals, turnDefaults: ctx.turnDefaults ?? new TurnDefaults(ctx.supervisor) };
  return async function dispatch(method: string, params: unknown, clientId = owner): Promise<unknown> {
    const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined;
    if (!handler) throw new Error(`method not allowed: ${method}`);
    if (params !== undefined && params !== null && (typeof params !== "object" || Array.isArray(params))) {
      throw new Error("RPC params must be an object");
    }
    return handler((params ?? {}) as Record<string, unknown>, { ...shared, terminalOwner: clientId });
  };
}
