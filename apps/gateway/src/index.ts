import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { CodexSupervisor } from "./codex/process.js";
import { ProjectRegistry } from "./projects.js";
import { DisplayPrefsStore } from "./display-prefs.js";
import { AttachmentStore } from "./attachments.js";
import { ProviderInfoReader } from "./provider-info.js";
import { AutoCompaction } from "./auto-compaction.js";
import { AuthToken } from "./auth-token.js";
import { Hub, type ClientMessage, type ServerMessage } from "./hub.js";
import { makeDispatcher } from "./api.js";
import { isProxyableToolCall, handleDynamicToolCall } from "./mcp-proxy.js";

const GATEWAY_VERSION = "1.0.0";
const CODEX_BIN = process.env.CODEX_BIN ?? "codex";
const CODEX_HOME = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const WORKSPACE_ROOT = process.env.CODEX_WORKSPACE ?? process.cwd();
const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8410);

/** Server-initiated requests that gate destructive actions; declined when no browser answers. */
const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

/**
 * Protocol-correct "decline" payloads per approval method. Each request type
 * expects a DIFFERENT response shape — a wrong shape is a protocol error that
 * kills the turn, so these must match the generated protocol types.
 */
const DECLINE_PAYLOADS: Record<string, unknown> = {
  "item/commandExecution/requestApproval": { decision: "decline" },
  "item/fileChange/requestApproval": { decision: "decline" },
  // GrantedPermissionProfile with nothing granted = denial.
  "item/permissions/requestApproval": { permissions: {}, scope: "turn" },
};

const hub = new Hub({ serverRequestTimeoutMs: 600_000 });

// Distinguishes "first boot" from "crash-restart" in onStateChange — only a
// restart needs the terminal/allExited broadcast (first boot has no terminals).
let appServerWasReady = false;

// Active turn per thread, seen on the notification tap — lets turn/interrupt
// work even when the browser (e.g. after a refresh) doesn't know the turn id.
const activeTurns = new Map<string, string>();

// Auto-compaction must exist BEFORE the supervisor so it can tap notifications.
// The supervisor constructor needs it, so we create a mutable reference.
let autoCompaction: { observe(method: string, params: any): void; forget(threadId: string): void } | null = null;

