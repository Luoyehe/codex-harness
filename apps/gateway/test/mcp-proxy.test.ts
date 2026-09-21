import { afterEach, expect, it, vi } from "vitest";
import { DYNAMIC_TOOL_LIMITS, handleDynamicToolCall, isProxyableToolCall } from "../src/mcp-proxy.js";

const params = { threadId: "thread-1", namespace: "web-reader", tool: "read", arguments: {} };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("accepts only the three bridge namespaces, not inherited keys or the stdio vision server", () => {
  for (const name of ["web-reader", "web-search-prime", "zread"]) expect(isProxyableToolCall(name)).toBe(true);
  for (const name of ["__proto__", "constructor", "zai-mcp-server", "other", null]) expect(isProxyableToolCall(name)).toBe(false);
});

it("executes once against the exact thread's native server without HTTP or global credentials", async () => {
  vi.stubEnv("Z_AI_API_KEY", "");
  const fetcher = vi.fn(() => { throw new Error("HTTP must not be used"); });
  vi.stubGlobal("fetch", fetcher);
  const request = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "project-local server" }] });
  const argumentsValue = { url: "https://example.invalid", options: { follow: false }, limit: 3 };
  const result = await handleDynamicToolCall({ ...params, arguments: argumentsValue }, { request });
  expect(request).toHaveBeenCalledExactlyOnceWith("mcpServer/tool/call", {
    threadId: "thread-1", server: "web-reader", tool: "read", arguments: argumentsValue,
  });
  expect(result).toEqual({ success: true, contentItems: [{ type: "inputText", text: "project-local server" }] });
  expect(fetcher).not.toHaveBeenCalled();
});

it("preserves a supplied supervisor's method receiver", async () => {
  const supervisor = {
    marker: "native",
    async request() { return { content: [{ type: "text", text: this.marker }] }; },
  };
  await expect(handleDynamicToolCall(params, { supervisor })).resolves.toMatchObject({ contentItems: [{ text: "native" }] });
});

it("requires a native executor instead of falling back to another transport", async () => {
  await expect(handleDynamicToolCall(params)).rejects.toThrow("native MCP executor is unavailable");
});

it("requires a valid thread, namespace and tool before dispatch", async () => {
  const request = vi.fn();
  for (const threadId of [undefined, "", " ", "bad\nthread", "x".repeat(DYNAMIC_TOOL_LIMITS.threadIdChars + 1)]) {
    await expect(handleDynamicToolCall({ ...params, threadId } as any, { request })).rejects.toThrow(/thread id/);
  }
  for (const tool of [undefined, "", "bad\ntool", "x".repeat(DYNAMIC_TOOL_LIMITS.toolChars + 1)]) {
    await expect(handleDynamicToolCall({ ...params, tool } as any, { request })).rejects.toThrow(/tool name/);
  }
  await expect(handleDynamicToolCall({ ...params, namespace: "constructor" }, { request })).rejects.toThrow(/namespace/);
  expect(request).not.toHaveBeenCalled();
});

it("rejects oversized, complex, deep, non-object and non-JSON arguments before dispatch", async () => {
  const request = vi.fn();
  const invoke = (argumentsValue: any) => handleDynamicToolCall({ ...params, arguments: argumentsValue }, { request });
  await expect(invoke({ text: "字".repeat(Math.ceil(DYNAMIC_TOOL_LIMITS.argumentBytes / 3)) })).rejects.toThrow(/1MiB/);
  for (const value of [[], null, "not-object", new Date()]) await expect(invoke(value)).rejects.toThrow(/plain object/);
  await expect(invoke({ value: Number.NaN })).rejects.toThrow(/non-finite/);
  await expect(invoke({ value: undefined })).rejects.toThrow(/non-JSON/);
  await expect(invoke({ values: Array(DYNAMIC_TOOL_LIMITS.argumentNodes).fill(0) })).rejects.toThrow(/complex/);
  const cyclic: any = {}; cyclic.self = cyclic;
  await expect(invoke(cyclic)).rejects.toThrow(/cycle/);
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let depth = 0; depth <= DYNAMIC_TOOL_LIMITS.argumentDepth; depth += 1) {
    const child: Record<string, unknown> = {};
    cursor.next = child; cursor = child;
  }
  await expect(invoke(root)).rejects.toThrow(/deeply nested/);
  expect(request).not.toHaveBeenCalled();
});

it("preserves mixed text/image/audio/resource output and reports unsupported blocks", async () => {
  const request = vi.fn().mockResolvedValue({ content: [
    { type: "text", text: "Figure follows" },
    { type: "image", mimeType: "image/png", data: "AAAA" },
    { type: "audio", mimeType: "audio/wav", data: "AAAA" },
    { type: "resource", resource: { text: "embedded resource" } },
    { type: "resource_link", uri: "mcp://unsupported" },
  ] });
  expect(await handleDynamicToolCall(params, { request })).toEqual({ success: true, contentItems: [
    { type: "inputText", text: "Figure follows" },
    { type: "inputImage", imageUrl: "data:image/png;base64,AAAA" },
    { type: "inputAudio", audioUrl: "data:audio/wav;base64,AAAA" },
    { type: "inputText", text: "embedded resource" },
    { type: "inputText", text: "(1 个不支持的内容块已省略)" },
  ] });
});

