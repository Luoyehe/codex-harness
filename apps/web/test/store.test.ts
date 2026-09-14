import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayNotification, GatewayServerRequest } from "../src/api/protocol";
import type { ThreadReadResponse } from "../../../protocol/v2/ThreadReadResponse";
import { agent, deferred, thread, turn } from "./fixtures";

const wire = vi.hoisted(() => ({
  generation: 1,
  state: "closed" as "closed" | "open" | "connecting",
  stateHandlers: new Set<(state: "closed" | "open" | "connecting") => void>(),
  notification: (_event: GatewayNotification) => {},
  serverRequest: (_request: GatewayServerRequest) => {},
  rpc: vi.fn(),
  respondServerRequest: vi.fn(),
}));

vi.mock("../src/api/ws", () => ({ gateway: {
  get generation() { return wire.generation; },
  get state() { return wire.state; },
  rpc: (...args: unknown[]) => wire.rpc(...args),
  request: (...args: unknown[]) => wire.rpc(...args),
  respondServerRequest: (...args: unknown[]) => wire.respondServerRequest(...args),
  onNotification(handler: typeof wire.notification) { wire.notification = handler; return () => {}; },
  setServerRequestHandler(handler: typeof wire.serverRequest) { wire.serverRequest = handler; },
  onStateChange(handler: (state: typeof wire.state) => void) { wire.stateHandlers.add(handler); handler(wire.state); return () => wire.stateHandlers.delete(handler); },
  connect() {},
} }));

let store: (typeof import("../src/store"))["useStore"];
let search = "";
const notify = (event: GatewayNotification) => wire.notification(event);
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function connection(state: typeof wire.state) {
  wire.state = state;
  for (const handler of wire.stateHandlers) handler(state);
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  wire.stateHandlers.clear(); wire.generation += 1; wire.state = "closed";
  wire.rpc.mockReset(); wire.respondServerRequest.mockReset();
  wire.rpc.mockImplementation(async (method: string, params?: { threadId?: string }) => {
    switch (method) {
      case "app/status": return { providerMode: "openai", codexState: "ready", management: { state: "idle" } };
      case "management/status": return { state: "idle" };
      case "projects/list": return { projects: [{ path: "P", addedAt: 1, lastUsedAt: 1 }] };
      case "thread/list": return { data: [], nextCursor: null };
      case "thread/read": return { thread: thread(params?.threadId ?? "T") };
      case "thread/start": return { thread: thread("new") };
      case "thread/resume": return { thread: thread(params?.threadId ?? "T") };
      case "account/read": return { account: null, requiresOpenaiAuth: true };
      case "model/list": case "mcpServerStatus/list": return { data: [], nextCursor: null };
      default: return {};
    }
  });
  vi.stubGlobal("window", { setTimeout, clearTimeout, matchMedia: () => ({ matches: false, addEventListener() {} }) });
  vi.stubGlobal("document", { documentElement: { classList: { toggle() {} } } });
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { get length() { return storage.size; }, key: (index: number) => [...storage.keys()][index] ?? null,
    getItem: (key: string) => storage.get(key) ?? null, setItem: vi.fn((key: string, value: string) => storage.set(key, value)), removeItem: vi.fn((key: string) => storage.delete(key)) });
  vi.stubGlobal("location", { href: `http://localhost/${search}`, search });
  vi.stubGlobal("history", { replaceState: vi.fn() });
  store = (await import("../src/store")).useStore;
  store.getState().bootstrap();
  store.setState({ currentProject: "P" });
});

