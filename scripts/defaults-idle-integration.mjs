// No-turn native lifecycle regression: isolated CLI home, no credentials,
// inference, MCP startup, provider server, or writes to existing user settings.
// Build gateway first, then set CODEX_BIN to the pinned CLI executable.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnOfflineChild, stopOfflineChild } from "./offline-process.mjs";
import { assertCodexVersion, expectedCodexVersion } from "./codex-version.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const { TurnDefaults } = await import(pathToFileURL(process.argv[2] ?? path.join(root, "apps/gateway/dist/turn-defaults.js")).href);
const bin = process.env.CODEX_BIN;
assert.ok(bin && path.isAbsolute(bin), "CODEX_BIN must be an absolute pinned binary path");
const version = spawnSync(bin, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
assert.equal(version.status, 0);
const expectedVersion = expectedCodexVersion();
assertCodexVersion(version.stdout, expectedVersion);
const scratch = mkdtempSync(path.join(tmpdir(), "harness-default-idle-"));
const home = path.join(scratch, "home"), cwd = path.join(scratch, "workspace");
mkdirSync(home, { mode: 0o700 }); mkdirSync(cwd, { mode: 0o700 });
const sample = JSON.parse(readFileSync(path.join(root, "deploy/providers/zhipu-coding-plan/models.json"), "utf8")).models[0];
const models = Array.from({ length: 66 }, (_, index) => `fixture-${index}`);
writeFileSync(path.join(home, "models.json"), JSON.stringify({ models: models.map(slug => ({
  ...sample, slug, display_name: slug, default_reasoning_level: "low",
})) }), { mode: 0o600 });
const configPath = path.join(home, "config.toml");
const configText = `model_provider = "fixture"\nmodel = "fixture-0"\nmodel_reasoning_effort = "low"\napproval_policy = "on-request"\nsandbox_mode = "read-only"\nthread_unload_delay_secs = 1800\nmodel_catalog_json = ${JSON.stringify(path.join(home, "models.json"))}\n[model_providers.fixture]\nname = "Offline fixture"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\n`;
writeFileSync(configPath, configText, { mode: 0o600 });
const child = spawnOfflineChild(bin, ["app-server"], { cwd, stdio: ["pipe", "pipe", "pipe"],
  env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
    CODEX_HOME: home, NO_PROXY: "*", no_proxy: "*" } });
child.stderr.resume();
const pending = new Map(), probes = new Set(), closed = new Set();
let seq = 0, transportError, callbacks = 0, startCalls = 0, unsubscribeCalls = 0;
const failTransport = () => {
  transportError ??= new Error("offline app-server transport closed or failed");
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(transportError); }
  pending.clear();
};
child.on("error", failTransport); child.on("exit", failTransport);
child.stdin.on("error", failTransport); child.stdout.on("error", failTransport); child.stderr.on("error", failTransport);
const lines = createInterface({ input: child.stdout });
lines.on("error", failTransport).on("line", line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
  if (msg.method) {
    if (msg.id != null) {
      callbacks++;
      child.stdin.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "No tools in offline regression" } }) + "\n");
    }
    if (msg.method === "thread/closed") closed.add(msg.params?.threadId);
    return;
  }
  const item = pending.get(msg.id);
  if (item) {
    pending.delete(msg.id); clearTimeout(item.timer);
    msg.error ? item.reject(new Error(JSON.stringify(msg.error))) : item.resolve(msg.result);
  }
});
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  assert.notEqual(method, "turn/start", "idle regression must never start a turn");
  if (transportError) { reject(transportError); return; }
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 15_000);
  pending.set(id, { resolve, reject, timer });
  try { child.stdin.write(JSON.stringify({ id, method, params }) + "\n", error => { if (error) failTransport(); }); }
  catch { failTransport(); }
});
const configReads = [];
const resolver = new TurnDefaults({ request: async (method, params) => {
  if (method === "config/read") {
    const result = await rpc(method, params);
    configReads.push(result.config);
    return result;
  }
  if (method === "thread/start") {
    startCalls++;
    assert.equal(params.ephemeral, true);
    assert.equal(params.config.thread_unload_delay_secs, 0);
    const result = await rpc(method, params);
    probes.add(result.thread.id);
    return result;
  }
  if (method === "thread/unsubscribe") unsubscribeCalls++;
  return rpc(method, params);
} });
async function loadedThreads() {
  const ids = [], cursors = new Set();
  let cursor;
  do {
    const page = await rpc("thread/loaded/list", { limit: 100, ...(cursor ? { cursor } : {}) });
    ids.push(...page.data);
    cursor = page.nextCursor;
    if (cursor) { assert.ok(!cursors.has(cursor), "loaded thread cursor cycle"); cursors.add(cursor); }
    assert.ok(cursors.size < 10, "loaded thread list exceeded regression budget");
  } while (cursor);
  return ids;
}
const pick = ({ model, approvalPolicy, sandbox, reasoningEffort }) => ({ model, approvalPolicy, sandbox, reasoningEffort });
let report;
try {
  await rpc("initialize", { clientInfo: { name: "harness-default-idle-regression", version: "1" } });
  child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  const initial = await rpc("thread/start", { cwd, ephemeral: true });
  const before = await loadedThreads();
  assert.deepEqual(before, [initial.thread.id]);
  for (const model of models) {
    assert.deepEqual(pick(await resolver.resolve(initial.thread.id, model)), { ...pick(initial), model });
  }
  await resolver.resolve(initial.thread.id, models.at(-1));
  assert.deepEqual(configReads.at(-2), configReads.at(-1), "unchanged native config must retain its meaning");
  assert.equal(startCalls, models.length, "cached lookup must not start another probe");
  await resolver.resolve(initial.thread.id, models[0]);
  assert.equal(startCalls, models.length + 1, "evicted cache key must resolve afresh");
  assert.equal(unsubscribeCalls, startCalls);
  const startedWaiting = Date.now(), deadline = startedWaiting + 10_000;
  let remaining;
  do {
    remaining = await loadedThreads();
    if (!remaining.some(id => probes.has(id)) && [...probes].every(id => closed.has(id))) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.deepEqual(remaining, before, "temporary probes must unload without evicting the user's loaded thread");
  assert.ok([...probes].every(id => closed.has(id)), "native close notifications must accompany probe reclamation");
  assert.equal((await rpc("config/read", { cwd, includeLayers: false })).config.thread_unload_delay_secs, 1800);
  assert.equal(readFileSync(configPath, "utf8"), configText, "probe override must not change persistent defaults");
  assert.equal(callbacks, 0);
  report = { binary: expectedVersion, turnsStarted: 0, toolCallbacks: callbacks, uniqueModels: models.length,
    probesStarted: startCalls, unsubscribed: unsubscribeCalls, loadedBefore: before.length, loadedAfter: remaining.length,
    probesClosed: closed.size, idleWaitMs: Date.now() - startedWaiting, configuredUnloadDelaySecs: 1800,
    nativeConfigKeyOrderChanged: configReads.some(config => JSON.stringify(config) !== JSON.stringify(configReads[0])),
    nativeConfigKeyOrderSamples: configReads.slice(-2).map(config => Object.keys(config)), passed: true };
} finally {
  for (const item of pending.values()) clearTimeout(item.timer);
  await stopOfflineChild(child);
  lines.close();
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(tmpdir()));
  assert.ok(path.basename(scratch).startsWith("harness-default-idle-"));
  rmSync(scratch, { recursive: true, force: true });
  if (report) console.log(JSON.stringify(report));
}
