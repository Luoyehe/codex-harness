import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const wire = vi.hoisted(() => ({ events: null as any, request: vi.fn() }));
vi.mock("../src/codex/process.js", () => ({ CodexSupervisor: class {
  state = "ready"; request = wire.request;
  constructor(_bin: unknown, _args: unknown, _env: unknown, events: unknown) { wire.events = events; }
  start() {}
  async stop() { this.state = "stopped"; wire.events.onStateChange("stopped"); }
} }));
const homes: string[] = [];
const engines: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs(); vi.resetModules(); wire.request.mockReset();
});

async function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), "engine-mcp-routing-")); homes.push(home);
  const bridge = fileURLToPath(new URL("../../../deploy/providers/zhipu-coding-plan/mcp-http-bridge.mjs", import.meta.url));
  // Even a complete official global preset cannot establish the identity of
  // a same-name server loaded earlier with a project's different settings.
  writeFileSync(path.join(home, "config.toml"), `model_provider="ZAI"
[model_providers.ZAI]
name="Zhipu Coding Plan"
base_url="https://open.bigmodel.cn/api/v1"
env_key="Z_AI_API_KEY"
wire_api="responses"
[features]
mcp_2026_07_28=true
[mcp_servers.web-reader]
type="local"
startup_timeout_sec=120
default_tools_approval_mode="approve"
command="node"
env_vars=["Z_AI_API_KEY"]
args=[${JSON.stringify(bridge)},"https://open.bigmodel.cn/api/mcp/web_reader/mcp"]
`);
  vi.stubEnv("CODEX_HOME", home); vi.stubEnv("CODEX_WORKSPACE", home);
  wire.request.mockResolvedValue({ content: [{ type: "text", text: "from the loaded project connection" }], isError: false });
  const { createEngine } = await import("../src/engine.js");
  const frames: any[] = [];
  const engine = createEngine((_id, frame) => frames.push(frame)); engines.push(engine); engine.connect("browser");
  const params = { threadId: "T", turnId: null, serverName: "web-reader", mode: "form", message: "Approve fixture tool",
    requestedSchema: { type: "object", properties: {} }, _meta: { codex_approval_kind: "mcp_tool_call" } };
  return { engine, frames, params };
}

it.each(["web-reader", "web-search-prime", "zread", "zai-mcp-server", "project-server"])(
  "requires browser approval for %s instead of trusting its name or metadata", async serverName => {
    const { engine, frames, params } = await fixture();
    const pending = wire.events.onServerRequest(1, "mcpServer/elicitation/request", { ...params, serverName });
    const prompt = frames.find(frame => frame.kind === "serverRequest");
    expect(prompt).toBeDefined();
    expect(wire.request).not.toHaveBeenCalled();
    const reply = { action: "decline", content: null, _meta: null };
    expect(engine.answer(prompt.requestId, reply)).toBe(true);
    expect(await pending).toEqual(reply);
  },
);

it("routes dynamic tools through the requested thread's native connection, not the global endpoint", async () => {
  await fixture();
  const result = await wire.events.onServerRequest(1, "item/tool/call", { threadId: "project-thread", namespace: "web-reader", tool: "read", arguments: { url: "https://example.invalid" } });
  expect(wire.request.mock.calls).toEqual([["mcpServer/tool/call", { threadId: "project-thread", server: "web-reader", tool: "read", arguments: { url: "https://example.invalid" } }]]);
  expect(result).toEqual({ contentItems: [{ type: "inputText", text: "from the loaded project connection" }], success: true });
});

it("same-batch resolution clears a prompt synchronously without reviving it later", async () => {
  const { frames, params } = await fixture();
  const pending = wire.events.onServerRequest(1, "mcpServer/elicitation/request", params);
  const rejected = expect(pending).rejects.toThrow();
  wire.events.onNotification("serverRequest/resolved", { threadId: "T", requestId: 1 });
  await rejected;
  expect(frames.filter(frame => frame.kind === "serverRequest")).toHaveLength(1);
  expect(frames.filter(frame => frame.kind === "notification" && frame.method === "serverRequest/resolved")).toHaveLength(1);
  expect(wire.request).not.toHaveBeenCalled();
});
