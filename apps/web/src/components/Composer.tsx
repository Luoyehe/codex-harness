import { useRef, useState, type KeyboardEvent } from "react";
import { useStore, type ApprovalPolicy, type ReasoningEffort, type SandboxPreset } from "../store";

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
  const reasoningEfforts = useStore((s) => s.reasoningEfforts);
  const updateSettings = useStore((s) => s.updateSettings);
  const models = useStore((s) => s.models);
  const connection = useStore((s) => s.connection);
  const uploadAttachment = useStore((s) => s.uploadAttachment);

  function fmtTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1000) return `${Math.round(n / 1000)}k`;
    return String(n);
  }

  function send() {
    const value = text.trim();
    if (
      sendActive.current ||
      connection !== "open" ||
      turnActive ||
      compacting ||
      !historyReady ||
      (!value && attachments.length === 0) ||
      uploading > 0
    ) return;
    sendActive.current = true;
    setSending(true);
    setUploadError(null);
    const originalText = text;
    const sentAttachments = [...attachments];
    // Clear AFTER the send pipeline succeeds — if newThread() or sendTurn()
    // throws, the composer text and attachments survive for the user to retry.
    void sendMessage(value, sentAttachments.length ? sentAttachments : undefined)
      .then(() => {
        // Preserve anything typed while the request was in flight.
        setText((current) => current === originalText ? "" : current);
        const sentPaths = new Set(sentAttachments.map((a) => a.path));
        // Ownership of each preview URL moved to the optimistic timeline
        // item in sendTurn(). The store revokes it only when the server echo
        // replaces that item; revoking here can leave a broken thumbnail in
        // the interval between turn/start's RPC result and its notification.
        setAttachments((current) => current.filter((a) => !sentPaths.has(a.path)));
      })
      .catch((err: any) => {
        setUploadError(`发送失败: ${err?.message ?? err}`);
        // Turn failures are also shown in the timeline. Keep the draft here
        // as well because a failed first-thread creation has no timeline yet.
        // Keep text/attachments so the user can fix and retry.
      })
      .finally(() => {
        sendActive.current = false;
        setSending(false);
      });
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
        // Batches are deliberately sequential: at most one large base64
        // string is held in memory at a time.
        try {
          const base64 = await fileToBase64(file);
          if (base64.length + filenameBytes + UPLOAD_RPC_OVERHEAD_BYTES > MAX_UPLOAD_RPC_BYTES) {
            throw new Error("编码后超过 WebSocket 单次上传上限");
          }
          const res = await uploadAttachment(file.name, base64, file.type.startsWith("image/") ? "image" : "file");
          setAttachments((list) => [
            ...list,
            {
              kind: file.type.startsWith("image/") ? "image" : "file",
              name: file.name.slice(0, 255),
              size: file.size,
              path: res.path,
              previewUrl,
            },
          ]);
          count += 1;
          totalBytes += file.size;
        } catch (err: any) {
          // The object URL never became part of the attachment list — free it.
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          setUploadError(`${file.name} 上传失败: ${err?.message ?? err}`);
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
    setAttachments((list) => {
      const hit = list.find((a) => a.path === path);
      if (hit?.previewUrl) URL.revokeObjectURL(hit.previewUrl);
      return list.filter((a) => a.path !== path);
    });
    // Clean up the server-side file too so cancelled uploads don't accumulate.
    void deleteAttachment(path).catch(() => {});
  }

  return (
    <div className="composer">
      <textarea
        value={text}
        placeholder={
          activeThreadId
            ? "给 Codex 发消息…（Enter 发送，Shift+Enter 换行）"
            : "输入消息开始新对话（使用当前项目与所选设置）…"
        }
        onChange={(e) => setText(e.target.value)}
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
              <button className="attach-remove" title="移除附件" disabled={sending} onClick={() => removeAttachment(a.path)}>
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
          <option value="">默认模型</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName || m.id}
            </option>
          ))}
        </select>
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
            title="思考程度（对下一条消息生效）。自定义 API/智谱模式的选项来自配置时对端点的自动探测或目录声明；OpenAI 模式为官方标准档位。默认=当前模型默认档"
            value={selectedEffort}
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
            disabled={connection !== "open" || !historyReady || compacting || sending || (!text.trim() && attachments.length === 0) || uploading > 0}
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
