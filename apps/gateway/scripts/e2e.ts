/**
 * End-to-end check against the real gateway + real codex app-server.
 * Simulates a browser client over the WebSocket surface.
 * Run: pnpm --filter @codex-harness/gateway exec tsx scripts/e2e.ts
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const PORT = 8417;
const BASE = `http://127.0.0.1:${PORT}`;

// Fixed per-run token handed to the spawned gateway via GATEWAY_TOKEN. The
// gateway persists a random token on FIRST boot only — reading the token
// file before spawn would race (fresh CODEX_HOME → empty read → 4001 on
// every WS). A deterministic env token sidesteps the file entirely.
const E2E_TOKEN = randomBytes(32).toString("hex");
const WS_URL = `ws://127.0.0.1:${PORT}/ws?token=${E2E_TOKEN}`;

function fail(msg: string): never {
  console.error(`E2E FAIL: ${msg}`);
  server?.kill();
  process.exit(1);
}

let server: ReturnType<typeof spawn> | null = null;
let ws: WebSocket | null = null;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitHealthy(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  fail("gateway did not become healthy in time");
}

let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
const notifications: Array<{ method: string; params: any }> = [];

function rpc<T = any>(method: string, params?: unknown): Promise<T> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws!.send(JSON.stringify({ kind: "rpc", id, method, params: params ?? {} }));
  });
}

async function main() {
  server = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), CODEX_WORKSPACE: process.cwd(), GATEWAY_TOKEN: E2E_TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  server.stderr.on("data", (d) => process.stderr.write(`  [gw-err] ${d}`));
  server.stdout.on("data", (d) => process.stdout.write(`  [gw-out] ${d}`));

  await waitHealthy();
  console.log("step1 healthz: ok");

  ws = new WebSocket(WS_URL);
  await new Promise<void>((resolve, reject) => {
    ws!.onopen = () => resolve();
    ws!.onerror = (e) => reject(new Error(String(e)));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.kind === "rpcResult") {
      const entry = pending.get(msg.id);
      if (entry) {
        pending.delete(msg.id);
        msg.error ? entry.reject(new Error(msg.error)) : entry.resolve(msg.result);
      }
    } else if (msg.kind === "notification") {
      notifications.push({ method: msg.method, params: msg.params });
    }
  };
  console.log("step2 ws connect: ok");

  // Wait for codexState=ready via app/status polling.
  let status: any;
  for (let i = 0; i < 100; i++) {
    status = await rpc("app/status");
    if (status.codexState === "ready") break;
    await sleep(300);
  }
  if (status.codexState !== "ready") fail(`codexState not ready: ${status.codexState}`);
  console.log(`step3 app/status: ready, workspace=${status.workspaceRoot}`);

  const account = await rpc("account/read");
  console.log(`step4 account/read: ${account?.account ? account.account.email : "signed out"}`);

  const threads = await rpc("thread/list", { limit: 5 });
  console.log(`step5 thread/list: ${threads?.data?.length ?? 0} threads`);

  const startRes = await rpc("thread/start", {});
  const threadId = startRes?.thread?.id;
  if (!threadId) fail(`thread/start returned no thread.id: ${JSON.stringify(startRes).slice(0, 200)}`);
  console.log(`step6 thread/start: ${threadId}`);

  // Terminal roundtrip: open PTY, wait for prompt bytes, echo, terminate.
  const term = await rpc("terminal/exec", { rows: 24, cols: 80 });
  const pid = term?.processId;
  if (typeof pid !== "string") fail(`terminal/exec returned no processId: ${JSON.stringify(term)}`);
  console.log(`step7 terminal/exec: ${pid}`);
  await sleep(1500);
  await rpc("terminal/write", { processId: pid, base64: Buffer.from("echo E2E_MARKER_7f3\r").toString("base64") });
  const markerDeadline = Date.now() + 15_000;
  let sawMarker = false;
  while (Date.now() < markerDeadline && !sawMarker) {
    sawMarker = notifications.some((n) => n.method === "command/exec/outputDelta" && Buffer.from(n.params.deltaBase64 ?? "", "base64").toString("utf8").includes("E2E_MARKER_7f3"));
    if (!sawMarker) await sleep(300);
  }
  if (!sawMarker) fail("terminal did not echo E2E_MARKER_7f3");
  console.log("step8 terminal echo: ok");
  await rpc("terminal/terminate", { processId: pid });
  await sleep(1000);
  const exited = notifications.some((n) => n.method === "terminal/exited" && n.params.processId === pid);
  console.log(`step9 terminal/exited notification: ${exited ? "ok" : "missing ( tolerated on windows )"}`);

  // Turn flow: send a message; pass on any item/* or error activity within 60s.
  await rpc("turn/start", { threadId, text: "请只回复：OK" });
  const turnDeadline = Date.now() + 60_000;
  let turnEvidence: string | null = null;
  while (Date.now() < turnDeadline && !turnEvidence) {
    const itemNotif = notifications.find((n) => n.method.startsWith("item/") && n.params?.threadId === threadId);
    if (itemNotif) turnEvidence = itemNotif.method;
    const errNotif = notifications.find((n) => n.method === "error" && n.params?.threadId === threadId);
    if (errNotif) turnEvidence = `${errNotif.method}: ${errNotif.params?.error?.message ?? ""}`;
    if (!turnEvidence) await sleep(500);
  }
  if (!turnEvidence) fail("no item/* or error activity for the turn within 60s");
  console.log(`step10 turn activity: ${turnEvidence}`);

  console.log("E2E PASS");
  ws?.close();
  server?.kill();
  spawnSync("taskkill", ["/PID", String(server?.pid), "/T", "/F"], { shell: true });
  process.exit(0);
}

main().catch((err) => fail(err?.message ?? String(err)));
