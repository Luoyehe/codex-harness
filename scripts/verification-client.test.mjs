import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { WebSocketServer } from "ws";

// Import with a synthetic credential so ws-token never reads a real Codex home.
const oldToken = process.env.GATEWAY_TOKEN;
process.env.GATEWAY_TOKEN = "verification-test-only";
const { VerificationClient, completedTurn, completedCompaction, finalAnswer, terminalMarkerPredicate, cleanupThread, cleanupTerminal, requirePaidVerification } = await import("../deploy/verification-client.mjs");
if (oldToken === undefined) delete process.env.GATEWAY_TOKEN;
else process.env.GATEWAY_TOKEN = oldToken;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const runFile = promisify(execFile);

async function eventually(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Local verification test condition timed out");
    await delay(5);
  }
}

async function fixture(t, onMessage = () => {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const messages = [];
  const connections = [];
  const clients = [];
  server.on("connection", (socket, request) => {
    connections.push({ socket, request });
    socket.on("message", data => {
      const message = JSON.parse(data.toString());
      if (message.method === "turn/start") assert.match(message.params?.clientOperationId ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, "public turn/start requires a stable operation ID");
      messages.push(message);
      onMessage(socket, message);
    });
  });
  t.after(async () => {
    for (const client of clients) client.close();
    for (const { socket } of connections) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  return {
    url, server, messages, connections,
    async client(options = {}) {
      const client = new VerificationClient(url, options, { openTimeoutMs: 200 });
      clients.push(client);
      await client.opened;
      return client;
    },
  };
}

function result(socket, message, value, error) {
  socket.send(JSON.stringify({ kind: "rpcResult", id: message.id, result: value, ...(error ? { error } : {}) }));
}

test("RPC timeout removes its waiter, ignores late results, and permits a subsequent RPC", { timeout: 5000 }, async t => {
  const f = await fixture(t, (socket, message) => {
    if (message.method === "echo") result(socket, message, message.params);
  });
  const client = await f.client();
  await assert.rejects(client.rpc("silent", {}, 30), /RPC silent timed out/);
  assert.equal(client.pending.size, 0);
  result(f.connections[0].socket, f.messages[0], { late: true });
  assert.deepEqual(await client.rpc("echo", { value: 42 }), { value: 42 });
  assert.equal(client.pending.size, 0);
  assert.equal(client.closed, false);
});

test("remote close rejects in-flight RPCs, notification waits, and future RPCs", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const client = await f.client();
  const pending = assert.rejects(client.rpc("silent"), /closed/i);
  const waiting = assert.rejects(client.waitFor(() => false), /closed/i);
  await eventually(() => f.messages.length === 1);
  f.connections[0].socket.close();
  await Promise.all([pending, waiting]);
  assert.equal(client.pending.size, 0);
  await assert.rejects(client.rpc("after-close"), /closed/i);
});

test("a stalled WebSocket handshake has a bounded timeout and closes safely before first RPC", { timeout: 5000 }, async t => {
  const sockets = new Set();
  const server = createServer();
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  // Deliberately accept the upgrade request but never complete the handshake.
  server.on("upgrade", () => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new VerificationClient(`ws://127.0.0.1:${server.address().port}`, {}, { openTimeoutMs: 25 });
  t.after(async () => {
    client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  // Waiting before observing opened also detects unhandled rejection regressions.
  await delay(60);
  await assert.rejects(client.opened, /connection timed out/);
  await assert.rejects(client.rpc("never-sent"), /connection timed out/);
  assert.equal(client.closed, true);
  assert.equal(client.pending.size, 0);
});

for (const malformed of ["not json", "null"]) {
  test(`invalid gateway frame ${JSON.stringify(malformed)} rejects pending work without an uncaught exception`, { timeout: 5000 }, async t => {
    const f = await fixture(t, socket => socket.send(malformed));
    const client = await f.client();
    await assert.rejects(client.rpc("malformed"), /Invalid gateway/);
    assert.equal(client.pending.size, 0);
    assert.equal(client.closed, true);
  });
}

test("serialization and invalid timeout failures do not leave pending timers", { timeout: 5000 }, async t => {
  const f = await fixture(t, (socket, message) => result(socket, message, "ok"));
  const client = await f.client();
  const circular = {};
  circular.self = circular;
  await assert.rejects(client.rpc("circular", circular), /not serializable/);
  for (const timeout of [0, -1, NaN, Infinity, 2147483648]) {
    await assert.rejects(client.rpc("invalid", {}, timeout), /timeout must be/);
    await assert.rejects(client.waitFor(() => false, timeout), /timeout must be/);
  }
  assert.equal(client.pending.size, 0);
  assert.equal(f.messages.length, 0);
  assert.equal(await client.rpc("after-invalid"), "ok");
});

test("notification waiting returns a matching frame and rejects a missing frame on timeout", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const client = await f.client();
  f.connections[0].socket.send(JSON.stringify({ kind: "notification", method: "expected", params: { value: 1 } }));
  assert.equal((await client.waitFor(note => note.method === "expected", 500)).params.value, 1);
  await assert.rejects(client.waitFor(note => note.method === "missing", 25), /notification timed out/);
});

test("interactive requests use protocol-specific refusals, never affirmative permissions", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const client = await f.client();
  const reason = "Unattended verification declines interactive requests";
  const cases = [
    ["item/commandExecution/requestApproval", { decision: "decline" }],
    ["item/fileChange/requestApproval", { decision: "decline" }],
    ["item/permissions/requestApproval", { permissions: {}, scope: "turn" }],
    ["mcpServer/elicitation/request", { action: "decline", content: null, _meta: null }],
    ["item/tool/requestUserInput", { answers: {} }],
    ["applyPatchApproval", { decision: { denied: { rejection: reason } } }],
    ["execCommandApproval", { decision: { denied: { rejection: reason } } }],
    ["unknown/request", null, reason],
  ];
  for (const [index, [method, payload, error]] of cases.entries()) {
    const requestId = index % 2 ? index : `request-${index}`;
    f.connections[0].socket.send(JSON.stringify({ kind: "serverRequest", requestId, method, params: { permissions: { network: { enabled: true } } } }));
    await eventually(() => f.messages.length === index + 1);
    assert.deepEqual(f.messages[index], { kind: "serverRequestResponse", requestId, payload, ...(error ? { error } : {}) });
  }
  assert.equal(client.closed, false);
});

test("paid opt-in accepts only exact 1 and completedTurn enforces it before sending", { timeout: 5000 }, async t => {
  const prior = process.env.HARNESS_ALLOW_PAID_TESTS;
  t.after(() => {
    if (prior === undefined) delete process.env.HARNESS_ALLOW_PAID_TESTS;
    else process.env.HARNESS_ALLOW_PAID_TESTS = prior;
  });
  const f = await fixture(t);
  const client = await f.client();
  for (const value of [undefined, "", "0", "true", "yes"]) {
    if (value === undefined) delete process.env.HARNESS_ALLOW_PAID_TESTS;
    else process.env.HARNESS_ALLOW_PAID_TESTS = value;
    assert.throws(requirePaidVerification, /HARNESS_ALLOW_PAID_TESTS=1/);
    await assert.rejects(completedTurn(client, "never-started"), /HARNESS_ALLOW_PAID_TESTS=1/);
  }
  process.env.HARNESS_ALLOW_PAID_TESTS = "1";
  assert.doesNotThrow(requirePaidVerification);
  assert.equal(f.messages.length, 0);
});

test("paid script entrypoints fail before establishing any connection without explicit opt-in", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  for (const path of ["../deploy/verify-full.mjs", "../deploy/verify-model.mjs", "../apps/web/scripts/verify-usage.mjs"]) {
    await assert.rejects(runFile(process.execPath, [fileURLToPath(new URL(path, import.meta.url))], {
      env: { ...process.env, GATEWAY_TOKEN: "verification-test-only", GATEWAY_WS: f.url, HARNESS_ALLOW_PAID_TESTS: "" },
      timeout: 3000, windowsHide: true,
    }), error => error.code === 1 && /HARNESS_ALLOW_PAID_TESTS=1/.test(error.stderr));
  }
  assert.equal(f.connections.length, 0);
});

test("completedTurn correlates the exact thread and turn and treats provider failure as failure", { timeout: 5000 }, async t => {
  const prior = process.env.HARNESS_ALLOW_PAID_TESTS;
  process.env.HARNESS_ALLOW_PAID_TESTS = "1";
  t.after(() => {
    if (prior === undefined) delete process.env.HARNESS_ALLOW_PAID_TESTS;
    else process.env.HARNESS_ALLOW_PAID_TESTS = prior;
  });
  let counter = 0;
  const f = await fixture(t, (socket, message) => {
    const id = `turn-${++counter}`;
    result(socket, message, { turn: { id } });
    for (const [threadId, turnId, status] of [["unrelated-thread", id, "completed"], [message.params.threadId, "unrelated-turn", "completed"], [message.params.threadId, id, message.params.text === "fail" ? "failed" : "completed"]]) {
      socket.send(JSON.stringify({ kind: "notification", method: "turn/completed", params: { threadId, turn: { id: turnId, status } } }));
    }
  });
  const client = await f.client();
  assert.equal(await completedTurn(client, "target-thread", { threadId: "cannot-override-target", clientOperationId: "cannot-override-operation" }), "turn-1");
  assert.equal(f.messages[0].params.threadId, "target-thread");
  await assert.rejects(completedTurn(client, "target-thread", { text: "fail" }), /provider errors are not successful/);
  assert.equal(f.messages.length, 2);
  assert.notEqual(f.messages[0].params.clientOperationId, f.messages[1].params.clientOperationId);
});

test("completedTurn submits one operation and never retries an unknown transport outcome", async t => {
  const previous = process.env.HARNESS_ALLOW_PAID_TESTS;
  process.env.HARNESS_ALLOW_PAID_TESTS = "1";
  t.after(() => { if (previous === undefined) delete process.env.HARNESS_ALLOW_PAID_TESTS; else process.env.HARNESS_ALLOW_PAID_TESTS = previous; });
  const calls = [];
  const client = {
    async rpc(method, params) { calls.push({ method, params }); throw new Error("synthetic transport uncertainty"); },
    async waitFor() { throw new Error("must not wait without admission response"); },
  };
  await assert.rejects(completedTurn(client, "test-thread"), /transport uncertainty/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "turn/start");
  assert.match(calls[0].params.clientOperationId, /^[0-9a-f-]{36}$/i);
});

test("cleanup reconnects after remote close with the original auth, deletes, and closes the temporary connection", { timeout: 5000 }, async t => {
  const f = await fixture(t, (socket, message) => {
    if (message.method === "turn/interrupt") result(socket, message, null, "already idle");
    else result(socket, message, {});
  });
  const client = await f.client({ headers: { Authorization: "Bearer synthetic-cleanup-token" } });
  f.connections[0].socket.close();
  await eventually(() => client.closed);
  await cleanupThread(client, "temporary-thread");
  assert.equal(f.connections.length, 2);
  assert.equal(f.connections[1].request.headers.authorization, "Bearer synthetic-cleanup-token");
  assert.deepEqual(f.messages.map(({ method, params }) => ({ method, params })), [
    { method: "turn/interrupt", params: { threadId: "temporary-thread" } },
    { method: "thread/delete", params: { threadId: "temporary-thread" } },
  ]);
  await eventually(() => f.connections[1].socket.readyState === 3);
});

test("cleanup reconnects when the original connection drops during interruption", { timeout: 5000 }, async t => {
  const f = await fixture(t, (socket, message) => {
    if (message.method === "turn/interrupt") socket.close();
    else result(socket, message, {});
  });
  const client = await f.client();
  await cleanupThread(client, "temporary-thread");
  assert.equal(f.connections.length, 2);
  assert.deepEqual(f.messages.map(message => message.method), ["turn/interrupt", "thread/delete"]);
});

test("cleanup reports deletion rejection instead of claiming successful cleanup", { timeout: 5000 }, async t => {
  const f = await fixture(t, (socket, message) => result(socket, message, null, "rejected"));
  const client = await f.client();
  client.close();
  await assert.rejects(cleanupThread(client, "temporary-thread"), /thread\/delete rejected/);
  await eventually(() => f.connections[1]?.socket.readyState === 3);
});

test("cleanup reports unavailable reconnect instead of silently skipping deletion", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const client = await f.client();
  client.close();
  for (const { socket } of f.connections) socket.terminate();
  await new Promise(resolve => f.server.close(resolve));
  await assert.rejects(cleanupThread(client, "temporary-thread"), /connection failed/);
});

test("terminal cleanup reconnects after close rather than abandoning the remote process", { timeout: 5000 }, async t => {
  const f = await fixture(t, (socket, message) => result(socket, message, {}));
  const client = await f.client();
  client.close();
  await cleanupTerminal(client, "temporary-process");
  assert.deepEqual(f.messages.map(({ method, params }) => ({ method, params })), [
    { method: "terminal/terminate", params: { processId: "temporary-process" } },
  ]);
  await eventually(() => f.connections[1]?.socket.readyState === 3);
});

test("full verification works against an isolated protocol fixture with split terminal output and cleans its thread", { timeout: 10000 }, async t => {
  const threadId = "fixture-thread";
  const processId = "fixture-terminal";
  const notify = (socket, method, params) => socket.send(JSON.stringify({ kind: "notification", method, params }));
  const f = await fixture(t, (socket, message) => {
    switch (message.method) {
      case "app/status": result(socket, message, { codexState: "ready", workspaceRoot: "fixture-workspace" }); break;
      case "projects/list": result(socket, message, { projects: [] }); break;
      case "fs/readDirectory": result(socket, message, { entries: [] }); break;
      case "thread/start":
      case "thread/read":
      case "thread/resume": result(socket, message, { thread: { id: threadId } }); break;
      case "turn/start":
        result(socket, message, { turn: { id: "fixture-turn" } });
        notify(socket, "item/completed", { threadId, turnId: "fixture-turn", item: { type: "agentMessage", phase: "final_answer", text: message.params.text.match(/VERIFY_[a-f0-9]+/)[0] } });
        notify(socket, "turn/completed", { threadId, turn: { id: "fixture-turn", status: "completed" } });
        break;
      case "terminal/exec": result(socket, message, { processId }); break;
      case "terminal/write": {
        result(socket, message, {});
        const command = Buffer.from(message.params.base64, "base64").toString();
        const output = command + "\n" + command.replace(/^echo /, "").trim() + "\r\n";
        const middle = Math.floor(output.length / 2);
        for (const chunk of [output.slice(0, middle), output.slice(middle)]) {
          notify(socket, "command/exec/outputDelta", { processId, deltaBase64: Buffer.from(chunk).toString("base64") });
        }
        break;
      }
      case "thread/compact/start":
        result(socket, message, {});
        notify(socket, "turn/started", { threadId, turn: { id: "compact-turn", status: "inProgress" } });
        notify(socket, "item/completed", { threadId, turnId: "compact-turn", item: { id: "fixture-compaction", type: "contextCompaction" } });
        notify(socket, "turn/completed", { threadId, turn: { id: "compact-turn", status: "completed" } });
        break;
      case "process/spawn": result(socket, message, null, "unknown method"); break;
      default: result(socket, message, {});
    }
  });
  const response = await runFile(process.execPath, [fileURLToPath(new URL("../deploy/verify-full.mjs", import.meta.url))], {
    env: { ...process.env, GATEWAY_TOKEN: "verification-test-only", GATEWAY_WS: f.url, HARNESS_ALLOW_PAID_TESTS: "1" },
    timeout: 5000, windowsHide: true,
  });
  assert.match(response.stdout, /FULL-E2E-PASS/);
  assert.deepEqual(f.messages.slice(-2).map(({ method, params }) => ({ method, params })), [
    { method: "turn/interrupt", params: { threadId } },
    { method: "thread/delete", params: { threadId } },
  ]);
  assert.ok(f.messages.some(message => message.method === "terminal/terminate" && message.params.processId === processId));
});

test("final answer excludes commentary, unknown phases and unrelated turns", () => {
  const answer = (text, phase, threadId = "t", turnId = "r") => ({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", text, phase } } });
  assert.equal(finalAnswer([answer("not final", "commentary"), answer("unknown", "future"), answer("wrong thread", null, "other"), answer("wrong turn", null, "t", "other"), answer("OK", "final_answer")], "t", "r"), "OK");
  assert.equal(finalAnswer([answer("legacy", null)], "t", "r"), "legacy");
});

test("terminal marker requires an executed output line, not input echo or another process", () => {
  const predicate = terminalMarkerPredicate("p", "VERIFY_1234");
  const delta = (text, processId = "p") => ({ method: "command/exec/outputDelta", params: { processId, deltaBase64: Buffer.from(text).toString("base64") } });
  assert.equal(predicate(delta("echo VERIFY_1234\r\n")), false);
  assert.equal(predicate(delta("VERIFY_1234\r\n", "other")), false);
  const part = delta("VERIFY_");
  assert.equal(predicate(part), false);
  assert.equal(predicate(part), false);
  assert.equal(predicate(delta("1234\r")), false);
  assert.equal(predicate(delta("\n")), true);
});

for (const mode of ["valid", "commentary", "wrong-answer", "cleanup-rejected"]) {
  test(`model verifier requires exact final reply and successful cleanup: ${mode}`, { timeout: 10000 }, async t => {
    const notify = (socket, method, params) => socket.send(JSON.stringify({ kind: "notification", method, params }));
    const f = await fixture(t, (socket, message) => {
      if (message.method === "thread/start") result(socket, message, { thread: { id: "test-thread" } });
      else if (message.method === "turn/start") {
        result(socket, message, { turn: { id: "test-turn" } });
        const text = mode === "wrong-answer" ? "OK" : message.params.text.match(/VERIFY_[a-f0-9]+/)[0];
        notify(socket, "item/completed", { threadId: "test-thread", turnId: "test-turn", item: { type: "agentMessage", phase: mode === "commentary" ? "commentary" : "final_answer", text } });
        notify(socket, "turn/completed", { threadId: "test-thread", turn: { id: "test-turn", status: "completed" } });
      } else if (message.method === "thread/delete" && mode === "cleanup-rejected") result(socket, message, null, "denied");
      else result(socket, message, {});
    });
    const run = runFile(process.execPath, [fileURLToPath(new URL("../deploy/verify-model.mjs", import.meta.url))], {
      env: { ...process.env, GATEWAY_TOKEN: "verification-test-only", GATEWAY_WS: f.url, HARNESS_ALLOW_PAID_TESTS: "1" },
      timeout: 5000, windowsHide: true,
    });
    if (mode === "valid") assert.match((await run).stdout, /MODEL-VERIFICATION-PASS/);
    else await assert.rejects(run, error => error.code === 1 && !error.stdout.includes("MODEL-VERIFICATION-PASS"));
    assert.ok(f.messages.some(message => message.method === "thread/delete"));
  });
}

test("compaction requires its own successful terminal turn and matching completed item", async t => {
  const prior = process.env.HARNESS_ALLOW_PAID_TESTS;
  process.env.HARNESS_ALLOW_PAID_TESTS = "1";
  t.after(() => { if (prior === undefined) delete process.env.HARNESS_ALLOW_PAID_TESTS; else process.env.HARNESS_ALLOW_PAID_TESTS = prior; });
  for (const mode of ["valid", "failed", "wrong-turn"]) {
    const client = {
      notes: [{ method: "turn/started", params: { threadId: "t", turn: { id: "stale" } } }],
      async rpc(method) {
        assert.equal(method, "thread/compact/start");
        assert.equal(this.notes.length, 0);
        this.notes.push(
          { method: "turn/started", params: { threadId: "t", turn: { id: "r" } } },
          { method: "item/completed", params: { threadId: "t", turnId: mode === "wrong-turn" ? "stale" : "r", item: { type: "contextCompaction" } } },
          { method: "turn/completed", params: { threadId: "t", turn: { id: "r", status: mode === "failed" ? "failed" : "completed" } } },
        );
      },
      async waitFor(predicate) { const found = this.notes.find(predicate); assert.ok(found); return found; },
    };
    if (mode === "valid") await completedCompaction(client, "t");
    else await assert.rejects(completedCompaction(client, "t"), /Compaction lacked/);
  }
});
