import type { McpServerElicitationRequestParams } from "../../../protocol/v2/McpServerElicitationRequestParams.js";

const AUTO_APPROVED_MCP_SERVERS = new Set([
  "web-search-prime",
  "web-reader",
  "zread",
  "zai-mcp-server",
]);

/**
 * Only the fixed MCP servers installed by the Zhipu preset may bypass the
 * browser approval prompt.  The metadata marker alone is not an identity:
 * any MCP server can emit arbitrary elicitation metadata.
 */
export function shouldAutoApproveMcpElicitation(params: unknown): boolean {
  if (!params || typeof params !== "object" || Array.isArray(params)) return false;
  const request = params as Partial<McpServerElicitationRequestParams>;
  if (request.mode !== "form" && request.mode !== "openai/form") return false;
  if (typeof request.serverName !== "string" || !AUTO_APPROVED_MCP_SERVERS.has(request.serverName)) return false;
  const meta = request._meta;
  return !!meta && typeof meta === "object" && !Array.isArray(meta)
    && (meta as Record<string, unknown>).codex_approval_kind === "mcp_tool_call";
}
