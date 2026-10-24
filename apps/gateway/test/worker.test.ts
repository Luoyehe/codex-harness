import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { AppServerConnection } from "../src/codex/rpc.js";
import { FLOW_LIMITS, WORKER_LIMITS } from "../src/flow-control.js";

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
afterEach(() => vi.useRealTimers());

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

it("retains worker bytes after the controller times out and releases only actual completion", async () => {
  const output = new PassThrough();
  fixture.process.stdout.write.mockImplementation((line: string) => output.write(line));
  let finish!: () => void;
  fixture.engine.dispatch.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ projects: [] }); }))
    .mockResolvedValue({ projects: [] });
  await import("../src/worker.js");
  const transport = new AppServerConnection("fixture", [], {}, {
    onNotification() {}, onServerRequest: async () => ({}), onExit() {}, onStderr() {},
  }, { requestTimeoutMs: 10 });
  transport.attach(new Writable({ write(chunk, _encoding, done) {
    fixture.callbacks.get("stdin.data")!(Buffer.from(chunk)); done();
  } }), output);
  vi.useFakeTimers();
  const params = { method: "projects/list", params: { ignored: "x".repeat(26 * 1024 * 1024) }, clientId: "browser" };
  try {
    const first = expect(transport.request("gateway/dispatch", params)).rejects.toMatchObject({ delivery: "unknown" });
    await vi.advanceTimersByTimeAsync(10);
    await first;
    await expect(transport.request("gateway/dispatch", params)).rejects.toMatchObject({ rpcError: { data: { delivery: "rejected" } } });
    expect(fixture.engine.dispatch).toHaveBeenCalledTimes(1);
    // Expiring the upstream waiter again must not create another byte lease.
    await vi.advanceTimersByTimeAsync(330_000);
    await expect(transport.request("gateway/dispatch", params)).rejects.toThrow("byte limit");
    expect(fixture.engine.dispatch).toHaveBeenCalledTimes(1);
    finish(); await Promise.resolve(); await Promise.resolve();
    await expect(transport.request("gateway/dispatch", params)).resolves.toEqual({ projects: [] });
    expect(fixture.engine.dispatch).toHaveBeenCalledTimes(2);
    expect(fixture.process.exit).not.toHaveBeenCalled();
  } finally {
    finish();
    await transport.kill();
    fixture.process.stdout.write.mockReset();
  }
});

it("charges the complete UTF-8 frame across chunks and leaves bytes for emergency controls", async () => {
  const pending: Array<() => void> = [];
  fixture.engine.dispatch.mockImplementation(() => new Promise(resolve => pending.push(() => resolve({}))));
  await import("../src/worker.js");
  const receive = (frame: unknown, bytes?: number, split = false) => {
    const json = JSON.stringify(frame);
    const padding = bytes === undefined ? "" : " ".repeat(bytes - Buffer.byteLength(json));
    const raw = Buffer.from(json + padding + "\n");
    const input = fixture.callbacks.get("stdin.data")!;
    if (split) { input(raw.subarray(0, 37)); input(raw.subarray(37)); }
    else input(raw);
  };
  const dispatch = (id: number, method: string) => ({ id, method: "gateway/dispatch", params: { method, params: { text: "中文" }, clientId: "browser" } });
  const ordinaryBytes = WORKER_LIMITS.incomingBytes - WORKER_LIMITS.controlIncomingBytes;
  receive(dispatch(1, "projects/list"), FLOW_LIMITS.frameBytes, true);
  receive(dispatch(2, "projects/list"), ordinaryBytes - FLOW_LIMITS.frameBytes);
  receive(dispatch(3, "projects/list"));
  receive(dispatch(4, "turn/interrupt"));
  receive(dispatch(5, "terminal/terminate"));
  receive({ id: 6, method: "gateway/disconnect", params: { clientId: "browser" } });
  receive({ id: 7, method: "gateway/answer", params: { requestId: "prompt", payload: {} } });
  await Promise.resolve();
  const replies = fixture.process.stdout.write.mock.calls.map(([line]) => JSON.parse(line));
  expect(replies).toContainEqual(expect.objectContaining({ id: 3, error: expect.objectContaining({ data: { delivery: "rejected" } }) }));
  expect(fixture.engine.dispatch.mock.calls.map(([method]) => method)).toEqual(["projects/list", "projects/list", "turn/interrupt", "terminal/terminate"]);
  expect(fixture.engine.disconnect).toHaveBeenCalledWith("browser");
  expect(fixture.engine.answer).toHaveBeenCalledWith("prompt", {}, undefined);
  for (const finish of pending) finish();
  await Promise.resolve();
});

it.each(["thread/read", "thread/resume", "thread/turns/list", "thread/items/list"].flatMap(method => [9, 37].map(mib => [method, mib] as const)))("rejects oversized %s (%s MiB) before the private IPC frame without terminating the worker", async (method, mib) => {
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
