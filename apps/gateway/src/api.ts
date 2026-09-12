import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CodexSupervisor } from "./codex/process.js";
import type { ProjectRegistry } from "./projects.js";
import type { DisplayPrefsStore } from "./display-prefs.js";
import type { AttachmentStore } from "./attachments.js";
import { AppServerRequestError } from "./codex/rpc.js";
import type { RequestParams } from "./protocol.js";
import type { ThreadSourceKind } from "../../../protocol/v2/ThreadSourceKind.js";
import type { SandboxPolicy } from "../../../protocol/v2/SandboxPolicy.js";
import type { UserInput } from "../../../protocol/v2/UserInput.js";
import { runScript, scheduleServiceRestart, serviceStatus, recentLogs, syncCatalog } from "./admin.js";
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

/** Reasoning-effort values the WebUI per-turn selector may send (whitelist). */
const EFFORT_PRESETS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

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

  "projects/list": async (_params, ctx) => ({ projects: ctx.projects.list() }),

  "projects/add": async (params, ctx) => {
    const target = requireString(params?.path, "path", MAX_PATH_CHARS);
    return { project: ctx.projects.add(target, params?.create === true) };
  },

  "projects/remove": async (params, ctx) => {
    ctx.projects.remove(requireString(params?.path, "path"));
    return { ok: true };
  },

  "projects/touch": async (params, ctx) => {
    ctx.projects.touch(requireString(params?.path, "path"));
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
      cursor: typeof params?.cursor === "string" && params.cursor ? params.cursor.slice(0, 512) : undefined,
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

  "thread/list": async (params, ctx) => {
    // The server defaults to "interactive" sources only, which hides threads
    // created through app-server (this WebUI). Ask for every user-facing kind.
    const sourceKinds: ThreadSourceKind[] =
      Array.isArray(params?.sourceKinds)
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
    // Cursor: opaque string, length-capped, passed through unchanged.
    if (typeof params?.cursor === "string" && params.cursor) {
      body.cursor = params.cursor.slice(0, 512);
    }
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
    const registeredCwd = ctx.projects.resolveRegistered(requestedCwd);
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
    const result = await ctx.supervisor.request("thread/delete", { threadId });
    ctx.attachments.cleanupForThread(threadId, threadData ?? {});
    ctx.onThreadDeleted?.(threadId);
    return result;
  },

  "mcpServerStatus/list": async (_params, ctx) => ctx.supervisor.request("mcpServerStatus/list", {}),

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
    if (Array.isArray(params?.attachments)) {
      const fileNotes: string[] = [];
      for (const att of params.attachments) {
        if (!att || typeof att !== "object") throw new Error("attachment entry must be an object");
        const attachmentPath = requireString(att.path, "attachment.path", MAX_PATH_CHARS);
        if (!ctx.attachments.isOwned(attachmentPath)) throw new Error(`附件路径不在上传目录内: ${attachmentPath}`);
        if (att.kind !== undefined && att.kind !== "image" && att.kind !== "file") {
          throw new Error("attachment.kind must be image or file");
        }
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
    input.unshift({ type: "text", text, text_elements: [] });
    const body: RequestParams<"turn/start"> = {
      threadId: requireString(params?.threadId, "threadId", MAX_ID_CHARS),
      input,
    };
    // Collect validated uploads before taking a persisted send reservation.
    let attachmentPaths: string[] = [];
    if (Array.isArray(params?.attachments)) {
      attachmentPaths = params.attachments
        .map((att: any) => (typeof att?.path === "string" && ctx.attachments.isOwned(att.path) ? att.path : null))
        .filter((p: string | null): p is string => !!p);
    }
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
      body.effort = requireEnum(params.effort, "effort", EFFORT_PRESETS);
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
    const reservation = attachmentPaths.length ? ctx.attachments.reservePaths(body.threadId, attachmentPaths) : null;
    try {
      const result = await ctx.supervisor.request("turn/start", body);
      if (reservation) ctx.attachments.settleReservation(reservation, true);
      return result;
    } catch (error) {
      // Only a JSON-RPC error proves rejection. After a lost response keep a
      // conservative reference to the real thread until its history is removed.
      if (reservation) ctx.attachments.settleReservation(reservation, !(error instanceof AppServerRequestError));
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

  "thread/compact/start": async (params, ctx) =>
    ctx.supervisor.request("thread/compact/start", { threadId: requireString(params?.threadId, "threadId", MAX_ID_CHARS) }),

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
    const cwd = ctx.projects.resolveRegistered(requestedCwd);
    if (!cwd) throw new Error("terminal cwd must be an existing registered project");
    const processId = ctx.terminals!.create(ctx.terminalOwner!, params.processId);
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
        cwd,
        size: { rows, cols },
      })
      .then((res: any) => {
        if (epoch !== ctx.terminals!.epoch) return;
        ctx.terminals!.finish(processId, epoch);
        // Deferred final response: the PTY session has ended. Tell the browsers.
        ctx.notify("terminal/exited", { processId, exitCode: res?.exitCode ?? null });
      })
      .catch((err: Error) => {
        if (epoch !== ctx.terminals!.epoch) return;
        ctx.terminals!.finish(processId, epoch);
        process.stderr.write(`[gateway] terminal ${processId} failed: ${err.message}\n`);
        ctx.notify("terminal/exited", { processId, exitCode: null, error: err.message });
      });
    return { processId };
  },

  "terminal/write": async (params, ctx) => {
    const processId = requireString(params?.processId, "processId", MAX_ID_CHARS);
    ctx.terminals!.require(ctx.terminalOwner!, processId);
    return ctx.supervisor.request("command/exec/write", {
      processId,
      deltaBase64: requireBase64(params?.base64, "base64", MAX_TERMINAL_WRITE_BYTES),
    });
  },

  "terminal/resize": async (params, ctx) => {
    const processId = requireString(params?.processId, "processId", MAX_ID_CHARS);
    ctx.terminals!.require(ctx.terminalOwner!, processId);
    return ctx.supervisor.request("command/exec/resize", {
      processId,
      size: {
        rows: boundedInteger(params?.rows, 2, 500, 24),
        cols: boundedInteger(params?.cols, 2, 500, 80),
      },
    });
  },

  "terminal/terminate": async (params, ctx) =>
    ctx.terminals!.terminate(ctx.terminalOwner!, requireString(params?.processId, "processId", MAX_ID_CHARS)),

  // ---- admin: WebUI access to the deploy scripts (settings panel) ----
  // Same authenticated-WS gate as every other method; script paths are fixed,
  // parameters travel as env vars — never as shell strings.

  "admin/status": async (_params, ctx) => {
    const { mode, model } = ctx.providerReader?.readModeAndModel() ?? { mode: "openai", model: "" };
    return { providerMode: mode, currentModel: model, ...await serviceStatus(ctx.supervisor.state, ctx.clientCount?.() ?? 0) };
  },

  "admin/logs": async (params) => ({ logs: await recentLogs(clampLimit(params?.lines, 10, 300, 80)) }),

  "admin/service/restart": async () => {
    scheduleServiceRestart();
    return { ok: true, restarting: true, note: "服务将在约 1 秒后重启，页面会自动重连" };
  },

  "admin/catalog/sync": async (_params, ctx) => {
    if (!ctx.providerReader) throw new Error("admin 未接线（providerReader 缺失）");
    const result = await syncCatalog(ctx.providerReader as any);
    if (result.code === 0) scheduleServiceRestart();
    return {
      ok: result.code === 0,
      mode: result.mode,
      restarting: result.code === 0,
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
          ? { CUSTOM_EFFORT: requireEnum(params.customEffort, "customEffort", EFFORT_PRESETS) }
          : {}),
      });
    }
    if (result.code === 0) scheduleServiceRestart();
    return { ok: result.code === 0, restarting: result.code === 0, output: result.output.slice(-8000) };
  },

  "admin/edge/config": async (params) => {
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      return {
        ok: false,
        restarting: false,
        output: "Caddy/Authelia 是 root 级系统配置；安全默认下网关无此权限。请在服务器运行：sudo codex-harness edge",
      };
    }
    if (params?.disable === true) {
      const result = await runScript("setup-edge.sh", { EDGE_ACTION: "disable" });
      return { ok: result.code === 0, restarting: false, output: result.output.slice(-8000) };
    }
    const domain = requireString(params?.domain, "domain", 253);
    if (!/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})$/.test(domain)) {
      throw new Error("domain is not a valid DNS hostname");
    }
    const listenPort = boundedInteger(params?.listenPort, 1, 65_535, 443);
    if (params?.tls !== undefined && (typeof params.tls !== "string" || !["auto", "own", "selfsigned"].includes(params.tls))) {
      throw new Error("tls must be auto, own or selfsigned");
    }
    const tlsMode = params?.tls === "own" || params?.tls === "selfsigned" ? params.tls : "auto";
    const env: Record<string, string> = {
      EDGE: "caddy-authelia",
      EDGE_DOMAIN: domain,
      EDGE_LISTEN_PORT: String(listenPort),
      EDGE_TLS: tlsMode,
    };
    if (tlsMode === "own" && typeof params?.certDir === "string" && params.certDir) {
      env.EDGE_CERT_DIR = requireString(params.certDir, "certDir", MAX_PATH_CHARS);
    }
    if (typeof params?.username === "string" && params.username) env.EDGE_USER = requireString(params.username, "username", 128);
    if (typeof params?.password === "string" && params.password) env.EDGE_PASS = requireString(params.password, "password", 4096);
    const result = await runScript("setup-edge.sh", env);
    return { ok: result.code === 0, restarting: false, output: result.output.slice(-8000) };
  },
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