afterEach(() => { search = ""; vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("history snapshots and lifecycle recovery", () => {
  it("loads full history when background notifications created only a partial cache", async () => {
    notify({ method: "item/completed", params: { threadId: "B", turnId: "b", completedAtMs: 0, item: agent("tail", "new") } });
    wire.rpc.mockImplementation(async (method) => ({ thread: thread("B", method === "thread/read" ? [turn("old-turn", [agent("old", "history")])] : []) }));
    await store.getState().openThread("B");
    expect(wire.rpc.mock.calls.map((call) => call[0])).toEqual(["thread/resume", "thread/read"]);
    expect(store.getState().items.B.map((item) => item.id)).toEqual(["old", "tail"]);
    expect(store.getState().historyLoaded.B).toBe(true);
  });

  it("merges completed live items and same-item streams with a late snapshot", async () => {
    const read = deferred<ThreadReadResponse>();
    wire.rpc.mockImplementation((method) => method === "thread/read" ? read.promise : Promise.resolve({}));
    const loading = store.getState().openThread("T");
    await settle();
    notify({ method: "item/started", params: { threadId: "T", turnId: "turn", startedAtMs: 0, item: agent("stream", "hello ") } });
    notify({ method: "item/agentMessage/delta", params: { threadId: "T", turnId: "turn", itemId: "stream", delta: "world" } });
    notify({ method: "item/completed", params: { threadId: "T", turnId: "turn", completedAtMs: 0, item: agent("live", "complete response") } });
    read.resolve({ thread: thread("T", [turn("turn", [agent("old", "history"), agent("stream", "hello ")])]) });
    await loading;
    expect(store.getState().items.T.map((item) => item.id)).toEqual(["old", "stream", "live"]);
    expect(store.getState().items.T.find((item) => item.id === "stream")).toMatchObject({ text: "hello world" });
  });

  it.each(["hello ", "hello world", "abcabc"])("uses canonical snapshot %s without content-based overlap guessing", async (text) => {
    const read = deferred<ThreadReadResponse>();
    wire.rpc.mockImplementation((method) => method === "thread/read" ? read.promise : Promise.resolve({}));
    const loading = store.getState().openThread("T"); await settle();
    notify({ method: "item/agentMessage/delta", params: { threadId: "T", turnId: "r", itemId: "a", delta: "world" } });
    await vi.advanceTimersByTimeAsync(120);
    read.resolve({ thread: thread("T", [turn("r", [agent("a", text)], "inProgress")]) });
    await loading;
    expect(store.getState().items.T[0]).toMatchObject({ text });
    expect(store.getState().items.T.some((item) => item.type === "errorItem" && item.message.includes("没有序号"))).toBe(true);
    notify({ method: "item/agentMessage/delta", params: { threadId: "T", turnId: "r", itemId: "a", delta: "abc" } });
    await vi.advanceTimersByTimeAsync(120);
    expect(store.getState().items.T[0]).toMatchObject({ text });
    notify({ method: "item/completed", params: { threadId: "T", turnId: "r", completedAtMs: 0, item: agent("a", "abcabcabc") } });
    expect(store.getState().items.T[0]).toMatchObject({ text: "abcabcabc" });
  });

  it("does not restore stale active state over a newer completion", async () => {
    const read = deferred<ThreadReadResponse>();
    wire.rpc.mockImplementation((method) => method === "thread/read" ? read.promise : Promise.resolve({}));
    const loading = store.getState().openThread("T"); await settle();
    notify({ method: "turn/completed", params: { threadId: "T", turn: turn("r", []) } });
    read.resolve({ thread: thread("T", [turn("r", [], "inProgress")], { status: { type: "active", activeFlags: [] } }) });
    await loading;
    expect(store.getState().turnActive.T).toBe(false);
  });

  it("keeps archived history readable when activation is rejected, without enabling send", async () => {
    wire.rpc.mockImplementation((method) => method === "thread/resume" ? Promise.reject(new Error("archived thread")) : Promise.resolve({ thread: thread("T", [turn("old", [agent("old", "archived history")])]) }));
    await store.getState().openThread("T");
    expect(store.getState().items.T[0]).toMatchObject({ text: "archived history" });
    expect(store.getState().historyLoaded.T).toBe(false); expect(store.getState().historyLoading.T).toBe(false);
    await expect(store.getState().sendTurn("do something")).rejects.toThrow("尚未完成加载");
  });

  it("restores active turn IDs and understands status objects, retries and late errors", async () => {
    wire.rpc.mockResolvedValue({ thread: thread("T", [turn("r", [], "inProgress")], { status: { type: "active", activeFlags: [] } }) });
    await store.getState().openThread("T");
    expect(store.getState().activeTurnId.T).toBe("r"); expect(store.getState().turnActive.T).toBe(true);
    notify({ method: "error", params: { threadId: "T", turnId: "r", willRetry: true, error: { message: "retry", codexErrorInfo: null, additionalDetails: null } } });
    expect(store.getState().turnActive.T).toBe(true);
    notify({ method: "error", params: { threadId: "T", turnId: "old", willRetry: false, error: { message: "old error", codexErrorInfo: null, additionalDetails: null } } });
    expect(store.getState().activeTurnId.T).toBe("r");
    notify({ method: "thread/queue/changed", params: { threadId: "T" } });
    expect(store.getState().turnActive.T).toBe(true);
    notify({ method: "thread/status/changed", params: { threadId: "T", status: { type: "idle" } } });
    expect(store.getState().turnActive.T).toBe(false); expect(store.getState().activeTurnId.T).toBeNull();
  });

  it.each(["app-server", "websocket"])("restores current history and clears derived state after %s recovery", async (kind) => {
    store.setState({ connection: "open", activeThreadId: "T", items: { T: [agent("old", "old")] }, compacting: { T: true }, plan: { T: { explanation: null, steps: [] } }, turnDiff: { T: "old diff" }, tokenUsage: { T: { total: 99, window: 100 } } });
    if (kind === "app-server") notify({ method: "appServer/stateChanged", params: { state: "ready" } });
    else { connection("closed"); connection("open"); }
    await settle();
    expect(store.getState().activeThreadId).toBe("T"); expect(store.getState().historyLoaded.T).toBe(true);
    expect(store.getState().compacting).toEqual({}); expect(store.getState().plan).toEqual({});
    expect(store.getState().turnDiff).toEqual({}); expect(store.getState().tokenUsage).toEqual({});
    expect(wire.rpc).toHaveBeenCalledWith("thread/resume", { threadId: "T" });
  });

  it("preserves the URL-selected thread on a first-browser project initialization", async () => {
    // bootstrap reads the URL before registering connection callbacks.
    vi.resetModules(); location.search = "?threadId=linked";
    wire.stateHandlers.clear(); store = (await import("../src/store")).useStore; store.getState().bootstrap();
    connection("open"); await settle();
    expect(store.getState().activeThreadId).toBe("linked");
    expect(store.getState().currentProject).toBe("P"); expect(store.getState().historyLoaded.linked).toBe(true);
  });

  it("does not let slow history steal selection or complete a deleted thread load", async () => {
    const read = deferred<ThreadReadResponse>();
    wire.rpc.mockImplementation((method) => method === "thread/read" ? read.promise : Promise.resolve({}));
    const loading = store.getState().openThread("T"); await settle();
    notify({ method: "thread/deleted", params: { threadId: "T" } });
    read.resolve({ thread: thread("T", [turn("old", [agent("old", "history")])]) }); await loading;
    expect(store.getState().activeThreadId).toBeNull(); expect(store.getState().items.T).toBeUndefined();
    wire.rpc.mockClear(); await store.getState().openThread("T"); expect(wire.rpc).not.toHaveBeenCalled();
  });
});

describe("compaction, approval and list contracts", () => {
  it("reports the newly allocated thread/operation after persistence and before delivering its turn", async () => {
    store.setState({ activeThreadId: null });
    const response = deferred<unknown>();
    const original = wire.rpc.getMockImplementation()!;
    wire.rpc.mockImplementation((method, ...args) => method === "turn/start" ? response.promise : original(method, ...args));
    const identities: Array<{ threadId: string; clientOperationId: string }> = [];
    const sending = store.getState().sendMessage("new-thread draft", undefined, identity => {
      identities.push(identity);
      expect(identity.threadId).toBe("new");
      expect(localStorage.getItem(`codex-harness-pending-operation-v1:${identity.clientOperationId}`)).toContain(identity.clientOperationId);
      expect(wire.rpc.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(0);
    });
    await settle();
    expect(identities).toHaveLength(1);
    expect(wire.rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining(identities[0]));
    store.setState({ activeThreadId: "B" });
    response.resolve({}); await sending;
    expect(store.getState().sendOperations.new).toMatchObject({ ...identities[0], state: "accepted" });
  });

  it("never binds a send operation when its durable identity cannot be saved", async () => {
    store.setState({ activeThreadId: "T", historyLoaded: { T: true } });
    vi.mocked(localStorage.setItem).mockImplementationOnce(() => { throw new Error("storage unavailable"); });
    const bound = vi.fn();
    await expect(store.getState().sendMessage("unsent", undefined, bound)).rejects.toThrow("消息未发送");
    expect(bound).not.toHaveBeenCalled(); expect(wire.rpc).not.toHaveBeenCalled();
    expect(store.getState().sendOperations.T).toBeUndefined();
  });

  it("returns exact historical operation evidence without overwriting a newer same-thread operation", async () => {
    const older = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const current = { threadId: "T", clientOperationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", state: "unknown" as const };
    store.setState({ activeThreadId: "B", sendOperations: { T: current } });
    wire.rpc.mockResolvedValueOnce({ state: "accepted" });
    expect(await store.getState().checkSendOperation("T", older)).toMatchObject({ threadId: "T", clientOperationId: older, state: "accepted" });
    expect(wire.rpc).toHaveBeenCalledExactlyOnceWith("turn/operation", { clientOperationId: older });
    expect(store.getState().sendOperations.T).toEqual(current);
  });

  it("explicitly acknowledges an unknown send without resending, deleting attachments, or claiming resolution", async () => {
    store.setState({ activeThreadId: "T", historyLoaded: { T: true } });
    wire.rpc.mockRejectedValueOnce(new Error("connection closed"));
    await expect(store.getState().sendTurn("do work", [{ name: "file.txt", path: "/upload/file.txt", kind: "file" }])).rejects.toThrow("connection closed");
    const original = store.getState().sendOperations.T.clientOperationId;
    wire.rpc.mockClear();
    expect(store.getState().acknowledgeUnknownSend("T", "wrong-operation")).toBe(false);
    expect(store.getState().acknowledgeUnknownSend("T", original)).toBe(true);
    expect(store.getState().sendOperations.T).toMatchObject({ clientOperationId: original, state: "acknowledged_unknown" });
    expect(wire.rpc).not.toHaveBeenCalled();
    expect(localStorage.getItem(localStorage.key(0)!)).toContain("acknowledged_unknown");
    vi.resetModules(); store = (await import("../src/store")).useStore;
    expect(store.getState().sendOperations.T).toMatchObject({ clientOperationId: original, state: "acknowledged_unknown" });
    await store.getState().checkSendOperation("T"); expect(wire.rpc).not.toHaveBeenCalled();
    store.setState({ activeThreadId: "T", historyLoaded: { T: true } });
    await store.getState().sendTurn("new instruction");
    expect(wire.rpc).toHaveBeenCalledExactlyOnceWith("turn/start", expect.objectContaining({ text: "new instruction", clientOperationId: expect.not.stringMatching(original) }));
  });

  it("does not let a late status response or acceptance undo explicit acknowledgment", async () => {
    store.setState({ activeThreadId: "T", historyLoaded: { T: true } });
    wire.rpc.mockRejectedValueOnce(new Error("lost response"));
    await expect(store.getState().sendTurn("old instruction")).rejects.toThrow("lost response");
    const original = store.getState().sendOperations.T.clientOperationId;
    const lookup = deferred<unknown>(); wire.rpc.mockReturnValueOnce(lookup.promise);
    const checking = store.getState().checkSendOperation("T");
    expect(store.getState().acknowledgeUnknownSend("T", original)).toBe(true);
    lookup.resolve({ state: "accepted", turnId: "old" }); await checking;
    notify({ method: "harness/turnAccepted", params: { clientOperationId: original, threadId: "T", turnId: "old", attachments: [] } });
    expect(store.getState().sendOperations.T.state).toBe("acknowledged_unknown");
  });

  it.each(["success", "failure"])("ignores stale %s from an acknowledged operation after a new operation starts", async (outcome) => {
    store.setState({ activeThreadId: "T", historyLoaded: { T: true } });
    const oldResult = deferred<unknown>(); wire.rpc.mockReturnValueOnce(oldResult.promise);
    const oldSend = store.getState().sendTurn("old").catch((error) => error);
    const original = store.getState().sendOperations.T.clientOperationId;
    expect(store.getState().acknowledgeUnknownSend("T", original)).toBe(true);
    // Model a confirmed turn completion before its admission RPC settles.
    store.setState({ turnActive: { T: false } });
    const newResult = deferred<unknown>(); wire.rpc.mockReturnValueOnce(newResult.promise);
    const newSend = store.getState().sendTurn("new");
    const replacement = store.getState().sendOperations.T.clientOperationId;
    expect(replacement).not.toBe(original);
    if (outcome === "success") oldResult.resolve({}); else oldResult.reject(new Error("old connection failed"));
    await oldSend;
    notify({ method: "harness/turnAccepted", params: { clientOperationId: original, threadId: "T", turnId: "old", attachments: [] } });
    expect(store.getState().sendOperations.T).toMatchObject({ clientOperationId: replacement, state: "unknown" });
    expect(store.getState().turnActive.T).toBe(true);
    newResult.resolve({}); await newSend;
    expect(store.getState().sendOperations.T).toMatchObject({ clientOperationId: replacement, state: "accepted" });
  });

  it("does not release an unknown send if the local acknowledgment cannot be persisted", async () => {
    store.setState({ activeThreadId: "T", historyLoaded: { T: true } });
    wire.rpc.mockRejectedValueOnce(new Error("lost response"));
    await expect(store.getState().sendTurn("instruction")).rejects.toThrow("lost response");
    const original = store.getState().sendOperations.T.clientOperationId;
    vi.mocked(localStorage.setItem).mockImplementationOnce(() => { throw new Error("quota full"); });
    expect(store.getState().acknowledgeUnknownSend("T", original)).toBe(false);
    expect(store.getState().sendOperations.T.state).toBe("unknown");
  });

  it("persists unknown operation IDs across reload and never retries a possibly accepted turn", async () => {
    store.setState({ activeThreadId: "T", historyLoaded: { T: true } });
    wire.rpc.mockRejectedValueOnce(new Error("connection closed"));
    await expect(store.getState().sendTurn("private draft", [{ name: "private.txt", path: "/private/file", kind: "file" }])).rejects.toThrow("connection closed");
    const operation = store.getState().sendOperations.T;
    expect(operation.state).toBe("unknown");
    expect(operation.clientOperationId).toMatch(/^[a-f0-9-]{36}$/);
    const persisted = localStorage.getItem(localStorage.key(0)!);
    expect(persisted).toContain(operation.clientOperationId); expect(persisted).not.toContain("private");
    await expect(store.getState().sendTurn("private draft")).rejects.toThrow("不能重复发送");
    expect(wire.rpc.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
    vi.resetModules(); store = (await import("../src/store")).useStore;
    expect(store.getState().sendOperations.T.clientOperationId).toBe(operation.clientOperationId);
    wire.rpc.mockResolvedValueOnce({ state: "accepted", threadId: "T", turnId: "r" });
    await store.getState().checkSendOperation("T");
    expect(wire.rpc).toHaveBeenLastCalledWith("turn/operation", { clientOperationId: operation.clientOperationId });
    expect(store.getState().sendOperations.T.state).toBe("accepted"); expect(localStorage.length).toBe(0);
  });

  it("retains a known acceptance even when its RPC acknowledgment is later lost", async () => {
    store.setState({ activeThreadId: "T", historyLoaded: { T: true } });
    const response = deferred<unknown>(); wire.rpc.mockReturnValueOnce(response.promise);
    const sending = store.getState().sendTurn("payload");
    const clientOperationId = store.getState().sendOperations.T.clientOperationId;
    notify({ method: "harness/turnAccepted", params: { clientOperationId, threadId: "T", turnId: "r", attachments: [] } });
    response.reject(new Error("connection closed")); await expect(sending).resolves.toBeUndefined();
    expect(store.getState().sendOperations.T.state).toBe("accepted");
  });

  it("matches generic attachment echoes by turn and operation identity, never text prefixes", async () => {
    store.setState({ activeThreadId: "T", historyLoaded: { T: true } });
    const response = deferred<unknown>(); wire.rpc.mockReturnValueOnce(response.promise);
    const attachment = { kind: "file" as const, name: "report.pdf", path: "/uploads/stable.pdf" };
    const sending = store.getState().sendTurn("", [attachment]);
    const clientOperationId = store.getState().sendOperations.T.clientOperationId;
    notify({ method: "item/started", params: { threadId: "T", turnId: "other", startedAtMs: 0, item: { type: "userMessage", id: "unrelated", clientId: null, content: [] } } });
    expect(store.getState().items.T.some((item) => item.type === "localUserMessage")).toBe(true);
    notify({ method: "item/started", params: { threadId: "T", turnId: "r", startedAtMs: 0, item: { type: "userMessage", id: "echo", clientId: null, content: [] } } });
    notify({ method: "harness/turnAccepted", params: { clientOperationId, threadId: "T", turnId: "r", attachments: [attachment] } });
    expect(store.getState().items.T.find((item) => item.id === "echo")).toMatchObject({ harnessAttachments: [attachment], clientOperationId });
    expect(store.getState().items.T.some((item) => item.type === "localUserMessage")).toBe(false);
    response.resolve({}); await sending;
  });

  it("retains attachment metadata when acceptance precedes the decorated user-message echo", async () => {
    store.setState({ activeThreadId: "T", historyLoaded: { T: true } });
    const response = deferred<unknown>(); wire.rpc.mockReturnValueOnce(response.promise);
    const attachment = { kind: "file" as const, name: "report.pdf", path: "/uploads/stable.pdf" };
    const sending = store.getState().sendTurn("", [attachment]);
    const clientOperationId = store.getState().sendOperations.T.clientOperationId;
    notify({ method: "harness/turnAccepted", params: { clientOperationId, threadId: "T", turnId: "r", attachments: [attachment] } });
    expect(store.getState().items.T.some((item) => item.type === "localUserMessage")).toBe(true);
    notify({ method: "item/started", params: { threadId: "T", turnId: "r", startedAtMs: 0,
      item: { type: "userMessage", id: "echo", clientId: null, content: [], clientOperationId, harnessAttachments: [attachment] } } } as any);
    expect(store.getState().items.T.find((item) => item.id === "echo")).toMatchObject({ harnessAttachments: [attachment], clientOperationId });
    expect(store.getState().items.T.some((item) => item.type === "localUserMessage")).toBe(false);
    response.resolve({}); await sending;
  });

  it("sends only actual display patches and does not overwrite later broadcasts with stale acknowledgments", async () => {
    const result = deferred<unknown>(); wire.rpc.mockReturnValueOnce(result.promise);
    store.getState().updateDisplay({ reasoning: false });
    expect(wire.rpc).toHaveBeenLastCalledWith("displayPrefs/set", { reasoning: false });
    notify({ method: "displayPrefs/updated", params: { ...store.getState().display, reasoning: false, commands: false } });
    result.resolve({ reasoning: false, commands: true }); await settle();
    expect(store.getState().display.commands).toBe(false);
    wire.rpc.mockRejectedValueOnce(new Error("disk full")); store.getState().updateDisplay({ webSearch: false }); await settle();
    expect(store.getState().displayError).toContain("disk full"); expect(store.getState().display.webSearch).toBe(true);
  });

  it("uses each selected model's native effort list including ultra and no inferred fallback", async () => {
    wire.rpc.mockResolvedValueOnce({ data: [
      { id: "a", supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low", isDefault: true },
      { id: "b", supportedReasoningEfforts: [{ reasoningEffort: "ultra" }, { reasoningEffort: "vendor-deep" }], defaultReasoningEffort: "ultra" },
      { id: "unknown", supportedReasoningEfforts: [] },
    ], nextCursor: null });
    await store.getState().refreshModels();
    store.setState({ activeThreadId: "T", historyLoaded: { T: true } });
    store.getState().updateSettings({ selectedModel: "b" }); store.getState().updateSettings({ selectedEffort: "ultra" });
    await store.getState().sendTurn("test");
    expect(wire.rpc).toHaveBeenLastCalledWith("turn/start", expect.objectContaining({ model: "b", effort: "ultra" }));
    store.getState().updateSettings({ selectedModel: "unknown" });
    expect(store.getState().settings.selectedEffort).toBe("");
    const { selectedModelEfforts } = await import("../src/store");
    expect(selectedModelEfforts(store.getState().models, "b")).toEqual(["ultra", "vendor-deep"]);
    expect(selectedModelEfforts(store.getState().models, "unknown")).toEqual([]);
    expect(selectedModelEfforts(store.getState().models, "")).toEqual(["low"]);
  });

  it("keeps interactive requests pending, validates answers, accepts the first response, and handles resolution", () => {
    const request: GatewayServerRequest = { method: "item/tool/requestUserInput", requestId: "input", params: { threadId: "T", turnId: "r", itemId: "i", isBlocking: true, autoResolutionMs: null,
      questions: [{ id: "choice", header: "Choose", question: "Which?", isOther: false, isSecret: false, options: [{ label: "A", description: "First" }, { label: "B", description: "Second" }] }] } };
    wire.serverRequest(request); expect(wire.respondServerRequest).not.toHaveBeenCalled(); expect(store.getState().inputRequests).toHaveLength(1);
    expect(store.getState().respondInputRequest("input", { answers: { choice: { answers: ["invalid"] } } })).toBe(false);
    wire.respondServerRequest.mockReturnValue(true);
    expect(store.getState().respondInputRequest("input", { answers: { choice: { answers: ["A"] } } })).toBe(true);
    expect(store.getState().respondInputRequest("input", { answers: { choice: { answers: ["B"] } } })).toBe(false);
    notify({ method: "serverRequest/answerRejected", params: { serverRequestId: "input", error: "Please retry" } });
    expect(store.getState().inputRequestErrors.input).toBe("Please retry");
    expect(store.getState().respondInputRequest("input", { answers: { choice: { answers: ["B"] } } })).toBe(true);
    expect(store.getState().inputRequestErrors.input).toBeUndefined();
    notify({ method: "serverRequest/resolved", params: { requestId: "input" } }); expect(store.getState().inputRequests).toHaveLength(0);
    wire.serverRequest(request); connection("closed"); expect(store.getState().inputRequests).toHaveLength(0);
    wire.serverRequest(request); expect(store.getState().inputRequests).toHaveLength(1);
  });

  it("keeps repeated stream text intact and bounds background timeline caches", async () => {
    const response = deferred<ThreadReadResponse>(); wire.rpc.mockImplementation((method) => method === "thread/read" ? response.promise : Promise.resolve({}));
    const loading = store.getState().openThread("T"); await settle();
    notify({ method: "item/started", params: { threadId: "T", turnId: "r", startedAtMs: 0, item: agent("a", "abc") } });
    notify({ method: "item/agentMessage/delta", params: { threadId: "T", turnId: "r", itemId: "a", delta: "abc" } });
    response.resolve({ thread: thread("T", [turn("r", [agent("a", "abc")], "inProgress")]) }); await loading;
    expect(store.getState().items.T[0]).toMatchObject({ text: "abcabc" });
    for (let index = 0; index < 20; index++) notify({ method: "item/completed", params: { threadId: `B${index}`, turnId: "r", completedAtMs: 0, item: agent("a", "background") } });
    expect(Object.keys(store.getState().items).length).toBeLessThanOrEqual(8);
    expect(store.getState().items.T[0]).toMatchObject({ text: "abcabc" });
  });

  it("disallows task submission during another client's management operation", async () => {
    store.setState({ activeThreadId: "T", historyLoaded: { T: true } });
    notify({ method: "management/stateChanged", params: { state: "running", operation: "catalog/sync" } });
    await expect(store.getState().sendTurn("test")).rejects.toThrow("管理操作");
    expect(wire.rpc).not.toHaveBeenCalled();
  });

  it("recovers the persisted last management failure on reconnect without replaying its mutation", async () => {
    const defaults = wire.rpc.getMockImplementation()!;
    const record = { operationId: "op", operation: "admin/provider/switch", outcome: "failed", startedAt: 1, updatedAt: 2, error: "restart helper failed" };
    wire.rpc.mockImplementation((method, ...args) => method === "management/status" ? Promise.resolve({ state: "idle", lastOperation: record }) : defaults(method, ...args));
    connection("open"); await settle();
    expect(store.getState().management.lastOperation).toEqual(record);
    connection("closed"); wire.generation++; connection("open"); await settle();
    expect(store.getState().management.lastOperation).toEqual(record);
    expect(wire.rpc.mock.calls.filter(([method]) => method === "management/status")).toHaveLength(2);
    expect(wire.rpc.mock.calls.some(([method]) => method === "admin/provider/switch")).toBe(false);
  });

  it("does not let a late management query overwrite a newer unknown notification", async () => {
    const query = deferred<unknown>(); wire.rpc.mockReturnValueOnce(query.promise);
    const checking = store.getState().refreshManagement();
    notify({ method: "management/stateChanged", params: { state: "unknown", operationId: "new", error: "worker delivery unknown" } });
    query.resolve({ state: "idle" }); await checking;
    expect(store.getState().management).toMatchObject({ state: "unknown", operationId: "new" });
    store.setState({ activeThreadId: "T", historyLoaded: { T: true } });
    await expect(store.getState().sendTurn("do not admit")).rejects.toThrow("管理操作");
  });

  it("keeps management result uncertainty on query failure without automatically retrying", async () => {
    const lastOperation = { operationId: "op", operation: "admin/catalog/sync", outcome: "unknown" as const, startedAt: 1, updatedAt: 2 };
    store.setState({ management: { state: "unknown", lastOperation } });
    wire.rpc.mockRejectedValueOnce(new Error("connection closed"));
    await store.getState().refreshManagement();
    expect(store.getState().management).toMatchObject({ state: "unknown", lastOperation });
    expect(store.getState().managementError).toContain("connection closed");
    expect(wire.rpc).toHaveBeenCalledExactlyOnceWith("management/status");
  });

  it("ignores a status query that crosses gateway generations", async () => {
    const query = deferred<unknown>(); wire.rpc.mockReturnValueOnce(query.promise);
    const checking = store.getState().refreshManagement(); wire.generation++;
    notify({ method: "management/stateChanged", params: { state: "unknown", operationId: "current" } });
    query.resolve({ state: "idle", operationId: "stale" }); await checking;
    expect(store.getState().management).toMatchObject({ state: "unknown", operationId: "current" });
  });

  it("normalizes durable no-op management results without scheduling any restart", async () => {
    const lastOperation = { operationId: "op", operation: "admin/catalog/sync", outcome: "succeeded", startedAt: 1, updatedAt: 2, changed: false, restartRequired: false };
    wire.rpc.mockResolvedValueOnce({ state: "idle", lastOperation });
    await store.getState().refreshManagement();
    expect(store.getState().management).toMatchObject({ state: "idle", lastOperation });
    expect(wire.rpc).toHaveBeenCalledExactlyOnceWith("management/status");
  });

  it("a failed optimistic send preserves another client's authoritative active turn", async () => {
    const start = deferred<unknown>();
    store.setState({ activeThreadId: "T", historyLoaded: { T: true } });
    wire.rpc.mockReturnValue(start.promise);
    const sending = store.getState().sendTurn("pending message");
    const failed = expect(sending).rejects.toThrow("synthetic send failure");
    notify({ method: "turn/started", params: { threadId: "T", turn: turn("other-tab-turn", [], "inProgress") } });
    start.reject(new Error("synthetic send failure")); await failed;
    expect(store.getState().turnActive.T).toBe(true);
    expect(store.getState().activeTurnId.T).toBe("other-tab-turn");
    expect(store.getState().items.T.some((item) => item.type === "localUserMessage")).toBe(false);
  });

  it("rolls back its own failed send and blocks overlapping optimistic sends", async () => {
    const start = deferred<unknown>();
    store.setState({ activeThreadId: "T", historyLoaded: { T: true } });
    wire.rpc.mockReturnValue(start.promise);
    const sending = store.getState().sendTurn("first");
    const failed = expect(sending).rejects.toThrow("failed");
    await expect(store.getState().sendTurn("overlap")).rejects.toThrow("正在运行");
    start.reject(new Error("failed")); await failed;
    expect(store.getState().turnActive.T).toBe(false);
  });

  it("refreshes all loaded pages and continues from the refreshed window's cursor", async () => {
    let prefix = "old";
    wire.rpc.mockImplementation(async (_method, params) => {
      const offset = Number(params.cursor ?? 0);
      return { data: Array.from({ length: 50 }, (_, i) => thread(`${prefix}-${offset + i}`)), nextCursor: String(offset + 50) };
    });
    await store.getState().refreshSessions();
    await store.getState().loadMoreSessions(); await store.getState().loadMoreSessions();
    expect(store.getState().sessions).toHaveLength(150);
    prefix = "fresh"; wire.rpc.mockClear(); await store.getState().refreshSessions();
    expect(wire.rpc.mock.calls.map(([, params]) => params.cursor ?? null)).toEqual([null, "50", "100"]);
    expect(store.getState().sessions).toHaveLength(150);
    expect(store.getState().sessions.every((session) => session.threadId.startsWith("fresh-"))).toBe(true);
    expect(store.getState().sessionCursor).toBe("150");
    await store.getState().loadMoreSessions();
    expect(wire.rpc).toHaveBeenLastCalledWith("thread/list", { limit: 50, cursor: "150", cwd: "P" });
    expect(store.getState().sessions).toHaveLength(200);
  });

  it("removes renamed or removed search results from refreshed tail pages", async () => {
    store.setState({ sessionSearch: "A", sessions: Array.from({ length: 51 }, (_, i) => ({ threadId: `old-${i}`, title: "A", updatedAt: Date.now() / 1000 })), sessionCursor: "old-tail" });
    wire.rpc.mockImplementation(async (_method, params) => ({ data: params.cursor ? [] : Array.from({ length: 50 }, (_, i) => thread(`valid-${i}`)), nextCursor: params.cursor ? null : "page-2" }));
    await store.getState().refreshSessions();
    expect(store.getState().sessions).toHaveLength(50);
    expect(store.getState().sessions.some((session) => session.threadId.startsWith("old-"))).toBe(false);
    expect(store.getState().sessionCursor).toBeNull();
  });

  it("does not publish a partial refresh when a later page fails", async () => {
    const sessions = Array.from({ length: 51 }, (_, i) => ({ threadId: `old-${i}`, title: "old", updatedAt: 1 }));
    store.setState({ sessions, sessionCursor: "old-tail" });
    wire.rpc.mockImplementation(async (_method, params) => {
      if (params.cursor) throw new Error("synthetic page failure");
      return { data: [thread("fresh")], nextCursor: "page-2" };
    });
    await store.getState().refreshSessions();
    expect(store.getState().sessions).toEqual(sessions);
    expect(store.getState().sessionCursor).toBe("old-tail");
    expect(store.getState().sessionLoading).toBe(false);
  });

  it("retains the number of loaded pages even when the server returns short pages", async () => {
    wire.rpc.mockImplementation(async (_method, params) => {
      const offset = Number(params.cursor ?? 0);
      return { data: [thread(`short-${offset}`)], nextCursor: String(offset + 1) };
    });
    await store.getState().refreshSessions();
    await store.getState().loadMoreSessions(); await store.getState().loadMoreSessions();
    wire.rpc.mockClear(); await store.getState().refreshSessions();
    expect(wire.rpc.mock.calls.map(([, params]) => params.cursor ?? null)).toEqual([null, "1", "2"]);
    expect(store.getState().sessions).toHaveLength(3);
    expect(store.getState().sessionCursor).toBe("3");
  });

  it("discards a multi-page refresh when its search context changes mid-flight", async () => {
    const secondPage = deferred<unknown>();
    store.setState({ sessionSearch: "A", sessions: Array.from({ length: 51 }, (_, i) => ({ threadId: `old-${i}`, title: "A", updatedAt: 1 })) });
    wire.rpc.mockImplementation(async (_method, params) => params.cursor ? secondPage.promise : { data: [thread("fresh-A")], nextCursor: "second" });
    const refreshing = store.getState().refreshSessions(); await settle();
    store.getState().setSessionSearch("B");
    secondPage.resolve({ data: [thread("stale-A")], nextCursor: "stale-tail" }); await refreshing;
    expect(store.getState().sessions).toEqual([]);
    expect(store.getState().sessionCursor).toBeNull();
    expect(store.getState().sessionLoading).toBe(false);
  });

  it("unlocks both manual and automatic compaction using modern completion events", async () => {
    store.setState({ activeThreadId: "T" }); await store.getState().compactThread();
    notify({ method: "item/completed", params: { threadId: "T", turnId: "c", completedAtMs: 0, item: { type: "contextCompaction", id: "c" } } });
    expect(store.getState().compacting.T).toBe(false);
    notify({ method: "thread/autoCompacting", params: { threadId: "T", usedTokens: 95, windowTokens: 100 } });
    expect(store.getState().items.T.at(-1)).toMatchObject({ type: "compactionProgress", status: "inProgress" });
    notify({ method: "thread/autoCompactFailed", params: { threadId: "T", error: "failed" } });
    expect(store.getState().items.T.find((item) => item.type === "compactionProgress")).toMatchObject({ status: "failed", message: expect.stringContaining("failed") });
  });

  it("updates patch details and streams plan text before completion", async () => {
    notify({ method: "item/started", params: { threadId: "T", turnId: "r", startedAtMs: 0, item: { id: "f", type: "fileChange", changes: [], status: "inProgress" } } });
    const changes = [{ path: "/project/file", kind: { type: "delete" as const }, diff: "- data" }];
    notify({ method: "item/fileChange/patchUpdated", params: { threadId: "T", turnId: "r", itemId: "f", changes } });
    expect(store.getState().items.T[0]).toMatchObject({ changes });
    notify({ method: "item/started", params: { threadId: "T", turnId: "r", startedAtMs: 0, item: { id: "p", type: "plan", text: "" } } });
    notify({ method: "item/plan/delta", params: { threadId: "T", turnId: "r", itemId: "p", delta: "proposed plan" } });
    await vi.advanceTimersByTimeAsync(120);
    expect(store.getState().items.T[1]).toMatchObject({ text: "proposed plan" });
  });

  it("grants exactly the permission entries displayed and can refuse them", () => {
    const permissions = { network: null, fileSystem: { read: null, write: null, entries: [{ path: { type: "path" as const, path: "/private/full-access" }, access: "write" as const }] } };
    wire.serverRequest({ method: "item/permissions/requestApproval", requestId: "req", params: { threadId: "T", turnId: "r", itemId: "p", environmentId: null, startedAtMs: 0, cwd: "P", reason: null, permissions } });
    store.getState().decideApproval("req", "accept");
    expect(wire.respondServerRequest).toHaveBeenCalledWith("req", { permissions: { fileSystem: permissions.fileSystem }, scope: "turn" });
    wire.serverRequest({ method: "item/permissions/requestApproval", requestId: "deny", params: { threadId: "T", turnId: "r", itemId: "p", environmentId: null, startedAtMs: 0, cwd: "P", reason: null, permissions } });
    store.getState().decideApproval("deny", "decline");
    expect(wire.respondServerRequest).toHaveBeenCalledWith("deny", { permissions: {}, scope: "turn" });
  });

  it("refuses to send an acceptance for unknown runtime permission scopes", () => {
    wire.serverRequest({ method: "item/permissions/requestApproval", requestId: "unknown", params: { threadId: "T", turnId: "r", itemId: "p", environmentId: null, startedAtMs: 0, cwd: "P", reason: null, permissions: { network: null, fileSystem: { read: null, write: null, entries: [{ access: "write", path: { type: "special", value: { kind: "unknown", path: "future-scope", subpath: null } } }] } } } });
    store.getState().decideApproval("unknown", "accept");
    expect(wire.respondServerRequest).not.toHaveBeenCalled(); expect(store.getState().approvals).toHaveLength(1);
    store.getState().decideApproval("unknown", "decline");
    expect(wire.respondServerRequest).toHaveBeenCalledWith("unknown", { permissions: {}, scope: "turn" });
  });

  it.each([
    "[]", "false", "0", '""',
    ...["network", "fileSystem"].flatMap((field) => [[], false, 0, ""].map((value) => JSON.stringify({ [field]: value }))),
  ])("only permits refusal for malformed runtime permission profiles %s", (serialized) => {
    wire.serverRequest({ method: "item/permissions/requestApproval", requestId: "malformed", params: {
      threadId: "T", turnId: "r", itemId: "p", environmentId: null, startedAtMs: 0, cwd: "P", reason: null,
      permissions: JSON.parse(serialized),
    } });
    store.getState().decideApproval("malformed", "accept");
    store.getState().decideApproval("malformed", "acceptForSession");
    expect(wire.respondServerRequest).not.toHaveBeenCalled();
    expect(store.getState().approvals).toHaveLength(1);
    store.getState().decideApproval("malformed", "decline");
    expect(wire.respondServerRequest).toHaveBeenCalledExactlyOnceWith("malformed", { permissions: {}, scope: "turn" });
    expect(store.getState().approvals).toHaveLength(0);
  });

  it("does not carry archived sessions into a newly-created current conversation", async () => {
    store.setState({ sessionArchived: true, sessions: [{ threadId: "archived", title: "old", updatedAt: 1 }] });
    await store.getState().newThread(); await settle();
    expect(store.getState().sessionArchived).toBe(false);
    expect(store.getState().sessions.map((session) => session.threadId)).toEqual(["new"]);
  });
});
