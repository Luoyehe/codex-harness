import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { MCP_TASKS, runMcpVerification, taskEvidence, taskToolCounts } from "../deploy/verify-mcp-tools.mjs";

const oldToken = process.env.GATEWAY_TOKEN;
before(() => { process.env.GATEWAY_TOKEN = "synthetic-mcp-test-token-0000000000"; });
after(() => { if (oldToken === undefined) delete process.env.GATEWAY_TOKEN; else process.env.GATEWAY_TOKEN = oldToken; });

const task = MCP_TASKS[0];
const searchResults = [
  { title: "OpenAI developer documentation", link: "https://platform.openai.com/docs", content: "Guides for the OpenAI API" },
  { title: "OpenAI product announcements", link: "https://openai.com/news" },
  { title: "OpenAI research publications", link: "https://openai.com/research" },
];
const fixtureResults = {
  "web-search-prime": JSON.stringify({ search_result: searchResults }),
  "web-reader": "Example Domain\nThis domain is for use in documentation examples without needing permission.",
  zread: "vitejs/vite\npackage.json\nREADME.md\npnpm-lock.yaml\npackages\ndocs",
  "zai-vision": "A red rose with green leaves against a transparent background.",
};
const fixtureReplies = {
  "web-search-prime": searchResults.map(result => result.title).join("; "),
  "web-reader": "Example Domain: This domain is for use in documentation examples without needing permission.",
  zread: "The repository contains package.json, README.md, pnpm-lock.yaml, packages and docs.",
  "zai-vision": "图片主体是一朵红色玫瑰，带有绿色叶子，背景透明。",
};
function notes(status = "completed", type = "mcpToolCall", selected = task) {
  return [
    { method: "item/completed", params: { threadId: "t", turnId: "r", item: type === "mcpToolCall"
      ? { id: "tool-one", type, server: selected.server, tool: selected.tool, status: "completed", result: { content: [{ type: "text", text: fixtureResults[selected.key] }] }, error: null }
      : { id: "tool-one", type, namespace: selected.server, tool: selected.tool, status: "completed", success: true, contentItems: [{ type: "inputText", text: fixtureResults[selected.key] }] } } },
    { method: "item/completed", params: { threadId: "t", turnId: "r", item: { type: "agentMessage", text: fixtureReplies[selected.key] } } },
    { method: "turn/completed", params: { threadId: "t", turn: { id: "r", status } } },
  ];
}

test("search evidence requires three distinct returned titles and all first three in the reply", () => {
  const entries = [
    { title: "OpenAI developer documentation", url: "https://example.com/one" },
    { title: "OpenAI product announcements", url: "https://example.com/two" },
    { title: "OpenAI research publications", url: "https://example.com/three" },
    { title: "OpenAI help articles", url: "https://example.com/four" },
  ];
  const check = (returned, reply) => {
    const fixture = notes();
    fixture[0].params.item.result = { content: [], structuredContent: returned };
    fixture[1].params.item.text = reply;
    return taskEvidence(fixture, "t", "r", task);
  };
  assert.equal(check(entries.slice(0, 1), entries[0].title).ok, false);
  assert.equal(check([entries[0], entries[0], entries[0]], entries[0].title).ok, false);
  assert.equal(check(entries, entries.slice(1).map(entry => entry.title).join("; ")).ok, false);
  assert.equal(check(entries, entries.slice(0, 3).map(entry => entry.title).join("; ")).ok, true);
});

test("repository evidence requires at least five distinct returned paths and five grounded reply paths", () => {
  const selected = MCP_TASKS.find(item => item.key === "zread");
  const check = (returned, reply) => {
    const fixture = notes("completed", "mcpToolCall", selected);
    fixture[0].params.item.result.content[0].text = returned;
    fixture[1].params.item.text = reply;
    return taskEvidence(fixture, "t", "r", selected).ok;
  };
  const three = "package.json README.md pnpm-lock.yaml";
  const five = three + " packages docs";
  assert.equal(check(three, three), false);
  assert.equal(check(five, three), false);
  assert.equal(check(five, five), true);
});

