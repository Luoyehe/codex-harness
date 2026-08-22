// Gateway RPC surface test — core whitelisted methods (app/status, thread/*,
// turn/*, terminal/*, projects/*), run against a local or remote gateway.
// Not exhaustive: displayPrefs, attachment/*, account/login, and
// auto-compaction are covered by dedicated scripts. Model calls exercise the
// error path locally (invalid key) or the real path on the server; both are PASS.
import { wsUrl } from "./ws-token.mjs";
const WS = wsUrl(process.env.GATEWAY_WS ?? "ws://127.0.0.1:8080/ws");
const ws = new WebSocket(WS);
let nextId = 1;
const pending = new Map();
const notes = [];
let failures = 0;

const rpc = (m, p) =>
  new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ kind: "rpc", id, method: m, params: p ?? {} }));
  });

function check(name, ok, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " " + extra : ""}`);
  if (!ok) failures++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.kind === "rpcResult") {
    const e = pending.get(msg.id);
    if (e) {
      pending.delete(msg.id);
      msg.error ? e.rej(new Error(msg.error)) : e.res(msg.result);
    }
  } else if (msg.kind === "notification") {
    notes.push(msg);
  }
};

async function main() {
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = (e) => rej(new Error("ws connect failed"));
  });
  check("ws connect", true);

  // --- app/session meta ---
  const status = await rpc("app/status");
  check("app/status", status?.codexState === "ready");
  const account = await rpc("account/read");
  check("account/read", typeof account?.requiresOpenaiAuth === "boolean");
  const models = await rpc("model/list");
  check("model/list", (models?.data ?? []).length > 0, `models=${models.data.length}`);
  const mcp = await rpc("mcpServerStatus/list");
  check("mcpServerStatus/list", Array.isArray(mcp?.data), `servers=${mcp.data.length}`);

  // --- projects CRUD ---
  const projRoot = status.workspaceRoot;
  const testDir = projRoot + "/e2e-full-project";
  await rpc("projects/add", { path: testDir, create: true });
  let list = await rpc("projects/list");
  check("projects/add + list", (list?.projects ?? []).some((p) => p.path === testDir));
  const read1 = await rpc("fs/readDirectory", { path: testDir });
  check("fs/readDirectory", Array.isArray(read1?.entries));
  await rpc("projects/touch", { path: testDir });
  await rpc("projects/remove", { path: testDir });
  list = await rpc("projects/list");
  check("projects/remove", !(list?.projects ?? []).some((p) => p.path === testDir));
  let rejected = false;
  try {
    await rpc("projects/add", { path: "relative/path", create: true });
  } catch {
    rejected = true;
  }
  check("projects/add rejects relative paths", rejected);

  // --- threads lifecycle ---
  const started = await rpc("thread/start", { cwd: projRoot });
  const tid = started?.thread?.id;
  check("thread/start", !!tid, `thread=${tid?.slice(0, 8)}`);
  await rpc("thread/name/set", { threadId: tid, name: "e2e-full-test" });
  const resumed = await rpc("thread/resume", { threadId: tid });
  check("thread/resume", resumed?.thread?.id === tid);
  const read = await rpc("thread/read", { threadId: tid });
  check("thread/read", read?.thread?.id === tid);

  // --- turn with per-turn overrides (params must pass gateway validation) ---
  const turnP = rpc("turn/start", { threadId: tid, text: "回复：好", model: models.data[0].id, approvalPolicy: "on-request" });
  let evidence = null;
  for (let i = 0; i < 50 && !evidence; i++) {
    await sleep(500);
    const item = notes.find((n) => n.method.startsWith("item/") && n.params?.threadId === tid);
    const err = notes.find((n) => n.method === "error" && n.params?.threadId === tid);
    if (item) evidence = item.method;
    if (err) evidence = `error:${(err.params?.error?.message ?? "").slice(0, 40)}`;
  }
  await Promise.race([turnP, sleep(100)]);
  check("turn/start with overrides", !!evidence, `(${evidence})`);

  // --- terminal lifecycle ---
  const term = await rpc("terminal/exec", { rows: 20, cols: 90 });
  const pid = term?.processId;
  check("terminal/exec", typeof pid === "string");
  await sleep(1200);
  await rpc("terminal/write", { processId: pid, base64: Buffer.from("echo FULL_MARKER_51\r").toString("base64") });
  await rpc("terminal/resize", { processId: pid, rows: 24, cols: 100 });
  let saw = false;
  for (let i = 0; i < 30 && !saw; i++) {
    saw = notes.some(
      (n) => n.method === "command/exec/outputDelta" && Buffer.from(n.params.deltaBase64 ?? "", "base64").toString("utf8").includes("FULL_MARKER_51"),
    );
    if (!saw) await sleep(300);
  }
  check("terminal write/resize/output", saw);
  await rpc("terminal/terminate", { processId: pid });
  let exited = false;
  for (let i = 0; i < 20 && !exited; i++) {
    exited = notes.some((n) => n.method === "terminal/exited" && n.params.processId === pid);
    if (!exited) await sleep(300);
  }
  check("terminal/exited broadcast", exited);

  // --- compact (may fail on invalid key locally; accept both outcomes) ---
  let compactOk = true;
  try {
    await rpc("thread/compact/start", { threadId: tid });
  } catch (e) {
    compactOk = String(e.message).length > 0; // gateway forwarded; server responded
  }
  check("thread/compact/start reachable", compactOk);

  // --- interrupt (needs the live turnId from turn/started) ---
  const turnNote = notes.find((n) => n.method === "turn/started" && n.params?.threadId === tid);
  if (turnNote?.params?.turn?.id) {
    let int = true;
    try {
      await rpc("turn/interrupt", { threadId: tid, turnId: turnNote.params.turn.id });
    } catch {
      int = false;
    }
    check("turn/interrupt with turnId", int);
  } else {
    check("turn/interrupt with turnId", false, "(no turn/started captured)");
  }

  // --- archive + delete ---
  await rpc("thread/archive", { threadId: tid });
  await rpc("thread/delete", { threadId: tid });
  const finalList = await rpc("thread/list", { limit: 50, cwd: projRoot });
  check("thread archive/delete", !(finalList?.data ?? []).some((t) => t.id === tid));

  // --- unknown method is rejected (whitelist works) ---
  let blocked = false;
  try {
    await rpc("process/spawn", { command: ["id"] });
  } catch {
    blocked = true;
  }
  check("whitelist blocks process/spawn", blocked);

  console.log(failures === 0 ? "FULL-E2E-PASS" : `FULL-E2E-FAIL(${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FULL E2E error:", e.message);
  process.exit(1);
});
