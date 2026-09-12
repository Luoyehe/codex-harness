import { describe, expect, it } from "vitest";
import { shouldAutoApproveMcpElicitation } from "../src/mcp-approval.js";

describe("MCP elicitation auto approval", () => {
  const valid = {
    mode: "form",
    serverName: "web-reader",
    _meta: { codex_approval_kind: "mcp_tool_call" },
  };

  it("accepts only fixed, configured MCP server identities", () => {
    expect(shouldAutoApproveMcpElicitation(valid)).toBe(true);
    expect(shouldAutoApproveMcpElicitation({ ...valid, serverName: "attacker" })).toBe(false);
  });

  it("does not auto-approve URL elicitations or metadata-only requests", () => {
    expect(shouldAutoApproveMcpElicitation({ ...valid, mode: "url" })).toBe(false);
    expect(shouldAutoApproveMcpElicitation({ _meta: valid._meta })).toBe(false);
    expect(shouldAutoApproveMcpElicitation({ ...valid, _meta: null })).toBe(false);
  });
});
