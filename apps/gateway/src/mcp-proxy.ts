/**
 * Handler for codex `item/tool/call` dynamic-tool server requests.
 *
 * The pinned client's HTTP bridge namespaces delegate execution to this
 * gateway. Only the three fixed namespaces below are routed here; this is
 * not a generic executor for every configured stdio MCP server (notably the
 * separate zai-mcp-server vision server). Approval metadata does not imply
 * that a namespace should gain an HTTP executor.
 */

import type { DynamicToolCallParams } from "../../../protocol/v2/DynamicToolCallParams.js";
import type { DynamicToolCallResponse } from "../../../protocol/v2/DynamicToolCallResponse.js";
import type { DynamicToolCallOutputContentItem } from "../../../protocol/v2/DynamicToolCallOutputContentItem.js";
import { isResponseFor, isSupportedProtocolVersion, postMcp, RemoteHttpError } from "../../../deploy/providers/zhipu-coding-plan/mcp-http-transport.mjs";

const ZHIPU_ENDPOINTS: Record<string, string> = {
  "web-search-prime": "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
  "web-reader": "https://open.bigmodel.cn/api/mcp/web_reader/mcp",
  zread: "https://open.bigmodel.cn/api/mcp/zread/mcp",
};

function token(): string {
  return process.env.Z_AI_API_KEY ?? "";
}

// JSON-RPC ids must be unique per process — Date.now() collides for
// same-millisecond concurrent calls, which some endpoints mis-route.
let nextMcpRequestId = 1;

interface Session { id: string; version: string; }
const sessions = new Map<string, Session>();
// Concurrent tool calls must not race duplicate initialize handshakes.
const initInFlight = new Map<string, Promise<void>>();

const FETCH_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
export const DYNAMIC_TOOL_LIMITS = {
  concurrent: 4,
  argumentBytes: 1024 * 1024,
  argumentNodes: 100_000,
  argumentDepth: 64,
  toolChars: 256,
  responseContentItems: 10_000,
} as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function validatedArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error("MCP tool arguments must be a plain object");
  }
  const seen = new WeakSet<object>();
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > DYNAMIC_TOOL_LIMITS.argumentNodes) throw new Error("MCP tool arguments are too complex");
    if (current.depth > DYNAMIC_TOOL_LIMITS.argumentDepth) throw new Error("MCP tool arguments are too deeply nested");
    const item = current.value;
    if (item === null || typeof item === "string" || typeof item === "boolean") continue;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error("MCP tool arguments contain a non-finite number");
      continue;
    }
    if (!item || typeof item !== "object" || (![Object.prototype, null].includes(Object.getPrototypeOf(item)) && !Array.isArray(item))) {
      throw new Error("MCP tool arguments contain a non-JSON value");
    }
    if (seen.has(item)) throw new Error("MCP tool arguments contain a cycle");
    seen.add(item);
    const children = Array.isArray(item) ? item : Object.values(item);
    if (nodes + children.length > DYNAMIC_TOOL_LIMITS.argumentNodes) throw new Error("MCP tool arguments are too complex");
    for (const child of children) stack.push({ value: child, depth: current.depth + 1 });
  }
  let encoded: string;
  try { encoded = JSON.stringify(value); }
  catch { throw new Error("MCP tool arguments are not serializable"); }
  if (Buffer.byteLength(encoded) > DYNAMIC_TOOL_LIMITS.argumentBytes) throw new Error("MCP tool arguments exceed the 1MiB limit");
  return value as Record<string, unknown>;
}

/** Returns true when this gateway knows how to execute the namespace. */
export function isProxyableToolCall(namespace: string | null): boolean {
  return typeof namespace === "string" && Object.hasOwn(ZHIPU_ENDPOINTS, namespace);
}

async function fetchMcp(url: string, body: any, session: Session, signal?: AbortSignal): Promise<{ payload: any; sessionId: string }> {
  if (!token()) throw new Error("Z_AI_API_KEY is not configured");
  let payload: any;
  const sessionId = await postMcp(url, body, {
    token: token(), session, signal, timeoutMs: FETCH_TIMEOUT_MS, maxResponseBytes: MAX_RESPONSE_BYTES,
    onMessage(message) {
      if (body.id != null && isResponseFor(message, body.id)) {
        payload = message;
        return true;
      }
      return false;
    },
  });
  return { payload, sessionId };
}

