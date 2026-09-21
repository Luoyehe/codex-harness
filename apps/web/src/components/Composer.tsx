import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { selectedModelEfforts, useStore, type ApprovalPolicy, type ReasoningEffort, type SandboxPreset, type SendOperation } from "../store";
import { releasePreviewUrl, retainPreviewUrl } from "../utils/preview-urls";

const MIB = 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * MIB;
const MAX_FILE_BYTES = 25 * MIB;
const MAX_ATTACHMENTS = 20;
const MAX_TOTAL_ATTACHMENT_BYTES = 100 * MIB;
// The gateway accepts a 36MiB WS frame. Base64 expands by 4/3; reserve room
// for the RPC envelope and filename so a raw-size-valid file cannot close the
// connection merely because its encoded frame crosses the transport cap.
const MAX_UPLOAD_RPC_BYTES = 36 * MIB;
const UPLOAD_RPC_OVERHEAD_BYTES = 16 * 1024;

interface PendingAttachment {
  kind: "image" | "file";
  name: string;
  size: number;
  path: string;
  /** Object URL for local image previews (only until the tab closes). */
  previewUrl?: string;
}

interface DraftAttempt {
  text: string;
  textRevision: number;
  attachments: PendingAttachment[];
  operation: SendOperation | null;
}

/**
 * Message composer with per-turn model / approval-policy / sandbox selectors
 * and a "+" attachment picker (images + files, uploaded to the gateway and
 * attached to the next message). With no session selected it sits in a
 * "ready to start" state: typing and sending creates a new session in the
 * current project first.
 */
