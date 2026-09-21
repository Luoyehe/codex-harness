import { describe, expect, it, vi } from "vitest";
import { shouldAutoApproveMcpElicitation } from "../src/mcp-approval.js";

describe("MCP elicitation auto approval", () => {
  const valid = {
    mode: "form",
    serverName: "web-reader",
    _meta: { codex_approval_kind: "mcp_tool_call" },
  };

  it("accepts only fixed, configured MCP server identities", () => {
    const managed = vi.fn((serverName: string) => serverName === "web-reader");
    expect(shouldAutoApproveMcpElicitation(valid, managed)).toBe(true);
    expect(shouldAutoApproveMcpElicitation({ ...valid, serverName: "attacker" }, managed)).toBe(false);
    expect(managed).toHaveBeenCalledOnce();
  });

  it("does not auto-approve URL elicitations or metadata-only requests", () => {
    const managed = vi.fn(() => true);
    expect(shouldAutoApproveMcpElicitation({ ...valid, mode: "url" }, managed)).toBe(false);
    expect(shouldAutoApproveMcpElicitation({ _meta: valid._meta }, managed)).toBe(false);
    expect(shouldAutoApproveMcpElicitation({ ...valid, _meta: null }, managed)).toBe(false);
    expect(managed).not.toHaveBeenCalled();
  });

  it("requires a fresh managed-configuration proof and fails closed when it cannot be read", () => {
    expect(shouldAutoApproveMcpElicitation(valid, () => false)).toBe(false);
    expect(shouldAutoApproveMcpElicitation(valid, () => { throw new Error("config changed"); })).toBe(false);
  });
});
