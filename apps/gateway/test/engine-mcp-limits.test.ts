import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const fixture = vi.hoisted(() => ({ events: null as any, request: vi.fn(), tool: vi.fn() }));
vi.mock("../src/codex/process.js", () => ({ CodexSupervisor: class {
  state = "ready";
  request = fixture.request;
  constructor(_command: string, _args: string[], _env: unknown, events: unknown) { fixture.events = events; }
  start() {}
  async stop() { fixture.events.onStateChange("stopped"); }
} }));
vi.mock("../src/mcp-proxy.js", async (original) => {
  const actual = await original<typeof import("../src/mcp-proxy.js")>();
  return { ...actual, isProxyableToolCall: () => true, handleDynamicToolCall: fixture.tool };
});

const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fixture.request.mockReset();
  fixture.tool.mockReset();
  for (const home of homes.splice(0)) rmSync(home, { force: true, recursive: true });
});

it("limits concurrent dynamic MCP executions independently of generic server requests", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "harness-engine-mcp-"));
  homes.push(home);
  vi.stubEnv("CODEX_HOME", home);
  vi.stubEnv("CODEX_WORKSPACE", home);
  const finishes: Array<(value: unknown) => void> = [];
  fixture.tool.mockImplementation(() => new Promise((resolve) => finishes.push(resolve)));
  const { ProviderInfoReader } = await import("../src/provider-info.js");
  vi.spyOn(ProviderInfoReader.prototype, "isManagedZhipuMcpServer").mockReturnValue(true);
  const { createEngine } = await import("../src/engine.js");
  const { DYNAMIC_TOOL_LIMITS } = await import("../src/mcp-proxy.js");
  const engine = createEngine(() => {});
  const params = { namespace: "web-reader", tool: "read", arguments: {} };
  const running = Array.from({ length: DYNAMIC_TOOL_LIMITS.concurrent }, (_, index) =>
    fixture.events.onServerRequest(`tool-${index}`, "item/tool/call", params));
  try {
    await expect(fixture.events.onServerRequest("tool-overflow", "item/tool/call", params)).rejects.toThrow(/concurrency/);
    expect(fixture.tool).toHaveBeenCalledTimes(DYNAMIC_TOOL_LIMITS.concurrent);
    for (const finish of finishes) finish({ contentItems: [], success: true });
    await Promise.all(running);
  } finally {
    await engine.stop();
  }
});

it("rejects the fixed dynamic HTTP proxy when the active provider/config proof fails", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "harness-engine-mcp-"));
  homes.push(home);
  vi.stubEnv("CODEX_HOME", home);
  vi.stubEnv("CODEX_WORKSPACE", home);
  const { ProviderInfoReader } = await import("../src/provider-info.js");
  vi.spyOn(ProviderInfoReader.prototype, "isManagedZhipuMcpServer").mockReturnValue(false);
  const { createEngine } = await import("../src/engine.js");
  const engine = createEngine(() => {});
  try {
    await expect(fixture.events.onServerRequest("tool-untrusted", "item/tool/call", {
      namespace: "web-reader", tool: "read", arguments: {},
    })).rejects.toThrow(/active managed Zhipu/);
    expect(fixture.tool).not.toHaveBeenCalled();
  } finally {
    await engine.stop();
  }
});
