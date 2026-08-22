import path from "node:path";
import type { CodexSupervisor } from "./codex/process.js";
import type { ProjectRegistry } from "./projects.js";
import type { DisplayPrefsStore } from "./display-prefs.js";
import type { AttachmentStore } from "./attachments.js";
import type { ProviderInfoReader } from "./provider-info.js";
import { runScript, scheduleServiceRestart, serviceStatus, recentLogs, syncCatalog } from "./admin.js";

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

/** Protocol enum ThreadSourceKind — anything else would be rejected (or worse,
 * interpreted unexpectedly) by the app-server. */
const SOURCE_KINDS = new Set([
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
  providerReader?: { readModeAndModel(): { mode: string; model: string }; customEndpoint(): { baseUrl: string; token: string; ctx: number; vision: boolean } | null };
  /** Active turn id the gateway has seen for a thread (turn/interrupt fallback). */
  activeTurnFor?(threadId: string): string | null;
  /** Called after a thread is deleted, so per-thread state can be cleaned. */
  onThreadDeleted?: (threadId: string) => void;
  /** Broadcast a gateway-synthetic notification to all browsers. */
  notify(method: string, params: unknown): void;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing required field: ${field}`);
  return value;
}

function defaultShellArgv(): string[] {
  if (process.platform === "win32") return [process.env.ComSpec ?? "cmd.exe"];
  return [process.env.SHELL ?? "/bin/bash"];
}

/**
 * Composer sandbox presets → codex SandboxPolicy objects. Keeping the mapping
 * server-side means browsers can only pick curated levels, never inject an
 * arbitrary policy.
 */
const SANDBOX_PRESETS: Record<string, Record<string, unknown>> = {
  // Read-only filesystem but LAN/internet sockets allowed (curl/ping/SSH probes).
  network: { type: "readOnly", networkAccess: true },
  // No sandbox at all — the approval policy is the only remaining gate.
  full: { type: "dangerFullAccess" },
};

/** Reasoning-effort values the WebUI per-turn selector may send (whitelist). */
const EFFORT_PRESETS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

type Handler = (params: any, ctx: ApiContext) => Promise<unknown>;

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
    const target = requireString(params?.path, "path");
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
    const name = requireString(params?.name, "name");
    const base64 = requireString(params?.base64, "base64");
    const kind = params?.kind === "image" || params?.kind === "file" ? params.kind : undefined;
    return ctx.attachments.save(name, base64, kind);
  },

  "attachment/read": async (params, ctx) => ctx.attachments.read(requireString(params?.path, "path")),

  "attachment/delete": async (params, ctx) => {
    const target = requireString(params?.path, "path");
    // Respect the refcount registry: a file another (still-living) thread
    // references must not be removed from under it. Pending, unsent uploads
    // (the normal delete path) were never registered and delete fine.
    const owners = ctx.attachments.registeredOwners(target);
    if (owners.length > 0) {
      throw new Error(`附件正被 ${owners.length} 个会话引用（${owners.slice(0, 3).join("、")}…），删除会破坏那些会话的历史附件；请先删除引用它的会话`);
    }
    ctx.attachments.remove(target);
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

  "account/read": async (_params, ctx) => ctx.supervisor.request("account/read"),

  "account/login/start": async (params, ctx) =>
    ctx.supervisor.request("account/login/start", {
      type: requireString(params?.type, "type"),
    }),

  "thread/list": async (params, ctx) => {
    // The server defaults to "interactive" sources only, which hides threads
    // created through app-server (this WebUI). Ask for every user-facing kind.
    const sourceKinds: string[] =
      Array.isArray(params?.sourceKinds)
        ? params.sourceKinds.filter((k: unknown) => typeof k === "string" && SOURCE_KINDS.has(k as string))
        : [];
    const kinds = sourceKinds.length > 0 ? sourceKinds : ["cli", "vscode", "exec", "appServer"];
    // Server-side sort must match what the sidebar displays — the frontend
    // must NOT re-sort paginated results (cursor order is opaque).
    const body: Record<string, unknown> = {
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
    if (typeof params?.cwd === "string" && params.cwd) body.cwd = params.cwd;
    return ctx.supervisor.request("thread/list", body);
  },

  "thread/start": async (params, ctx) => {
    const body: Record<string, unknown> = {};
    body.cwd = typeof params?.cwd === "string" && params.cwd ? params.cwd : ctx.workspaceRoot;
    if (typeof params?.model === "string") body.model = params.model;
    if (typeof params?.approvalPolicy === "string") body.approvalPolicy = params.approvalPolicy;
    if (typeof params?.sandbox === "string") body.sandbox = params.sandbox;
    return ctx.supervisor.request("thread/start", body);
  },

  "thread/resume": async (params, ctx) =>
    ctx.supervisor.request("thread/resume", { threadId: requireString(params?.threadId, "threadId") }),

  "thread/read": async (params, ctx) =>
    ctx.supervisor.request("thread/read", {
      threadId: requireString(params?.threadId, "threadId"),
      // includeTurns gives the FULL rollout history — thread/resume's initial
      // page is summary-viewed and page-capped, which truncated old messages.
      ...(params?.includeTurns === true ? { includeTurns: true } : {}),
    }),

  "thread/archive": async (params, ctx) => {
    const threadId = requireString(params?.threadId, "threadId");
    const result = await ctx.supervisor.request("thread/archive", { threadId });
    ctx.onThreadDeleted?.(threadId);
    return result;
  },

  "thread/unarchive": async (params, ctx) =>
    ctx.supervisor.request("thread/unarchive", { threadId: requireString(params?.threadId, "threadId") }),

  "thread/delete": async (params, ctx) => {
    const threadId = requireString(params?.threadId, "threadId");
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
    if (threadData) ctx.attachments.cleanupForThread(threadId, threadData);
    ctx.onThreadDeleted?.(threadId);
    return result;
  },

  "mcpServerStatus/list": async (_params, ctx) => ctx.supervisor.request("mcpServerStatus/list", {}),

  "thread/name/set": async (params, ctx) =>
    ctx.supervisor.request("thread/name/set", {
      threadId: requireString(params?.threadId, "threadId"),
      name: requireString(params?.name, "name"),
    }),

  "turn/start": async (params, ctx) => {
    // Empty text is valid for attachment-only messages (the Composer allows
    // sending files without typing anything); completely empty turns are not.
    let text = typeof params?.text === "string" ? params.text : "";
    const hasAttachments = Array.isArray(params?.attachments) && params.attachments.length > 0;
    if (!text.trim() && !hasAttachments) throw new Error("missing required field: text");
    // UserInput.text requires the text_elements field on the wire.
    const input: Array<Record<string, unknown>> = [];
    if (Array.isArray(params?.attachments)) {
      const fileNotes: string[] = [];
      for (const att of params.attachments) {
        if (typeof att?.path !== "string" || !att.path) continue;
        if (!ctx.attachments.isOwned(att.path)) throw new Error(`附件路径不在上传目录内: ${att.path}`);
        const name = typeof att?.name === "string" && att.name ? att.name : path.basename(att.path);
        if (att?.kind === "image") {
          // codex handles localImage natively (vision MCP for text-only models).
          input.push({ type: "localImage", path: att.path });
        } else {
          // mention UserInput is not expanded server-side; tell the model where
          // the file lives so it can read it with its own file tools.
          fileNotes.push(`[附件 ${name}] 位于服务器路径: ${att.path}`);
        }
      }
      if (fileNotes.length) text += `\n\n${fileNotes.join("\n")}`;
    }
    input.unshift({ type: "text", text, text_elements: [] });
    const body: Record<string, unknown> = {
      threadId: requireString(params?.threadId, "threadId"),
      input,
    };
    // Attachment paths to register in the refcount registry — AFTER a
    // successful turn/start, so failed turns never pollute the registry
    // (their files get deleted by the frontend's attachment/delete cleanup).
    let attachmentPaths: string[] = [];
    if (Array.isArray(params?.attachments)) {
      attachmentPaths = params.attachments
        .map((att: any) => (typeof att?.path === "string" && ctx.attachments.isOwned(att.path) ? att.path : null))
        .filter((p: string | null): p is string => !!p);
    }
    // Per-turn overrides (composer selections apply immediately). These are
    // sticky on the app-server ("this turn and subsequent turns"), so an
    // explicit null is meaningful: it resets to the thread/server default.
    if (params?.model === null) body.model = null;
    else if (typeof params?.model === "string" && params.model) body.model = params.model;
    if (params?.approvalPolicy === null) body.approvalPolicy = null;
    else if (typeof params?.approvalPolicy === "string" && params.approvalPolicy) body.approvalPolicy = params.approvalPolicy;
    if (params?.effort === null) body.effort = null;
    else if (typeof params?.effort === "string" && EFFORT_PRESETS.has(params.effort)) body.effort = params.effort;
    if (params?.sandbox === null) body.sandboxPolicy = null;
    else if (typeof params?.sandbox === "string" && SANDBOX_PRESETS[params.sandbox]) {
      body.sandboxPolicy = SANDBOX_PRESETS[params.sandbox];
    }
    const result = await ctx.supervisor.request("turn/start", body);
    // The turn was accepted — the thread now durably references these files.
    if (attachmentPaths.length) ctx.attachments.rememberPaths(String(body.threadId), attachmentPaths);
    return result;
  },

  "turn/interrupt": async (params, ctx) => {
    const threadId = requireString(params?.threadId, "threadId");
    // turnId is optional: after a page refresh the browser may not know the
    // active turn id — fall back to the one the gateway saw on turn/started.
    let turnId = typeof params?.turnId === "string" && params.turnId ? params.turnId : null;
    if (!turnId && ctx.activeTurnFor) turnId = ctx.activeTurnFor(threadId);
    if (!turnId) throw new Error("没有正在进行的回合（刷新后首次发送前无法停止）");
    return ctx.supervisor.request("turn/interrupt", { threadId, turnId });
  },

  "thread/compact/start": async (params, ctx) =>
    ctx.supervisor.request("thread/compact/start", { threadId: requireString(params?.threadId, "threadId") }),

  /**
   * Opens a PTY shell on the server. `processId` is client-supplied on this
   * protocol, so the gateway mints one and hands it back immediately — the
   * underlying `command/exec` response only resolves at process exit, so it
   * must not be awaited here. Streamed bytes arrive via
   * `command/exec/outputDelta` notifications meanwhile.
   */
  "terminal/exec": async (params, ctx) => {
    const processId = `term-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const rows = typeof params?.rows === "number" ? params.rows : 24;
    const cols = typeof params?.cols === "number" ? params.cols : 80;
    // The WebUI terminal is a SHELL, not an arbitrary program launcher: the
    // browser cannot pick argv, env, or cwd. A compromised page that gets a
    // WS connection must not gain "run any binary" beyond what the
    // interactive shell itself provides (commands typed by the human).
    // cwd/env stay server-chosen for the same reason.
    void ctx.supervisor
      .request("command/exec", {
        command: defaultShellArgv(),
        processId,
        tty: true,
        streamStdoutStderr: true,
        disableTimeout: true,
        cwd: ctx.workspaceRoot,
        size: { rows, cols },
      })
      .then((res: any) => {
        // Deferred final response: the PTY session has ended. Tell the browsers.
        ctx.notify("terminal/exited", { processId, exitCode: res?.exitCode ?? null });
      })
      .catch((err: Error) => {
        process.stderr.write(`[gateway] terminal ${processId} failed: ${err.message}\n`);
        ctx.notify("terminal/exited", { processId, exitCode: null, error: err.message });
      });
    return { processId };
  },

  "terminal/write": async (params, ctx) =>
    ctx.supervisor.request("command/exec/write", {
      processId: requireString(params?.processId, "processId"),
      deltaBase64: requireString(params?.base64, "base64"),
    }),

  "terminal/resize": async (params, ctx) =>
    ctx.supervisor.request("command/exec/resize", {
      processId: requireString(params?.processId, "processId"),
      size: {
        rows: typeof params?.rows === "number" ? params.rows : 24,
        cols: typeof params?.cols === "number" ? params.cols : 80,
      },
    }),

  "terminal/terminate": async (params, ctx) =>
    ctx.supervisor.request("command/exec/terminate", { processId: requireString(params?.processId, "processId") }),

  // ---- admin: WebUI access to the deploy scripts (settings panel) ----
  // Same authenticated-WS gate as every other method; script paths are fixed,
  // parameters travel as env vars — never as shell strings.

  "admin/status": async (_params, ctx) => {
    const { mode, model } = ctx.providerReader?.readModeAndModel() ?? { mode: "openai", model: "" };
    return { providerMode: mode, currentModel: model, ...serviceStatus() };
  },

  "admin/logs": async (params) => ({ logs: recentLogs(clampLimit(params?.lines, 10, 300, 80)) }),

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

  "admin/provider/switch": async (params, ctx) => {
    const mode = requireString(params?.mode, "mode");
    if (!["openai", "zhipu", "custom"].includes(mode)) throw new Error("mode 必须是 openai/zhipu/custom");
    let result: { code: number; output: string };
    if (mode === "openai") {
      result = await runScript("providers/openai/setup.sh", {});
    } else if (mode === "zhipu") {
      const key = typeof params?.zhipuKey === "string" && params.zhipuKey
        ? params.zhipuKey
        : process.env.Z_AI_API_KEY ?? "";
      if (!key) throw new Error("缺少智谱 API Key（设置里填写或服务器 env 提供）");
      const env: Record<string, string> = { ZHIPU_KEY: key };
      if (typeof params?.model === "string" && params.model) env.ZHIPU_MODEL = params.model;
      result = await runScript("providers/zhipu-coding-plan/setup.sh", env);
    } else {
      const baseUrl = requireString(params?.customBaseUrl, "customBaseUrl");
      const model = requireString(params?.customModel, "customModel");
      result = await runScript("providers/custom-openai/setup.sh", {
        CUSTOM_BASE_URL: baseUrl,
        CUSTOM_MODEL: model,
        CUSTOM_API_KEY: typeof params?.customApiKey === "string" ? params.customApiKey : "",
        ...(typeof params?.customCtx === "number" ? { CUSTOM_CTX: String(params.customCtx) } : {}),
        ...(params?.customVision === true ? { CUSTOM_VISION: "1" } : {}),
        ...(typeof params?.customEffort === "string" && params.customEffort ? { CUSTOM_EFFORT: params.customEffort } : {}),
      });
    }
    if (result.code === 0) scheduleServiceRestart();
    return { ok: result.code === 0, restarting: result.code === 0, output: result.output.slice(-8000) };
  },

  "admin/edge/config": async (params) => {
    if (params?.disable === true) {
      // Local-only: remove nothing — just tell the user how the edge is wired.
      return {
        ok: false,
        output: "关闭远程访问请在服务器上移除 Caddyfile 中的 codex-harness:begin/end 站点块（保留 HTTPS 面板更安全）。",
      };
    }
    const domain = requireString(params?.domain, "domain");
    const listenPort = typeof params?.listenPort === "number" ? params.listenPort : 443;
    const tlsMode = params?.tls === "own" ? "own" : "selfsigned";
    const env: Record<string, string> = {
      EDGE: "caddy-authelia",
      EDGE_DOMAIN: domain,
      EDGE_LISTEN_PORT: String(listenPort),
      EDGE_TLS: tlsMode,
    };
    if (tlsMode === "own" && typeof params?.certDir === "string" && params.certDir) env.EDGE_CERT_DIR = params.certDir;
    if (typeof params?.username === "string" && params.username) env.EDGE_USER = params.username;
    if (typeof params?.password === "string" && params.password) env.EDGE_PASS = params.password;
    const result = await runScript("setup-edge.sh", env);
    return { ok: result.code === 0, restarting: false, output: result.output.slice(-8000) };
  },
};

export function makeDispatcher(ctx: ApiContext) {
  return async function dispatch(method: string, params: unknown): Promise<unknown> {
    const handler = handlers[method];
    if (!handler) throw new Error(`method not allowed: ${method}`);
    return handler(params ?? {}, ctx);
  };
}