const supervisor = new CodexSupervisor(CODEX_BIN, ["app-server"], { CODEX_HOME }, {
  onNotification: (method, params) => {
    // Tap into token usage / turn lifecycle for auto-compaction, then
    // broadcast the notification to browsers as usual.
    if (autoCompaction) {
      try { autoCompaction.observe(method, params); } catch { /* never block broadcast */ }
    }
    // Track the active turn per thread so turn/interrupt can fall back to it
    // when a browser lost the id (page refresh mid-turn).
    const tid = (params as any)?.threadId;
    if (tid) {
      if (method === "turn/started" && (params as any)?.turn?.id) activeTurns.set(tid, (params as any).turn.id);
      else if (method === "turn/completed" || method === "turn/interrupted" || method === "error") activeTurns.delete(tid);
    }
    hub.broadcastNotification(method, params);
  },
  onServerRequest: async (id, method, params) => {
    // The mcp_2026_07_28 client gates every MCP tool call behind an
    // elicitation "form" with _meta.codex_approval_kind = "mcp_tool_call".
    // These are our own configured MCP servers, so auto-accept the gate;
    // genuine elicitation forms still fall through to the browser.
    if (method === "mcpServer/elicitation/request") {
      const meta = (params as any)?._meta;
      if (meta?.codex_approval_kind === "mcp_tool_call") {
        return { action: "accept", content: {}, _meta: null };
      }
    }
    process.stderr.write(`[gateway] unhandled serverRequest ${method} id=${id}\n`);
    // The mcp_2026_07_28 client delegates MCP tool EXECUTION to us via
    // dynamic tool calls — answer those here instead of asking browsers.
    if (method === "item/tool/call") {
      const toolParams = params as { namespace: string | null; tool: string; arguments: unknown };
      if (isProxyableToolCall(toolParams.namespace)) {
        try {
          return await handleDynamicToolCall(toolParams);
        } catch (err: any) {
          process.stderr.write(`[gateway] dynamic tool call failed: ${err?.message}\n`);
          throw new Error(`tool execution failed: ${err?.message}`);
        }
      }
    }
    // The WebUI only renders *requestApproval-style prompts. Any other
    // server request would sit in front of browsers for 10 minutes and
    // time out — fail fast with a clear error instead so the turn ends
    // immediately with an actionable message.
    const BROWSER_HANDLED = /requestApproval|requestUserInput|elicitation\/request/;
    if (!BROWSER_HANDLED.test(method)) {
      throw new Error(
        `server request type not supported by this WebUI: ${method} (please report — the turn was aborted instead of hanging)`,
      );
    }
    const answer = await hub.waitForBrowserAnswer(id, method, params);
    if (answer.answered) {
      if (answer.error) throw new Error(answer.error);
      return answer.payload;
    }
    // Nobody home: fail safely. Approvals are declined, other requests error out.
    if (APPROVAL_METHODS.has(method)) {
      process.stderr.write(`[gateway] auto-declining ${method} (request ${id}): ${answer.error}\n`);
      hub.broadcastNotification("serverRequest/resolved", {
        serverRequestId: id,
        reason: { type: "cancelled" },
      });
      return DECLINE_PAYLOADS[method] ?? { decision: "decline" };
    }
    throw new Error(answer.error ?? "no browser client answered");
  },
  onStateChange: (state) => {
    // This callback is where appServer/stateChanged is SYNTHESIZED — it never
    // arrives via onNotification, so restart side-effects belong here.
    if (state === "ready") {
      if (appServerWasReady) {
        // A RESTART (not first boot): the old connection's terminal sessions
        // died without per-process exit notifications — tell the browsers.
        hub.broadcastNotification("terminal/allExited", {
          reason: "app-server restarted; all terminal sessions have ended",
        });
      }
      appServerWasReady = true;
    }
    hub.broadcastNotification("appServer/stateChanged", { state });
  },
});

const displayPrefs = new DisplayPrefsStore(CODEX_HOME);

// Auto-compaction: watches token usage and triggers thread/compact/start when
// the conversation approaches the model's context window. Threshold is
// user-configurable via displayPrefs (settings → 通用), default 90%.
autoCompaction = new AutoCompaction(
  { supervisor, notify: (method, params) => hub.broadcastNotification(method, params) },
  () => displayPrefs.get().autoCompactThreshold,
);

const projectRegistry = new ProjectRegistry(
  CODEX_HOME,
  WORKSPACE_ROOT,
  // Extra directories mounted at the same path inside the container. Anything
  // outside these (plus workspace/codex-home) is ephemeral container storage.
  (process.env.CODEX_PERSISTENT_ROOTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const attachments = new AttachmentStore(CODEX_HOME);
const providerInfoReader = new ProviderInfoReader(CODEX_HOME);

const dispatch = makeDispatcher({
  supervisor,
  workspaceRoot: WORKSPACE_ROOT,
  gatewayVersion: GATEWAY_VERSION,
  projects: projectRegistry,
  displayPrefs,
  attachments,
  providerInfo: () => providerInfoReader.read(),
  providerReader: providerInfoReader,
  activeTurnFor: (threadId) => activeTurns.get(threadId) ?? null,
  onThreadDeleted: (threadId) => autoCompaction?.forget(threadId),
  notify: (method, params) => hub.broadcastNotification(method, params),
});

const app = fastify({ logger: false });
await app.register(fastifyWebsocket);

const authToken = new AuthToken(CODEX_HOME, PORT);

app.get("/healthz", async () => ({ ok: true, codexState: supervisor.state, clients: hub.clientCount }));

// Serve the SPA. The auth token cookie is ONLY set on trusted hosts —
// this blocks DNS rebinding (attacker resolves evil.com to 127.0.0.1, gets
// the page, but the cookie is not set so the subsequent WS is rejected).
const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, prefix: "/" });
  const secure = process.env.GATEWAY_HTTPS === "true";
  const setCookieIfTrusted = (req: any, reply: any) => {
    if (authToken.isTrustedHost(req?.headers?.host)) {
      reply.header("set-cookie", authToken.cookieHeader(secure));
    }
  };
  // Cookie on all HTML responses (/, /index.html, SPA fallback) — restricted
  // to trusted hosts only.
  app.addHook("onRequest", async (req, reply) => {
    const isHtml = req.method === "GET" && (
      req.url === "/" || req.url.startsWith("/?") ||
      req.url === "/index.html" ||
      (req.headers.accept?.includes("text/html") && !req.url.startsWith("/assets/") && !req.url.startsWith("/healthz"))
    );
    if (isHtml) setCookieIfTrusted(req, reply);
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && req.headers.accept?.includes("text/html")) {
      setCookieIfTrusted(req, reply);
      reply.sendFile("index.html");
    } else {
      reply.code(404).send({ error: "not found" });
    }
  });
}

