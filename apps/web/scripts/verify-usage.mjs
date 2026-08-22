// Protocol-level check: thread/tokenUsage/updated notifications flow to
// clients after a turn, carrying total tokens and the model context window.
import { wsUrl } from "../../../deploy/ws-token.mjs";
const WS = wsUrl(process.env.GATEWAY_WS ?? "ws://127.0.0.1:8080/ws");
const ws = new WebSocket(WS);
let nextId = 1;
const pending = new Map();
const notes = [];
const rpc = (m, p) =>
  new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ kind: "rpc", id, method: m, params: p ?? {} }));
  });
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

(async () => {
  await new Promise((r) => (ws.onopen = r));
  const st = await rpc("thread/start", {});
  const tid = st?.thread?.id;
  await rpc("turn/start", { threadId: tid, text: "回复：好" });

  let usage = null;
  for (let i = 0; i < 60 && !usage; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const n = notes.find((x) => x.method === "thread/tokenUsage/updated" && x.params?.threadId === tid);
    if (n) usage = n.params.tokenUsage;
  }
  if (usage) {
    console.log("USAGE total:", usage.total?.totalTokens, "window:", usage.modelContextWindow);
    console.log("TOKEN-USAGE-PASS");
  } else {
    // Local invalid key still yields usage? If not, report notification absence.
    console.log("no tokenUsage notification within 60s");
    console.log("notifications seen:", [...new Set(notes.map((n) => n.method))].join(", "));
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error("error:", e.message);
  process.exit(1);
});
