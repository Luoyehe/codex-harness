import assert from "node:assert/strict";
import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { providerVerificationConfig, runProviderVerification, syntheticExpected } from "../deploy/verify-provider.mjs";

// The script imports the real bounded helper lazily. A synthetic token prevents
// its authentication module from consulting any real Codex home during tests.
const oldToken = process.env.GATEWAY_TOKEN, oldPaid = process.env.HARNESS_ALLOW_PAID_TESTS;
before(() => { process.env.GATEWAY_TOKEN = "synthetic-verifier-test-token-000000"; process.env.HARNESS_ALLOW_PAID_TESTS = "1"; });
after(() => {
  if (oldToken === undefined) delete process.env.GATEWAY_TOKEN; else process.env.GATEWAY_TOKEN = oldToken;
  if (oldPaid === undefined) delete process.env.HARNESS_ALLOW_PAID_TESTS; else process.env.HARNESS_ALLOW_PAID_TESTS = oldPaid;
});

const expected = "HARNESS_SYNTHETIC_0123456789abcdef0123456789abcdef";
const env = {
  HARNESS_VERIFY_MODE: "openai", HARNESS_VERIFY_PROVIDER: "openai", HARNESS_VERIFY_MODEL: "fixture-model",
  HARNESS_VERIFY_AUTH_MODE: "chatgpt", HARNESS_VERIFY_CWD: "/isolated/verification-case",
  HARNESS_VERIFY_FIXTURE: "/isolated/verification-case/fixture.txt", HARNESS_VERIFY_EXPECTED_FILE: "/private-verifier/expected.txt",
};