it("omits malformed media, resource and primitive content safely", async () => {
  const request = vi.fn().mockResolvedValue({ content: [
    null, 1, "text",
    { type: "image", mimeType: "text/html", data: "AAAA" },
    { type: "audio", mimeType: "audio/wav\n", data: "AAAA" },
    { type: "image", mimeType: "image/png", data: "A===" },
    { type: "image", mimeType: "image/png", data: "" },
    { type: "resource", resource: null },
  ] });
  await expect(handleDynamicToolCall(params, { request })).resolves.toEqual({
    success: true, contentItems: [{ type: "inputText", text: "(8 个不支持的内容块已省略)" }],
  });
});

it("maps tool errors and empty native results without retry", async () => {
  const request = vi.fn().mockResolvedValueOnce({ content: [{ type: "text", text: "denied" }], isError: true })
    .mockResolvedValueOnce({ content: [] });
  await expect(handleDynamicToolCall(params, { request })).resolves.toEqual({ success: false, contentItems: [{ type: "inputText", text: "denied" }] });
  await expect(handleDynamicToolCall(params, { request })).resolves.toEqual({ success: true, contentItems: [{ type: "inputText", text: "(empty response)" }] });
  expect(request).toHaveBeenCalledTimes(2);
});

it("rejects malformed native result schemas and excessive content arrays", async () => {
  const malformed = [null, "not-an-object", {}, { result: { content: [] } }, { content: "not-an-array" },
    { content: [], isError: "false" }, { content: Array(DYNAMIC_TOOL_LIMITS.responseContentItems + 1).fill({}) }];
  for (const result of malformed) {
    const request = vi.fn().mockResolvedValue(result);
    await expect(handleDynamicToolCall(params, { request })).rejects.toThrow(/invalid/);
    expect(request).toHaveBeenCalledTimes(1);
  }
});

it("applies the UTF-8 response budget to all native result fields", async () => {
  const request = vi.fn().mockResolvedValue({ content: [], structuredContent: { data: "字".repeat(Math.ceil(DYNAMIC_TOOL_LIMITS.responseBytes / 3)) } });
  await expect(handleDynamicToolCall(params, { request })).rejects.toThrow(/10MiB/);
  expect(request).toHaveBeenCalledTimes(1);
});

it("also bounds the mapped output when mapping adds JSON overhead", async () => {
  const result = { content: [{ type: "text", text: "" }] };
  const overhead = Buffer.byteLength(JSON.stringify(result));
  result.content[0].text = "x".repeat(DYNAMIC_TOOL_LIMITS.responseBytes - overhead);
  expect(Buffer.byteLength(JSON.stringify(result))).toBe(DYNAMIC_TOOL_LIMITS.responseBytes);
  const request = vi.fn().mockResolvedValue(result);
  await expect(handleDynamicToolCall(params, { request })).rejects.toThrow(/10MiB/);
});

it("rejects unserializable results without exposing partial content", async () => {
  const result: any = { content: [{ type: "text", text: "partial" }] }; result._meta = result;
  await expect(handleDynamicToolCall(params, { request: vi.fn().mockResolvedValue(result) })).rejects.toThrow(/non-JSON/);
});

it.each(["request timed out", "connection lost", "401", "404", "410"])("does not retry native failure: %s", async (message) => {
  const error = new Error(message);
  const request = vi.fn().mockRejectedValue(error);
  await expect(handleDynamicToolCall(params, { request })).rejects.toBe(error);
  expect(request).toHaveBeenCalledTimes(1);
});

it("does not dispatch after cancellation", async () => {
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  const request = vi.fn();
  await expect(handleDynamicToolCall(params, { request, signal: controller.signal })).rejects.toThrow("cancelled");
  expect(request).not.toHaveBeenCalled();
});

it("retains its in-flight lifetime until native settlement and suppresses cancelled output", async () => {
  const controller = new AbortController();
  let resolve!: (result: unknown) => void;
  const request = vi.fn(() => new Promise<unknown>((done) => { resolve = done; }));
  let settled = false;
  const result = handleDynamicToolCall(params, { request, signal: controller.signal });
  const observed = result.then(() => { settled = true; return "unexpected success"; }, (error) => { settled = true; return error; });
  const reason = new Error("cancelled"); controller.abort(reason);
  await Promise.resolve(); await Promise.resolve();
  expect(settled).toBe(false);
  resolve({ content: [{ type: "text", text: "stale output" }] });
  expect(await observed).toBe(reason);
  expect(request).toHaveBeenCalledTimes(1);
});

it("observes native rejection after cancellation without detaching a rejected request", async () => {
  const controller = new AbortController();
  let reject!: (reason: Error) => void;
  const request = vi.fn(() => new Promise<unknown>((_resolve, fail) => { reject = fail; }));
  const outcome = handleDynamicToolCall(params, { request, signal: controller.signal }).catch((error) => error);
  controller.abort();
  const error = new Error("native failed"); reject(error);
  expect(await outcome).toBe(error);
  expect(request).toHaveBeenCalledTimes(1);
});
