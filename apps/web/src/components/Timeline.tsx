import { Component, memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { validatedHttpUrl } from "../utils/validation";
import { useStore, type Display, type TimelineItem } from "../store";
import type { RequestPermissionProfile } from "../../../../protocol/v2/RequestPermissionProfile";
import { approvalCanAccept, describePermissions, fileChangeApprovalContext, normalizeNetworkApprovalContext } from "../utils/permissions";
import { InputRequests } from "./InputRequests";
import { boundedRuntimeJson } from "../utils/bounded-runtime";
import { historicalImageUrls, type HistoricalImageLease } from "../utils/historical-image-urls";
import { markdownWithinBudget, remarkBoundedTree } from "../utils/markdown-budget";

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
const MAX_SEARCH_RESULTS = 100;
const MAX_FILE_CHANGES = 50;
const MAX_TOOL_CONTENT_ITEMS = 100;
const MAX_USER_CONTENT_ITEMS = 1_000;
const MAX_REASONING_PARTS = 1_024;
const MAX_RENDERED_ATTACHMENTS = 50;

function imageSource(value: string): string | null {
  if (/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(value)) return value;
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(value)) {
    const mime = value.startsWith("iVBORw0KGgo") ? "png" : value.startsWith("/9j/") ? "jpeg" : value.startsWith("R0lGOD") ? "gif" : value.startsWith("UklGR") ? "webp" : null;
    if (mime) return `data:image/${mime};base64,${value}`;
  }
  return null;
}

function runtimeText(value: unknown, fallback = "", max = 200_000): string {
  return typeof value === "string" ? value.slice(0, max) : fallback;
}

function runtimeTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result = value.slice(0, MAX_REASONING_PARTS).filter((entry): entry is string => typeof entry === "string");
  if (value.length > MAX_REASONING_PARTS) result.push(`[另有 ${value.length - MAX_REASONING_PARTS} 个片段未显示（已达到浏览器预算）]`);
  return result;
}

function boundedTextJoin(values: readonly unknown[], separator: string, maxChars = 200_000): string {
  const parts: string[] = [];
  let used = 0;
  for (const value of values) {
    if (typeof value !== "string" || !value) continue;
    const glue = parts.length ? separator : "";
    const remaining = maxChars - used - glue.length;
    if (remaining <= 0) break;
    parts.push(`${glue}${value.slice(0, remaining)}`);
    used += glue.length + Math.min(value.length, remaining);
    if (value.length > remaining) break;
  }
  return parts.join("");
}

function printable(value: unknown): string {
  return boundedRuntimeJson(value, 1024 * 1024, 4_096, 16);
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
  const tailText = last && "text" in last ? runtimeText(last.text)
    : last?.type === "commandExecution" ? runtimeText(last.aggregatedOutput)
      : last?.type === "reasoning" ? boundedTextJoin([...runtimeTextList(last.summary), ...runtimeTextList(last.content)], "") : "";
  const lastSignature = `${visible.length}:${runtimeText(last?.id)}:${tailText.length}`;

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
  const steps = Array.isArray(plan?.steps) ? plan.steps.slice(0, 1_000).filter((step) => step && typeof step === "object") : [];
  if (steps.length === 0) return null;
  const explanation = runtimeText(plan.explanation);
  return (
    <div className="plan-card">
      <div className="plan-title">执行计划{explanation ? ` · ${explanation}` : ""}</div>
      {steps.map((s, i) => {
        const status = runtimeText(s.status);
        return <div key={i} className={`plan-step ${status}`}>
          <span className="plan-step-status">
            {status === "completed" ? "✓" : status === "in_progress" || status === "inProgress" ? "◐" : "○"}
          </span>
          <span>{runtimeText(s.step, "（计划步骤格式无效）")}</span>
        </div>;
      })}
    </div>
  );
}

function RequestDock() {
  const hasApprovals = useStore((state) => state.approvals.length > 0);
  const hasInputs = useStore((state) => (state.inputRequests?.length ?? 0) > 0);
  if (!hasApprovals && !hasInputs) return null;
  return <div className="request-docks"><ApprovalBanner /><InputRequests /></div>;
}

function approvalThreadId(approval: { params?: unknown }): string | null {
  const params = approval.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const value = (params as Record<string, unknown>).threadId;
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}

