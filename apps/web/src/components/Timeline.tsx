import { memo, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore, type Display, type TimelineItem } from "../store";

// Stable reference: zustand v5 compares snapshots with Object.is, so an
// inline `?? []` would mint a fresh array every render and loop forever
// (React "Maximum update depth exceeded").
const EMPTY_ITEMS: TimelineItem[] = [];

/** item.type -> display-pref key; unlisted types always render. */
const HIDDEN_BY: Partial<Record<string, keyof Display>> = {
  reasoning: "reasoning",
  commandExecution: "commands",
  fileChange: "fileChanges",
  mcpToolCall: "mcpCalls",
  webSearch: "webSearch",
};

// Long conversations: render the newest slice + an explicit "show older"
// button. Rendering thousands of markdown blocks at once froze the tab.
const RENDER_CHUNK = 150;

export function Timeline() {
  const activeThreadId = useStore((s) => s.activeThreadId);
  const items = useStore((s) => (s.activeThreadId ? s.items[s.activeThreadId] : undefined)) ?? EMPTY_ITEMS;
  const display = useStore((s) => s.display);
  const plan = useStore((s) => (s.activeThreadId ? s.plan[s.activeThreadId] : null));
  const scrollRef = useRef<HTMLDivElement>(null);
  const [renderLimit, setRenderLimit] = useState(RENDER_CHUNK);
  // Stick-to-bottom: auto-follow only while the user is AT the bottom.
  const atBottomRef = useRef(true);

  const visible = useMemo(
    () => items.filter((it) => {
      const key = HIDDEN_BY[it.type];
      return !key || display[key];
    }),
    [items, display],
  );

  const last = visible[visible.length - 1];
  const lastIsLocalUser = !!last?.local && last.type === "userMessage";
  // Cheap "the tail changed" signal without depending on full item identity.
  const lastSignature = `${visible.length}:${last?.id ?? ""}:${(last?.text ?? last?.aggregatedOutput ?? "").length}`;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, [activeThreadId]);

  // Reset the window whenever the thread changes.
  useEffect(() => {
    setRenderLimit(RENDER_CHUNK);
    atBottomRef.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeThreadId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Follow the stream only when the user hasn't scrolled away, or when
    // their own message just landed (always jump to it).
    if (atBottomRef.current || lastIsLocalUser) {
      el.scrollTop = el.scrollHeight;
      atBottomRef.current = true;
    }
  }, [lastSignature, lastIsLocalUser]);

  const hiddenCount = Math.max(0, visible.length - renderLimit);
  const windowed = hiddenCount > 0 ? visible.slice(hiddenCount) : visible;

  if (!activeThreadId) {
    return (
      <div className="timeline empty">
        <div className="empty-hint">在下方输入消息即可开始新对话</div>
      </div>
    );
  }

  return (
    <div className="timeline" ref={scrollRef}>
      {plan && <PlanCard plan={plan} />}
      <ApprovalBanner />
      {hiddenCount > 0 && (
        <button className="btn load-older" onClick={() => setRenderLimit((n) => n + RENDER_CHUNK)}>
          显示更早的消息（还有 {hiddenCount} 条）
        </button>
      )}
      {windowed.map((item) => (
        <ItemView key={item.id} item={item} />
      ))}
    </div>
  );
}

function PlanCard({ plan }: { plan: { explanation: string | null; steps: Array<{ step: string; status: string }> } }) {
  if (plan.steps.length === 0) return null;
  return (
    <div className="plan-card">
      <div className="plan-title">执行计划{plan.explanation ? ` · ${plan.explanation}` : ""}</div>
      {plan.steps.map((s, i) => (
        <div key={i} className={`plan-step ${s.status}`}>
          <span className="plan-step-status">
            {s.status === "completed" ? "✓" : s.status === "in_progress" || s.status === "inProgress" ? "◐" : "○"}
          </span>
          <span>{s.step}</span>
        </div>
      ))}
    </div>
  );
}

