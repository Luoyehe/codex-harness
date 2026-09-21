import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DYNAMIC_TOOL_LIMITS } from "../src/mcp-proxy.js";

const wire = vi.hoisted(() => ({ events: null as any, request: vi.fn() }));
vi.mock("../src/codex/process.js", () => ({ CodexSupervisor: class {
  state = "ready"; request = wire.request;
  constructor(_command: unknown, _args: unknown, _env: unknown, events: unknown) { wire.events = events; }
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
  const home = mkdtempSync(path.join(tmpdir(), "engine-mcp-lifetime-")); homes.push(home);
  vi.stubEnv("CODEX_HOME", home); vi.stubEnv("CODEX_WORKSPACE", home);
  let active = 0;
  const calls: Array<{ resolve(value: unknown): void; reject(error: Error): void }> = [];
  wire.request.mockImplementation(() => {
    active++;
    return new Promise((resolve, reject) => {
      calls.push({ resolve: value => { active--; resolve(value); }, reject: error => { active--; reject(error); } });
    });
  });
  const { createEngine } = await import("../src/engine.js");
  const engine = createEngine(() => {}); engines.push(engine);
  const params = { threadId: "T", namespace: "web-reader", tool: "read", arguments: {} };
  const start = (id: number) => wire.events.onServerRequest(id, "item/tool/call", params) as Promise<unknown>;
  const cancel = (id: number) => wire.events.onNotification("serverRequest/resolved", { threadId: "T", requestId: id });
  return { engine, calls, start, cancel, active: () => active };
}

it("does not admit new native executions when cancelled requests have not settled", async () => {
  const f = await fixture();
  const limit = DYNAMIC_TOOL_LIMITS.concurrent;
  const first = Array.from({ length: limit }, (_, id) => f.start(id).catch(error => error));
  expect(f.active()).toBe(limit);
  for (let round = 0; round < 3; round++) {
    for (let id = 0; id < limit; id++) f.cancel(id);
    await expect(f.start(100 + round)).rejects.toThrow(/concurrency/);
    await expect(f.start(0)).rejects.toThrow(/duplicate/);
    expect(f.active()).toBe(limit);
    expect(wire.request).toHaveBeenCalledTimes(limit);
  }
  f.calls[0].resolve({ content: [{ type: "text", text: "cancelled output" }] });
  expect(await first[0]).toBeInstanceOf(Error);
  const replacement = f.start(100).catch(error => error);
  expect(f.active()).toBe(limit);
  await expect(f.start(101)).rejects.toThrow(/concurrency/);
  f.calls[1].reject(new Error("native server tool timeout"));
  expect(await first[1]).toMatchObject({ message: expect.stringContaining("native server tool timeout") });
  const recovered = f.start(101);
  expect(f.active()).toBe(limit);
  for (let index = 2; index < f.calls.length; index++) f.calls[index].resolve({ content: [] });
  for (const outcome of await Promise.all(first.slice(2))) expect(outcome).toBeInstanceOf(Error);
  expect(await replacement).toMatchObject({ success: true });
  expect(await recovered).toMatchObject({ success: true });
  expect(f.active()).toBe(0);
});

it("suppresses old-generation results without releasing a reused id in the replacement generation", async () => {
  const f = await fixture();
  const old = f.start(1).catch(error => error);
  wire.events.onStateChange("restarting");
  // Production transport invalidates the old native request before a ready
  // replacement. Leave its handler continuation queued to model a late finally.
  f.calls[0].resolve({ content: [{ type: "text", text: "old generation" }] });
  wire.events.onStateChange("ready");
  const replacement = Array.from({ length: DYNAMIC_TOOL_LIMITS.concurrent }, (_, index) => f.start(index + 1));
  expect(await old).toBeInstanceOf(Error);
  await expect(f.start(1)).rejects.toThrow(/duplicate/);
  await expect(f.start(100)).rejects.toThrow(/concurrency/);
  expect(f.active()).toBe(DYNAMIC_TOOL_LIMITS.concurrent);
  for (const call of f.calls.slice(1)) call.resolve({ content: [] });
  for (const result of await Promise.all(replacement)) expect(result).toMatchObject({ success: true });
  expect(f.active()).toBe(0);
});

it("suppresses an in-flight native result after engine stop", async () => {
  const f = await fixture();
  const result = f.start(1).catch(error => error);
  await f.engine.stop();
  f.calls[0].resolve({ content: [{ type: "text", text: "stopped" }] });
  expect(await result).toBeInstanceOf(Error);
  expect(f.active()).toBe(0);
  expect(wire.request).toHaveBeenCalledOnce();
});
