import { existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { AuthToken, setBootstrapCookie } from "./auth-token.js";
import { rpcFailureMessage, type ClientMessage, type ServerMessage } from "./hub.js";
import { GatewayController } from "./control.js";
import { FLOW_LIMITS, RpcBudget, encodeBounded } from "./flow-control.js";
import { contentSecurityPolicy, isTrustedBrowserOrigin } from "./security-headers.js";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8410);
if (!["127.0.0.1", "::1", "localhost"].includes(HOST)) throw new Error("HOST must be loopback-only");
if (!Number.isSafeInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("PORT must be an integer between 1 and 65535");
const HTTPS_MODE = process.env.GATEWAY_HTTPS === "true";
const controlHome = process.env.GATEWAY_CONTROL_HOME ?? path.join(os.homedir(), ".codex-harness-control");
mkdirSync(controlHome, { recursive: true, mode: 0o700 });
const authToken = new AuthToken(controlHome, PORT);
const controller = new GatewayController(controlHome);
const budget = new RpcBudget();
const MAX_WS_PAYLOAD_BYTES = FLOW_LIMITS.frameBytes;
const MAX_SERVER_RESPONSE_BYTES = 1024 * 1024;

const app = fastify({ logger: false, bodyLimit: 1024 * 1024 });
await app.register(fastifyWebsocket, { options: { maxPayload: MAX_WS_PAYLOAD_BYTES } });

app.addHook("onSend", async (req, reply, payload) => {
  reply.header("x-content-type-options", "nosniff");
  reply.header("referrer-policy", "no-referrer");
  reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
  reply.header("x-frame-options", "DENY");
  if (HTTPS_MODE) reply.header("strict-transport-security", "max-age=31536000");
  reply.header(
    "content-security-policy",
    contentSecurityPolicy(authToken.isTrustedHost(req.headers.host) ? req.headers.host : null, HTTPS_MODE),
  );
  return payload;
});



app.get("/healthz", async () => ({ ok: true, codexState: controller.codexState, clients: controller.clientCount }));

// Serve the SPA. The auth token cookie is ONLY set on trusted hosts —
// this blocks DNS rebinding (attacker resolves evil.com to 127.0.0.1, gets
// the page, but the cookie is not set so the subsequent WS is rejected).
const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, prefix: "/" });
  const secure = HTTPS_MODE;
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
 * 3. Token auth for every client, including local processes. The credential
 *    lives under the separate control-plane OS account, never in CODEX_HOME.
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
      if (!isTrustedBrowserOrigin(origin, String(host ?? ""), HTTPS_MODE)) {
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
  const clientId = randomUUID();
  const client = {
    send: (msg: ServerMessage) => {
      const encoded = encodeBounded(msg);
      if (socket.readyState !== 1) return;
      if (socket.bufferedAmount + Buffer.byteLength(encoded) > FLOW_LIMITS.outgoingBytes) {
        socket.close(1013, "slow client; reconnect and reload history");
        const timer = setTimeout(() => socket.terminate(), 1000); timer.unref();
        return;
      }
      socket.send(encoded);
    },
    close: (code: number, reason: string) => socket.close(code, reason),
  };
  const connected = controller.connect(clientId, client);
  void connected.catch(() => socket.close(1012, "backend unavailable"));
  const ids = new Set<number>();

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
      if (ids.has(msg.id)) { socket.close(1008, "duplicate rpc id"); return; }
      let release: () => void;
      try { release = budget.acquire(clientId, msg.method, raw.byteLength); }
      catch (error) { client.send(rpcFailureMessage(msg.id, error, { delivery: "not_sent" })); return; }
      const rpcId = msg.id;
      const rpcMethod = msg.method;
      let rpcParams = msg.params;
      ids.add(rpcId);
      // Controller-owned diagnostics, receipts and send admission do not wait
      // for worker attachment. A broken backend must not hide durable results.
      const requiresWorker = !["management/status", "turn/operation", "thread/start/operation", "account/login/status", "admin/logs", "turn/start", "thread/start"].includes(rpcMethod);
      // Receipt queries must never overtake an already queued send and report
      // not_received. Persist its control-plane intent now; the ledger's send
      // callback still waits for this exact browser/worker attachment.
      void (requiresWorker ? connected : Promise.resolve()).then(() => {
        const params = rpcParams;
        rpcParams = undefined;
        return rpcMethod === "turn/start" || rpcMethod === "thread/start"
          ? controller.dispatch(rpcMethod, params, clientId, connected)
          : controller.dispatch(rpcMethod, params, clientId);
      })
        .then((result) => {
          try {
            client.send({ kind: "rpcResult", id: rpcId, result });
          } catch (error) {
            try { client.send(rpcFailureMessage(rpcId, error, { errorCode: "RESPONSE_TOO_LARGE", delivery: "unknown" })); }
            catch { socket.close(1013, "response exceeds limits; reconnect"); }
          }
        })
        .catch((err: unknown) => {
          try {
            client.send(rpcFailureMessage(rpcId, err));
          } catch {
            /* socket already closed — nothing to do */
          }
        }).finally(() => { release(); ids.delete(rpcId); });
      return;
    }
    if (msg?.kind === "serverRequestResponse") {
      // Retain only the response protocol fields across worker attachment. In
      // particular, unknown fields in the parsed frame must not stay captured
      // by the asynchronous answer/rejection callbacks.
      const response = {
        kind: "serverRequestResponse" as const,
        requestId: msg.requestId,
        payload: msg.payload,
        ...(msg.error !== undefined ? { error: msg.error } : {}),
      };
      msg = response;
      let responseBytes = Number.POSITIVE_INFINITY;
      // The 1 MiB response limit includes its envelope, not just payload/error,
      // so four/eight maximum-size answers fit the per-client/global reserve.
      try { responseBytes = Buffer.byteLength(JSON.stringify(response)); } catch { /* rejected below */ }
      if (typeof response.requestId !== "string" || response.requestId.length === 0 || response.requestId.length > 256 || response.requestId.includes("\0") ||
          responseBytes > MAX_SERVER_RESPONSE_BYTES ||
          (response.error !== undefined && (typeof response.error !== "string" || response.error.length > 4096))) {
        socket.close(1008, "invalid server response");
        return;
      }
      let release: () => void;
      // Charge the complete received frame even when it contains ignored
      // fields or whitespace; normalization must never make admission free.
      try { release = budget.acquire(clientId, "serverRequestResponse", raw.byteLength); }
      catch (error) {
        client.send({ kind: "notification", method: "serverRequest/answerRejected", params: { serverRequestId: response.requestId, error: (error as Error).message } });
        return;
      }
      const requestId = response.requestId;
      const responseError = response.error;
      let responsePayload = response.payload;
      // First answer wins; later ones are ignored because the waiter is gone.
      void connected.then(() => {
        const payload = responsePayload;
        responsePayload = undefined;
        return controller.answer(requestId, payload, responseError);
      }).catch((error) => {
        const message = error instanceof Error ? error.message : "server response failed";
        client.send({ kind: "notification", method: "serverRequest/answerRejected", params: { serverRequestId: requestId, error: message.slice(0, 4096) } });
      }).finally(release);
    }
  });

  const disconnect = () => { void controller.disconnect(clientId).catch(() => {}); };
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
  controller.start();
  console.log(`[gateway] listening on http://${HOST}:${PORT}`);
  console.log(`[gateway] control credential file: ${path.join(controlHome, "gateway-token")}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void controller.stop().then(() => app.close()).then(() => process.exit(0));
  });
}
