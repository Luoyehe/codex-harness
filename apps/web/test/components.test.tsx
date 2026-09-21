import css from "../src/styles.css?raw";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { RequestPermissionProfile } from "../../../protocol/v2/RequestPermissionProfile";
import { describePermissions } from "../src/utils/permissions";
import { Drawer } from "../src/components/Drawer";
import { DiffView, ItemView, Markdown, MarkdownBoundary, PermissionsSummary, Timeline } from "../src/components/Timeline";
import { markdownWithinBudget, remarkBoundedTree } from "../src/utils/markdown-budget";
import { malformedNetworkApprovals, networkOnlyParams, networkProtocols } from "./network-approval-fixtures";

const view = vi.hoisted(() => ({
  drawerTab: null as "diff" | "terminal" | null,
  setDrawerTab(tab: "diff" | "terminal" | null) { view.drawerTab = tab; },
  activeThreadId: null as string | null,
  currentProject: "P", connection: "open", turnDiff: {}, items: {}, plan: {}, display: {},
  approvals: [] as unknown[], sessions: [],
  approvalSubmissions: {} as Record<string, boolean>, approvalErrors: {} as Record<string, string>,
  decideApproval: vi.fn(), openThread: vi.fn(),
  readAttachment: vi.fn(),
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

beforeEach(() => {
  view.drawerTab = null; view.activeThreadId = null; view.approvals = []; view.items = {};
  view.approvalSubmissions = {}; view.approvalErrors = {};
  view.decideApproval.mockReset(); view.openThread.mockReset(); view.readAttachment.mockReset();
});

describe("Markdown structural budgets and per-message recovery", () => {
  it.each([
    ["quotes", "> ".repeat(10_000) + "nested model response"],
    ["lists", Array.from({ length: 150 }, (_, n) => "  ".repeat(n) + "- item").join("\n")],
    ["links", "[".repeat(10_000) + "text" + "]".repeat(10_000)],
    ["emphasis", "*a ".repeat(1_000) + "text" + " a*".repeat(1_000)],
  ])("rejects deeply nested %s before invoking the parser and preserves literal content", (_kind, text) => {
    expect(text.length).toBeLessThan(200_000);
    expect(markdownWithinBudget(text)).toBe(false);
    let renderer!: ReactTestRenderer;
    expect(() => act(() => { renderer = create(<Markdown text={text} />); })).not.toThrow();
    expect(renderer.root.findByProps({ className: "markdown-plain" }).props.children).toBe(text);
    expect(JSON.stringify(renderer.toJSON())).toContain("已安全显示为纯文本");
    act(() => renderer.unmount());
  });

  it.each(["agentMessage", "userMessage", "plan"])("contains hostile Markdown in real %s timeline history", (type) => {
    const text = "> ".repeat(10_000) + "history";
    view.activeThreadId = "T";
    view.items = { T: [{ type, id: "hostile", text, content: [{ type: "text", text }] },
      { type: "agentMessage", id: "healthy", text: "**still available**" }] };
    let renderer!: ReactTestRenderer;
    expect(() => act(() => { renderer = create(<Timeline />); })).not.toThrow();
    expect(renderer.root.findByProps({ className: "markdown-plain" }).props.children).toBe(text);
    expect(renderer.root.findByType("strong").props.children).toBe("still available");
    act(() => renderer.unmount());
  });

  it("keeps ordinary GFM and large literal fenced snippets formatted", () => {
    const text = "# Heading\n\n> A quote with **bold**\n\n- first\n  - nested\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n~~done~~";
    const html = renderToStaticMarkup(<Markdown text={text} />);
    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<table>");
    expect(html).toContain("<del>done</del>");
    const shallow = Array.from({ length: 1_000 }, (_, n) => `* **item ${n}**`).join("\n");
    expect(markdownWithinBudget(shallow)).toBe(true);
    expect(renderToStaticMarkup(<Markdown text={shallow} />).match(/<strong>/g)).toHaveLength(1_000);
    for (const marker of ["```", "~~~~"]) {
      const code = `${marker}text\n${"> [*~_".repeat(20_000)}\n${marker}`;
      expect(markdownWithinBudget(code)).toBe(true);
      const rendered = renderToStaticMarkup(<Markdown text={code} />);
      expect(rendered).toContain("<pre><code");
      expect(rendered).not.toContain("markdown-plain");
    }
  });

  it("bounds a constructed AST iteratively before later recursive render traversals", () => {
    let tree: unknown = { type: "text", value: "deep" };
    for (let depth = 0; depth < 10_000; depth++) tree = { children: [tree] };
    expect(() => remarkBoundedTree()(tree)).toThrow("Markdown structure exceeds browser budget");
    expect(() => remarkBoundedTree()({ children: Array.from({ length: 20_001 }, () => ({})) })).toThrow("Markdown structure exceeds browser budget");
  });

  it("contains unexpected parser/render errors within one message and retries when its text changes", () => {
    function Broken(): never { throw new Error("synthetic renderer failure"); }
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let renderer!: ReactTestRenderer;
    try {
      act(() => { renderer = create(<div><button>停止</button><MarkdownBoundary text="literal source"><Broken /></MarkdownBoundary><Markdown text="healthy" /></div>); });
      expect(renderer.root.findByType("button").props.children).toBe("停止");
      expect(renderer.root.findByProps({ className: "markdown-plain" }).props.children).toBe("literal source");
      expect(renderer.root.findByType("p").props.children).toBe("healthy");
      act(() => renderer.update(<div><button>停止</button><MarkdownBoundary text="recovered"><strong>recovered</strong></MarkdownBoundary><Markdown text="healthy" /></div>));
      expect(renderer.root.findAllByProps({ className: "markdown-plain" })).toHaveLength(0);
      expect(renderer.root.findByType("strong").props.children).toBe("recovered");
    } finally {
      act(() => renderer?.unmount());
      errors.mockRestore();
    }
  });
});

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

  it("fails closed when a permission profile exceeds the safe rendering budget", () => {
    const profile: RequestPermissionProfile = { network: null, fileSystem: {
      read: null, write: Array.from({ length: 1_001 }, (_, index) => `/path-${index}`),
    } };
    expect(describePermissions(profile).valid).toBe(false);
    expect(renderToStaticMarkup(<PermissionsSummary profile={profile} />)).toContain("已禁用批准");
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

  it("shows the execution directory, network target, and requested session write root before approval", () => {
    view.activeThreadId = "T";
    view.approvals = [
      { requestId: "command", method: "item/commandExecution/requestApproval", params: {
        threadId: "T", command: "curl https://api.example.test", cwd: "/srv/private-project",
        networkApprovalContext: { protocol: "https", host: "api.example.test" },
        proposedNetworkPolicyAmendments: [{ action: "allow", host: "api.example.test" }],
      } },
      { requestId: "files", method: "item/fileChange/requestApproval", params: {
        threadId: "T", itemId: "file-change", grantRoot: "/srv/shared-output",
      } },
    ];
    const html = renderToStaticMarkup(<Timeline />);
    expect(html).toContain("工作目录"); expect(html).toContain("/srv/private-project");
    expect(html).toContain("网络目标"); expect(html).toContain("https://api.example.test");
    expect(html).toContain("会话写入授权根目录"); expect(html).toContain("/srv/shared-output");
    expect(html).toContain("后续网络规则"); expect(html).toContain("allow api.example.test");
  });

  it.each(networkProtocols.flatMap(protocol => [null, undefined].map(command => ({ protocol, command }))))(
    "renders complete network-only $protocol context with command=$command and permits both approvals", ({ protocol, command }) => {
      view.activeThreadId = "T";
      view.approvals = [{ requestId: "network-only", method: "item/commandExecution/requestApproval", params: networkOnlyParams(command, protocol) }];
      let renderer!: ReactTestRenderer;
      act(() => { renderer = create(<Timeline />); });
      try {
        const rendered = JSON.stringify(renderer.toJSON());
        expect(rendered).toContain("请求访问网络");
        expect(rendered).not.toContain("命令结构无效");
        expect(rendered).not.toContain("请求执行命令");
        expect(rendered).toContain("Fetch the requested resource");
        expect(rendered).toContain("/network-project");
        const context = renderer.root.findByProps({ className: "approval-context" });
        expect(context.findAllByType("code").map(node => Array.isArray(node.props.children) ? node.props.children.join("") : node.props.children))
          .toEqual(["/network-project", `${protocol}://api.example.test:8443`, "allow api.example.test", "deny blocked.example.test", '["curl","--header","X-Label: two words"]']);
        const approvalButtons = renderer.root.findByProps({ className: "approval-actions" }).findAllByType("button");
        expect(approvalButtons.map(button => button.props.disabled)).toEqual([false, false, false]);
        act(() => approvalButtons[0].props.onClick());
        expect(view.decideApproval).toHaveBeenLastCalledWith("network-only", "accept");
        act(() => approvalButtons[1].props.onClick());
        expect(view.decideApproval).toHaveBeenLastCalledWith("network-only", "acceptForSession");
      } finally { act(() => renderer.unmount()); }
    },
  );

  it.each(malformedNetworkApprovals)("fails closed without hiding refusal for network callbacks with %s", (_label, patch) => {
    view.activeThreadId = "T";
    view.approvals = [{ requestId: "invalid-network", method: "item/commandExecution/requestApproval", params: { ...networkOnlyParams(), ...patch } }];
    const html = renderToStaticMarkup(<Timeline />);
    expect(html).toContain("已禁用批准");
    expect(html.match(/<button[^>]*disabled=""[^>]*>/g)).toHaveLength(2);
    expect(html).toMatch(/<button class="btn-danger">拒绝<\/button>/);
  });

  it("ignores malformed optional approval context without crashing the whole request dock", () => {
    view.activeThreadId = "T";
    view.approvals = [{ requestId: "malformed-context", method: "item/commandExecution/requestApproval", params: {
      threadId: "T", command: "echo visible", cwd: { unexpected: true },
      networkApprovalContext: "not-an-object", proposedNetworkPolicyAmendments: { unexpected: true },
      proposedExecpolicyAmendment: "not-an-array",
    } }];
    expect(() => renderToStaticMarkup(<Timeline />)).not.toThrow();
    const html = renderToStaticMarkup(<Timeline />);
    expect(html).toContain("echo visible"); expect(html).not.toContain("[object Object]");
  });

  it("fails closed instead of crashing or approving when a command approval has no valid command", () => {
    view.activeThreadId = "T";
    view.approvals = [{ requestId: "malformed-command", method: "item/commandExecution/requestApproval", params: {
      threadId: "T", command: { unexpected: true },
    } }];
    expect(() => renderToStaticMarkup(<Timeline />)).not.toThrow();
    const html = renderToStaticMarkup(<Timeline />);
    expect(html).toContain("命令结构无效"); expect(html).not.toContain("[object Object]");
    expect(html.match(/<button[^>]*disabled=""[^>]*>/g)).toHaveLength(2);
    expect(html).toMatch(/<button class="btn-danger">拒绝<\/button>/);
  });

  it("keeps an approval with malformed params rejectable without crashing the request dock", () => {
    view.activeThreadId = "T";
    view.approvals = [{ requestId: "malformed-params", method: "item/commandExecution/requestApproval", params: null }];
    const html = renderToStaticMarkup(<Timeline />);
    expect(html).toContain("命令结构无效");
    expect(html.match(/<button[^>]*disabled=""[^>]*>/g)).toHaveLength(2);
    expect(html).toMatch(/<button class="btn-danger">拒绝<\/button>/);
  });

  it("keeps an approval with a malformed thread owner locally rejectable", () => {
    view.activeThreadId = "T";
    view.approvals = [{ requestId: "malformed-owner", method: "item/commandExecution/requestApproval", params: {
      threadId: { unexpected: true }, command: "echo visible",
    } }];
    const html = renderToStaticMarkup(<Timeline />);
    expect(html).toContain("请求执行命令");
    expect(html).not.toContain("后台会话「");
    expect(html.match(/<button[^>]*disabled=""[^>]*>/g)).toHaveLength(2);
    expect(html).toMatch(/<button class="btn-danger">拒绝<\/button>/);
  });

  it("bounds file-change details duplicated into an approval card", () => {
    view.activeThreadId = "T";
    view.items = { T: [{
      type: "fileChange", id: "large-change", threadId: "T", turnId: "turn", status: "inProgress",
      changes: Array.from({ length: 101 }, (_, index) => ({ path: `/approval-path-${index}`, kind: { type: "update", move_path: null }, diff: "" })),
    }] };
    view.approvals = [{ requestId: "large-files", method: "item/fileChange/requestApproval", params: {
      threadId: "T", turnId: "turn", itemId: "large-change",
    } }];
    const html = renderToStaticMarkup(<Timeline />);
    expect(html).toContain("/approval-path-49");
    expect(html).not.toContain("/approval-path-50");
    expect(html).toContain("仅显示前 50 / 101 项");
    expect(html).toContain("不完整或过大，已禁用批准");
    expect(html.match(/<button[^>]*disabled=""[^>]*>/g)).toHaveLength(2);
  });

  it("enables file approval only for complete details on the exact thread, turn, and item", () => {
    view.activeThreadId = "T";
    view.items = { T: [{
      type: "fileChange", id: "exact-change", threadId: "T", turnId: "turn", status: "inProgress",
      changes: [{ path: "/project/exact.ts", kind: { type: "update", move_path: null }, diff: "+safe" }],
    }] };
    view.approvals = [{ requestId: "exact-files", method: "item/fileChange/requestApproval", params: {
      threadId: "T", turnId: "turn", itemId: "exact-change",
    } }];
    let html = renderToStaticMarkup(<Timeline />);
    expect(html).toContain("/project/exact.ts");
    expect(html.match(/<button[^>]*disabled=""[^>]*>/g) ?? []).toHaveLength(0);

    view.approvals = [{ requestId: "wrong-turn", method: "item/fileChange/requestApproval", params: {
      threadId: "T", turnId: "other-turn", itemId: "exact-change",
    } }];
    html = renderToStaticMarkup(<Timeline />);
    expect(html).toContain("已禁用批准");
    expect(html.match(/<button[^>]*disabled=""[^>]*>/g)).toHaveLength(2);
  });

  it.each([
    ["ordinary", "/project/important-destination.txt"],
    ["maximum length", `/${"d".repeat(4_091)}.txt`],
    ["HTML-like filename", '/project/<img src=x onerror="alert(1)">.txt'],
  ])("shows the complete rename destination before approval and in history (%s)", (_label, destination) => {
    const item = {
      type: "fileChange", id: "rename", threadId: "T", turnId: "turn", status: "inProgress",
      changes: [{ path: "/project/source.txt", kind: { type: "update", move_path: destination }, diff: "" }],
    };
    view.activeThreadId = "T";
    view.items = { T: [item] };
    view.approvals = [{ requestId: "rename", method: "item/fileChange/requestApproval", params: {
      threadId: "T", turnId: "turn", itemId: "rename",
    } }];
    const approval = renderToStaticMarkup(<Timeline />);
    const history = renderToStaticMarkup(<ItemView item={item as any} />);
    const escapedDestination = renderToStaticMarkup(<bdi>{destination}</bdi>);
    for (const html of [approval, history]) {
      expect(html).toContain(`<bdi>/project/source.txt</bdi> → ${escapedDestination}`);
      expect(html).not.toContain("<img");
      expect(html).not.toContain("<script");
    }
    expect(approval.match(/<button[^>]*disabled=""[^>]*>/g) ?? []).toHaveLength(0);
  });

  it.each([undefined, "", "/".repeat(4_097), { unexpected: true }, ["/wrong-shape"]])(
    "keeps invalid move destinations rejectable without rendering unsafe data (%j)", (destination) => {
      const item = {
        type: "fileChange", id: "rename", threadId: "T", turnId: "turn", status: "inProgress",
        changes: [{ path: "/source", kind: { type: "update", move_path: destination }, diff: "" }],
      };
      view.activeThreadId = "T";
      view.items = { T: [item] };
      view.approvals = [{ requestId: "rename", method: "item/fileChange/requestApproval", params: {
        threadId: "T", turnId: "turn", itemId: "rename",
      } }];
      const html = renderToStaticMarkup(<Timeline />);
      expect(html.match(/<button[^>]*disabled=""[^>]*>/g)).toHaveLength(2);
      expect(html).toMatch(/<button class="btn-danger">拒绝<\/button>/);
      expect(html).not.toContain("[object Object]");
      expect(html).not.toContain("/".repeat(4_097));
      expect(() => renderToStaticMarkup(<ItemView item={item as any} />)).not.toThrow();
    },
  );

  it.each([{ type: "add" }, { type: "delete" }, { type: "update", move_path: null }])(
    "keeps ordinary file changes free of a spurious destination (%j)", (kind) => {
      const html = renderToStaticMarkup(<ItemView item={{ type: "fileChange", id: "normal", status: "completed",
        changes: [{ path: "/source", kind, diff: "" }] } as any} />);
      expect(html).toContain("/source");
      expect(html).not.toContain(" → ");
    },
  );

  it("keeps a submitted approval visible with busy state and a retryable rejection error", () => {
    view.activeThreadId = "T";
    view.approvals = [{ requestId: "pending", method: "item/commandExecution/requestApproval", params: {
      threadId: "T", command: "echo safe",
    } }];
    view.approvalSubmissions = { pending: true };
    let html = renderToStaticMarkup(<Timeline />);
    expect(html).toContain("等待服务器确认");
    expect(html.match(/<button[^>]*disabled=""[^>]*>/g)).toHaveLength(3);

    view.approvalSubmissions = { pending: false };
    view.approvalErrors = { pending: "approval token expired" };
    html = renderToStaticMarkup(<Timeline />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("approval token expired");
    expect(html.match(/<button[^>]*disabled=""[^>]*>/g) ?? []).toHaveLength(0);
  });

  it.each([
    ["null entry", [null, { path: "/valid-after-null", kind: { type: "update" }, diff: "" }]],
    ["non-array changes", { unexpected: true }],
    ["invalid path and kind", [{ path: { unexpected: true }, kind: null, diff: "" }]],
  ])("keeps malformed file-change approval details rejectable (%s)", (_label, changes) => {
    view.activeThreadId = "T";
    view.items = { T: [{ type: "fileChange", id: "malformed-change", threadId: "T", turnId: "turn", status: "inProgress", changes }] };
    view.approvals = [{ requestId: "malformed-files", method: "item/fileChange/requestApproval", params: {
      threadId: "T", turnId: "turn", itemId: "malformed-change",
    } }];

    expect(() => renderToStaticMarkup(<Timeline />)).not.toThrow();
    const html = renderToStaticMarkup(<Timeline />);
    expect(html).toContain("审批上下文格式无效、不完整或过大，已禁用批准");
    expect(html.match(/<button[^>]*disabled=""[^>]*>/g)).toHaveLength(2);
    expect(html).toMatch(/<button class="btn-danger">拒绝<\/button>/);
    if (_label === "null entry") {
      expect(html).toContain("变更条目格式无效");
      expect(html).toContain("/valid-after-null");
    }
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

  it("labels long dynamic-tool output and lets the user reveal every character in bounded steps", () => {
    const output = `${"x".repeat(24_000)}TAIL`;
    const item = { type: "dynamicToolCall" as const, id: "tool", namespace: null, tool: "large-output",
      arguments: {}, status: "completed" as const, contentItems: [{ type: "inputText" as const, text: output }], success: true, durationMs: null };
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<ItemView item={item} />); });
    let pre = renderer.root.findByType("pre");
    expect(String(pre.props.children)).toHaveLength(2_000);
    expect(renderer.root.findByProps({ className: "output-truncation" }).findByType("span").props.children.join("")).toContain("2,000 / 24,004");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("TAIL");
    act(() => { renderer.root.findByType("button").props.onClick(); });
    act(() => { renderer.root.findByType("button").props.onClick(); });
    pre = renderer.root.findByType("pre");
    expect(String(pre.props.children)).toBe(output);
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
    renderer.unmount();
  });

  it("bounds long command output initially without silently losing access to it", () => {
    const output = `${"y".repeat(24_000)}COMMAND-TAIL`;
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<ItemView item={{ type: "commandExecution", id: "command", pluginId: null, scriptPath: null, source: "agent", command: "generate", cwd: "/tmp", processId: null, status: "completed", commandActions: [], aggregatedOutput: output, exitCode: 0, durationMs: 1 }} />); });
    expect(String(renderer.root.findByType("pre").props.children)).toHaveLength(2_000);
    expect(renderer.root.findByProps({ className: "output-truncation" }).findByType("span").props.children.join(""))
      .toContain(`2,000 / ${output.length.toLocaleString("zh-CN")}`);
    expect(JSON.stringify(renderer.toJSON())).not.toContain("COMMAND-TAIL");
    act(() => renderer.root.findByType("button").props.onClick());
    act(() => renderer.root.findByType("button").props.onClick());
    expect(String(renderer.root.findByType("pre").props.children)).toBe(output);
    renderer.unmount();
  });

  it("bounds long MCP arguments and results without silently discarding them", () => {
    const argumentsText = `${"a".repeat(24_000)}ARGUMENT-TAIL`;
    const resultText = `${"r".repeat(24_000)}RESULT-TAIL`;
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<ItemView item={{ type: "mcpToolCall", id: "mcp", server: "server", tool: "tool", status: "completed", arguments: argumentsText, result: resultText } as any} />); });
    const initial = renderer.root.findAllByType("pre");
    expect(initial).toHaveLength(2);
    expect(String(initial[0].props.children)).toHaveLength(2_000);
    expect(String(initial[1].props.children)).toHaveLength(2_000);
    expect(JSON.stringify(renderer.toJSON())).not.toContain("ARGUMENT-TAIL");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("RESULT-TAIL");
    const firstButton = renderer.root.findAllByType("button")[0];
    act(() => firstButton.props.onClick());
    act(() => renderer.root.findAllByType("button")[0].props.onClick());
    expect(String(renderer.root.findAllByType("pre")[0].props.children)).toBe(argumentsText);
    expect(renderer.root.findAllByType("button")).toHaveLength(1);
    renderer.unmount();
  });

  it("renders very large diffs in explicit bounded line windows", () => {
    const diff = Array.from({ length: 6_001 }, (_, index) => `+line-${index}`).join("\n");
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<DiffView text={diff} />); });
    expect(renderer.root.findAllByProps({ className: "diff-add" })).toHaveLength(2_000);
    expect(renderer.root.findByProps({ className: "output-truncation" }).findByType("span").props.children.join(""))
      .toContain("2,000 / 6,001");
    act(() => renderer.root.findByType("button").props.onClick());
    expect(renderer.root.findAllByProps({ className: "diff-add" })).toHaveLength(4_000);
    renderer.unmount();
  });

  it("bounds markdown parsing and file-change inspection before touching an untrusted tail", () => {
    const markdown = renderToStaticMarkup(<Markdown text={`${"safe ".repeat(50_000)}TAIL-MARKER`} />);
    expect(markdown).not.toContain("TAIL-MARKER");
    expect(markdown).toContain("Markdown 解析预算");

    const changes: unknown[] = Array.from({ length: 200 }, (_, index) => ({ path: `/safe-${index}`, kind: { type: "update" }, diff: "" }));
    Object.defineProperty(changes, "200", { get: () => { throw new Error("untrusted tail inspected"); } });
    changes.length = 1_000;
    expect(() => renderToStaticMarkup(<ItemView item={{ type: "fileChange", id: "bounded", status: "completed", changes } as any} />)).not.toThrow();
  });

  it.each(["agentMessage", "plan"])("discloses %s truncation only above the exact Markdown budget", (type) => {
    for (const length of [199_999, 200_000, 200_001]) {
      const html = renderToStaticMarkup(<ItemView item={{ type, id: "text", text: "x".repeat(length) } as any} />);
      expect(html.includes("内容超过浏览器 Markdown 解析预算")).toBe(length > 200_000);
      expect(html).toContain("x".repeat(Math.min(length, 200_000)));
      expect(html).not.toContain("x".repeat(200_001));
    }
  });

  it("keeps an unfinished Markdown block from absorbing the truncation notice and bounds parser input", () => {
    const text = `\`\`\`\n${"x".repeat(200_000)}MISSING_TAIL`;
    const html = renderToStaticMarkup(<ItemView item={{ type: "agentMessage", id: "long", text } as any} />);
    expect(html).not.toContain("MISSING_TAIL");
    expect(html).toContain('</code></pre><div class="output-truncation" role="status">内容超过浏览器 Markdown 解析预算');
    // Verify the actual parser receives only the bounded prefix, even when a
    // caller passes a whole history-budget-sized string into this component.
    const markdown = Markdown({ text: "x".repeat(20 * 1024 * 1024) });
    expect(markdown.props.children[0].props.text).toHaveLength(200_000);
    expect(markdown.props.children[0].props.children.props.children).toHaveLength(200_000);
    expect(markdown.props.children[1].props.role).toBe("status");
  });

  it("keeps malformed fields on known timeline variants from crashing the conversation", () => {
    const malformed = [
      { type: "userMessage", id: "user", content: { unexpected: true } },
      { type: "agentMessage", id: "agent", text: { unexpected: true } },
      { type: "reasoning", id: "reasoning", summary: { unexpected: true }, content: null },
      { type: "commandExecution", id: "command", command: { unexpected: true }, aggregatedOutput: { unexpected: true }, exitCode: { unexpected: true }, status: "completed" },
      { type: "mcpToolCall", id: "mcp", server: { unexpected: true }, tool: { unexpected: true }, status: "completed" },
      { type: "webSearch", id: "search", query: { unexpected: true }, results: { unexpected: true } },
      { type: "fileChange", id: "file", status: "completed", changes: { unexpected: true } },
      { type: "hookPrompt", id: "hook", fragments: { unexpected: true } },
      { type: "imageView", id: "image-view", path: { unexpected: true } },
      { type: "imageGeneration", id: "image-generation", status: { unexpected: true }, result: "", savedPath: null, failure: null },
      { type: "sleep", id: "sleep", durationMs: { unexpected: true } },
    ];
    for (const item of malformed) {
      expect(() => renderToStaticMarkup(<ItemView item={item as any} />)).not.toThrow();
      expect(renderToStaticMarkup(<ItemView item={item as any} />)).not.toContain("[object Object]");
    }
  });

  it("keeps malformed dynamic-tool content from crashing the entire timeline item", () => {
    const malformed = JSON.parse('{"type":"dynamicToolCall","id":"bad","tool":"future-tool","status":"completed","contentItems":{"unexpected":true}}');
    expect(() => renderToStaticMarkup(<ItemView item={malformed} />)).not.toThrow();
    expect(renderToStaticMarkup(<ItemView item={malformed} />)).toContain("future-tool");
  });

  it("bounds nested result collections and reports the omitted count", () => {
    const search = renderToStaticMarkup(<ItemView item={{
      type: "webSearch", id: "search", query: "query",
      results: Array.from({ length: 501 }, (_, index) => ({ title: `result-${index}`, url: `https://example.test/${index}` })),
    } as any} />);
    expect(search).toContain("result-99");
    expect(search).not.toContain("result-100");
    expect(search).toContain("仅显示前 100 / 501 条");

    const files = renderToStaticMarkup(<ItemView item={{
      type: "fileChange", id: "files", status: "completed",
      changes: Array.from({ length: 101 }, (_, index) => ({ path: `/path-${index}`, kind: { type: "update" }, diff: "" })),
    } as any} />);
    expect(files).toContain("/path-49");
    expect(files).not.toContain("/path-50");
    expect(files).toContain("仅显示前 50 / 101 项");

    const tool = renderToStaticMarkup(<ItemView item={{
      type: "dynamicToolCall", id: "tool", tool: "many-results", status: "completed",
      contentItems: Array.from({ length: 101 }, (_, index) => ({ type: "inputText", text: `chunk-${index}` })),
    } as any} />);
    expect(tool).toContain("chunk-99");
    expect(tool).not.toContain("chunk-100");
    expect(tool).toContain("仅显示前 100 / 101 项");

    const content = Array.from({ length: 1_101 }, (_, index): unknown => index < 60
      ? { type: "mention", name: index === 0 ? `${"N".repeat(300)}TAIL-NAME` : `attachment-${index}`, path: `/path-${index}` }
      : { type: "text", text: `text-${index}` });
    Object.defineProperty(content, "1000", {
      configurable: true,
      get() { throw new Error("over-budget user content was accessed"); },
    });
    const user = renderToStaticMarkup(<ItemView item={{ type: "userMessage", id: "bounded-user", clientId: null, content } as any} />);
    expect(user).toContain("attachment-49");
    expect(user).not.toContain("attachment-50");
    expect(user).not.toContain("TAIL-NAME");
    expect(user).toContain("另有 10 个附件");
    expect(user).toContain("另有 101 个消息片段未检查");
  });

  it("does not auto-load remote images from model markdown and hardens explicit links", () => {
    const html = renderToStaticMarkup(<Markdown text={'![tracking pixel](http://192.0.2.1/pixel)\n\n[open docs](https://example.test/docs)\n\n[unsafe](javascript:alert(1))'} />);
    expect(html).not.toContain("<img");
    expect(html).toContain('href="http://192.0.2.1/pixel"');
    expect(html).toContain('href="https://example.test/docs"');
    expect(html.match(/target="_blank"/g)).toHaveLength(2);
    expect(html).not.toContain("javascript:");
  });

  it("requires a click before loading remote tool or image-generation media", () => {
    const tool = JSON.parse('{"type":"dynamicToolCall","id":"remote-tool","tool":"image","status":"completed","contentItems":[{"type":"inputImage","imageUrl":"https://media.example.test/tool.png"}]}');
    const generated = JSON.parse('{"type":"imageGeneration","id":"remote-generation","status":"completed","result":"https://media.example.test/generated.png","savedPath":null,"failure":null,"revisedPrompt":null}');
    for (const item of [tool, generated]) {
      const html = renderToStaticMarkup(<ItemView item={item} />);
      expect(html).not.toContain("<img");
      expect(html).toContain('target="_blank"');
      expect(html).toContain("media.example.test");
    }
    const audio = JSON.parse('{"type":"dynamicToolCall","id":"remote-audio","tool":"audio","status":"completed","contentItems":[{"type":"inputAudio","audioUrl":"https://media.example.test/tool.mp3"}]}');
    const audioHtml = renderToStaticMarkup(<ItemView item={audio} />);
    expect(audioHtml).not.toContain("<audio");
    expect(audioHtml).toContain('href="https://media.example.test/tool.mp3"');
    expect(audioHtml).toContain('target="_blank"');
    const inline = JSON.parse('{"type":"dynamicToolCall","id":"inline-tool","tool":"image","status":"completed","contentItems":[{"type":"inputImage","imageUrl":"data:image/png;base64,iVBORw0KGgo="}]}');
    expect(renderToStaticMarkup(<ItemView item={inline} />)).toContain("<img");
    const inlineAudio = JSON.parse('{"type":"dynamicToolCall","id":"inline-audio","tool":"audio","status":"completed","contentItems":[{"type":"inputAudio","audioUrl":"data:audio/mpeg;base64,SUQz"}]}');
    expect(renderToStaticMarkup(<ItemView item={inlineAudio} />)).toContain("<audio");
  });

  it("never auto-loads a remote attachment preview supplied by history", () => {
    const item = {
      type: "userMessage", id: "remote-attachment", clientId: null, content: [],
      harnessAttachments: [{ kind: "image", name: "tracking.png", path: "/uploads/tracking.png", previewUrl: "https://media.example.test/tracking.png" }],
    } as any;
    const html = renderToStaticMarkup(<ItemView item={item} />);
    expect(html).not.toContain("media.example.test");
    expect(html).not.toContain("<img");
    expect(html).toContain("tracking.png");
  });

  it("does not let malformed historical attachment fields crash the timeline", () => {
    const item = {
      type: "userMessage", id: "bad-attachment", clientId: null, content: [],
      harnessAttachments: [{ kind: "image", name: { unexpected: true }, path: "/uploads/bad.png" }],
    } as any;
    expect(() => renderToStaticMarkup(<ItemView item={item} />)).not.toThrow();
    expect(renderToStaticMarkup(<ItemView item={item} />)).toContain("附件格式无效");
  });

  it("truncates a server-supplied attachment path before requesting it", async () => {
    const longPath = `/${"p".repeat(5_000)}TAIL-PATH`;
    view.readAttachment.mockRejectedValue(new Error("expected read stop"));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ItemView item={{ type: "userMessage", id: "long-path", clientId: null, content: [{ type: "localImage", path: longPath }] } as any} />);
      for (let index = 0; index < 5; index++) await Promise.resolve();
    });
    expect(view.readAttachment).toHaveBeenCalledWith(longPath.slice(0, 4_096), expect.any(AbortSignal));
    expect(JSON.stringify(renderer.toJSON())).not.toContain("TAIL-PATH");
    act(() => renderer.unmount());
  });

  it("surfaces a failed historical image read and provides an explicit retry", async () => {
    view.readAttachment.mockRejectedValue(new Error("read failed"));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ItemView item={{ type: "userMessage", id: "u", clientId: null, content: [{ type: "localImage", path: "/history/image.png" }] }} />);
      for (let index = 0; index < 5; index++) await Promise.resolve();
    });
    const retry = renderer.root.findByProps({ className: "attach-image-retry" });
    expect(retry.props.title).toContain("read failed");
    await act(async () => {
      retry.props.onClick();
      for (let index = 0; index < 5; index++) await Promise.resolve();
    });
    expect(view.readAttachment).toHaveBeenCalledTimes(2);
    renderer.unmount();
  });

  it("aborts an unmounted historical image read and ignores its late bytes", async () => {
    let resolve!: (value: { base64: string; mime: string }) => void;
    const response = new Promise<{ base64: string; mime: string }>((done) => { resolve = done; });
    let signal: AbortSignal | undefined;
    view.readAttachment.mockImplementation((_path, candidate?: AbortSignal) => {
      signal = candidate;
      return response;
    });
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:late");
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ItemView item={{ type: "userMessage", id: "u", clientId: null, content: [{ type: "localImage", path: "/history/late.png" }] }} />);
      await Promise.resolve();
    });

    act(() => renderer.unmount());
    expect(signal?.aborted).toBe(true);
    await act(async () => { resolve({ base64: "YQ==", mime: "image/png" }); await Promise.resolve(); });
    expect(createUrl).not.toHaveBeenCalled();
  });
});