function ApprovalBanner() {
  const approvals = useStore((s) => s.approvals);
  const activeThreadId = useStore((s) => s.activeThreadId);
  const sessions = useStore((s) => s.sessions);
  const items = useStore((s) => s.items);
  const decideApproval = useStore((s) => s.decideApproval);
  const openThread = useStore((s) => s.openThread);
  // Show approvals for the active thread first, then any OTHER thread's
  // pending approvals as a compact "background" card so multi-task users
  // don't miss them (the turn would block until timeout otherwise).
  const own = approvals.filter((a) => !a.params?.threadId || a.params.threadId === activeThreadId);
  const background = approvals.filter((a) => a.params?.threadId && a.params.threadId !== activeThreadId);
  if (own.length === 0 && background.length === 0) return null;

  return (
    <>
      {background.map((a) => {
        const tid = String(a.params?.threadId);
        const title = sessions.find((s) => s.threadId === tid)?.title ?? tid.slice(0, 8);
        const isCommand = a.method.includes("commandExecution");
        return (
          <div key={String(a.requestId)} className="approval-card approval-bg">
            <div className="approval-title">
              后台会话「{title}」等待审批：{isCommand ? "执行命令" : "修改文件"}
              <button className="btn" style={{ marginLeft: 8, padding: "2px 10px" }} onClick={() => void openThread(tid)}>
                查看
              </button>
            </div>
          </div>
        );
      })}
      {own.map((a) => {
        const isCommand = a.method.includes("commandExecution");
        const isPermissions = a.method.includes("permissions");
        // File-change approval params don't carry the change list; the pending
        // fileChange item (matched by itemId) does.
        const fileChangeItem = !isCommand && !isPermissions
          ? (items[a.params?.threadId] ?? []).find(
              (it) => it.id === a.params?.itemId && it.type === "fileChange",
            )
          : undefined;
        const changes: any[] = fileChangeItem?.changes ?? [];
        const title = isCommand ? "请求执行命令" : isPermissions ? "请求提升权限" : "请求修改文件";
        return (
          <div key={String(a.requestId)} className="approval-card">
            <div className="approval-title">
              {title} <span className="dim">（等待你的决定）</span>
            </div>
            {a.params?.reason && <div className="dim">{a.params.reason}</div>}
            {isCommand ? (
              <pre className="approval-command">{a.params.command ?? "（见上方命令卡片）"}</pre>
            ) : isPermissions ? (
              <PermissionsSummary profile={a.params.permissions} />
            ) : changes.length > 0 ? (
              <div className="approval-files">
                {changes.map((c, i) => (
                  <div key={i} className="file-line">
                    <StatusBadge kind={c.kind} />
                    <code>{c.path}</code>
                  </div>
                ))}
              </div>
            ) : (
              <div className="dim">（变更明细见时间线中的文件修改条目）</div>
            )}
            <div className="approval-actions">
              <button className="btn-primary" onClick={() => decideApproval(a.requestId, "accept")}>
                批准
              </button>
              <button className="btn" onClick={() => decideApproval(a.requestId, "acceptForSession")}>
                本次会话内一律批准
              </button>
              <button className="btn-danger" onClick={() => decideApproval(a.requestId, "decline")}>
                拒绝
              </button>
            </div>
          </div>
        );
      })}
    </>
  );
}

function StatusBadge({ kind }: { kind?: { type?: string } | string }) {
  const type = typeof kind === "string" ? kind : kind?.type;
  if (!type) return null;
  return <span className={`status-badge status-${type}`}>{type}</span>;
}

/** Human-readable summary of a RequestPermissionProfile (permissions approval). */
function PermissionsSummary({ profile }: { profile?: any }) {
  if (!profile || typeof profile !== "object") {
    return <div className="dim">（请求的权限明细缺失，见时间线上下文）</div>;
  }
  const rows: string[] = [];
  if (profile.network?.enabled != null) {
    rows.push(profile.network.enabled ? "网络访问：开启" : "网络访问：关闭");
  }
  const fs = profile.fileSystem;
  if (fs) {
    const reads = Array.isArray(fs.read) ? fs.read : [];
    const writes = Array.isArray(fs.write) ? fs.write : [];
    if (reads.length) rows.push(`额外读取（${reads.length} 项）: ${reads.slice(0, 5).join("、")}${reads.length > 5 ? " …" : ""}`);
    if (writes.length) rows.push(`额外写入（${writes.length} 项）: ${writes.slice(0, 5).join("、")}${writes.length > 5 ? " …" : ""}`);
  }
  if (rows.length === 0) rows.push("（未请求额外文件系统/网络权限）");
  return (
    <div className="approval-files">
      {rows.map((r, i) => (
        <div key={i} className="file-line"><code>{r}</code></div>
      ))}
    </div>
  );
}

