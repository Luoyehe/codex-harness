// In-container WebSocket e2e: exercises the same surface a browser uses.
import { wsUrl } from "./ws-token.mjs";
const WS = wsUrl(process.env.GATEWAY_WS ?? "ws://127.0.0.1:8080/ws");
const ws = new WebSocket(WS);
const pending = new Map();
const notifications = [];
let nextId = 1;
let failures = 0;

function check(name, ok, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " " + extra : ""}`);
  if (!ok) failures++;
}

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    if (closed) return reject(new Error("websocket closed"));
    pending.set(id, { resolve, reject });
    try {
      ws.send(JSON.stringify({ kind: "rpc", id, method, params: params ?? {} }));
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// If the socket dies mid-run, reject all pending RPCs instead of letting the
// event loop drain into a silent exit-0.
let closed = false;
ws.onclose = (ev) => {
  closed = true;
  const err = new Error(`websocket closed (code=${ev?.code})`);
  for (const [, entry] of pending) entry.reject(err);
  pending.clear();
};

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

async function main() {
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error("ws error")); });
  check("ws connect", true);

  const status = await rpc("app/status");
  check("app/status", status?.codexState === "ready", `codexState=${status?.codexState}`);

  const account = await rpc("account/read");
  check("account/read", typeof account?.requiresOpenaiAuth === "boolean",
    `account=${JSON.stringify(account?.account)} requiresOpenaiAuth=${account?.requiresOpenaiAuth}`);

  const models = await rpc("model/list");
  const modelIds = (models?.data ?? []).map((m) => m.id);
  // Provider-neutral: whichever catalog is active (glm for the Zhipu preset,
  // gpt-* for native OpenAI), the RPC must return at least one model.
  check("model/list", modelIds.length > 0, `models=${modelIds.slice(0, 4).join(",")}`);

  const threads = await rpc("thread/list", { limit: 5 });
  check("thread/list", Array.isArray(threads?.data), `count=${threads?.data?.length ?? 0}`);

  const start = await rpc("thread/start", {});
  const threadId = start?.thread?.id;
  check("thread/start", !!threadId, `threadId=${threadId}`);

  const term = await rpc("terminal/exec", { rows: 24, cols: 80 });
  const pid = term?.processId;
  check("terminal/exec", typeof pid === "string", `processId=${pid}`);
  await sleep(1500);
  await rpc("terminal/write", { processId: pid, base64: Buffer.from("echo SPARK_MARKER_9c2\r").toString("base64") });
  let sawMarker = false;
  for (let i = 0; i < 40 && !sawMarker; i++) {
    sawMarker = notifications.some(
      (n) => n.method === "command/exec/outputDelta" &&
        Buffer.from(n.params.deltaBase64 ?? "", "base64").toString("utf8").includes("SPARK_MARKER_9c2"),
    );
    if (!sawMarker) await sleep(300);
  }
  check("terminal echo roundtrip", sawMarker);
  await rpc("terminal/terminate", { processId: pid });

  // turn/start: with a valid ZAI key this streams items; without one it must
  // still surface a protocol-level error notification instead of hanging.
  await rpc("turn/start", { threadId, text: "Reply with exactly: OK" });
  let evidence = null;
  for (let i = 0; i < 100 && !evidence; i++) {
    const item = notifications.find((n) => n.method.startsWith("item/") && n.params?.threadId === threadId);
    if (item) evidence = item.method;
    const err = notifications.find((n) => n.method === "error" && n.params?.threadId === threadId);
    if (err) evidence = `error: ${(err.params?.error?.message ?? "").slice(0, 80)}`;
    if (!evidence) await sleep(500);
  }
  check("turn activity", !!evidence, evidence ? `(${evidence})` : "(none within 50s)");

  console.log(failures === 0 ? "WS-E2E-PASS" : `WS-E2E-FAIL(${failures})`);
  try { ws.close(); } catch {}
  await sleep(100); // let buffered stdout flush before exit
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error("WS E2E error:", err.message); process.exit(1); });
