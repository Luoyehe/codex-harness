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
  fixture.engine.dispatch.mockReset();
  fixture.process.platform = "linux";
  fixture.process.env.CODEX_HARNESS_MANAGED_WORKER = "1";
  fixture.process.on.mockImplementation((event, callback) => { fixture.callbacks.set(event, callback); });
  fixture.process.stdin.on.mockImplementation((event, callback) => { fixture.callbacks.set(`stdin.${event}`, callback); });
  fixture.create.mockReturnValue(fixture.engine);
});

it("round-trips admission while still dispatching the nested compaction command", async () => {
  await import("../src/worker.js");
  fixture.engine.dispatch.mockResolvedValue({});
  const admitted = fixture.create.mock.calls[0][1].requestAutoCompaction("t1");
  const request = JSON.parse(fixture.process.stdout.write.mock.calls[0][0]);
  expect(request).toMatchObject({ method: "gateway/autoCompact", params: { threadId: "t1" } });
  fixture.callbacks.get("stdin.data")!(Buffer.from(JSON.stringify({ id: 7, method: "gateway/dispatch", params: { method: "thread/compact/start", params: { threadId: "t1" }, clientId: "auto-compaction" } }) + "\n"));
  await Promise.resolve();
  expect(fixture.engine.dispatch).toHaveBeenCalledWith("thread/compact/start", { threadId: "t1" }, "auto-compaction");
  expect(fixture.process.stdout.write.mock.calls.map(([line]) => JSON.parse(line))).toContainEqual({ id: 7, result: {} });
  fixture.callbacks.get("stdin.data")!(Buffer.from(JSON.stringify({ id: request.id, result: {} }) + "\n"));
  await expect(admitted).resolves.toEqual({});
});

it.each([["thread/read", 9], ["thread/resume", 9], ["thread/read", 37], ["thread/resume", 37]])("rejects oversized %s (%s MiB) before the private IPC frame without terminating the worker", async (method, mib) => {
  await import("../src/worker.js");
  fixture.engine.dispatch.mockResolvedValueOnce({ thread: { turns: [{ text: "x".repeat(Number(mib) * 1024 * 1024) }] } }).mockResolvedValueOnce({ ok: true });
  const request = (id: number) => fixture.callbacks.get("stdin.data")!(Buffer.from(JSON.stringify({ id, method: "gateway/dispatch", params: { method, params: { threadId: "synthetic" }, clientId: "test" } }) + "\n"));
  request(1);
  await Promise.resolve();
  expect(fixture.engine.stop).not.toHaveBeenCalled();
  expect(fixture.process.exit).not.toHaveBeenCalled();
  const reply = JSON.parse(fixture.process.stdout.write.mock.calls[0][0]);
  expect(reply).toMatchObject({ id: 1, error: { data: { errorCode: "RESPONSE_TOO_LARGE", delivery: "unknown" } } });
  request(2);
  await Promise.resolve();
  expect(JSON.parse(fixture.process.stdout.write.mock.calls[1][0])).toEqual({ id: 2, result: { ok: true } });
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
