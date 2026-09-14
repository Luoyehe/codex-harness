// Isolated, no-inference smoke test against the installed Codex app-server.
// Run after pnpm build. Never reads the user's existing Codex home or starts a turn.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = fileURLToPath(new URL("../", import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), "codex-harness-smoke-"));
const codexHome = path.join(scratch, "codex-home");
const workspace = path.join(scratch, "workspace");
mkdirSync(codexHome);
mkdirSync(workspace);
const token = randomBytes(32).toString("hex");
const reserve = createServer();
await new Promise((resolve, reject) => {
  reserve.once("error", reject);
  reserve.listen(0, "127.0.0.1", resolve);
});
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const base = `http://127.0.0.1:${port}`;
const wsBase = `ws://127.0.0.1:${port}/ws`;
const env = { ...process.env, CODEX_HOME: codexHome, CODEX_WORKSPACE: workspace,
  GATEWAY_TOKEN: token, GATEWAY_CONTROL_HOME: path.join(scratch, "control"), GATEWAY_UNSAFE_SINGLE_USER: "1",
  HOST: "127.0.0.1", PORT: String(port), ALLOW_QUERY_TOKEN: "0", GATEWAY_BOOTSTRAP_AUTH: "required" };
for (const name of ["OPENAI_API_KEY", "Z_AI_API_KEY", "ZHIPU_KEY", "CUSTOM_API_KEY", "CUSTOM_OPENAI_API_KEY", "TRUSTED_HOSTS", "GATEWAY_HTTPS", "CODEX_PERSISTENT_ROOTS", "CODEX_WORKER_LAUNCHER", "CODEX_HARNESS_ADMIN_HELPER"]) delete env[name];
const gateway = spawn(process.execPath, [path.join(root, "apps/gateway/dist/index.js")], {
  cwd: workspace, env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
});
let errors = "";
gateway.stderr.on("data", (chunk) => { errors = (errors + chunk.toString()).slice(-8000); });
gateway.on("error", (error) => { errors = error.message; });

function exchange({ headers = {}, suffix = "", method = "app/status", id = 1 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBase + suffix, { headers });
    const timer = setTimeout(() => finish(new Error("WS exchange timed out")), 5000);
    let done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.terminate();
      error ? reject(error) : resolve(result);
    };
    ws.on("error", (error) => finish(error));
    ws.on("close", (code) => finish(null, { close: code }));
    ws.on("open", () => ws.send(JSON.stringify({ kind: "rpc", id, method, params: {} })));
    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.kind === "rpcResult" && message.id === id) finish(null, { message });
      } catch (error) { finish(error); }
    });
  });
}

try {
  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline) {
    if (gateway.exitCode !== null) throw new Error(`gateway exited: ${errors}`);
    try {
      const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1500) });
      ready = response.ok && (await response.json()).codexState === "ready";
      if (ready) break;
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.ok(ready, `app-server failed to become ready: ${errors}`);
  console.log("PASS isolated gateway + real app-server initialization");
  const unauthenticated = await fetch(base, { signal: AbortSignal.timeout(5000) });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("set-cookie"), null);
  const html = await fetch(base, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
  assert.equal(html.status, 200);
  assert.ok(html.headers.get("set-cookie")?.includes("HttpOnly"));
  assert.ok((await html.text()).includes('<div id="root">'));
  console.log("PASS production SPA + HttpOnly cookie");
  const auth = { Authorization: `Bearer ${token}` };
  for (const [name, options, close] of [
    ["missing token", {}, 4001],
    ["invalid cookie", { headers: { Cookie: "gw_token=invalid" } }, 4001],
    ["valid query token disabled", { suffix: `?token=${token}` }, 4001],
    ["cross-origin", { headers: { ...auth, Origin: "http://evil.example" } }, 4003],
    ["untrusted host", { headers: { ...auth, Host: `evil.example:${port}` } }, 4003],
  ]) {
    assert.equal((await exchange(options)).close, close, name);
    console.log(`PASS reject ${name}`);
  }
  const status = (await exchange({ headers: auth })).message;
  assert.equal(status?.result?.codexState, "ready");
  assert.equal(status.error, undefined);
  assert.ok((await exchange({ headers: { Cookie: html.headers.get("set-cookie").split(";")[0] } })).message?.result);
  const account = (await exchange({ headers: auth, method: "account/read" })).message;
  assert.equal(account?.error, undefined);
  assert.equal(account?.result?.account, null);
  const blocked = (await exchange({ headers: auth, method: "fs/readFile" })).message;
  assert.match(blocked?.error ?? "", /not allowed/);
  console.log("PASS bearer/cookie RPC, signed-out isolation, RPC allowlist");
  console.log("GATEWAY-SMOKE-PASS (no turn, inference, provider setup, or production changes)");
} finally {
  if (gateway.pid && gateway.exitCode === null) {
    if (process.platform === "win32") {
      // Exact PID created above, including only its app-server descendants.
      spawnSync("taskkill", ["/PID", String(gateway.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10000 });
    } else {
      const closed = new Promise((resolve) => gateway.once("exit", resolve));
      gateway.kill("SIGTERM");
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 15000))]);
      if (gateway.exitCode === null) gateway.kill("SIGKILL");
    }
  }
  // Only the exact mkdtemp-created test directory, never the user's home.
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
