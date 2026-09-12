import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
import { AuthToken, setBootstrapCookie } from "./auth-token.js";
import { Hub, type ClientMessage, type ServerMessage } from "./hub.js";
import { makeDispatcher } from "./api.js";
import { isProxyableToolCall, handleDynamicToolCall } from "./mcp-proxy.js";
import { shouldAutoApproveMcpElicitation } from "./mcp-approval.js";
import { ActiveTurns } from "./active-turns.js";
import { TurnDefaults } from "./turn-defaults.js";
import { Terminals } from "./terminals.js";
import { observedNotification } from "./protocol.js";
import type { CommandExecutionRequestApprovalResponse } from "../../../protocol/v2/CommandExecutionRequestApprovalResponse.js";
import type { FileChangeRequestApprovalResponse } from "../../../protocol/v2/FileChangeRequestApprovalResponse.js";
import type { PermissionsRequestApprovalResponse } from "../../../protocol/v2/PermissionsRequestApprovalResponse.js";
import type { DynamicToolCallParams } from "../../../protocol/v2/DynamicToolCallParams.js";
import type { ServerRequest } from "../../../protocol/ServerRequest.js";

const GATEWAY_VERSION = "1.0.1";
const CODEX_BIN = process.env.CODEX_BIN ?? "codex";
const CODEX_HOME = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const WORKSPACE_ROOT = process.env.CODEX_WORKSPACE ?? process.cwd();
const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8410);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
if (!LOOPBACK_HOSTS.has(HOST)) {
  throw new Error(`HOST must be loopback-only (${[...LOOPBACK_HOSTS].join(", ")})`);
}
if (!Number.isSafeInteger(PORT) || PORT < 1 || PORT > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
const MAX_WS_PAYLOAD_BYTES = 36 * 1024 * 1024;

/** Server-initiated requests that gate destructive actions; declined when no browser answers. */
const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);
const BROWSER_HANDLED: ReadonlySet<string> = new Set([
  "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval",
  "item/tool/requestUserInput", "mcpServer/elicitation/request",
] satisfies ServerRequest["method"][]);

/**
 * Protocol-correct "decline" payloads per approval method. Each request type
 * expects a DIFFERENT response shape — a wrong shape is a protocol error that
 * kills the turn, so these must match the generated protocol types.
 */
const DECLINE_PAYLOADS = {
  "item/commandExecution/requestApproval": { decision: "decline" },
  "item/fileChange/requestApproval": { decision: "decline" },
  // GrantedPermissionProfile with nothing granted = denial.
  "item/permissions/requestApproval": { permissions: {}, scope: "turn" },
} satisfies {
  "item/commandExecution/requestApproval": CommandExecutionRequestApprovalResponse;
  "item/fileChange/requestApproval": FileChangeRequestApprovalResponse;
  "item/permissions/requestApproval": PermissionsRequestApprovalResponse;
};

const hub = new Hub({ serverRequestTimeoutMs: 600_000 });

// Distinguishes "first boot" from "crash-restart" in onStateChange — only a
// restart needs the terminal/allExited broadcast (first boot has no terminals).
let appServerIsReady = false;

// Active turn per thread, seen on the notification tap — lets turn/interrupt
// work even when the browser (e.g. after a refresh) doesn't know the turn id.
const activeTurns = new ActiveTurns();

// Auto-compaction must exist BEFORE the supervisor so it can tap notifications.
// The supervisor constructor needs it, so we create a mutable reference.
let autoCompaction: Pick<AutoCompaction, "observe" | "forget" | "reset"> | null = null;
let turnDefaults: TurnDefaults | null = null;
let terminals: Terminals | null = null;