function ApprovalBanner() {
  const approvals = useStore((s) => s.approvals);
  const activeThreadId = useStore((s) => s.activeThreadId);
  const sessions = useStore((s) => s.sessions);
  const items = useStore((s) => s.items);
  const approvalSubmissions = useStore((s) => s.approvalSubmissions);
  const approvalErrors = useStore((s) => s.approvalErrors);
  const connected = useStore((s) => s.connection === "open");
  const decideApproval = useStore((s) => s.decideApproval);
  const openThread = useStore((s) => s.openThread);
  // Show approvals for the active thread first, then any OTHER thread's
  // pending approvals as a compact "background" card so multi-task users
  // don't miss them (the turn would block until timeout otherwise).
  const own = approvals.filter((a) => !approvalThreadId(a) || approvalThreadId(a) === activeThreadId);
  const background = approvals.filter((a) => !!approvalThreadId(a) && approvalThreadId(a) !== activeThreadId);
  if (own.length === 0 && background.length === 0) return null;

  return (
    <section className="approval-dock" aria-label="待处理审批">
      <div className="approval-dock-count" role="status">
        等待审批：{approvals.length} 项{background.length > 0 ? `（后台会话 ${background.length} 项）` : ""}
      </div>
      {own.map((a) => {
        const isCommand = a.method === "item/commandExecution/requestApproval";
        const isPermissions = a.method === "item/permissions/requestApproval";
        const rawParams: unknown = a.params;
        const paramsValid = !!rawParams && typeof rawParams === "object" && !Array.isArray(rawParams);
        const params = paramsValid ? rawParams as Record<string, unknown> : {};
        let contextValid = paramsValid;
        const optionalContextText = (value: unknown, max: number): string | null => {
          if (value == null) return null;
          if (typeof value !== "string" || value.length > max) {
            contextValid = false;
            return null;
          }
          return value;
        };
        const commandParams = isCommand && paramsValid ? a.params : null;
        const fileParams = a.method === "item/fileChange/requestApproval" && paramsValid ? a.params : null;
        const command = typeof commandParams?.command === "string" && commandParams.command.length <= 200_000 && commandParams.command.trim()
          ? commandParams.command : null;
        const cwd = optionalContextText(params.cwd, 4_096);
        const rawNetwork = commandParams?.networkApprovalContext as unknown;
        const network = normalizeNetworkApprovalContext(rawNetwork);
        if (rawNetwork != null && !network) contextValid = false;
        const networkOnly = isCommand && commandParams?.command == null && network !== null;
        const rawNetworkRules: unknown = commandParams?.proposedNetworkPolicyAmendments;
        const networkRulesValid = rawNetworkRules == null || Array.isArray(rawNetworkRules) && rawNetworkRules.length <= 500 && rawNetworkRules.every(
          (rule) => !!rule && typeof rule === "object" &&
            ((rule as { action?: unknown }).action === "allow" || (rule as { action?: unknown }).action === "deny") &&
            typeof (rule as { host?: unknown }).host === "string" && (rule as { host: string }).host.length > 0 &&
            (rule as { host: string }).host.length <= 2_048,
        );
        if (!networkRulesValid) contextValid = false;
        const networkRules = Array.isArray(rawNetworkRules) && networkRulesValid
          ? rawNetworkRules as Array<{ action: "allow" | "deny"; host: string }> : [];
        const rawExecRule: unknown = commandParams?.proposedExecpolicyAmendment;
        const execRuleValid = rawExecRule == null || Array.isArray(rawExecRule) && rawExecRule.length <= 500 &&
          rawExecRule.every((part) => typeof part === "string" && part.length <= 4_096);
        if (!execRuleValid) contextValid = false;
        const execRule = Array.isArray(rawExecRule) && execRuleValid ? rawExecRule as string[] : [];
        const grantRoot = fileParams ? optionalContextText(fileParams.grantRoot, 4_096) : null;
        const reason = optionalContextText(params.reason, 20_000);
        const permissionProfile = isPermissions && paramsValid ? a.params.permissions : null as unknown as RequestPermissionProfile;
        // File-change params carry no changes. Authorization is allowed only
        // after the exact thread/item record is present and its COMPLETE list
        // can be validated and displayed within the approval budget.
        const normalizedChanges = !isCommand && !isPermissions
          ? fileChangeApprovalContext(a, items)
          : { changes: [], total: 0, present: true, valid: true };
        if (!normalizedChanges.valid) contextValid = false;
        const { changes } = normalizedChanges;
        const requestKey = String(a.requestId);
        const submitting = approvalSubmissions[requestKey] === true;
        const approvalError = approvalErrors[requestKey];
        contextValid = contextValid && approvalCanAccept(a, items);
        const canApprove = connected && !submitting && contextValid;
        const title = isCommand ? networkOnly ? "请求访问网络" : "请求执行命令" : isPermissions ? "请求提升权限" : "请求修改文件";
        return (
          <div key={String(a.requestId)} className="approval-card">
            <div className="approval-title">
              {title} <span className="dim">（等待你的决定）</span>
            </div>
            {reason && <div className="dim">{reason}</div>}
            {!contextValid && <div className="error-text">{!isCommand && !isPermissions && !normalizedChanges.present
              ? "尚未收到与此请求精确匹配的文件变更明细，已禁用批准。"
              : "审批上下文格式无效、不完整或过大，已禁用批准。"}</div>}
            {approvalError && <div className="error-text" role="alert">{approvalError}</div>}
            {submitting && <div className="dim" role="status">正在提交审批决定，等待服务器确认…</div>}
            {(cwd || network || grantRoot || networkRules.length > 0 || execRule.length > 0) && (
              <div className="approval-context">
                {cwd && <div><span>工作目录</span><code>{cwd}</code></div>}
                {network && <div><span>网络目标</span><code>{network.protocol}://{network.host}</code></div>}
                {grantRoot && <div><span>会话写入授权根目录</span><code>{grantRoot}</code></div>}
                {networkRules.map((rule, index) => (
                  <div key={`network-${index}`}><span>后续网络规则</span><code>{rule.action} {rule.host}</code></div>
                ))}
                {execRule.length > 0 && <div><span>后续命令规则</span><code>{JSON.stringify(execRule)}</code></div>}
              </div>
            )}
            {isCommand ? (
              !networkOnly && <pre className="approval-command">{command ?? "（命令结构无效或过长，已禁用批准）"}</pre>
            ) : isPermissions ? (
              <PermissionsSummary profile={permissionProfile} />
            ) : changes.length > 0 ? (
              <div className="approval-files">
                {changes.map((c, i) => (
                  <div key={i} className="file-line">
                    <StatusBadge kind={c.kind} />
                    <FileChangePaths path={c.path} kind={c.kind} />
                  </div>
                ))}
                {normalizedChanges.total > changes.length && <div className="output-truncation">仅显示前 {changes.length} / {normalizedChanges.total} 项（已达到浏览器预算）</div>}
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
              <button className="btn-danger" disabled={!connected || submitting} onClick={() => decideApproval(a.requestId, "decline")}>
                拒绝
              </button>
            </div>
          </div>
        );
      })}
      {background.map((a) => {
        const tid = approvalThreadId(a)!;
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
  const candidate = typeof kind === "string" ? kind : kind?.type;
  const type = typeof candidate === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(candidate) ? candidate : "";
  if (!type) return null;
  return <span className={`status-badge status-${type}`}>{type}</span>;
}

function FileChangePaths({ path, kind }: { path: unknown; kind: unknown }) {
  const record = kind && typeof kind === "object" && !Array.isArray(kind) ? kind as Record<string, unknown> : null;
  const destination = record?.type === "update" ? record.move_path : null;
  const pathText = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 4_096
    ? value : "（路径格式无效或过长）";
  return <code className="file-change-paths">
    <bdi>{pathText(path)}</bdi>
    {destination != null && <> → <bdi>{pathText(destination)}</bdi></>}
  </code>;
}

/** Human-readable summary of a RequestPermissionProfile (permissions approval). */
export function PermissionsSummary({ profile }: { profile: RequestPermissionProfile }) {
  const { rows, valid } = describePermissions(profile);
  return (
    <div className="approval-files">
      {rows.map((r, i) => (
        <div key={i} className="file-line"><code>{r}</code></div>
      ))}
      {!valid && <ProgressiveOutput text={printable(profile)} />}
    </div>
  );
}

/** userMessage items carry `content: UserInput[]`; local echoes carry `text`. */
type UserMessage = Extract<TimelineItem, { type: "userMessage" | "localUserMessage" }>;
function userText(item: UserMessage): string {
  if (item.type === "localUserMessage") return item.text;
  const content: unknown[] = Array.isArray(item.content) ? item.content : [];
  const parts: string[] = [];
  const inspected = Math.min(content.length, MAX_USER_CONTENT_ITEMS);
  for (let index = 0; index < inspected; index++) {
    const value = content[index];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as { type?: unknown; text?: unknown };
    if (entry.type === "text" && typeof entry.text === "string") parts.push(entry.text);
  }
  const text = parts.join("\n");
  return content.length > MAX_USER_CONTENT_ITEMS
    ? `${text}${text ? "\n" : ""}[另有 ${content.length - MAX_USER_CONTENT_ITEMS} 个消息片段未显示（已达到浏览器预算）]`
    : text;
}

/** Attachments from either the local optimistic echo or the server payload
 * (UserInput localImage / mention items on resumed threads). */
interface UserAttachmentSummary {
  attachments: Array<{ kind: "image" | "file"; name: string; path?: string; previewUrl?: string }>;
  total: number;
  unchecked: number;
}

function userAttachments(item: UserMessage): UserAttachmentSummary {
  const normalize = (raw: unknown[]): ReturnType<typeof userAttachments> => {
    const attachments: Array<{ kind: "image" | "file"; name: string; path: string; previewUrl?: string }> = [];
    const inspected = Math.min(raw.length, MAX_USER_CONTENT_ITEMS);
    for (let index = 0; index < inspected; index++) {
      const value = raw[index];
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      if ((entry.kind !== "image" && entry.kind !== "file") || typeof entry.name !== "string" || !entry.name ||
          typeof entry.path !== "string" || !entry.path) continue;
      if (attachments.length >= MAX_RENDERED_ATTACHMENTS) continue;
      // Object URLs are minted by this tab. A remote URL echoed in history
      // must never become an automatically loaded image source.
      const previewUrl = typeof entry.previewUrl === "string" && entry.previewUrl.startsWith("blob:") && entry.previewUrl.length <= 4_096
        ? entry.previewUrl : undefined;
      attachments.push({ kind: entry.kind, name: entry.name.slice(0, 255), path: entry.path.slice(0, 4_096), ...(previewUrl ? { previewUrl } : {}) });
    }
    return { attachments, total: inspected, unchecked: Math.max(0, raw.length - inspected) };
  };
  if (item.type === "localUserMessage") {
    const raw = Array.isArray(item.attachments) ? item.attachments : [];
    return normalize(raw);
  }
  if (Array.isArray(item.harnessAttachments)) {
    return normalize(item.harnessAttachments);
  }
  const content: unknown[] = Array.isArray(item.content) ? item.content : [];
  const attachments: UserAttachmentSummary["attachments"] = [];
  let total = 0;
  const inspected = Math.min(content.length, MAX_USER_CONTENT_ITEMS);
  for (let index = 0; index < inspected; index++) {
    const value = content[index];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as { type?: unknown; name?: unknown; path?: unknown };
    if ((entry.type !== "localImage" && entry.type !== "mention") || typeof entry.path !== "string" || !entry.path) continue;
    total += 1;
    if (attachments.length >= MAX_RENDERED_ATTACHMENTS) continue;
    const path = entry.path.slice(0, 4_096);
    attachments.push({
      kind: entry.type === "localImage" ? ("image" as const) : ("file" as const),
      name: (entry.type === "mention" && typeof entry.name === "string" && entry.name ? entry.name : path).slice(0, 255),
      path,
    });
  }
  return { attachments, total, unchecked: Math.max(0, content.length - inspected) };
}

/** Image with a local preview URL, or bytes lazily fetched from the gateway
 * upload store (history view after a reload). */
function AttachmentImage({ att }: { att: { name: string; path?: string; previewUrl?: string } }) {
  const readAttachment = useStore((s) => s.readAttachment);
  const [src, setSrc] = useState<string | undefined>(att.previewUrl);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setError(null);
    if (att.previewUrl) {
      setSrc(att.previewUrl);
      return;
    }
    setSrc(undefined);
    if (!att.path) return;
    const controller = new AbortController();
    let lease: HistoricalImageLease | undefined;
    let alive = true;
    void readAttachment(att.path, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        lease = historicalImageUrls.acquire(res.base64, res.mime);
        if (alive) setSrc(lease.url);
        else lease.release();
      })
      .catch((reason) => {
        if (alive && !(reason instanceof Error && reason.name === "AbortError")) {
          setError(reason instanceof Error ? reason.message.slice(0, 500) : String(reason).slice(0, 500));
        }
      });
    return () => {
      alive = false;
      controller.abort();
      lease?.release();
    };
  }, [att.path, att.previewUrl, readAttachment, retry]);
  return src ? (
    <img src={src} alt={att.name} className="attach-thumb" />
  ) : error ? (
    <button type="button" className="attach-image-retry" title={`图片读取失败：${error}`} onClick={() => setRetry((value) => value + 1)}>
      🖼️ 重试
    </button>
  ) : (
    <span className="attach-icon">🖼️</span>
  );
}

function AttachmentRow({ item }: { item: UserMessage }) {
  const { attachments, total, unchecked } = userAttachments(item);
  if (attachments.length === 0) return total > 0 || unchecked > 0
    ? <div className="attach-chips attach-sent"><span className="attach-chip">附件格式无效或未显示（已达到浏览器检查或显示预算）</span></div>
    : null;
  return (
    <div className="attach-chips attach-sent">
      {attachments.map((a, i) => (
        <span key={i} className={`attach-chip ${a.kind === "image" ? "attach-chip-img" : ""}`} title={a.name}>
          {a.kind === "image" ? <AttachmentImage att={a} /> : <span className="attach-icon">📄</span>}
          <span className="attach-name">{a.name}</span>
        </span>
      ))}
      {total > attachments.length && <span className="attach-chip">另有 {total - attachments.length} 个附件格式无效或未显示（已达到浏览器预算）</span>}
      {unchecked > 0 && <span className="attach-chip">另有 {unchecked} 个消息片段未检查（已达到浏览器预算）</span>}
    </div>
  );
}

const OUTPUT_PREVIEW_CHARS = 2_000;
const OUTPUT_REVEAL_CHARS = 20_000;

function ProgressiveOutput({ text }: { text: string }) {
  const [limit, setLimit] = useState(OUTPUT_PREVIEW_CHARS);
  const shown = Math.min(limit, text.length);
  return (
    <>
      <pre className="command-output">{text.slice(0, shown)}</pre>
      {shown < text.length && (
        <div className="output-truncation" role="status">
          <span>输出较长，已显示 {shown.toLocaleString("zh-CN")} / {text.length.toLocaleString("zh-CN")} 字符。</span>
          <button className="btn" onClick={() => setLimit((current) => Math.min(text.length, current + OUTPUT_REVEAL_CHARS))}>
            继续显示完整输出
          </button>
        </div>
      )}
    </>
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
          <Markdown text={item.text} fallback="（消息格式无效）" />
        </div>
      );
    case "reasoning": {
      // #6: show the model's own SUMMARY of its thinking by default; the
      // raw chain-of-thought stays behind an explicit toggle.
      const summaryText = boundedTextJoin(runtimeTextList(item.summary), "\n");
      const rawContent = boundedTextJoin(runtimeTextList(item.content), "\n");
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
    case "commandExecution": {
      const exitCode = typeof item.exitCode === "number" && Number.isFinite(item.exitCode) ? item.exitCode : null;
      return (
        <div className="item item-command">
          <div className="command-head">
            <code className="command-text">{runtimeText(item.command, "（命令格式无效）")}</code>
            {exitCode !== null && (
              <span className={`badge ${exitCode === 0 ? "badge-ok" : "badge-warn"}`}>exit {exitCode}</span>
            )}
            {item.status === "inProgress" && <span className="badge">运行中</span>}
            {item.status === "declined" && <span className="badge badge-warn">已拒绝</span>}
          </div>
          {typeof item.aggregatedOutput === "string" && item.aggregatedOutput && (
            <details open={item.status === "inProgress"}>
              <summary>输出</summary>
              <ProgressiveOutput text={item.aggregatedOutput} />
            </details>
          )}
        </div>
      );
    }
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
            MCP 工具调用：<code>{runtimeText(item.server, "?")}/{runtimeText(item.tool, "?")}</code> <span className="badge">{runtimeText(statusLabel)}</span>
          </summary>
          {item.arguments != null && <ProgressiveOutput text={printable(item.arguments)} />}
          {item.result != null && <ProgressiveOutput text={printable(item.result)} />}
          {item.error != null && <div className="error-text">{runtimeText((item.error as { message?: unknown })?.message) || printable(item.error)}</div>}
        </details>
      );
    }
    case "plan":
      return <div className="item item-agent"><Markdown text={item.text} fallback="（计划格式无效）" /></div>;
    case "webSearch":
      {
      const rawResults: unknown[] = Array.isArray(item.results) ? item.results : [];
      const results = rawResults.slice(0, MAX_SEARCH_RESULTS);
      return (
        <details className="item item-search">
          <summary>
            网络搜索：{runtimeText(item.query, "（查询格式无效）")}
            {Array.isArray(item.results) ? `（${rawResults.length} 条结果）` : ""}
          </summary>
          <ul>
            {results.map((r, i) => {
              const record: Record<string, unknown> = r && typeof r === "object" && !Array.isArray(r) ? r as Record<string, unknown> : {};
              const href = validatedHttpUrl(record.url);
              const label = typeof record.title === "string" ? record.title : typeof record.url === "string" ? record.url : printable(r);
              return <li key={i}>{href
                ? <a href={href} target="_blank" rel="noopener noreferrer">{label}</a>
                : <span>{label}</span>}
              </li>;
            })}
            {rawResults.length > results.length && <li>仅显示前 {results.length} / {rawResults.length} 条（已达到浏览器预算）</li>}
          </ul>
        </details>
      );
      }
    case "imageView":
      return (
        <div className="item item-mcp">
          图片：<code>{runtimeText(item.path, "（路径格式无效）")}</code>
        </div>
      );
    case "contextCompaction":
      return (
        <div className="item item-compaction">
          <span className="compaction-icon">⇲</span> 上下文压缩记录
        </div>
      );
    case "compactionProgress":
      return <div className={`item ${item.status === "failed" ? "item-error" : "item-compaction"}`}>{runtimeText(item.message, "（压缩状态格式无效）")}</div>;
    case "turnStatus":
      return <div className={`item ${item.status === "failed" ? "item-error" : "item-dim"}`}>
        {item.status === "failed" ? "回合失败：" : ""}{runtimeText(item.message, "（回合状态格式无效）")}
      </div>;
    case "dynamicToolCall": {
      // Protocol: contentItems: Array<{type:"inputText",text}> + success: boolean|null
      const rawContentItems: unknown[] = Array.isArray(item.contentItems) ? item.contentItems : [];
      const contentItems = rawContentItems.slice(0, MAX_TOOL_CONTENT_ITEMS);
      const outputParts: string[] = [];
      let outputChars = 0;
      for (const content of contentItems) {
        if (!content || typeof content !== "object" ||
            (content as { type?: unknown }).type !== "inputText" || typeof (content as { text?: unknown }).text !== "string") continue;
        const text = (content as { text: string }).text;
        const separator = outputParts.length ? "\n" : "";
        const remaining = 1024 * 1024 - outputChars - separator.length;
        if (remaining <= 0) break;
        outputParts.push(`${separator}${text.slice(0, remaining)}`);
        outputChars += separator.length + Math.min(text.length, remaining);
        if (text.length > remaining) break;
      }
      const output = outputParts.join("");
      const statusLabel = item.success === true ? "完成" : item.success === false ? "失败" : item.status ?? "";
      return (
        <details className="item item-mcp">
          <summary>
            工具调用：<code>{runtimeText(item.tool, "?")}</code>{" "}
            <span className="badge">{runtimeText(statusLabel)}</span>
          </summary>
          {output && <ProgressiveOutput text={output} />}
          {contentItems.map((content, index) => {
            if (!content || typeof content !== "object") return null;
            const record = content as { type?: unknown; imageUrl?: unknown; audioUrl?: unknown };
            if (record.type === "inputImage") {
              const imageUrl = typeof record.imageUrl === "string" ? record.imageUrl : "";
              const src = imageSource(imageUrl);
              const href = !src ? validatedHttpUrl(imageUrl) : null;
              return src
                ? <img key={index} className="generated-image" src={src} alt="工具返回的图片" />
                : href
                  ? <a key={index} href={href} target="_blank" rel="noopener noreferrer">打开工具返回的外部图片</a>
                  : <div key={index}>图片地址无法显示</div>;
            }
            if (record.type === "inputAudio") {
              const audioUrl = typeof record.audioUrl === "string" ? record.audioUrl : "";
              const src = /^data:audio\/(wav|mpeg|mp3|ogg|webm);base64,[A-Za-z0-9+/=\r\n]+$/.test(audioUrl) ? audioUrl : null;
              const href = !src ? validatedHttpUrl(audioUrl) : null;
              return src
                ? <audio key={index} controls preload="none" src={src} />
                : href
                  ? <a key={index} href={href} target="_blank" rel="noopener noreferrer">打开工具返回的外部音频</a>
                  : <div key={index}>音频地址无法播放</div>;
            }
            return null;
          })}
          {rawContentItems.length > contentItems.length && <div className="output-truncation">仅显示前 {contentItems.length} / {rawContentItems.length} 项（已达到浏览器预算）</div>}
        </details>
      );
    }
    case "subAgentActivity":
      return (
        <div className="item item-dim">
          子代理活动：{runtimeText(item.kind, "（状态格式无效）")}
        </div>
      );
    case "collabAgentToolCall":
      return (
        <div className="item item-dim">
          协作代理：{runtimeText(item.tool, "?")} {runtimeText(item.status)}
        </div>
      );
    case "imageGeneration": {
      const result = typeof item.result === "string" ? item.result : "";
      const src = imageSource(result);
      const href = !src ? validatedHttpUrl(result) : null;
      return (
        <div className="item item-dim">
          🖼 图像生成 · {runtimeText(item.status, "（状态格式无效）")}
          {typeof item.savedPath === "string" && item.savedPath && <div>输出文件：<code>{item.savedPath}</code></div>}
          {item.failure && <div className="error-text">图像生成失败：{printable(item.failure)}</div>}
          {src
            ? <img src={src} alt="生成的图片" className="generated-image" />
            : href
              ? <a href={href} target="_blank" rel="noopener noreferrer">打开外部生成图片</a>
              : result && <details><summary>查看生成结果</summary><ProgressiveOutput text={result} /></details>}
        </div>
      );
    }
    case "hookPrompt":
      return (
          <div className="item item-dim">钩子提示：{(() => {
            const fragments = Array.isArray(item.fragments) ? item.fragments : [];
            const parts: unknown[] = [];
            for (let index = 0; index < Math.min(fragments.length, MAX_USER_CONTENT_ITEMS); index++) parts.push(fragments[index]?.text);
            const text = boundedTextJoin(parts, "\n");
            return `${text || "（内容格式无效）"}${fragments.length > MAX_USER_CONTENT_ITEMS ? `\n[另有 ${fragments.length - MAX_USER_CONTENT_ITEMS} 个片段未显示（已达到浏览器预算）]` : ""}`;
          })()}</div>
      );
    case "sleep":
      return (
        <div className="item item-dim">⏸ 休眠 {typeof item.durationMs === "number" && Number.isFinite(item.durationMs) && item.durationMs >= 0
          ? `${Math.round(item.durationMs / 1000)}s`
          : "（时长格式无效）"}</div>
      );
    case "enteredReviewMode":
      return <div className="item item-dim">✓ 进入审查模式</div>;
    case "exitedReviewMode":
      return <div className="item item-dim">✓ 退出审查模式</div>;
    case "errorItem":
      return (
        <div className="item item-error">
          {runtimeText(item.message, "发生错误")}
          {item.willRetry ? "（将自动重试）" : ""}
        </div>
      );
    default: {
      // Compile-time exhaustiveness with a readable runtime fallback for a
      // newer server variant, rather than losing the entire React tree.
      const unsupported: never = item;
      return <details className="item"><summary>未支持的消息内容</summary><ProgressiveOutput text={printable(unsupported)} /></details>;
    }
  }
});

function FileChangeItem({ item }: { item: Extract<TimelineItem, { type: "fileChange" }> }) {
  const source: unknown[] = Array.isArray(item.changes) ? item.changes : [];
  const changes: Array<Record<string, unknown>> = [];
  const inspected = Math.min(source.length, MAX_FILE_CHANGES * 4);
  for (let index = 0; index < inspected && changes.length < MAX_FILE_CHANGES; index++) {
    const change = source[index];
    if (change && typeof change === "object" && !Array.isArray(change)) changes.push(change as Record<string, unknown>);
  }
  return (
    <div className="item item-filechange">
      <div className="filechange-title">
        文件修改{item.status === "inProgress" ? "（进行中）" : item.status === "declined" ? "（已拒绝）" : ""}
      </div>
      {changes.map((c, i) => (
        <div key={i}>
          <div className="file-line">
            <StatusBadge kind={typeof c.kind === "string" || c.kind && typeof c.kind === "object" && !Array.isArray(c.kind)
              ? c.kind as string | { type?: string } : undefined} />
            <FileChangePaths path={c.path} kind={c.kind} />
          </div>
          {typeof c.diff === "string" && c.diff && <DiffView text={c.diff} />}
        </div>
      ))}
      {source.length > changes.length && <div className="output-truncation">{inspected === source.length
        ? `仅显示前 ${changes.length} / ${source.length} 项（已达到浏览器预算）`
        : `仅显示 ${changes.length} 项；共 ${source.length} 项，最多检查前 ${inspected} 项（已达到浏览器预算）`}</div>}
    </div>
  );
}

function PlainMarkdown({ text }: { text: string }) {
  return <>
    <pre className="markdown-plain" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{text}</pre>
    <div className="output-truncation" role="status">Markdown 结构过于复杂或解析失败，已安全显示为纯文本。</div>
  </>;
}

/** Isolate parser/plugin/render errors to one message, including historical
 * messages. New streamed text gets another bounded attempt, not a permanently
 * poisoned component or an error that removes the entire application. */
export class MarkdownBoundary extends Component<{ text: string; children: ReactNode }, { text: string; failed: boolean }> {
  state = { text: this.props.text, failed: false };
  static getDerivedStateFromProps(props: { text: string }, state: { text: string; failed: boolean }) {
    return props.text === state.text ? null : { text: props.text, failed: false };
  }
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <PlainMarkdown text={this.props.text} /> : this.props.children; }
}