export function Composer() {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [sending, setSending] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadBatchActive = useRef(false);
  const sendActive = useRef(false);
  const mounted = useRef(true);
  const attachmentOwners = useRef<PendingAttachment[]>([]);
  const uploadPreviewOwners = useRef(new Set<object>());
  const textRevision = useRef(0);
  const draftAttempt = useRef<DraftAttempt | null>(null);
  const [draftOperation, setDraftOperation] = useState<SendOperation | null>(null);
  const [operationCheckState, setOperationCheckState] = useState<Record<string, { busy: boolean; error: string | null }>>({});
  const operationCheckFlights = useRef(new Set<string>());
  const activeThreadId = useStore((s) => s.activeThreadId);
  const historyReady = useStore((s) => !s.activeThreadId || !!s.historyLoaded[s.activeThreadId]);
  const turnActive = useStore((s) => (s.activeThreadId ? !!s.turnActive[s.activeThreadId] : false));
  const usage = useStore((s) => (s.activeThreadId ? s.tokenUsage[s.activeThreadId] : undefined));
  const compacting = useStore((s) => (s.activeThreadId ? !!s.compacting[s.activeThreadId] : false));
  const sendMessage = useStore((s) => s.sendMessage);
  const interruptTurn = useStore((s) => s.interruptTurn);
  const compactThread = useStore((s) => s.compactThread);
  const enterBehavior = useStore((s) => s.settings.enterBehavior);
  const selectedModel = useStore((s) => s.settings.selectedModel);
  const selectedPolicy = useStore((s) => s.settings.selectedApprovalPolicy);
  const selectedSandbox = useStore((s) => s.settings.selectedSandbox);
  const selectedEffort = useStore((s) => s.settings.selectedEffort);
  const updateSettings = useStore((s) => s.updateSettings);
  const models = useStore((s) => s.models);
  const modelLoad = useStore((s) => s.modelLoad);
  const refreshModels = useStore((s) => s.refreshModels);
  const reasoningEfforts = selectedModelEfforts(models, selectedModel);
  const sendOperation = useStore((s) => s.activeThreadId ? s.sendOperations[s.activeThreadId] : undefined);
  const sendOperationRecords = useStore((s) => s.sendOperationRecords);
  const sendOperationOverflow = useStore((s) => s.sendOperationOverflow);
  const checkSendOperation = useStore((s) => s.checkSendOperation);
  const acknowledgeUnknownSend = useStore((s) => s.acknowledgeUnknownSend);
  const unresolvedOperations = useMemo(() => {
    const result: SendOperation[] = [];
    const seen = new Set<string>();
    for (const id in sendOperationRecords) {
      if (!Object.prototype.hasOwnProperty.call(sendOperationRecords, id) || result.length >= 100) break;
      const operation = sendOperationRecords[id];
      if (operation.state !== "unknown" ||
          operation.threadId !== activeThreadId && operation.clientOperationId !== draftOperation?.clientOperationId) continue;
      seen.add(id);
      result.push(operation);
    }
    if (sendOperation?.state === "unknown" && !seen.has(sendOperation.clientOperationId) && result.length < 100) {
      seen.add(sendOperation.clientOperationId);
      result.push(sendOperation);
    }
    // The draft is shared across thread navigation. Its unresolved send must
    // remain locked and visible even while a different idle thread is selected.
    if (draftOperation?.state === "unknown" && !seen.has(draftOperation.clientOperationId) && result.length < 100) {
      result.push(draftOperation);
    }
    return result.sort((a, b) => a.clientOperationId.localeCompare(b.clientOperationId));
  }, [activeThreadId, draftOperation, sendOperation, sendOperationRecords]);
  const unresolved = unresolvedOperations.length > 0;
  const management = useStore((state) => state.management);
  const connection = useStore((s) => s.connection);
  const uploadAttachment = useStore((s) => s.uploadAttachment);

  function updateAttachments(update: (current: PendingAttachment[]) => PendingAttachment[]) {
    setAttachments((current) => {
      const next = update(current);
      attachmentOwners.current = next;
      return next;
    });
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const attachment of attachmentOwners.current) releasePreviewUrl(attachment, attachment.previewUrl);
      attachmentOwners.current = [];
      for (const owner of uploadPreviewOwners.current) releasePreviewUrl(owner);
      uploadPreviewOwners.current.clear();
    };
  }, []);

  function releaseAttempt(attempt: DraftAttempt) {
    if (draftAttempt.current !== attempt) return;
    draftAttempt.current = null;
    setDraftOperation(null);
    sendActive.current = false;
    setSending(false);
  }

  function settleAttempt(attempt: DraftAttempt, operation: SendOperation) {
    if (draftAttempt.current !== attempt || attempt.operation?.threadId !== operation.threadId ||
        attempt.operation.clientOperationId !== operation.clientOperationId) return;
    attempt.operation = operation;
    const acknowledged = operation.state === "acknowledged_unknown";
    if (operation.state !== "accepted" && !acknowledged) {
      setDraftOperation(operation);
      return;
    }
    setText((current) => textRevision.current === attempt.textRevision && current === attempt.text ? "" : current);
    updateAttachments((current) => current.filter((attachment) => !attempt.attachments.includes(attachment)));
    // The timeline owns independent clones. Releasing the Composer owner here
    // therefore cannot invalidate an accepted optimistic preview; on a local
    // acknowledgment it becomes the final owner and revokes exactly once.
    for (const attachment of attempt.attachments) releasePreviewUrl(attachment, attachment.previewUrl);
    setUploadError(acknowledged ? "已按确认放弃原草稿。原请求结果仍未知；没有重发，也没有删除服务器附件。" : "已确认上一条消息已被服务器受理，未重复发送。");
    releaseAttempt(attempt);
  }

  useEffect(() => useStore.subscribe((state) => {
    const attempt = draftAttempt.current;
    if (!attempt?.operation) return;
    const selected = state.sendOperations[attempt.operation.threadId];
    const operation = state.sendOperationRecords[attempt.operation.clientOperationId] ??
      (selected?.clientOperationId === attempt.operation.clientOperationId ? selected : undefined);
    // Observe synchronously, including background/cross-tab acknowledgment
    // immediately followed by a new operation before React renders again.
    if (operation) settleAttempt(attempt, operation);
  }), []);

  function fmtTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1000) return `${Math.round(n / 1000)}k`;
    return String(n);
  }

  function send() {
    const value = text.trim();
    if (
      sendActive.current ||
      unresolved ||
      sendOperationOverflow ||
      management.state !== "idle" ||
      connection !== "open" ||
      turnActive ||
      compacting ||
      !historyReady ||
      (!value && attachments.length === 0) ||
      uploading > 0
    ) return;
    sendActive.current = true;
    const attempt: DraftAttempt = { text, textRevision: textRevision.current, attachments: [...attachments], operation: null };
    draftAttempt.current = attempt;
    setSending(true);
    setUploadError(null);
    // Clear AFTER the send pipeline succeeds — if newThread() or sendTurn()
    // throws, the composer text and attachments survive for the user to retry.
    void sendMessage(value, attempt.attachments.length ? attempt.attachments : undefined, (identity) => {
      if (draftAttempt.current !== attempt) return;
      attempt.operation = { ...identity, state: "unknown" };
      setDraftOperation(attempt.operation);
    })
      .then(() => {
        if (attempt.operation) settleAttempt(attempt, { ...attempt.operation, state: "accepted" });
      })
      .catch((err: any) => {
        if (draftAttempt.current !== attempt) return;
        const identity = attempt.operation;
        const currentState = useStore.getState();
        const selected = identity && currentState.sendOperations[identity.threadId];
        const latest = identity && (currentState.sendOperationRecords[identity.clientOperationId] ??
          (selected?.clientOperationId === identity.clientOperationId ? selected : undefined));
        const operation = latest ?? identity;
        if (operation?.state === "accepted" || operation?.state === "acknowledged_unknown") {
          settleAttempt(attempt, operation);
          return;
        }
        if (operation?.state === "unknown") {
          settleAttempt(attempt, operation);
          setUploadError("发送结果待确认：可能已经执行，请勿重复发送。草稿与附件暂时保留。");
        } else {
          releaseAttempt(attempt);
          setUploadError(`发送失败: ${err?.message ?? err}`);
        }
        // Turn failures are also shown in the timeline. Keep the draft here
        // as well because a failed first-thread creation has no timeline yet.
        // Keep text/attachments so the user can fix and retry.
      })
      .finally(() => {
        if (draftAttempt.current !== attempt) return;
        sendActive.current = false;
        setSending(false);
      });
  }

  function acknowledgeUnknownDraft(operation: SendOperation) {
    if (!operation || sending || sendActive.current || uploading > 0) return;
    if (!confirm("服务器可能已经执行这次请求，当前没有足够证据确认成功或失败。\n\n请先核对原会话历史与实际执行结果。继续只放弃这次发送捕获的原草稿及附件选择，保留后续编辑、服务器附件和未知执行记录，不会重发、取消或停止原请求。之后再次输入同一指令仍可能重复执行。\n\n确认已核对，并放弃原草稿？")) return;
    if (!acknowledgeUnknownSend(operation.threadId, operation.clientOperationId)) {
      setUploadError("未能记录你的确认，草稿未清空；请检查浏览器存储或重新核对发送状态。");
      return;
    }
    const attempt = draftAttempt.current;
    if (attempt) settleAttempt(attempt, { ...operation, state: "acknowledged_unknown" });
    setUploadError("已按确认放弃原草稿。原请求结果仍未知；没有重发，也没有删除服务器附件。");
  }

  async function checkUnknownDraft(operation: SendOperation) {
    const id = operation.clientOperationId;
    if (operationCheckFlights.current.has(id)) return;
    operationCheckFlights.current.add(id);
    setOperationCheckState((state) => ({ ...state, [id]: { busy: true, error: null } }));
    const attempt = draftAttempt.current;
    try {
      const checked = await checkSendOperation(operation.threadId, id);
      const latestState = useStore.getState();
      const selected = latestState.sendOperations[operation.threadId];
      const latest = latestState.sendOperationRecords[id] ??
        (selected?.clientOperationId === id ? selected : undefined);
      if (attempt && checked) settleAttempt(attempt, checked);
      if (!mounted.current) return;
      if (checked?.state === "unknown") {
        setOperationCheckState((state) => ({ ...state, [id]: { busy: false, error: "服务器仍报告结果未知；未自动重发，请稍后再核对。" } }));
      } else if (!checked && latest?.state === "unknown") {
        setOperationCheckState((state) => ({ ...state, [id]: { busy: false, error: "未能核对发送状态；连接可能不稳定，未自动重发。" } }));
      } else {
        setOperationCheckState((state) => {
          const next = { ...state };
          delete next[id];
          return next;
        });
      }
    } catch (error) {
      if (!mounted.current) return;
      const detail = error instanceof Error ? error.message.slice(0, 1_000) : "未知错误";
      setOperationCheckState((state) => ({ ...state, [id]: { busy: false, error: `核对发送状态失败：${detail}` } }));
    } finally {
      operationCheckFlights.current.delete(id);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>, behavior: "send" | "newline") {
    const plain = !e.shiftKey && !e.nativeEvent.isComposing;
    const shifted = e.shiftKey && !e.nativeEvent.isComposing;
    if (e.key === "Enter" && ((behavior === "send" && plain) || (behavior === "newline" && shifted))) {
      e.preventDefault();
      send();
    }
  }

  async function pickFiles(files: FileList | null) {
    if (!files?.length || uploadBatchActive.current) return;
    uploadBatchActive.current = true;
    setUploading(1);
    setUploadError(null);
    let count = attachments.length;
    let totalBytes = attachments.reduce((sum, attachment) => sum + attachment.size, 0);
    try {
      for (const file of Array.from(files).slice(0, Math.max(0, MAX_ATTACHMENTS - count))) {
        // Image cap aligns with the Zhipu vision MCP (5MB); larger images would
        // upload but fail at analysis time. Files get a transport-practical cap.
        const cap = file.type.startsWith("image/") ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
        if (file.size === 0) {
          setUploadError(`${file.name} 是空文件`);
          continue;
        }
        if (file.size > cap) {
          setUploadError(`${file.name} 超过 ${Math.floor(cap / MIB)}MB 上限`);
          continue;
        }
        if (totalBytes + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
          setUploadError(`本条消息的附件总量不能超过 ${MAX_TOTAL_ATTACHMENT_BYTES / MIB}MB`);
          continue;
        }
        const encodedBytes = 4 * Math.ceil(file.size / 3);
        const filenameBytes = new TextEncoder().encode(file.name).byteLength;
        if (encodedBytes + filenameBytes + UPLOAD_RPC_OVERHEAD_BYTES > MAX_UPLOAD_RPC_BYTES) {
          setUploadError(`${file.name} 编码后超过 WebSocket 单次上传上限`);
          continue;
        }
        const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
        const uploadPreviewOwner = {};
        if (previewUrl) {
          retainPreviewUrl(uploadPreviewOwner, previewUrl);
          uploadPreviewOwners.current.add(uploadPreviewOwner);
        }
        // Batches are deliberately sequential: at most one large base64
        // string is held in memory at a time.
        try {
          const base64 = await fileToBase64(file);
          if (base64.length + filenameBytes + UPLOAD_RPC_OVERHEAD_BYTES > MAX_UPLOAD_RPC_BYTES) {
            throw new Error("编码后超过 WebSocket 单次上传上限");
          }
          const res = await uploadAttachment(file.name, base64, file.type.startsWith("image/") ? "image" : "file");
          if (!mounted.current) {
            releasePreviewUrl(uploadPreviewOwner, previewUrl);
            uploadPreviewOwners.current.delete(uploadPreviewOwner);
            continue;
          }
          const attachment: PendingAttachment = {
            kind: file.type.startsWith("image/") ? "image" : "file",
            name: file.name.slice(0, 255),
            size: file.size,
            path: res.path,
            previewUrl,
          };
          // Retain the durable draft owner before releasing the temporary
          // upload owner, so the URL never reaches a zero-reference gap.
          retainPreviewUrl(attachment, previewUrl);
          releasePreviewUrl(uploadPreviewOwner, previewUrl);
          uploadPreviewOwners.current.delete(uploadPreviewOwner);
          updateAttachments((list) => [...list, attachment]);
          count += 1;
          totalBytes += file.size;
        } catch (err: any) {
          // The object URL never became part of the attachment list — free it.
          releasePreviewUrl(uploadPreviewOwner, previewUrl);
          uploadPreviewOwners.current.delete(uploadPreviewOwner);
          if (mounted.current) setUploadError(`${file.name} 上传失败: ${err?.message ?? err}`);
        }
      }
      if (files.length > MAX_ATTACHMENTS - attachments.length) {
        setUploadError(`每条消息最多添加 ${MAX_ATTACHMENTS} 个附件`);
      }
    } finally {
      uploadBatchActive.current = false;
      setUploading(0);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  const deleteAttachment = useStore((s) => s.deleteAttachment);

  function removeAttachment(path: string) {
    updateAttachments((list) => {
      const hit = list.find((a) => a.path === path);
      if (hit) releasePreviewUrl(hit, hit.previewUrl);
      return list.filter((a) => a.path !== path);
    });
    // Clean up the server-side file too so cancelled uploads don't accumulate.
    void deleteAttachment(path).catch((error) => {
      const detail = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
      setUploadError(`附件已从草稿移除，但服务器清理未确认：${detail || "未知错误"}。服务器可能仍保留临时文件。`);
    });
  }

  return (
    <div className="composer">
      {management.state !== "idle" && <div className="dim" role="status">{management.state === "unknown" ? "服务器管理操作结果未知，请在设置中核对管理状态；暂时不能提交新任务。" : `管理操作 ${management.operation ?? ""} 正在进行，暂时不能提交新任务。`}</div>}
      {unresolvedOperations.map((operation) => {
        const check = operationCheckState[operation.clientOperationId];
        return <div className="error-text send-operation-alert" role="status" key={operation.clientOperationId}>
        <span>消息是否受理尚未确认，发送已暂停以防重复执行。</span>
        <span className="send-operation-identity">发送标识 <code>{operation.clientOperationId}</code>{operation.threadId !== activeThreadId && <> · 会话 <code>{operation.threadId}</code></>}</span>
        {check?.error && <span role="alert">{check.error}</span>}
        <span className="send-operation-actions">
          <button className="btn" disabled={connection !== "open" || !!check?.busy} onClick={() => void checkUnknownDraft(operation)}>{check?.busy ? "核对中…" : "核对发送状态"}</button>
          <button className="btn" disabled={sending || uploading > 0 || !!check?.busy} onClick={() => acknowledgeUnknownDraft(operation)}>已核对历史，放弃这次草稿</button>
        </span>
      </div>})}
      {sendOperationOverflow && <div className="error-text send-operation-alert" role="alert">
        本地待核对发送记录超过浏览器安全预算。未自动重发任何请求；请先核对已有会话或清理本站旧记录，新发送已暂停。
      </div>}
      {sendOperation?.state === "acknowledged_unknown" && <div className="dim" role="status">你已确认放弃未知结果请求的草稿；服务器执行结果仍未确定。新消息会使用新的发送标识，重复输入原指令可能重复执行。</div>}
      <textarea
        value={text}
        placeholder={
          activeThreadId
            ? "给 Codex 发消息…（Enter 发送，Shift+Enter 换行）"
            : "输入消息开始新对话（使用当前项目与所选设置）…"
        }
        onChange={(e) => { ++textRevision.current; setText(e.target.value); }}
        onKeyDown={(e) => onKeyDown(e, enterBehavior)}
        maxLength={1_000_000}
        rows={3}
      />
      {(attachments.length > 0 || uploadError) && (
        <div className="attach-chips">
          {attachments.map((a) => (
            <span key={a.path} className={`attach-chip ${a.kind === "image" ? "attach-chip-img" : ""}`}>
              {a.kind === "image" && a.previewUrl && (
                <img src={a.previewUrl} alt={a.name} className="attach-thumb" />
              )}
              {a.kind === "file" && <span className="attach-icon">📄</span>}
              <span className="attach-name" title={a.name}>
                {a.name}
              </span>
              <button className="attach-remove" title="移除附件" disabled={sending || unresolved} onClick={() => removeAttachment(a.path)}>
                ×
              </button>
            </span>
          ))}
          {uploading > 0 && <span className="attach-chip attach-uploading">上传中… ({uploading})</span>}
          {uploadError && <span className="attach-chip attach-error">{uploadError}</span>}
        </div>
      )}
      <div className="composer-actions">
        <button
          className="icon-btn icon-btn-plus"
          title="添加图片/文件附件（随下一条消息发送）"
          disabled={connection !== "open" || uploading > 0 || sending || attachments.length >= MAX_ATTACHMENTS}
          onClick={() => fileInput.current?.click()}
        >
          ＋
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          disabled={uploading > 0 || sending}
          accept="image/*,.pdf,.txt,.md,.json,.csv,.log,.xml,.yml,.yaml,.toml,.js,.ts,.py,.go,.rs,.java,.c,.cpp,.h,.sh,.html,.css"
          onChange={(e) => void pickFiles(e.target.files)}
        />
        <select
          className="composer-select"
          title="模型（对下一条消息生效，新对话同样适用）"
          value={selectedModel}
          onChange={(e) => updateSettings({ selectedModel: e.target.value })}
        >
          <option value="">{modelLoad.state === "loading" && models.length === 0 ? "模型加载中…" : "默认模型"}</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName || m.id}
            </option>
          ))}
        </select>
        {modelLoad.state === "error" && (
          <button
            type="button"
            className="btn composer-model-retry"
            role="alert"
            title={modelLoad.error ?? "模型目录读取失败"}
            onClick={() => void refreshModels()}
          >
            模型加载失败，重试
          </button>
        )}
        <select
          className="composer-select"
          title="审批策略（对下一条消息生效，新对话同样适用）"
          value={selectedPolicy}
          onChange={(e) => updateSettings({ selectedApprovalPolicy: e.target.value as ApprovalPolicy })}
        >
          <option value="">默认审批</option>
          <option value="on-request">按需询问</option>
          <option value="untrusted">全部询问</option>
          <option value="never">从不询问</option>
        </select>
        <select
          className="composer-select"
          title="沙箱模式（对下一条消息生效，新对话同样适用）。默认=服务器配置（无网络）；允许网络=只读文件但可访问局域网/外网，适合 curl/ping/SSH 探测；完全访问=无沙箱限制"
          value={selectedSandbox}
          onChange={(e) => updateSettings({ selectedSandbox: e.target.value as SandboxPreset })}
        >
          <option value="">默认沙箱</option>
          <option value="network">允许网络</option>
          <option value="full">完全访问</option>
        </select>
        <span className="spacer" />
        {/* Tail group in its own sub-container: the two bottom rows need
            OPPOSITE alignment on mobile (selectors left, this group right) —
            one flex line can't do per-line justify, a nested flex can. */}
        <div className="composer-tail">
        {usage && (
          <span
            className="ctx-badge"
            title={`当前对话累计占用 ${usage.total.toLocaleString()} tokens${usage.window ? ` / 模型窗口 ${usage.window.toLocaleString()}` : ""}。接近窗口时可用「压缩」总结历史释放空间`}
          >
            上下文 {fmtTokens(usage.total)}
            {usage.window ? `/${fmtTokens(usage.window)}` : ""}
            {usage.window ? <span className="ctx-pct"> {Math.min(100, Math.round((usage.total / usage.window) * 100))}%</span> : null}
          </span>
        )}
        {usage && activeThreadId && (
          <button
            className="btn compact-btn"
            disabled={compacting || turnActive}
            title="总结压缩对话历史，释放上下文空间（压缩期间会开启一个总结任务）"
            onClick={() => void compactThread()}
          >
            {compacting ? "压缩中…" : "压缩"}
          </button>
        )}
        {reasoningEfforts.length > 0 && (
          <select
            className="composer-select"
            title="思考程度来自所选模型的能力声明；未确认的模型不提供推测档位。默认=当前模型默认档"
            value={reasoningEfforts.includes(selectedEffort as Exclude<ReasoningEffort, "">) ? selectedEffort : ""}
            onChange={(e) => updateSettings({ selectedEffort: e.target.value as ReasoningEffort })}
          >
            <option value="">默认思考</option>
            {reasoningEfforts.map((e) => (
              <option key={e} value={e}>
                思考·{e}
              </option>
            ))}
          </select>
        )}
        {turnActive ? (
          <button className="btn-danger" onClick={() => void interruptTurn()}>
            停止
          </button>
        ) : (
          <button
            className="btn-primary"
            disabled={connection !== "open" || management.state !== "idle" || unresolved || sendOperationOverflow || !historyReady || compacting || sending || (!text.trim() && attachments.length === 0) || uploading > 0}
            onClick={send}
          >
            {sending ? "发送中…" : activeThreadId ? "发送" : "发送并新建"}
          </button>
        )}
        </div>
      </div>
    </div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1)); // strip data: prefix
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}