/** userMessage items carry `content: UserInput[]`; local echoes carry `text`. */
function userText(item: TimelineItem): string {
  if (typeof item.text === "string") return item.text;
  return (item.content ?? [])
    .filter((c: any) => c?.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}

/** Attachments from either the local optimistic echo or the server payload
 * (UserInput localImage / mention items on resumed threads). */
function userAttachments(item: TimelineItem): Array<{ kind: "image" | "file"; name: string; path?: string; previewUrl?: string }> {
  if (Array.isArray(item.attachments)) return item.attachments;
  return (item.content ?? [])
    .filter((c: any) => c?.type === "localImage" || c?.type === "mention")
    .map((c: any) => ({
      kind: c.type === "localImage" ? ("image" as const) : ("file" as const),
      name: c.name ?? c.path,
      path: c.path,
    }));
}

/** Image with a local preview URL, or bytes lazily fetched from the gateway
 * upload store (history view after a reload). */
function AttachmentImage({ att }: { att: { name: string; path?: string; previewUrl?: string } }) {
  const readAttachment = useStore((s) => s.readAttachment);
  const [src, setSrc] = useState<string | undefined>(att.previewUrl);
  useEffect(() => {
    if (src || !att.path) return;
    let url: string | undefined;
    let alive = true;
    void readAttachment(att.path)
      .then((res: any) => {
        url = URL.createObjectURL(
          new Blob([Uint8Array.from(atob(res.base64), (ch) => ch.charCodeAt(0))], { type: res.mime }),
        );
        if (alive) setSrc(url);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [att.path, att.previewUrl, src, readAttachment]);
  return src ? (
    <img src={src} alt={att.name} className="attach-thumb" />
  ) : (
    <span className="attach-icon">🖼️</span>
  );
}

function AttachmentRow({ item }: { item: TimelineItem }) {
  const atts = userAttachments(item);
  if (atts.length === 0) return null;
  return (
    <div className="attach-chips attach-sent">
      {atts.map((a, i) => (
        <span key={i} className={`attach-chip ${a.kind === "image" ? "attach-chip-img" : ""}`} title={a.name}>
          {a.kind === "image" ? <AttachmentImage att={a} /> : <span className="attach-icon">📄</span>}
          <span className="attach-name">{a.name}</span>
        </span>
      ))}
    </div>
  );
}

// Memoized: streaming deltas only replace the patched item's identity, so
// untouched items (the vast majority in a long thread) skip re-render —
// this is what keeps long conversations responsive.
const ItemView = memo(function ItemView({ item }: { item: TimelineItem }) {
  switch (item.type) {
    case "userMessage":
      return (
        <div className="item item-user">
          <div className="bubble-user">
            <Markdown text={userText(item)} />
          </div>
          <AttachmentRow item={item} />
        </div>
      );
    case "agentMessage":
      return (
        <div className="item item-agent">
          <Markdown text={item.text ?? ""} />
        </div>
      );
    case "reasoning": {
      // #6: show the model's own SUMMARY of its thinking by default; the
      // raw chain-of-thought stays behind an explicit toggle.
      const summaryText = (item.summary ?? []).filter(Boolean).join("\n");
      const rawContent = (item.content ?? []).filter(Boolean).join("\n");
      return (
        <details className="item item-reasoning" open={!!item.streaming || !!summaryText}>
          <summary>{item.streaming ? "思考中…" : "思考摘要"}</summary>
          <div className="reasoning-body">
            {summaryText || (item.streaming ? "（生成摘要中…）" : "（无摘要）")}
          </div>
          {rawContent && (
            <details className="reasoning-raw">
              <summary>查看原始思考内容</summary>
              <div className="reasoning-body">{rawContent}</div>
            </details>
          )}
        </details>
      );
    }
    case "commandExecution":
      return (
        <div className="item item-command">
          <div className="command-head">
            <code className="command-text">{item.command}</code>
            {item.exitCode !== undefined && item.exitCode !== null && (
              <span className={`badge ${item.exitCode === 0 ? "badge-ok" : "badge-warn"}`}>exit {item.exitCode}</span>
            )}
            {item.status === "inProgress" && <span className="badge">运行中</span>}
            {item.status === "declined" && <span className="badge badge-warn">已拒绝</span>}
          </div>
          {item.aggregatedOutput && (
            <details open={item.status === "inProgress"}>
              <summary>输出</summary>
              <pre className="command-output">{item.aggregatedOutput}</pre>
            </details>
          )}
        </div>
      );
    case "fileChange":
      return <FileChangeItem item={item} />;
    case "mcpToolCall": {
      // Badge text in the summary line; details stay collapsed by default —
      // the status is visible without expanding.
      const statusLabel =
        item.status === "inProgress"
          ? "运行中"
          : item.status === "completed"
            ? "完成"
            : item.status === "failed"
              ? "失败"
              : (item.status ?? "");
      return (
        <details className="item item-mcp">
          <summary>
            MCP 工具调用：<code>{item.server}/{item.tool}</code> <span className="badge">{statusLabel}</span>
          </summary>
          {item.arguments != null && (
            <pre className="command-output">
              {typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments, null, 2)}
            </pre>
          )}
          {item.result != null && (
            <pre className="command-output">
              {typeof item.result === "string" ? item.result : JSON.stringify(item.result, null, 2)}
            </pre>
          )}
          {item.error != null && <div className="error-text">{String(item.error?.message ?? item.error)}</div>}
        </details>
      );
    }
    case "plan":
      // The live plan is always visible in the sticky PlanCard at the top of
      // the timeline — the in-flow plan item would just duplicate it.
      return null;
    case "webSearch":
      return (
        <details className="item item-search">
          <summary>
            网络搜索：{item.query}
            {item.results ? `（${item.results.length} 条结果）` : ""}
          </summary>
          <ul>
            {(item.results ?? []).map((r: any, i: number) => (
              <li key={i}>
                <a href={r?.url} target="_blank" rel="noreferrer">
                  {r?.title ?? r?.url ?? String(r)}
                </a>
              </li>
            ))}
          </ul>
        </details>
      );
    case "imageView":
      return (
        <div className="item item-mcp">
          图片：<code>{item.path}</code>
        </div>
      );
    case "contextCompaction":
      return (
        <div className="item item-compaction">
          <span className="compaction-icon">⇲</span> 上下文已压缩：历史对话被总结替代，上下文空间已释放
        </div>
      );
    case "dynamicToolCall": {
      // Protocol: contentItems: Array<{type:"inputText",text}> + success: boolean|null
      const output = Array.isArray(item.contentItems)
        ? item.contentItems.map((c: any) => c?.text ?? "").join("\n")
        : "";
      const statusLabel = item.success === true ? "完成" : item.success === false ? "失败" : item.status ?? "";
      return (
        <details className="item item-mcp">
          <summary>
            工具调用：<code>{item.tool ?? item.name ?? "unknown"}</code>{" "}
            <span className="badge">{statusLabel}</span>
          </summary>
          {output && (
            <pre className="command-output">{output.slice(0, 2000)}</pre>
          )}
        </details>
      );
    }
    case "subAgentActivity":
      return (
        <div className="item item-dim">
          子代理活动：{item.kind ?? item.activity ?? "running"}
        </div>
      );
    case "collabAgentToolCall":
      return (
        <div className="item item-dim">
          协作代理：{item.name ?? item.tool ?? "unknown"} {item.status ?? ""}
        </div>
      );
    case "imageGeneration":
      return (
        <div className="item item-dim">
          🖼 图像生成{item.size ? ` (${item.size})` : ""}{item.path ? `: ${item.path}` : ""}
        </div>
      );
    case "hookPrompt":
      return (
        <div className="item item-dim">钩子提示：{item.name ?? "hook"}</div>
      );
    case "sleep":
      return (
        <div className="item item-dim">⏸ 休眠 {item.durationMs != null ? `${Math.round(item.durationMs / 1000)}s` : ""}</div>
      );
    case "enteredReviewMode":
      return <div className="item item-dim">✓ 进入审查模式</div>;
    case "exitedReviewMode":
      return <div className="item item-dim">✓ 退出审查模式</div>;
    case "errorItem":
      return (
        <div className="item item-error">
          {item.message ?? "发生错误"}
          {item.willRetry ? "（将自动重试）" : ""}
        </div>
      );
    default:
      return null;
  }
});

function FileChangeItem({ item }: { item: TimelineItem }) {
  const changes: any[] = item.changes ?? [];
  return (
    <div className="item item-filechange">
      <div className="filechange-title">
        文件修改{item.status === "inProgress" ? "（进行中）" : item.status === "declined" ? "（已拒绝）" : ""}
      </div>
      {changes.map((c, i) => (
        <div key={i}>
          <div className="file-line">
            <StatusBadge kind={c.kind} />
            <code>{c.path}</code>
          </div>
          {c.diff && <DiffView text={c.diff} />}
        </div>
      ))}
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

/** Lightweight unified-diff renderer with add/del/hunk coloring. */
export function DiffView({ text }: { text: string }) {
  if (!text) return null;
  const lines = text.split("\n");
  return (
    <pre className="diff-view">
      {lines.map((line, i) => {
        let cls = "diff-ctx";
        if (line.startsWith("+")) cls = "diff-add";
        else if (line.startsWith("-")) cls = "diff-del";
        else if (line.startsWith("@")) cls = "diff-hunk";
        return (
          <div key={i} className={cls}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}
