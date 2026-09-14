import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { fetchGatewayCookie, verifyWebSocketAuth } from "../deploy/ws-auth-probe.mjs";

// Avoid consulting any genuine user credential during module initialization.
const prior = process.env.GATEWAY_TOKEN;
process.env.GATEWAY_TOKEN = "test-only";
const { readGatewayToken } = await import("../deploy/ws-token.mjs");
if (prior === undefined) delete process.env.GATEWAY_TOKEN; else process.env.GATEWAY_TOKEN = prior;

test("verification tokens use only explicit control-home, default control-home, or explicit override", t => {
  const dir = mkdtempSync(path.join(tmpdir(), "gateway verifier "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const worker = path.join(dir, "worker"), control = path.join(dir, "control");
  mkdirSync(worker); mkdirSync(control);
  writeFileSync(path.join(worker, "gateway-token"), "obsolete-test-value");
  writeFileSync(path.join(control, "gateway-token"), "current-test-value");
  assert.equal(readGatewayToken({ CODEX_HOME: worker }, dir), "");
  assert.equal(readGatewayToken({ CODEX_HOME: worker, GATEWAY_CONTROL_HOME: path.join(dir, "missing") }, dir), "");
  assert.equal(readGatewayToken({ CODEX_HOME: worker, GATEWAY_CONTROL_HOME: control }, dir), "current-test-value");
  mkdirSync(path.join(dir, ".codex-harness-control"));
  writeFileSync(path.join(dir, ".codex-harness-control", "gateway-token"), "default-control-value");
  assert.equal(readGatewayToken({ CODEX_HOME: worker }, dir), "default-control-value");
  assert.equal(readGatewayToken({ GATEWAY_CONTROL_HOME: control, GATEWAY_TOKEN: "explicit" }, dir), "explicit");
  writeFileSync(path.join(control, "gateway-token"), "x".repeat(17 * 1024));
  assert.equal(readGatewayToken({ GATEWAY_CONTROL_HOME: control }, dir), "");
});

async function authFixture(t, mode = "healthy") {
  const token = "synthetic-" + "a".repeat(40);
  const cookieName = "gw_token_c123456789abcdef";
  const requests = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    const cookie = `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict`;
    res.writeHead(200, { "content-type": "text/html", ...(mode === "no-cookie" ? {} : { "set-cookie": cookie }) }).end("<html>fixture</html>");
  });
  const ws = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => { requests.push({ url: req.url, headers: req.headers }); ws.handleUpgrade(req, socket, head, connection => ws.emit("connection", connection, req)); });
  ws.on("connection", (socket, req) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    const port = server.address().port;
    if (req.headers.host !== `127.0.0.1:${port}` || req.headers.origin && req.headers.origin !== `http://127.0.0.1:${port}`) { socket.close(4003); return; }
    const accepted = req.headers.authorization === `Bearer ${token}` || req.headers.cookie === `${cookieName}=${token}`
      || mode === "legacy-leak" && req.headers.cookie === `gw_token=${token}`;
    if (!accepted) { if (mode !== "silent-rejection") socket.close(4001); return; }
    socket.on("message", data => {
      const message = JSON.parse(String(data));
      assert.equal(message.method, "app/status", "auth probes must never start model work");
      socket.send(JSON.stringify({ kind: "rpcResult", id: message.id, result: { codexState: "ready" } }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { for (const socket of sockets) socket.terminate(); await new Promise(resolve => ws.close(resolve)); await new Promise(resolve => server.close(resolve)); });
  return { token, port: server.address().port, cookieName, requests };
}

test("auth verifier uses the actual authenticated Set-Cookie and exercises current public contracts", { timeout: 5000 }, async t => {
  const fixture = await authFixture(t);
  const lines = [];
  assert.equal(await verifyWebSocketAuth({ ...fixture, timeoutMs: 200, log: line => lines.push(line) }), true);
  assert.equal(lines.at(-1), "WS-AUTH-PASS");
  assert.equal(lines.join("\n").includes(fixture.token), false);
  assert.equal(fixture.requests.some(request => request.url.includes(fixture.token)), false);
  assert.ok(fixture.requests.some(request => request.headers.cookie === `${fixture.cookieName}=${fixture.token}`));
});

test("auth verifier reports an obsolete-cookie acceptance as a failure", { timeout: 5000 }, async t => {
  const fixture = await authFixture(t, "legacy-leak");
  const lines = [];
  assert.equal(await verifyWebSocketAuth({ ...fixture, timeoutMs: 200, log: line => lines.push(line) }), false);
  assert.ok(lines.some(line => line.startsWith("FAIL obsolete-worker-cookie")));
});

test("auth verifier treats silence as inconclusive failure, not proof of rejection", { timeout: 5000 }, async t => {
  const fixture = await authFixture(t, "silent-rejection");
  const lines = [];
  assert.equal(await verifyWebSocketAuth({ ...fixture, timeoutMs: 40, log: line => lines.push(line) }), false);
  assert.ok(lines.some(line => line.startsWith("FAIL no-token")));
});

test("auth verifier fails closed when authenticated HTML does not issue an instance cookie", async t => {
  const fixture = await authFixture(t, "no-cookie");
  await assert.rejects(fetchGatewayCookie({ ...fixture, timeoutMs: 200 }), /did not provide/);
});
