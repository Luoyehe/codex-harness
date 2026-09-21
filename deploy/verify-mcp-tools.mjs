// Explicitly paid acceptance tests for the configured MCP preset. A test
// needs a completed successful turn, a completed successful named tool call,
// and the expected final reply. Every created thread is cleaned in finally.
// HARNESS_ALLOW_PAID_TESTS=1 node verify-mcp-tools.mjs [never|on-request|untrusted] [web|zread|zai]
import path from "node:path";
import { pathToFileURL } from "node:url";

const POLICIES = new Set(["never", "on-request", "untrusted"]);
export const MCP_TASKS = [
  {
    key: "web-search-prime", server: "web-search-prime", tool: "web_search_prime",
    prompt: "必须且仅调用指定 MCP 工具 mcp__web_search_prime__web_search_prime 一次，搜索「OpenAI」，报告工具返回的前 3 条结果标题。无论成功或失败都不得重试，不得调用其它工具、运行任何命令或委派子代理；工具失败时直接报告失败。",
  },
  {
    key: "web-reader", server: "web-reader", tool: "webReader",
    prompt: "必须且仅调用指定 MCP 工具 mcp__web-reader__webReader 一次，读取网页 https://example.com ，报告页面主标题和正文第一句。无论成功或失败都不得重试，不得调用其它工具、运行任何命令或委派子代理；工具失败时直接报告失败。",
  },
  {
    key: "zread", server: "zread", tool: "get_repo_structure",
    prompt: "必须且仅调用指定 MCP 工具 mcp__zread__get_repo_structure 一次，查看仓库 vitejs/vite 的目录结构，列出根目录下 5 个以上文件或目录名。无论成功或失败都不得重试，不得调用其它工具、运行任何命令或委派子代理；工具失败时直接报告失败。",
  },
  {
    key: "zai-vision", server: "zai-mcp-server", tool: "analyze_image",
    prompt: "必须且仅调用指定 MCP 工具 mcp__zai_mcp_server__analyze_image 一次，分析图片 https://www.gstatic.com/webp/gallery3/1_webp_a.png ，描述图片内容（主体、颜色、背景）。无论成功或失败都不得重试，不得调用其它工具、运行任何命令或委派子代理；工具失败时直接报告失败。",
  },
];

function selection(argv) {
  const args = [...argv];
  const policy = POLICIES.has(args[0]) ? args.shift() : "never";
  for (const keyword of args) {
    if (!keyword.trim() || !MCP_TASKS.some(task => task.key.includes(keyword))) throw new Error("Unknown MCP task or unsupported approval policy");
  }
  const tasks = args.length ? MCP_TASKS.filter(task => args.some(keyword => task.key.includes(keyword))) : MCP_TASKS;
  if (tasks.length === 0) throw new Error("No MCP tasks selected");
  return { policy, tasks };
}

const normalize = text => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const meaningfulError = value => value !== undefined && value !== null && value !== false && value !== "" && value !== 0 && !(Array.isArray(value) && value.length === 0);
const failedHttpStatus = value => (typeof value === "number" || typeof value === "string") && /^\d{3}$/.test(String(value)) && Number(value) >= 400 && Number(value) <= 599;

/** Decode text-wrapped JSON as well as native structuredContent. Keep result
 * data, not echoed query/arguments or metadata, and reject explicit error
 * envelopes even when another block contains plausible successful text. */