export function Markdown({ text, fallback = "" }: { text: unknown; fallback?: string }) {
  const MAX_MARKDOWN_CHARS = 200_000;
  // Inspect and slice exactly once, before the parser sees model-controlled
  // text. Keep the notice outside Markdown so an unfinished fence/HTML block
  // cannot hide it, and callers cannot silently lose the truncation signal.
  const source = typeof text === "string" ? text : fallback;
  const truncated = source.length > MAX_MARKDOWN_CHARS;
  const bounded = source.slice(0, MAX_MARKDOWN_CHARS);
  return (
    <div className="markdown">
      <MarkdownBoundary text={bounded}>
      {markdownWithinBudget(bounded) ? <ReactMarkdown
        remarkPlugins={[remarkBoundedTree, remarkGfm]}
        components={{
          a({ href, children }) {
            const safe = validatedHttpUrl(href);
            return safe
              ? <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a>
              : <span>{children}</span>;
          },
          img({ src, alt }) {
            // Markdown is model-controlled. Loading an image automatically
            // would make the browser contact arbitrary Internet/LAN hosts.
            // Keep it as an explicit, validated user gesture instead.
            const safe = validatedHttpUrl(src);
            return safe
              ? <a href={safe} target="_blank" rel="noopener noreferrer">🖼 {alt || "打开外部图片"}</a>
              : <span>（图片地址已阻止）</span>;
          },
        }}
      >{bounded}</ReactMarkdown> : <PlainMarkdown text={bounded} />}
      </MarkdownBoundary>
      {truncated && <div className="output-truncation" role="status">内容超过浏览器 Markdown 解析预算，剩余部分未解析。</div>}
    </div>
  );
}

