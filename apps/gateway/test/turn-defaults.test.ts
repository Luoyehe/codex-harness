import { describe, expect, it, vi } from "vitest";
import { TurnDefaults } from "../src/turn-defaults.js";
import { makeDispatcher } from "../src/api.js";

function fixture() {
  const state = { model: "base", fail: false, effort: "low" as string | null };
  let seq = 0;
  const request = vi.fn(async (method: string, params: any) => {
    if (method === "thread/read") return { thread: { cwd: "/fixture" } };
    if (method === "config/read") return { config: { model: state.model, mcp_servers: { synthetic: { command: "fixture", enabled: true } } } };
    if (method === "thread/start") {
      if (state.fail) throw new Error("fixture resolution failure");
      return { thread: { id: `lookup-${++seq}`, ephemeral: true }, model: params.model || state.model,
        approvalPolicy: "on-request", sandbox: { type: "readOnly", networkAccess: false }, reasoningEffort: state.effort };
    }
    if (method === "model/list") return { data: [{ id: state.model, model: state.model, defaultReasoningEffort: "medium" }] };
    if (method === "thread/unsubscribe") return { status: "unsubscribed" };
    throw new Error(`unexpected ${method}`);
  });
  return { state, request, defaults: new TurnDefaults({ request } as any) };
}

