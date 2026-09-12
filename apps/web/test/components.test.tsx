import css from "../src/styles.css?raw";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestPermissionProfile } from "../../../protocol/v2/RequestPermissionProfile";
import { describePermissions } from "../src/utils/permissions";
import { Drawer } from "../src/components/Drawer";
import { ItemView, PermissionsSummary, Timeline } from "../src/components/Timeline";

const view = vi.hoisted(() => ({
  drawerTab: null as "diff" | "terminal" | null,
  setDrawerTab(tab: "diff" | "terminal" | null) { view.drawerTab = tab; },
  activeThreadId: null as string | null,
  currentProject: "P", connection: "open", turnDiff: {}, items: {}, plan: {}, display: {},
  approvals: [] as unknown[], sessions: [],
}));
vi.mock("../src/store", () => ({ useStore: (select: (state: typeof view) => unknown) => select(view) }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));

type ButtonProps = { children?: ReactNode; onClick?: () => void };
function buttons(node: ReactNode): ReactElement<ButtonProps>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement<ButtonProps>(node)) return [];
  return [...(node.type === "button" ? [node] : []), ...buttons(node.props.children)];
}

beforeEach(() => { view.drawerTab = null; view.activeThreadId = null; view.approvals = []; view.items = {}; });

describe("reachable drawer controls", () => {
  it("keeps initial controls visible and opens/closes each panel through the rendered buttons", () => {
    expect(css.match(/\.drawer\s*\{([^}]+)\}/)?.[1]).toMatch(/display:\s*flex/);
    expect(renderToStaticMarkup(<Drawer />)).toContain("改动 Diff");
    buttons(Drawer())[0].props.onClick?.();
    expect(view.drawerTab).toBe("diff");
    expect(renderToStaticMarkup(<Drawer />)).toContain("当前会话还没有文件改动");
    buttons(Drawer())[1].props.onClick?.();
    expect(view.drawerTab).toBe("terminal");
    expect(renderToStaticMarkup(<Drawer />)).toContain("新终端");
    buttons(Drawer())[1].props.onClick?.();
    expect(view.drawerTab).toBeNull();
    expect(renderToStaticMarkup(<Drawer />)).toContain("改动 Diff");
  });
});