test("MCP verification requires final turn success and completed evidence from the same turn", () => {
  assert.equal(taskEvidence(notes(), "t", "r", task).ok, true);
  assert.equal(taskEvidence(notes("completed", "dynamicToolCall"), "t", "r", task).ok, true);
  assert.equal(taskEvidence(notes("failed"), "t", "r", task).ok, false);
  assert.equal(taskEvidence(notes().slice(0, 2), "t", "r", task).ok, false);
  const startedOnly = notes();
  startedOnly[0].method = "item/started";
  assert.equal(taskEvidence(startedOnly, "t", "r", task).ok, false);
  const stale = notes();
  stale[0].params.turnId = "older";
  assert.equal(taskEvidence(stale, "t", "r", task).ok, false);
  const commentary = notes();
  commentary[1].params.item.phase = "commentary";
  assert.equal(taskEvidence(commentary, "t", "r", task).ok, false);
  commentary[1].params.item.phase = "final_answer";
  assert.equal(taskEvidence(commentary, "t", "r", task).ok, true);
  commentary[1].params.item.phase = "future_unknown_phase";
  assert.equal(taskEvidence(commentary, "t", "r", task).ok, false);
  commentary[1].params.item.phase = null;
  assert.equal(taskEvidence(commentary, "t", "r", task).ok, true);
});

test("all four tasks require task-relevant native or dynamic tool results", () => {
  for (const selected of MCP_TASKS) {
    for (const type of ["mcpToolCall", "dynamicToolCall"]) {
      const valid = notes("completed", type, selected);
      assert.equal(taskEvidence(valid, "t", "r", selected).ok, true, selected.key + " " + type);
      const item = valid[0].params.item;
      if (type === "mcpToolCall") item.result.content = [{ type: "text", text: "Request received. No usable result was returned." }];
      else item.contentItems = [{ type: "inputText", text: "Request received. No usable result was returned." }];
      const result = taskEvidence(valid, "t", "r", selected);
      assert.equal(result.toolResult, false);
      assert.equal(result.ok, false, "final reply alone must not prove " + selected.key);
    }
  }
});

test("empty, media-only and explicitly failed results never become successful evidence", () => {
  const good = { type: "text", text: fixtureResults[task.key] };
  const invalidNative = [
    { content: [] },
    { content: [{ type: "text", text: " \n " }] },
    { content: [{ type: "image", data: "Zml4dHVyZQ==", mimeType: "image/png" }] },
    { content: [good], isError: true },
    { content: [{ ...good, isError: true }] },
    { content: [good], error: { code: 429, message: "rate limited" } },
    { content: [good], structuredContent: { success: false, data: JSON.parse(fixtureResults[task.key]) } },
    { content: [good], structuredContent: { errors: ["denied"] } },
  ];
  for (const result of invalidNative) {
    const fixture = notes();
    fixture[0].params.item.result = result;
    assert.equal(taskEvidence(fixture, "t", "r", task).ok, false, JSON.stringify(result));
  }
  for (const text of ["", "(empty response)", JSON.stringify({ isError: true, data: JSON.parse(fixtureResults[task.key]) }),
    JSON.stringify({ status: "error", data: JSON.parse(fixtureResults[task.key]) }),
    JSON.stringify({ code: 429, message: "rate limited", data: JSON.parse(fixtureResults[task.key]) }),
    JSON.stringify({ statusCode: "403", message: "forbidden", data: JSON.parse(fixtureResults[task.key]) }),
    JSON.stringify({ error: { message: "denied" }, data: JSON.parse(fixtureResults[task.key]) }),
    '```json\n' + JSON.stringify({ ok: false, data: JSON.parse(fixtureResults[task.key]) }) + '\n```']) {
    const fixture = notes("completed", "dynamicToolCall");
    fixture[0].params.item.contentItems = [{ type: "inputText", text }];
    assert.equal(taskEvidence(fixture, "t", "r", task).ok, false, text);
  }
});

