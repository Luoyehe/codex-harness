import { useEffect, useRef, useState, type RefObject } from "react";
import { gateway } from "../api/ws";
import { useStore } from "../store";
import { validatedApiBaseUrl } from "../utils/validation";
import { managementOperationLabel, managementOutcomeText, type ManagementOperation } from "../utils/management";
import { boundedRedact } from "../utils/bounded-runtime";

/**
 * Settings modal — organized by scope, matching the user's mental model:
 *   通用       local preferences (this browser only): appearance & input
 *   对话       conversation behavior, persisted SERVER-side (all browsers):
 *              which timeline items render + auto-compact threshold
 *   服务器管理  server operations: status, provider, MCP, remote access, logs
 */
export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<"general" | "conversation" | "server">("general");
  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-tabs">
          <button className={tab === "general" ? "active" : ""} onClick={() => setTab("general")}>
            通用
          </button>
          <button className={tab === "conversation" ? "active" : ""} onClick={() => setTab("conversation")}>
            对话
          </button>
          <button className={tab === "server" ? "active" : ""} onClick={() => setTab("server")}>
            服务器管理
          </button>
          <span className="spacer" />
          <button className="icon-btn" title="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        {tab === "general" ? (
          <GeneralTab />
        ) : tab === "conversation" ? (
          <ConversationTab />
        ) : (
          <ServerTab />
        )}
      </div>
    </div>
  );
}

function GeneralTab() {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);

  const themes: Array<{ value: "system" | "light" | "dark"; label: string }> = [
    { value: "system", label: "跟随系统" },
    { value: "light", label: "浅色" },
    { value: "dark", label: "深色" },
  ];

  return (
    <div className="settings-body">
      <div className="dim settings-hint">界面与输入偏好，仅影响当前浏览器（本地保存）。</div>

      <section>
        <div className="settings-label">主题</div>
        <div className="seg-group">
          {themes.map((t) => (
            <button
              key={t.value}
              className={`seg ${settings.theme === t.value ? "active" : ""}`}
              onClick={() => updateSettings({ theme: t.value })}
            >
              {t.label}
            </button>
          ))}
        </div>
      </section>

      <section>
        <div className="settings-label">Enter 键行为</div>
        <div className="seg-group">
          <button
            className={`seg ${settings.enterBehavior === "send" ? "active" : ""}`}
            onClick={() => updateSettings({ enterBehavior: "send" })}
          >
            Enter 发送
          </button>
          <button
            className={`seg ${settings.enterBehavior === "newline" ? "active" : ""}`}
            onClick={() => updateSettings({ enterBehavior: "newline" })}
          >
            Enter 换行
          </button>
        </div>
        <div className="dim settings-hint">
          {settings.enterBehavior === "send" ? "Enter 发送消息，Shift+Enter 换行" : "Enter 换行，Shift+Enter 发送消息"}
        </div>
      </section>
    </div>
  );
}