/**
 * Defense-in-depth for the WebSocket:
 * 1. Trusted Host check (blocks DNS rebinding).
 * 2. Origin same-host check (blocks cross-origin browser pages).
 * 3. Token auth (blocks unauthenticated local processes).
 */
app.get("/ws", { websocket: true }, (socket, req) => {
  const host = req?.headers?.host;
  if (!authToken.isTrustedHost(host)) {
    process.stderr.write(`[gateway] rejected websocket from untrusted host: ${host}\n`);
    socket.close(4003, "untrusted host");
    return;
  }
  // Origin check only applies to browser clients (they always send Origin).
  // Host headers are case-insensitive — compare lowercased on both sides.
  const origin = req?.headers?.origin;
  if (origin) {
    try {
      const o = new URL(origin);
      if (o.host.toLowerCase() !== String(host ?? "").toLowerCase()) {
        process.stderr.write(`[gateway] rejected cross-origin websocket: origin=${origin} host=${host}\n`);
        socket.close(4003, "cross-origin");
        return;
      }
    } catch {
      socket.close(4003, "bad origin");
      return;
    }
  }
  const presented = authToken.extract(req);
  if (!authToken.verify(presented)) {
    process.stderr.write(`[gateway] rejected unauthenticated websocket\n`);
    socket.close(4001, "unauthorized");
    return;
  }
  const client = {
    send: (msg: ServerMessage) => socket.send(JSON.stringify(msg)),
  };
  hub.addClient(client);

  socket.on("message", (raw: Buffer) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg?.kind === "rpc") {
      void dispatch(msg.method, msg.params)
        .then((result) => {
          try {
            client.send({ kind: "rpcResult", id: msg.id, result });
          } catch {
            /* socket closed between dispatch and send */
          }
        })
        .catch((err: Error) => {
          try {
            client.send({ kind: "rpcResult", id: msg.id, error: err.message });
          } catch {
            /* socket already closed — nothing to do */
          }
        });
      return;
    }
    if (msg?.kind === "serverRequestResponse") {
      // First answer wins; later ones are ignored because the waiter is gone.
      hub.resolveBrowserAnswer(msg.requestId, msg.payload, msg.error);
      // Tell ALL browsers (including other tabs) that this request is settled
      // so their banners don't linger. Field name matches the gateway's own
      // auto-decline broadcast below.
      hub.broadcastNotification("serverRequest/resolved", {
        serverRequestId: msg.requestId,
        decidedBy: "browser",
      });
    }
  });

  socket.on("close", () => hub.removeClient(client));
  socket.on("error", () => hub.removeClient(client));
});

supervisor.start();

app.listen({ host: HOST, port: PORT }, (err) => {
  if (err) {
    console.error(`[gateway] failed to listen on ${HOST}:${PORT}:`, err);
    process.exit(1);
  }
  console.log(`[gateway] listening on http://${HOST}:${PORT}`);
  console.log(`[gateway] workspace root: ${WORKSPACE_ROOT}`);
  console.log(`[gateway] codex binary: ${CODEX_BIN}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    supervisor.stop();
    process.exit(0);
  });
}
