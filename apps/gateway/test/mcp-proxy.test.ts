import { afterEach, expect, it, vi } from "vitest";
import { handleDynamicToolCall, isProxyableToolCall } from "../src/mcp-proxy.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("accepts only its own configured MCP namespace keys", () => {
  expect(isProxyableToolCall("web-reader")).toBe(true);
  expect(isProxyableToolCall("__proto__")).toBe(false);
  expect(isProxyableToolCall("constructor")).toBe(false);
  expect(isProxyableToolCall(null)).toBe(false);
  // The vision server is a standard stdio MCP, not one of the HTTP bridges.
  // Do not invent a dynamic HTTP executor for it without upstream evidence.
  expect(isProxyableToolCall("zai-mcp-server")).toBe(false);
});

it("preserves mixed text/image/audio/resource output and reports unsupported blocks", async () => {
  vi.stubEnv("Z_AI_API_KEY", "test-key");
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, options: any) => {
    const request = JSON.parse(options.body);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: request.method === "tools/call" ? {
      content: [
        { type: "text", text: "Figure follows" },
        { type: "image", mimeType: "image/png", data: "AAAA" },
        { type: "audio", mimeType: "audio/wav", data: "AAAA" },
        { type: "resource", resource: { text: "embedded resource" } },
        { type: "resource_link", uri: "mcp://unsupported" },
      ],
    } : { protocolVersion: "2025-03-26", capabilities: {} } }), { headers: { "content-type": "application/json" } });
  }));
  const result = await handleDynamicToolCall({ namespace: "web-reader", tool: "read", arguments: {} });
  expect(result.success).toBe(true);
  expect(result.contentItems).toEqual([
    { type: "inputText", text: "Figure follows" },
    { type: "inputImage", imageUrl: "data:image/png;base64,AAAA" },
    { type: "inputAudio", audioUrl: "data:audio/wav;base64,AAAA" },
    { type: "inputText", text: "embedded resource" },
    { type: "inputText", text: "(1 个不支持的内容块已省略)" },
  ]);
});

it("does not treat a failed initialization with a session header as initialized", async () => {
  vi.stubEnv("Z_AI_API_KEY", "test-key");
  const fetcher = vi.fn(async (_url: unknown, options: any) => {
    const request = JSON.parse(options.body);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -1, message: "no" } }), {
      headers: { "content-type": "application/json", "mcp-session-id": "failed-session" },
    });
  });
  vi.stubGlobal("fetch", fetcher);
  for (let i = 0; i < 2; i++) {
    await expect(handleDynamicToolCall({ namespace: "zread", tool: "read", arguments: {} })).rejects.toThrow("initialize returned an invalid response");
  }
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const [, options] of fetcher.mock.calls) {
    expect(JSON.parse(options.body).method).toBe("initialize");
    expect(options.headers["Mcp-Session-Id"]).toBeUndefined();
  }
});
