import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayNotification, GatewayServerRequest } from "../src/api/protocol";
import type { SendOperation } from "../src/store";
import { deferred, thread } from "./fixtures";

const wire = vi.hoisted(() => ({
  rpc: vi.fn(),
  notification: (_event: GatewayNotification) => {},
  serverRequest: (_request: GatewayServerRequest) => {},
}));
vi.mock("../src/api/ws", () => ({ gateway: {
  generation: 1, state: "closed", rpc: (...args: unknown[]) => wire.rpc(...args),
  request: (...args: unknown[]) => wire.rpc(...args), respondServerRequest: () => true,
  onNotification(handler: typeof wire.notification) { wire.notification = handler; return () => {}; },
  setServerRequestHandler(handler: typeof wire.serverRequest) { wire.serverRequest = handler; },
  onStateChange(handler: (state: string) => void) { handler("closed"); return () => {}; },
  connect() {},
} }));

let store: (typeof import("../src/store"))["useStore"];
let view: ReactTestRenderer;
let delivery: ReturnType<typeof deferred<unknown>>;
const storageHandlers = new Set<(event: { key: string; newValue: string }) => void>();
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const text = () => view.root.findByType("textarea").props.value;
const attachmentNames = () => view.root.findAllByProps({ className: "attach-name" }).map(node => node.props.children);
const button = (label: string) => view.root.findAllByType("button").find(node => node.props.children === label)!;
const sendButton = () => view.root.findByProps({ className: "btn-primary" });
const notice = () => view.root.findAllByProps({ className: "attach-chip attach-error" }).map(node => node.props.children).join(" ");
const turnCalls = () => wire.rpc.mock.calls.filter(([method]) => method === "turn/start");
const edit = (value: string) => act(() => view.root.findByType("textarea").props.onChange({ target: { value } }));
const navigate = (threadId: string) => act(() => { void store.getState().openThread(threadId); });
const submit = () => act(() => sendButton().props.onClick());
async function upload(name: string) {
  await act(async () => {
    view.root.findByType("input").props.onChange({ target: { files: [new File(["synthetic"], name, { type: "image/png" })] } });
    await settle();
  });
}
async function loseResponse() {
  await act(async () => { delivery.reject(new Error("synthetic connection closed")); await settle(); });
}
function operation(threadId = "A") { return store.getState().sendOperations[threadId]; }
function setOperation(state: SendOperation["state"], threadId = "A") {
  act(() => store.setState(current => ({ sendOperations: { ...current.sendOperations, [threadId]: { ...current.sendOperations[threadId], state } } })));
}
function assertNoReplay() { expect(turnCalls()).toHaveLength(1); }
function acknowledgeElsewhere(threadId = "A") {
  const acknowledged = { ...operation(threadId), state: "acknowledged_unknown" as const };
  const key = `codex-harness-pending-operation-v1:${acknowledged.clientOperationId}`;
  const newValue = JSON.stringify(acknowledged);
  act(() => {
    localStorage.setItem(key, newValue);
    for (const handler of storageHandlers) handler({ key, newValue });
  });
}

