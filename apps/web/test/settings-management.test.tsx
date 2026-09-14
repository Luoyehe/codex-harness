import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminResultFeedback, ServerTab } from "../src/components/SettingsModal";
import { normalizeManagement, type ManagementSnapshot, type ManagementOperation } from "../src/utils/management";

const mock = vi.hoisted(() => ({ state: { connection: "open", providerMode: "openai", management: { state: "idle" } as ManagementSnapshot, managementError: null, refreshManagement: async () => {}, mcpServers: [] }, rpc: vi.fn() }));
vi.mock("../src/store", () => ({ useStore: (select: (state: typeof mock.state) => unknown) => select(mock.state) }));
vi.mock("../src/api/ws", () => ({ gateway: { generation: 1, rpc: mock.rpc } }));

describe("supported server management interface", () => {
  beforeEach(() => {
    mock.state.connection = "open";
    mock.state.management = { state: "idle", operation: undefined };
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
    const snapshot = normalizeManagement({ state: "unknown", error: "x".repeat(5000), secret: "example", lastOperation: {
      operationId: "op", operation: "admin/catalog/sync", outcome: "unknown", startedAt: 1, updatedAt: 2, config: "private value",
    } });
    expect(snapshot.error).toHaveLength(2000);
    expect(JSON.stringify(snapshot)).not.toContain("private value");
    expect(JSON.stringify(snapshot)).not.toContain("example");
  });
});
