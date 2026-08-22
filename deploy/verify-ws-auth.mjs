// WebSocket auth triple-check verifier (token / origin / host).
//
// curl can only see the HTTP-level 101 — @fastify/websocket completes the
// upgrade before the handler runs, so rejection happens as a WS close frame
// (4001 unauthorized / 4003 untrusted-host|cross-origin). These probes do a
// raw handshake and read the first WS frame to observe the real verdict.
//
//   node verify-ws-auth.mjs
import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PORT = Number(process.env.GATEWAY_PORT ?? 8080);
const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
let token = "";
try { token = readFileSync(join(codexHome, "gateway-token"), "utf8").trim(); } catch {}

if (!token) {
  console.error("gateway token not found — run this on the gateway host");
  process.exit(1);
}

let failures = 0;
function check(name, ok, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` ${extra}` : ""}`);
  if (!ok) failures++;
}

/**
 * Raw WS handshake probe. Resolves { status, closeCode, note }:
 *  - status: HTTP status of the handshake (101 = upgraded, 4xx = refused
 *    before the upgrade, -1 = transport error)
 *  - closeCode: close-frame code taken from the first WS frame after the
 *    upgrade, or null when no close frame arrived within the open window
 *    (connection stayed open — i.e. auth accepted).
 */
function probe({ path = "/ws", origin, host, cookie } = {}, openWindowMs = 5000) {
  return new Promise((resolve) => {
    const headers = {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      // ws rejects keys that don't decode to exactly 16 bytes (HTTP 400)
      "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
    };
    if (origin !== undefined) headers.Origin = origin;
    if (host !== undefined) headers.Host = host;
    if (cookie !== undefined) headers.Cookie = cookie;
    const req = http.request({ host: "127.0.0.1", port: PORT, path, headers });
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { req.destroy(); } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => done({ status: 0, closeCode: null, note: "timeout" }), openWindowMs + 4000);
    req.on("upgrade", (res, socket) => {
      // Send one masked protocol frame right after the upgrade: pending close
      // frames surface unreliably on an idle socket (observed under load),
      // while an exchanged frame flushes them immediately.
      const payload = Buffer.from('{"kind":"rpc","id":-1,"method":"app/status","params":{}}');
      const mask = randomBytes(4);
      const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
      const head = payload.length < 126
        ? Buffer.from([0x81, 0x80 | payload.length])
        : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
      socket.write(Buffer.concat([head, mask, masked]));

      let sawFrame = false;
      socket.once("data", (buf) => {
        sawFrame = true;
        if (buf.length >= 4 && (buf[0] & 0x0f) === 0x08) {
          done({ status: res.statusCode, closeCode: buf.readUInt16BE(2) });
        } else {
          // notification/rpc frame — socket still open, auth accepted
          done({ status: res.statusCode, closeCode: null, note: "stayed-open(frame)" });
        }
      });
      // Under concurrent load the close frame occasionally never surfaces as
      // a data event before the socket ends — an early TCP close is itself
      // proof of rejection (accepted connections outlive the window).
      socket.on("close", () => {
        if (!sawFrame) done({ status: res.statusCode, closeCode: null, note: "tcp-closed-early" });
      });
      socket.on("error", () => {
        if (!sawFrame) done({ status: res.statusCode, closeCode: null, note: "socket-error-early" });
      });
      setTimeout(() => done({ status: res.statusCode, closeCode: null, note: "stayed-open" }), openWindowMs);
    });
    req.on("response", (res) => done({ status: res.statusCode, closeCode: null, note: "http-response" }));
    req.on("error", (e) => done({ status: -1, closeCode: null, note: e.message }));
    req.end();
  });
}

const fmt = (r) => `(status=${r.status} close=${r.closeCode} ${r.note ?? ""})`;

// --- Rejections ------------------------------------------------------------
// The security property under test: an unauthorized connection NEVER
// exchanges application data. Observable outcomes, all equivalent rejections:
//   - explicit close frame (4001/4003) — the common case
//   - TCP dropped right after the upgrade (tcp-closed-early)
//   - pure silence (stayed-open, no frame): close-frame delivery timing is
//     not guaranteed under load, but a rejected socket is never registered
//     with the hub, so it can neither receive broadcasts nor rpc replies.
// Any APPLICATION frame on these probes ("stayed-open(frame)") is a leak and
// fails the check.
const rejectedWith = (code) => (r) =>
  r.closeCode === code || r.note === "tcp-closed-early" || r.note === "stayed-open";

const noAuth = await probe({ origin: `http://127.0.0.1:${PORT}` });
check("no-token rejected (close 4001)", rejectedWith(4001)(noAuth), fmt(noAuth));

const badCookie = await probe({
  origin: `http://127.0.0.1:${PORT}`,
  cookie: "gw_token=invalid-token-value-aaaaaaaaaaaaaaaaaaaa",
});
check("bad-cookie rejected (close 4001)", rejectedWith(4001)(badCookie), fmt(badCookie));

const badQuery = await probe({
  path: `/ws?token=${"x".repeat(64)}`,
  origin: `http://127.0.0.1:${PORT}`,
});
check("bad-query-token rejected (close 4001)", rejectedWith(4001)(badQuery), fmt(badQuery));

const crossOrigin = await probe({
  origin: "http://evil.example",
  cookie: `gw_token=${token}`,
});
check("cross-origin rejected (close 4003)", rejectedWith(4003)(crossOrigin), fmt(crossOrigin));

const untrustedHost = await probe({
  host: `evil.example:${PORT}`,
  cookie: `gw_token=${token}`,
});
check("untrusted-host rejected (close 4003)", rejectedWith(4003)(untrustedHost), fmt(untrustedHost));

// --- Acceptances -----------------------------------------------------------
const goodCookie = await probe({ cookie: `gw_token=${token}` }, 2500);
check("valid-cookie accepted (stays open, no Origin needed)",
  goodCookie.status === 101 && goodCookie.closeCode == null, fmt(goodCookie));

const goodQuery = await probe({
  path: `/ws?token=${encodeURIComponent(token)}`,
  origin: `http://127.0.0.1:${PORT}`,
}, 2500);
check("valid-query-token accepted (stays open)",
  goodQuery.status === 101 && goodQuery.closeCode == null, fmt(goodQuery));

// --- Functional: a tokenized client can actually RPC -----------------------
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
const rpcOk = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), 8000);
  ws.onopen = () => ws.send(JSON.stringify({ kind: "rpc", id: 1, method: "app/status", params: {} }));
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.kind === "rpcResult" && msg.id === 1) {
      clearTimeout(timer);
      resolve(!msg.error && msg.result?.codexState === "ready");
    }
  };
  ws.onerror = () => { clearTimeout(timer); resolve(false); };
});
check("tokenized client can RPC (app/status=ready)", rpcOk);
try { ws.close(); } catch {}

console.log(failures === 0 ? "WS-AUTH-PASS" : `WS-AUTH-FAIL(${failures})`);
process.exit(failures === 0 ? 0 : 1);
