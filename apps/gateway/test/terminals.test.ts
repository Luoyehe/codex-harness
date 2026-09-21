import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminals } from "../src/terminals.js";
import { makeDispatcher } from "../src/api.js";

afterEach(() => vi.useRealTimers());

describe("connection-owned terminals", () => {
  it("rejects duplicate ids and cross-client controls, enforces both quotas", () => {
    const sessions = new Terminals(async () => ({}), 1, 2);
    for (const owner of ["a", "b", "c"]) sessions.connect(owner);
    const id = sessions.create("a");
    expect(() => sessions.require("b", id)).toThrow("connection");
    expect(() => sessions.create("b", id)).toThrow("already exists");
    expect(() => sessions.create("a")).toThrow("limit");
    sessions.create("b");
    expect(() => sessions.create("c")).toThrow("limit");
  });

  it("disconnect stops only that client's PTYs and prevents further creates", () => {
    const stop = vi.fn(async () => ({}));
    const sessions = new Terminals(stop);
    sessions.connect("a"); sessions.connect("b");
    const a = sessions.create("a"), b = sessions.create("b");
    sessions.disconnect("a"); sessions.disconnect("a");
    expect(stop).toHaveBeenCalledExactlyOnceWith(a);
    expect(() => sessions.create("a")).toThrow("closed");
    expect(() => sessions.require("b", b)).not.toThrow();
  });

  it("keeps uncertain termination counted and retries a disconnect failure once", async () => {
    vi.useFakeTimers();
    const stop = vi.fn().mockRejectedValueOnce(new Error("transient")).mockResolvedValue({});
    const sessions = new Terminals(stop, 1, 1);
    sessions.connect("a"); sessions.connect("b");
    const id = sessions.create("a");
    sessions.disconnect("a");
    await vi.advanceTimersByTimeAsync(1000);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(() => sessions.create("b")).toThrow("limit");
    sessions.finish(id);
    expect(() => sessions.create("b")).not.toThrow();
  });

  it("continues bounded disconnect cleanup retries until admission recovers", async () => {
    vi.useFakeTimers();
    const stop = vi.fn().mockRejectedValueOnce(new Error("full-1")).mockRejectedValueOnce(new Error("full-2")).mockResolvedValue({});
    const sessions = new Terminals(stop, 1, 1);
    sessions.connect("a"); sessions.connect("b");
    const id = sessions.create("a");
    sessions.disconnect("a");
    await vi.advanceTimersByTimeAsync(1000);
    expect(stop).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(stop).toHaveBeenCalledTimes(3);
    expect(() => sessions.create("b")).toThrow("limit");
    sessions.finish(id);
    expect(() => sessions.create("b")).not.toThrow();
  });

  it("an old exec settlement cannot remove a reused id in a new generation", () => {
    const sessions = new Terminals(async () => ({})); sessions.connect("a");
    const id = sessions.create("a"), epoch = sessions.epoch;
    sessions.reset(); sessions.create("a", id); sessions.finish(id, epoch);
    expect(() => sessions.require("a", id)).not.toThrow();
  });

  it("continues disconnect cleanup if an already pending manual termination fails", async () => {
    let reject!: (error: Error) => void;
    const stop = vi.fn().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; })).mockResolvedValue({});
    const sessions = new Terminals(stop); sessions.connect("a");
    const id = sessions.create("a");
    const terminating = sessions.terminate("a", id);
    sessions.disconnect("a"); reject(new Error("transient"));
    await expect(terminating).rejects.toThrow("transient");
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("dispatcher registers client id before exec and honors immediate failures", async () => {
    const request = vi.fn(async (method: string) => { if (method === "command/exec") throw new Error("unavailable"); return {}; });
    const notify = vi.fn();
    const sessions = new Terminals(async () => ({})); sessions.connect("browser");
    const dispatch = makeDispatcher({ supervisor: { request, state: "ready" }, projects: { resolveRegistered: () => "/fixture" },
      workspaceRoot: "/fixture", terminals: sessions, notify } as any);
    const id = "term-12345678-1234-1234-1234-123456789012";
    expect(await dispatch("terminal/exec", { processId: id }, "browser")).toEqual({ processId: id });
    await new Promise((resolve) => setImmediate(resolve));
    expect(notify).toHaveBeenCalledWith("terminal/exited", expect.objectContaining({ processId: id, error: "unavailable" }));
    expect(() => sessions.require("browser", id)).toThrow("not active");
  });

  it("projects terminal control acknowledgements and bounds deferred exit data", async () => {
    let finish!: (value: unknown) => void;
    const request = vi.fn((method: string) => method === "command/exec"
      ? new Promise((resolve) => { finish = resolve; })
      : Promise.resolve({ privatePadding: "x".repeat(100_000) }));
    const notify = vi.fn();
    const sessions = new Terminals(async (id) => request("command/exec/terminate", { id }));
    sessions.connect("browser");
    const dispatch = makeDispatcher({ supervisor: { request, state: "ready" }, projects: { resolveRegistered: () => "/fixture" },
      workspaceRoot: "/fixture", terminals: sessions, terminalOwner: "browser", notify } as any);
    const { processId } = await dispatch("terminal/exec", {}, "browser") as { processId: string };
    await expect(dispatch("terminal/write", { processId, base64: "YQ==" }, "browser")).resolves.toEqual({ ok: true });
    await expect(dispatch("terminal/resize", { processId, rows: 24, cols: 80 }, "browser")).resolves.toEqual({ ok: true });
    await expect(dispatch("terminal/terminate", { processId }, "browser")).resolves.toEqual({ ok: true });
    finish({ exitCode: { privatePadding: "x".repeat(100_000) } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(notify).toHaveBeenCalledWith("terminal/exited", { processId, exitCode: null });
  });

  it("caps an untrusted deferred terminal failure before publishing it", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "command/exec") throw new Error("e".repeat(100_000));
      return {};
    });
    const notify = vi.fn();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const sessions = new Terminals(async () => ({})); sessions.connect("browser");
    const dispatch = makeDispatcher({ supervisor: { request, state: "ready" }, projects: { resolveRegistered: () => "/fixture" },
      workspaceRoot: "/fixture", terminals: sessions, terminalOwner: "browser", notify } as any);
    try {
      await dispatch("terminal/exec", {}, "browser");
      await new Promise((resolve) => setImmediate(resolve));
      const exited = notify.mock.calls.find(([method]) => method === "terminal/exited")?.[1];
      expect(exited.error).toHaveLength(2000);
    } finally { stderr.mockRestore(); }
  });

  it("does not queue shell creation while restarting or publish an old-generation exit", async () => {
    let resolve!: (value: unknown) => void;
    const request = vi.fn(() => new Promise((done) => { resolve = done; }));
    const supervisor = { request, state: "restarting" };
    const notify = vi.fn();
    const sessions = new Terminals(async () => ({})); sessions.connect("browser");
    const dispatch = makeDispatcher({ supervisor, projects: { resolveRegistered: () => "/fixture" },
      workspaceRoot: "/fixture", terminals: sessions, notify } as any);
    await expect(dispatch("terminal/exec", {}, "browser")).rejects.toThrow("not ready");
    expect(request).not.toHaveBeenCalled();
    supervisor.state = "ready";
    const { processId } = await dispatch("terminal/exec", {}, "browser") as { processId: string };
    sessions.reset(); sessions.create("browser", processId);
    resolve({ exitCode: 0 });
    await new Promise((done) => setImmediate(done));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("terminal/started", { processId });
    expect(notify).not.toHaveBeenCalledWith("terminal/exited", expect.anything());
    expect(() => sessions.require("browser", processId)).not.toThrow();
  });
});
