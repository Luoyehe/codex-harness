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
const storageHandlers = new Set<(event: { key: string | null; newValue: string | null }) => void>();
const popstateHandlers = new Set<() => void>();
const storageEvent = (key: string, newValue: string | null) => {
  for (const handler of storageHandlers) handler({ key, newValue });
};
function connection(state: typeof wire.state) {
  wire.state = state;
  for (const handler of wire.stateHandlers) handler(state);
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  wire.stateHandlers.clear(); wire.generation += 1; wire.state = "closed";
  wire.rpc.mockReset(); wire.respondServerRequest.mockReset();
  wire.respondServerRequest.mockReturnValue(true);
  storageHandlers.clear();
  popstateHandlers.clear();
  wire.rpc.mockImplementation(async (method: string, params?: { threadId?: string; clientOperationId?: string }) => {
    switch (method) {
      case "app/status": return { providerMode: "openai", codexState: "ready", management: { state: "idle" } };
      case "management/status": return { state: "idle" };
      case "projects/list": return { projects: [{ path: "P", addedAt: 1, lastUsedAt: 1 }] };
      case "thread/list": return { data: [], nextCursor: null };
      case "thread/read": return { thread: thread(params?.threadId ?? "T") };
      case "thread/start": return { thread: thread("new"), clientOperationId: params?.clientOperationId };
      case "thread/resume": return { thread: thread(params?.threadId ?? "T") };
      case "account/read": return { account: null, requiresOpenaiAuth: true };
      case "account/login/status": return { state: "idle" };
      case "model/list": case "mcpServerStatus/list": return { data: [], nextCursor: null };
      default: return {};
    }
  });
  vi.stubGlobal("window", {
    setTimeout, clearTimeout,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener(name: string, handler: ((event: { key: string | null; newValue: string | null }) => void) | (() => void)) {
      if (name === "storage") storageHandlers.add(handler as (event: { key: string | null; newValue: string | null }) => void);
      if (name === "popstate") popstateHandlers.add(handler as () => void);
    },
  });
  vi.stubGlobal("document", { documentElement: { classList: { toggle() {} } } });
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { get length() { return storage.size; }, key: (index: number) => [...storage.keys()][index] ?? null,
    getItem: (key: string) => storage.get(key) ?? null, setItem: vi.fn((key: string, value: string) => storage.set(key, value)), removeItem: vi.fn((key: string) => storage.delete(key)) });
  vi.stubGlobal("location", { href: `http://localhost/${search}`, search });
  vi.stubGlobal("history", { replaceState: vi.fn(), pushState: vi.fn() });
  store = (await import("../src/store")).useStore;
  store.getState().bootstrap();
  store.setState({
    currentProject: "P",
    projects: [
      { path: "P", addedAt: 1, lastUsedAt: 1, available: true },
      { path: "Q", addedAt: 1, lastUsedAt: 1, available: true },
    ],
    projectsLoad: { state: "loaded", error: null },
  });
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

  it("releases an optimistic image preview when a history snapshot supplies its server echo", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const clientOperationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    store.setState({ items: { T: [{
      id: "local", type: "localUserMessage", text: "pending", threadId: "T", clientOperationId,
      attachments: [{ kind: "image", name: "preview.png", path: "/uploads/preview.png", previewUrl: "blob:preview.png" }],
    }] } });
    wire.rpc.mockImplementation(async (method) => method === "thread/read"
      ? { thread: thread("T", [turn("server-turn", [{
          type: "userMessage", id: "echo", clientId: null, content: [], clientOperationId,
        } as any])]) }
      : { thread: thread("T") });

    await store.getState().openThread("T");

    expect(store.getState().items.T.some((item) => item.type === "localUserMessage")).toBe(false);
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:preview.png");
  });

  it("releases a store-owned optimistic preview exactly once when the live server echo arrives", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    revoke.mockClear();
    store.setState({ activeThreadId: "T", historyLoaded: { T: true } });
    await store.getState().sendTurn("with image", [{ kind: "image", name: "preview.png", path: "/uploads/preview.png", previewUrl: "blob:preview.png" }]);
    const operation = store.getState().sendOperations.T;
    const echo = { type: "userMessage", id: "echo", clientId: null, content: [], clientOperationId: operation.clientOperationId } as any;

    notify({ method: "item/started", params: { threadId: "T", turnId: "server-turn", startedAtMs: 0, item: echo } });
    notify({ method: "item/completed", params: { threadId: "T", turnId: "server-turn", completedAtMs: 1, item: echo } });

    expect(store.getState().items.T.some((item) => item.type === "localUserMessage")).toBe(false);
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:preview.png");
  });

  it.each(["forget", "project", "runtime", "eviction"] as const)("releases optimistic previews on %s state removal", async removal => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    revoke.mockClear();
    store.setState({ activeThreadId: "T", historyLoaded: { T: true } });
    await store.getState().sendTurn("with image", [{ kind: "image", name: "preview.png", path: "/uploads/preview.png", previewUrl: "blob:preview.png" }]);

    if (removal === "forget") await store.getState().archiveThread("T");
    else if (removal === "project") {
      void store.getState().selectProject("Q");
      await settle();
    } else if (removal === "runtime") connection("closed");
    else {
      const optimistic = store.getState().items.T;
      store.setState({
        activeThreadId: "B0",
        items: Object.fromEntries([
          ["T", optimistic],
          ...Array.from({ length: 7 }, (_, index) => [`B${index}`, [agent(`existing-${index}`, "background")]]),
        ]),
      });
      notify({ method: "item/completed", params: { threadId: "B7", turnId: "r", completedAtMs: 7, item: agent("newest", "background") } });
      expect(store.getState().items.T).toBeUndefined();
    }

    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:preview.png");
  });

  it("reference-counts duplicate previews and never revokes a non-blob URL", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    revoke.mockClear();
    store.setState({ activeThreadId: "T", historyLoaded: { T: true } });
    await store.getState().sendTurn("duplicates", [
      { kind: "image", name: "one.png", path: "/uploads/one.png", previewUrl: "blob:shared" },
      { kind: "image", name: "two.png", path: "/uploads/two.png", previewUrl: "blob:shared" },
      { kind: "image", name: "remote.png", path: "/uploads/remote.png", previewUrl: "https://example.test/remote.png" },
    ]);

    connection("closed");

    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:shared");
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

  it("drops malformed streaming deltas instead of allocating attacker-sized reasoning arrays", async () => {
    notify({ method: "item/started", params: { threadId: "T", turnId: "r", startedAtMs: 0,
      item: { type: "reasoning", id: "reasoning", summary: [], content: [] } } });
    notify({ method: "item/reasoning/textDelta", params: {
      threadId: "T", turnId: "r", itemId: "reasoning", delta: "must not be inserted", contentIndex: 10_000,
    } } as any);
    await vi.advanceTimersByTimeAsync(120);
    expect(store.getState().items.T[0]).toMatchObject({ content: [] });

    notify({ method: "item/reasoning/summaryTextDelta", params: {
      threadId: "T", turnId: "r", itemId: "reasoning", delta: { unexpected: true }, summaryIndex: 0,
    } } as any);
    await vi.advanceTimersByTimeAsync(120);
    expect(store.getState().items.T[0]).toMatchObject({ summary: [] });
  });

  it("coalesces a full delta batch with one bounded item-index pass", () => {
    let idReads = 0;
    const items = Array.from({ length: 5_000 }, (_, index) => new Proxy(
      { type: "agentMessage", id: index === 4_999 ? "target" : `item-${index}`, text: "", phase: null },
      { get(target, key, receiver) { if (key === "id") idReads += 1; return Reflect.get(target, key, receiver); } },
    ));
    store.setState({ items: { T: items as any }, historyLoaded: { T: true } });
    idReads = 0;
    for (let index = 0; index < 512; index++) {
      notify({ method: "item/agentMessage/delta", params: { threadId: "T", turnId: "r", itemId: "target", delta: "x" } });
    }
    for (let index = 0; index < 512; index++) {
      notify({ method: "item/agentMessage/delta", params: { threadId: "T", turnId: "r", itemId: "target", delta: "x" } });
    }
    expect(idReads).toBeLessThanOrEqual(5_001);
    expect((store.getState().items.T[4_999] as { text?: string }).text).toBe("x".repeat(1_024));
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

  it("re-reads once when a terminal event overtakes an uncertain history snapshot", async () => {
    const firstRead = deferred<ThreadReadResponse>();
    const defaults = wire.rpc.getMockImplementation()!;
    let reads = 0;
    wire.rpc.mockImplementation((method: string, params?: { threadId?: string }) => {
      if (method === "thread/read" && params?.threadId === "T") {
        reads += 1;
        return reads === 1
          ? firstRead.promise
          : Promise.resolve({ thread: thread("T", [turn("r", [agent("same", "complete")])]) });
      }
      return defaults(method, params);
    });

    const loading = store.getState().openThread("T");
    await settle();
    notify({ method: "item/agentMessage/delta", params: { threadId: "T", turnId: "r", itemId: "same", delta: "uncertain" } });
    notify({ method: "turn/completed", params: { threadId: "T", turn: turn("r", []) } });
    firstRead.resolve({ thread: thread("T", [turn("r", [agent("same", "stale")], "inProgress")], { status: { type: "active", activeFlags: [] } }) });
    await loading;

    expect(reads).toBe(2);
    expect(store.getState().items.T.find((item) => item.id === "same")).toMatchObject({ text: "complete" });
    expect(store.getState().items.T.some((item) => item.type === "errorItem" && item.message.includes("没有序号"))).toBe(false);
    expect(store.getState().historyLoaded.T).toBe(true);
    expect(store.getState().turnActive.T).toBe(false);
  });

  it("rejects mismatched and malformed thread/read payloads without committing them", async () => {
    let reads = 0;
    wire.rpc.mockImplementation(async (method: string) => {
      if (method !== "thread/read") return { thread: thread("T") };
      reads += 1;
      return reads === 1
        ? { thread: thread("OTHER", [turn("wrong", [agent("wrong", "wrong conversation")])]) }
        : { thread: { ...thread("T"), turns: [{ id: "bad", status: "completed", items: "not-an-array", itemsView: "full", error: null }] } };
    });
    const loading = store.getState().openThread("T");
    await settle();
    await vi.advanceTimersByTimeAsync(400);
    await settle();
    await vi.advanceTimersByTimeAsync(800);
    await loading;

    expect(reads).toBe(3);
    expect(store.getState().items.T.some((item) => item.id === "wrong")).toBe(false);
    expect(store.getState().items.T.at(-1)).toMatchObject({ type: "errorItem", historyLoadError: true, message: expect.stringContaining("加载失败") });
    expect(store.getState().historyLoaded.T).not.toBe(true);
  });

  it("inspects only the bounded newest history items before materializing the snapshot", async () => {
    const rawItems = new Array(10_001);
    Object.defineProperty(rawItems, "0", { enumerable: true, get: () => { throw new Error("old item was inspected"); } });
    Object.defineProperty(rawItems, "1", { enumerable: true, get: () => { throw new Error("item beyond budget was inspected"); } });
    for (let index = 2; index < rawItems.length; index++) rawItems[index] = agent(`tail-${index}`, "ok");
    wire.rpc.mockImplementation(async (method) => method === "thread/read"
      ? { thread: thread("T", [turn("many", rawItems)]) }
      : { thread: thread("T") });

    await expect(store.getState().openThread("T")).resolves.toBeUndefined();
    expect(store.getState().items.T).toHaveLength(10_000);
    expect(store.getState().items.T[0]).toMatchObject({ type: "errorItem", message: expect.stringContaining("读取预算") });
    expect(store.getState().items.T.at(-1)).toMatchObject({ id: "tail-10000" });
    expect(store.getState().historyLoaded.T).toBe(true);
  });

  it("does not inspect turns older than the raw turn budget", async () => {
    const rawTurns = new Array(4_098);
    Object.defineProperty(rawTurns, "0", { enumerable: true, get: () => { throw new Error("old turn was inspected"); } });
    Object.defineProperty(rawTurns, "1", { enumerable: true, get: () => { throw new Error("turn beyond budget was inspected"); } });
    for (let index = 2; index < rawTurns.length; index++) rawTurns[index] = turn(`turn-${index}`, []);
    wire.rpc.mockImplementation(async (method) => method === "thread/read"
      ? { thread: thread("T", rawTurns) }
      : { thread: thread("T") });

    await expect(store.getState().openThread("T")).resolves.toBeUndefined();
    expect(store.getState().items.T).toHaveLength(1);
    expect(store.getState().items.T[0]).toMatchObject({ type: "errorItem", message: expect.stringContaining("读取预算") });
  });

  it("stops before an older item when the history character budget is exhausted", async () => {
    const chunk = "x".repeat(1024 * 1024);
    const rawItems = new Array(20);
    Object.defineProperty(rawItems, "0", { enumerable: true, get: () => { throw new Error("old oversized item was inspected"); } });
    for (let index = 1; index < rawItems.length; index++) rawItems[index] = agent(`large-${index}`, chunk);
    wire.rpc.mockImplementation(async (method) => method === "thread/read"
      ? { thread: thread("T", [turn("large", rawItems)]) }
      : { thread: thread("T") });

    await expect(store.getState().openThread("T")).resolves.toBeUndefined();
    expect(store.getState().items.T[0]).toMatchObject({ type: "errorItem", message: expect.stringContaining("读取预算") });
    expect(store.getState().items.T.length).toBeLessThan(20);
    expect(store.getState().items.T.at(-1)).toMatchObject({ id: "large-19" });
  });

  it("preserves failed and interrupted turn outcomes from history snapshots", async () => {
    const failed = { ...turn("failed", [agent("partial", "partial output")], "failed"), error: {
      message: "provider rejected request", codexErrorInfo: null, additionalDetails: "quota exhausted",
    } };
    const interrupted = turn("interrupted", [], "interrupted");
    wire.rpc.mockImplementation(async (method) => method === "thread/read"
      ? { thread: thread("T", [failed, interrupted]) }
      : { thread: thread("T") });
    await store.getState().openThread("T");
    expect(store.getState().items.T).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "turn-status:failed", type: "turnStatus", turnId: "failed", status: "failed", message: expect.stringContaining("quota exhausted") }),
      expect.objectContaining({ id: "turn-status:interrupted", type: "turnStatus", turnId: "interrupted", status: "interrupted" }),
    ]));
    expect(store.getState().items.T.find((item) => item.id === "partial")).toMatchObject({ turnId: "failed" });
  });

  it("renders live failed and interrupted turn completions once using their durable turn IDs", () => {
    const interrupted = turn("interrupted-live", [], "interrupted");
    notify({ method: "turn/completed", params: { threadId: "T", turn: interrupted } });
    notify({ method: "turn/completed", params: { threadId: "T", turn: interrupted } });
    const failed = { ...turn("failed-live", [], "failed"), error: {
      message: "provider failed", codexErrorInfo: null, additionalDetails: "request-id-123",
    } };
    notify({ method: "turn/completed", params: { threadId: "T", turn: failed } });
    expect(store.getState().items.T.filter((item) => item.id === "turn-status:interrupted-live")).toHaveLength(1);
    expect(store.getState().items.T.find((item) => item.id === "turn-status:failed-live")).toMatchObject({
      type: "turnStatus", status: "failed", message: expect.stringContaining("request-id-123"),
    });
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

  it("does not let an abandoned retry clear a replacement load's streaming evidence", async () => {
    const replacementRead = deferred<ThreadReadResponse>();
    const defaults = wire.rpc.getMockImplementation()!;
    let threadReads = 0;
    wire.rpc.mockImplementation((method: string, params?: { threadId?: string }) => {
      if (method === "thread/read" && params?.threadId === "T") {
        threadReads += 1;
        return threadReads === 1 ? Promise.reject(new Error("synthetic first read failure")) : replacementRead.promise;
      }
      return defaults(method, params);
    });

    const abandoned = store.getState().openThread("T");
    await settle(); // The first read is now waiting for its retry delay.
    await store.getState().openThread("B");
    const replacement = store.getState().openThread("T");
    await settle();
    notify({ method: "item/started", params: { threadId: "T", turnId: "r", startedAtMs: 0, item: agent("same", "live ") } });
    notify({ method: "item/agentMessage/delta", params: { threadId: "T", turnId: "r", itemId: "same", delta: "tail" } });
    await vi.advanceTimersByTimeAsync(500);
    await abandoned;

    replacementRead.resolve({ thread: thread("T", [turn("r", [agent("same", "snapshot")], "inProgress")]) });
    await replacement;
    expect(store.getState().items.T.find((item) => item.id === "same")).toMatchObject({ text: "live tail" });
    expect(store.getState().historyLoading.T).toBe(false);
  });

  it("invalidates paused background streams at turn completion and reloads on the next visit", async () => {
    const firstRead = deferred<ThreadReadResponse>();
    const defaults = wire.rpc.getMockImplementation()!;
    let threadReads = 0;
    wire.rpc.mockImplementation((method: string, params?: { threadId?: string }) => {
      if (method === "thread/read" && params?.threadId === "T") {
        threadReads += 1;
        return threadReads === 1 ? firstRead.promise : Promise.resolve({ thread: thread("T", [turn("r", [agent("same", "complete")])]) });
      }
      return defaults(method, params);
    });
    const loading = store.getState().openThread("T"); await settle();
    // No item/started cut: this delta is deliberately uncertain and pauses the
    // matching stream after the snapshot arrives.
    notify({ method: "item/agentMessage/delta", params: { threadId: "T", turnId: "r", itemId: "same", delta: "uncertain" } });
    await vi.advanceTimersByTimeAsync(120);
    firstRead.resolve({ thread: thread("T", [turn("r", [agent("same", "snapshot")], "inProgress")], { status: { type: "active", activeFlags: [] } }) });
    await loading;
    expect(store.getState().historyLoaded.T).toBe(true);

    await store.getState().openThread("B");
    notify({ method: "turn/completed", params: { threadId: "T", turn: turn("r", []) } });
    expect(store.getState().historyLoaded.T).toBe(false);
    wire.rpc.mockClear();
    await store.getState().openThread("T");
    expect(wire.rpc).toHaveBeenCalledWith("thread/read", { threadId: "T", includeTurns: true });
    expect(store.getState().items.T.find((item) => item.id === "same")).toMatchObject({ text: "complete" });
  });

  it("drops paused-stream ownership when a thread is forgotten", async () => {
    const read = deferred<ThreadReadResponse>();
    wire.rpc.mockImplementation((method) => method === "thread/read" ? read.promise : Promise.resolve({}));
    const loading = store.getState().openThread("T"); await settle();
    notify({ method: "item/agentMessage/delta", params: { threadId: "T", turnId: "r", itemId: "same", delta: "uncertain" } });
    await vi.advanceTimersByTimeAsync(120);
    read.resolve({ thread: thread("T", [turn("r", [agent("same", "snapshot")], "inProgress")]) });
    await loading;

    notify({ method: "thread/archived", params: { threadId: "T" } });
    // Model a later restored cache entry without starting another history load:
    // stale private pause state must not suppress its ordinary live deltas.
    store.setState({ activeThreadId: "T", items: { T: [agent("same", "restored ")] }, historyLoaded: { T: true }, historyLoading: { T: false } });
    notify({ method: "item/agentMessage/delta", params: { threadId: "T", turnId: "r2", itemId: "same", delta: "live" } });
    await vi.advanceTimersByTimeAsync(120);
    expect(store.getState().items.T[0]).toMatchObject({ text: "restored live" });
  });
});

