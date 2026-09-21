import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminResultFeedback, ServerTab, SettingsModal } from "../src/components/SettingsModal";
import { normalizeManagement, type ManagementSnapshot, type ManagementOperation } from "../src/utils/management";
import { deferred } from "./fixtures";

const mock = vi.hoisted(() => ({ state: {
  connection: "open", providerMode: "openai", management: { state: "idle" } as ManagementSnapshot,
  managementError: null, refreshManagement: async () => {}, mcpServers: [],
  mcpLoad: { state: "loaded" as "loading" | "loaded" | "error", error: null as string | null }, refreshMcp: vi.fn(async () => {}),
  settings: { theme: "system", enterBehavior: "send" }, updateSettings() {},
  display: { reasoning: true, commands: true, fileChanges: true, mcpCalls: true, webSearch: true, autoCompactThreshold: 0.9 },
  displayError: null, updateDisplay() {},
}, rpc: vi.fn() }));
vi.mock("../src/store", () => ({ useStore: (select: (state: typeof mock.state) => unknown) => select(mock.state) }));
vi.mock("../src/api/ws", () => ({ gateway: { generation: 1, rpc: mock.rpc } }));

describe("supported server management interface", () => {
  beforeEach(() => {
    mock.state.connection = "open";
    mock.state.management = { state: "idle", operation: undefined };
    mock.state.mcpServers = [];
    mock.state.mcpLoad = { state: "loaded", error: null };
    mock.state.refreshMcp.mockClear();
    mock.rpc.mockClear();
  });

  it("shows server CLI guidance without any obsolete privileged edge form", () => {
    const html = renderToStaticMarkup(<ServerTab />);
    expect(html).toContain("sudo codex-harness edge</pre>");
    expect(html).toContain("sudo codex-harness edge disable</pre>");
    expect(html).toContain("自定义实例请使用安装时生成的专属管理命令");
    expect(html).toContain("独立的非 root 账号");
    expect(html).not.toContain("应用远程访问配置");
    expect(html).not.toContain("Authelia 密码");
    expect(html).not.toContain("对外域名，如");
    expect(mock.rpc).not.toHaveBeenCalled();
  });

  it("describes conditional restarts and preserves no-op semantics", () => {
    const html = renderToStaticMarkup(<ServerTab />);
    expect(html).toContain("OpenAI 原生目录无需同步");
    expect(html).toContain("无变化不会重启");
    expect(html).toContain("不发起付费思考档位探测");
    expect(html).toContain("请先结束运行中的任务和网页终端");
    expect(html).not.toContain("完成后自动重启服务生效");
    expect(html).not.toContain("切换后自动重启）");
  });

  it("shows the shared pending restart state and disables management actions", () => {
    mock.state.management = { state: "restart_pending", operation: "admin/provider/switch" };
    const html = renderToStaticMarkup(<ServerTab />);
    expect(html).toContain("正在等待服务重启");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>重启服务<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>查看服务日志<\/button>/);
  });

  it("does not offer disconnected management actions", () => {
    mock.state.connection = "closed";
    const html = renderToStaticMarkup(<ServerTab />);
    expect(html).toContain("服务器管理操作暂不可用");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>重启服务<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>切换到智谱 Coding Plan<\/button>/);
  });

  it("does not present disconnected conversation preferences as editable", () => {
    mock.state.connection = "closed";
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<SettingsModal open onClose={() => {}} />); });
    const conversation = renderer.root.findAllByType("button").find((button) => button.props.children === "对话");
    act(() => conversation!.props.onClick());
    expect(renderer.root.findAllByType("input").filter((input) => input.props.type === "checkbox").every((input) => input.props.disabled)).toBe(true);
    for (const label of ["关闭", "80%", "85%", "90%", "95%"]) {
      expect(renderer.root.findAllByType("button").find((button) => button.props.children === label)?.props.disabled).toBe(true);
    }
    renderer.unmount();
  });

  it("does not label script acceptance or unknown transport as final success", () => {
    const accepted = renderToStaticMarkup(<AdminResultFeedback result={{ ok: true, restarting: true, restartRequired: true, operationId: "op" }} />);
    expect(accepted).toContain("重启结果待确认");
    expect(accepted).not.toContain("上次操作结果（成功）");
    const unknown = renderToStaticMarkup(<AdminResultFeedback result={{ ok: false, restarting: false, uncertain: true }} />);
    expect(unknown).toContain("请求结果待确认");
    expect(unknown).not.toContain("请求失败");
  });

  it("renders a persisted failure or unknown outcome even after the admission gate becomes idle", () => {
    for (const outcome of ["failed", "unknown"] as const) {
      mock.state.management = { state: "idle", lastOperation: { operationId: "op", operation: "admin/provider/switch", outcome, startedAt: 1, updatedAt: 2, error: "helper did not finish" } };
      const html = renderToStaticMarkup(<ServerTab />);
      expect(html).toContain(outcome === "failed" ? "管理操作失败" : "原管理操作的结果仍未知");
      expect(html).toContain("helper did not finish");
      expect(html).toContain("核对管理状态（不会重试配置）");
    }
  });

  it("uses the exact operation identity for recovered status and never another operation's outcome", () => {
    const record: ManagementOperation = { operationId: "new", operation: "admin/provider/switch", outcome: "recovered", startedAt: 1, updatedAt: 2, restartRequired: true };
    const own = renderToStaticMarkup(<AdminResultFeedback result={{ ok: true, restarting: true, operationId: "new" }} record={record} />);
    expect(own).toContain("已确认新后端就绪");
    expect(own).toContain("不代表模型调用");
    const stale = renderToStaticMarkup(<AdminResultFeedback result={{ ok: true, restarting: true, operationId: "old" }} record={record} />);
    expect(stale).toContain("重启结果待确认");
    expect(stale).not.toContain("已确认新后端就绪");
  });

  it("normalizes only bounded management metadata and fails closed on invalid state", () => {
    expect(normalizeManagement({ state: "unrecognized" }).state).toBe("unknown");
    expect(() => normalizeManagement({ state: { toString: "not callable" } })).not.toThrow();
    expect(normalizeManagement({ state: { toString: "not callable" } }).state).toBe("unknown");
    const snapshot = normalizeManagement({ state: "unknown", error: "x".repeat(5000), secret: "example", lastOperation: {
      operationId: "op", operation: "admin/catalog/sync", outcome: "unknown", startedAt: 1, updatedAt: 2, config: "private value",
    } });
    expect(snapshot.error).toHaveLength(2000);
    expect(JSON.stringify(snapshot)).not.toContain("private value");
    expect(JSON.stringify(snapshot)).not.toContain("example");
  });

  it("does not crash or render object data when the logs response is malformed", async () => {
    mock.rpc.mockImplementation((method: string) => Promise.resolve(method === "admin/logs" ? { logs: { private: "value" } } : {}));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ServerTab />);
      await Promise.resolve();
    });
    const logsButton = renderer.root.findAllByType("button").find((button) => button.props.children === "查看服务日志");
    expect(logsButton).toBeDefined();
    await act(async () => {
      logsButton!.props.onClick();
      for (let index = 0; index < 3; index++) await Promise.resolve();
    });
    const html = JSON.stringify(renderer.toJSON());
    expect(html).toContain("日志响应格式无效");
    expect(html).not.toContain("private");
  });

  it("fails closed on a malformed successful management response", async () => {
    mock.rpc.mockImplementation((method: string) => Promise.resolve(method === "admin/catalog/sync"
      ? { ok: true, restarting: "yes", output: { private: "value" } }
      : {}));
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<ServerTab />); await Promise.resolve(); });
    const sync = renderer.root.findAllByType("button").find((button) => String(button.props.children).includes("一键同步"));
    await act(async () => {
      sync!.props.onClick();
      for (let index = 0; index < 4; index++) await Promise.resolve();
    });
    const html = JSON.stringify(renderer.toJSON());
    expect(html).toContain("请求结果待确认");
    expect(html).toContain("响应格式无效");
    expect(html).not.toContain("private");
    renderer.unmount();
  });

  it("treats an initialized zero-tool MCP server as connected and reports a bounded tool preview", () => {
    const tools = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`tool-${index}`, { name: `tool-${index}` }]));
    Object.defineProperty(tools, "tool-over-budget", {
      enumerable: true,
      get() { throw new Error("over-budget settings tool was accessed"); },
    });
    mock.state.mcpServers = [{ name: "empty", serverInfo: { name: "empty", version: "1" }, tools: {}, resources: [], resourceTemplates: [], authStatus: "notRequired" },
      { name: "large", serverInfo: { name: "large", version: "1" }, tools, resources: [], resourceTemplates: [], authStatus: "notRequired" }] as never[];
    const html = renderToStaticMarkup(<ServerTab />);
    expect(html).toContain("已连接 · 0 个工具");
    expect(html).toContain("至少 501 个工具（仅显示前 500 个）");
    expect(html).not.toContain("empty</span><span class=\"dim\">未加载");
  });

  it("reports an MCP read failure without claiming that no servers are configured and exposes a retry", () => {
    mock.state.mcpLoad = { state: "error", error: "MCP synthetic failure" };
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<ServerTab />); });
    const html = JSON.stringify(renderer.toJSON());
    expect(html).toContain("MCP synthetic failure");
    expect(html).not.toContain("未配置 MCP 服务器");
    const retry = renderer.root.findAllByType("button").find((button) => button.props.children === "重试");
    act(() => retry!.props.onClick());
    expect(mock.state.refreshMcp).toHaveBeenCalledOnce();
    act(() => renderer.unmount());
  });

  it("keeps the newest admin status when an older mount request resolves last", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    mock.rpc.mockImplementation((method: string) => {
      if (method === "admin/status") return mock.rpc.mock.calls.filter(([name]) => name === "admin/status").length === 1
        ? first.promise : second.promise;
      if (method === "admin/catalog/sync") return Promise.resolve({ ok: true, restarting: false, changed: false });
      return Promise.resolve({});
    });
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<ServerTab />); await Promise.resolve(); });
    const sync = renderer.root.findAllByType("button").find((button) => String(button.props.children).includes("一键同步"))!;
    await act(async () => { sync.props.onClick(); for (let i = 0; i < 4; i++) await Promise.resolve(); });
    expect(mock.rpc.mock.calls.filter(([name]) => name === "admin/status")).toHaveLength(2);
    await act(async () => { second.resolve({ currentModel: "new-model" }); await Promise.resolve(); });
    await act(async () => { first.resolve({ currentModel: "stale-model" }); await Promise.resolve(); });
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain("new-model");
    expect(rendered).not.toContain("stale-model");
    act(() => renderer.unmount());
  });

  it("shows an admin status failure and recovers only through the visible retry", async () => {
    mock.rpc.mockRejectedValueOnce(new Error("status unavailable"));
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<ServerTab />); for (let i = 0; i < 3; i++) await Promise.resolve(); });
    expect(JSON.stringify(renderer.toJSON())).toContain("status unavailable");
    const retry = renderer.root.findAllByType("button").find((button) => button.props.children === "重试服务器状态")!;
    mock.rpc.mockResolvedValueOnce({ currentModel: "recovered-model" });
    await act(async () => { retry.props.onClick(); for (let i = 0; i < 3; i++) await Promise.resolve(); });
    expect(JSON.stringify(renderer.toJSON())).toContain("recovered-model");
    expect(renderer.root.findAllByType("button").some((button) => button.props.children === "重试服务器状态")).toBe(false);
    act(() => renderer.unmount());
  });
});
