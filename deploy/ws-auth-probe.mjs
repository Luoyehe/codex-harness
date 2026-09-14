// Read-only deployment auth probes. No real credential is ever put in a URL,
// diagnostic message, process argument, or synthetic model request.
import http from "node:http";
import WebSocket from "ws";

export function fetchGatewayCookie({ port, token, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/", headers: { Authorization: `Bearer ${token}`, Accept: "text/html" } }, (response) => {
      const cookies = response.headers["set-cookie"] ?? [];
      const cookie = cookies.find((header) => {
        const pair = header.split(";", 1)[0];
        const index = pair.indexOf("=");
        return /^gw_token_[a-f0-9]{16}$/.test(pair.slice(0, index)) && pair.slice(index + 1) === token
          && /;\s*HttpOnly(?:;|$)/i.test(header) && /;\s*SameSite=Strict(?:;|$)/i.test(header) && /;\s*Path=\/(?:;|$)/i.test(header);
      });
      clearTimeout(timer);
      response.destroy();
      if (response.statusCode !== 200 || !cookie) reject(new Error("Authenticated HTML did not provide this instance's secure gateway cookie"));
      else resolve(cookie.split(";", 1)[0]);
    });
    const timer = setTimeout(() => { request.destroy(); reject(new Error("Gateway HTML bootstrap timed out")); }, timeoutMs);
    request.on("error", () => { clearTimeout(timer); reject(new Error("Gateway HTML bootstrap connection failed")); });
  });
}

function probe({ port, cookie, authorization, origin, host, path = "/ws", timeoutMs }) {
  return new Promise((resolve) => {
    const headers = {};
    if (cookie !== undefined) headers.Cookie = cookie;
    if (authorization !== undefined) headers.Authorization = authorization;
    if (origin !== undefined) headers.Origin = origin;
    if (host !== undefined) headers.Host = host;
    let socket;
    let applicationFrame = false;
    let settled = false;
    let timer;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.terminate();
      resolve({ applicationFrame, rpcReady: false, closeCode: null, ...result });
    };
    try { socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers }); }
    catch { done({ note: "connection-options-invalid" }); return; }
    timer = setTimeout(() => done({ note: "timeout" }), timeoutMs);
    socket.on("open", () => {
      socket.send(JSON.stringify({ kind: "rpc", id: 1, method: "app/status", params: {} }), (error) => { if (error) done({ note: "send-failed" }); });
    });
    socket.on("message", (data) => {
      applicationFrame = true;
      let message;
      try { message = JSON.parse(data.toString()); } catch { done({ note: "invalid-application-frame" }); return; }
      if (message?.kind === "rpcResult" && message.id === 1) done({ note: "application-response", rpcReady: !message.error && message.result?.codexState === "ready" });
    });
    socket.on("close", (code) => done({ closeCode: code, note: "closed" }));
    socket.on("error", () => done({ note: "connection-failed" }));
  });
}

export async function verifyWebSocketAuth({ port, token, timeoutMs = 5000, log = console.log }) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !token) throw new Error("A valid gateway port and control-plane credential are required");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) throw new Error("Invalid auth verification timeout");
  const cookie = await fetchGatewayCookie({ port, token, timeoutMs });
  const cookieName = cookie.slice(0, cookie.indexOf("="));
  let failures = 0;
  const check = (name, passed, result) => {
    log(`${passed ? "PASS" : "FAIL"} ${name} (close=${result.closeCode ?? "none"} ${result.note ?? ""})`);
    if (!passed) failures++;
  };
  const rejected = (result, code) => !result.applicationFrame && result.closeCode === code;
  const sameOrigin = `http://127.0.0.1:${port}`;
  for (const [name, options, code] of [
    ["no-token rejected", { origin: sameOrigin }, 4001],
    ["bad-instance-cookie rejected", { origin: sameOrigin, cookie: `${cookieName}=${"x".repeat(64)}` }, 4001],
    ["obsolete-worker-cookie rejected", { origin: sameOrigin, cookie: `gw_token=${token}` }, 4001],
    // Deliberately synthetic: never leak the administrator token through a
    // URL merely to test the legacy query-token compatibility option.
    ["bad-query-token rejected", { origin: sameOrigin, path: `/ws?token=${"x".repeat(64)}` }, 4001],
    ["cross-origin rejected", { origin: "http://evil.example", cookie }, 4003],
    ["untrusted-host rejected", { host: `evil.example:${port}`, cookie }, 4003],
  ]) {
    const result = await probe({ port, timeoutMs, ...options });
    check(name, rejected(result, code), result);
  }
  for (const [name, options] of [
    ["current-instance cookie can RPC", { cookie, origin: sameOrigin }],
    ["Bearer client can RPC", { authorization: `Bearer ${token}` }],
  ]) {
    const result = await probe({ port, timeoutMs, ...options });
    check(name, result.applicationFrame && result.rpcReady && result.closeCode === null, result);
  }
  log(failures === 0 ? "WS-AUTH-PASS" : `WS-AUTH-FAIL(${failures})`);
  return failures === 0;
}
