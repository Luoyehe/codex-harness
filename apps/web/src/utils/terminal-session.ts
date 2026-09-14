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
  private ready = false;
  private disposed = false;
  private frame: number | null = null;
  private observer: ResizeObserver;
  private subscriptions: Array<{ dispose(): void }>;
  private writeQueue: Uint8Array[] = [];
  private queuedBytes = 0;
  private writing = false;
  private inputBlocked = false;
  private outputBytes = 0;

  constructor(
    readonly term: Terminal,
    readonly fit: FitAddon,
    readonly container: HTMLDivElement,
    private rpc: TerminalRpc,
    private onExited: () => void,
  ) {
    // Install listeners before open/fit: fit only emits when dimensions change.
    this.subscriptions = [
      term.onData((data) => {
        if (!this.ready || this.exited || this.disposed || this.inputBlocked) return;
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
    this.ready = true;
    // A terminal/exited notification may already have arrived during exec.
    // Never turn that final state back into a running terminal.
    this.syncDimensions();
    if (!this.exited) this.term.focus();
  }

  handleNotification({ method, params }: GatewayNotification): void {
    if (this.disposed || this.exited) return;
    if (method === "terminal/allExited") {
      this.markExited("服务器重启，进程已终止");
    } else if (method === "terminal/exited" && params.processId === this.processId) {
      this.markExited(`进程已退出${params.exitCode != null ? `，exit ${params.exitCode}` : ""}${params.error ? `：${params.error}` : ""}`);
    } else if (method === "command/exec/outputDelta" && params.processId === this.processId) {
      try {
        const binary = atob(params.deltaBase64);
        if (this.outputBytes + binary.length > 4 * 1024 * 1024) {
          this.markExited("终端输出超过显示队列上限，已停止进程；请新建终端");
          void this.rpc("terminal/terminate", { processId: this.processId }).catch(() => {});
          return;
        }
        this.outputBytes += binary.length;
        this.term.write(Uint8Array.from(binary, (char) => char.charCodeAt(0)), () => { this.outputBytes -= binary.length; });
      } catch { /* Discard malformed output without breaking the subscriber. */ }
    }
  }

  markExited(message: string): void {
    if (this.disposed || this.exited) return;
    this.exited = true;
    this.writeQueue = [];
    this.queuedBytes = 0;
    this.term.writeln(`\r\n\x1b[90m[${message}]\x1b[0m`);
    this.onExited();
  }

  private async drainWrites(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.writeQueue.length && !this.disposed && !this.exited && !this.inputBlocked) {
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
    if (!this.ready || this.exited || this.disposed) return;
    void this.rpc("terminal/resize", { processId: this.processId, ...this.dimensions() }).catch(() => {});
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.writeQueue = [];
    this.queuedBytes = 0;
    this.observer.disconnect();
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    for (const subscription of this.subscriptions) subscription.dispose();
    if (!this.exited) void this.rpc("terminal/terminate", { processId: this.processId }).catch(() => {});
    this.term.dispose();
    this.container.remove();
  }
}
