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
}, generation: 1, rpc: vi.fn() }));
vi.mock("../src/store", () => ({ useStore: (select: (state: typeof mock.state) => unknown) => select(mock.state) }));
vi.mock("../src/api/ws", () => ({ gateway: { get generation() { return mock.generation; }, rpc: mock.rpc } }));

function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").find((candidate) => candidate.props.children === label)!;
}

describe("supported server management interface", () => {
  beforeEach(() => {
    mock.state.connection = "open";
    mock.state.management = { state: "idle", operation: undefined };
    mock.state.mcpServers = [];
    mock.state.mcpLoad = { state: "loaded", error: null };
    mock.state.refreshMcp.mockClear();
    mock.generation = 1;
    mock.rpc.mockReset().mockResolvedValue({});
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

  it("blocks configuration during a pending restart but keeps safe read-only diagnostics available", () => {
    mock.state.management = { state: "restart_pending", operation: "admin/provider/switch" };
    const html = renderToStaticMarkup(<ServerTab />);
    expect(html).toContain("正在等待服务重启");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>重启服务<\/button>/);
    expect(html).toMatch(/<button class="btn">查看服务日志<\/button>/);
    expect(html).toMatch(/<button class="btn">刷新服务器状态<\/button>/);
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
    act(() => renderer.unmount());
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
    mock.state.mcpServers = [{ name: "empty", runtimeStatus: "connected", tools: {} },
      { name: "large", runtimeStatus: "connected", tools }] as never[];
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
    expect(mock.state.refreshMcp).toHaveBeenCalledTimes(2); // Mount refresh, then explicit retry.
    act(() => renderer.unmount());
  });

  it.each(["failed", "authenticationRequired", "disabled", "unknown"])("does not show cached tools as healthy when MCP is %s", (runtimeStatus) => {
    mock.state.mcpServers = [{ name: "cached", runtimeStatus, initialized: true, serverInfo: {}, tools: [{name:"tool"}], toolsError: "discovery failed" }] as never[];
    const html = renderToStaticMarkup(<ServerTab />);
    expect(html).not.toContain('class="mcp-dot on"');
    expect(html).not.toContain("已连接");
    expect(html).toContain("discovery failed");
    expect(html).toContain("tool");
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

  it("invalidates loaded status and logs on disconnect, then reads current status without replaying log reads", async () => {
    const freshStatus = deferred<unknown>();
    mock.rpc.mockImplementation((method: string) => {
      if (method === "admin/logs") return Promise.resolve({ logs: "old-service-log" });
      return mock.generation === 1 ? Promise.resolve({ currentModel: "old-model", unit: "old-unit", active: "active" }) : freshStatus.promise;
    });
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<ServerTab />); });
    await act(async () => { button(renderer, "查看服务日志").props.onClick(); });
    expect(JSON.stringify(renderer.toJSON())).toContain("old-model");
    expect(JSON.stringify(renderer.toJSON())).toContain("old-service-log");

    act(() => { mock.state.connection = "closed"; renderer.update(<ServerTab />); });
    const disconnected = JSON.stringify(renderer.toJSON());
    expect(disconnected).not.toContain("old-model");
    expect(disconnected).not.toContain("old-unit");
    expect(disconnected).not.toContain("old-service-log");
    expect(disconnected).toContain("旧日志已失效");
    expect(button(renderer, "刷新服务器状态").props.disabled).toBe(true);
    expect(button(renderer, "重新读取服务日志").props.disabled).toBe(true);
    expect(button(renderer, "收起日志").props.disabled).toBe(false);

    await act(async () => { mock.generation++; mock.state.connection = "open"; renderer.update(<ServerTab />); });
    expect(JSON.stringify(renderer.toJSON())).toContain("正在读取服务器状态");
    expect(mock.rpc.mock.calls.filter(([name]) => name === "admin/status")).toHaveLength(2);
    expect(mock.rpc.mock.calls.filter(([name]) => name === "admin/logs")).toHaveLength(1);
    await act(async () => { freshStatus.resolve({ currentModel: "new-model", unit: "new-unit" }); });
    expect(JSON.stringify(renderer.toJSON())).toContain("new-model");
    expect(JSON.stringify(renderer.toJSON())).toContain("new-unit");
    expect(button(renderer, "刷新服务器状态").props.disabled).toBe(false);
    mock.rpc.mockResolvedValueOnce({ logs: "new-service-log" });
    await act(async () => { button(renderer, "重新读取服务日志").props.onClick(); });
    expect(JSON.stringify(renderer.toJSON())).toContain("new-service-log");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("旧日志已失效");
    act(() => renderer.unmount());
  });

  it.each(["resolve", "reject"] as const)("recovers an interrupted status read and ignores the obsolete request's late %s", async (settlement) => {
    const old = deferred<unknown>();
    const fresh = deferred<unknown>();
    mock.rpc.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<ServerTab />); });
    act(() => { mock.state.connection = "closed"; renderer.update(<ServerTab />); });
    expect(JSON.stringify(renderer.toJSON())).not.toContain("正在读取服务器状态");
    act(() => { mock.generation++; mock.state.connection = "connecting"; renderer.update(<ServerTab />); });
    await act(async () => { mock.state.connection = "open"; renderer.update(<ServerTab />); });
    expect(mock.rpc).toHaveBeenCalledTimes(2);
    await act(async () => { fresh.resolve({ currentModel: "fresh-model" }); });
    await act(async () => {
      if (settlement === "resolve") old.resolve({ currentModel: "obsolete-model" });
      else old.reject(new Error("obsolete-error"));
    });
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain("fresh-model");
    expect(rendered).not.toContain("obsolete-");
    expect(rendered).not.toContain("正在读取服务器状态");
    act(() => renderer.unmount());
  });

  it("leaves an interrupted log read visibly stale even when the generation changes before a connection render", async () => {
    const oldLogs = deferred<unknown>();
    mock.rpc.mockImplementation((method: string) => method === "admin/logs" ? oldLogs.promise : Promise.resolve({}));
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<ServerTab />); });
    act(() => { button(renderer, "查看服务日志").props.onClick(); });
    expect(JSON.stringify(renderer.toJSON())).toContain("日志加载中");
    mock.generation++;
    await act(async () => { oldLogs.resolve({ logs: "obsolete-log" }); });
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).not.toContain("日志加载中");
    expect(rendered).not.toContain("obsolete-log");
    expect(rendered).toContain("旧日志已失效");
    expect(button(renderer, "重新读取服务日志").props.disabled).toBe(false);
    expect(button(renderer, "收起日志").props.disabled).toBe(false);
    act(() => renderer.unmount());
  });

  it("starts a fresh status read when an obsolete reply reveals a new connection generation", async () => {
    const oldStatus = deferred<unknown>();
    mock.rpc.mockReturnValueOnce(oldStatus.promise).mockResolvedValueOnce({ currentModel: "current-generation-model" });
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<ServerTab />); });
    mock.generation++;
    await act(async () => { oldStatus.resolve({ currentModel: "obsolete-model" }); });
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain("current-generation-model");
    expect(rendered).not.toContain("obsolete-model");
    expect(rendered).not.toContain("正在读取服务器状态");
    expect(mock.rpc.mock.calls.map(([method]) => method)).toEqual(["admin/status", "admin/status"]);
    act(() => renderer.unmount());
  });

  it("lets a new log read supersede an interrupted one and lets collapse discard a pending read", async () => {
    const oldLogs = deferred<unknown>();
    const freshLogs = deferred<unknown>();
    const collapsedLogs = deferred<unknown>();
    const reads = [oldLogs, freshLogs, collapsedLogs];
    mock.rpc.mockImplementation((method: string) => method === "admin/logs" ? reads.shift()!.promise : Promise.resolve({}));
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<ServerTab />); });
    act(() => { button(renderer, "查看服务日志").props.onClick(); });
    act(() => { mock.state.connection = "closed"; renderer.update(<ServerTab />); });
    await act(async () => { mock.generation++; mock.state.connection = "open"; renderer.update(<ServerTab />); });
    act(() => { button(renderer, "重新读取服务日志").props.onClick(); });
    await act(async () => { freshLogs.resolve({ logs: "fresh-log" }); });
    await act(async () => { oldLogs.reject(new Error("obsolete-log-error")); });
    expect(JSON.stringify(renderer.toJSON())).toContain("fresh-log");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("obsolete-log-error");
    act(() => { button(renderer, "重新读取服务日志").props.onClick(); });
    act(() => { button(renderer, "收起日志").props.onClick(); });
    await act(async () => { collapsedLogs.resolve({ logs: "collapsed-log" }); });
    expect(JSON.stringify(renderer.toJSON())).not.toContain("collapsed-log");
    expect(button(renderer, "查看服务日志")).toBeDefined();
    act(() => renderer.unmount());
  });

  it("offers a read-only log retry after failure", async () => {
    mock.rpc.mockImplementation((method: string) => method === "admin/logs" ? Promise.reject(new Error("logs unavailable")) : Promise.resolve({}));
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<ServerTab />); });
    await act(async () => { button(renderer, "查看服务日志").props.onClick(); });
    expect(JSON.stringify(renderer.toJSON())).toContain("logs unavailable");
    mock.rpc.mockResolvedValueOnce({ logs: "recovered-log" });
    await act(async () => { button(renderer, "重试服务日志").props.onClick(); });
    expect(JSON.stringify(renderer.toJSON())).toContain("recovered-log");
    expect(mock.rpc.mock.calls.map(([method]) => method)).toEqual(["admin/status", "admin/logs", "admin/logs"]);
    act(() => renderer.unmount());
  });

  it("waits for an open connection before the initial status read", async () => {
    mock.state.connection = "closed";
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<ServerTab />); });
    expect(mock.rpc).not.toHaveBeenCalled();
    expect(button(renderer, "刷新服务器状态").props.disabled).toBe(true);
    await act(async () => { mock.state.connection = "open"; renderer.update(<ServerTab />); });
    expect(mock.rpc.mock.calls.map(([method]) => method)).toEqual(["admin/status"]);
    expect(button(renderer, "刷新服务器状态").props.disabled).toBe(false);
    act(() => renderer.unmount());
  });

  it("allows explicit diagnostics during a pending mutation and never repeats the mutation on reconnect", async () => {
    const mutation = deferred<unknown>();
    mock.rpc.mockImplementation((method: string) => method === "admin/service/restart" ? mutation.promise : Promise.resolve({}));
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<ServerTab />); });
    act(() => { button(renderer, "重启服务").props.onClick(); });
    expect(button(renderer, "重启中…").props.disabled).toBe(true);
    expect(button(renderer, "刷新服务器状态").props.disabled).toBe(false);
    expect(button(renderer, "查看服务日志").props.disabled).toBe(false);
    await act(async () => { button(renderer, "刷新服务器状态").props.onClick(); });
    await act(async () => { button(renderer, "查看服务日志").props.onClick(); });
    act(() => { mock.state.connection = "closed"; renderer.update(<ServerTab />); });
    await act(async () => { mock.generation++; mock.state.connection = "open"; renderer.update(<ServerTab />); });
    expect(button(renderer, "重启中…").props.disabled).toBe(true);
    await act(async () => { mutation.reject(new Error("connection closed")); });
    expect(JSON.stringify(renderer.toJSON())).toContain("请求结果待确认");
    expect(mock.rpc.mock.calls.filter(([method]) => method === "admin/service/restart")).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it("does not restart reads when status and logs settle after the tab unmounts", async () => {
    const status = deferred<unknown>();
    const logs = deferred<unknown>();
    mock.rpc.mockImplementation((method: string) => method === "admin/logs" ? logs.promise : status.promise);
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<ServerTab />); });
    act(() => { button(renderer, "查看服务日志").props.onClick(); });
    act(() => renderer.unmount());
    mock.generation++;
    await act(async () => { status.resolve({ currentModel: "unmounted-model" }); logs.reject(new Error("unmounted-error")); });
    expect(renderer.toJSON()).toBe(null);
    expect(mock.rpc.mock.calls.map(([method]) => method)).toEqual(["admin/status", "admin/logs"]);
  });
});
