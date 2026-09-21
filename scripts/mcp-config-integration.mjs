// Pinned CLI configuration/loaded-MCP identity regression. Only disposable
// local stdio fixtures and a canned loopback response; no provider credentials.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { spawnOfflineChild, stopOfflineChild } from "./offline-process.mjs";
import { handleDynamicToolCall } from "../apps/gateway/dist/mcp-proxy.js";

const root = fileURLToPath(new URL("../", import.meta.url));
assert.ok(process.env.CODEX_BIN && path.isAbsolute(process.env.CODEX_BIN), "CODEX_BIN must be an absolute pinned path");
const version = spawnSync(process.env.CODEX_BIN, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
assert.equal(version.status, 0); assert.match(version.stdout, /\b0\.149\.0\b/);
const scratch = mkdtempSync(path.join(tmpdir(), "mcp-context-regression-"));
const home = path.join(scratch, "home"), cwd = path.join(scratch, "workspace");
mkdirSync(home); mkdirSync(cwd); mkdirSync(path.join(cwd, ".git")); mkdirSync(path.join(cwd, ".codex"));
const pending = new Map(), notes = []; let sequence = 0, child, transportError;
let servedResponses = 0, adapterCalls = 0, approvals = 0, fixtureThreadId;
const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || !req.url.endsWith("/responses")) { res.writeHead(404); res.end(); return; }
  let raw = ""; for await (const part of req) raw += part;
  const request = JSON.parse(raw); servedResponses++;
  const callTool = servedResponses === 1;
  const message = callTool
    ? { id: "fc-fixture", type: "function_call", status: "completed", call_id: "call-fixture", name: "fixture_marker", namespace: "mcp__web_reader", arguments: "{}" }
    : { id: "msg-fixture", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "OK", annotations: [] }] };
  const response = { id: "resp-fixture", object: "response", created_at: 1, status: "completed", model: request.model, output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const event of [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
    ...(callTool ? [] : [{ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: message.id, delta: "OK" }]),
    { type: "response.output_item.done", output_index: 0, item: message }, { type: "response.completed", response }]) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
});
const fail = error => { transportError = error; for (const slot of pending.values()) { clearTimeout(slot.timer); slot.reject(error); } pending.clear(); };
const rpc = (method, params) => new Promise((resolve, reject) => {
  if (transportError) { reject(transportError); return; }
  const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 15000);
  pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
});
const until = async (check, label) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await check()) return; if (transportError) throw transportError; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error(`missing ${label}`);
};
const stub = `const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const r=JSON.parse(line);if(r.id==null)return;let result;
if(r.method==='initialize')result={protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:process.argv[1]+':'+(process.env.AUDIT_OLD_MARKER||'none'),version:'1'}};
else if(r.method==='tools/list')result={tools:[{name:'fixture_marker',description:'Offline marker only',inputSchema:{type:'object',properties:{}}}]};
else if(r.method==='tools/call')result={content:[{type:'text',text:'native-marker:'+process.argv[1]}],isError:false};
else if(r.method==='ping')result={};
else{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{code:-32601,message:'No execution in fixture'}})+'\\n');return;}
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});`;
async function startApp() {
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CODEX_HOME: home, NO_PROXY: "*", no_proxy: "*" };
  child = spawnOfflineChild(process.env.CODEX_BIN, ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume(); child.on("error", fail); child.on("exit", () => fail(new Error("fixture exited")));
  child.stdin.on("error", fail); child.stdout.on("error", fail);
  createInterface({ input: child.stdout }).on("line", line => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    const slot = !msg.method && pending.get(msg.id);
    if (slot) { pending.delete(msg.id); clearTimeout(slot.timer); msg.error ? slot.reject(new Error(JSON.stringify(msg.error))) : slot.resolve(msg.result); }
    else if (msg.method) {
      notes.push(msg);
      if (msg.id != null) {
        const answer = async () => {
          assert.equal(msg.params?.threadId, fixtureThreadId);
          if (msg.method === "mcpServer/elicitation/request") {
            assert.equal(msg.params.serverName, "web-reader");
            assert.equal(msg.params.mode, "form");
            assert.equal(++approvals, 1);
            // Exercise the production adapter while this same thread is
            // waiting on a client response. Native dispatch must not deadlock
            // or recursively emit another approval/dynamic-tool request.
            const result = await handleDynamicToolCall({ threadId: fixtureThreadId, namespace: "web-reader", tool: "fixture_marker", arguments: {} }, { request: rpc });
            adapterCalls++;
            assert.deepEqual(result, { success: true, contentItems: [{ type: "inputText", text: "native-marker:pinned" }] });
            return { action: "accept", content: null, _meta: null };
          }
          throw new Error(`unexpected or recursive server request: ${msg.method}`);
        };
        answer().then(result => child.stdin.write(JSON.stringify({ id: msg.id, result }) + "\n"), error => {
          child.stdin.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: error.message } }) + "\n");
          fail(error);
        });
      }
    }
  });
  await rpc("initialize", { clientInfo: { name: "mcp-context-regression", version: "1" } });
  child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
}
let report;
try {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const bridge = path.join(root, "deploy/providers/zhipu-coding-plan/mcp-http-bridge.mjs");
  const managed = `model_provider="ZAI"\nmodel="glm-5.3"\n[model_providers.ZAI]\nname="Zhipu Coding Plan"\nbase_url="https://open.bigmodel.cn/api/v1"\nenv_key="Z_AI_API_KEY"\nwire_api="responses"\n[features]\nmcp_2026_07_28=true\n[mcp_servers.web-reader]\ntype="local"\nstartup_timeout_sec=120\ndefault_tools_approval_mode="approve"\ncommand="node"\nenv_vars=["Z_AI_API_KEY"]\nargs=[${JSON.stringify(bridge)},"https://open.bigmodel.cn/api/mcp/web_reader/mcp"]\n[projects.${JSON.stringify(cwd)}]\ntrust_level="trusted"\n`;
  writeFileSync(path.join(home, "config.toml"), managed);
  await startApp();
  const initial = await rpc("config/read", { cwd, includeLayers: false });
  assert.equal(initial.config.mcp_servers["web-reader"].command, "node");
  writeFileSync(path.join(cwd, ".codex/config.toml"), '[mcp_servers.web-reader]\ncommand="audit-placeholder-never-started"\ndefault_tools_approval_mode="prompt"\n');
  const overridden = await rpc("config/read", { cwd, includeLayers: false });
  assert.equal(overridden.config.mcp_servers["web-reader"].command, "audit-placeholder-never-started");
  assert.equal(overridden.config.mcp_servers["web-reader"].default_tools_approval_mode, "prompt");
  writeFileSync(path.join(cwd, ".codex/config.toml"), "");
  const sample = JSON.parse(readFileSync(path.join(root, "deploy/providers/zhipu-coding-plan/models.json"), "utf8")).models[0];
  writeFileSync(path.join(home, "models.json"), JSON.stringify({ models: [{ ...sample, slug: "fixture", display_name: "fixture", base_instructions: "Use only the offline marker fixture when asked." }] }));
  writeFileSync(path.join(home, "config.toml"), `model_provider="fixture"\nmodel="fixture"\nmodel_catalog_json=${JSON.stringify(path.join(home,"models.json"))}\napproval_policy="on-request"\nsandbox_mode="read-only"\n[model_providers.fixture]\nname="Offline fixture"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\nwire_api="responses"\n[features]\nmcp_2026_07_28=true\n[mcp_servers.web-reader]\ncommand=${JSON.stringify(process.execPath)}\nargs=${JSON.stringify(["-e",stub,"global"])}\nenabled=false\nenv={AUDIT_OLD_MARKER="old"}\n`);
  const pinned = { command: process.execPath, args: ["-e", stub, "pinned"], enabled: true, startup_timeout_sec: 5 };
  const started = await rpc("thread/start", { cwd, config: { "mcp_servers.web-reader": pinned } });
  const id = started.thread.id; fixtureThreadId = id;
  let marker;
  const markerFor = async () => (await rpc("mcpServerStatus/list", { threadId: id })).data.find(item => item.name === "web-reader")?.serverInfo?.name;
  await until(async () => { marker = await markerFor(); return marker != null; }, "pinned local MCP initialization");
  assert.equal(marker, "pinned:old", "pinned CLI recursively merges tables; do not treat override as an identity proof");
  const native = await rpc("mcpServer/tool/call", { threadId: id, server: "web-reader", tool: "fixture_marker", arguments: {} });
  assert.deepEqual(native.content, [{ type: "text", text: "native-marker:pinned" }]);
  assert.equal(notes.filter(note => note.id != null).length, 0, "native tool dispatch must not recurse into client tool requests");
  const turn = await rpc("turn/start", { threadId: id, input: [{ type: "text", text: "Call fixture_marker once, then reply OK.", text_elements: [] }] });
  await until(() => notes.some(note => note.method === "turn/completed" && note.params?.turn?.id === turn.turn.id && note.params.turn.status === "completed"), "canned turn completion");
  assert.equal(adapterCalls, 1, "active model turn must exercise the gateway native adapter");
  assert.equal(approvals, 1);
  assert.equal(servedResponses, 2);
  assert.ok(notes.some(note => note.method === "item/completed" && note.params?.item?.type === "mcpToolCall"
    && note.params.item.result?.content?.[0]?.text === "native-marker:pinned"), "approved model tool must execute on the loaded connection");
  await rpc("thread/resume", { threadId: id, config: { "mcp_servers.web-reader": { ...pinned, args: ["-e", stub, "warm-override"] } } });
  const warmMarker = await markerFor();
  // Unsubscribe is not an unload in the pinned server. A real isolated child
  // restart proves that historical threads can recover native MCP routing.
  await stopOfflineChild(child);
  transportError = undefined;
  await startApp();
  assert.equal((await rpc("thread/loaded/list", {})).data.includes(id), false);
  await rpc("thread/resume", { threadId: id, config: { "mcp_servers.web-reader": { ...pinned, args: ["-e", stub, "cold-override"] } } });
  let coldMarker;
  await until(async () => { coldMarker = await markerFor(); return coldMarker != null; }, "cold resume local MCP initialization");
  assert.equal(coldMarker, "cold-override:old");
  const cold = await rpc("mcpServer/tool/call", { threadId: id, server: "web-reader", tool: "fixture_marker", arguments: {} });
  assert.deepEqual(cold.content, [{ type: "text", text: "native-marker:cold-override" }]);
  assert.equal(notes.filter(note => note.id != null).length, approvals);
  report = { passed: true, projectOverrideObserved: true, nativeRpcCalls: 3, modelToolCalls: 1, adapterCallsDuringApproval: adapterCalls, approvals, recursiveRequests: 0, initialMarker: marker, warmMarker, coldMarker, servedResponses, externalRequests: 0 };
} finally {
  for (const slot of pending.values()) clearTimeout(slot.timer);
  if (child) await stopOfflineChild(child);
  await new Promise(resolve => server.close(resolve));
  rmSync(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify(report));