const supervisor = new CodexSupervisor(CODEX_BIN, ["app-server"], { CODEX_HOME }, {
  onNotification: (method, params) => {
    if (turnDefaults?.hideNotification(method, params)) return;
    const event = observedNotification(method, params);
    if (event?.method === "serverRequest/resolved") {
      hub.cancelServerRequest(event.params.requestId);
      // Hub translates upstream IDs to generation-safe browser IDs.
      return;
    }
    // Tap into token usage / turn lifecycle for auto-compaction, then
    // broadcast the notification to browsers as usual.
    if (autoCompaction) {
      try { autoCompaction.observe(method, params); } catch { /* never block broadcast */ }
    }
    // Track the active turn per thread so turn/interrupt can fall back to it
    // when a browser lost the id (page refresh mid-turn).
    if (event) activeTurns.observe(event);
    hub.broadcastNotification(method, params);
  },
  onServerRequest: async (id, method, params) => {
    // The mcp_2026_07_28 client gates every MCP tool call behind an
    // elicitation "form" with _meta.codex_approval_kind = "mcp_tool_call".
    // These are our own configured MCP servers, so auto-accept the gate;
    // genuine elicitation forms still fall through to the browser.
    if (method === "mcpServer/elicitation/request" && shouldAutoApproveMcpElicitation(params)) {
      return { action: "accept", content: {}, _meta: null };
    }
    // The mcp_2026_07_28 client delegates MCP tool EXECUTION to us via
    // dynamic tool calls — answer those here instead of asking browsers.
    if (method === "item/tool/call") {
      const toolParams = params as DynamicToolCallParams | null;
      if (toolParams && typeof toolParams.tool === "string" && isProxyableToolCall(toolParams.namespace)) {
        try {
          return await handleDynamicToolCall(toolParams);
        } catch (err: any) {
          process.stderr.write(`[gateway] dynamic tool call failed: ${err?.message}\n`);
          throw new Error(`tool execution failed: ${err?.message}`);
        }
      }
    }
    // The WebUI renders approval, user-input and elicitation prompts. Any other
    // server request would sit in front of browsers for 10 minutes and
    // time out — fail fast with a clear error instead so the turn ends
    // immediately with an actionable message.
    if (!BROWSER_HANDLED.has(method)) {
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
      return DECLINE_PAYLOADS[method as keyof typeof DECLINE_PAYLOADS];
    }
    throw new Error(answer.error ?? "no browser client answered");
  },
  onStateChange: (state) => {
    // This callback is where appServer/stateChanged is SYNTHESIZED — it never
    // arrives via onNotification, so restart side-effects belong here.
    if (state === "ready") {
      appServerIsReady = true;
    } else if (appServerIsReady || state === "restarting" || state === "stopped") {
      // Everything below is scoped to one app-server generation.  Clear it
      // as soon as the ready connection is lost, not after a replacement
      // happens to initialize successfully.
      appServerIsReady = false;
      activeTurns.clear();
      turnDefaults?.reset();
      terminals?.reset();
      hub.resetPendingAnswers("app-server connection was replaced");
      autoCompaction?.reset();
      hub.broadcastNotification("terminal/allExited", {
        reason: "app-server disconnected; all terminal sessions have ended",
      });
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
  // Optional persistence allowlist; unset on the supported bare-metal install.
  // Legacy container environments also retain the registry's volume guard.
  (process.env.CODEX_PERSISTENT_ROOTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const attachments = new AttachmentStore(CODEX_HOME);
const providerInfoReader = new ProviderInfoReader(CODEX_HOME);
turnDefaults = new TurnDefaults(supervisor);
terminals = new Terminals((processId) => supervisor.request("command/exec/terminate", { processId }));

const dispatch = makeDispatcher({
  supervisor,
  workspaceRoot: WORKSPACE_ROOT,
  gatewayVersion: GATEWAY_VERSION,
  projects: projectRegistry,
  displayPrefs,
  attachments,
  turnDefaults,
  terminals,
  providerInfo: () => providerInfoReader.read(),
  providerReader: providerInfoReader,
  activeTurnFor: (threadId) => activeTurns.get(threadId) ?? null,
  clientCount: () => hub.clientCount,
  onThreadDeleted: (threadId) => {
    activeTurns.delete(threadId);
    autoCompaction?.forget(threadId);
  },
  notify: (method, params) => hub.broadcastNotification(method, params),
});

const app = fastify({ logger: false, bodyLimit: 1024 * 1024 });
await app.register(fastifyWebsocket, { options: { maxPayload: MAX_WS_PAYLOAD_BYTES } });

app.addHook("onSend", async (_req, reply, payload) => {
  reply.header("x-content-type-options", "nosniff");
  reply.header("referrer-policy", "no-referrer");
  reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
  reply.header("x-frame-options", "DENY");
  reply.header(
    "content-security-policy",
    "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; connect-src 'self' ws: wss:",
  );
  return payload;
});

const authToken = new AuthToken(CODEX_HOME, PORT);

app.get("/healthz", async () => ({ ok: true, codexState: supervisor.state, clients: hub.clientCount }));

// Serve the SPA. The auth token cookie is ONLY set on trusted hosts —
// this blocks DNS rebinding (attacker resolves evil.com to 127.0.0.1, gets
// the page, but the cookie is not set so the subsequent WS is rejected).
const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, prefix: "/" });
  const secure = process.env.GATEWAY_HTTPS === "true";
  // Cookie on all HTML responses (/, /index.html, SPA fallback) — restricted
  // to trusted hosts only.
  app.addHook("onRequest", async (req, reply) => {
    const isHtml = req.method === "GET" && (
      req.url === "/" || req.url.startsWith("/?") ||
      req.url === "/index.html" ||
      (req.headers.accept?.includes("text/html") && !req.url.startsWith("/assets/") && !req.url.startsWith("/healthz"))
    );
    if (isHtml) setBootstrapCookie(authToken, req, reply, secure);
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && req.headers.accept?.includes("text/html")) {
      setBootstrapCookie(authToken, req, reply, secure);
      if (reply.sent) return;
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
 * 3. Token auth. Local processes are trusted in the default bootstrap mode;
 *    GATEWAY_BOOTSTRAP_AUTH=required additionally requires an existing secret.
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
  const clientId = randomUUID();
  terminals!.connect(clientId);

  socket.on("message", (raw: Buffer) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg?.kind === "rpc") {
      if (
        typeof msg.id !== "number" || !Number.isSafeInteger(msg.id) ||
        typeof msg.method !== "string" || msg.method.length === 0 || msg.method.length > 128
      ) {
        socket.close(1008, "invalid rpc message");
        return;
      }
      void dispatch(msg.method, msg.params, clientId)
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
      if (typeof msg.requestId !== "string" || msg.requestId.length > 256 ||
          (msg.error !== undefined && (typeof msg.error !== "string" || msg.error.length > 4096))) {
        socket.close(1008, "invalid server response");
        return;
      }
      // First answer wins; later ones are ignored because the waiter is gone.
      hub.resolveBrowserAnswer(msg.requestId, msg.payload, msg.error);
    }
  });

  const disconnect = () => { terminals!.disconnect(clientId); hub.removeClient(client); };
  socket.on("close", disconnect);
  socket.on("error", disconnect);
});

app.listen({ host: HOST, port: PORT }, (err) => {
  if (err) {
    console.error(`[gateway] failed to listen on ${HOST}:${PORT}:`, err);
    process.exit(1);
  }
  // Do not create a child until the gateway has acquired its listener. A port
  // collision must not leave an orphan app-server or trigger restart loops.
  supervisor.start();
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
