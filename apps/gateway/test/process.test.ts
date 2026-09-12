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