test("search accepts real structuredContent or Markdown results, not echoed arguments or invented titles", () => {
  const structured = notes();
  structured[0].params.item.result = { content: [], structuredContent: JSON.parse(fixtureResults[task.key]) };
  assert.equal(taskEvidence(structured, "t", "r", task).ok, true);
  const markdown = notes("completed", "dynamicToolCall");
  markdown[0].params.item.contentItems[0].text = searchResults.map(result => `- [${result.title}](${result.link})`).join("\n");
  assert.equal(taskEvidence(markdown, "t", "r", task).ok, true);
  for (const text of [JSON.stringify({ query: "OpenAI", results: [] }),
    JSON.stringify({ arguments: { title: "OpenAI developer documentation", url: "https://platform.openai.com/docs" }, results: [] })]) {
    const fixture = notes();
    fixture[0].params.item.result.content[0].text = text;
    assert.equal(taskEvidence(fixture, "t", "r", task).toolResult, false);
  }
  structured[1].params.item.text = "OpenAI: no usable search results returned.";
  assert.equal(taskEvidence(structured, "t", "r", task).content, false);
});

test("fixed-fixture checks need actual page content, repository paths and image attributes", () => {
  for (const [key, text] of [["web-reader", "Example Domain"], ["zread", "package.json"], ["zai-vision", "玫瑰"]]) {
    const selected = MCP_TASKS.find(item => item.key === key);
    const fixture = notes("completed", "mcpToolCall", selected);
    fixture[0].params.item.result.content[0].text = text;
    assert.equal(taskEvidence(fixture, "t", "r", selected).toolResult, false);
  }
  const selected = MCP_TASKS.find(item => item.key === "zai-vision");
  const fixture = notes("completed", "mcpToolCall", selected);
  fixture[1].params.item.text = "A yellow rose on a black background.";
  assert.equal(taskEvidence(fixture, "t", "r", selected).content, false, "reply colors must have evidence in the result");
});

function encodeResult(value, stringLayers = 1) {
  let encoded = JSON.stringify(value);
  for (let i = 0; i < stringLayers; i++) encoded = JSON.stringify(encoded);
  return encoded;
}

function encodedEvidence(text, type = "mcpToolCall", selected = task) {
  const fixture = notes("completed", type, selected);
  if (type === "mcpToolCall") fixture[0].params.item.result.content[0].text = text;
  else fixture[0].params.item.contentItems[0].text = text;
  return taskEvidence(fixture, "t", "r", selected);
}

test("single and multiple JSON-string wrappers decode real search arrays on native and dynamic transports", () => {
  const results = searchResults.map(result => ({ ...result, refer: "fixture-reference" }));
  for (const type of ["mcpToolCall", "dynamicToolCall"]) {
    for (const layers of [1, 2, 4]) {
      const evidence = encodedEvidence(encodeResult(results, layers), type);
      assert.equal(evidence.toolResult, true, `${type}, wrappers=${layers}`);
      assert.equal(evidence.content, true);
      assert.equal(evidence.ok, true);
    }
  }
});

test("valid quoted prose is processed as text after JSON-string decoding", () => {
  const selected = MCP_TASKS.find(value => value.key === "web-reader");
  for (const layers of [0, 2]) {
    assert.equal(encodedEvidence(encodeResult(fixtureResults[selected.key], layers), "mcpToolCall", selected).ok, true);
  }
  assert.equal(encodedEvidence(encodeResult("Error: Example Domain documentation examples", 2), "mcpToolCall", selected).ok, false);
});

test("JSON-string wrapping cannot hide error envelopes, HTTP errors, echoed queries or empty results", () => {
  const data = JSON.parse(fixtureResults[task.key]);
  for (const value of [
    { isError: true, data }, { code: 403, data }, { statusCode: "403", data },
    { query: "OpenAI", results: [] }, { arguments: data, results: [] }, [], "", "(empty response)",
  ]) {
    for (const type of ["mcpToolCall", "dynamicToolCall"]) {
      for (const layers of [1, 3]) {
        const evidence = encodedEvidence(encodeResult(value, layers), type);
        assert.equal(evidence.toolResult, false);
        assert.equal(evidence.ok, false);
      }
    }
  }
});

