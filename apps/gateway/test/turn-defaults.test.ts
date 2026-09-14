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
        approvalPolicy: "on-request", sandbox: { type: "readOnly" }, reasoningEffort: state.effort };
    }
    if (method === "model/list") return { data: [{ model: state.model, defaultReasoningEffort: "medium" }] };
    if (method === "thread/unsubscribe") return { status: "unsubscribed" };
    throw new Error(`unexpected ${method}`);
  });
  return { state, request, defaults: new TurnDefaults({ request } as any) };
}

describe("effective turn defaults", () => {
  it("resolves actual policies, disables lookup MCP startup and unsubscribes without a turn", async () => {
    const { defaults, request } = fixture();
    expect(await defaults.resolve("thread")).toEqual({ model: "base", approvalPolicy: "on-request", sandbox: { type: "readOnly" }, reasoningEffort: "low" });
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
        return params.cursor ? { data: [{ model: "base", defaultReasoningEffort: "high" }], nextCursor: null }
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
  });

  it("suppresses transient lookup events but does not suppress user threads", () => {
    const { defaults } = fixture();
    expect(defaults.hideNotification("thread/started", { thread: { id: "private", ephemeral: true } })).toBe(true);
    expect(defaults.hideNotification("thread/closed", { threadId: "private" })).toBe(true);
    expect(defaults.hideNotification("thread/started", { thread: { id: "user", ephemeral: false } })).toBe(false);
    expect(defaults.hideNotification("turn/started", { threadId: "user" })).toBe(false);
  });

  it("gateway translates null to explicit values and fails closed if resolution fails", async () => {
    const request = vi.fn(async (method: string) => method === "model/list"
      ? { data: [{ model: "base", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }], nextCursor: null }
      : { turn: { id: "t" } });
    const resolve = vi.fn(async () => ({ model: "base", approvalPolicy: "on-request", sandbox: { type: "readOnly" }, reasoningEffort: "low" }));
    const dispatch = makeDispatcher({ supervisor: { request }, attachments: {}, turnDefaults: { resolve } } as any);
    await dispatch("turn/start", { threadId: "thread", text: "fixture", model: null, approvalPolicy: null, sandbox: null, effort: null });
    expect(request).toHaveBeenCalledWith("turn/start", expect.objectContaining({ model: "base", approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly" }, effort: "low" }));
    resolve.mockRejectedValueOnce(new Error("defaults unavailable"));
    await expect(dispatch("turn/start", { threadId: "thread", text: "fixture", sandbox: null })).rejects.toThrow("defaults unavailable");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("restores the native default with no advertised efforts but still rejects the same explicit override", async () => {
    const request = vi.fn(async (method: string) => method === "model/list"
      ? { data: [{ model: "unprobed", defaultReasoningEffort: "medium", supportedReasoningEfforts: [] }], nextCursor: null }
      : { turn: { id: "t" } });
    const resolve = vi.fn(async () => ({ model: "unprobed", approvalPolicy: "on-request", sandbox: { type: "readOnly" }, reasoningEffort: "medium" }));
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
      if (method === "model/list") return { data: [{ model: "base", defaultReasoningEffort: "none", supportedReasoningEfforts: [] }], nextCursor: null };
      if (method === "turn/start") return { turn: { id: "t" } };
      return original(method, params);
    });
    const dispatch = makeDispatcher({ supervisor: { request }, attachments: {}, turnDefaults: defaults } as any);
    await dispatch("turn/start", { threadId: "thread", text: "fixture", model: null, effort: null });
    expect(request).toHaveBeenCalledWith("turn/start", expect.objectContaining({ model: "base", effort: "none" }));
  });
});
