/**
 * Handler for codex `item/tool/call` dynamic-tool server requests.
 *
 * With the mcp_2026_07_28 client, codex wraps MCP tools as dynamic tools and
 * delegates EXECUTION to the app-server client (this gateway). The MCP
 * stdio servers it spawns are only used for discovery; a tools/call never
 * reaches them. So the gateway executes the call itself against the
 * Zhipu HTTP endpoints and shapes the reply DynamicToolCallResponse expects.
 */

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
  return !!namespace && namespace in ZHIPU_ENDPOINTS;
}

async function fetchMcp(url: string, body: unknown): Promise<{ status: number; ctype: string; text: string }> {
  const sid = sessionIds.get(url);
  const res = await fetch(url, {
    method: "POST",
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
  let text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    text = text.slice(0, MAX_RESPONSE_BYTES);
  }
  return { status: res.status, ctype, text };
}

/** Ensure an initialized session exists for this endpoint (deduped). */
function ensureSession(url: string): Promise<void> {
  if (sessionIds.has(url) || initialized.has(url)) return Promise.resolve();
  const existing = initInFlight.get(url);
  if (existing) return existing;
  const p = (async () => {
    try {
      const init = await fetchMcp(url, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "codex-harness-gateway", version: "0" } },
      });
      if (init.status >= 400) throw new Error(`MCP initialize failed: HTTP ${init.status}`);
      await fetchMcp(url, { jsonrpc: "2.0", method: "notifications/initialized" });
      initialized.add(url);
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
        if (msg.result) return msg;
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

export async function handleDynamicToolCall(params: {
  namespace: string | null;
  tool: string;
  arguments: unknown;
}): Promise<unknown> {
  const url = params.namespace ? ZHIPU_ENDPOINTS[params.namespace] : undefined;
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
    throw new Error(`MCP tools/call failed: HTTP ${res.status} ${res.text.slice(0, 200)}`);
  }

  const payload = parsePayload(res.ctype, res.text);
  const content: any[] = payload?.result?.content ?? [];
  const isError = payload?.result?.isError === true;
  const contentItems = content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => ({ type: "inputText", text: c.text }));
  // Non-text MCP content (images, resources) can't ride the inputText wire —
  // represent it explicitly instead of silently dropping it.
  const skipped = content.length - contentItems.length;

  return {
    contentItems: contentItems.length > 0
      ? contentItems
      : [{ type: "inputText", text: `${res.text.slice(0, 2000) || "(empty response)"}${skipped > 0 ? `\n(${skipped} 个非文本内容块已省略)` : ""}` }],
    success: !isError && !!payload?.result,
  };
}
