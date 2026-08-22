// Reproduce the "MCP tool call requires approval, but approval policy is
// never" failure and verify fixes. Pass an approvalPolicy to test with:
//   node verify-mcp-approval.mjs never       # must pass after the fix
//   node verify-mcp-approval.mjs on-request  # control group
// Fix: mcp_servers.<id>.default_tools_approval_mode = "approve" in
// config.toml (written by setup-http-mcp.sh / setup-zai-mcp.sh).
import { wsUrl } from "./ws-token.mjs";
const WS = wsUrl(process.env.GATEWAY_WS ?? "ws://127.0.0.1:8080/ws");
const POLICY = process.argv[2] ?? "never";

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
  } else if (msg.kind === "notification") notes.push(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => (ws.onopen = r));
  const st = await rpc("thread/start", {});
  const tid = st.thread.id;
  await rpc("turn/start", {
    threadId: tid,
    text: "不要运行任何命令。必须调用 MCP 工具 mcp__web_search_prime__web_search_prime 搜索「OpenAI」，报告工具返回的前 3 条结果标题。",
    approvalPolicy: POLICY,
  });
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    await sleep(3000);
    if (notes.find((n) => n.method === "turn/completed" && n.params?.threadId === tid)) break;
  }
  const call = notes.find(
    (n) => n.method === "item/completed" && n.params?.threadId === tid && n.params?.item?.type === "mcpToolCall",
  )?.params?.item;
  const reply = notes
    .filter((n) => n.method === "item/completed" && n.params?.threadId === tid && n.params?.item?.type === "agentMessage")
    .map((n) => n.params.item.text)
    .join("")
    .slice(0, 200);
  const errItem = notes.find(
    (n) => n.method === "item/completed" && n.params?.threadId === tid && n.params?.item?.type === "errorItem",
  );
  console.log(`policy=${POLICY}`);
  console.log(`mcp call: ${call ? `${call.server}/${call.tool} status=${call.status}` : "(not invoked)"}`);
  console.log(`reply: ${reply || "(none)"}`);
  console.log(`errorItem: ${errItem?.params?.item?.message?.slice(0, 120) ?? "(none)"}`);
  await rpc("thread/delete", { threadId: tid }).catch(() => {});
  process.exit(0);
})().catch((e) => {
  console.error("error:", e.message);
  process.exit(1);
});
