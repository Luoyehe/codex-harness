// Deep verification: real model reply through the whole gateway chain.
import { wsUrl } from "./ws-token.mjs";
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => (ws.onopen = r));
  const st = await rpc("thread/start", {});
  const tid = st.thread.id;
  await rpc("turn/start", { threadId: tid, text: "请只回复四个字：部署成功" });
  let answer = "";
  for (let i = 0; i < 120 && !answer; i++) {
    await sleep(1000);
    const done = notes.find(
      (n) => n.method === "item/completed" && n.params?.item?.type === "agentMessage" && n.params?.threadId === tid,
    );
    if (done) answer = done.params.item.text;
    const delta = notes
      .filter((n) => n.method === "item/agentMessage/delta" && n.params?.threadId === tid)
      .map((n) => n.params.delta)
      .join("");
    if (!answer && delta.length > 5) answer = delta + " …(流式截取)";
  }
  const errNote = notes.find((n) => n.method === "error" && n.params?.threadId === tid);
  const mcpItems = notes.filter((n) => n.method.startsWith("item/mcpToolCall")).length;
  console.log("AGENT_REPLY:", answer || "(no reply in 120s)");
  if (errNote) console.log("ERROR_NOTE:", (errNote.params?.error?.message ?? "").slice(0, 120));
  console.log("MCP_ITEMS:", mcpItems);
  process.exit(answer ? 0 : 1);
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
