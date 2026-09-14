import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";

const bridge = fileURLToPath(new URL("../deploy/providers/zhipu-coding-plan/mcp-http-bridge.mjs", import.meta.url));

async function server(handler) {
  const instance = http.createServer(handler);
  instance.listen(0, "127.0.0.1");
  await once(instance, "listening");
  const address = instance.address();
  return { instance, url: `http://127.0.0.1:${address.port}/mcp` };
}

function runBridge(url, lines, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridge, url], {
      env: { ...process.env, Z_AI_API_KEY: "bridge-test-key-never-log", MCP_BRIDGE_DEBUG: "1", ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (value) => { stdout += value; });
    child.stderr.on("data", (value) => { stderr += value; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    for (const line of lines) child.stdin.write(JSON.stringify(line) + "\n");
    child.stdin.end();
  });
}

function liveBridge(t, url, extraEnv = {}) {
  const child = spawn(process.execPath, [bridge, url], {
    env: { ...process.env, Z_AI_API_KEY: "local-fixture-key", ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const frames = [];
  let buffer = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      frames.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = once(child, "close");
  t.after(() => { child.kill(); });
  return {
    child, frames, closed, stderr: () => stderr,
    send: (message) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"),
    waitFor: async (predicate) => {
      const deadline = Date.now() + 4000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, "bridge fixture timed out: " + stderr);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}

async function requestBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body);
}

function jsonResponse(res, request, result = {}) {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
}

test("SSE progress is incremental across split UTF-8/CRLF and cancellation bypasses an active call", { timeout: 8000 }, async (t) => {
  let cancellationReached = false;
  let toolEnded = false;
  const { instance, url } = await server(async (req, res) => {
    const request = await requestBody(req);
    if (request.method === "notifications/cancelled") {
      cancellationReached = !toolEnded && request.params.requestId === 2;
      res.writeHead(202).end();
      return;
    }
    res.setHeader("content-type", "text/event-stream");
    const progress = Buffer.from('data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"text":"进度"}}\r\n\r\n');
    const split = progress.indexOf(Buffer.from("进")) + 1;
    res.write(progress.subarray(0, split));
    setImmediate(() => {
      res.write(progress.subarray(split, progress.length - 1));
      setImmediate(() => res.write(progress.subarray(progress.length - 1)));
    });
    res.on("close", () => { toolEnded = true; });
    // The tool stream remains open until the bridge forwards cancellation.
  });
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  const run = liveBridge(t, url);
  run.send({ id: 2, method: "tools/call", params: {} });
  await run.waitFor(() => run.frames.some((frame) => frame.method === "notifications/progress"));
  assert.equal(toolEnded, false);
  assert.equal(run.frames[0].params.text, "进度");
  run.send({ method: "notifications/cancelled", params: { requestId: 2 } });
  await run.waitFor(() => cancellationReached);
  run.child.stdin.end();
  await run.waitFor(() => toolEnded);
  assert.deepEqual(await run.closed, [0, null], run.stderr());
  assert.equal(run.frames.filter((frame) => frame.id === 2).length, 0);
});

test("SSE delivers a matching response and releases the request without waiting for EOF", { timeout: 8000 }, async (t) => {
  const { instance, url } = await server(async (req, res) => {
    const request = await requestBody(req);
    res.setHeader("content-type", "text/event-stream");
    res.write('data: {"id":123456,"result":{"wrong":true}}\r\n\r\n');
    res.write(`data: {"jsonrpc":"2.0","id":${request.id},\r\ndata: "result":{"done":true}}\r\n\r\n`);
  });
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  const run = liveBridge(t, url);
  run.send({ id: 9, method: "tools/call" });
  run.child.stdin.end();
  await run.waitFor(() => run.frames.length === 1 && run.child.exitCode !== null);
  assert.deepEqual(run.frames, [{ jsonrpc: "2.0", id: 9, result: { done: true } }]);
});

test("SSE terminal errors are matched by id and complete without EOF", { timeout: 8000 }, async (t) => {
  const { instance, url } = await server(async (req, res) => {
    const request = await requestBody(req);
    res.setHeader("content-type", "text/event-stream");
    res.write('data: {"id":-1,"error":{"code":-1}}\n\n');
    res.write('data: ' + JSON.stringify({ id: request.id, error: { code: -42, message: "test" } }) + "\n\n");
  });
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  const run = liveBridge(t, url);
  run.send({ id: 9, method: "tools/call" });
  run.child.stdin.end();
  await run.waitFor(() => run.frames.length === 1 && run.child.exitCode !== null);
  assert.deepEqual(run.frames, [{ id: 9, error: { code: -42, message: "test" } }]);
});

test("cancellation aborts a held tool even if its control notification never receives a response", { timeout: 8000 }, async (t) => {
  let initialized = false;
  let closed = false;
  let cancelling = false;
  const { instance, url } = await server(async (req, res) => {
    const request = await requestBody(req);
    if (request.method === "initialize") {
      res.setHeader("mcp-session-id", "session");
      jsonResponse(res, request, { protocolVersion: "2025-06-18" });
    } else if (request.method === "notifications/initialized") { initialized = true; res.writeHead(202).end(); }
    else if (request.method === "notifications/cancelled") { cancelling = true; /* hung control request */ }
    else {
      res.setHeader("content-type", "text/event-stream");
      res.write('data: {"method":"notifications/progress"}\n\n');
      res.on("close", () => { closed = true; });
    }
  });
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  const run = liveBridge(t, url);
  run.send({ id: 1, method: "initialize" });
  run.send({ method: "notifications/initialized" });
  await run.waitFor(() => initialized);
  run.send({ id: 2, method: "tools/call" });
  await run.waitFor(() => run.frames.some((frame) => frame.method === "notifications/progress"));
  run.send({ method: "notifications/cancelled", params: { requestId: 2 } });
  await run.waitFor(() => cancelling && closed);
  run.child.stdin.end();
  assert.deepEqual(await run.closed, [0, null]);
  assert.equal(run.frames.some((frame) => frame.id === 2), false);
});

test("SSE rejects an oversized unfinished event with bounded buffering", { timeout: 8000 }, async (t) => {
  const { instance, url } = await server(async (_req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.write("data: " + "x".repeat(256));
  });
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  const run = liveBridge(t, url, { MCP_BRIDGE_MAX_RESPONSE_BYTES: "128" });
  run.send({ id: 9, method: "tools/call" });
  run.child.stdin.end();
  await run.waitFor(() => run.frames.length === 1);
  assert.match(run.frames[0].error.message, /exceeded 128 bytes/);
});

for (const expiredStatus of [401, 404, 410]) test(`initialization orders sessions and HTTP ${expiredStatus} concurrent calls share one recovery`, { timeout: 8000 }, async (t) => {
  let initializations = 0;
  let ready = "";
  const expired = [];
  const seen = [];
  const { instance, url } = await server(async (req, res) => {
    const request = await requestBody(req);
    seen.push({ method: request.method, session: req.headers["mcp-session-id"], version: req.headers["mcp-protocol-version"] });
    if (request.method === "initialize") {
      initializations++;
      ready = "";
      assert.equal(req.headers["mcp-session-id"], undefined);
      res.setHeader("mcp-session-id", "session-" + initializations);
      jsonResponse(res, request, { protocolVersion: "2025-06-18" });
    } else if (request.method === "notifications/initialized") {
      ready = req.headers["mcp-session-id"];
      res.writeHead(202).end();
    } else if (req.headers["mcp-session-id"] === "session-1") {
      assert.equal(ready, "session-1");
      expired.push(res);
      if (expired.length === 3) for (const response of expired) response.writeHead(expiredStatus).end();
    } else {
      assert.equal(ready, "session-2");
      assert.equal(req.headers["mcp-session-id"], "session-2");
      assert.equal(req.headers["mcp-protocol-version"], "2025-06-18");
      res.setHeader("mcp-session-id", "stale-call-must-not-overwrite-session");
      jsonResponse(res, request, { ok: true });
    }
  });
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  const run = liveBridge(t, url);
  run.send({ id: 1, method: "initialize", params: {} });
  run.send({ method: "notifications/initialized" });
  for (let id = 2; id <= 4; id++) run.send({ id, method: "tools/call" });
  await run.waitFor(() => run.frames.filter((frame) => frame.result?.ok).length === 3);
  run.send({ id: 5, method: "tools/list" });
  run.child.stdin.end();
  await run.waitFor(() => run.frames.some((frame) => frame.id === 5));
  assert.equal(initializations, 2);
  assert.equal(run.frames.filter((frame) => frame.id === 1).length, 1);
  assert.deepEqual(seen.slice(0, 2).map((entry) => entry.method), ["initialize", "notifications/initialized"]);
  assert.equal(run.frames.some((frame) => frame.error), false);
});

for (const initializationResult of [
  { error: { code: -1, message: "private failure" } },
  { result: {} },
  { result: null },
  { result: { protocolVersion: "2099-01-01" } },
]) test(`invalid initialize ${JSON.stringify(initializationResult)} with a session header blocks later calls`, { timeout: 8000 }, async (t) => {
  const methods = [];
  const { instance, url } = await server(async (req, res) => {
    const request = await requestBody(req);
    methods.push(request.method);
    res.setHeader("mcp-session-id", "invalid-session");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...initializationResult }));
  });
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  const result = await runBridge(url, [
    { id: 1, method: "initialize" }, { method: "notifications/initialized" }, { id: 2, method: "tools/list" },
  ]);
  assert.deepEqual(methods, ["initialize"]);
  assert.equal(result.stdout.trim().split("\n").length, 2);
  assert.doesNotMatch(result.stdout, /private failure/);
});