test("malformed JSON is not repaired and nested decoding retains depth, node and cumulative text limits", () => {
  const record = { title: "OpenAI developer documentation", link: "https://platform.openai.com/docs", content: "OpenAI API guides" };
  const malformed = encodeResult([record], 2).slice(0, -1);
  assert.equal(encodedEvidence(malformed).ok, false);
  assert.equal(encodedEvidence(`[${JSON.stringify(record)},]`).ok, false);
  let nested = record;
  for (let depth = 0; depth < 30; depth++) nested = [nested];
  assert.equal(encodedEvidence(encodeResult(nested, 1)).ok, false, "JSON-string decoding must not reset the nesting budget");
  assert.equal(encodedEvidence(encodeResult([...Array(10020).fill(0), record], 1)).ok, false, "decoding must not reset the visited-node budget");
  assert.equal(encodedEvidence(encodeResult({ data: record, padding: "x".repeat(800000) }, 2)).ok, false, "each decoded text layer counts toward the shared text budget");
});

test("the paid gate rejects before constructing a connection", async () => {
  const previous = process.env.HARNESS_ALLOW_PAID_TESTS;
  delete process.env.HARNESS_ALLOW_PAID_TESTS;
  try {
    let constructed = false;
    await assert.rejects(runMcpVerification([], { createClient: () => { constructed = true; } }), /HARNESS_ALLOW_PAID_TESTS/);
    assert.equal(constructed, false);
  } finally {
    if (previous === undefined) delete process.env.HARNESS_ALLOW_PAID_TESTS;
    else process.env.HARNESS_ALLOW_PAID_TESTS = previous;
  }
});

test("unknown or blank task filters reject before constructing a connection", async () => {
  const previous = process.env.HARNESS_ALLOW_PAID_TESTS;
  process.env.HARNESS_ALLOW_PAID_TESTS = "1";
  try {
    for (const keyword of ["", " ", "unknown-tool"]) {
      let constructed = false;
      await assert.rejects(runMcpVerification(["never", keyword], { createClient: () => { constructed = true; } }), /Unknown MCP task/);
      assert.equal(constructed, false);
    }
  } finally {
    if (previous === undefined) delete process.env.HARNESS_ALLOW_PAID_TESTS;
    else process.env.HARNESS_ALLOW_PAID_TESTS = previous;
  }
});

test("a failed model turn, empty tool result or failed cleanup cannot print PASS and created threads are removed", async () => {
  const previous = process.env.HARNESS_ALLOW_PAID_TESTS;
  process.env.HARNESS_ALLOW_PAID_TESTS = "1";
  try {
    for (const failure of ["turn", "result", "cleanup"]) {
      const calls = [], output = [];
      const client = {
        notes: [], closed: false, ws: { readyState: 1 },
        async rpc(method) {
          calls.push(method);
          if (method === "thread/start") return { thread: { id: "t" } };
          if (method === "turn/start") {
            const received = notes(failure === "turn" ? "failed" : "completed");
            if (failure === "result") received[0].params.item.result.content = [];
            this.notes.push(...received);
            return { turn: { id: "r" } };
          }
          if (method === "thread/delete" && failure === "cleanup") throw new Error("cleanup rejected");
          return {};
        },
        async waitFor(predicate) { const note = this.notes.find(predicate); if (!note) throw new Error("timed out"); return note; },
        close() { this.closed = true; },
      };
      const result = await runMcpVerification(["never", "web-search-prime"], { createClient: () => client, env: {}, log: text => output.push(text), error: text => output.push(text) });
      assert.equal(result, false);
      assert.ok(calls.includes("thread/delete"));
      assert.equal(output.some(text => text.startsWith("PASS ") || text === "MCP-TOOLS-PASS"), false);
      assert.equal(client.closed, true);
    }
  } finally {
    if (previous === undefined) delete process.env.HARNESS_ALLOW_PAID_TESTS;
    else process.env.HARNESS_ALLOW_PAID_TESTS = previous;
  }
});

