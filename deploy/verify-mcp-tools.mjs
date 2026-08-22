// Real-task acceptance tests for the four MCP servers, run under the
// approval policy that used to block MCP calls ("never"). Each task must
// invoke the named tool AND the agent reply must contain the expected text.
//
//   node verify-mcp-tools.mjs            # all four
//   node verify-mcp-tools.mjs web zread  # subset by keyword
import { wsUrl } from "./ws-token.mjs";
const WS = wsUrl(process.env.GATEWAY_WS ?? "ws://127.0.0.1:8080/ws");
const ARGV = process.argv.slice(2);
const POLICIES = new Set(["never", "on-request", "on-failure", "always", "untrusted"]);
const POLICY = POLICIES.has(ARGV[0]) ? ARGV.shift() : "never";

const TASKS = [
  {
    key: "web-search-prime",
    match: ["web-search-prime"],
    timeout: 150_000,
    prompt:
      "不要运行任何命令。必须调用 MCP 工具 mcp__web_search_prime__web_search_prime 搜索「OpenAI」，报告工具返回的前 3 条结果标题。",
    expect: ["OpenAI"],
  },
  {
    key: "web-reader",
    match: ["web-reader"],
    timeout: 150_000,
    prompt:
      "不要运行任何命令。必须调用 MCP 工具 mcp__web-reader__webReader 读取网页 https://example.com ，报告页面主标题和正文第一句。",
    expect: ["Example Domain"],
  },
  {
    key: "zread",
    match: ["zread"],
    timeout: 150_000,
    prompt:
      "不要运行任何命令。必须调用 MCP 工具 mcp__zread__get_repo_structure 查看仓库 vitejs/vite 的目录结构，列出根目录下 5 个以上文件或目录名。",
    expect: ["package.json"],
  },
  {
    key: "zai-vision",
    match: ["zai-mcp-server"],
    timeout: 180_000,
    // NOTE: upload.wikimedia.org URLs fail inside Zhipu's vision API with
    // code 1210: Wikimedia 403s Zhipu's server-side image fetch (User-Agent
    // policy), so the API never sees image bytes. Verified with a gstatic
    // URL that Zhipu can fetch: the tool then returns a full description.
    prompt:
      "不要运行任何命令。必须调用 MCP 工具 mcp__zai_mcp_server__analyze_image 分析图片 https://www.gstatic.com/webp/gallery3/1_webp_a.png ，描述图片内容（主体、颜色、背景）。",
    expect: ["玫瑰"],
  },
];

const tasks = ARGV.length ? TASKS.filter((t) => ARGV.some((k) => t.key.includes(k))) : TASKS;

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

async function runTask(task) {
  const started = await rpc("thread/start", {});
  const tid = started.thread.id;
  await rpc("turn/start", { threadId: tid, text: task.prompt, approvalPolicy: POLICY });

  const deadline = Date.now() + task.timeout;
  let turnDone = false;
  while (Date.now() < deadline) {
    await sleep(2000);
    const done = notes.find((n) => n.method === "turn/completed" && n.params?.threadId === tid);
    const failed = notes.find((n) => n.method === "error" && n.params?.threadId === tid && !n.params?.willRetry);
    if (done || failed) {
      turnDone = true;
      break;
    }
  }

  const callsDone = notes
    .filter((n) => n.method === "item/completed" && n.params?.threadId === tid && n.params?.item?.type === "mcpToolCall")
    .map((n) => n.params.item);
  const callsStarted = notes
    .filter((n) => n.method === "item/started" && n.params?.threadId === tid && n.params?.item?.type === "mcpToolCall")
    .map((n) => n.params.item);
  const target = callsDone.find((c) => task.match.some((m) => String(c.server).includes(m)))
    ?? callsStarted.find((c) => task.match.some((m) => String(c.server).includes(m)));
  const agentMsg = notes
    .filter((n) => n.method === "item/completed" && n.params?.threadId === tid && n.params?.item?.type === "agentMessage")
    .map((n) => n.params.item.text)
    .join("");

  const callOk = !!target && (target.status === "completed" || target.result != null);
  const contentOk = task.expect.every((s) => agentMsg.toLowerCase().includes(s.toLowerCase()))
    && (task.expect.length > 0 ? agentMsg.length >= 10 : agentMsg.length >= 40);
  const ok = callOk && contentOk;
  console.log(`${ok ? "PASS" : "FAIL"} ${task.key}`);
  console.log(`     turn: ${turnDone ? "completed" : "TIMEOUT"}`);
  if (target) {
    console.log(`     call: ${target.server}/${target.tool} status=${target.status} result=${target.result ? "yes" : "none"}`);
  } else {
    const kinds = [...new Set(notes.filter((n) => n.params?.threadId === tid).map((n) => n.method))];
    console.log(`     call: NOT INVOKED; notifications: ${kinds.join(", ")}`);
  }
  console.log(`     content: ${contentOk ? "ok" : `missing ${JSON.stringify(task.expect)}`}`);
  console.log(`     reply: ${agentMsg.slice(0, 160) || "(none)"}`);
  await rpc("thread/delete", { threadId: tid }).catch(() => {});
  return ok;
}

(async () => {
  await new Promise((r) => (ws.onopen = r));
  console.log(`testing ${tasks.length} MCP task(s) against ${WS} with approvalPolicy=${POLICY}`);
  let failed = 0;
  for (const t of tasks) {
    if (!(await runTask(t))) failed++;
  }
  console.log(failed === 0 ? "MCP-TOOLS-PASS" : `MCP-TOOLS-FAIL(${failed})`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error("error:", e.message);
  process.exit(1);
});
