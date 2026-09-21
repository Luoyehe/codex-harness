// Fixed app-server contract regression. Only loopback canned Responses, no
// credentials, inference, MCP servers, tool commands or existing CODEX_HOME.
// Build gateway first. CODEX_BIN must point to the supported 0.149.0 executable.
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnOfflineChild, stopOfflineChild } from "./offline-process.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const defaultsModule = pathToFileURL(process.argv[2] ?? path.join(root, "apps/gateway/dist/turn-defaults.js"));
const { TurnDefaults } = await import(defaultsModule.href);
const { makeDispatcher } = await import(new URL("./api.js", defaultsModule).href);
const bin = process.env.CODEX_BIN;
assert.ok(bin && path.isAbsolute(bin), "CODEX_BIN must be an absolute pinned binary path");
const version = spawnSync(bin, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
assert.equal(version.status, 0);
assert.match(version.stdout, /\b0\.149\.0\b/);
const scratch = mkdtempSync(path.join(tmpdir(), "harness-default-reset-"));
const home = path.join(scratch, "home"), cwd = path.join(scratch, "workspace");
mkdirSync(home, { mode: 0o700 }); mkdirSync(cwd, { mode: 0o700 });
const sample = JSON.parse(readFileSync(process.argv[3] ?? path.join(root, "deploy/providers/zhipu-coding-plan/models.json"), "utf8")).models[0];
writeFileSync(path.join(home, "models.json"), JSON.stringify({ models: ["fixture-a", "fixture-b", "fixture-unprobed", "fixture-no-summaries"].map(slug => ({
  ...sample, slug, display_name: slug, base_instructions: "Reply OK without tools.", default_reasoning_level: "low",
  supported_reasoning_levels: ["fixture-unprobed", "fixture-no-summaries"].includes(slug)
    ? [] : [{ effort: "low", description: "fixture" }, { effort: "high", description: "fixture" }],
  supports_reasoning_summaries: slug !== "fixture-no-summaries",
})) }), { mode: 0o600 });
const servedModels = [], servedRequests = [];
const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || !req.url.endsWith("/responses")) { res.writeHead(404); res.end(); return; }
  let raw = ""; for await (const chunk of req) raw += chunk;
  const request = JSON.parse(raw); servedModels.push(request.model); servedRequests.push(request);
  const message = { id: `msg-${servedModels.length}`, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "OK", annotations: [] }] };
  const response = { id: `resp-${servedModels.length}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model: request.model, output: [message],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: message.id, delta: "OK" },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response },
  ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
writeFileSync(path.join(home, "config.toml"), `model_provider = "fixture"\nmodel = "fixture-a"\napproval_policy = "on-request"\nsandbox_mode = "read-only"\nmodel_catalog_json = ${JSON.stringify(path.join(home, "models.json"))}\nmodel_reasoning_effort = "low"\n[model_providers.fixture]\nname = "Offline fixture"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\n`, { mode: 0o600 });
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CODEX_HOME: home, NO_PROXY: "*", no_proxy: "*" };
const child = spawnOfflineChild(bin, ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
child.stderr.resume();
const pending = new Map(), notes = [];
let seq = 0, resolver, transportError;
const failTransport = () => {
  transportError ??= new Error("offline app-server transport closed or failed");
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(transportError); }
  pending.clear();
};
child.on("error", failTransport); child.on("exit", failTransport);
child.stdin.on("error", failTransport); child.stdout.on("error", failTransport); child.stderr.on("error", failTransport);
createInterface({ input: child.stdout }).on("error", failTransport).on("line", line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
  if (msg.id != null && pending.has(msg.id)) {
    const item = pending.get(msg.id); pending.delete(msg.id); clearTimeout(item.timer);
    msg.error ? item.reject(new Error(JSON.stringify(msg.error))) : item.resolve(msg.result);
  } else if (msg.method) {
    if (msg.id != null) child.stdin.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "No tools in offline regression" } }) + "\n");
    if (!resolver?.hideNotification(msg.method, msg.params)) notes.push(msg);
  }
});
const rpc = (method, params) => new Promise((resolve, reject) => {
  if (transportError) { reject(transportError); return; }
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 15000);
  pending.set(id, { resolve, reject, timer });
  try { child.stdin.write(JSON.stringify({ id, method, params }) + "\n", error => { if (error) failTransport(); }); }
  catch { failTransport(); }
});
resolver = new TurnDefaults({ request: rpc });
const dispatch = makeDispatcher({ supervisor: { request: rpc }, turnDefaults: resolver, attachments: {} });
const waitForTurn = async (result) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (transportError) throw transportError;
    const end = notes.find(note => note.method === "turn/completed" && note.params?.turn?.id === result.turn.id);
    if (end) { assert.equal(end.params.turn.status, "completed"); return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("turn completion missing");
};
const turn = async (threadId, overrides) => waitForTurn(await rpc("turn/start", {
  threadId, input: [{ type: "text", text: "Reply OK without tools.", text_elements: [] }], ...overrides,
}));
const composerTurn = async (threadId, overrides = {}) => waitForTurn(await dispatch("turn/start", {
  threadId, text: "Reply OK without tools.", model: null, approvalPolicy: null, sandbox: null, effort: null, ...overrides,
}));
const pick = r => ({ model: r.model, approvalPolicy: r.approvalPolicy, sandbox: r.sandbox.type, reasoningEffort: r.reasoningEffort });
let report;
try {
  await rpc("initialize", { clientInfo: { name: "harness-default-reset-regression", version: "1" } });
  child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  const initial = await rpc("thread/start", { cwd });
  const threadId = initial.thread.id;
  // First send must also work before a new thread has materialized a rollout.
  const beforeFirstTurn = await resolver.resolve(threadId);
  assert.deepEqual(pick(beforeFirstTurn), pick(initial));
  await turn(threadId, { model: "fixture-b", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, effort: "high" });
  const overridden = await rpc("thread/resume", { threadId });
  const defaults = await resolver.resolve(threadId);
  await composerTurn(threadId);
  const afterReset = await rpc("thread/resume", { threadId });
  assert.deepEqual(pick(afterReset), pick(initial));
  assert.deepEqual(servedModels, ["fixture-b", "fixture-a"]);
  assert.equal(servedRequests[0].reasoning?.effort, "high");
  assert.equal(servedRequests[1].reasoning?.effort, defaults.reasoningEffort);

  const emptyCapabilityResults = [];
  for (const model of ["fixture-unprobed", "fixture-no-summaries"]) {
    const catalog = await rpc("model/list", { includeHidden: true });
    assert.deepEqual(catalog.data.find(entry => entry.model === model)?.supportedReasoningEfforts, []);
    const baseline = await rpc("thread/start", { cwd, model });
    const id = baseline.thread.id;
    // The ordinary first message must work when the catalog has no effort
    // overrides. Selecting a model retains its native configured default.
    await composerTurn(id, { model });
    assert.equal(servedModels.at(-1), model);
    const firstDefaultRequest = servedRequests.at(-1);
    // Establish a sticky native override without claiming it is advertised by
    // the gateway. The canned server executes no inference or tools.
    await turn(id, { effort: "high" });
    assert.equal((await rpc("thread/resume", { threadId: id })).reasoningEffort, "high");
    await composerTurn(id, { model });
    const restored = await rpc("thread/resume", { threadId: id });
    assert.equal(restored.reasoningEffort, baseline.reasoningEffort);
    const restoredRequest = servedRequests.at(-1);
    // In pinned 0.149.0, supports_reasoning_summaries:false does not suppress
    // a configured effort on the wire. Preserve that native default behavior;
    // neither this flag nor an empty override list means "omit reasoning".
    assert.equal(firstDefaultRequest.reasoning?.effort, baseline.reasoningEffort);
    assert.equal(restoredRequest.reasoning?.effort, baseline.reasoningEffort);
    const count = servedRequests.length;
    for (const effort of [baseline.reasoningEffort, "arbitrary-vendor-effort"]) {
      await assert.rejects(dispatch("turn/start", { threadId: id, text: "Must not dispatch.", model, effort }), /未声明支持/);
    }
    assert.equal(servedRequests.length, count);
    emptyCapabilityResults.push({ model, defaultEffort: baseline.reasoningEffort, restoredEffort: restored.reasoningEffort,
      reasoningOnWire: restoredRequest.reasoning ?? null, explicitOverridesRejected: true });
  }
  assert.equal(notes.filter(note => note.method === "thread/started" && note.params?.thread?.ephemeral).length, 0);
  report = { binary: "0.149.0", externalRequests: 0, fixtureResponses: servedModels.length,
    servedModels, initial: pick(initial), overridden: pick(overridden), afterReset: pick(afterReset), emptyCapabilityResults, passed: true };
} finally {
  for (const item of pending.values()) clearTimeout(item.timer);
  try { await stopOfflineChild(child); }
  finally { server.closeAllConnections(); server.close(); }
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(tmpdir()));
  assert.ok(path.basename(scratch).startsWith("harness-default-reset-"));
  rmSync(scratch, { recursive: true, force: true });
  if (report) console.log(JSON.stringify(report));
}