test("ordinary HTTP calls are bounded and a saturated input queue fails promptly", { timeout: 8000 }, async (t) => {
  let active = 0;
  const { instance, url } = await server(async (req, _res) => {
    await requestBody(req);
    active++;
  });
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  const run = liveBridge(t, url);
  for (let id = 1; id <= 40; id++) run.send({ id, method: "tools/call" });
  await run.waitFor(() => active === 8);
  run.send({ id: 41, method: "tools/call" });
  await run.waitFor(() => run.child.exitCode !== null);
  assert.equal(active, 8);
  assert.equal(run.child.exitCode, 1);
});

test("MCP bridge logs metadata but never request/response payloads", async () => {
  const sensitive = "private prompt and local path C:/secret.txt";
  const remoteSensitive = "private remote page contents";
  const { instance, url } = await server(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(request.method === "initialize"
      ? { jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-03-26" } }
      : request.id == null
        ? {}
        : { jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: remoteSensitive }] } }));
  });
  try {
    const result = await runBridge(url, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "reader", arguments: { text: sensitive } } },
    ]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /private remote page contents/);
    for (const forbidden of [sensitive, remoteSensitive, "bridge-test-key-never-log"]) {
      assert.doesNotMatch(result.stderr, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(result.stderr, /method=tools\/call/);
  } finally {
    instance.close();
  }
});

test("MCP bridge rejects a declared oversized response before buffering it", async () => {
  const { instance, url } = await server(async (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("content-length", "1024");
    res.end("{}");
  });
  try {
    const result = await runBridge(
      url,
      [{ jsonrpc: "2.0", id: 7, method: "initialize", params: {} }],
      { MCP_BRIDGE_MAX_RESPONSE_BYTES: "32" },
    );
    assert.equal(result.code, 0);
    assert.match(result.stdout, /exceeded 32 bytes/);
  } finally {
    instance.close();
  }
});
