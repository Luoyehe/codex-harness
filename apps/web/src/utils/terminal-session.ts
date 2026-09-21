import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { GatewayNotification } from "../api/protocol";

type TerminalRpc = <T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>;

function dimension(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(500, Math.max(2, Math.trunc(value))) : fallback;
}

function processId(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  // randomUUID is secure-context-only; LAN HTTP pages still have getRandomValues.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Owns the lifecycle shared by the terminal DOM, geometry and gateway process. */
export class TerminalSession {
  readonly processId = processId();
  exited = false;
  unavailable = false;
  private ready = false;
  private disposed = false;
  private frame: number | null = null;
  private observer: ResizeObserver;
  private subscriptions: Array<{ dispose(): void }>;
  private writeQueue: Uint8Array[] = [];
  private queuedBytes = 0;
  private writing = false;
  private resizeInFlight = false;
  private pendingDimensions: { cols: number; rows: number } | null = null;
  private inputBlocked = false;
  private outputBytes = 0;
  private outputBlocked = false;

  constructor(
    readonly term: Terminal,
    readonly fit: FitAddon,
    readonly container: HTMLDivElement,
    private rpc: TerminalRpc,
    private onEnded: (confirmedExit: boolean) => void,
  ) {
    // Install listeners before open/fit: fit only emits when dimensions change.
    this.subscriptions = [
      term.onData((data) => {
        if (!this.ready || this.exited || this.unavailable || this.disposed || this.inputBlocked) return;
        const bytes = new TextEncoder().encode(data);
        // Refuse the whole new paste before admitting any of it. Previously
        // >64 KiB pastes were silently discarded by the gateway.
        if (this.queuedBytes + bytes.length > 1024 * 1024) {
          this.term.writeln("\r\n[输入队列已满：本次输入未发送，请等待后重试。]");
          return;
        }
        // Split bytes, not JavaScript characters. The PTY is a byte stream;
        // multi-byte UTF-8 sequences crossing frames reassemble unchanged.
        for (let offset = 0; offset < bytes.length; offset += 32 * 1024) this.writeQueue.push(bytes.slice(offset, offset + 32 * 1024));
        this.queuedBytes += bytes.length;
        void this.drainWrites();
      }),
      term.onResize(() => this.syncDimensions()),
    ];
    term.open(container);
    this.observer = new ResizeObserver(() => {
      if (this.frame !== null || this.disposed) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        this.fitVisible();
      });
    });
    this.observer.observe(container);
    this.fitVisible();
  }

  async start(cwd: string | null): Promise<void> {
    const result = await this.rpc<{ processId: string }>("terminal/exec", {
      processId: this.processId,
      ...this.dimensions(),
      ...(cwd ? { cwd } : {}),
    });
    if (result?.processId !== this.processId) throw new Error("gateway returned a different processId");
    if (this.disposed) {
      void this.rpc("terminal/terminate", { processId: this.processId }).catch(() => {});
      return;
    }
    if (this.unavailable) return;
    this.ready = true;
    // A terminal/exited notification may already have arrived during exec.
    // Never turn that final state back into a running terminal.
    this.syncDimensions();
    if (!this.exited) this.term.focus();
  }

  handleNotification({ method, params }: GatewayNotification): void {
    if (this.disposed || this.exited) return;
    // A lifecycle notification is stronger evidence than a prior transport
    // failure. It must be allowed to upgrade "unknown" to confirmed exited.
    if (method === "terminal/allExited") {
      this.markExited("服务器重启，进程已终止");
      return;
    }
    const runtimeParams = params && typeof params === "object" && !Array.isArray(params)
      ? params as unknown as Record<string, unknown>
      : null;
    if (!runtimeParams) return;
    if (method === "terminal/exited" && runtimeParams.processId === this.processId) {
      const exitCode = typeof runtimeParams.exitCode === "number" && Number.isFinite(runtimeParams.exitCode) ? runtimeParams.exitCode : null;
      const error = typeof runtimeParams.error === "string" ? runtimeParams.error.slice(0, 2_000) : "";
      this.markExited(`进程已退出${exitCode != null ? `，exit ${exitCode}` : ""}${error ? `：${error}` : ""}`);
    } else if (this.unavailable) {
      return;
    } else if (method === "command/exec/outputDelta" && runtimeParams.processId === this.processId && typeof runtimeParams.deltaBase64 === "string") {
      if (this.outputBlocked) return;
      try {
        // Reject an oversized encoded frame before atob allocates its decoded
        // copy. Four MiB of queued binary needs at most this many base64 chars.
        if (runtimeParams.deltaBase64.length > Math.ceil((4 * 1024 * 1024) * 4 / 3) + 4) {
          this.stopForOutputOverflow();
          return;
        }
        const binary = atob(runtimeParams.deltaBase64);
        if (this.outputBytes + binary.length > 4 * 1024 * 1024) {
          this.stopForOutputOverflow();
          return;
        }
        this.outputBytes += binary.length;
        this.term.write(Uint8Array.from(binary, (char) => char.charCodeAt(0)), () => { this.outputBytes -= binary.length; });
      } catch {
        // Continuing after a missing/corrupt byte frame would present an
        // incomplete transcript as trustworthy. Freeze this view and make the
        // uncertainty explicit; closing it still requests process cleanup.
        this.markUnavailable("终端输出数据格式无效，显示可能不完整；进程退出尚未确认，请关闭终端后核对服务器状态");
      }
    }
  }

  private stopForOutputOverflow(): void {
    if (this.outputBlocked) return;
    this.outputBlocked = true;
    this.inputBlocked = true;
    this.writeQueue = [];
    this.queuedBytes = 0;
    this.term.writeln("\r\n[终端输出超过显示队列上限，已暂停显示和输入；正在请求终止进程，等待服务器确认。]");
    void this.rpc("terminal/terminate", { processId: this.processId })
      .then(() => {
        if (!this.disposed && !this.exited && !this.unavailable) this.term.writeln("\r\n[终止请求已送达，仍在等待进程退出确认。]");
      })
      .catch((error) => {
        if (!this.disposed && !this.exited && !this.unavailable) {
          this.markUnavailable(`终止请求失败：${error instanceof Error ? error.message : String(error)}；进程状态仍未知，请关闭终端后核对服务器状态`);
        }
      });
  }

  markExited(message: string): void {
    if (this.disposed || this.exited) return;
    this.exited = true;
    this.unavailable = false;
    this.outputBlocked = true;
    this.inputBlocked = true;
    this.writeQueue = [];
    this.queuedBytes = 0;
    this.pendingDimensions = null;
    this.term.writeln(`\r\n\x1b[90m[${message}]\x1b[0m`);
    this.onEnded(true);
  }

  /** A closed browser connection makes this PTY unusable, but the gateway may
   * still be retrying process termination. Preserve that distinction instead
   * of presenting an unconfirmed remote process as exited. */
  markUnavailable(message: string): void {
    if (this.disposed || this.exited || this.unavailable) return;
    this.unavailable = true;
    this.outputBlocked = true;
    this.inputBlocked = true;
    this.writeQueue = [];
    this.queuedBytes = 0;
    this.pendingDimensions = null;
    this.term.writeln(`\r\n\x1b[90m[${message}]\x1b[0m`);
    this.onEnded(false);
  }

  private async drainWrites(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.writeQueue.length && !this.disposed && !this.exited && !this.unavailable && !this.inputBlocked) {
        const bytes = this.writeQueue.shift()!;
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        try {
          await this.rpc("terminal/write", { processId: this.processId, base64: btoa(binary) });
          this.queuedBytes = Math.max(0, this.queuedBytes - bytes.length);
        } catch {
          // A lost acknowledgement may follow a successful write. Never
          // replay this chunk (or the remaining suffix) as a shell command.
          this.inputBlocked = true;
          this.writeQueue = [];
          this.queuedBytes = 0;
          if (!this.disposed) this.term.writeln("\r\n[输入传输中断：部分内容可能已经执行，未自动重发，后续输入已暂停。请检查输出并新建终端。]");
        }
      }
    } finally { this.writing = false; }
  }

  fitVisible(): void {
    if (!this.disposed && this.container.style.display !== "none") this.fit.fit();
  }

  private dimensions() {
    return { cols: dimension(this.term.cols, 80), rows: dimension(this.term.rows, 24) };
  }

  private syncDimensions(): void {
    if (!this.ready || this.exited || this.unavailable || this.disposed) return;
    // Geometry events can arrive much faster than a remote gateway can
    // acknowledge them. Keep at most one request in flight and one coalesced
    // latest value; otherwise a dragged window can exhaust the WebSocket's
    // pending-RPC budget and starve unrelated terminal work.
    this.pendingDimensions = this.dimensions();
    void this.drainDimensions();
  }

  private async drainDimensions(): Promise<void> {
    if (this.resizeInFlight) return;
    this.resizeInFlight = true;
    try {
      while (!this.disposed && !this.exited && !this.unavailable && this.pendingDimensions) {
        const dimensions = this.pendingDimensions;
        this.pendingDimensions = null;
        try {
          await this.rpc("terminal/resize", { processId: this.processId, ...dimensions });
        } catch {
          // Resize is idempotent and advisory. A newer queued geometry is still
          // useful after this failure, but replaying the failed request without
          // a new event could loop forever on a closed connection.
        }
      }
    } finally {
      this.resizeInFlight = false;
      // No asynchronous work can interleave between the final loop condition
      // and this block, but keep the hand-off explicit for future callers that
      // may queue a value from an RPC completion callback.
      if (!this.disposed && !this.exited && !this.unavailable && this.pendingDimensions) {
        void this.drainDimensions();
      }
    }
  }

  dispose(onTerminationFailed?: (error: unknown) => void): void {
    if (this.disposed) return;
    this.disposed = true;
    this.writeQueue = [];
    this.queuedBytes = 0;
    this.pendingDimensions = null;
    this.observer.disconnect();
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    for (const subscription of this.subscriptions) subscription.dispose();
    if (!this.exited) void this.rpc("terminal/terminate", { processId: this.processId }).catch((error) => {
      // Component unmount has nowhere safe to report an error, but an
      // explicit tab close supplies a reporter so a failed/unknown cleanup is
      // never presented as a confirmed process exit.
      try { onTerminationFailed?.(error); } catch { /* UI reporter failure */ }
    });
    this.term.dispose();
    this.container.remove();
  }
}