test("synthetic expectation reads are descriptor-pinned, singly linked and bounded", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "provider-expectation-"));
  try {
    const file = path.join(directory, "expected");
    writeFileSync(file, expected + "\n");
    assert.equal(syntheticExpected(file), expected);
    const oversized = path.join(directory, "oversized");
    writeFileSync(oversized, "x".repeat(129));
    assert.throws(() => syntheticExpected(oversized), /invalid_synthetic_expectation/);
    if (process.platform !== "win32") {
      const alias = path.join(directory, "alias");
      const linked = path.join(directory, "linked");
      symlinkSync(file, alias);
      linkSync(file, linked);
      assert.throws(() => syntheticExpected(alias), /invalid_synthetic_expectation/);
      assert.throws(() => syntheticExpected(linked), /invalid_synthetic_expectation/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function setup(failure = "none", configEnv = env) {
  const calls = [], clients = [], output = [], reads = [];
  let nonce, attempts = 0, clock = 100;
  const thread = () => ({ thread: { id: "thread-test", modelProvider: configEnv.HARNESS_VERIFY_PROVIDER, cwd: configEnv.HARNESS_VERIFY_CWD },
    model: configEnv.HARNESS_VERIFY_MODEL, modelProvider: configEnv.HARNESS_VERIFY_PROVIDER, cwd: configEnv.HARNESS_VERIFY_CWD,
    sandbox: { type: "readOnly", networkAccess: false }, approvalPolicy: "never" });
  const createClient = previous => {
    if (previous) assert.equal(previous.closed, true, "resume must use a new connection after closing the old one");
    const client = {
      notes: [], closed: false, ws: { readyState: 1 }, url: "ws://127.0.0.1:1", options: {}, openTimeoutMs: 20,
      async rpc(method, params) {
        calls.push({ connection: clients.indexOf(this), method, params });
        if (method === "app/status") return { codexState: "ready", providerMode: failure === "mode" ? "wrong-mode" : configEnv.HARNESS_VERIFY_MODE };
        if (method === "account/read") return { account: { type: failure === "auth" ? "apiKey" : "chatgpt", email: "private-account@example.com", secret: "<RAW_ACCOUNT_SECRET>" } };
        if (method === "thread/start") {
          const response = thread();
          if (failure === "model") response.model = "unexpected-model";
          if (failure === "provider") response.thread.modelProvider = "unexpected-provider";
          if (failure === "sandbox") response.sandbox.type = "dangerFullAccess";
          return response;
        }
        if (method === "thread/resume") {
          const response = thread();
          if (failure === "resume") response.modelProvider = "unexpected-provider";
          return response;
        }
        if (method === "thread/delete" && failure === "cleanup") throw new Error("RAW_CLEANUP_SECRET");
        if (method !== "turn/start") return {};
        const n = ++attempts, id = `turn-${n}`;
        assert.ok(n <= 3, "the verifier must never auto-retry beyond three turn starts");
        assert.equal(params.approvalPolicy, "never");
        assert.equal(Object.hasOwn(params, "sandbox"), false, "turn/start must inherit the thread's read-only sandbox");
        const note = (method, detail) => this.notes.push({ method, params: { threadId: "thread-test", turnId: id, ...detail } });
        note("turn/started", { turn: { id, status: "inProgress" } });
        let reply;
        if (n === 1) {
          nonce = params.text.match(/NONCE_[a-f0-9]{32}/)[0];
          const [, left, right] = params.text.match(/Compute (\d+) \+ (\d+)/);
          reply = JSON.stringify({ nonce, sum: Number(left) + Number(right) + (failure === "arithmetic" ? 1 : 0) });
        } else if (n === 2) {
          assert.ok(!params.text.includes(nonce), "the resumed-memory challenge must not leak its expected nonce into the prompt");
          reply = JSON.stringify({ nonce: failure === "memory" ? "wrong-nonce" : nonce });
        } else {
          assert.ok(params.text.includes(configEnv.HARNESS_VERIFY_FIXTURE));
          assert.ok(!params.text.includes(expected) && !params.text.includes(configEnv.HARNESS_VERIFY_EXPECTED_FILE));
          reply = expected;
          const item = { type: "commandExecution", id: "file-command", command: `cat -- '${configEnv.HARNESS_VERIFY_FIXTURE}'`,
            cwd: configEnv.HARNESS_VERIFY_CWD, status: "completed", exitCode: 0, aggregatedOutput: expected + "\n" };
          if (failure === "exit-code") item.exitCode = 1;
          if (failure === "command-status") item.status = "failed";
          if (failure === "output") item.aggregatedOutput = "unrelated output";
          if (failure === "echo") item.command = `echo '${expected}'`;
          if (failure === "wrong-file") item.command = "cat /unrelated-real-file";
          if (failure.startsWith("wrapped")) {
            const innerCommand = item.command;
            item.command = `/bin/bash -lc "${innerCommand}"`;
            item.commandActions = [{ type: "read", command: innerCommand, name: "fixture.txt", path: configEnv.HARNESS_VERIFY_FIXTURE }];
            if (failure === "wrapped-relative") item.commandActions[0].path = "./fixture.txt";
            if (failure === "wrapped-echo") item.commandActions[0].command = `echo '${expected}'`;
            if (failure === "wrapped-outer-echo") item.command = `echo '${expected}'`;
            if (failure === "wrapped-multiple") item.commandActions.push({ type: "unknown", command: "another-command" });
            if (failure === "wrapped-wrong-path") item.commandActions[0].path = "../other-fixture.txt";
            if (failure === "wrapped-unknown") item.commandActions[0].type = "unknown";
            if (failure === "wrapped-no-action") item.commandActions = [];
          }
          if (failure !== "oral-only") {
            note(failure === "started-only" ? "item/started" : "item/completed", { item, ...(failure === "stale-tool" ? { turnId: "older-turn" } : {}) });
            if (failure === "duplicate-event") note("item/completed", { item });
          }
        }
        if (failure === "unexpected-tool" && n === 1) note("item/completed", { item: { type: "webSearch", id: "unexpected-tool" } });
        const extra = /^extra-(1|3)-(.+)$/.exec(failure);
        if (extra && n === Number(extra[1])) note("item/completed", { item: { type: extra[2], id: "extra-activity" } });
        note("item/completed", { item: { id: `answer-${n}`, type: "agentMessage", phase: failure === "commentary" ? "commentary" : "final_answer", text: reply } });
        if (failure === "reroute") note("model/rerouted", { fromModel: configEnv.HARNESS_VERIFY_MODEL, toModel: "other-model", reason: "highRiskCyberActivity" });
        if (failure !== "no-usage") note("thread/tokenUsage/updated", {
          ...(failure === "stale-usage" ? { turnId: "older-turn" } : {}),
          tokenUsage: { last: { totalTokens: 5, inputTokens: 3, outputTokens: 2, arbitrary: "RAW_USAGE_SECRET" }, total: { totalTokens: n * 5 }, modelContextWindow: 1000 },
        });
        if (failure !== "missing-terminal") note("turn/completed", { turn: { id, status: failure === "provider-error" ? "failed" : "completed", error: { message: "RAW_PROVIDER_ERROR_SECRET" } } });
        return { turn: { id } };
      },
      async waitFor(predicate) { const match = this.notes.find(predicate); if (!match) throw new Error("RAW_TIMEOUT_SECRET"); return match; },
      close() { this.closed = true; },
    };
    clients.push(client);
    return client;
  };
  return { calls, clients, output, reads, get nonce() { return nonce; }, run: () => runProviderVerification({ env: configEnv, createClient,
    readExpected: file => { reads.push(file); return failure === "bad-expectation" ? "not a synthetic fixture" : expected; },
    now: () => ++clock, log: line => output.push(line),
  }) };
}

test("successful business verification starts exactly three turns across two clients and emits only a safe summary", async () => {
  const f = setup();
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(result.budget.attemptedTurnStarts, 3);
  assert.equal(result.budget.automaticRetries, 0);
  assert.equal(result.budget.providerRequests, "not-bounded-by-turn-count");
  assert.deepEqual(f.reads, [env.HARNESS_VERIFY_EXPECTED_FILE]);
  assert.equal(f.clients.length, 2);
  assert.ok(f.clients.every(client => client.closed));
  assert.deepEqual(f.calls.filter(call => call.method === "thread/start").map(call => call.params), [
    { cwd: env.HARNESS_VERIFY_CWD, approvalPolicy: "never", sandbox: "read-only" },
  ]);
  assert.equal(f.calls.find(call => call.method === "thread/resume").connection, 1);
  assert.equal(f.calls.filter(call => call.method === "turn/start").length, 3);
  assert.deepEqual(f.calls.slice(-2).map(call => call.method), ["turn/interrupt", "thread/delete"]);
  assert.equal(f.calls.some(call => /compact|projects\/add|thread\/archive/.test(call.method)), false);
  assert.deepEqual(result.turns.map(turn => turn.turnId), ["turn-1", "turn-2", "turn-3"]);
  assert.ok(result.turns.every(turn => turn.turnStatus === "completed" && turn.receivedTerminal));
  assert.equal(result.turns[0].fixtureRead, null);
  assert.deepEqual(result.turns[2].fixtureRead, { commandRecognized: true, readActionMatched: false, exitCode: 0, outputMatched: true, finalReplyMatched: true });
  assert.deepEqual(result.turns.map(turn => turn.tools.started), [0, 0, 1]);
  assert.equal(result.turns[0].tokenUsage.last.cachedInputTokens, null);
  assert.equal(result.turns[2].tokenUsage.total.totalTokens, 15);
  assert.deepEqual(result.cleanup, { attempted: true, ok: true });
  assert.equal(f.output.length, 1);
  for (const privateText of [expected, f.nonce, env.HARNESS_VERIFY_FIXTURE, env.HARNESS_VERIFY_EXPECTED_FILE, "private-account", "RAW_", "Remember this nonce"]) {
    assert.ok(!f.output[0].includes(privateText), `summary leaked private data: ${privateText}`);
  }
  assert.deepEqual(JSON.parse(f.output[0]), result);
});

for (const type of ["imageView", "collabToolCall", "subAgentActivity", "sleep"]) {
  for (const turn of [1, 3]) test(`business verification rejects extra ${type} during turn ${turn}`, async () => {
    const f = setup(`extra-${turn}-${type}`);
    const result = await f.run();
    assert.equal(result.ok, false);
    assert.equal(result.budget.attemptedTurnStarts, turn);
    assert.equal(result.turns.at(-1).tools.started, turn === 1 ? 1 : 2);
    assert.deepEqual(result.cleanup, { attempted: true, ok: true });
  });
}

test("paid opt-in fails before expected-file reads or client construction", async () => {
  process.env.HARNESS_ALLOW_PAID_TESTS = "0";
  try {
    const f = setup();
    const result = await f.run();
    assert.equal(result.ok, false);
    assert.equal(result.failure.code, "paid_opt_in_required");
    assert.equal(f.reads.length, 0);
    assert.equal(f.clients.length, 0);
  } finally { process.env.HARNESS_ALLOW_PAID_TESTS = "1"; }
});

test("configuration requires isolated Linux paths, exact provider/model expectations and synthetic contents", async () => {
  for (const override of [
    { HARNESS_VERIFY_MODEL: "" }, { HARNESS_VERIFY_PROVIDER: "" }, { HARNESS_VERIFY_MODE: "unknown" },
    { HARNESS_VERIFY_CWD: "/" }, { HARNESS_VERIFY_FIXTURE: "/different/file" },
    { HARNESS_VERIFY_EXPECTED_FILE: env.HARNESS_VERIFY_FIXTURE }, { HARNESS_VERIFY_FIXTURE: "/isolated/verification-case/../real" },
    { HARNESS_VERIFY_AUTH_MODE: "unknown" },
  ]) assert.throws(() => providerVerificationConfig({ ...env, ...override }));
  const f = setup("bad-expectation");
  assert.equal((await f.run()).failure.code, "invalid_synthetic_expectation");
  assert.equal(f.clients.length, 0);
});

for (const [failure, attempts] of [["mode", 0], ["auth", 0], ["model", 0], ["provider", 0], ["sandbox", 0], ["resume", 1],
  ["arithmetic", 1], ["memory", 2], ["provider-error", 1], ["unexpected-tool", 1], ["commentary", 1],
  ["oral-only", 3], ["started-only", 3], ["exit-code", 3], ["command-status", 3], ["output", 3], ["echo", 3], ["wrong-file", 3], ["stale-tool", 3], ["reroute", 1], ["cleanup", 3]]) {
  test(`${failure} cannot pass or trigger automatic extra turns, and any created thread is cleaned`, async () => {
    const f = setup(failure);
    const result = await f.run();
    assert.equal(result.ok, false);
    assert.equal(result.budget.attemptedTurnStarts, attempts);
    assert.equal(f.calls.filter(call => call.method === "turn/start").length, attempts);
    const created = f.calls.some(call => call.method === "thread/start");
    assert.equal(result.cleanup.attempted, created);
    assert.equal(f.calls.some(call => call.method === "thread/delete"), created);
    if (failure === "cleanup") assert.equal(result.cleanup.ok, false);
    else if (created) assert.equal(result.cleanup.ok, true);
    assert.ok(f.clients.every(client => client.closed));
    assert.ok(!f.output[0].includes("RAW_"));
    if (failure === "reroute") assert.deepEqual(result.turns[0].reroutes, [{ fromModel: "fixture-model", toModel: "other-model", reason: "highRiskCyberActivity" }]);
  });
}

test("shell-wrapped reads accept only one exact inner cat action at the fixture path", async () => {
  for (const success of ["wrapped", "wrapped-relative"]) {
    const f = setup(success);
    const result = await f.run();
    assert.equal(result.ok, true, success);
    assert.deepEqual(result.turns[2].fixtureRead, { commandRecognized: true, readActionMatched: true, exitCode: 0, outputMatched: true, finalReplyMatched: true });
    assert.ok(!f.output[0].includes("/bin/bash") && !f.output[0].includes(env.HARNESS_VERIFY_FIXTURE));
  }
  for (const failure of ["wrapped-echo", "wrapped-outer-echo", "wrapped-multiple", "wrapped-wrong-path", "wrapped-unknown", "wrapped-no-action"]) {
    const result = await setup(failure).run();
    assert.equal(result.ok, false, failure);
    assert.equal(result.turns[2].fixtureRead.commandRecognized, false, failure);
    assert.equal(result.budget.attemptedTurnStarts, 3);
    assert.equal(result.cleanup.ok, true);
  }
});

test("safe diagnostics distinguish terminal failure, missing terminal, command, output and reply evidence", async () => {
  const failed = await setup("provider-error").run();
  assert.equal(failed.turns[0].receivedTerminal, true);
  assert.equal(failed.turns[0].turnStatus, "failed");
  const missing = await setup("missing-terminal").run();
  assert.equal(missing.ok, false);
  assert.equal(missing.turns[0].receivedTerminal, false);
  assert.equal(missing.turns[0].turnStatus, null);
  const badCommand = (await setup("echo").run()).turns[2].fixtureRead;
  assert.equal(badCommand.commandRecognized, false);
  assert.equal(badCommand.outputMatched, true);
  assert.equal(badCommand.finalReplyMatched, true);
  const badOutput = (await setup("output").run()).turns[2].fixtureRead;
  assert.equal(badOutput.commandRecognized, true);
  assert.equal(badOutput.outputMatched, false);
  assert.equal((await setup("exit-code").run()).turns[2].fixtureRead.exitCode, 1);
});

test("missing or stale usage is null, not invented zero, and duplicate tool notifications are deduplicated", async () => {
  for (const failure of ["no-usage", "stale-usage", "duplicate-event"]) {
    const result = await setup(failure).run();
    assert.equal(result.ok, true);
    assert.equal(result.turns[2].tools.commandExecutions, 1);
    if (failure !== "duplicate-event") assert.ok(result.turns.every(turn => turn.tokenUsage === null));
  }
});

test("provider expectations work for API providers without requiring ChatGPT account data", async () => {
  for (const [mode, provider] of [["zhipu", "ZAI"], ["custom", "custom"]]) {
    const f = setup("none", { ...env, HARNESS_VERIFY_MODE: mode, HARNESS_VERIFY_PROVIDER: provider, HARNESS_VERIFY_AUTH_MODE: "" });
    assert.equal((await f.run()).ok, true);
    assert.equal(f.calls.some(call => call.method === "account/read"), false);
  }
});
