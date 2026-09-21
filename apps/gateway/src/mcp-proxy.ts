/**
 * Handler for codex `item/tool/call` dynamic-tool server requests.
 *
 * Only the three fixed bridge namespaces are supported. Execution uses the
 * thread's native MCP connection, so project overrides, loaded credentials,
 * and server identity stay with Codex rather than a global HTTP replacement.
 */

import type { DynamicToolCallParams } from "../../../protocol/v2/DynamicToolCallParams.js";
import type { DynamicToolCallResponse } from "../../../protocol/v2/DynamicToolCallResponse.js";
import type { DynamicToolCallOutputContentItem } from "../../../protocol/v2/DynamicToolCallOutputContentItem.js";
import type { McpServerToolCallParams } from "../../../protocol/v2/McpServerToolCallParams.js";
import type { JsonValue } from "../../../protocol/serde_json/JsonValue.js";

const NATIVE_BRIDGE_NAMESPACES = new Set(["web-search-prime", "web-reader", "zread"]);

type NativeMcpRequest = (method: "mcpServer/tool/call", params: McpServerToolCallParams) => Promise<unknown>;
export interface DynamicToolCallOptions {
  signal?: AbortSignal;
  supervisor?: { request: NativeMcpRequest };
  request?: NativeMcpRequest;
}

export const DYNAMIC_TOOL_LIMITS = {
  concurrent: 4,
  argumentBytes: 1024 * 1024,
  argumentNodes: 100_000,
  argumentDepth: 64,
  toolChars: 256,
  threadIdChars: 256,
  responseContentItems: 10_000,
  responseBytes: 10 * 1024 * 1024,
} as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function validatedArguments(value: unknown): Record<string, JsonValue> {
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
  return value as Record<string, JsonValue>;
}

/** Returns true when this gateway knows how to execute the namespace. */
export function isProxyableToolCall(namespace: string | null): boolean {
  return typeof namespace === "string" && NATIVE_BRIDGE_NAMESPACES.has(namespace);
}

function enforceResponseBudget(value: unknown): void {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); }
  catch { throw new Error("MCP tools/call returned an invalid non-JSON result"); }
  if (encoded === undefined) throw new Error("MCP tools/call returned an invalid result");
  if (Buffer.byteLength(encoded) > DYNAMIC_TOOL_LIMITS.responseBytes) {
    throw new Error("MCP tools/call result exceeds the 10MiB limit");
  }
}

export async function handleDynamicToolCall(params: Pick<DynamicToolCallParams, "threadId" | "namespace" | "tool" | "arguments">, options: DynamicToolCallOptions = {}): Promise<DynamicToolCallResponse> {
  options.signal?.throwIfAborted();
  if (!isProxyableToolCall(params.namespace)) throw new Error("no executor for requested tool namespace");
  if (typeof params.threadId !== "string" || params.threadId.trim().length === 0 || params.threadId.length > DYNAMIC_TOOL_LIMITS.threadIdChars
      || /[\u0000-\u001f\u007f]/.test(params.threadId)) throw new Error("MCP thread id is invalid");
  if (typeof params.tool !== "string" || params.tool.length === 0 || params.tool.length > DYNAMIC_TOOL_LIMITS.toolChars
      || /[\u0000-\u001f\u007f]/.test(params.tool)) throw new Error("MCP tool name is invalid");
  const toolArguments = validatedArguments(params.arguments);

  const request = options.request ?? (options.supervisor ? options.supervisor.request.bind(options.supervisor) : undefined);
  if (!request) throw new Error("native MCP executor is unavailable");
  options.signal?.throwIfAborted();
  // Native requests cannot be revoked by AbortSignal. Await actual settlement
  // so cancellation does not release an in-flight engine slot prematurely.
  // In particular, never retry an ambiguous timeout or connection failure.
  const result = await request("mcpServer/tool/call", {
    threadId: params.threadId, server: params.namespace!, tool: params.tool, arguments: toolArguments,
  });
  options.signal?.throwIfAborted();
  if (!isPlainRecord(result) || !Array.isArray(result.content) || result.content.length > DYNAMIC_TOOL_LIMITS.responseContentItems
      || (result.isError !== undefined && typeof result.isError !== "boolean")) {
    throw new Error("MCP tools/call returned an invalid result schema");
  }
  enforceResponseBudget(result);
  const content: unknown[] = result.content;
  const isError = result.isError === true;
  const contentItems: DynamicToolCallOutputContentItem[] = [];
  let skipped = 0;
  for (const item of content) {
    if (!isPlainRecord(item)) { skipped += 1; continue; }
    if (item.type === "text" && typeof item.text === "string") {
      contentItems.push({ type: "inputText", text: item.text });
    } else if ((item?.type === "image" || item?.type === "audio") && typeof item.data === "string"
      && typeof item.mimeType === "string" && new RegExp(`^${item.type}/[A-Za-z0-9.+-]+$`).test(item.mimeType)
      && item.data.length > 0 && item.data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(item.data)) {
      const url = `data:${item.mimeType};base64,${item.data}`;
      contentItems.push(item.type === "image" ? { type: "inputImage", imageUrl: url } : { type: "inputAudio", audioUrl: url });
    } else if (item.type === "resource" && isPlainRecord(item.resource) && typeof item.resource.text === "string") {
      contentItems.push({ type: "inputText", text: item.resource.text });
    } else skipped += 1;
  }
  if (skipped > 0) contentItems.push({ type: "inputText", text: `(${skipped} 个不支持的内容块已省略)` });

  const response: DynamicToolCallResponse = {
    contentItems: contentItems.length > 0
      ? contentItems
      : [{ type: "inputText", text: "(empty response)" }],
    success: !isError,
  };
  enforceResponseBudget(response);
  return response;
}
