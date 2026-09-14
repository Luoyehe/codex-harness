import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CodexSupervisor,
  type SupervisorConnection,
  type SupervisorConnectionFactory,
  type SupervisorEvents,
} from "../src/codex/process.js";
import type { AppServerHandlers } from "../src/codex/rpc.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeConnection implements SupervisorConnection {
  readonly initialization = deferred<unknown>();
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  spawned = false;
  killed = false;

  constructor(readonly handlers: AppServerHandlers) {}

  spawn(): void {
    this.spawned = true;
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "initialize") return this.initialization.promise as Promise<T>;
    return Promise.resolve({ method }) as Promise<T>;
  }

  notify(method: string, params?: unknown): void {
    this.notifications.push({ method, params });
  }

  kill(): void {
    this.killed = true;
    this.handlers.onExit(null, "killed");
  }

  exit(): void {
    this.handlers.onExit(1, null);
  }
}

function makeSupervisor(eventOverrides: Partial<SupervisorEvents> = {}) {
  const connections: FakeConnection[] = [];
  const factory: SupervisorConnectionFactory = (handlers) => {
    const connection = new FakeConnection(handlers);
    connections.push(connection);
    return connection;
  };
  const events: SupervisorEvents = {
    onNotification: vi.fn(),
    onServerRequest: vi.fn(async () => ({ decision: "decline" })),
    onStateChange: vi.fn(),
    ...eventOverrides,
  };
  const supervisor = new CodexSupervisor("fake", [], {}, events, factory);
  return { supervisor, connections, events };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("CodexSupervisor connection generations", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([false, true])("hands managed loss off without publishing cleanup or admitting more work (callback throws=%s)", async (throws) => {
    const fatal = vi.fn(() => { if (throws) throw new Error("synthetic callback failure"); });
    const { supervisor, connections, events } = makeSupervisor({ onFatalConnectionLoss: fatal });
    supervisor.start();
    connections[0].initialization.resolve({});
    await flushPromises();
    vi.mocked(events.onStateChange).mockClear();
    connections[0].handlers.onTransportLost?.(new Error("app-server naturally exited"));
    connections[0].exit();
    connections[0].handlers.onTransportLost?.(new Error("late pipe close"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fatal).toHaveBeenCalledOnce();
    expect(connections).toHaveLength(1);
    expect(connections[0].killed).toBe(false);
    expect(events.onStateChange).not.toHaveBeenCalled();
    await expect(supervisor.request("model/list", {})).rejects.toThrow("stopped");
    expect(connections[0].requests.map((request) => request.method)).toEqual(["initialize"]);
  });

  it("escalates managed initialization failure before attempting inner cleanup", async () => {
    const fatal = vi.fn();
    const { supervisor, connections } = makeSupervisor({ onFatalConnectionLoss: fatal });
    supervisor.start();
    connections[0].initialization.reject(new Error("initialize failed"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fatal).toHaveBeenCalledOnce();
    expect(connections[0].killed).toBe(false);
    expect(connections).toHaveLength(1);
  });

  it("rejects a queued readiness continuation if managed loss happens before it resumes", async () => {
    const { supervisor, connections } = makeSupervisor({ onFatalConnectionLoss: vi.fn() });
    supervisor.start();
    const waiting = expect(supervisor.request("model/list", {})).rejects.toThrow("unavailable");
    // Resolve waiters synchronously, then invalidate before their microtasks.
    (supervisor as any).setState("ready");
    connections[0].handlers.onTransportLost?.(new Error("lost immediately after ready"));
    await waiting;
    expect(connections[0].requests.map((request) => request.method)).toEqual(["initialize"]);
  });

  it("blocks replacement and readiness after an unconfirmed cleanup-owner exit", async () => {
    const { supervisor, connections, events } = makeSupervisor();
    supervisor.start();
    const waiting = expect(supervisor.waitReady()).rejects.toThrow("owner killed");
    connections[0].handlers.onCleanupUnconfirmed?.(new Error("owner killed"));
    await waiting;
    connections[0].exit();
    connections[0].initialization.resolve({});
    supervisor.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(supervisor.state).toBe("blocked");
    expect(connections).toHaveLength(1);
    expect(events.onStateChange).not.toHaveBeenCalledWith("restarting");
    expect(events.onStateChange).not.toHaveBeenCalledWith("stopped");
    await expect(supervisor.request("model/list", {})).rejects.toThrow("cleanup is unconfirmed");
  });

  it("ignores every callback from a replaced connection", async () => {
    const { supervisor, connections, events } = makeSupervisor();
    supervisor.start();
    const first = connections[0];
    first.initialization.resolve({});
    await flushPromises();
    expect(supervisor.state).toBe("ready");

    first.exit();
    expect(supervisor.state).toBe("restarting");
    first.handlers.onNotification("item/started", { stale: true });
    await expect(first.handlers.onServerRequest(1, "approval", {})).rejects.toThrow(/stale/);
    expect(events.onNotification).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    const second = connections[1];
    second.initialization.resolve({});
    await flushPromises();
    expect(supervisor.state).toBe("ready");
    second.handlers.onNotification("item/started", { fresh: true });
    expect(events.onNotification).toHaveBeenCalledWith("item/started", { fresh: true });

    // A duplicate late exit from generation 1 cannot schedule generation 3.
    first.exit();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connections).toHaveLength(2);
  });

  it("cannot become ready from a late initialize response", async () => {
    const { supervisor, connections } = makeSupervisor();
    supervisor.start();
    const first = connections[0];
    first.exit();
    first.initialization.resolve({ late: true });
    await flushPromises();
    expect(supervisor.state).toBe("restarting");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(supervisor.state).toBe("starting");
    connections[1].initialization.resolve({});
    await flushPromises();
    expect(supervisor.state).toBe("ready");
  });

  it("rejects a server-request result that completes after its generation exits", async () => {
    const answer = deferred<unknown>();
    const { supervisor, connections } = makeSupervisor({
      onServerRequest: vi.fn(() => answer.promise),
    });
    supervisor.start();
    connections[0].initialization.resolve({});
    await flushPromises();

    const response = connections[0].handlers.onServerRequest(4, "item/fileChange/requestApproval", {});
    connections[0].exit();
    answer.resolve({ decision: "accept" });
    await expect(response).rejects.toThrow(/stale/);
  });

  it("rejects timed-out and stopped readiness waiters and removes them", async () => {
    const { supervisor, connections } = makeSupervisor();
    supervisor.start();
    const timedOut = supervisor.waitReady(100);
    const stopped = supervisor.waitReady(10_000);
    const timedOutAssertion = expect(timedOut).rejects.toThrow(/not ready/);
    const stoppedAssertion = expect(stopped).rejects.toThrow(/stopped/);
    await vi.advanceTimersByTimeAsync(100);
    await timedOutAssertion;

    supervisor.stop();
    await stoppedAssertion;
    connections[0].initialization.resolve({ late: true });
    await flushPromises();
    expect(supervisor.state).toBe("stopped");
  });

  it("treats repeated start calls as idempotent", () => {
    const { supervisor, connections } = makeSupervisor();
    supervisor.start();
    supervisor.start();
    expect(connections).toHaveLength(1);
  });

  it("does not restart after initialize failure until termination is confirmed", async () => {
    const { supervisor, connections } = makeSupervisor();
    supervisor.start();
    const stopped = deferred<void>();
    vi.spyOn(connections[0], "kill").mockImplementation(() => stopped.promise as any);
    connections[0].initialization.reject(new Error("initialization rejected"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connections).toHaveLength(1);
    stopped.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(connections).toHaveLength(2);
    await supervisor.stop();
  });

  it("cannot start over a stop that is still waiting for the old worker", async () => {
    const { supervisor, connections } = makeSupervisor();
    supervisor.start();
    connections[0].initialization.resolve({});
    await flushPromises();
    const stopped = deferred<void>();
    vi.spyOn(connections[0], "kill").mockImplementation(() => stopped.promise as any);
    const completion = supervisor.stop();
    supervisor.start();
    expect(connections).toHaveLength(1);
    stopped.resolve();
    await completion;
    supervisor.start();
    expect(connections).toHaveLength(2);
    await supervisor.stop();
  });

  it("waits through a restart and dispatches to the new connection", async () => {
    const { supervisor, connections } = makeSupervisor();
    supervisor.start();
    connections[0].initialization.resolve({});
    await flushPromises();
    connections[0].exit();

    const result = supervisor.request("model/list", { limit: 10 });
    await vi.advanceTimersByTimeAsync(1_000);
    connections[1].initialization.resolve({});
    await flushPromises();
    await expect(result).resolves.toEqual({ method: "model/list" });
    expect(connections[1].requests.at(-1)).toEqual({ method: "model/list", params: { limit: 10 } });
  });

  it("buffers stderr by line so credential patterns split across chunks are redacted", () => {
    const { supervisor, connections } = makeSupervisor();
    supervisor.start();
    connections[0].handlers.onStderr("Z_AI_API_");
    connections[0].handlers.onStderr("KEY=super-secret-value\nnext line\n");

    const output = vi.mocked(process.stderr.write).mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Z_AI_API_KEY=[REDACTED]");
    expect(output).toContain("next line");
    expect(output).not.toContain("super-secret-value");
  });

  it("omits an oversized stderr line instead of leaking truncated fragments", () => {
    const { supervisor, connections } = makeSupervisor();
    supervisor.start();
    connections[0].handlers.onStderr(`${"x".repeat(70 * 1024)}SENSITIVE_TAIL\nok\n`);

    const output = vi.mocked(process.stderr.write).mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("stderr line omitted");
    expect(output).toContain("ok");
    expect(output).not.toContain("SENSITIVE_TAIL");
  });
});