describe("device login lifecycle", () => {
  it.each([
    [true, null],
    [false, "device authorization failed"],
  ] as const)("settles an early completion only after the matching start response (success=%s)", async (success, error) => {
    const start = deferred<unknown>();
    const defaults = wire.rpc.getMockImplementation()!;
    wire.rpc.mockImplementation((method: string, ...args: unknown[]) => method === "account/login/start"
      ? start.promise
      : defaults(method, ...args));

    const pending = store.getState().startDeviceLogin();
    notify({ method: "account/login/completed", params: {
      loginId: "login-current", success, error, onboardingEntrypoint: null,
    } });
    expect(store.getState().deviceLogin).toMatchObject({ status: "waiting" });

    start.resolve({ type: "chatgptDeviceCode", loginId: "login-current", verificationUrl: "https://auth.example.test/device", userCode: "ABCD-EFGH" });
    await pending;
    expect(store.getState().deviceLogin).toEqual(success ? null : { status: "error", error });
  });

  it("does not let another login id complete the current device flow", async () => {
    wire.rpc.mockResolvedValueOnce({ type: "chatgptDeviceCode", loginId: "login-current", verificationUrl: "https://auth.example.test/device", userCode: "ABCD-EFGH" });
    await store.getState().startDeviceLogin();
    notify({ method: "account/updated", params: { authMode: "chatgpt", planType: null } });
    expect(store.getState().deviceLogin).toMatchObject({ status: "waiting", loginId: "login-current" });
    notify({ method: "account/login/completed", params: {
      loginId: "login-other", success: true, error: null, onboardingEntrypoint: null,
    } });
    expect(store.getState().deviceLogin).toMatchObject({ status: "waiting", loginId: "login-current" });
    notify({ method: "account/login/completed", params: {
      loginId: "login-current", success: true, error: null, onboardingEntrypoint: null,
    } });
    expect(store.getState().deviceLogin).toBeNull();
  });

  it("does not consume an early completion for a different login id", async () => {
    const start = deferred<unknown>();
    const defaults = wire.rpc.getMockImplementation()!;
    wire.rpc.mockImplementation((method: string, ...args: unknown[]) => method === "account/login/start"
      ? start.promise
      : defaults(method, ...args));
    const pending = store.getState().startDeviceLogin();
    notify({ method: "account/login/completed", params: {
      loginId: "login-other", success: true, error: null, onboardingEntrypoint: null,
    } });
    start.resolve({ type: "chatgptDeviceCode", loginId: "login-current", verificationUrl: "https://auth.example.test/device", userCode: "ABCD-EFGH" });
    await pending;
    expect(store.getState().deviceLogin).toMatchObject({ status: "waiting", loginId: "login-current" });
  });

  it("keeps an unknown start outcome pending without issuing it twice", async () => {
    wire.rpc
      .mockRejectedValueOnce(Object.assign(new Error("connection closed"), { delivery: "unknown" }))
      .mockResolvedValueOnce({ state: "unknown" });
    await store.getState().startDeviceLogin();
    await settle();
    expect(store.getState().deviceLogin).toMatchObject({ status: "waiting", error: expect.stringContaining("待确认") });
    await store.getState().startDeviceLogin();
    expect(wire.rpc.mock.calls.filter(([method]) => method === "account/login/start")).toHaveLength(1);
  });

  it("cancels the exact active login and keeps an uncertain cancellation visible", async () => {
    wire.rpc.mockResolvedValueOnce({ type: "chatgptDeviceCode", loginId: "login-current", verificationUrl: "https://auth.example.test/device", userCode: "ABCD-EFGH" });
    await store.getState().startDeviceLogin();
    wire.rpc
      .mockRejectedValueOnce(Object.assign(new Error("connection closed"), { delivery: "unknown" }))
      .mockResolvedValueOnce({ state: "unknown" });
    await store.getState().cancelDeviceLogin();
    await settle();
    expect(wire.rpc.mock.calls).toContainEqual(["account/login/cancel", { loginId: "login-current" }]);
    expect(store.getState().deviceLogin).toMatchObject({ status: "waiting", loginId: "login-current", canceling: false, error: expect.stringContaining("待确认") });

    wire.rpc.mockResolvedValueOnce({ status: "notFound" });
    await store.getState().cancelDeviceLogin();
    expect(store.getState().deviceLogin).toBeNull();
  });

  it("lets a matching completion win a concurrent cancellation", async () => {
    const cancel = deferred<unknown>();
    wire.rpc.mockResolvedValueOnce({ type: "chatgptDeviceCode", loginId: "login-current", verificationUrl: "https://auth.example.test/device", userCode: "ABCD-EFGH" });
    await store.getState().startDeviceLogin();
    wire.rpc.mockReturnValueOnce(cancel.promise);
    const pending = store.getState().cancelDeviceLogin();
    expect(store.getState().deviceLogin).toMatchObject({ loginId: "login-current", canceling: true });
    notify({ method: "account/login/completed", params: {
      loginId: "login-current", success: true, error: null, onboardingEntrypoint: null,
    } });
    cancel.resolve({ status: "canceled" });
    await pending;
    expect(store.getState().deviceLogin).toBeNull();
  });

  it.each(["not_sent", "rejected"] as const)("keeps the active login after a definite %s cancellation failure", async (delivery) => {
    wire.rpc.mockResolvedValueOnce({ type: "chatgptDeviceCode", loginId: "login-current", verificationUrl: "https://auth.example.test/device", userCode: "ABCD-EFGH" });
    await store.getState().startDeviceLogin();
    wire.rpc.mockRejectedValueOnce(Object.assign(new Error("cancel refused"), { delivery }));
    await store.getState().cancelDeviceLogin();
    expect(store.getState().deviceLogin).toMatchObject({
      status: "waiting",
      loginId: "login-current",
      canceling: false,
      error: expect.stringContaining("取消失败"),
    });
  });

  it("does not let an older account refresh overwrite a newer notification", async () => {
    const older = deferred<unknown>();
    const newer = deferred<unknown>();
    wire.rpc.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    notify({ method: "account/updated", params: { authMode: "chatgpt", planType: null } });
    notify({ method: "account/updated", params: { authMode: "chatgpt", planType: null } });
    newer.resolve({ account: null, requiresOpenaiAuth: false });
    await settle();
    expect(store.getState().account?.requiresOpenaiAuth).toBe(false);
    older.resolve({ account: null, requiresOpenaiAuth: true });
    await settle();
    expect(store.getState().account?.requiresOpenaiAuth).toBe(false);
  });

  it("keeps a known login identity across a websocket reconnect", async () => {
    connection("open");
    await settle();
    wire.rpc.mockResolvedValueOnce({ type: "chatgptDeviceCode", loginId: "login-current", verificationUrl: "https://auth.example.test/device", userCode: "ABCD-EFGH" });
    await store.getState().startDeviceLogin();
    connection("closed");
    expect(store.getState().deviceLogin).toMatchObject({ status: "waiting", loginId: "login-current" });
    const defaults = wire.rpc.getMockImplementation()!;
    wire.rpc.mockImplementation((method: string, ...args: unknown[]) => method === "account/login/status"
      ? Promise.resolve({ state: "active", login: { type: "chatgptDeviceCode", loginId: "login-current", verificationUrl: "https://auth.example.test/device", userCode: "ABCD-EFGH" } })
      : defaults(method, ...args));
    connection("open");
    await settle();
    expect(store.getState().deviceLogin).toMatchObject({ status: "waiting", loginId: "login-current" });
    notify({ method: "account/login/completed", params: {
      loginId: "login-current", success: true, error: null, onboardingEntrypoint: null,
    } });
    expect(store.getState().deviceLogin).toBeNull();
  });

  it.each([
    ["active", { state: "active", login: { type: "chatgptDeviceCode", loginId: "login-restored", verificationUrl: "https://auth.example.test/device", userCode: "REST-ORED" } }],
    ["unknown", { state: "unknown" }],
  ] as const)("restores a globally %s login state on first connect", async (_label, loginStatus) => {
    const defaults = wire.rpc.getMockImplementation()!;
    wire.rpc.mockImplementation((method: string, ...args: unknown[]) => method === "account/login/status"
      ? Promise.resolve(loginStatus)
      : defaults(method, ...args));
    connection("open");
    await settle();
    expect(store.getState().deviceLogin).toMatchObject(loginStatus.state === "active"
      ? { status: "waiting", loginId: "login-restored", userCode: "REST-ORED" }
      : { status: "waiting", error: expect.stringContaining("待确认") });
    await store.getState().startDeviceLogin();
    expect(wire.rpc.mock.calls.filter(([method]) => method === "account/login/start")).toHaveLength(0);
  });

  it("does not let a status request started earlier clear a newer login attempt", async () => {
    const status = deferred<unknown>();
    const defaults = wire.rpc.getMockImplementation()!;
    wire.rpc.mockImplementation((method: string, ...args: unknown[]) => {
      if (method === "account/login/status") return status.promise;
      if (method === "account/login/start") return Promise.resolve({ type: "chatgptDeviceCode", loginId: "login-current", verificationUrl: "https://auth.example.test/device", userCode: "ABCD-EFGH" });
      return defaults(method, ...args);
    });
    connection("open");
    await settle();
    expect(wire.rpc.mock.calls.some(([method]) => method === "account/login/status")).toBe(true);
    await store.getState().startDeviceLogin();
    status.resolve({ state: "idle" });
    await settle();
    expect(store.getState().deviceLogin).toMatchObject({ status: "waiting", loginId: "login-current" });
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

  it("replaces the cross-tab operation snapshot so removed records do not survive locally", () => {
    const operation = { threadId: "T", clientOperationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "unknown" as const };
    const key = `codex-harness-pending-operation-v1:${operation.clientOperationId}`;
    localStorage.setItem(key, JSON.stringify(operation));
    store.setState({ sendOperations: { T: operation } });
    localStorage.removeItem(key);
    storageEvent(key, null);
    expect(store.getState().sendOperations.T).toBeUndefined();
  });

  it("releases a missed same-thread acknowledgment before adopting its newer operation snapshot", () => {
    const old = { threadId: "T", clientOperationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "unknown" as const };
    const replacement = { threadId: "T", clientOperationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", state: "unknown" as const };
    const oldKey = `codex-harness-pending-operation-v1:${old.clientOperationId}`;
    const replacementKey = `codex-harness-pending-operation-v1:${replacement.clientOperationId}`;
    localStorage.setItem(oldKey, JSON.stringify(old));
    store.setState({ sendOperations: { T: old } });
    const observed: string[] = [];
    const unsubscribe = store.subscribe((state) => {
      const operation = state.sendOperationRecords[old.clientOperationId];
      if (operation) observed.push(`${operation.clientOperationId}:${operation.state}`);
    });
    // The acknowledgment event was missed. The subsequent new-operation event
    // arrives before the sender removes the old acknowledged record.
    localStorage.setItem(oldKey, JSON.stringify({ ...old, state: "acknowledged_unknown" }));
    localStorage.setItem(replacementKey, JSON.stringify(replacement));
    storageEvent(replacementKey, JSON.stringify(replacement));
    unsubscribe();
    expect(observed).toContain(`${old.clientOperationId}:acknowledged_unknown`);
    expect(store.getState().sendOperations.T).toEqual(replacement);
    expect(wire.rpc).not.toHaveBeenCalledWith("turn/start", expect.anything());
  });

  it("releases a captured old draft when both its acknowledgment event and acknowledged key were missed", () => {
    const old = { threadId: "T", clientOperationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "unknown" as const };
    const replacement = { threadId: "T", clientOperationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", state: "unknown" as const };
    const oldKey = `codex-harness-pending-operation-v1:${old.clientOperationId}`;
    const replacementKey = `codex-harness-pending-operation-v1:${replacement.clientOperationId}`;
    localStorage.setItem(oldKey, JSON.stringify(old));
    store.setState({ sendOperationRecords: { [old.clientOperationId]: old }, sendOperations: { T: old } });
    const observed: string[] = [];
    const unsubscribe = store.subscribe((state) => {
      const operation = state.sendOperationRecords[old.clientOperationId];
      if (operation) observed.push(operation.state);
    });
    // Another tab acknowledged the old operation, started its replacement,
    // then pruned the acknowledgment before this tab received any event.
    localStorage.removeItem(oldKey);
    localStorage.setItem(replacementKey, JSON.stringify(replacement));
    storageEvent(replacementKey, JSON.stringify(replacement));
    unsubscribe();
    expect(observed).toContain("acknowledged_unknown");
    expect(store.getState().sendOperations.T).toEqual(replacement);
    expect(wire.rpc).not.toHaveBeenCalledWith("turn/start", expect.anything());
  });

  it("preserves every same-thread unknown created concurrently by different tabs", () => {
    const first = { threadId: "T", clientOperationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "unknown" as const };
    const second = { threadId: "T", clientOperationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", state: "unknown" as const };
    const firstKey = `codex-harness-pending-operation-v1:${first.clientOperationId}`;
    const secondKey = `codex-harness-pending-operation-v1:${second.clientOperationId}`;
    localStorage.setItem(firstKey, JSON.stringify(first));
    localStorage.setItem(secondKey, JSON.stringify(second));
    storageEvent(secondKey, JSON.stringify(second));
    expect(Object.values(store.getState().sendOperationRecords).filter((operation) => operation.threadId === "T" && operation.state === "unknown"))
      .toEqual(expect.arrayContaining([first, second]));
    const selected = store.getState().sendOperations.T;
    expect(store.getState().acknowledgeUnknownSend("T", selected.clientOperationId)).toBe(true);
    expect(store.getState().sendOperations.T).toMatchObject({
      clientOperationId: selected.clientOperationId === first.clientOperationId ? second.clientOperationId : first.clientOperationId,
      state: "unknown",
    });
    expect(wire.rpc).not.toHaveBeenCalledWith("turn/start", expect.anything());
  });

  it("singleflights duplicate checks for the same immutable send receipt", async () => {
    const operation = { threadId: "T", clientOperationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "unknown" as const };
    store.setState({ sendOperationRecords: { [operation.clientOperationId]: operation }, sendOperations: { T: operation } });
    const status = deferred<{ state: "unknown" }>();
    const defaults = wire.rpc.getMockImplementation()!;
    wire.rpc.mockImplementation((method, ...args) => method === "turn/operation" ? status.promise : defaults(method, ...args));
    const first = store.getState().checkSendOperation("T", operation.clientOperationId);
    const second = store.getState().checkSendOperation("T", operation.clientOperationId);
    expect(wire.rpc.mock.calls.filter(([method]) => method === "turn/operation")).toHaveLength(1);
    status.resolve({ state: "unknown" });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("keeps unknown safety evidence but drops settled auxiliary records when a thread is forgotten", async () => {
    const unknown = { threadId: "T", clientOperationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "unknown" as const };
    const acknowledged = { threadId: "T", clientOperationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", state: "acknowledged_unknown" as const };
    localStorage.setItem(`codex-harness-pending-operation-v1:${unknown.clientOperationId}`, JSON.stringify(unknown));
    localStorage.setItem(`codex-harness-pending-operation-v1:${acknowledged.clientOperationId}`, JSON.stringify(acknowledged));
    store.setState({
      sessions: [{ threadId: "T", title: "thread", updatedAt: 1 }],
      sendOperationRecords: { [unknown.clientOperationId]: unknown, [acknowledged.clientOperationId]: acknowledged },
      sendOperations: { T: unknown },
    });
    await store.getState().deleteThread("T");
    expect(store.getState().sendOperationRecords[unknown.clientOperationId]).toEqual(unknown);
    expect(store.getState().sendOperationRecords[acknowledged.clientOperationId]).toBeUndefined();
    expect(localStorage.getItem(`codex-harness-pending-operation-v1:${acknowledged.clientOperationId}`)).toBeNull();
  });

  it("bounds durable unknown receipts and automatic reconnect reconciliation without replaying", async () => {
    for (let index = 0; index < 101; index++) {
      const id = `${index.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-${index.toString().padStart(12, "0")}`;
      localStorage.setItem(`codex-harness-pending-operation-v1:${id}`, JSON.stringify({ threadId: `T${index}`, clientOperationId: id, state: "unknown" }));
    }
    wire.stateHandlers.clear();
    vi.resetModules();
    store = (await import("../src/store")).useStore;
    store.getState().bootstrap();
    expect(Object.keys(store.getState().sendOperationRecords)).toHaveLength(100);
    expect(store.getState().sendOperationOverflow).toBe(true);
    store.setState({ activeThreadId: "T0", historyLoaded: { T0: true } });
    await expect(store.getState().sendTurn("must not send")).rejects.toThrow("超过浏览器预算");
    expect(wire.rpc.mock.calls.some(([method]) => method === "turn/start")).toBe(false);

    const defaults = wire.rpc.getMockImplementation()!;
    wire.rpc.mockImplementation((method, ...args) => method === "turn/operation" ? Promise.resolve({ state: "unknown" }) : defaults(method, ...args));
    connection("open");
    await settle();
    expect(wire.rpc.mock.calls.filter(([method]) => method === "turn/operation")).toHaveLength(8);
    connection("closed");
    wire.generation += 1;
    connection("open");
    await settle();
    expect(wire.rpc.mock.calls.filter(([method]) => method === "turn/operation")).toHaveLength(8);
  });

  it("does not strand an unsent replacement when cleanup of an acknowledged record fails", async () => {
    const prior = { threadId: "T", clientOperationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "acknowledged_unknown" as const };
    localStorage.setItem(`codex-harness-pending-operation-v1:${prior.clientOperationId}`, JSON.stringify(prior));
    store.setState({ activeThreadId: "T", historyLoaded: { T: true }, sendOperations: { T: prior } });
    vi.mocked(localStorage.removeItem).mockImplementationOnce(() => { throw new Error("cleanup blocked"); });
    await expect(store.getState().sendTurn("new instruction")).resolves.toBeUndefined();
    const replacement = store.getState().sendOperations.T;
    expect(replacement).toMatchObject({ state: "accepted" });
    expect(replacement.clientOperationId).not.toBe(prior.clientOperationId);
    expect(wire.rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining({ text: "new instruction", clientOperationId: replacement.clientOperationId }));
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
    await expect(store.getState().sendTurn("private draft")).rejects.toThrow("正在运行");
    expect(wire.rpc.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
    vi.resetModules(); store = (await import("../src/store")).useStore;
    expect(store.getState().sendOperations.T.clientOperationId).toBe(operation.clientOperationId);
    wire.rpc.mockResolvedValueOnce({ state: "accepted", threadId: "T", turnId: "r" });
    await store.getState().checkSendOperation("T");
    expect(wire.rpc.mock.calls.slice(-2)).toEqual([
      ["turn/operation", { clientOperationId: operation.clientOperationId }],
      ["thread/read", { threadId: "T", includeTurns: false }],
    ]);
    expect(store.getState().sendOperations.T.state).toBe("accepted"); expect(localStorage.length).toBe(0);
    expect(store.getState().turnActive.T).toBe(false);
  });

  it.each([
    ["active", true],
    ["idle", false],
  ] as const)("reconciles an accepted unknown send against authoritative %s activity", async (statusType, expectedActive) => {
    const operation = { threadId: "T", clientOperationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "unknown" as const };
    store.setState({
      sendOperationRecords: { [operation.clientOperationId]: operation },
      sendOperations: { T: operation },
      turnActive: { T: true },
    });
    wire.rpc
      .mockResolvedValueOnce({ state: "accepted" })
      .mockResolvedValueOnce({ thread: thread("T", [], { status: statusType === "active" ? { type: "active", activeFlags: [] } : { type: "idle" } }) });

    await store.getState().checkSendOperation("T");

    expect(store.getState().sendOperations.T.state).toBe("accepted");
    expect(store.getState().turnActive.T).toBe(expectedActive);
  });

  it("does not let a stale accepted-send activity read overwrite a newer turn notification", async () => {
    const operation = { threadId: "T", clientOperationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "unknown" as const };
    const read = deferred<ThreadReadResponse>();
    store.setState({
      sendOperationRecords: { [operation.clientOperationId]: operation },
      sendOperations: { T: operation },
      turnActive: { T: true },
    });
    wire.rpc.mockResolvedValueOnce({ state: "accepted" }).mockReturnValueOnce(read.promise);
    const checking = store.getState().checkSendOperation("T");
    await settle();
    notify({ method: "turn/started", params: { threadId: "T", turn: turn("newer", [], "inProgress") } });
    read.resolve({ thread: thread("T", [], { status: { type: "idle" } }) });

    await checking;

    expect(store.getState().turnActive.T).toBe(true);
    expect(store.getState().activeTurnId.T).toBe("newer");
  });

  it("releases the activity lock only for a definitive current-operation lookup", async () => {
    const operation = { threadId: "T", clientOperationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "unknown" as const };
    store.setState({
      sendOperationRecords: { [operation.clientOperationId]: operation },
      sendOperations: { T: operation },
      turnActive: { T: true },
    });
    wire.rpc.mockResolvedValueOnce({ state: "not_received" });

    await store.getState().checkSendOperation("T");

    expect(store.getState().turnActive.T).toBe(false);
    expect(store.getState().activeTurnId.T).toBeNull();
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
    await settle();
    expect(wire.rpc).toHaveBeenLastCalledWith("displayPrefs/set", { reasoning: false });
    notify({ method: "displayPrefs/updated", params: { ...store.getState().display, reasoning: false, commands: false } });
    result.resolve({ reasoning: false, commands: true }); await settle();
    expect(store.getState().display.commands).toBe(false);
    wire.rpc.mockRejectedValueOnce(new Error("disk full")); store.getState().updateDisplay({ webSearch: false }); await settle();
    expect(store.getState().displayError).toContain("disk full"); expect(store.getState().display.webSearch).toBe(true);
    notify({ method: "displayPrefs/updated", params: { webSearch: false } });
    expect(store.getState().displayError).toBeNull();
  });

  it("accepts only zero or a value below one for the auto-compaction threshold", async () => {
    store.setState({ display: { ...store.getState().display, autoCompactThreshold: 0.9 } });
    notify({ method: "displayPrefs/updated", params: { autoCompactThreshold: 1 } } as any);
    expect(store.getState().display.autoCompactThreshold).toBe(0.9);
    wire.rpc.mockClear();
    store.getState().updateDisplay({ autoCompactThreshold: 1 });
    expect(wire.rpc).not.toHaveBeenCalled();
    store.getState().updateDisplay({ autoCompactThreshold: 0 });
    store.getState().updateDisplay({ autoCompactThreshold: 0.95 });
    await settle();
    expect(wire.rpc).toHaveBeenNthCalledWith(1, "displayPrefs/set", { autoCompactThreshold: 0 });
    expect(wire.rpc).toHaveBeenNthCalledWith(2, "displayPrefs/set", { autoCompactThreshold: 0.95 });
  });

  it("serializes display writes and prevents an older failure from overwriting a newer intent", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    wire.rpc.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    store.getState().updateDisplay({ reasoning: false });
    store.getState().updateDisplay({ commands: false });
    await settle();
    expect(wire.rpc.mock.calls).toEqual([["displayPrefs/set", { reasoning: false }]]);
    first.reject(new Error("older write failed"));
    await settle();
    expect(store.getState().displayError).toBeNull();
    expect(wire.rpc.mock.calls).toEqual([
      ["displayPrefs/set", { reasoning: false }],
      ["displayPrefs/set", { commands: false }],
    ]);
    second.resolve({});
    await settle();
    expect(store.getState().displayError).toBeNull();
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

  it("clears a selected effort when a refreshed catalog removes that capability", async () => {
    wire.rpc.mockResolvedValueOnce({ data: [{
      id: "changing", supportedReasoningEfforts: [{ reasoningEffort: "ultra" }], defaultReasoningEffort: "ultra", isDefault: true,
    }], nextCursor: null });
    await store.getState().refreshModels();
    store.getState().updateSettings({ selectedModel: "changing", selectedEffort: "ultra" });
    expect(store.getState().settings.selectedEffort).toBe("ultra");

    wire.rpc.mockResolvedValueOnce({ data: [{
      id: "changing", supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low", isDefault: true,
    }], nextCursor: null });
    await store.getState().refreshModels();

    expect(store.getState().settings.selectedModel).toBe("changing");
    expect(store.getState().settings.selectedEffort).toBe("");
  });

  it("retains only the bounded MCP status fields consumed by the settings UI", async () => {
    const tools = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`tool-${index}`, {
      name: `tool-${index}`, description: `description-${index}`, inputSchema: { large: "x".repeat(1_000) },
    }]));
    Object.defineProperty(tools, "tool-over-budget", {
      enumerable: true,
      get() { throw new Error("over-budget tool value was accessed"); },
    });
    wire.rpc.mockResolvedValueOnce({ data: [{
      name: "large-mcp", pluginId: null, serverInfo: { name: "server", version: "1" }, tools,
      resources: [{ uri: "resource://private", text: "RESOURCE-PAYLOAD-MUST-NOT-STAY" }],
      resourceTemplates: [{ uriTemplate: "resource://{private}" }], authStatus: "notRequired",
    }] });

    await store.getState().refreshMcp();

    const server = store.getState().mcpServers[0] as any;
    expect(server).toMatchObject({ name: "large-mcp", initialized: true, toolCount: 501, toolsTruncated: true });
    expect(server.tools).toHaveLength(500);
    expect(JSON.stringify(server)).not.toContain("RESOURCE-PAYLOAD-MUST-NOT-STAY");
    expect(JSON.stringify(server)).not.toContain("inputSchema");
  });

  it.each([
    ["rename", "thread/name/set", "重命名失败"],
    ["archive", "thread/archive", "归档失败"],
    ["delete", "thread/delete", "删除失败"],
    ["unarchive", "thread/unarchive", "恢复失败"],
  ] as const)("rejects a failed %s row action with a bounded visible error contract", async (action, method, label) => {
    const sessions = [{ threadId: "T", title: "Original", updatedAt: 1 }];
    const items = { T: [agent("existing", "keep me")] };
    store.setState({ sessions, items });
    wire.rpc.mockRejectedValueOnce(new Error(`synthetic-${"x".repeat(5_000)}`));

    const pending = action === "rename" ? store.getState().renameThread("T", "Renamed")
      : action === "archive" ? store.getState().archiveThread("T")
        : action === "delete" ? store.getState().deleteThread("T")
          : store.getState().unarchiveThread("T");
    let error: Error | null = null;
    try {
      await pending;
    } catch (reason) {
      error = reason instanceof Error ? reason : new Error(String(reason));
    }
    if (!error) throw new Error("row action unexpectedly resolved");
    expect(error.message).toContain(label);
    expect(error.message.length).toBeLessThanOrEqual(1_020);
    expect(wire.rpc).toHaveBeenCalledWith(method, action === "rename" ? { threadId: "T", name: "Renamed" } : { threadId: "T" });
    expect(store.getState().sessions).toEqual(sessions);
    expect(store.getState().items).toEqual(items);
  });

  it("stops model pagination on a malformed cursor instead of echoing it back", async () => {
    wire.rpc.mockResolvedValue({ data: [{ id: "safe-model" }], nextCursor: { attacker: true } });
    await store.getState().refreshModels();
    expect(wire.rpc).toHaveBeenCalledTimes(1);
    expect(wire.rpc).toHaveBeenCalledWith("model/list", { limit: 100 });
    expect(store.getState().models.map((model) => model.id)).toEqual(["safe-model"]);
  });

  it("stops model pagination when a provider cycles through older cursors", async () => {
    wire.rpc.mockImplementation(async (_method, params) => ({
      data: [{ id: `model-${params.cursor ?? "first"}` }],
      nextCursor: params.cursor === "A" ? "B" : "A",
    }));

    await store.getState().refreshModels();

    expect(wire.rpc.mock.calls.map(([, params]) => params.cursor ?? null)).toEqual([null, "A", "B"]);
    expect(store.getState().models.map((model) => model.id)).toEqual(["model-first", "model-A", "model-B"]);
  });

  it("restores the newest existing session without waiting for a stalled model catalog", async () => {
    const catalog = deferred<unknown>();
    wire.rpc.mockImplementation(async (method: string, params?: { threadId?: string }) => {
      if (method === "app/status") return { providerMode: "openai", codexState: "ready", management: { state: "idle" } };
      if (method === "management/status") return { state: "idle" };
      if (method === "projects/list") return { projects: [{ path: "P", addedAt: 1, lastUsedAt: 1 }] };
      if (method === "thread/list") return { data: [thread("latest")], nextCursor: null };
      if (method === "thread/resume" || method === "thread/read") return { thread: thread(params?.threadId ?? "latest") };
      if (method === "model/list") return catalog.promise;
      if (method === "account/read") return { account: null, requiresOpenaiAuth: true };
      if (method === "account/login/status") return { state: "idle" };
      if (method === "mcpServerStatus/list") return { data: [] };
      return {};
    });

    const refreshing = store.getState().refresh();
    await settle();
    await expect(refreshing).resolves.toBeUndefined();
    await settle();
    expect(store.getState().activeThreadId).toBe("latest");
    expect(store.getState().historyLoaded.latest).toBe(true);
    expect(store.getState().modelLoad.state).toBe("loading");

    catalog.resolve({ data: [{ id: "late-model" }], nextCursor: null });
    await settle();
    expect(store.getState().modelLoad.state).toBe("loaded");
  });

  it("caps an endless model catalog, keeps the bounded cache, and exposes a retry state", async () => {
    wire.rpc.mockImplementation(async (_method, params) => ({
      data: Array.from({ length: 100 }, (_, index) => ({ id: `model-${params.cursor ?? "first"}-${index}` })),
      nextCursor: `cursor-${wire.rpc.mock.calls.length}`,
    }));

    await store.getState().refreshModels();

    expect(wire.rpc).toHaveBeenCalledTimes(5);
    expect(store.getState().models).toHaveLength(500);
    expect(store.getState().modelLoad).toMatchObject({ state: "error", error: expect.stringContaining("最多 5 页") });
  });

  it("preserves a valid same-provider model cache on failure and recovers on explicit retry", async () => {
    wire.rpc.mockResolvedValueOnce({ data: [{ id: "cached" }], nextCursor: null });
    await store.getState().refreshModels();
    wire.rpc.mockRejectedValueOnce(new Error("catalog offline"));
    await store.getState().refreshModels();
    expect(store.getState().models.map((model) => model.id)).toEqual(["cached"]);
    expect(store.getState().modelLoad).toMatchObject({ state: "error", error: expect.stringContaining("catalog offline") });

    wire.rpc.mockResolvedValueOnce({ data: [{ id: "recovered" }], nextCursor: null });
    await store.getState().refreshModels();
    expect(store.getState().models.map((model) => model.id)).toEqual(["recovered"]);
    expect(store.getState().modelLoad).toEqual({ state: "loaded", error: null });
  });

  it("ends a stalled model request at the wall-clock budget without discarding the last valid cache", async () => {
    const stalled = deferred<unknown>();
    store.setState({ models: [{ id: "keep-me" }] });
    wire.rpc.mockReturnValue(stalled.promise);
    const loading = store.getState().refreshModels();
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    await loading;
    expect(store.getState().models.map((model) => model.id)).toEqual(["keep-me"]);
    expect(store.getState().modelLoad).toMatchObject({ state: "error", error: expect.stringContaining("超过 5 秒预算") });
    expect(wire.rpc).toHaveBeenCalledTimes(1);
    stalled.resolve({ data: [{ id: "too-late" }], nextCursor: null });
    await settle();
    expect(store.getState().models.map((model) => model.id)).toEqual(["keep-me"]);
  });

  it("normalizes a malformed app-server state notification before it reaches React", () => {
    notify({ method: "appServer/stateChanged", params: { state: { unexpected: true } } } as any);
    expect(store.getState().codexState).toBe("unknown");
  });

  it("does not silently switch providers when app/status omits a valid provider mode", async () => {
    store.setState({ providerMode: "zhipu" });
    wire.rpc.mockImplementation(async (method: string) => {
      if (method === "app/status") return { providerMode: { malformed: true }, codexState: "ready", management: { state: "idle" } };
      if (method === "management/status") return { state: "idle" };
      if (method === "projects/list") return { projects: [{ path: "P", addedAt: 1, lastUsedAt: 1 }] };
      if (method === "thread/list") return { data: [], nextCursor: null };
      if (method === "model/list" || method === "mcpServerStatus/list") return { data: [], nextCursor: null };
      if (method === "account/read") return { account: null, requiresOpenaiAuth: false };
      return {};
    });

    await store.getState().refresh();

    expect(store.getState().providerMode).toBe("zhipu");
    expect(store.getState().appStatusLoad).toMatchObject({ state: "error", error: expect.stringContaining("格式无效") });
  });

  it("surfaces resource read failures, preserves prior snapshots, and recovers on one explicit retry", async () => {
    const account = { account: { type: "apiKey" as const }, requiresOpenaiAuth: false };
    const projects = [{ path: "P", addedAt: 1, lastUsedAt: 1 }];
    const mcpServers = [{ name: "mcp", initialized: true, toolCount: 0, tools: [] }];
    store.setState({ account, projects, mcpServers });

    wire.rpc.mockRejectedValue(new Error("temporary read failure"));
    await store.getState().refreshAccount();
    await store.getState().refreshProjects();
    await store.getState().refreshMcp();
    expect(store.getState()).toMatchObject({
      account, projects, mcpServers,
      accountLoad: { state: "error", error: expect.stringContaining("temporary read failure") },
      projectsLoad: { state: "error", error: expect.stringContaining("temporary read failure") },
      mcpLoad: { state: "error", error: expect.stringContaining("temporary read failure") },
    });

    wire.rpc.mockImplementation(async (method: string) => {
      if (method === "account/read") return { account: null, requiresOpenaiAuth: true };
      if (method === "projects/list") return { projects: [] };
      if (method === "mcpServerStatus/list") return { data: [], nextCursor: null };
      throw new Error(`unexpected ${method}`);
    });
    await store.getState().refreshAccount();
    await store.getState().refreshProjects();
    await store.getState().refreshMcp();
    expect(store.getState()).toMatchObject({
      account: { account: null, requiresOpenaiAuth: true }, accountLoad: { state: "loaded", error: null },
      projects: [], projectsLoad: { state: "loaded", error: null },
      mcpServers: [], mcpLoad: { state: "loaded", error: null },
    });
  });

  it("projects every account union branch and rejects malformed account objects without replacing the last snapshot", async () => {
    const responses: unknown[] = [
      { account: { type: "apiKey", ignored: "secret" }, requiresOpenaiAuth: false },
      { account: { type: "chatgpt", email: `${"a".repeat(400)}@example.test`, planType: "plus", ignored: true }, requiresOpenaiAuth: true },
      { account: { type: "amazonBedrock", usesCodexManagedCredentials: true, ignored: true }, requiresOpenaiAuth: false },
      { account: { type: "future-provider" }, requiresOpenaiAuth: false },
    ];
    wire.rpc.mockImplementation(async (method: string) => {
      if (method === "account/read") return responses.shift();
      return {};
    });
    await store.getState().refreshAccount();
    expect(store.getState().account).toEqual({ account: { type: "apiKey" }, requiresOpenaiAuth: false });
    await store.getState().refreshAccount();
    expect(store.getState().account?.account).toMatchObject({ type: "chatgpt", planType: "plus" });
    expect((store.getState().account?.account as { email: string }).email).toHaveLength(320);
    await store.getState().refreshAccount();
    const bedrock = { account: { type: "amazonBedrock", usesCodexManagedCredentials: true }, requiresOpenaiAuth: false } as const;
    expect(store.getState().account).toEqual(bedrock);
    await store.getState().refreshAccount();
    expect(store.getState().account).toEqual(bedrock);
    expect(store.getState().accountLoad).toMatchObject({ state: "error", error: expect.stringContaining("格式无效") });
  });

  it("keeps first-session auto-selection pending across a failed list read and performs it after retry", async () => {
    let listAttempts = 0;
    wire.rpc.mockImplementation(async (method: string, params?: { threadId?: string }) => {
      if (method === "app/status") return { providerMode: "openai", codexState: "ready", management: { state: "idle" } };
      if (method === "projects/list") return { projects: [{ path: "P", addedAt: 1, lastUsedAt: 1 }] };
      if (method === "thread/list") {
        if (listAttempts++ === 0) throw new Error("list temporarily unavailable");
        return { data: [thread("latest")], nextCursor: null };
      }
      if (method === "thread/resume") return { thread: thread(params?.threadId ?? "latest") };
      if (method === "thread/read") return { thread: thread(params?.threadId ?? "latest") };
      if (method === "account/read") return { account: null, requiresOpenaiAuth: true };
      if (method === "account/login/status") return { state: "idle" };
      if (method === "model/list" || method === "mcpServerStatus/list") return { data: [], nextCursor: null };
      return {};
    });

    await store.getState().refresh();
    expect(store.getState().activeThreadId).toBeNull();
    expect(store.getState().sessionLoad.state).toBe("error");

    await store.getState().refresh();
    await settle();
    expect(store.getState().sessionLoad.state).toBe("loaded");
    expect(store.getState().activeThreadId).toBe("latest");
  });

  it("preserves catalog snapshots when a successful RPC has a malformed collection shape", async () => {
    const projects = [{ path: "P", addedAt: 1, lastUsedAt: 1 }];
    const sessions = [{ threadId: "session", title: "Session", updatedAt: 1 }];
    const models = [{ id: "model", displayName: "Model", reasoningEfforts: ["low"] }];
    const mcpServers = [{ name: "mcp", initialized: true, toolCount: 0, tools: [] }];
    store.setState({ projects, sessions, sessionCursor: "tail", models, mcpServers });
    wire.rpc.mockResolvedValue({ malformed: true });

    await store.getState().refreshProjects();
    await store.getState().refreshSessions();
    await store.getState().refreshModels();
    await store.getState().refreshMcp();

    expect(store.getState()).toMatchObject({ projects, sessions, sessionCursor: "tail", models, mcpServers });
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

  it("keeps an approval visible when the response cannot enter the websocket", () => {
    wire.respondServerRequest.mockReturnValue(false);
    wire.serverRequest({ method: "item/commandExecution/requestApproval", requestId: "offline", params: {
      threadId: "T", turnId: "r", itemId: "cmd", startedAtMs: 0, environmentId: null,
      command: "echo safe", cwd: "P", reason: null, networkApprovalContext: null,
    } });
    store.getState().decideApproval("offline", "accept");
    expect(wire.respondServerRequest).toHaveBeenCalledOnce();
    expect(store.getState().approvals).toHaveLength(1);
  });

  it("permits only refusal until the exact file-change item has complete valid details", () => {
    store.setState({ items: { T: [{
      type: "fileChange", id: "exact", threadId: "T", turnId: "turn", status: "inProgress",
      changes: [{ path: "/project/exact.ts", kind: { type: "update", move_path: null }, diff: "+safe" }],
    }] } });
    wire.serverRequest({ method: "item/fileChange/requestApproval", requestId: "missing", params: {
      threadId: "T", turnId: "turn", itemId: "missing", startedAtMs: 0, reason: null, grantRoot: null,
    } });
    store.getState().decideApproval("missing", "accept");
    store.getState().decideApproval("missing", "acceptForSession");
    expect(wire.respondServerRequest).not.toHaveBeenCalled();
    store.getState().decideApproval("missing", "decline");
    expect(wire.respondServerRequest).toHaveBeenCalledExactlyOnceWith("missing", { decision: "decline" });
    notify({ method: "serverRequest/resolved", params: { requestId: "missing" } });

    wire.respondServerRequest.mockClear();
    wire.serverRequest({ method: "item/fileChange/requestApproval", requestId: "wrong-turn", params: {
      threadId: "T", turnId: "other", itemId: "exact", startedAtMs: 0, reason: null, grantRoot: null,
    } });
    store.getState().decideApproval("wrong-turn", "acceptForSession");
    expect(wire.respondServerRequest).not.toHaveBeenCalled();
    store.getState().decideApproval("wrong-turn", "decline");
    expect(wire.respondServerRequest).toHaveBeenCalledExactlyOnceWith("wrong-turn", { decision: "decline" });
  });

  it("retains an approval until resolution and unlocks a rejected answer for retry", () => {
    store.setState({ items: { T: [{
      type: "fileChange", id: "exact", threadId: "T", turnId: "turn", status: "inProgress",
      changes: [{ path: "/project/exact.ts", kind: { type: "add" }, diff: "+safe" }],
    }] } });
    wire.serverRequest({ method: "item/fileChange/requestApproval", requestId: "exact", params: {
      threadId: "T", turnId: "turn", itemId: "exact", startedAtMs: 0, reason: null, grantRoot: null,
    } });

    store.getState().decideApproval("exact", "acceptForSession");
    // A replay of the same unresolved request is not a rejection and must not
    // unlock a second response on the same live socket.
    wire.serverRequest({ method: "item/fileChange/requestApproval", requestId: "exact", params: {
      threadId: "T", turnId: "turn", itemId: "exact", startedAtMs: 0, reason: null, grantRoot: null,
    } });
    store.getState().decideApproval("exact", "accept");
    expect(wire.respondServerRequest).toHaveBeenCalledExactlyOnceWith("exact", { decision: "acceptForSession" });
    expect(store.getState().approvals).toHaveLength(1);
    expect(store.getState().approvalSubmissions.exact).toBe(true);

    notify({ method: "serverRequest/answerRejected", params: { serverRequestId: "exact", error: "approval token expired" } });
    expect(store.getState().approvals).toHaveLength(1);
    expect(store.getState().approvalSubmissions.exact).toBe(false);
    expect(store.getState().approvalErrors.exact).toBe("approval token expired");
    store.getState().decideApproval("exact", "accept");
    expect(wire.respondServerRequest).toHaveBeenCalledTimes(2);
    expect(store.getState().approvalErrors.exact).toBeUndefined();

    notify({ method: "serverRequest/resolved", params: { requestId: "exact" } });
    expect(store.getState().approvals).toHaveLength(0);
    expect(store.getState().approvalSubmissions.exact).toBeUndefined();
    expect(store.getState().approvalErrors.exact).toBeUndefined();
  });

  it.each([
    ["empty", []],
    ["missing diff", [{ path: "/project/file.ts", kind: { type: "add" } }]],
    ["incomplete update kind", [{ path: "/project/file.ts", kind: { type: "update" }, diff: "+x" }]],
    ["oversized list", Array.from({ length: 51 }, (_, index) => ({ path: `/project/file-${index}.ts`, kind: { type: "add" }, diff: "+x" }))],
  ])("fails file approval closed for %s change details", (_label, changes) => {
    store.setState({ items: { T: [{
      type: "fileChange", id: "malformed", threadId: "T", turnId: "turn", status: "inProgress", changes,
    } as any] } });
    wire.serverRequest({ method: "item/fileChange/requestApproval", requestId: "malformed-file", params: {
      threadId: "T", turnId: "turn", itemId: "malformed", startedAtMs: 0, reason: null, grantRoot: null,
    } });
    store.getState().decideApproval("malformed-file", "accept");
    store.getState().decideApproval("malformed-file", "acceptForSession");
    expect(wire.respondServerRequest).not.toHaveBeenCalled();
    store.getState().decideApproval("malformed-file", "decline");
    expect(wire.respondServerRequest).toHaveBeenCalledExactlyOnceWith("malformed-file", { decision: "decline" });
  });

  it("serializes history attachment reads and retries a transient heavy-lane BUSY response", async () => {
    const first = deferred<{ base64: string; mime: string }>();
    const defaults = wire.rpc.getMockImplementation()!;
    let reads = 0;
    wire.rpc.mockImplementation((method, ...args) => {
      if (method !== "attachment/read") return defaults(method, ...args);
      reads += 1;
      if (reads === 1) return first.promise;
      return Promise.resolve({ base64: "Yg==", mime: "image/png" });
    });
    const one = store.getState().readAttachment("/one.png");
    const duplicate = store.getState().readAttachment("/one.png");
    const two = store.getState().readAttachment("/two.png");
    await settle();
    expect(wire.rpc.mock.calls.filter(([method]) => method === "attachment/read")).toHaveLength(1);
    first.resolve({ base64: "YQ==", mime: "image/png" });
    await expect(one).resolves.toMatchObject({ base64: "YQ==" });
    await expect(duplicate).resolves.toMatchObject({ base64: "YQ==" });
    await expect(two).resolves.toMatchObject({ base64: "Yg==" });

    reads = 0;
    wire.rpc.mockImplementation((method, ...args) => {
      if (method !== "attachment/read") return defaults(method, ...args);
      reads += 1;
      if (reads === 1) return Promise.reject(Object.assign(new Error("busy"), { code: "BUSY" }));
      return Promise.resolve({ base64: "Yw==", mime: "image/png" });
    });
    const retried = store.getState().readAttachment("/busy.png");
    await settle();
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    await expect(retried).resolves.toMatchObject({ base64: "Yw==" });
    expect(reads).toBe(2);
  });

  it("bounds queued history reads instead of retaining an entire large timeline", async () => {
    const active = deferred<{ base64: string; mime: string }>();
    const defaults = wire.rpc.getMockImplementation()!;
    wire.rpc.mockImplementation((method, ...args) => method === "attachment/read"
      ? (args[0]?.path === "/active.png" ? active.promise : Promise.resolve({ base64: "YQ==", mime: "image/png" }))
      : defaults(method, ...args));

    const first = store.getState().readAttachment("/active.png");
    const queued = Array.from({ length: 64 }, (_, index) => store.getState().readAttachment(`/queued-${index}.png`));
    const overflow = store.getState().readAttachment("/overflow.png");
    await expect(overflow).rejects.toMatchObject({ code: "ATTACHMENT_QUEUE_FULL" });
    expect(wire.rpc.mock.calls.filter(([method]) => method === "attachment/read")).toHaveLength(1);

    active.resolve({ base64: "YQ==", mime: "image/png" });
    await expect(Promise.all([first, ...queued])).resolves.toHaveLength(65);
    expect(wire.rpc.mock.calls.filter(([method]) => method === "attachment/read")).toHaveLength(65);
  });

  it("cancels one deduplicated reader without canceling the remaining owner", async () => {
    const response = deferred<{ base64: string; mime: string }>();
    const defaults = wire.rpc.getMockImplementation()!;
    wire.rpc.mockImplementation((method, ...args) => method === "attachment/read" ? response.promise : defaults(method, ...args));
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = store.getState().readAttachment("/shared.png", firstController.signal);
    const second = store.getState().readAttachment("/shared.png", secondController.signal);

    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(wire.rpc.mock.calls.filter(([method]) => method === "attachment/read")).toHaveLength(1);
    response.resolve({ base64: "YQ==", mime: "image/png" });
    await expect(second).resolves.toMatchObject({ base64: "YQ==" });
  });

  it.each(["thread", "project", "runtime"] as const)("cancels stale attachment results across a %s boundary", async boundary => {
    store.setState({ activeThreadId: "A", currentProject: "P", historyLoaded: { A: true, B: true } });
    const response = deferred<{ base64: string; mime: string }>();
    const defaults = wire.rpc.getMockImplementation()!;
    wire.rpc.mockImplementation((method, ...args) => method === "attachment/read" ? response.promise : defaults(method, ...args));
    const reading = store.getState().readAttachment("/stale.png");

    if (boundary === "thread") void store.getState().openThread("B");
    else if (boundary === "project") void store.getState().selectProject("Q");
    else connection("closed");

    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    response.resolve({ base64: "c3RhbGU=", mime: "image/png" });
    await settle();
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

  it("keeps an ambiguous failed send active and blocks overlapping optimistic sends", async () => {
    const start = deferred<unknown>();
    store.setState({ activeThreadId: "T", historyLoaded: { T: true } });
    wire.rpc.mockReturnValue(start.promise);
    const sending = store.getState().sendTurn("first");
    const failed = expect(sending).rejects.toThrow("failed");
    await expect(store.getState().sendTurn("overlap")).rejects.toThrow("正在运行");
    start.reject(new Error("failed")); await failed;
    expect(store.getState().turnActive.T).toBe(true);
    expect(store.getState().sendOperations.T.state).toBe("unknown");
  });

  it("refreshes one bounded first page after lifecycle events while preserving the explicitly loaded tail", async () => {
    let prefix = "old";
    wire.rpc.mockImplementation(async (_method, params) => {
      const offset = Number(params.cursor ?? 0);
      return {
        data: Array.from({ length: 50 }, (_, i) => thread(`session-${offset + i}`, [], { name: `${prefix}-${offset + i}` })),
        nextCursor: String(offset + 50),
      };
    });
    await store.getState().refreshSessions();
    await store.getState().loadMoreSessions(); await store.getState().loadMoreSessions();
    expect(store.getState().sessions).toHaveLength(150);
    prefix = "fresh"; wire.rpc.mockClear();
    notify({ method: "turn/completed", params: { threadId: "session-0", turn: turn("done", []) } });
    await vi.advanceTimersByTimeAsync(300); await settle();
    expect(wire.rpc.mock.calls.map(([, params]) => params.cursor ?? null)).toEqual([null]);
    expect(store.getState().sessions).toHaveLength(150);
    expect(store.getState().sessions.slice(0, 50).every((session) => session.title.startsWith("fresh-"))).toBe(true);
    expect(store.getState().sessions.slice(50).every((session) => session.title.startsWith("old-"))).toBe(true);
    expect(store.getState().sessionCursor).toBe("50");
    await store.getState().loadMoreSessions();
    expect(wire.rpc).toHaveBeenLastCalledWith("thread/list", { limit: 50, cursor: "50", cwd: "P" });
    expect(store.getState().sessions).toHaveLength(150);
    expect(store.getState().sessions.slice(0, 100).every((session) => session.title.startsWith("fresh-"))).toBe(true);
    expect(store.getState().sessions.slice(100).every((session) => session.title.startsWith("old-"))).toBe(true);
    expect(store.getState().sessionCursor).toBe("100");
  });

  it("does not reinsert a locally deleted thread from a stale pagination page", async () => {
    wire.rpc.mockResolvedValueOnce({ data: [thread("existing")], nextCursor: "page-2" });
    await store.getState().refreshSessions();
    notify({ method: "thread/deleted", params: { threadId: "deleted" } });
    wire.rpc.mockResolvedValueOnce({ data: [thread("deleted"), thread("next")], nextCursor: null });

    await store.getState().loadMoreSessions();

    expect(store.getState().sessions.map((session) => session.threadId)).toEqual(["existing", "next"]);
  });

  it("ends pagination when a stale server repeats the current page cursor", async () => {
    wire.rpc.mockResolvedValueOnce({ data: [thread("existing")], nextCursor: "same-page" });
    await store.getState().refreshSessions();
    wire.rpc.mockResolvedValueOnce({ data: [thread("duplicate-page")], nextCursor: "same-page" });

    await store.getState().loadMoreSessions();

    expect(store.getState().sessionCursor).toBeNull();
  });

  it("drops malformed lifecycle, diff, status, and plan notifications without corrupting state", () => {
    store.setState({
      turnActive: { T: true }, activeTurnId: { T: "turn" }, turnDiff: { T: "safe diff" },
      plan: { T: { explanation: "safe plan", steps: [{ step: "safe", status: "pending" }] } },
    });
    expect(() => notify({ method: "turn/completed", params: { threadId: "T", turn: null } } as any)).not.toThrow();
    expect(() => notify({ method: "thread/status/changed", params: { threadId: "T", status: null } } as any)).not.toThrow();
    expect(() => notify({ method: "turn/diff/updated", params: { threadId: "T", turnId: "turn", diff: { malformed: true } } } as any)).not.toThrow();
    expect(() => notify({ method: "turn/plan/updated", params: { threadId: "T", turnId: "turn", explanation: {}, plan: {} } } as any)).not.toThrow();
    expect(() => notify({ method: "turn/started", params: { threadId: "T", turn: { id: { malformed: true } } } } as any)).not.toThrow();
    expect(() => notify({ method: "item/started", params: { threadId: "T", turnId: "turn", item: { id: { malformed: true }, type: "agentMessage", text: "poison" } } } as any)).not.toThrow();
    expect(() => notify({ method: "thread/status/changed", params: null } as any)).not.toThrow();
    expect(() => notify({ method: "turn/diff/updated", params: { threadId: { malformed: true }, turnId: "turn", diff: "poison" } } as any)).not.toThrow();
    expect(store.getState()).toMatchObject({
      turnActive: { T: true }, activeTurnId: { T: "turn" }, turnDiff: { T: "safe diff" },
      plan: { T: { explanation: "safe plan", steps: [{ step: "safe", status: "pending" }] } },
    });
    expect(store.getState().items.T).toBeUndefined();
    expect(Object.keys(store.getState().turnDiff)).toEqual(["T"]);
  });

  it("removes a renamed deep-page result immediately when it no longer matches the active search", async () => {
    store.setState({ sessionSearch: "match" });
    wire.rpc.mockResolvedValueOnce({ data: [thread("head", [], { name: "match head" })], nextCursor: "page-2" });
    await store.getState().refreshSessions();
    wire.rpc.mockResolvedValueOnce({ data: [thread("tail", [], { name: "match tail" })], nextCursor: "page-3" });
    await store.getState().loadMoreSessions();
    notify({ method: "thread/name/updated", params: { threadId: "tail", threadName: "different title" } });
    expect(store.getState().sessions.map((session) => session.threadId)).toEqual(["head"]);
  });

  it("keeps the entire prior session window and cursor when its bounded refresh fails", async () => {
    wire.rpc.mockResolvedValueOnce({ data: [thread("old-head")], nextCursor: "page-2" });
    await store.getState().refreshSessions();
    wire.rpc.mockResolvedValueOnce({ data: [thread("old-tail")], nextCursor: "page-3" });
    await store.getState().loadMoreSessions();
    const sessions = store.getState().sessions;
    wire.rpc.mockRejectedValueOnce(new Error("synthetic first-page failure"));
    await store.getState().refreshSessions();
    expect(store.getState().sessions).toEqual(sessions);
    expect(store.getState().sessionCursor).toBe("page-3");
    expect(store.getState().sessionLoading).toBe(false);
    expect(store.getState().sessionLoad).toMatchObject({ state: "error", error: expect.stringContaining("synthetic first-page failure") });
  });

  it("preserves explicitly loaded short-page tails without replaying their cursors", async () => {
    wire.rpc.mockImplementation(async (_method, params) => {
      const offset = Number(params.cursor ?? 0);
      return { data: [thread(`short-${offset}`)], nextCursor: String(offset + 1) };
    });
    await store.getState().refreshSessions();
    await store.getState().loadMoreSessions(); await store.getState().loadMoreSessions();
    wire.rpc.mockClear(); await store.getState().refreshSessions();
    expect(wire.rpc.mock.calls.map(([, params]) => params.cursor ?? null)).toEqual([null]);
    expect(store.getState().sessions).toHaveLength(3);
    expect(store.getState().sessionCursor).toBe("1");
    await store.getState().loadMoreSessions();
    expect(wire.rpc).toHaveBeenLastCalledWith("thread/list", { limit: 50, cursor: "1", cwd: "P" });
    expect(store.getState().sessions).toHaveLength(3);
    expect(store.getState().sessionCursor).toBe("2");
  });

  it("revalidates a shifted first-page boundary from the fresh cursor without losing or duplicating rows", async () => {
    let phase: "initial" | "refresh" = "initial";
    wire.rpc.mockImplementation(async (_method, params) => {
      if (phase === "initial") {
        const offset = Number(params.cursor ?? 0);
        return {
          data: Array.from({ length: 50 }, (_, index) => thread(`session-${offset + index}`)),
          nextCursor: offset < 100 ? String(offset + 50) : null,
        };
      }
      if (!params.cursor) {
        return {
          data: [thread("newest"), ...Array.from({ length: 49 }, (_, index) => thread(`session-${index}`))],
          nextCursor: "fresh-50",
        };
      }
      expect(params.cursor).toBe("fresh-50");
      return {
        data: Array.from({ length: 50 }, (_, index) => thread(`session-${49 + index}`)),
        nextCursor: "fresh-100",
      };
    });
    await store.getState().refreshSessions();
    await store.getState().loadMoreSessions();
    await store.getState().loadMoreSessions();
    expect(store.getState().sessions).toHaveLength(150);

    phase = "refresh";
    await store.getState().refreshSessions();
    expect(store.getState().sessionCursor).toBe("fresh-50");
    expect(store.getState().sessions.map((session) => session.threadId)).toContain("session-49");

    await store.getState().loadMoreSessions();
    const ids = store.getState().sessions.map((session) => session.threadId);
    expect(ids.slice(0, 101)).toEqual(["newest", ...Array.from({ length: 100 }, (_, index) => `session-${index}`)]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("session-149");
    expect(store.getState().sessionCursor).toBe("fresh-100");
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

  it("loads sessions after adding the first project even when refresh already selected it", async () => {
    store.setState({ currentProject: "", activeThreadId: null, sessions: [] });
    wire.rpc.mockImplementation(async (method: string) => {
      if (method === "projects/add") return {};
      if (method === "projects/list") return { projects: [{ path: "P", addedAt: 1, lastUsedAt: 1 }] };
      if (method === "thread/list") return { data: [thread("existing")], nextCursor: null };
      return {};
    });
    await store.getState().addProject("P", true);
    await store.getState().selectProject("P");
    expect(store.getState().currentProject).toBe("P");
    expect(store.getState().sessions.map((session) => session.threadId)).toEqual(["existing"]);
  });

  it("does not keep an old project's active conversation after removing the current project", async () => {
    store.setState({
      currentProject: "P", activeThreadId: "old-thread",
      items: { "old-thread": [agent("old", "old project")] }, historyLoaded: { "old-thread": true },
    });
    wire.rpc.mockImplementation(async (method: string) => {
      if (method === "projects/remove") return {};
      if (method === "projects/list") return { projects: [{ path: "Q", addedAt: 1, lastUsedAt: 1 }] };
      if (method === "thread/list") return { data: [thread("q-thread")], nextCursor: null };
      return {};
    });
    await store.getState().removeProject("P");
    expect(store.getState().currentProject).toBe("Q");
    expect(store.getState().activeThreadId).toBeNull();
    expect(store.getState().items).toEqual({});
    expect(store.getState().sessions.map((session) => session.threadId)).toEqual(["q-thread"]);
  });

  it("atomically falls back projects and discards delayed list/create results captured under the old cwd", async () => {
    const oldList = deferred<unknown>();
    const oldCreate = deferred<unknown>();
    let firstCreate = true;
    store.setState({
      currentProject: "Q",
      projects: [
        { path: "P", addedAt: 1, lastUsedAt: 1, available: true },
        { path: "Q", addedAt: 1, lastUsedAt: 1, available: true },
      ],
      activeThreadId: null,
      sessions: [{ threadId: "q-old", title: "Q", updatedAt: 1 }],
    });
    wire.rpc.mockImplementation(async (method: string, params?: any) => {
      if (method === "projects/list") return { projects: [{ path: "P", addedAt: 1, lastUsedAt: 1, available: true }] };
      if (method === "thread/list") return params?.cwd === "Q" ? oldList.promise : { data: [], nextCursor: null };
      if (method === "thread/start") {
        if (firstCreate) { firstCreate = false; return oldCreate.promise; }
        return { thread: thread("p-created", [], { cwd: "P" }), clientOperationId: params.clientOperationId };
      }
      return {};
    });

    const listing = store.getState().refreshSessions();
    const creating = store.getState().newThread();
    await settle();
    const oldCreateParams = wire.rpc.mock.calls.find(([method]) => method === "thread/start")![1];
    await store.getState().refreshProjects();
    expect(store.getState()).toMatchObject({ currentProject: "P", activeThreadId: null, sessions: [] });

    oldList.resolve({ data: [thread("q-late", [], { cwd: "Q" })], nextCursor: "q-tail" });
    oldCreate.resolve({ thread: thread("q-created", [], { cwd: "Q" }), clientOperationId: oldCreateParams.clientOperationId });
    await Promise.all([listing, creating]);
    expect(store.getState()).toMatchObject({ currentProject: "P", activeThreadId: null, sessions: [] });
    expect(localStorage.getItem("codex-harness-thread-create-operation-v1")).toContain("q-created");
    expect(wire.rpc.mock.calls.find(([method]) => method === "thread/start")![1]).toMatchObject({ cwd: "Q" });

    await expect(store.getState().newThread()).resolves.toBe("p-created");
    expect(store.getState().activeThreadId).toBe("p-created");
    expect(wire.rpc.mock.calls.filter(([method]) => method === "thread/start").at(-1)?.[1]).toMatchObject({ cwd: "P" });
  });

  it("never selects an unavailable fallback and refuses to create in an unverified cwd", async () => {
    store.setState({ currentProject: "Q", activeThreadId: "q-thread", historyLoaded: { "q-thread": true } });
    wire.rpc.mockResolvedValueOnce({ projects: [{ path: "Q", addedAt: 1, lastUsedAt: 1, available: false }] });
    await store.getState().refreshProjects();
    expect(store.getState()).toMatchObject({
      currentProject: "",
      activeThreadId: null,
      projectsLoad: { state: "error", error: expect.stringContaining("均不可用") },
    });
    wire.rpc.mockClear();
    await expect(store.getState().newThread()).rejects.toThrow("没有可用项目");
    expect(wire.rpc).not.toHaveBeenCalledWith("thread/start", expect.anything());
  });

  it("does not publish a project that disappeared while its touch request was pending", async () => {
    const touch = deferred<unknown>();
    store.setState({
      currentProject: "P",
      projects: [
        { path: "P", addedAt: 1, lastUsedAt: 1, available: true },
        { path: "Q", addedAt: 1, lastUsedAt: 1, available: true },
      ],
      sessions: [{ threadId: "p-thread", title: "P", updatedAt: 1 }],
    });
    wire.rpc.mockImplementation(async (method: string) => {
      if (method === "projects/touch") return touch.promise;
      if (method === "projects/list") return { projects: [{ path: "P", addedAt: 1, lastUsedAt: 1, available: true }] };
      if (method === "thread/list") return { data: [], nextCursor: null };
      return {};
    });

    const selecting = store.getState().selectProject("Q");
    await settle();
    await store.getState().refreshProjects();
    touch.resolve({});
    await expect(selecting).rejects.toThrow("切换期间变为不可用");
    expect(store.getState().currentProject).toBe("P");
    expect(store.getState().sessions.map((session) => session.threadId)).toEqual(["p-thread"]);
    expect(wire.rpc.mock.calls.filter(([method]) => method === "thread/list")).toHaveLength(0);
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

  it("does not enable duplicate compaction after an ambiguous delivery failure", async () => {
    store.setState({ activeThreadId: "T" });
    wire.rpc.mockRejectedValueOnce(Object.assign(new Error("connection closed"), { delivery: "unknown" }));
    await store.getState().compactThread();
    expect(store.getState().compacting.T).toBe(true);
    expect(store.getState().items.T.at(-1)).toMatchObject({
      type: "errorItem",
      message: expect.stringContaining("结果待确认"),
    });
    await store.getState().compactThread();
    expect(wire.rpc.mock.calls.filter(([method]) => method === "thread/compact/start")).toHaveLength(1);
  });

  it("unlocks compaction after a definitive transport rejection", async () => {
    store.setState({ activeThreadId: "T" });
    wire.rpc.mockRejectedValueOnce(Object.assign(new Error("not sent"), { delivery: "not_sent" }));
    await store.getState().compactThread();
    expect(store.getState().compacting.T).toBe(false);
    expect(store.getState().items.T.at(-1)).toMatchObject({ type: "errorItem", message: expect.stringContaining("压缩失败") });
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
    expect(store.getState().approvals).toHaveLength(1);
    expect(store.getState().approvalSubmissions.malformed).toBe(true);
    notify({ method: "serverRequest/resolved", params: { requestId: "malformed" } });
    expect(store.getState().approvals).toHaveLength(0);
  });

  it("only permits refusal when command approval context cannot be rendered faithfully", () => {
    wire.serverRequest({ method: "item/commandExecution/requestApproval", requestId: "bad-command-context", params: {
      threadId: "T", turnId: "r", itemId: "command", startedAtMs: 0, environmentId: null,
      command: "curl https://example.test", proposedNetworkPolicyAmendments: [{ action: "allow", host: { unexpected: true } }],
    } } as any);
    store.getState().decideApproval("bad-command-context", "accept");
    store.getState().decideApproval("bad-command-context", "acceptForSession");
    expect(wire.respondServerRequest).not.toHaveBeenCalled();
    expect(store.getState().approvals).toHaveLength(1);
    store.getState().decideApproval("bad-command-context", "decline");
    expect(wire.respondServerRequest).toHaveBeenCalledExactlyOnceWith("bad-command-context", { decision: "decline" });
  });

  it("keeps malformed approvals rejectable during interrupt and thread deletion", async () => {
    store.setState({ activeThreadId: "T", turnActive: { T: true } });
    wire.serverRequest({ method: "item/commandExecution/requestApproval", requestId: "bad-interrupt", params: null } as any);
    await expect(store.getState().interruptTurn()).resolves.toBeUndefined();
    expect(wire.respondServerRequest).toHaveBeenCalledWith("bad-interrupt", { decision: "decline" });
    notify({ method: "serverRequest/resolved", params: { requestId: "bad-interrupt" } });

    wire.serverRequest({ method: "item/commandExecution/requestApproval", requestId: "bad-delete", params: null } as any);
    expect(() => notify({ method: "thread/deleted", params: { threadId: "T" } })).not.toThrow();
    // With no trustworthy owner, keep the request globally rejectable rather
    // than guessing that deletion resolved it.
    expect(store.getState().approvals).toHaveLength(1);
    store.getState().decideApproval("bad-delete", "decline");
    expect(store.getState().approvals).toHaveLength(1);
    notify({ method: "serverRequest/resolved", params: { requestId: "bad-delete" } });
    expect(store.getState().approvals).toHaveLength(0);
  });

  it("fails closed without throwing when network approval protocol metadata is not text", () => {
    wire.serverRequest({ method: "item/commandExecution/requestApproval", requestId: "bad-network-protocol", params: {
      threadId: "T", command: "curl https://example.test",
      networkApprovalContext: { protocol: { toString: "not callable" }, host: "example.test" },
    } } as any);
    expect(() => store.getState().decideApproval("bad-network-protocol", "accept")).not.toThrow();
    expect(wire.respondServerRequest).not.toHaveBeenCalled();
    store.getState().decideApproval("bad-network-protocol", "decline");
    expect(wire.respondServerRequest).toHaveBeenCalledWith("bad-network-protocol", { decision: "decline" });
  });

  it("does not carry archived sessions into a newly-created current conversation", async () => {
    store.setState({ sessionArchived: true, sessions: [{ threadId: "archived", title: "old", updatedAt: 1 }] });
    await store.getState().newThread(); await settle();
    expect(store.getState().sessionArchived).toBe(false);
    expect(store.getState().sessions.map((session) => session.threadId)).toEqual(["new"]);
  });

  it("singleflights concurrent thread creation with one durable client operation id", async () => {
    const response = deferred<unknown>();
    store.setState({ activeThreadId: null });
    wire.rpc.mockImplementation((method: string) => method === "thread/start"
      ? response.promise
      : Promise.resolve(method === "thread/list" ? { data: [], nextCursor: null } : {}));

    const first = store.getState().newThread();
    const second = store.getState().newThread();
    expect(second).toBe(first);
    const calls = wire.rpc.mock.calls.filter(([method]) => method === "thread/start");
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ cwd: "P", clientOperationId: expect.stringMatching(/^[a-f0-9-]{36}$/i) });
    expect(localStorage.getItem("codex-harness-thread-create-operation-v1")).toContain(calls[0][1].clientOperationId);

    response.resolve({ thread: thread("single"), clientOperationId: calls[0][1].clientOperationId });
    await expect(Promise.all([first, second])).resolves.toEqual(["single", "single"]);
    expect(store.getState().activeThreadId).toBe("single");
  });

  it("blocks duplicate creation after an unknown response and reconciles the exact receipt without resending", async () => {
    store.setState({ activeThreadId: null });
    wire.rpc.mockRejectedValueOnce(Object.assign(new Error("socket closed"), { delivery: "unknown" }));
    await expect(store.getState().newThread()).rejects.toThrow("结果未知");
    const operation = store.getState().threadCreateOperation!;
    expect(operation).toMatchObject({ state: "unknown", cwd: "P" });
    expect(localStorage.getItem("codex-harness-thread-create-operation-v1")).toContain(operation.clientOperationId);

    await expect(store.getState().newThread()).rejects.toThrow("请先核对状态");
    expect(wire.rpc.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(1);
    wire.rpc.mockResolvedValueOnce({ state: "accepted", cwd: "P", threadId: "reconciled" });
    await store.getState().checkThreadCreateOperation();
    expect(wire.rpc).toHaveBeenCalledWith("thread/start/operation", { clientOperationId: operation.clientOperationId });
    expect(store.getState()).toMatchObject({ activeThreadId: "reconciled", threadCreateOperation: { state: "accepted", threadId: "reconciled" } });
    expect(wire.rpc.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(1);
  });

  it("requires explicit acknowledgement before replacing a persistently unknown create operation", async () => {
    store.setState({
      activeThreadId: null,
      threadCreateOperation: {
        clientOperationId: "11111111-1111-4111-8111-111111111111",
        cwd: "P",
        state: "unknown",
      },
    });
    expect(store.getState().acknowledgeUnknownThreadCreate("wrong-id")).toBe(false);
    expect(store.getState().acknowledgeUnknownThreadCreate("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(store.getState().threadCreateOperation?.state).toBe("acknowledged_unknown");
    expect(localStorage.getItem("codex-harness-thread-create-operation-v1")).toContain("acknowledged_unknown");
  });

  it("keeps global and config warnings visible in a bounded dismissible queue", () => {
    notify({ method: "warning", params: { threadId: null, message: "global warning" } });
    notify({ method: "warning", params: { threadId: "T", message: "thread warning" } });
    for (let index = 0; index < 25; index++) {
      notify({ method: "configWarning", params: { summary: `config-${index}`, details: "d".repeat(4_000) } } as any);
    }
    expect(store.getState().globalWarnings).toHaveLength(20);
    expect(store.getState().globalWarnings.at(-1)?.message).toContain("config-24");
    expect(store.getState().globalWarnings.every((warning) => warning.message.length <= 3_000)).toBe(true);
    expect(store.getState().items.T.some((item) => item.type === "errorItem" && item.message.includes("thread warning"))).toBe(true);
    const id = store.getState().globalWarnings[0].id;
    store.getState().dismissGlobalWarning(id);
    expect(store.getState().globalWarnings.some((warning) => warning.id === id)).toBe(false);
  });

  it("pushes user thread navigation and follows popstate without creating another history entry", async () => {
    await store.getState().openThread("A");
    expect(history.pushState).toHaveBeenCalledOnce();
    const locationState = location as unknown as { href: string; search: string };
    locationState.href = "http://localhost/?threadId=B";
    locationState.search = "?threadId=B";
    for (const handler of popstateHandlers) handler();
    await settle();
    expect(store.getState().activeThreadId).toBe("B");
    expect(history.pushState).toHaveBeenCalledOnce();

    locationState.href = "http://localhost/";
    locationState.search = "";
    for (const handler of popstateHandlers) handler();
    expect(store.getState().activeThreadId).toBeNull();
    expect(history.pushState).toHaveBeenCalledOnce();
  });
});