function ConversationTab() {
  const display = useStore((s) => s.display);
  const updateDisplay = useStore((s) => s.updateDisplay);
  const displayError = useStore((s) => s.displayError);
  const connection = useStore((s) => s.connection);

  const thresholds = [0, 0.8, 0.85, 0.9, 0.95];

  type BoolDisplayKey = "reasoning" | "commands" | "fileChanges" | "mcpCalls" | "webSearch";
  const rows: Array<{ key: BoolDisplayKey; label: string; desc: string }> = [
    { key: "reasoning", label: "思考摘要", desc: "模型的推理摘要（原始思考可展开）" },
    { key: "commands", label: "命令执行", desc: "Shell 命令及其输出" },
    { key: "fileChanges", label: "文件修改", desc: "文件的增删改与 diff" },
    { key: "mcpCalls", label: "MCP 工具调用", desc: "MCP 服务器的工具调用详情" },
    { key: "webSearch", label: "网络搜索", desc: "内置搜索工具的结果" },
  ];

  return (
    <div className="settings-body">
      <div className="dim settings-hint">
        对话内容的显示与上下文管理。保存在服务器端，对所有浏览器和重启后的会话生效。
      </div>
      {connection !== "open" && <div className="dim">网关未连接，修改暂不会保存</div>}
      {displayError && <div className="error-text" role="alert">{displayError}</div>}

      <section>
        <div className="settings-label">对话中显示的内容</div>
        {rows.map((r) => (
          <label key={r.key} className="toggle-row">
            <span className="toggle-text">
              <span className="toggle-label">{r.label}</span>
              <span className="dim toggle-desc">{r.desc}</span>
            </span>
            <input
              type="checkbox"
              disabled={connection !== "open"}
              checked={display[r.key]}
              onChange={(e) => updateDisplay({ [r.key]: e.target.checked })}
            />
          </label>
        ))}
        <div className="dim settings-hint">关闭后对应内容不在对话中显示（仅影响显示，不影响执行）。</div>
      </section>

      <section>
        <div className="settings-label">自动压缩阈值</div>
        <div className="seg-group">
          {thresholds.map((t) => (
            <button
              key={t}
              className={`seg ${display.autoCompactThreshold === t ? "active" : ""}`}
              disabled={connection !== "open"}
              onClick={() => updateDisplay({ autoCompactThreshold: t })}
            >
              {t === 0 ? "关闭" : `${Math.round(t * 100)}%`}
            </button>
          ))}
        </div>
        <div className="dim settings-hint">
          {display.autoCompactThreshold === 0
            ? "不自动压缩；上下文占满时任务会失败，需手动点压缩按钮"
            : `上下文占用超过 ${Math.round(display.autoCompactThreshold * 100)}% 时，在任务间隙自动总结历史释放空间。仅在任务外触发，不会打断正在执行的任务。`}
        </div>
      </section>
    </div>
  );
}

/** MCP server status — lives under 服务器管理: it's server-side
 *  infrastructure configured by the active provider preset. */