function resultData(item) {
  const texts = [], records = [];
  let error = false, visited = 0, textBytes = 0;
  const skip = new Set(["_meta", "metadata", "query", "request", "input", "arguments", "parameters", "prompt", "type"]);
  const visit = (value, depth = 0) => {
    if (++visited > 10000 || depth > 24) { error = true; return; }
    if (typeof value === "string") {
      const text = value.trim();
      if (!text) return;
      textBytes += text.length;
      if (textBytes > 2 * 1024 * 1024) { error = true; return; }
      const json = text.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
      // Some MCP transports JSON-stringify their JSON payload more than once.
      // Decode quoted JSON strings through the same visit/depth/byte budgets;
      // valid quoted prose eventually reaches the ordinary plain-text path.
      // Malformed JSON is never repaired or interpreted with a looser parser.
      if (/^[\[{"]/.test(json)) {
        try { visit(JSON.parse(json), depth + 1); return; } catch { /* plain text */ }
      }
      if (/^(?:\(empty response\)|error\s*[:：]|错误\s*[:：]|失败\s*[:：])/i.test(text)) error = true;
      texts.push(text);
    } else if (Array.isArray(value)) {
      for (const child of value) visit(child, depth + 1);
    } else if (value && typeof value === "object") {
      if (value.isError === true || value.success === false || value.ok === false ||
          meaningfulError(value.error) || meaningfulError(value.errors) || meaningfulError(value.error_code) || meaningfulError(value.errorCode) ||
          /^(?:error|failed|failure|denied)$/i.test(String(value.status ?? "")) ||
          [value.status, value.statusCode, value.status_code, value.code].some(failedHttpStatus)) error = true;
      records.push(value);
      for (const [key, child] of Object.entries(value)) if (!skip.has(key)) visit(child, depth + 1);
    }
  };
  // Binary/media bytes alone cannot prove any of these four text-result tasks.
  const blocks = item.type === "mcpToolCall" ? item.result?.content : item.contentItems;
  if (item.isError === true || item.result?.isError === true) error = true;
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (block?.isError === true) error = true;
      if ((block?.type === "text" || block?.type === "inputText") && typeof block.text === "string") visit(block.text);
      else if (block?.type === "resource" && typeof block.resource?.text === "string") visit(block.resource.text);
    }
  }
  if (item.type === "mcpToolCall") {
    // Inspect top-level error fields separately without treating metadata as
    // useful content or counting the same content blocks twice.
    const { content: _content, structuredContent, _meta: _meta, ...envelope } = item.result ?? {};
    visit(envelope);
    visit(structuredContent);
  }
  return { texts, records, error };
}

function taskResult(data, reply, task) {
  if (data.error || data.texts.length === 0) return { result: false, reply: false };
  const text = data.texts.join("\n");
  const normalizedReply = normalize(reply);
  const shared = values => values.filter(value => normalizedReply.includes(normalize(value)));
  if (task.key === "web-search-prime") {
    const titles = [];
    const add = (title, url) => {
      if (typeof title === "string" && normalize(title).length >= 4 && typeof url === "string" && /^https?:\/\/\S+$/i.test(url)) titles.push(title);
    };
    for (const record of data.records) add(record.title ?? record.name, record.url ?? record.link ?? record.href);
    for (const part of data.texts) {
      for (const match of part.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gi)) add(match[1], match[2]);
      // Also accept plain title/link result blocks without assuming one
      // vendor-specific JSON envelope.
      for (const match of part.matchAll(/(?:^|\n)\s*(?:title|标题)\s*[:：]\s*([^\n]+)\n\s*(?:url|link|链接)\s*[:：]\s*(https?:\/\/\S+)/gi)) add(match[1], match[2]);
    }
    // Multiple content representations often repeat the same result. They
    // must not manufacture the three distinct titles requested by the task.
    const firstTitles = [...new Map(titles.map(title => [normalize(title), title])).values()].slice(0, 3);
    const result = /openai/i.test(text) && firstTitles.length === 3;
    return { result, reply: result && shared(firstTitles).length === 3 };
  }
  if (task.key === "web-reader") {
    const result = /example domain/i.test(text) && /(?:documentation|illustrative)\s+examples/i.test(text);
    return { result, reply: result && /example domain/i.test(reply) && /(?:documentation|illustrative)\s+examples|文档.{0,8}示例|示例.{0,8}文档/i.test(reply) };
  }
  if (task.key === "zread") {
    const names = [...new Set([...text.matchAll(/(?:^|[^a-z0-9_.-])(\.[a-z0-9_-]+|[a-z0-9_-]+(?:\.[a-z0-9_-]+)+|packages|docs|scripts|playground)(?=$|[^a-z0-9_.-])/gi)].map(match => match[1]))];
    const result = names.includes("package.json") && names.length >= 5;
    return { result, reply: result && shared(names).length >= 5 };
  }
  if (task.key === "zai-vision") {
    // Bounded fixture checks, not a claim to fully judge image descriptions.
    // Accept common English/Chinese equivalents instead of one exact word.
    const subject = /\broses?\b|玫瑰|月季/i;
    const colors = [/\bred\b|红色?/i, /\bpink\b|粉红|粉色/i, /\byellow\b|黄色?/i, /\bgreen\b|绿色?/i, /\bwhite\b|白色?/i, /\bblack\b|黑色?/i];
    const colorsSeen = colors.filter(pattern => pattern.test(text));
    const result = subject.test(text) && colorsSeen.length > 0 && /background|transparent|leaves|petals|背景|透明|叶|花瓣/i.test(text);
    return { result, reply: result && subject.test(reply) && colorsSeen.some(pattern => pattern.test(reply)) };
  }
  return { result: false, reply: false };
}

