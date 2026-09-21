import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WebSocketServer } from "ws";

const deploy = fileURLToPath(new URL("../deploy/", import.meta.url));
async function runScript(name, env) {
  const child = spawn(process.execPath, [path.join(deploy, name)], {
    windowsHide: true, env: { ...process.env, GATEWAY_TOKEN: "synthetic-verifier-only-000000000000", HARNESS_VERIFY_TIMEOUT_MS: "100", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => stdout += data); child.stderr.on("data", data => stderr += data);
  const timer = setTimeout(() => child.kill(), 3000);
  const [code, signal] = await once(child, "close"); clearTimeout(timer);
  return { code, signal, stdout, stderr };
}
async function fixture(t, handler) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening");
  const messages = [];
  server.on("connection", socket => socket.on("message", data => {
    const request = JSON.parse(String(data)); messages.push(request); handler(socket, request);
  }));
  t.after(async () => { for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); });
  return { url: `ws://127.0.0.1:${server.address().port}/ws`, messages };
}
function respond(socket, request, result, error) {
  socket.send(JSON.stringify({ kind: "rpcResult", id: request.id, result, ...(error ? { error } : {}) }));
}

for (const mode of ["rejected", "close", "malformed", "silent", "accepted"]) {
  test(`read-only WS verifier requires an explicit disabled-method rejection: ${mode}`, { timeout: 5000 }, async t => {
    const f = await fixture(t, (socket, request) => {
      if (request.method === "app/status") respond(socket, request, { codexState: "ready" });
      else if (request.method === "account/read") respond(socket, request, { requiresOpenaiAuth: false });
      else if (request.method === "model/list" || request.method === "thread/list") respond(socket, request, { data: [] });
      else if (mode === "rejected") respond(socket, request, null, "disabled");
      else if (mode === "close") socket.close();
      else if (mode === "malformed") socket.send("not-json");
      else if (mode === "accepted") respond(socket, request, {});
    });
    const result = await runScript("verify-ws.mjs", { GATEWAY_WS: f.url });
    assert.equal(result.signal, null);
    assert.equal(result.code, mode === "rejected" ? 0 : 1, result.stdout + result.stderr);
    assert.equal(result.stdout.includes("WS-READONLY-PASS"), mode === "rejected");
    assert.deepEqual(f.messages.map(message => message.method), ["app/status", "account/read", "model/list", "thread/list", "process/spawn"]);
  });
}

for (const mode of ["close", "silent", "malformed", "rejected", "invalid-result"]) {
  test(`MCP status verifier fails boundedly and never prints PASS on ${mode}`, { timeout: 5000 }, async t => {
    const f = await fixture(t, (socket, request) => {
      if (mode === "close") socket.close();
      if (mode === "malformed") socket.send("null");
      if (mode === "rejected") respond(socket, request, null, "private-error-not-for-output");
      if (mode === "invalid-result") respond(socket, request, {});
    });
    const result = await runScript("list-mcp-tools.mjs", { GATEWAY_WS: f.url });
    assert.equal(result.signal, null); assert.equal(result.code, 1);
    assert.ok(!result.stdout.includes("PASS")); assert.ok(!result.stderr.includes("private-error-not-for-output"));
    assert.deepEqual(f.messages.map(message => message.method), ["mcpServerStatus/list"]);
  });
}
test("MCP status verifier validates pagination and succeeds on a valid empty final page", async t => {
  const f = await fixture(t, (socket, request) => respond(socket, request, request.params?.cursor
    ? { data: [], nextCursor: null } : { data: [{ name: "fixture", tools: { inspect: {} } }], nextCursor: "next" }));
  const result = await runScript("list-mcp-tools.mjs", { GATEWAY_WS: f.url });
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /fixture :: inspect/); assert.match(result.stdout, /MCP-STATUS-PASS/);
  assert.equal(f.messages.length, 2); assert.equal(f.messages[1].params.cursor, "next");
});

test("project verification never creates a directory or removes an existing registration", async t => {
  const f = await fixture(t, (socket, request) => {
    if (request.method === "app/status") respond(socket, request, { workspaceRoot: "/workspace/synthetic", codexState: "ready" });
    else if (request.method === "projects/list") respond(socket, request, { projects: [{ path: "/root/bare-selftest-project" }] });
    else if (request.method === "fs/readDirectory") respond(socket, request, { entries: [] });
    else respond(socket, request, {});
  });
  const result = await runScript("verify-projects.mjs", { GATEWAY_WS: f.url });
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /PROJECTS-READONLY-PASS/);
  assert.deepEqual(f.messages.map(message => message.method), ["app/status", "projects/list", "fs/readDirectory"]);
  assert.deepEqual(f.messages.at(-1).params, { path: "/workspace/synthetic" });
});

for (const mode of ["valid", "unauthorized", "not-spa", "missing-asset", "html-asset", "not-ready", "redirect", "silent", "aborted", "oversized", "too-many-assets"]) {
  test(`SPA verifier authenticates only loopback and checks HTML/assets/readiness: ${mode}`, async t => {
    const requests = [];
    const server = createServer((request, response) => {
      requests.push({ url: request.url, authorization: request.headers.authorization });
      if (mode === "silent") return;
      if (mode === "aborted") { response.writeHead(200, { "content-type": "text/html" }); response.write("<div"); response.destroy(); return; }
      if (mode === "oversized") { response.setHeader("content-type", "text/html"); response.end(Buffer.alloc(10 * 1024 * 1024 + 1, 120)); return; }
      if (request.headers.authorization !== "Bearer synthetic-verifier-only-000000000000" || mode === "unauthorized") { response.writeHead(401).end(); return; }
      if (request.url === "/healthz") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ ok: true, codexState: mode === "not-ready" ? "failed" : "ready" })); return; }
      if (request.url === "/") {
        if (mode === "redirect") { response.writeHead(302, { location: "/redirect-must-not-follow" }).end(); return; }
        const assets = mode === "too-many-assets"
          ? Array.from({ length: 129 }, (_, index) => `<script src="/assets/${index}.js"></script>`).join("")
          : '<script src="/assets/app.js"></script><link href="/assets/app.css">';
        response.setHeader("content-type", "text/html"); response.end(mode === "not-spa" ? "not an app" : `<div id="root"></div>${assets}`); return;
      }
      if (mode === "missing-asset") { response.writeHead(404).end(); return; }
      response.setHeader("content-type", mode === "html-asset" ? "text/html" : request.url.endsWith(".css") ? "text/css" : "text/javascript"); response.end("synthetic asset");
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const result = await runScript("verify-spa.mjs", { PORT: String(server.address().port) });
    assert.equal(result.signal, null);
    assert.equal(result.code, mode === "valid" ? 0 : 1, result.stderr);
    assert.equal(result.stdout.includes("SPA-VERIFICATION-PASS"), mode === "valid");
    assert.ok(!result.stdout.includes("synthetic-verifier-only-000000000000") && !result.stderr.includes("synthetic-verifier-only-000000000000"));
    if (mode === "valid") assert.equal(requests.length, 4);
    assert.ok(!requests.some(request => request.url === "/redirect-must-not-follow"));
  });
}