test("all four prompts explicitly constrain a single named call, no retries, commands or delegation", () => {
  for (const selected of MCP_TASKS) {
    assert.match(selected.prompt, /一次/);
    assert.match(selected.prompt, /不得重试/);
    assert.match(selected.prompt, /不得调用其它工具/);
    assert.match(selected.prompt, /运行任何命令/);
    assert.match(selected.prompt, /委派子代理/);
  }
});

test("tool counts deduplicate lifecycle events but count retries and unrelated commands separately", () => {
  for (const type of ["mcpToolCall", "dynamicToolCall"]) {
    const fixture = notes("completed", type);
    fixture.unshift({ ...fixture[0], method: "item/started" });
    fixture.push(fixture[1]);
    fixture.push({ ...fixture[1], params: { ...fixture[1].params, turnId: "old-turn" } });
    assert.deepEqual(taskToolCounts(fixture, "t", "r", task), { observed: 1, completed: 1, named: 1, other: 0 });
    fixture.push({ method: "item/started", params: { threadId: "t", turnId: "r", item: { ...fixture[1].params.item, id: "retry-two" } } });
    fixture.push({ method: "item/completed", params: { threadId: "t", turnId: "r", item: { type: "commandExecution", id: "command-three", status: "completed" } } });
    assert.deepEqual(taskToolCounts(fixture, "t", "r", task), { observed: 3, completed: 2, named: 2, other: 1 });
  }
});

function runnerFixture(failure = "none", env = {}) {
  const calls = [], output = [];
  let sequence = 0, currentThread, clock = 100;
  const client = {
    notes: [], closed: false, ws: { readyState: 1 },
    async rpc(method, params) {
      calls.push({ method, params });
      if (method === "app/status") return { codexState: "ready", providerMode: failure === "mode" ? "custom" : "zhipu" };
      if (method === "thread/start") {
        currentThread = `thread-${++sequence}`;
        return { thread: { id: currentThread, modelProvider: "ZAI", cwd: env.HARNESS_VERIFY_CWD },
          modelProvider: "ZAI", model: failure === "model" ? "wrong-model" : "glm-5.3", cwd: env.HARNESS_VERIFY_CWD };
      }
      if (method === "thread/delete" && failure === "cleanup") throw new Error("PRIVATE_RAW_CLEANUP_ERROR");
      if (method !== "turn/start") return {};
      const selected = MCP_TASKS.find(value => value.prompt === params.text);
      assert.ok(selected, "runner must use the strengthened original task prompt");
      const received = notes(failure === "turn" ? "failed" : "completed", sequence % 2 ? "mcpToolCall" : "dynamicToolCall", selected);
      for (const note of received) {
        note.params.threadId = currentThread;
        if (note.params.turnId) note.params.turnId = `turn-${sequence}`;
        if (note.params.turn) note.params.turn.id = `turn-${sequence}`;
      }
      if (failure === "empty-result") {
        const item = received[0].params.item;
        if (item.type === "mcpToolCall") item.result.content = [];
        else item.contentItems = [];
      }
      if (failure === "reply") received[1].params.item.text = "No grounded response is available.";
      if (failure === "unknown-phase") received[1].params.item.phase = "future_unknown_phase";
      received.unshift({ ...received[0], method: "item/started" });
      if (failure === "retry") received.push({ method: "item/completed", params: { threadId: currentThread, turnId: `turn-${sequence}`,
        item: { ...received[1].params.item, id: "another-tool-call" } } });
      if (failure === "command" || failure === "delegate") received.push({ method: "item/completed", params: { threadId: currentThread, turnId: `turn-${sequence}`,
        item: { type: failure === "command" ? "commandExecution" : "collabAgentToolCall", id: "unrequested-call", status: "completed", raw: "PRIVATE_TOOL_DETAILS" } } });
      if (["imageView", "collabToolCall", "subAgentActivity", "sleep"].includes(failure)) received.push({ method: "item/started", params: {
        threadId: currentThread, turnId: `turn-${sequence}`, item: { type: failure, id: "unexpected-activity" },
      } });
      if (failure.startsWith("reroute")) received.push({ method: "model/rerouted", params: {
        threadId: failure === "reroute-other-thread" ? "other-thread" : currentThread,
        turnId: failure === "reroute-other-turn" ? "other-turn" : `turn-${sequence}`,
        fromModel: "PRIVATE_REROUTE_FROM", toModel: "PRIVATE_REROUTE_TO", reason: "PRIVATE_REROUTE_REASON",
      } });
      if (failure === "duplicate") received.push(received[1]);
      if (failure !== "no-usage") received.push({ method: "thread/tokenUsage/updated", params: { threadId: currentThread, turnId: failure === "stale-usage" ? "old-turn" : `turn-${sequence}`,
        tokenUsage: { last: { totalTokens: 12, inputTokens: 8, outputTokens: 4, private: "PRIVATE_USAGE_DETAILS" }, total: { totalTokens: 12 }, modelContextWindow: 1000 } } });
      this.notes.push(...received);
      return { turn: { id: `turn-${sequence}` } };
    },
    async waitFor(predicate) { const match = this.notes.find(predicate); if (!match) throw new Error("PRIVATE_TRANSPORT_ERROR"); return match; },
    close() { this.closed = true; },
  };
  return { calls, output, client, records: () => output.filter(line => line.startsWith("{")).map(line => JSON.parse(line)),
    run: () => runMcpVerification([], { env, createClient: () => client, now: () => ++clock, log: line => output.push(line), error: line => output.push(line) }) };
}

