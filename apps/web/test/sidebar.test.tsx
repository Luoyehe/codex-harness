import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "./fixtures";

const model = vi.hoisted(() => ({
  projects: [], currentProject: "/root/project", sessions: [], activeThreadId: null,
  projectsLoad: { state: "loaded" as "loading" | "loaded" | "error", error: null as string | null },
  sessionCursor: null, sessionLoading: false, sessionLoadingMore: false,
  sessionLoad: { state: "loaded" as "loading" | "loaded" | "error", error: null as string | null },
  sessionSearch: "", sessionArchived: false, workspaceRoot: "/root/project",
  selectProject: vi.fn(), openThread: vi.fn(), newThread: vi.fn(), removeProject: vi.fn(),
  loadMoreSessions: vi.fn(), setSessionSearch: vi.fn(), setSessionArchived: vi.fn(), addProject: vi.fn(),
  refresh: vi.fn(), refreshProjects: vi.fn(), refreshSessions: vi.fn(),
  renameThread: vi.fn(), archiveThread: vi.fn(), deleteThread: vi.fn(), unarchiveThread: vi.fn(),
  threadCreateOperation: null as null | { clientOperationId: string; cwd: string; state: string; error?: string; threadId?: string },
  checkThreadCreateOperation: vi.fn(), acknowledgeUnknownThreadCreate: vi.fn(),
}));
const wire = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../src/store", () => ({ useStore: (selector: (state: typeof model) => unknown) => selector(model) }));
vi.mock("../src/api/ws", () => ({ gateway: { rpc: (...args: unknown[]) => wire.rpc(...args) } }));

import { Sidebar, parentOf } from "../src/components/Sidebar";

const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };

describe("project picker async ownership", () => {
  let view: ReactTestRenderer;

  beforeEach(() => {
    wire.rpc.mockReset();
    model.addProject.mockReset(); model.selectProject.mockReset();
    act(() => { view = create(<Sidebar />); });
    act(() => view.root.findByProps({ title: "添加项目" }).props.onClick());
  });

  afterEach(() => act(() => view.unmount()));

  it("does not let an older directory response overwrite a newer navigation", async () => {
    const child = deferred<unknown>();
    const parent = deferred<unknown>();
    wire.rpc.mockImplementation((_method: string, params: { path: string }) => {
      if (params.path === "/root") return Promise.resolve({ entries: [{ fileName: "child", isDirectory: true }] });
      if (params.path === "/root/child") return child.promise;
      if (params.path === "/") return parent.promise;
      return Promise.reject(new Error(`unexpected path ${params.path}`));
    });

    await act(async () => {
      view.root.findAllByType("button").find(node => node.props.children === "浏览目录")!.props.onClick();
      await settle();
    });
    act(() => view.root.findByProps({ className: "dir-entry" }).props.onClick());
    act(() => view.root.findAllByType("button").find(node => node.props.children === "↑ 上级")!.props.onClick());
    await act(async () => {
      parent.resolve({ entries: [{ fileName: "fresh", isDirectory: true }] });
      await settle();
      child.resolve({ entries: [{ fileName: "stale", isDirectory: true }] });
      await settle();
    });

    expect(view.root.findByProps({ className: "dir-browser-path" }).props.children).toBe("/");
    expect(view.root.findAllByProps({ className: "dir-entry" }).map(node => node.props.children.join(""))).toEqual(["📁 fresh"]);
  });

  it("admits a rapid double-click only once while project selection is pending", async () => {
    const adding = deferred<void>();
    model.addProject.mockReturnValue(adding.promise);
    model.selectProject.mockResolvedValue(undefined);
    act(() => view.root.findByProps({ className: "text-input" }).props.onChange({ target: { value: "/new-project" } }));
    const add = view.root.findAllByType("button").find(node => node.props.children === "添加")!;
    act(() => { add.props.onClick(); add.props.onClick(); });
    expect(model.addProject).toHaveBeenCalledExactlyOnceWith("/new-project", false);
    await act(async () => { adding.resolve(); await settle(); });
    expect(model.selectProject).toHaveBeenCalledExactlyOnceWith("/new-project");
  });

  it("reports a malformed directory response instead of presenting an empty folder", async () => {
    wire.rpc.mockResolvedValue({ unexpected: true });
    await act(async () => {
      view.root.findAllByType("button").find(node => node.props.children === "浏览目录")!.props.onClick();
      await settle();
    });
    expect(view.root.findByProps({ className: "error-text" }).props.children).toContain("目录列表格式无效");
    expect(view.root.findAllByProps({ className: "dir-browser" })).toHaveLength(0);
  });

  it("bounds directory inspection before touching an untrusted tail", async () => {
    const entries: unknown[] = [{ fileName: "safe", isDirectory: true }];
    entries.length = 20_001;
    Object.defineProperty(entries, "20000", { get: () => { throw new Error("directory tail inspected"); } });
    wire.rpc.mockResolvedValue({ entries });
    await act(async () => {
      view.root.findAllByType("button").find(node => node.props.children === "浏览目录")!.props.onClick();
      await settle();
    });
    expect(view.root.findAllByProps({ className: "dir-entry" }).map(node => node.props.children.join(""))).toEqual(["📁 safe"]);
  });
});

