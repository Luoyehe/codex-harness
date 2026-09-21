import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const fixture = vi.hoisted(() => ({ events: null as any, request: vi.fn() }));
vi.mock("../src/codex/process.js", () => ({ CodexSupervisor: class {
  state = "ready";
  request = fixture.request;
  constructor(_command: string, _args: string[], _env: unknown, events: unknown) { fixture.events = events; }
  start() {}
  async stop() { fixture.events.onStateChange("stopped"); }
} }));
vi.mock("../src/mcp-proxy.js", () => ({ isProxyableToolCall: () => false, handleDynamicToolCall: vi.fn() }));
const homes: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const home of homes.splice(0)) rmSync(home, { force: true, recursive: true }); });

it("publishes the previous turn completion before sending automatic admission over the private channel", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "harness-engine-admission-")); homes.push(home);
  vi.stubEnv("CODEX_HOME", home); vi.stubEnv("CODEX_WORKSPACE", home);
  const { createEngine } = await import("../src/engine.js");
  const sequence: string[] = [];
  const engine = createEngine((_client, message) => { if (message.kind === "notification") sequence.push(message.method); }, {
    requestAutoCompaction: async () => { sequence.push("control/admission"); return {}; },
  });
  try {
    fixture.events.onNotification("turn/started", { threadId: "t", turn: { id: "normal" } });
    fixture.events.onNotification("thread/tokenUsage/updated", { threadId: "t", tokenUsage: { last: { totalTokens: 950 }, modelContextWindow: 1000 } });
    expect(sequence).not.toContain("control/admission");
    fixture.events.onNotification("turn/completed", { threadId: "t", turn: { id: "normal" } });
    expect(sequence.slice(-3)).toEqual(["turn/completed", "thread/autoCompacting", "control/admission"]);
    expect(fixture.request).not.toHaveBeenCalled();
  } finally { await engine.stop(); }
});

it("does not forward app-server collisions with gateway-reserved lifecycle notifications", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "harness-engine-reserved-")); homes.push(home);
  vi.stubEnv("CODEX_HOME", home); vi.stubEnv("CODEX_WORKSPACE", home);
  const { createEngine } = await import("../src/engine.js");
  const messages: unknown[] = [];
  const engine = createEngine((_client, message) => messages.push(message));
  try {
    for (const method of ["appServer/stateChanged", "terminal/allExited", "harness/turnAccepted", "management/stateChanged", "thread/autoCompactFailed"]) {
      fixture.events.onNotification(method, { state: "stopped", processId: "fake" });
    }
    expect(messages).toEqual([]);
  } finally { await engine.stop(); }
});