function McpSection() {
  const mcpServers = useStore((s) => s.mcpServers);
  const mcpLoad = useStore((s) => s.mcpLoad);
  const refreshMcp = useStore((s) => s.refreshMcp);
  const connection = useStore((s) => s.connection);

  return (
    <section>
      <div className="settings-label">MCP 服务器</div>
      {connection !== "open" && <div className="dim">网关未连接，状态可能过期</div>}
      {mcpLoad.state === "loading" && mcpServers.length === 0 && <div className="dim" role="status">正在读取 MCP 状态…</div>}
      {mcpLoad.state === "loading" && mcpServers.length > 0 && <div className="dim" role="status">正在刷新 MCP 状态；下方显示上次成功读取的结果。</div>}
      {mcpLoad.state === "error" && (
        <div className="error-text" role="alert">
          {mcpLoad.error ?? "MCP 状态读取失败；不能判断是否已配置。"}{" "}
          <button className="btn" disabled={connection !== "open"} onClick={() => void refreshMcp()}>重试</button>
        </div>
      )}
      {mcpServers.map((m) => {
        const runtime = m as unknown as { tools?: unknown; toolCount?: unknown; toolsTruncated?: unknown; initialized?: unknown; serverInfo?: unknown };
        const toolRecords: Array<{ name?: unknown; description?: unknown }> = [];
        let observedToolCount = 0;
        let collectionTruncated = false;
        if (Array.isArray(runtime.tools)) {
          observedToolCount = Math.min(runtime.tools.length, 501);
          collectionTruncated = runtime.tools.length > 500;
          for (let index = 0; index < Math.min(runtime.tools.length, 500); index++) {
            const value = runtime.tools[index];
            toolRecords.push(value && typeof value === "object" && !Array.isArray(value) ? value : {});
          }
        } else if (runtime.tools && typeof runtime.tools === "object") {
          const source = runtime.tools as Record<string, unknown>;
          for (const key in source) {
            if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
            observedToolCount += 1;
            if (observedToolCount > 500) {
              collectionTruncated = true;
              break;
            }
            const value = source[key];
            toolRecords.push(value && typeof value === "object" && !Array.isArray(value) ? value : {});
          }
        }
        const tools = toolRecords
          .map((tool) => ({
            name: typeof tool?.name === "string" ? tool.name.slice(0, 256) : undefined,
            description: typeof tool?.description === "string" ? tool.description.slice(0, 2_000) : undefined,
          }));
        // An initialized MCP server is healthy even when it intentionally
        // advertises no tools. Conversely, an absent serverInfo plus an empty
        // tool list means the server has not finished loading.
        const healthy = typeof runtime.initialized === "boolean"
          ? runtime.initialized
          : (runtime.serverInfo !== null && typeof runtime.serverInfo === "object") || toolRecords.length > 0;
        const toolCount = typeof runtime.toolCount === "number" && Number.isSafeInteger(runtime.toolCount) && runtime.toolCount >= tools.length
          ? runtime.toolCount : observedToolCount;
        const truncated = runtime.toolsTruncated === true || collectionTruncated || toolCount > tools.length;
        const shownCount = Math.max(toolCount, truncated ? tools.length + 1 : tools.length);
        const toolSummary = truncated
          ? `至少 ${shownCount} 个工具（仅显示前 ${tools.length} 个）`
          : `${shownCount} 个工具`;
        let toolTitle = "";
        for (const tool of tools) {
          const name = tool.name ?? "";
          if (!name) continue;
          const separator = toolTitle ? ", " : "";
          if (toolTitle.length + separator.length + name.length > 2_000) {
            toolTitle += "…";
            break;
          }
          toolTitle += separator + name;
        }
        return (
          <div key={m.name} className={`mcp-card ${healthy ? "" : "mcp-card-stale"}`}>
            <div className="mcp-card-head">
              <span className={`mcp-dot ${healthy ? "on" : ""}`} />
              <span className="mcp-card-name">{m.name}</span>
              <span className="dim">
                {healthy ? `已连接 · ${toolSummary}` : "未加载（尚未连接或启动失败）"}
              </span>
            </div>
            {tools.length > 0 && (
              <div className="mcp-tools" title={toolTitle}>
                {tools.map((t, i) => (
                  <span key={i} className="mcp-tool-chip" title={t.description ?? t.name}>
                    {t.name ?? i}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {mcpLoad.state === "loaded" && mcpServers.length === 0 && (
        <div className="dim">
          未配置 MCP 服务器。智谱 Coding Plan 模式会自动配置官方四件套（切换上方模型源即可）。
        </div>
      )}
    </section>
  );
}

/** One admin action = fixed script + env on the server; result shown inline. */
interface AdminResult {
  ok: boolean;
  restarting: boolean;
  changed?: boolean;
  restartRequired?: boolean;
  output?: string;
  mode?: string;
  operationId?: string;
  uncertain?: boolean;
}

interface AdminStatus {
  currentModel?: string;
  unit?: string;
  active?: string;
}

const ADMIN_OUTPUT_LIMIT = 200_000;

function boundedResponseString(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length <= limit ? value : `${value.slice(0, limit)}\n…（输出过长，仅显示前 ${limit.toLocaleString()} 个字符）`;
}

function normalizeAdminStatus(value: unknown): AdminStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    currentModel: boundedResponseString(record.currentModel, 256),
    unit: boundedResponseString(record.unit, 256),
    active: boundedResponseString(record.active, 64),
  };
}

function normalizeLogsResponse(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "日志响应格式无效";
  const logs = (value as Record<string, unknown>).logs;
  if (logs == null || logs === "") return "(无日志)";
  return boundedResponseString(logs, ADMIN_OUTPUT_LIMIT) ?? "日志响应格式无效";
}

export function AdminResultFeedback({ result, record }: { result: AdminResult; record?: ManagementOperation }) {
  const matching = result.operationId && record?.operationId === result.operationId ? record : undefined;
  const pending = result.uncertain || result.restarting || result.restartRequired;
  const summary = matching ? managementOutcomeText(matching) : result.uncertain
    ? "请求结果待确认：服务器可能已修改配置。请核对管理状态，未自动重试。"
    : !result.ok ? "请求失败，请核对错误与服务器状态。"
    : pending ? "配置步骤已完成，重启结果待确认；这不是完整成功结果。"
    : result.changed === false ? "配置没有变化，无需重启。" : "配置已更新，无需重启。";
  return <>
    <div className="settings-label">本次请求回执</div>
    <div className="dim settings-hint" role="status">{summary}</div>
    {result.operationId && <div className="dim settings-hint">操作标识：{result.operationId}</div>}
    <pre className="admin-output">{result.output || "(无输出)"}</pre>
  </>;
}

function redactKnownSecrets(output: unknown, secrets: string[]): string {
  return boundedRedact(output, secrets, ADMIN_OUTPUT_LIMIT);
}

function normalizeAdminResult(value: unknown, secrets: string[]): AdminResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, restarting: false, uncertain: true, output: "服务器返回的管理响应格式无效；操作结果待确认。" };
  }
  const record = value as Record<string, unknown>;
  const malformed = typeof record.ok !== "boolean" || typeof record.restarting !== "boolean" ||
    record.changed !== undefined && typeof record.changed !== "boolean" ||
    record.restartRequired !== undefined && typeof record.restartRequired !== "boolean" ||
    record.uncertain !== undefined && typeof record.uncertain !== "boolean" ||
    record.mode !== undefined && typeof record.mode !== "string" ||
    record.operationId !== undefined && typeof record.operationId !== "string" ||
    record.output !== undefined && typeof record.output !== "string";
  const safeOutput = typeof record.output === "string" ? redactKnownSecrets(record.output, secrets) : "";
  if (malformed) {
    return {
      ok: false,
      restarting: false,
      uncertain: true,
      output: `服务器返回的管理响应格式无效；操作结果待确认。${safeOutput ? `\n${safeOutput}` : ""}`,
    };
  }
  return {
    ok: record.ok === true,
    restarting: record.restarting === true,
    ...(typeof record.changed === "boolean" ? { changed: record.changed } : {}),
    ...(typeof record.restartRequired === "boolean" ? { restartRequired: record.restartRequired } : {}),
    ...(typeof record.mode === "string" ? { mode: record.mode.slice(0, 256) } : {}),
    ...(typeof record.operationId === "string" ? { operationId: record.operationId.slice(0, 128) } : {}),
    ...(record.uncertain === true ? { uncertain: true } : {}),
    output: safeOutput,
  };
}

export function ServerTab() {
  const connection = useStore((s) => s.connection);
  const providerMode = useStore((s) => s.providerMode);
  const management = useStore((s) => s.management);
  const managementError = useStore((s) => s.managementError);
  const refreshManagement = useStore((s) => s.refreshManagement);
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [statusLoad, setStatusLoad] = useState<{ state: "loading" | "loaded" | "error"; error: string | null }>({ state: "loading", error: null });
  const [localBusy, setBusy] = useState<string | null>(null);
  const busy = localBusy ?? (management.state === "idle" ? null : management.operation ?? "management");
  const [result, setResult] = useState<AdminResult | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [checkingManagement, setCheckingManagement] = useState(false);
  // Results render at the BOTTOM of this long panel — without scrolling to
  // them, a click looks like "nothing happened".
  const resultRef = useRef<HTMLDivElement>(null);
  const logsRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  const logsRequestSeq = useRef(0);
  const statusRequestSeq = useRef(0);
  const statusMounted = useRef(true);

  const scrollTo = (ref: RefObject<HTMLDivElement | null>) => {
    globalThis.setTimeout(() => ref.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  };

  // provider switch forms
  const [zhipuKey, setZhipuKey] = useState("");
  const [zhipuModel, setZhipuModel] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [customKey, setCustomKey] = useState("");
  const [customVision, setCustomVision] = useState(false);
  const validCustomUrl = validatedApiBaseUrl(customUrl);

  async function refreshStatus() {
    if (!statusMounted.current) return;
    const request = ++statusRequestSeq.current;
    const generation = gateway.generation;
    if (statusMounted.current) setStatusLoad({ state: "loading", error: null });
    try {
      const next = await gateway.rpc<unknown>("admin/status");
      if (!statusMounted.current || request !== statusRequestSeq.current || generation !== gateway.generation) return;
      setStatus(normalizeAdminStatus(next));
      setStatusLoad({ state: "loaded", error: null });
    } catch (error) {
      if (!statusMounted.current || request !== statusRequestSeq.current || generation !== gateway.generation) return;
      const detail = error instanceof Error ? error.message.slice(0, 1_000) : "未知错误";
      setStatusLoad({ state: "error", error: `服务器状态读取失败：${detail}` });
    }
  }

  useEffect(() => {
    statusMounted.current = true;
    void refreshManagement();
    void refreshStatus();
    return () => {
      statusMounted.current = false;
      statusRequestSeq.current += 1;
      logsRequestSeq.current += 1;
    };
  }, []);

  async function run(label: string, fn: () => Promise<unknown>, secrets: string[] = []) {
    if (busyRef.current || management.state !== "idle" || connection !== "open") return;
    busyRef.current = true;
    setBusy(label);
    setResult(null);
    try {
      const next = await fn();
      setResult(normalizeAdminResult(next, secrets));
    } catch (err: any) {
      setResult({
        ok: false,
        restarting: false,
        uncertain: err?.delivery !== "not_sent" && err?.delivery !== "rejected",
        output: redactKnownSecrets(err?.message ?? String(err), secrets),
      });
    } finally {
      busyRef.current = false;
      setBusy(null);
      scrollTo(resultRef);
      void refreshManagement();
      void refreshStatus();
    }
  }

  const restarting = management.state === "restart_pending" && connection !== "open";

  function switchToOpenAi(): void {
    setZhipuKey("");
    setCustomKey("");
    void run("openai", () => gateway.rpc<any>("admin/provider/switch", { mode: "openai" }));
  }

  function configureZhipu(): void {
    const key = zhipuKey.trim();
    const model = zhipuModel.trim().slice(0, 256);
    setZhipuKey("");
    void run(
      "zhipu",
      () => gateway.rpc<any>("admin/provider/switch", {
        mode: "zhipu",
        zhipuKey: key || undefined,
        model: model || undefined,
      }),
      [key],
    );
  }

  function configureCustom(): void {
    if (!validCustomUrl || !customModel.trim()) return;
    const key = customKey;
    const model = customModel.trim().slice(0, 256);
    setCustomKey("");
    void run(
      "custom",
      () => gateway.rpc<any>("admin/provider/switch", {
        mode: "custom",
        customBaseUrl: validCustomUrl,
        customModel: model,
        customApiKey: key,
        customVision,
      }),
      [key],
    );
  }

  return (
    <div className="settings-body">
      {restarting && (
        <div className="admin-restarting">
          重启结果待确认，页面会自动尝试重连；请以服务器管理记录为准，不要重复提交配置。
        </div>
      )}
      {management.state !== "idle" && <div className="dim settings-hint" role="status">
        {management.state === "unknown" ? "管理操作结果未知，暂时不能开始新任务或再次配置。请核对管理状态；必要时通过服务器终端检查。"
          : management.state === "restart_pending" ? "配置步骤已完成，正在等待服务重启；重启结果仍待确认。" : "服务器配置操作正在进行；完成前不能开始新任务或另一项配置操作。"}
      </div>}
      {connection !== "open" && !restarting && <div className="dim settings-hint" role="status">网关未连接，服务器管理操作暂不可用。</div>}

      <section>
        <div className="settings-label">服务器管理记录</div>
        {management.lastOperation ? <div className="admin-card">
          <div>{managementOperationLabel(management.lastOperation.operation)}</div>
          <div role="status">{managementOutcomeText(management.lastOperation)}</div>
          <div className="dim settings-hint">操作标识：{management.lastOperation.operationId}</div>
          {management.lastOperation.error && <pre className="admin-output error-text" role="alert">{management.lastOperation.error}</pre>}
        </div> : <div className="dim settings-hint">暂无已记录的管理操作。</div>}
        {management.error && <div className="error-text" role="alert">{management.error}</div>}
        {managementError && <div className="error-text" role="alert">{managementError}</div>}
        <button className="btn" disabled={connection !== "open" || checkingManagement} onClick={() => {
          setCheckingManagement(true);
          void refreshManagement().finally(() => setCheckingManagement(false));
        }}>{checkingManagement ? "核对中…" : "核对管理状态（不会重试配置）"}</button>
        <div className="dim settings-hint">记录保存在服务器，刷新或重连后重新核对；仅显示最近一次操作。配置成功不等于外部模型或 MCP 业务验证通过。</div>
      </section>

      <section>
        <div className="settings-label">当前状态</div>
        <div className="dim settings-hint">
          模型源：{providerMode === "zhipu" ? "智谱 Coding Plan" : providerMode === "custom" ? "自定义 API" : "OpenAI 原生"}
          {status?.currentModel ? ` · 模型：${status.currentModel}` : ""}
          {status?.unit ? ` · 服务：${status.unit}（${status.active ?? "?"}）` : ""}
        </div>
        {statusLoad.state === "loading" && <div className="dim settings-hint" role="status">
          {status ? "正在刷新服务器状态；上方显示上次成功结果。" : "正在读取服务器状态…"}
        </div>}
        {statusLoad.state === "error" && <div className="error-text" role="alert">
          {statusLoad.error ?? "服务器状态读取失败。"}{status ? " 上方显示上次成功结果。" : ""}{" "}
          <button className="btn" disabled={connection !== "open"} onClick={() => void refreshStatus()}>重试服务器状态</button>
        </div>}
        <div className="admin-actions">
          <button
            className="btn"
            disabled={!!busy || connection !== "open"}
            onClick={() => run("sync", () => gateway.rpc<any>("admin/catalog/sync"))}
          >
            {busy === "sync" ? "同步中…" : "⟳ 一键同步上游模型与思考档位"}
          </button>
          <button
            className="btn"
            disabled={!!busy || connection !== "open"}
            onClick={() => run("restart", () => gateway.rpc<any>("admin/service/restart"))}
          >
            {busy === "restart" ? "重启中…" : "重启服务"}
          </button>
          <button
            className="btn"
            disabled={!!busy || logsLoading || connection !== "open"}
            onClick={() => {
              // Toggle: a second click collapses the (long) log block.
              if (logs !== null && !logsLoading) {
                logsRequestSeq.current += 1;
                setLogs(null);
                return;
              }
              const request = ++logsRequestSeq.current;
              const generation = gateway.generation;
              setLogsLoading(true);
              setLogs("日志加载中…");
              void gateway.rpc<any>("admin/logs", { lines: 80 })
                .then((r) => {
                  if (request !== logsRequestSeq.current || generation !== gateway.generation) return;
                  setLogs(normalizeLogsResponse(r));
                  scrollTo(logsRef);
                })
                .catch((e) => {
                  if (request !== logsRequestSeq.current || generation !== gateway.generation) return;
                  setLogs(`日志加载失败: ${e?.message ?? e}`);
                  scrollTo(logsRef);
                })
                .finally(() => {
                  if (request === logsRequestSeq.current) setLogsLoading(false);
                });
            }}
          >
            {logsLoading ? "日志加载中…" : logs !== null ? "收起日志" : "查看服务日志"}
          </button>
        </div>
        <div className="dim settings-hint">
          同步读取当前模型源的目录并保留已知能力，不发起付费思考档位探测。OpenAI 原生目录无需同步；其他模式仅在配置变化且需要重启时自动重启，无变化不会重启。
        </div>
        <div className="dim settings-hint">
          更改配置或手动重启前，请先结束运行中的任务和网页终端；不会为管理操作强行中断工作。
        </div>
      </section>

      <section>
        <div className="settings-label">切换模型源（三选一）</div>
        <div className="dim settings-hint">切换或更新配置后，服务器仅在需要时安排重启；配置无变化时不会重启。</div>

        <div className="admin-card">
          <div className="admin-card-title">1 · OpenAI / ChatGPT 原生</div>
          <div className="dim">启用空的受管理配置，使用 Codex 原生默认值；其它模式的配置与密钥保留。切换后可用页面右上角设备码登录。</div>
          <button
            className="btn-primary"
            disabled={!!busy || connection !== "open" || providerMode === "openai"}
            onClick={switchToOpenAi}
          >
            {providerMode === "openai" ? "当前模式" : busy === "openai" ? "切换中…" : "切换到 OpenAI 原生"}
          </button>
        </div>

        <div className="admin-card">
          <div className="admin-card-title">2 · 智谱个人版 Coding Plan</div>
          <div className="admin-form">
            <input
              type="password"
              placeholder="API Key（留空使用服务器已保存的 Key）"
              value={zhipuKey}
              onChange={(e) => setZhipuKey(e.target.value)}
              maxLength={8_192}
              autoComplete="new-password"
              spellCheck={false}
            />
            <input
              type="text"
              placeholder="模型 slug（留空 = 默认 glm-5.3；切换后可在同步里重选）"
              value={zhipuModel}
              onChange={(e) => setZhipuModel(e.target.value)}
              maxLength={256}
              spellCheck={false}
            />
          </div>
          <button
            className="btn-primary"
            disabled={!!busy || connection !== "open"}
            onClick={configureZhipu}
          >
            {busy === "zhipu" ? "配置中…" : providerMode === "zhipu" ? "更新智谱 Key / 模型" : "切换到智谱 Coding Plan"}
          </button>
        </div>

        <div className="admin-card">
          <div className="admin-card-title">3 · 自定义 OpenAI 兼容 API（vLLM / 中转站）</div>
          <div className="admin-form">
            <input
              type="url"
              placeholder="base_url，如 http://127.0.0.1:8000/v1（需 /responses）"
              value={customUrl}
              onChange={(e) => setCustomUrl(e.target.value)}
              maxLength={2_048}
              spellCheck={false}
            />
            {customUrl.trim() && !validCustomUrl && <div className="error-text">端点必须是无内嵌账号、查询参数或片段的 http:// 或 https:// URL</div>}
            <input type="text" placeholder="模型 id" value={customModel} onChange={(e) => setCustomModel(e.target.value)} maxLength={256} spellCheck={false} />
            <input
              type="password"
              placeholder="API Key（本地无鉴权服务留空）"
              value={customKey}
              onChange={(e) => setCustomKey(e.target.value)}
              maxLength={8_192}
              autoComplete="new-password"
              spellCheck={false}
            />
            <label className="toggle-row">
              <span className="toggle-text"><span className="toggle-label">端点支持图片输入</span></span>
              <input type="checkbox" checked={customVision} onChange={(e) => setCustomVision(e.target.checked)} />
            </label>
          </div>
          <button
            className="btn-primary"
            disabled={!!busy || connection !== "open" || !validCustomUrl || !customModel.trim()}
            onClick={configureCustom}
          >
            {busy === "custom" ? "配置中…" : providerMode === "custom" ? "重新配置自定义 API" : "切换到自定义 API"}
          </button>
        </div>
      </section>

      <McpSection />

      <section>
        <div className="settings-label">远程访问（Caddy + Authelia HTTPS）</div>
        <div className="dim settings-hint">
          HTTPS 入口和认证服务属于系统配置。网关与 Agent 使用独立的非 root 账号，网页不提供系统配置权限，也不支持旧式 root 服务直配。
        </div>
        <div className="admin-card">
          <div>请通过 SSH 登录服务器，在服务器终端配置或变更入口：</div>
          <pre className="admin-output">sudo codex-harness edge</pre>
          <div>关闭当前实例的远程入口，恢复仅本机 / SSH 隧道访问：</div>
          <pre className="admin-output">sudo codex-harness edge disable</pre>
          <div className="dim settings-hint">以上为默认实例命令。自定义实例请使用安装时生成的专属管理命令；不要在网页终端尝试提权，也无需在网页提交域名、证书或认证密码。</div>
        </div>
      </section>

      {result && (
        <section ref={resultRef}>
          <AdminResultFeedback result={result} record={management.lastOperation} />
        </section>
      )}

      {logs !== null && (
        <section ref={logsRef}>
          <div className="settings-label">服务日志（最近 80 行）</div>
          <pre className="admin-output">{logs}</pre>
        </section>
      )}
    </div>
  );
}