async function paid(operation) {
  const prior = process.env.HARNESS_ALLOW_PAID_TESTS;
  process.env.HARNESS_ALLOW_PAID_TESTS = "1";
  try { return await operation(); }
  finally { if (prior === undefined) delete process.env.HARNESS_ALLOW_PAID_TESTS; else process.env.HARNESS_ALLOW_PAID_TESTS = prior; }
}

test("all four tasks emit final machine-readable evidence, bounded counts and cleanup without raw data", async () => paid(async () => {
  const env = { HARNESS_VERIFY_CWD: "/isolated/mcp-fixture", HARNESS_VERIFY_MODE: "zhipu", HARNESS_VERIFY_PROVIDER: "ZAI", HARNESS_VERIFY_MODEL: "glm-5.3" };
  const f = runnerFixture("none", env);
  assert.equal(await f.run(), true);
  const records = f.records();
  assert.equal(records.length, 4);
  assert.equal(f.calls.filter(call => call.method === "turn/start").length, 4);
  assert.equal(f.calls.filter(call => call.method === "thread/delete").length, 4);
  for (const call of f.calls.filter(call => call.method === "thread/start")) assert.deepEqual(call.params, { sandbox: "read-only", cwd: env.HARNESS_VERIFY_CWD });
  for (const [index, record] of records.entries()) {
    assert.equal(record.status, "completed"); assert.equal(record.turnStatus, "completed");
    assert.equal(record.rerouteCount, 0);
    assert.equal(record.threadId, `thread-${index + 1}`); assert.equal(record.turnId, `turn-${index + 1}`);
    assert.equal(record.completed && record.namedTool && record.toolResult && record.groundedReply, true);
    assert.deepEqual(record.tools, { observed: 1, completed: 1, named: 1, other: 0 });
    assert.equal(record.tokenUsage.last.totalTokens, 12); assert.equal(record.tokenUsage.last.cachedInputTokens, null);
    assert.equal(typeof record.durationMs, "number");
    assert.deepEqual(record.cleanup, { attempted: true, ok: true });
    assert.equal(record.failure, null);
  }
  assert.equal(f.client.closed, true);
  const printed = f.output.join("\n");
  for (const text of [...Object.values(fixtureResults), ...Object.values(fixtureReplies), ...MCP_TASKS.map(value => value.prompt), "PRIVATE_", env.HARNESS_VERIFY_CWD]) assert.ok(!printed.includes(text));
  assert.match(printed, /do not bound provider request counts or spending/);
}));