/** Ensure an initialized session exists for this endpoint (deduped). */
function ensureSession(url: string): Promise<void> {
  if (sessions.has(url)) return Promise.resolve();
  const existing = initInFlight.get(url);
  if (existing) return existing;
  const p = (async () => {
    try {
      const init = await fetchMcp(url, {
        jsonrpc: "2.0",
        id: nextMcpRequestId++,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "codex-harness-gateway", version: "1.2.0" } },
      }, { id: "", version: "2025-03-26" });
      const handshake = init.payload;
      if (!isPlainRecord(handshake) || Object.hasOwn(handshake, "error") || !isPlainRecord(handshake.result)) {
        throw new Error("MCP initialize returned an invalid response");
      }
      const version = handshake.result.protocolVersion;
      if (typeof version !== "string" || !isSupportedProtocolVersion(version) || init.sessionId.length > 4096) throw new Error("MCP initialize returned invalid metadata");
      const session = { id: init.sessionId, version };
      await fetchMcp(url, { jsonrpc: "2.0", method: "notifications/initialized" }, session);
      sessions.set(url, session);
    } catch (error) {
      sessions.delete(url);
      throw error;
    } finally {
      initInFlight.delete(url);
    }
  })();
  initInFlight.set(url, p);
  return p;
}

async function awaitSession(url: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const ready = ensureSession(url);
  if (!signal) return ready;
  await new Promise<void>((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", aborted, { once: true });
    void ready.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

export async function handleDynamicToolCall(params: Pick<DynamicToolCallParams, "namespace" | "tool" | "arguments">, options: { signal?: AbortSignal } = {}): Promise<DynamicToolCallResponse> {
  const url = isProxyableToolCall(params.namespace) ? ZHIPU_ENDPOINTS[params.namespace!] : undefined;
  if (!url) throw new Error("no executor for requested tool namespace");
  if (typeof params.tool !== "string" || params.tool.length === 0 || params.tool.length > DYNAMIC_TOOL_LIMITS.toolChars
      || /[\u0000-\u001f\u007f]/.test(params.tool)) throw new Error("MCP tool name is invalid");
  const toolArguments = validatedArguments(params.arguments);

  await awaitSession(url, options.signal);

  const callBody = {
    jsonrpc: "2.0",
    id: nextMcpRequestId++,
    method: "tools/call",
    params: { name: params.tool, arguments: toolArguments },
  };

  options.signal?.throwIfAborted();
  const usedSession = sessions.get(url)!;
  let res;
  try {
    res = await fetchMcp(url, callBody, usedSession, options.signal);
  } catch (error) {
    // Only explicit rejection of an established session is retryable. A
    // transport timeout is ambiguous and must never replay a tool operation.
    if (!(error instanceof RemoteHttpError) || ![401, 404, 410].includes(error.status) || !usedSession.id || options.signal?.aborted) throw error;
    if (sessions.get(url) === usedSession) sessions.delete(url);
    await awaitSession(url, options.signal);
    options.signal?.throwIfAborted();
    res = await fetchMcp(url, callBody, sessions.get(url)!, options.signal);
  }

  const payload = res.payload;
  if (!isPlainRecord(payload) || payload.id !== callBody.id || Object.hasOwn(payload, "error") || !isPlainRecord(payload.result)) {
    throw new Error("MCP tools/call returned an invalid or error response");
  }
  const result = payload.result;
  if (!Array.isArray(result.content) || result.content.length > DYNAMIC_TOOL_LIMITS.responseContentItems
      || (result.isError !== undefined && typeof result.isError !== "boolean")) {
    throw new Error("MCP tools/call returned an invalid result schema");
  }
  const content: any[] = result.content;
  const isError = result.isError === true;
  const contentItems: DynamicToolCallOutputContentItem[] = [];
  let skipped = 0;
  for (const item of content) {
    if (item?.type === "text" && typeof item.text === "string") {
      contentItems.push({ type: "inputText", text: item.text });
    } else if ((item?.type === "image" || item?.type === "audio") && typeof item.data === "string"
      && typeof item.mimeType === "string" && new RegExp(`^${item.type}/[A-Za-z0-9.+-]+$`).test(item.mimeType)
      && item.data.length > 0 && item.data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(item.data)) {
      const url = `data:${item.mimeType};base64,${item.data}`;
      contentItems.push(item.type === "image" ? { type: "inputImage", imageUrl: url } : { type: "inputAudio", audioUrl: url });
    } else if (item?.type === "resource" && typeof item.resource?.text === "string") {
      contentItems.push({ type: "inputText", text: item.resource.text });
    } else skipped += 1;
  }
  if (skipped > 0) contentItems.push({ type: "inputText", text: `(${skipped} 个不支持的内容块已省略)` });

  return {
    contentItems: contentItems.length > 0
      ? contentItems
      : [{ type: "inputText", text: "(empty response)" }],
    success: !isError,
  };
}