beforeEach(async () => {
  vi.resetModules();
  storageHandlers.clear();
  delivery = deferred<unknown>();
  wire.rpc.mockReset();
  wire.rpc.mockImplementation(async (method: string, params?: { threadId?: string; name?: string }) => {
    if (method === "turn/start") return delivery.promise;
    if (method === "thread/start") return { thread: thread("created") };
    if (method === "thread/read" || method === "thread/resume") return { thread: thread(params?.threadId ?? "A") };
    if (method === "thread/list") return { data: [], nextCursor: null };
    if (method === "attachment/upload") return { path: `/uploads/${params?.name}`, size: 9 };
    return {};
  });
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    get length() { return storage.size; }, key: (index: number) => [...storage.keys()][index] ?? null,
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal("window", { setTimeout, clearTimeout, matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener(name: string, handler: (event: { key: string; newValue: string }) => void) { if (name === "storage") storageHandlers.add(handler); } });
  vi.stubGlobal("document", { documentElement: { classList: { toggle() {} } } });
  vi.stubGlobal("location", { href: "http://localhost/", search: "" });
  vi.stubGlobal("history", { replaceState: vi.fn() });
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal("FileReader", class {
    result = "data:image/png;base64,c3ludGhldGlj";
    onload?: () => void;
    readAsDataURL() { this.onload?.(); }
  });
  vi.spyOn(URL, "createObjectURL").mockImplementation(blob => `blob:${(blob as File).name}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  store = (await import("../src/store")).useStore;
  store.getState().bootstrap();
  store.setState({ activeThreadId: "A", currentProject: "P", connection: "open", historyLoaded: { A: true, B: true }, management: { state: "idle" } });
  const { Composer } = await import("../src/components/Composer");
  act(() => { view = create(createElement(Composer)); });
});

afterEach(() => { act(() => view?.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Composer send ownership through the real store", () => {
  it.each([false, true])("clears exactly the admitted draft after lost response and accepted lookup (switch=%s)", async switched => {
    edit("execute exactly once"); await upload("original.png"); submit();
    const identity = operation();
    expect(turnCalls()[0][1]).toMatchObject({ threadId: "A", clientOperationId: identity.clientOperationId });
    if (switched) navigate("B");
    await loseResponse();
    expect(text()).toBe("execute exactly once");
    expect(notice()).toContain("发送结果待确认");
    expect(sendButton().props.disabled).toBe(true);
    // Even an invoked key handler cannot bypass the background draft's lock.
    act(() => view.root.findByType("textarea").props.onKeyDown({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: false }, preventDefault() {} }));
    assertNoReplay();
    wire.rpc.mockResolvedValueOnce({ state: "accepted" });
    await act(async () => { button("核对发送状态").props.onClick(); await settle(); });
    expect(wire.rpc).toHaveBeenLastCalledWith("turn/operation", { clientOperationId: identity.clientOperationId });
    if (switched) navigate("A");
    expect(text()).toBe(""); expect(attachmentNames()).toEqual([]);
    expect(notice()).toContain("已被服务器受理"); expect(notice()).not.toContain("发送失败");
    assertNoReplay();
  });

  it("binds a newly created thread's actual operation before navigation and rejection", async () => {
    act(() => store.setState({ activeThreadId: null }));
    edit("new-thread instruction");
    await act(async () => { submit(); await settle(); });
    expect(store.getState().activeThreadId).toBe("created");
    const identity = operation("created");
    expect(turnCalls()[0][1]).toMatchObject({ threadId: "created", clientOperationId: identity.clientOperationId });
    navigate("B"); await loseResponse();
    expect(sendButton().props.disabled).toBe(true);
    setOperation("accepted", "created");
    expect(text()).toBe(""); expect(notice()).not.toContain("发送失败"); assertNoReplay();
  });

  it("preserves the unsent draft when navigation cancels first-thread creation", async () => {
    const creation = deferred<unknown>();
    wire.rpc.mockImplementationOnce(() => creation.promise);
    act(() => store.setState({ activeThreadId: null }));
    edit("not yet submitted"); submit(); navigate("B");
    await act(async () => { creation.resolve({ thread: thread("created") }); await settle(); });
    expect(text()).toBe("not yet submitted"); expect(turnCalls()).toHaveLength(0);
    expect(notice()).toContain("消息未发送"); expect(sendButton().props.disabled).toBe(false);
  });

  it.each(["accepted", "acknowledged_unknown"] as const)("%s keeps later text and newly uploaded attachments while releasing only captured attachments", async state => {
    edit("original"); await upload("original.png"); submit(); navigate("B"); await loseResponse();
    edit("later edit"); await upload("later.png");
    if (state === "accepted") setOperation(state);
    else act(() => button("已核对历史，放弃这次草稿").props.onClick());
    expect(text()).toBe("later edit"); expect(attachmentNames()).toEqual(["later.png"]);
    expect(sendButton().props.disabled).toBe(false); assertNoReplay();
    expect(wire.rpc.mock.calls.some(([method]) => method === "attachment/delete")).toBe(false);
    if (state === "acknowledged_unknown") expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:original.png");
    else expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("does not clear a later edit even when its text equals the captured original", async () => {
    edit("original"); submit(); navigate("B"); await loseResponse();
    edit("changed"); edit("original"); setOperation("accepted");
    expect(text()).toBe("original"); expect(notice()).toContain("已被服务器受理"); assertNoReplay();
  });

  it.each([
    ["success", "accepted"], ["failure", "accepted"],
    ["success", "acknowledged_unknown"], ["failure", "acknowledged_unknown"],
  ] as const)("ignores a late %s after background %s and a new send", async (outcome, status) => {
    edit("original"); await upload("original.png"); submit(); navigate("B");
    const old = delivery;
    // The real store subscription sees the acknowledgment even when React
    // batches it with the newer operation; no active-thread lookup is used.
    if (status === "acknowledged_unknown") acknowledgeElsewhere();
    else act(() => wire.notification({ method: "harness/turnAccepted", params: {
      threadId: "A", clientOperationId: operation().clientOperationId, turnId: "old-turn", attachments: [],
    } }));
    expect(text()).toBe(""); expect(attachmentNames()).toEqual([]);
    edit("new instruction"); delivery = deferred<unknown>(); submit();
    const newer = operation("B");
    await act(async () => { if (outcome === "success") old.resolve({}); else old.reject(new Error("late old failure")); await settle(); });
    expect(text()).toBe("new instruction"); expect(operation("B")).toEqual(newer);
    expect(notice()).not.toContain("发送失败"); expect(turnCalls()).toHaveLength(2);
    await act(async () => { delivery.resolve({}); await settle(); });
    expect(text()).toBe(""); expect(turnCalls()).toHaveLength(2);
  });

  it("preserves later edits and attachments when the acknowledgment arrives through a storage event", async () => {
    edit("old"); await upload("original.png"); submit(); navigate("B"); await loseResponse();
    edit("later"); await upload("later.png"); acknowledgeElsewhere();
    expect(text()).toBe("later"); expect(attachmentNames()).toEqual(["later.png"]);
    expect(sendButton().props.disabled).toBe(false); assertNoReplay();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:original.png");
  });

  it("ignores a late lookup for an acknowledged draft after another draft is submitted", async () => {
    edit("old"); submit(); navigate("B"); await loseResponse();
    const lookup = deferred<unknown>(); wire.rpc.mockReturnValueOnce(lookup.promise);
    act(() => button("核对发送状态").props.onClick());
    act(() => button("已核对历史，放弃这次草稿").props.onClick());
    edit("new"); delivery = deferred<unknown>(); submit();
    await act(async () => { lookup.resolve({ state: "accepted" }); await settle(); });
    expect(text()).toBe("new"); expect(operation("B").state).toBe("unknown"); expect(turnCalls()).toHaveLength(2);
  });

  it("checks the captured ID after a different tab replaces the thread's current operation", async () => {
    edit("old"); submit(); navigate("B"); await loseResponse();
    const original = operation();
    const replacement = { ...original, clientOperationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    act(() => store.setState({ sendOperations: { A: replacement } }));
    expect(sendButton().props.disabled).toBe(true);
    wire.rpc.mockResolvedValueOnce({ state: "accepted" });
    await act(async () => { button("核对发送状态").props.onClick(); await settle(); });
    expect(wire.rpc).toHaveBeenLastCalledWith("turn/operation", { clientOperationId: original.clientOperationId });
    expect(operation()).toEqual(replacement); expect(text()).toBe(""); assertNoReplay();
  });

  it("does not discard unrelated local edits when acknowledging a recovered operation with no captured draft", async () => {
    const recovered: SendOperation = { threadId: "A", clientOperationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "unknown" };
    act(() => store.setState({ sendOperations: { A: recovered } }));
    edit("unrelated new draft"); await upload("later.png");
    act(() => button("已核对历史，放弃这次草稿").props.onClick());
    expect(text()).toBe("unrelated new draft"); expect(attachmentNames()).toEqual(["later.png"]);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled(); expect(turnCalls()).toHaveLength(0);
  });

  it("preserves a definitively rejected draft and permits an explicit new submission", async () => {
    edit("rejected draft"); await upload("original.png"); submit();
    await act(async () => { delivery.reject(Object.assign(new Error("rejected"), { delivery: "rejected" })); await settle(); });
    expect(text()).toBe("rejected draft"); expect(attachmentNames()).toEqual(["original.png"]);
    expect(notice()).toContain("发送失败"); expect(sendButton().props.disabled).toBe(false); assertNoReplay();
  });
});