/** Pure evidence check, including thread AND turn IDs. A started tool, a
 * failed turn with an earlier good reply, or another turn's output cannot pass.
 * HTTP bridge dynamicToolCall and native stdio mcpToolCall are both supported. */
export function taskEvidence(notes, threadId, turnId, task) {
  const own = notes.filter(note => note.params?.threadId === threadId &&
    (note.params?.turnId === turnId || note.params?.turn?.id === turnId));
  const completed = own.some(note => note.method === "turn/completed" && note.params?.turn?.id === turnId && note.params.turn.status === "completed");
  const items = own.filter(note => note.method === "item/completed").map(note => note.params.item);
  const calls = items.filter(item => item?.status === "completed" && item.tool === task.tool && (
    (item.type === "mcpToolCall" && item.server === task.server && item.result != null && !item.error) ||
    (item.type === "dynamicToolCall" && item.namespace === task.server && item.success === true && Array.isArray(item.contentItems) && item.contentItems.length > 0)
  ));
  // Null/missing phase is the protocol's legacy compatibility case. Explicit
  // Other explicit phases cannot satisfy the final-answer content check.
  const reply = items.filter(item => item?.type === "agentMessage" && (item.phase == null || item.phase === "final_answer") && typeof item.text === "string").map(item => item.text).join("\n");
  const evidence = calls.map(item => taskResult(resultData(item), reply, task));
  const toolResult = evidence.some(item => item.result);
  const content = reply.trim().length >= 10 && evidence.some(item => item.result && item.reply);
  return { completed, call: calls.length > 0, toolResult, content, ok: completed && toolResult && content };
}

const TOOL_TYPES = new Set(["mcpToolCall", "dynamicToolCall", "commandExecution", "fileChange", "webSearch", "imageView", "imageGeneration", "collabAgentToolCall", "collabToolCall", "subAgentActivity", "sleep"]);
const safeId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
const numeric = value => Number.isFinite(value) && value >= 0 ? value : null;

export function taskToolCounts(notes, threadId, turnId, task) {
  const calls = new Map();
  for (const note of notes) {
    if (!["item/started", "item/completed"].includes(note.method) || note.params?.threadId !== threadId || note.params?.turnId !== turnId) continue;
    const item = note.params.item;
    if (!TOOL_TYPES.has(item?.type)) continue;
    const key = typeof item.id === "string" ? item.id : `missing-${calls.size}`;
    const named = item.tool === task.tool && ((item.type === "mcpToolCall" && item.server === task.server) ||
      (item.type === "dynamicToolCall" && item.namespace === task.server));
    const previous = calls.get(key);
    calls.set(key, { named: (previous?.named ?? true) && named, completed: !!previous?.completed || note.method === "item/completed" });
  }
  const values = [...calls.values()];
  return { observed: values.length, completed: values.filter(value => value.completed).length,
    named: values.filter(value => value.named).length, other: values.filter(value => !value.named).length };
}

