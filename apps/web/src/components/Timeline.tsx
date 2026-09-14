import { memo, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { validatedHttpUrl } from "../utils/validation";
import { useStore, type Display, type TimelineItem } from "../store";
import type { RequestPermissionProfile } from "../../../../protocol/v2/RequestPermissionProfile";
import { describePermissions } from "../utils/permissions";
import { InputRequests } from "./InputRequests";

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

function imageSource(value: string): string | null {
  if (/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(value)) return value;
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(value)) {
    const mime = value.startsWith("iVBORw0KGgo") ? "png" : value.startsWith("/9j/") ? "jpeg" : value.startsWith("R0lGOD") ? "gif" : value.startsWith("UklGR") ? "webp" : null;
    if (mime) return `data:image/${mime};base64,${value}`;
  }
  return validatedHttpUrl(value);
}

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
  const lastIsLocalUser = last?.type === "localUserMessage";
  // Cheap "the tail changed" signal without depending on full item identity.
  const tailText = last && "text" in last ? last.text : last?.type === "commandExecution" ? last.aggregatedOutput ?? "" : last?.type === "reasoning" ? [...last.summary, ...last.content].join("") : "";
  const lastSignature = `${visible.length}:${last?.id ?? ""}:${tailText.length}`;

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
      <>
        <RequestDock />
        <div className="timeline empty">
          <div className="empty-hint">在下方输入消息即可开始新对话</div>
        </div>
      </>
    );
  }

  return (
    <>
      <RequestDock />
      <div className="timeline" ref={scrollRef}>
        {plan && <PlanCard plan={plan} />}
        {hiddenCount > 0 && (
          <button className="btn load-older" onClick={() => setRenderLimit((n) => n + RENDER_CHUNK)}>
            显示更早的消息（还有 {hiddenCount} 条）
          </button>
        )}
        {windowed.map((item) => (
          <ItemView key={item.id} item={item} />
        ))}
      </div>
    </>
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

function RequestDock() {
  const hasApprovals = useStore((state) => state.approvals.length > 0);
  const hasInputs = useStore((state) => (state.inputRequests?.length ?? 0) > 0);
  if (!hasApprovals && !hasInputs) return null;
  return <div className="request-docks"><ApprovalBanner /><InputRequests /></div>;
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
    <section className="approval-dock" aria-label="待处理审批">
      <div className="approval-dock-count" role="status">
        等待审批：{approvals.length} 项{background.length > 0 ? `（后台会话 ${background.length} 项）` : ""}
      </div>
      {own.map((a) => {
        const isCommand = a.method === "item/commandExecution/requestApproval";
        const isPermissions = a.method === "item/permissions/requestApproval";
        const canApprove = !isPermissions || describePermissions(a.params.permissions).valid;
        // File-change approval params don't carry the change list; the pending
        // fileChange item (matched by itemId) does.
        const fileChangeItem = !isCommand && !isPermissions
          ? (items[a.params?.threadId] ?? []).find(
              (it) => it.id === a.params?.itemId && it.type === "fileChange",
            )
          : undefined;
        const changes = fileChangeItem?.type === "fileChange" ? fileChangeItem.changes : [];
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
              <button className="btn-primary" disabled={!canApprove} onClick={() => decideApproval(a.requestId, "accept")}>
                批准
              </button>
              <button className="btn" disabled={!canApprove} onClick={() => decideApproval(a.requestId, "acceptForSession")}>
                本次会话内一律批准
              </button>
              <button className="btn-danger" onClick={() => decideApproval(a.requestId, "decline")}>
                拒绝
              </button>
            </div>
          </div>
        );
      })}
      {background.map((a) => {
        const tid = String(a.params?.threadId);
        const title = sessions.find((s) => s.threadId === tid)?.title ?? tid.slice(0, 8);
        const action = a.method === "item/commandExecution/requestApproval" ? "执行命令"
          : a.method === "item/permissions/requestApproval" ? "提升权限" : "修改文件";
        return (
          <div key={String(a.requestId)} className="approval-card approval-bg">
            <div className="approval-title">
              后台会话「{title}」等待审批：{action}
              <button className="btn" style={{ marginLeft: 8, padding: "2px 10px" }} onClick={() => void openThread(tid)}>
                查看
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

function StatusBadge({ kind }: { kind?: { type?: string } | string }) {
  const type = typeof kind === "string" ? kind : kind?.type;
  if (!type) return null;
  return <span className={`status-badge status-${type}`}>{type}</span>;
}

/** Human-readable summary of a RequestPermissionProfile (permissions approval). */
export function PermissionsSummary({ profile }: { profile: RequestPermissionProfile }) {
  const { rows, valid } = describePermissions(profile);
  return (
    <div className="approval-files">
      {rows.map((r, i) => (
        <div key={i} className="file-line"><code>{r}</code></div>
      ))}
      {!valid && <pre className="command-output">{JSON.stringify(profile, null, 2)}</pre>}
    </div>
  );
}

/** userMessage items carry `content: UserInput[]`; local echoes carry `text`. */
type UserMessage = Extract<TimelineItem, { type: "userMessage" | "localUserMessage" }>;
function userText(item: UserMessage): string {
  if (item.type === "localUserMessage") return item.text;
  return item.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** Attachments from either the local optimistic echo or the server payload
 * (UserInput localImage / mention items on resumed threads). */
function userAttachments(item: UserMessage): Array<{ kind: "image" | "file"; name: string; path?: string; previewUrl?: string }> {
  if (item.type === "localUserMessage") return item.attachments;
  if (Array.isArray(item.harnessAttachments)) return item.harnessAttachments;
  return item.content
    .filter((c) => c.type === "localImage" || c.type === "mention")
    .map((c) => ({
      kind: c.type === "localImage" ? ("image" as const) : ("file" as const),
      name: c.type === "mention" ? c.name : c.path,
      path: c.path,
    }));
}

/** Image with a local preview URL, or bytes lazily fetched from the gateway
 * upload store (history view after a reload). */
function AttachmentImage({ att }: { att: { name: string; path?: string; previewUrl?: string } }) {
  const readAttachment = useStore((s) => s.readAttachment);
  const [src, setSrc] = useState<string | undefined>(att.previewUrl);
  useEffect(() => {
    if (att.previewUrl) {
      setSrc(att.previewUrl);
      return;
    }
    setSrc(undefined);
    if (!att.path) return;
    let url: string | undefined;
    let alive = true;
    void readAttachment(att.path)
      .then((res) => {
        url = URL.createObjectURL(
          new Blob([Uint8Array.from(atob(res.base64), (ch) => ch.charCodeAt(0))], { type: res.mime }),
        );
        if (alive) setSrc(url);
        else URL.revokeObjectURL(url);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [att.path, att.previewUrl, readAttachment]);
  return src ? (
    <img src={src} alt={att.name} className="attach-thumb" />
  ) : (
    <span className="attach-icon">🖼️</span>
  );
}

function AttachmentRow({ item }: { item: UserMessage }) {
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
export const ItemView = memo(function ItemView({ item }: { item: TimelineItem }) {
  switch (item.type) {
    case "userMessage":
    case "localUserMessage":
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
      return <div className="item item-agent"><Markdown text={item.text} /></div>;
    case "webSearch":
      return (
        <details className="item item-search">
          <summary>
            网络搜索：{item.query}
            {item.results ? `（${item.results.length} 条结果）` : ""}
          </summary>
          <ul>
            {(item.results ?? []).map((r, i) => {
              const record = r && typeof r === "object" && !Array.isArray(r) ? r : {};
              const href = validatedHttpUrl(record.url);
              const label = typeof record.title === "string" ? record.title : typeof record.url === "string" ? record.url : JSON.stringify(r);
              return <li key={i}>{href
                ? <a href={href} target="_blank" rel="noopener noreferrer">{label}</a>
                : <span>{label}</span>}
              </li>;
            })}
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
          <span className="compaction-icon">⇲</span> 上下文压缩记录
        </div>
      );
    case "compactionProgress":
      return <div className={`item ${item.status === "failed" ? "item-error" : "item-compaction"}`}>{item.message}</div>;
    case "dynamicToolCall": {
      // Protocol: contentItems: Array<{type:"inputText",text}> + success: boolean|null
      const output = Array.isArray(item.contentItems)
        ? item.contentItems.filter((c) => c.type === "inputText").map((c) => c.text).join("\n")
        : "";
      const statusLabel = item.success === true ? "完成" : item.success === false ? "失败" : item.status ?? "";
      return (
        <details className="item item-mcp">
          <summary>
            工具调用：<code>{item.tool}</code>{" "}
            <span className="badge">{statusLabel}</span>
          </summary>
          {output && (
            <pre className="command-output">{output.slice(0, 2000)}</pre>
          )}
          {item.contentItems?.map((content, index) => {
            if (content.type === "inputImage") {
              const src = imageSource(content.imageUrl);
              return src ? <img key={index} className="generated-image" src={src} alt="工具返回的图片" /> : <div key={index}>图片地址无法显示</div>;
            }
            if (content.type === "inputAudio") {
              const src = /^data:audio\/(wav|mpeg|mp3|ogg|webm);base64,[A-Za-z0-9+/=\r\n]+$/.test(content.audioUrl) ? content.audioUrl : validatedHttpUrl(content.audioUrl);
              return src ? <audio key={index} controls src={src} /> : <div key={index}>音频地址无法播放</div>;
            }
            return null;
          })}
        </details>
      );
    }
    case "subAgentActivity":
      return (
        <div className="item item-dim">
          子代理活动：{item.kind}
        </div>
      );
    case "collabAgentToolCall":
      return (
        <div className="item item-dim">
          协作代理：{item.tool} {item.status}
        </div>
      );
    case "imageGeneration": {
      const src = imageSource(item.result);
      return (
        <div className="item item-dim">
          🖼 图像生成 · {item.status}
          {item.savedPath && <div>输出文件：<code>{item.savedPath}</code></div>}
          {item.failure && <div className="error-text">图像生成失败：{JSON.stringify(item.failure)}</div>}
          {src ? <img src={src} alt="生成的图片" className="generated-image" /> : item.result && <details><summary>查看生成结果</summary><pre className="command-output">{item.result}</pre></details>}
        </div>
      );
    }
    case "hookPrompt":
      return (
          <div className="item item-dim">钩子提示：{item.fragments.map((fragment) => fragment.text).join("\n")}</div>
      );
    case "sleep":
      return (
        <div className="item item-dim">⏸ 休眠 {Math.round(item.durationMs / 1000)}s</div>
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
    default: {
      // Compile-time exhaustiveness with a readable runtime fallback for a
      // newer server variant, rather than losing the entire React tree.
      const unsupported: never = item;
      return <details className="item"><summary>未支持的消息内容</summary><pre>{JSON.stringify(unsupported, null, 2)}</pre></details>;
    }
  }
});

function FileChangeItem({ item }: { item: Extract<TimelineItem, { type: "fileChange" }> }) {
  const changes = item.changes;
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
