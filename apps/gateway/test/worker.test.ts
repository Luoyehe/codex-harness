import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  callbacks: new Map<string, (...args: any[]) => void>(),
  process: {
    platform: "linux", env: { CODEX_HARNESS_MANAGED_WORKER: "1" },
    stdin: { on: vi.fn(), pause: vi.fn() },
    stdout: { on: vi.fn(), write: vi.fn(), writableLength: 0 },
    stderr: { write: vi.fn() }, on: vi.fn(), exit: vi.fn(),
  },
  engine: { start: vi.fn(), stop: vi.fn(async () => {}), dispatch: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), answer: vi.fn() },
  create: vi.fn(),
}));
vi.mock("node:process", () => ({ default: fixture.process }));
vi.mock("../src/engine.js", () => ({ createEngine: fixture.create }));
vi.mock("../src/admin.js", () => ({ redactSecrets: (value: string) => value }));

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); fixture.callbacks.clear();
  fixture.process.platform = "linux";
  fixture.process.env.CODEX_HARNESS_MANAGED_WORKER = "1";
  fixture.process.on.mockImplementation((event, callback) => { fixture.callbacks.set(event, callback); });
  fixture.create.mockReturnValue(fixture.engine);
});

it("exits the installed worker on inner loss without waiting for unverified inner cleanup", async () => {
  await import("../src/worker.js");
  expect(fixture.engine.start).toHaveBeenCalledOnce();
  fixture.create.mock.calls[0][1].onFatalConnectionLoss(new Error("synthetic failure"));
  expect(fixture.process.stdin.pause).toHaveBeenCalledOnce();
  expect(fixture.engine.stop).not.toHaveBeenCalled();
  expect(fixture.process.exit).toHaveBeenCalledWith(1);
});

it("keeps normal worker stop graceful and does not request a failure exit", async () => {
  await import("../src/worker.js");
  fixture.callbacks.get("SIGTERM")!();
  await Promise.resolve();
  expect(fixture.engine.stop).toHaveBeenCalledOnce();
  expect(fixture.process.exit).toHaveBeenCalledWith(0);
});

it.each([["linux", ""], ["win32", "1"], ["darwin", "1"]])("does not claim managed cleanup for %s development (%s)", async (platform, marker) => {
  fixture.process.platform = platform;
  fixture.process.env.CODEX_HARNESS_MANAGED_WORKER = marker;
  await import("../src/worker.js");
  expect(fixture.create.mock.calls[0][1].onFatalConnectionLoss).toBeUndefined();
});