describe("effective turn defaults", () => {
  it("resolves actual policies, disables lookup MCP startup and unsubscribes without a turn", async () => {
    const { defaults, request } = fixture();
    expect(await defaults.resolve("thread")).toEqual({ model: "base", approvalPolicy: "on-request", sandbox: { type: "readOnly", networkAccess: false }, reasoningEffort: "low" });
    expect(request).toHaveBeenCalledWith("thread/start", { cwd: "/fixture", ephemeral: true, config: { mcp_servers: { synthetic: { command: "fixture", enabled: false } } } });
    expect(request).toHaveBeenCalledWith("thread/unsubscribe", { threadId: "lookup-1" });
    expect(request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
  });

  it("shares in-flight lookups, invalidates changed disk config and service generations", async () => {
    const { defaults, request, state } = fixture();
    await Promise.all([defaults.resolve("a"), defaults.resolve("b")]);
    expect(request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(1);
    state.model = "new-provider-model";
    expect((await defaults.resolve("a")).model).toBe(state.model);
    defaults.reset();
    await defaults.resolve("a");
    expect(request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(3);
  });

  it("invalidates account-scoped cache without skipping in-flight unsubscribe", async () => {
    const { defaults, request } = fixture();
    const original = request.getMockImplementation()!;
    let finish!: (value: unknown) => void;
    request.mockImplementation(async (method, params) => method === "thread/start"
      ? new Promise((resolve) => { finish = resolve; })
      : original(method, params));
    const stale = defaults.resolve("thread");
    await vi.waitFor(() => expect(request.mock.calls.some(([method]) => method === "thread/start")).toBe(true));
    defaults.invalidateCache();
    finish({ thread: { id: "lookup-account-old" }, model: "base", approvalPolicy: "on-request",
      sandbox: { type: "readOnly", networkAccess: false }, reasoningEffort: "low" });
    await expect(stale).rejects.toThrow(/环境已变化/);
    expect(request).toHaveBeenCalledWith("thread/unsubscribe", { threadId: "lookup-account-old" });
  });

  it.runIf(process.platform !== "win32")("rejects paths that are absolute only on another operating-system family", async () => {
    const { defaults, request } = fixture();
    const original = request.getMockImplementation()!;
    const foreign = "C:\\not-native";
    request.mockImplementation(async (method, params) => method === "thread/read"
      ? { thread: { cwd: foreign } }
      : original(method, params));
    await expect(defaults.resolve("thread")).rejects.toThrow(/当前平台/);
    expect(request.mock.calls.some(([method]) => method === "config/read")).toBe(false);
  });

  it("does not cache a failed resolution and uses model catalog effort when unset", async () => {
    const { defaults, state } = fixture();
    state.fail = true;
    await expect(defaults.resolve("a")).rejects.toThrow("fixture resolution");
    state.fail = false; state.effort = null;
    expect((await defaults.resolve("a")).reasoningEffort).toBe("medium");
  });

  it("keeps selected model while resolving that model's default effort", async () => {
    const { defaults, request } = fixture();
    expect((await defaults.resolve("a", "chosen")).model).toBe("chosen");
    expect(request.mock.calls.find(([method]) => method === "thread/start")![1].model).toBe("chosen");
  });

  it("finds configured hidden models beyond the first page and rejects cursor loops", async () => {
    const { defaults, request, state } = fixture(); state.effort = null;
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) => {
      if (method === "model/list") {
        expect(params.includeHidden).toBe(true);
        return params.cursor ? { data: [{ id: "base", model: "base", defaultReasoningEffort: "high" }], nextCursor: null }
          : { data: [], nextCursor: "second" };
      }
      return original(method, params);
    });
    expect((await defaults.resolve("a")).reasoningEffort).toBe("high");
    defaults.reset();
    request.mockImplementation(async (method, params) => method === "model/list"
      ? { data: [], nextCursor: "loop" } : original(method, params));
    await expect(defaults.resolve("a")).rejects.toThrow("游标循环");
    expect(request).toHaveBeenCalledWith("thread/unsubscribe", { threadId: "lookup-2" });

    defaults.reset();
    let pages = 0;
    request.mockImplementation(async (method, params) => method === "model/list"
      ? { data: [], nextCursor: `page-${++pages}` } : original(method, params));
    await expect(defaults.resolve("a")).rejects.toThrow("分页过多");
    expect(pages).toBe(5);
    expect(request).toHaveBeenCalledWith("thread/unsubscribe", { threadId: "lookup-3" });
  });

  it("suppresses transient lookup events but does not suppress user threads", () => {
    const { defaults } = fixture();
    expect(defaults.hideNotification("thread/started", { thread: { id: "private", ephemeral: true } })).toBe(true);
    expect(defaults.hideNotification("thread/closed", { threadId: "private" })).toBe(true);
    expect(defaults.hideNotification("thread/started", { thread: { id: "user", ephemeral: false } })).toBe(false);
    expect(defaults.hideNotification("turn/started", { threadId: "user" })).toBe(false);
    expect(defaults.hideNotification("thread/started", { thread: { id: "x".repeat(300), ephemeral: true } })).toBe(true);
    expect((defaults as any).hidden.has("x".repeat(300))).toBe(false);
  });

  it("projects baseline policies and rejects malformed or oversized upstream defaults", async () => {
    const { defaults, request } = fixture();
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) => {
      if (method === "thread/start") return {
        thread: { id: "lookup-canonical", ephemeral: true, unknown: "x".repeat(1000) },
        model: "base", approvalPolicy: "on-request",
        sandbox: { type: "readOnly", networkAccess: false, privatePadding: "x".repeat(1000) },
        reasoningEffort: "medium", privatePadding: "x".repeat(1000),
      };
      return original(method, params);
    });
    expect(await defaults.resolve("thread")).toEqual({
      model: "base", approvalPolicy: "on-request",
      sandbox: { type: "readOnly", networkAccess: false }, reasoningEffort: "medium",
    });
    defaults.reset();
    request.mockImplementation(async (method, params) => method === "thread/start"
      ? { thread: { id: "lookup-invalid" }, model: "base", approvalPolicy: "on-request", sandbox: { type: "readOnly" }, reasoningEffort: "low" }
      : original(method, params));
    await expect(defaults.resolve("thread")).rejects.toThrow(/沙箱策略/);
    expect(request).toHaveBeenCalledWith("thread/unsubscribe", { threadId: "lookup-invalid" });
    defaults.reset();
    request.mockImplementation(async (method, params) => method === "config/read"
      ? { config: { padding: "x".repeat(1024 * 1024) } }
      : original(method, params));
    await expect(defaults.resolve("thread")).rejects.toThrow(/1MiB/);
    expect(request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(2);
  });

  it("rejects malformed model catalogs instead of caching invented defaults", async () => {
    const cases = [
      { data: "not-an-array" },
      { data: [{}] },
      { data: [{ id: "base", model: "base", defaultReasoningEffort: "bad effort" }] },
      { data: [], nextCursor: "x".repeat(4097) },
      { data: Array.from({ length: 201 }, () => ({ id: "base", model: "base", defaultReasoningEffort: "low" })) },
    ];
    for (const response of cases) {
      const { defaults, request, state } = fixture();
      state.effort = null;
      const original = request.getMockImplementation()!;
      request.mockImplementation(async (method, params) => method === "model/list" ? response : original(method, params));
      await expect(defaults.resolve("thread")).rejects.toThrow();
      expect(request).toHaveBeenCalledWith("thread/unsubscribe", { threadId: "lookup-1" });
    }
  });

  it("gateway translates null to explicit values and fails closed if resolution fails", async () => {
    const request = vi.fn(async (method: string) => method === "model/list"
      ? { data: [{ id: "base", model: "base", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }], nextCursor: null }
      : { turn: { id: "t" } });
    const resolve = vi.fn(async () => ({ model: "base", approvalPolicy: "on-request", sandbox: { type: "readOnly", networkAccess: false }, reasoningEffort: "low" }));
    const dispatch = makeDispatcher({ supervisor: { request }, attachments: {}, turnDefaults: { resolve } } as any);
    await dispatch("turn/start", { threadId: "thread", text: "fixture", model: null, approvalPolicy: null, sandbox: null, effort: null });
    expect(request).toHaveBeenCalledWith("turn/start", expect.objectContaining({ model: "base", approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false }, effort: "low" }));
    resolve.mockRejectedValueOnce(new Error("defaults unavailable"));
    await expect(dispatch("turn/start", { threadId: "thread", text: "fixture", sandbox: null })).rejects.toThrow("defaults unavailable");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("restores the native default with no advertised efforts but still rejects the same explicit override", async () => {
    const request = vi.fn(async (method: string) => method === "model/list"
      ? { data: [{ id: "unprobed", model: "unprobed", defaultReasoningEffort: "medium", supportedReasoningEfforts: [] }], nextCursor: null }
      : { turn: { id: "t" } });
    const resolve = vi.fn(async () => ({ model: "unprobed", approvalPolicy: "on-request", sandbox: { type: "readOnly", networkAccess: false }, reasoningEffort: "medium" }));
    const dispatch = makeDispatcher({ supervisor: { request }, attachments: {}, turnDefaults: { resolve } } as any);
    const defaults = { threadId: "thread", text: "fixture", model: null, approvalPolicy: null, sandbox: null, effort: null };

    await dispatch("turn/start", defaults);
    expect(request).toHaveBeenCalledExactlyOnceWith("turn/start", expect.objectContaining({ model: "unprobed", effort: "medium" }));

    await expect(dispatch("turn/start", { ...defaults, effort: "medium" })).rejects.toThrow("未声明支持");
    await expect(dispatch("turn/start", { ...defaults, effort: "arbitrary-vendor-effort" })).rejects.toThrow("未声明支持");
    expect(request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
  });

  it("uses the model catalog default when the native thread effort is null and overrides are empty", async () => {
    const { defaults, request, state } = fixture();
    state.effort = null;
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) => {
      if (method === "model/list") return { data: [{ id: "base", model: "base", defaultReasoningEffort: "none", supportedReasoningEfforts: [] }], nextCursor: null };
      if (method === "turn/start") return { turn: { id: "t" } };
      return original(method, params);
    });
    const dispatch = makeDispatcher({ supervisor: { request }, attachments: {}, turnDefaults: defaults } as any);
    await dispatch("turn/start", { threadId: "thread", text: "fixture", model: null, effort: null });
    expect(request).toHaveBeenCalledWith("turn/start", expect.objectContaining({ model: "base", effort: "none" }));
  });
});