/** Lightweight unified-diff renderer with add/del/hunk coloring. */
export function DiffView({ text }: { text: string }) {
  const [lineLimit, setLineLimit] = useState(2_000);
  useEffect(() => setLineLimit(2_000), [text]);
  if (!text) return null;
  const maxChars = 1024 * 1024;
  const boundedText = text.slice(0, maxChars);
  let totalLines = boundedText.length > 0 ? 1 : 0;
  for (let index = 0; index < boundedText.length; index++) if (boundedText.charCodeAt(index) === 10) totalLines += 1;
  const totalKnown = boundedText.length === text.length;
  const shownLines: string[] = [];
  let cursor = 0;
  let hasMore = text.length > maxChars;
  while (shownLines.length < lineLimit && cursor <= boundedText.length) {
    const newline = boundedText.indexOf("\n", cursor);
    if (newline < 0) {
      shownLines.push(boundedText.slice(cursor));
      cursor = boundedText.length + 1;
      break;
    }
    shownLines.push(boundedText.slice(cursor, newline));
    cursor = newline + 1;
  }
  if (cursor <= boundedText.length) hasMore = true;
  const canRevealMore = cursor <= boundedText.length && lineLimit < Math.min(totalLines, 10_000);
  return (
    <>
      <pre className="diff-view">
        {shownLines.map((line, i) => {
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
      {hasMore && <div className="output-truncation" role="status">
        <span>Diff 较长，已显示 {shownLines.length.toLocaleString("zh-CN")} / {totalKnown ? totalLines.toLocaleString("zh-CN") : `至少 ${totalLines.toLocaleString("zh-CN")}`} 行。</span>
        {canRevealMore && <button className="btn" onClick={() => setLineLimit((current) => Math.min(10_000, totalLines, current + 2_000))}>继续显示 Diff</button>}
        {!canRevealMore && <span> 已达到浏览器 Diff 显示预算。</span>}
      </div>}
    </>
  );
}
