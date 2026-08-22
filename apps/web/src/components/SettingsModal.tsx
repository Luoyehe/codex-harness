import { useEffect, useRef, useState, type RefObject } from "react";
import { gateway } from "../api/ws";
import { useStore, type Display } from "../store";

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
  const connection = useStore((s) => s.connection);

  return (
    <section>
      <div className="settings-label">MCP 服务器</div>
      {connection !== "open" && <div className="dim">网关未连接，状态可能过期</div>}
      {mcpServers.map((m: any) => {
        const tools = Object.values(m.tools ?? {}) as Array<{ name?: string; description?: string }>;
        const healthy = tools.length > 0;
        return (
          <div key={m.name} className={`mcp-card ${healthy ? "" : "mcp-card-stale"}`}>
            <div className="mcp-card-head">
              <span className={`mcp-dot ${healthy ? "on" : ""}`} />
              <span className="mcp-card-name">{m.name}</span>
              <span className="dim">
                {healthy ? `${tools.length} 个工具` : "未加载（尚未连接或启动失败）"}
              </span>
            </div>
            {tools.length > 0 && (
              <div className="mcp-tools" title={tools.map((t) => t.name).join(", ")}>
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
      {mcpServers.length === 0 && (
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
  output: string;
  mode?: string;
}

function ServerTab() {
  const connection = useStore((s) => s.connection);
  const providerMode = useStore((s) => s.providerMode);
  const [status, setStatus] = useState<{ currentModel?: string; unit?: string; active?: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<AdminResult | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  // Results render at the BOTTOM of this long panel — without scrolling to
  // them, a click looks like "nothing happened".
  const resultRef = useRef<HTMLDivElement>(null);
  const logsRef = useRef<HTMLDivElement>(null);

  const scrollTo = (ref: RefObject<HTMLDivElement | null>) => {
    window.setTimeout(() => ref.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  };

  // provider switch forms
  const [zhipuKey, setZhipuKey] = useState("");
  const [zhipuModel, setZhipuModel] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [customKey, setCustomKey] = useState("");
  const [customVision, setCustomVision] = useState(false);
  // remote access form
  const [edgeDomain, setEdgeDomain] = useState("");
  const [edgePort, setEdgePort] = useState(443);
  const [edgeTls, setEdgeTls] = useState<"selfsigned" | "own">("selfsigned");
  const [edgeCertDir, setEdgeCertDir] = useState("");
  const [edgeUser, setEdgeUser] = useState("admin");
  const [edgePass, setEdgePass] = useState("");

  useEffect(() => {
    void gateway.rpc<any>("admin/status").then(setStatus).catch(() => {});
  }, []);

  async function run(label: string, fn: () => Promise<AdminResult>) {
    setBusy(label);
    setResult(null);
    try {
      setResult(await fn());
    } catch (err: any) {
      setResult({ ok: false, restarting: false, output: err?.message ?? String(err) });
    } finally {
      setBusy(null);
      scrollTo(resultRef);
      void gateway.rpc<any>("admin/status").then(setStatus).catch(() => {});
    }
  }

  const restarting = result?.restarting && connection !== "open";

  return (
    <div className="settings-body">
      {restarting && (
        <div className="admin-restarting">
          配置已应用，服务正在重启… 页面会自动重连，无需手动操作。
        </div>
      )}

      <section>
        <div className="settings-label">当前状态</div>
        <div className="dim settings-hint">
          模型源：{providerMode === "zhipu" ? "智谱 Coding Plan" : providerMode === "custom" ? "自定义 API" : "OpenAI 原生"}
          {status?.currentModel ? ` · 模型：${status.currentModel}` : ""}
          {status?.unit ? ` · 服务：${status.unit}（${status.active ?? "?"}）` : ""}
        </div>
        <div className="admin-actions">
          <button
            className="btn"
            disabled={!!busy}
            onClick={() => run("sync", () => gateway.rpc<any>("admin/catalog/sync"))}
          >
            {busy === "sync" ? "同步中…" : "⟳ 一键同步上游模型与思考档位"}
          </button>
          <button
            className="btn"
            disabled={!!busy}
            onClick={() => run("restart", () => gateway.rpc<any>("admin/service/restart"))}
          >
            {busy === "restart" ? "重启中…" : "重启服务"}
          </button>
          <button
            className="btn"
            disabled={!!busy || logsLoading}
            onClick={() => {
              // Toggle: a second click collapses the (long) log block.
              if (logs !== null && !logsLoading) {
                setLogs(null);
                return;
              }
              setLogsLoading(true);
              setLogs("日志加载中…");
              void gateway.rpc<any>("admin/logs", { lines: 80 })
                .then((r) => {
                  setLogs(r?.logs ?? "(无日志)");
                  scrollTo(logsRef);
                })
                .catch((e) => {
                  setLogs(`日志加载失败: ${e?.message ?? e}`);
                  scrollTo(logsRef);
                })
                .finally(() => setLogsLoading(false));
            }}
          >
            {logsLoading ? "日志加载中…" : logs !== null ? "收起日志" : "查看服务日志"}
          </button>
        </div>
        <div className="dim settings-hint">
          同步会从模型源拉取最新目录并重新探测思考档位（与安装脚本同一流程），完成后自动重启服务生效。
        </div>
      </section>

      <section>
        <div className="settings-label">切换模型源（三选一，切换后自动重启）</div>

        <div className="admin-card">
          <div className="admin-card-title">1 · OpenAI / ChatGPT 原生</div>
          <div className="dim">移除激活配置软链，回到零配置原生模式；其它模式的配置集保留。切换后可用页面右上角设备码登录。</div>
          <button
            className="btn-primary"
            disabled={!!busy || providerMode === "openai"}
            onClick={() => run("openai", () => gateway.rpc<any>("admin/provider/switch", { mode: "openai" }))}
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
            />
            <input
              type="text"
              placeholder="模型 slug（留空 = 默认 glm-5.3；切换后可在同步里重选）"
              value={zhipuModel}
              onChange={(e) => setZhipuModel(e.target.value)}
            />
          </div>
          <button
            className="btn-primary"
            disabled={!!busy || providerMode === "zhipu"}
            onClick={() =>
              run("zhipu", () =>
                gateway.rpc<any>("admin/provider/switch", {
                  mode: "zhipu",
                  zhipuKey: zhipuKey || undefined,
                  model: zhipuModel || undefined,
                }),
              )
            }
          >
            {providerMode === "zhipu" ? "当前模式（可重跑以换 Key/模型）" : busy === "zhipu" ? "切换中…" : "切换到智谱 Coding Plan"}
          </button>
        </div>

        <div className="admin-card">
          <div className="admin-card-title">3 · 自定义 OpenAI 兼容 API（vLLM / 中转站）</div>
          <div className="admin-form">
            <input type="text" placeholder="base_url，如 http://127.0.0.1:8000/v1（需 /responses）" value={customUrl} onChange={(e) => setCustomUrl(e.target.value)} />
            <input type="text" placeholder="模型 id" value={customModel} onChange={(e) => setCustomModel(e.target.value)} />
            <input type="password" placeholder="API Key（本地无鉴权服务留空）" value={customKey} onChange={(e) => setCustomKey(e.target.value)} />
            <label className="toggle-row">
              <span className="toggle-text"><span className="toggle-label">端点支持图片输入</span></span>
              <input type="checkbox" checked={customVision} onChange={(e) => setCustomVision(e.target.checked)} />
            </label>
          </div>
          <button
            className="btn-primary"
            disabled={!!busy || !customUrl.trim() || !customModel.trim()}
            onClick={() =>
              run("custom", () =>
                gateway.rpc<any>("admin/provider/switch", {
                  mode: "custom",
                  customBaseUrl: customUrl.trim(),
                  customModel: customModel.trim(),
                  customApiKey: customKey,
                  customVision,
                }),
              )
            }
          >
            {providerMode === "custom" ? "重新配置自定义 API" : busy === "custom" ? "切换中…" : "切换到自定义 API"}
          </button>
        </div>
      </section>

      <McpSection />

      <section>
        <div className="settings-label">远程访问（Caddy + Authelia HTTPS）</div>
        <div className="dim settings-hint">
          配置对外域名与登录账号；向导会自动装好 Caddy + Authelia、注册网关信任列表并重载。已在服务器配置过则保持不变。
        </div>
        <div className="admin-form">
          <input type="text" placeholder="对外域名，如 codex.example.com" value={edgeDomain} onChange={(e) => setEdgeDomain(e.target.value)} />
          <input type="number" placeholder="HTTPS 端口（默认 443）" value={edgePort} onChange={(e) => setEdgePort(Number(e.target.value) || 443)} />
          <div className="seg-group">
            <button className={`seg ${edgeTls === "selfsigned" ? "active" : ""}`} onClick={() => setEdgeTls("selfsigned")}>自签证书</button>
            <button className={`seg ${edgeTls === "own" ? "active" : ""}`} onClick={() => setEdgeTls("own")}>自有证书</button>
          </div>
          {edgeTls === "own" && (
            <input type="text" placeholder="证书目录（cert.pem+key.pem 等）" value={edgeCertDir} onChange={(e) => setEdgeCertDir(e.target.value)} />
          )}
          <input type="text" placeholder="Authelia 登录用户名（默认 admin；已配置则忽略）" value={edgeUser} onChange={(e) => setEdgeUser(e.target.value)} />
          <input type="password" placeholder="Authelia 密码（已配置则忽略；留空自动生成）" value={edgePass} onChange={(e) => setEdgePass(e.target.value)} />
        </div>
        <button
          className="btn-primary"
          disabled={!!busy || !edgeDomain.trim()}
          onClick={() =>
            run("edge", () =>
              gateway.rpc<any>("admin/edge/config", {
                domain: edgeDomain.trim(),
                listenPort: edgePort,
                tls: edgeTls,
                certDir: edgeCertDir || undefined,
                username: edgeUser || undefined,
                password: edgePass || undefined,
              }),
            )
          }
        >
          {busy === "edge" ? "配置中…" : "应用远程访问配置"}
        </button>
      </section>

      {result && (
        <section ref={resultRef}>
          <div className="settings-label">上次操作结果（{result.ok ? "成功" : "失败"}）</div>
          <pre className="admin-output">{result.output || "(无输出)"}</pre>
          {result.restarting && <div className="dim settings-hint">服务将自动重启，页面重连后新配置生效。</div>}
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