describe("project picker path navigation", () => {
  it("keeps Unix and Windows drive roots stable when navigating upward", () => {
    expect(parentOf("/")).toBe("/");
    expect(parentOf("C:\\")).toBe("C:\\");
    expect(parentOf("C:\\project")).toBe("C:\\");
  });
});

describe("sidebar write admission", () => {
  it("does not present failed project and session reads as confirmed empty lists and exposes retries", () => {
    model.projectsLoad = { state: "error", error: "项目读取失败" };
    model.sessionLoad = { state: "error", error: "会话读取失败" };
    model.refreshProjects.mockReset(); model.refresh.mockReset();
    let view!: ReactTestRenderer;
    act(() => { view = create(<Sidebar />); });
    const rendered = JSON.stringify(view.toJSON());
    expect(rendered).toContain("项目读取失败");
    expect(rendered).toContain("会话读取失败");
    expect(rendered).not.toContain("尚未添加项目");
    expect(rendered).not.toContain("当前项目还没有会话");
    const retries = view.root.findAllByType("button").filter((button) => button.props.children === "重试");
    act(() => { retries[0].props.onClick(); retries[1].props.onClick(); });
    expect(model.refreshProjects).toHaveBeenCalledOnce();
    expect(model.refresh).toHaveBeenCalledOnce();
    act(() => view.unmount());
    model.projectsLoad = { state: "loaded", error: null };
    model.sessionLoad = { state: "loaded", error: null };
  });

  it("shows a failed session action on its row, unlocks it, and permits a retry", async () => {
    model.sessions = [{ threadId: "T", title: "Original", updatedAt: 1 }] as never[];
    model.archiveThread.mockReset();
    model.archiveThread.mockRejectedValueOnce(new Error("synthetic archive failure"));
    let view!: ReactTestRenderer;
    act(() => { view = create(<Sidebar />); });
    const archive = view.root.findByProps({ title: "归档" });
    act(() => { archive.props.onClick(); archive.props.onClick(); });
    await act(async () => { await settle(); });
    expect(model.archiveThread).toHaveBeenCalledExactlyOnceWith("T");
    expect(view.root.findByProps({ role: "alert" }).props.children).toContain("synthetic archive failure");
    expect(view.root.findByProps({ title: "归档" }).props.disabled).toBe(false);
    model.archiveThread.mockResolvedValueOnce(undefined);
    act(() => view.root.findByProps({ title: "归档" }).props.onClick());
    await act(async () => { await settle(); });
    expect(model.archiveThread).toHaveBeenCalledTimes(2);
    act(() => view.unmount());
    model.sessions = [];
  });

  it("guards each project removal, reports its failure inline, and permits retry", async () => {
    model.projects = [
      { path: "/root/project", addedAt: 1, lastUsedAt: 1, available: true },
      { path: "/root/other", addedAt: 1, lastUsedAt: 1, available: true },
    ] as never[];
    model.removeProject.mockReset();
    model.removeProject.mockRejectedValueOnce(new Error("synthetic remove failure"));
    vi.stubGlobal("confirm", vi.fn(() => true));
    let view!: ReactTestRenderer;
    act(() => { view = create(<Sidebar />); });
    const remove = view.root.findAllByProps({ title: "移除注册（不删除文件）" })[0];
    const event = { stopPropagation: vi.fn() };
    act(() => { remove.props.onClick(event); remove.props.onClick(event); });
    await act(async () => { await settle(); });
    expect(model.removeProject).toHaveBeenCalledExactlyOnceWith("/root/project");
    expect(view.root.findByProps({ role: "alert" }).props.children).toContain("synthetic remove failure");
    expect(view.root.findAllByProps({ title: "移除注册（不删除文件）" })[0].props.disabled).toBe(false);
    model.removeProject.mockResolvedValueOnce(undefined);
    act(() => view.root.findAllByProps({ title: "移除注册（不删除文件）" })[0].props.onClick(event));
    await act(async () => { await settle(); });
    expect(model.removeProject).toHaveBeenCalledTimes(2);
    act(() => view.unmount());
    model.projects = [];
    vi.unstubAllGlobals();
  });

  it("creates only one conversation when the new button is clicked rapidly", async () => {
    const creating = deferred<string | null>();
    model.newThread.mockReset();
    model.newThread.mockReturnValue(creating.promise);
    let view!: ReactTestRenderer;
    act(() => { view = create(<Sidebar />); });
    const button = view.root.findByProps({ className: "sb-new" });
    act(() => { button.props.onClick(); button.props.onClick(); });
    expect(model.newThread).toHaveBeenCalledTimes(1);
    expect(view.root.findByProps({ className: "sb-new" }).props.disabled).toBe(true);
    await act(async () => { creating.resolve("new"); await settle(); });
    expect(view.root.findByProps({ className: "sb-new" }).props.disabled).toBe(false);
    act(() => view.unmount());
  });

  it("surfaces a failed standalone conversation creation without an unhandled rejection", async () => {
    model.newThread.mockReset();
    model.newThread.mockRejectedValue(new Error("synthetic create failure"));
    let view!: ReactTestRenderer;
    act(() => { view = create(<Sidebar />); });
    await act(async () => {
      view.root.findByProps({ className: "sb-new" }).props.onClick();
      await settle();
    });
    expect(view.root.find((node) => typeof node.props.className === "string" && node.props.className.includes("sb-create-error")).props.children).toContain("synthetic create failure");
    expect(view.root.findByProps({ className: "sb-new" }).props.disabled).toBe(false);
    act(() => view.unmount());
  });

  it("shows an unknown create receipt, blocks duplicates, and exposes bounded reconciliation controls", () => {
    model.threadCreateOperation = {
      clientOperationId: "11111111-1111-4111-8111-111111111111",
      cwd: "/root/project",
      state: "unknown",
      error: "创建响应丢失；结果未知",
    };
    model.checkThreadCreateOperation.mockReset();
    model.acknowledgeUnknownThreadCreate.mockReset();
    let view!: ReactTestRenderer;
    act(() => { view = create(<Sidebar />); });
    expect(JSON.stringify(view.toJSON())).toContain("创建响应丢失；结果未知");
    expect(view.root.findByProps({ className: "sb-new" }).props.disabled).toBe(true);
    act(() => view.root.findAllByType("button").find((button) => button.props.children === "核对创建状态")!.props.onClick());
    act(() => view.root.findAllByType("button").find((button) => button.props.children === "已核对列表，允许重试")!.props.onClick());
    expect(model.checkThreadCreateOperation).toHaveBeenCalledOnce();
    expect(model.acknowledgeUnknownThreadCreate).toHaveBeenCalledExactlyOnceWith("11111111-1111-4111-8111-111111111111");
    act(() => view.unmount());
    model.threadCreateOperation = null;
  });

  it("does not commit an escaped rename or submit the same row action twice", async () => {
    const archiving = deferred<void>();
    model.sessions = [{ threadId: "T", title: "Original", updatedAt: 1 }] as never[];
    model.renameThread.mockReset(); model.archiveThread.mockReset();
    model.archiveThread.mockReturnValue(archiving.promise);
    let view!: ReactTestRenderer;
    act(() => { view = create(<Sidebar />); });
    act(() => view.root.findByProps({ title: "重命名" }).props.onClick());
    const input = view.root.findByProps({ className: "sb-rename" });
    act(() => input.props.onChange({ target: { value: "Should not be saved" } }));
    act(() => { input.props.onKeyDown({ key: "Escape" }); input.props.onBlur(); });
    expect(model.renameThread).not.toHaveBeenCalled();
    const archive = view.root.findByProps({ title: "归档" });
    act(() => { archive.props.onClick(); archive.props.onClick(); });
    expect(model.archiveThread).toHaveBeenCalledExactlyOnceWith("T");
    await act(async () => { archiving.resolve(); await settle(); });
    act(() => view.unmount());
    model.sessions = [];
  });
});
