import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Timeline } from "../src/components/Timeline";

const view = vi.hoisted(() => ({
  activeThreadId: "T", historyLoading: {}, items: {} as Record<string, unknown[]>,
  display: { fileChanges: true }, plan: {}, approvals: [] as unknown[], sessions: [], inputRequests: [],
  approvalSubmissions: {}, approvalErrors: {}, connection: "open", decideApproval: vi.fn(), openThread: vi.fn(),
}));
vi.mock("../src/store", () => ({ useStore: (select: (state: typeof view) => unknown) => select(view) }));

function change(diff: unknown) {
  return { path: "/project/unsafe-name.html", kind: { type: "update", move_path: null }, diff };
}

function setChanges(changes: unknown[]) {
  view.items = { T: [{ type: "fileChange", id: "patch", threadId: "T", turnId: "turn", status: "inProgress", changes }] };
}

const blobs: Blob[] = [];
const anchors: Array<{ href: string; download: string; hidden: boolean; click: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }> = [];
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  view.approvals = [{ requestId: "request", method: "item/fileChange/requestApproval", params: {
    threadId: "T", turnId: "turn", itemId: "patch",
  } }];
  view.items = {}; view.decideApproval.mockReset();
  blobs.length = 0; anchors.length = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    blobs.push(blob as Blob);
    return `blob:approval-diff-${blobs.length}`;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.stubGlobal("document", {
    body: { appendChild: vi.fn() },
    createElement: vi.fn((tag: string) => {
      expect(tag).toBe("a");
      const anchor = { href: "", download: "", hidden: false, click: vi.fn(), remove: vi.fn() };
      anchors.push(anchor);
      return anchor;
    }),
  });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function mount() {
  act(() => { renderer = create(<Timeline />); });
  return renderer!;
}

function downloadButton() {
  return renderer!.root.findByProps({ "aria-label": "下载 /project/unsafe-name.html 的完整 Diff 文本" });
}

describe("complete bounded file-approval diff downloads", () => {
  it.each([
    ["characters", "+" + "x".repeat(1024 * 1024) + "\n+complete_tail_终点();"],
    ["lines", "+ok\n".repeat(10_001) + "+complete_tail_终点();"],
  ])("downloads the exact raw suffix beyond the unchanged preview budget (%s)", async (_limit, diff) => {
    setChanges([change(diff)]);
    const tree = mount();
    const actions = tree.root.findByProps({ className: "approval-actions" }).findAllByType("button");
    expect(actions.map((button) => button.props.disabled)).toEqual([false, false, false]);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    for (let attempt = 0; attempt < 10; attempt++) {
      const reveal = tree.root.findAllByType("button").find((button) => button.props.children === "继续显示 Diff");
      if (!reveal) break;
      act(() => reveal.props.onClick());
    }
    expect(JSON.stringify(tree.toJSON())).not.toContain("complete_tail");
    expect(JSON.stringify(tree.toJSON())).toContain("已达到浏览器 Diff 显示预算");
    expect(tree.root.findAllByType("button").some((button) => button.props.children === "继续显示 Diff")).toBe(false);

    act(() => downloadButton().props.onClick());
    expect(blobs).toHaveLength(1);
    expect(blobs[0].type).toBe("text/plain;charset=utf-8");
    expect(await blobs[0].text()).toBe(diff);
    expect(anchors[0]).toMatchObject({ href: "blob:approval-diff-1", download: "codex-harness-approval-diff.txt", hidden: true });
    expect(anchors[0].click).toHaveBeenCalledOnce();
    expect(anchors[0].remove).toHaveBeenCalledOnce();
    expect(view.decideApproval).not.toHaveBeenCalled();

    act(() => tree.update(<Timeline />));
    act(() => downloadButton().props.onClick());
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(anchors[1].href).toBe(anchors[0].href);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    act(() => tree.unmount()); renderer = undefined;
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:approval-diff-1");
  });

  it("revokes replaced text and removes downloads when its approval context becomes invalid", async () => {
    setChanges([change("+before")]);
    const tree = mount();
    act(() => downloadButton().props.onClick());
    setChanges([change("+after")]);
    act(() => tree.update(<Timeline />));
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:approval-diff-1");
    act(() => downloadButton().props.onClick());
    expect(await blobs[1].text()).toBe("+after");

    setChanges([change({ invalid: true })]);
    act(() => tree.update(<Timeline />));
    expect(tree.root.findAllByType("button").some((button) => button.props.children === "下载完整 Diff 文本")).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenLastCalledWith("blob:approval-diff-2");
    expect(tree.root.findByProps({ className: "approval-actions" }).findAllByType("button").map((button) => button.props.disabled))
      .toEqual([true, true, false]);
  });

  it.each([
    ["malformed diff", [change({ invalid: true })]],
    ["oversized diff", [change("x".repeat(2 * 1024 * 1024 + 1))]],
    ["oversized aggregate", [change("a".repeat(1024 * 1024)), change("b".repeat(1024 * 1024 + 1))]],
  ])("offers neither download nor acceptance for %s", (_label, changes) => {
    setChanges(changes);
    const tree = mount();
    expect(tree.root.findAllByType("button").some((button) => button.props.children === "下载完整 Diff 文本")).toBe(false);
    expect(tree.root.findByProps({ className: "approval-actions" }).findAllByType("button").map((button) => button.props.disabled))
      .toEqual([true, true, false]);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("does not expose downloads for unrelated historical file changes", () => {
    view.approvals = [];
    setChanges([change("x".repeat(2 * 1024 * 1024 + 1))]);
    const tree = mount();
    expect(tree.root.findAllByType("button").some((button) => button.props.children === "下载完整 Diff 文本")).toBe(false);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("shows a retryable download failure without submitting an approval", () => {
    setChanges([change("+complete")]);
    const tree = mount();
    vi.mocked(URL.createObjectURL).mockImplementationOnce(() => { throw new Error("unavailable"); });
    act(() => downloadButton().props.onClick());
    expect(tree.root.findByProps({ role: "alert" }).props.children).toContain("下载失败");
    expect(view.decideApproval).not.toHaveBeenCalled();
    act(() => downloadButton().props.onClick());
    expect(anchors[0].click).toHaveBeenCalledOnce();
    expect(tree.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  });
});