test("optional expectation mismatch stops all paid turns and still cleans any allocated thread", async () => paid(async () => {
  for (const failure of ["mode", "model"]) {
    const f = runnerFixture(failure, { HARNESS_VERIFY_MODE: "zhipu", HARNESS_VERIFY_PROVIDER: "ZAI", HARNESS_VERIFY_MODEL: "glm-5.3" });
    assert.equal(await f.run(), false);
    assert.equal(f.calls.filter(call => call.method === "turn/start").length, 0);
    assert.equal(f.calls.filter(call => call.method === "thread/start").length, failure === "mode" ? 0 : 1);
    assert.equal(f.calls.filter(call => call.method === "thread/delete").length, failure === "mode" ? 0 : 1);
    assert.equal(f.records().length, 4);
    assert.ok(f.records().every(record => record.status === "failed"));
  }
}));

test("observed retries, other tools, weak evidence and cleanup failures cannot pass or trigger a rerun", async () => paid(async () => {
  for (const [failure, expectedCode] of [["retry", "tool_call_limit_exceeded"], ["command", "unexpected_tool_call"], ["delegate", "unexpected_tool_call"],
    ["empty-result", null], ["reply", "ungrounded_reply"], ["turn", "model_turn_failed"], ["cleanup", "thread_cleanup_failed"]]) {
    const f = runnerFixture(failure);
    assert.equal(await f.run(), false, failure);
    assert.equal(f.calls.filter(call => call.method === "turn/start").length, 4, failure);
    assert.equal(f.calls.filter(call => call.method === "thread/delete").length, 4, failure);
    assert.ok(f.records().every(record => record.status === "failed"));
    if (expectedCode) assert.ok(f.records().every(record => record.failure.code === expectedCode), failure);
    assert.ok(!f.output.some(line => line.startsWith("PASS ") || line === "MCP-TOOLS-PASS"), failure);
    assert.ok(!f.output.join("\n").includes("PRIVATE_"), failure);
  }
}));

test("legacy invocation needs no new metadata; duplicate events do not inflate counts and missing usage stays null", async () => paid(async () => {
  for (const failure of ["none", "duplicate", "no-usage", "stale-usage"]) {
    const f = runnerFixture(failure);
    assert.equal(await f.run(), true, failure);
    assert.ok(f.calls.filter(call => call.method === "thread/start").every(call => !Object.hasOwn(call.params, "cwd")));
    assert.equal(f.calls.some(call => call.method === "app/status"), false);
    assert.ok(f.records().every(record => record.tools.observed === 1));
    if (["no-usage", "stale-usage"].includes(failure)) assert.ok(f.records().every(record => record.tokenUsage === null));
  }
}));

test("unknown answer phases and extra image, collaboration, subagent or sleep activities fail closed", async () => paid(async () => {
  for (const failure of ["unknown-phase", "imageView", "collabToolCall", "subAgentActivity", "sleep"]) {
    const f = runnerFixture(failure);
    assert.equal(await f.run(), false, failure);
    for (const record of f.records()) {
      assert.equal(record.status, "failed");
      assert.equal(record.failure.code, failure === "unknown-phase" ? "ungrounded_reply" : "unexpected_tool_call");
      if (failure !== "unknown-phase") assert.deepEqual(record.tools, { observed: 2, completed: 1, named: 1, other: 1 });
      assert.equal(record.cleanup.ok, true);
    }
  }
}));

test("only a same-thread same-turn reroute fails acceptance and its raw fields never enter summaries", async () => paid(async () => {
  for (const failure of ["reroute", "reroute-other-thread", "reroute-other-turn"]) {
    const f = runnerFixture(failure);
    assert.equal(await f.run(), failure !== "reroute");
    for (const record of f.records()) {
      assert.equal(record.rerouteCount, failure === "reroute" ? 1 : 0);
      if (failure === "reroute") {
        assert.equal(record.status, "failed");
        assert.equal(record.failure.code, "model_rerouted");
        assert.equal(record.completed && record.namedTool && record.toolResult && record.groundedReply, true);
      }
      assert.equal(record.cleanup.ok, true);
    }
    assert.equal(f.calls.filter(call => call.method === "turn/start").length, 4);
    assert.ok(!f.output.join("\n").includes("PRIVATE_REROUTE"));
  }
}));