function taskUsage(notes, threadId, turnId) {
  const usage = notes.filter(note => note.method === "thread/tokenUsage/updated" && note.params?.threadId === threadId && note.params?.turnId === turnId).at(-1)?.params?.tokenUsage;
  if (!usage || typeof usage !== "object") return null;
  const breakdown = value => value && typeof value === "object" ? Object.fromEntries(
    ["totalTokens", "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens"].map(key => [key, numeric(value[key])]),
  ) : null;
  return { last: breakdown(usage.last), total: breakdown(usage.total), modelContextWindow: numeric(usage.modelContextWindow) };
}

function expectations(env) {
  const result = {};
  for (const key of ["PROVIDER", "MODE", "MODEL"]) {
    const value = env[`HARNESS_VERIFY_${key}`];
    if (value) {
      if (!/^[A-Za-z0-9._:/-]{1,200}$/.test(value) || (key === "MODE" && !["openai", "zhipu", "custom"].includes(value))) throw new Error("Invalid MCP verification expectation");
      result[key.toLowerCase()] = value;
    }
  }
  if (env.HARNESS_VERIFY_CWD) {
    const cwd = env.HARNESS_VERIFY_CWD;
    if (!/^\/[A-Za-z0-9_./-]+$/.test(cwd) || path.posix.normalize(cwd) !== cwd || cwd === "/" || cwd.endsWith("/")) throw new Error("Invalid MCP verification cwd");
    result.cwd = cwd;
  }
  return result;
}

class TaskFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}

