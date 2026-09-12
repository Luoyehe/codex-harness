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

// Per-endpoint session ids handed out at initialize; required on later calls.
const sessionIds = new Map<string, string>();
// Endpoints whose initialize completed even when the server handed out no
// session id (some don't) — don't re-handshake on every call.
const initialized = new Set<string>();
// Concurrent tool calls must not race duplicate initialize handshakes.
const initInFlight = new Map<string, Promise<void>>();

const FETCH_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** Returns true when this gateway knows how to execute the namespace. */
export function isProxyableToolCall(namespace: string | null): boolean {
  return typeof namespace === "string" && Object.hasOwn(ZHIPU_ENDPOINTS, namespace);
}

async function fetchMcp(url: string, body: unknown): Promise<{ status: number; ctype: string; text: string }> {
  if (!token()) throw new Error("Z_AI_API_KEY is not configured");
  const sid = sessionIds.get(url);
  const res = await fetch(url, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
      ...(sid ? { "Mcp-Session-Id": sid } : {}),
    },
    body: JSON.stringify(body),
    // A hung remote endpoint must not hang the agent turn forever.
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const sid2 = res.headers.get("mcp-session-id");
  if (sid2) sessionIds.set(url, sid2);
  const ctype = res.headers.get("content-type") ?? "";
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`MCP response exceeded ${MAX_RESPONSE_BYTES} bytes`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  if (res.body) {
    for await (const chunk of res.body) {
      const bytes = Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await res.body.cancel().catch(() => {});
        throw new Error(`MCP response exceeded ${MAX_RESPONSE_BYTES} bytes`);
      }
      chunks.push(bytes);
    }
  }
  const text = Buffer.concat(chunks, total).toString("utf8");
  return { status: res.status, ctype, text };
}

/** Ensure an initialized session exists for this endpoint (deduped). */
function ensureSession(url: string): Promise<void> {
  if (initialized.has(url)) return Promise.resolve();
  const existing = initInFlight.get(url);
  if (existing) return existing;
  const p = (async () => {
    try {
      const init = await fetchMcp(url, {
        jsonrpc: "2.0",
        id: nextMcpRequestId++,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "codex-harness-gateway", version: "1.0.1" } },
      });
      if (init.status >= 400) throw new Error(`MCP initialize failed: HTTP ${init.status}`);
      const handshake = parsePayload(init.ctype, init.text);
      if (!handshake?.result || handshake.error) throw new Error("MCP initialize returned an invalid response");
      await fetchMcp(url, { jsonrpc: "2.0", method: "notifications/initialized" });
      initialized.add(url);
    } catch (error) {
      sessionIds.delete(url);
      initialized.delete(url);
      throw error;
    } finally {
      initInFlight.delete(url);
    }
  })();
  initInFlight.set(url, p);
  return p;
}

/** Session-expiry statuses: the stored Mcp-Session-Id is no longer valid. */
function looksLikeSessionError(status: number): boolean {
  return status === 400 || status === 404 || status === 410;
}

function parsePayload(ctype: string, text: string): any {
  if (ctype.includes("text/event-stream")) {
    for (const block of text.split(/\n\s*\n/)) {
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (!data) continue;
      try {
        const msg = JSON.parse(data);
        if (msg?.result !== undefined || msg?.error !== undefined) return msg;
      } catch {
        /* skip */
      }
    }
    return null;
  }
  if (text.trim()) {
    try {
      return JSON.parse(text);
    } catch {
      /* non-JSON error body */
    }
  }
  return null;
}

export async function handleDynamicToolCall(params: Pick<DynamicToolCallParams, "namespace" | "tool" | "arguments">): Promise<DynamicToolCallResponse> {
  const url = isProxyableToolCall(params.namespace) ? ZHIPU_ENDPOINTS[params.namespace!] : undefined;
  if (!url) throw new Error(`no executor for tool namespace: ${params.namespace}`);

  await ensureSession(url);

  const callBody = {
    jsonrpc: "2.0",
    id: nextMcpRequestId++,
    method: "tools/call",
    params: { name: params.tool, arguments: params.arguments ?? {} },
  };

  let res = await fetchMcp(url, callBody);
  if (res.status >= 400 && looksLikeSessionError(res.status)) {
    // The session expired server-side — re-initialize once and retry.
    sessionIds.delete(url);
    initialized.delete(url);
    await ensureSession(url);
    res = await fetchMcp(url, callBody);
  }
  if (res.status >= 400) {
    throw new Error(`MCP tools/call failed: HTTP ${res.status}`);
  }

  const payload = parsePayload(res.ctype, res.text);
  if (payload?.id !== callBody.id || payload?.error || !payload?.result) {
    throw new Error("MCP tools/call returned an invalid or error response");
  }
  const content: any[] = Array.isArray(payload.result.content) ? payload.result.content : [];
  const isError = payload?.result?.isError === true;
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
    success: !isError && !!payload?.result,
  };
}