describe("permission and output rendering", () => {
  it("shows every entries-only permission, including glob and special scopes", () => {
    const profile: RequestPermissionProfile = {
      network: null,
      fileSystem: { read: null, write: null, entries: [
        { access: "write", path: { type: "path", path: "/private/full-access" } },
        { access: "read", path: { type: "glob_pattern", pattern: "/project/**/*.md" } },
        { access: "write", path: { type: "special", value: { kind: "root" } } },
      ] },
    };
    const html = renderToStaticMarkup(<PermissionsSummary profile={profile} />);
    expect(html).toContain("写入: /private/full-access"); expect(html).toContain("/project/**/*.md");
    expect(html).toContain("写入: 整个文件系统"); expect(html).not.toContain("未请求");
    expect(describePermissions(profile).valid).toBe(true);
  });

  it("never labels unknown permission structures as an empty grant", () => {
    const profile: RequestPermissionProfile = { network: null, fileSystem: { read: null, write: null, entries: [
      { access: "write", path: { type: "special", value: { kind: "unknown", path: "new-scope", subpath: null } } },
    ] } };
    expect(describePermissions(profile).valid).toBe(false);
    const html = renderToStaticMarkup(<PermissionsSummary profile={profile} />);
    expect(html).toContain("已禁用批准"); expect(html).toContain("new-scope"); expect(html).not.toContain("未请求");
  });

  it.each([
    "[]", "false", "0", '""',
    ...["network", "fileSystem"].flatMap((field) => [[], false, 0, ""].map((value) => JSON.stringify({ [field]: value }))),
  ])("disables both approval actions for malformed runtime permissions %s", (serialized) => {
    // Intentionally cross the JSON boundary with invalid server data; the
    // generated compile-time type alone cannot validate wire values.
    const profile: RequestPermissionProfile = JSON.parse(serialized);
    expect(describePermissions(profile).valid).toBe(false);
    view.activeThreadId = "T";
    view.approvals = [{ requestId: "invalid", method: "item/permissions/requestApproval", params: { threadId: "T", permissions: profile } }];
    const html = renderToStaticMarkup(<Timeline />);
    expect(html).toContain("已禁用批准");
    expect(html).not.toContain("未请求额外文件系统/网络权限");
    expect(html.match(/<button[^>]*disabled=""[^>]*>/g)).toHaveLength(2);
    expect(html).toMatch(/<button class="btn-danger">拒绝<\/button>/);
  });

  it.each(["{}", '{"network":null,"fileSystem":null}', '{"network":null}'])("preserves absent and null permission fields %s", (serialized) => {
    const profile: RequestPermissionProfile = JSON.parse(serialized);
    expect(describePermissions(profile)).toEqual({ valid: true, rows: ["未请求额外文件系统/网络权限"] });
  });

  it("does not truncate the set of paths shown for approval", () => {
    const profile: RequestPermissionProfile = { network: null, fileSystem: { read: null, write: Array.from({ length: 8 }, (_, i) => `/path-${i}`) } };
    expect(renderToStaticMarkup(<PermissionsSummary profile={profile} />)).toContain("/path-7");
  });

  it("shows background approvals even when no conversation is selected", () => {
    view.approvals = [{ requestId: "req", method: "item/commandExecution/requestApproval", params: { threadId: "background", command: "pwd" } }];
    expect(renderToStaticMarkup(<Timeline />)).toContain("等待审批");
  });

  it("keeps approval controls and background counts outside a long conversation's scroll container", () => {
    view.activeThreadId = "T";
    view.items = { T: Array.from({ length: 200 }, (_, i) => ({ type: "localUserMessage", id: `message-${i}`, text: `message-${i}`, attachments: [] })) };
    view.approvals = [
      { requestId: "own", method: "item/commandExecution/requestApproval", params: { threadId: "T", command: "synthetic command" } },
      { requestId: "background", method: "item/commandExecution/requestApproval", params: { threadId: "B", command: "synthetic command" } },
    ];
    const html = renderToStaticMarkup(<Timeline />);
    expect(html).toContain('aria-label="待处理审批"');
    expect(html).toContain("等待审批：2 项（后台会话 1 项）");
    expect(html).toContain("message-199");
    expect(html.indexOf("请求执行命令")).toBeLessThan(html.indexOf("后台会话「"));
    expect(html.indexOf("批准")).toBeLessThan(html.indexOf('<div class="timeline"'));
    expect(html.indexOf("</section>")).toBeLessThan(html.indexOf('<div class="timeline"'));
    expect(css.match(/\.approval-dock\s*\{([^}]+)\}/)?.[1]).toMatch(/max-height:/);
    expect(css.match(/\.approval-dock-count\s*\{([^}]+)\}/)?.[1]).toMatch(/position:\s*sticky/);
  });

  it("renders a saved plan independently of the live structured progress card", () => {
    expect(renderToStaticMarkup(<ItemView item={{ type: "plan", id: "p", text: "First inspect the project, then implement the fix." }} />)).toContain("First inspect the project");
  });

  it("distinguishes pending/failed compaction and displays generated image output or failures", () => {
    const pending = renderToStaticMarkup(<ItemView item={{ type: "compactionProgress", id: "c", status: "inProgress", message: "正在自动压缩…" }} />);
    expect(pending).toContain("正在自动压缩"); expect(pending).not.toContain("已释放");
    const failed = renderToStaticMarkup(<ItemView item={{ type: "compactionProgress", id: "c", status: "failed", message: "自动压缩失败: timeout" }} />);
    expect(failed).toContain("timeout");
    const image = renderToStaticMarkup(<ItemView item={{ type: "imageGeneration", id: "g", status: "completed", result: "", savedPath: "/outputs/result.png", failure: null, revisedPrompt: null }} />);
    expect(image).toContain("/outputs/result.png");
    const failure = renderToStaticMarkup(<ItemView item={{ type: "imageGeneration", id: "g", status: "failed", result: "", revisedPrompt: null, failure: { type: "usageLimitExceeded", limitId: "images", resetsAt: null } }} />);
    expect(failure).toContain("图像生成失败"); expect(failure).toContain("usageLimitExceeded");
  });
});