export async function runMcpVerification(argv = process.argv.slice(2), {
  createClient, log = console.log, error = console.error, env = process.env, now = Date.now,
} = {}) {
  // Opt-in before importing ws-token, connecting or creating any server state.
  if (process.env.HARNESS_ALLOW_PAID_TESTS !== "1") throw new Error("Set HARNESS_ALLOW_PAID_TESTS=1 explicitly for paid MCP verification");
  const { policy, tasks } = selection(argv);
  const expected = expectations(env);
  const { VerificationClient, completedTurn, cleanupThread, requirePaidVerification } = await import("./verification-client.mjs");
  requirePaidVerification();
  const client = createClient ? createClient() : new VerificationClient();
  let failed = 0, preflightFailure = null;
  try {
    log("Testing " + tasks.length + " MCP task(s), approvalPolicy=" + policy + "; model/MCP requests may incur charges.");
    log("Each task permits one named tool call and no retries. Prompts constrain intent only; observed extra calls fail. Turn/tool counts do not bound provider request counts or spending.");
    log("Checks require task-relevant tool results and grounded reply markers; natural-language accuracy still needs a spot-check.");
    if (expected.mode) {
      try {
        const status = await client.rpc("app/status");
        if (status?.providerMode !== expected.mode || status?.codexState !== "ready") preflightFailure = "gateway_mode_not_ready";
      } catch { preflightFailure = "gateway_status_failed"; }
    }
    for (const task of tasks) {
      const started = now();
      let threadId, turnId, stage = "preflight";
      const record = { kind: "mcp-task-verification", task: task.key, threadId: null, turnId: null, status: "failed", turnStatus: null,
        completed: false, namedTool: false, toolResult: false, groundedReply: false,
        tools: { observed: 0, completed: 0, named: 0, other: 0 }, tokenUsage: null, rerouteCount: 0, durationMs: null,
        cleanup: { attempted: false, ok: null }, failure: null };
      client.notes.length = 0;
      try {
        if (preflightFailure) throw new TaskFailure(preflightFailure);
        stage = "thread-start";
        const response = await client.rpc("thread/start", { sandbox: "read-only", ...(expected.cwd ? { cwd: expected.cwd } : {}) });
        threadId = response?.thread?.id;
        record.threadId = safeId(threadId);
        if (!record.threadId) throw new TaskFailure("invalid_thread_identity");
        if ((expected.provider && (response.modelProvider !== expected.provider || response.thread.modelProvider !== expected.provider)) ||
            (expected.model && response.model !== expected.model) ||
            (expected.cwd && (response.cwd !== expected.cwd || response.thread.cwd !== expected.cwd))) {
          preflightFailure = "thread_expectation_mismatch";
          throw new TaskFailure(preflightFailure);
        }
        stage = "turn";
        turnId = await completedTurn(client, threadId, { text: task.prompt, approvalPolicy: policy, sandbox: "network" });
        if (!safeId(turnId)) throw new TaskFailure("invalid_turn_identity");
        stage = "evidence";
        const evidence = taskEvidence(client.notes, threadId, turnId, task);
        const tools = taskToolCounts(client.notes, threadId, turnId, task);
        if (tools.other > 0) throw new TaskFailure("unexpected_tool_call");
        if (tools.observed > 1) throw new TaskFailure("tool_call_limit_exceeded");
        if (!evidence.call) throw new TaskFailure("named_tool_not_completed");
        if (!evidence.toolResult) throw new TaskFailure("invalid_tool_result");
        if (!evidence.content) throw new TaskFailure("ungrounded_reply");
        if (!evidence.ok || tools.observed !== 1 || tools.named !== 1) throw new TaskFailure("incomplete_evidence");
        record.status = "completed";
      } catch (failure) {
        record.failure = { stage, code: failure instanceof TaskFailure ? failure.code : "rpc_or_transport_failed" };
      } finally {
        turnId ??= client.notes.findLast(note => ["turn/started", "turn/completed"].includes(note.method) && note.params?.threadId === threadId)?.params?.turn?.id;
        record.turnId = safeId(turnId);
        if (record.turnId) {
          const evidence = taskEvidence(client.notes, threadId, turnId, task);
          record.completed = evidence.completed; record.namedTool = evidence.call;
          record.toolResult = evidence.toolResult; record.groundedReply = evidence.content;
          record.tools = taskToolCounts(client.notes, threadId, turnId, task);
          record.tokenUsage = taskUsage(client.notes, threadId, turnId);
          const terminal = client.notes.findLast(note => note.method === "turn/completed" && note.params?.threadId === threadId && note.params?.turn?.id === turnId)?.params?.turn?.status;
          record.turnStatus = ["completed", "failed", "interrupted"].includes(terminal) ? terminal : null;
          if (record.failure?.code === "rpc_or_transport_failed" && record.turnStatus === "failed") record.failure.code = "model_turn_failed";
          record.rerouteCount = client.notes.filter(note => note.method === "model/rerouted" && note.params?.threadId === threadId && note.params?.turnId === turnId).length;
          if (record.rerouteCount > 0) {
            record.status = "failed";
            record.failure = { stage: "evidence", code: "model_rerouted" };
          }
        }
        if (typeof threadId === "string" && threadId) {
          record.cleanup.attempted = true;
          try { await cleanupThread(client, threadId); record.cleanup.ok = true; }
          catch { record.status = "failed"; record.cleanup.ok = false; record.failure ??= { stage: "cleanup", code: "thread_cleanup_failed" }; }
        }
        record.durationMs = Math.max(0, now() - started);
      }
      // No raw replies, tool results/arguments, account/config, paths or errors.
      log(JSON.stringify(record));
      if (record.status === "completed") log("PASS " + task.key + " (single named tool, task-relevant result, grounded reply, thread removed)");
      else { failed += 1; error("FAIL " + task.key + ": " + record.failure?.code); }
    }
  } finally { client.close(); }
  log(failed === 0 ? "MCP-TOOLS-PASS" : "MCP-TOOLS-FAIL(" + failed + ")");
  return failed === 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { if (!await runMcpVerification()) process.exitCode = 1; }
  catch { console.error("MCP-TOOLS-FAIL (preflight or connection cleanup failed; check paid opt-in, task filters and verification expectations)"); process.exitCode = 1; }
}
