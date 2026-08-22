import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/**
 * JSON-RPC 2.0 connection to a `codex app-server` child process over stdio.
 * The app-server wire format omits the "jsonrpc" header on the wire.
 */
export interface AppServerHandlers {
  /** Notification from the server (no id). */
  onNotification(method: string, params: unknown): void;
  /** Server-initiated request. Return the result payload, or throw to send an error. */
  onServerRequest(id: number | string, method: string, params: unknown): Promise<unknown>;
  onExit(code: number | null, signal: string | null): void;
  onStderr(chunk: string): void;
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  /** Timeout handle so a late response can be ignored after rejection. */
  timer?: ReturnType<typeof setTimeout>;
}

/** How long to wait for an app-server response before giving up (per call). */
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Methods whose response legitimately arrives long after the request (e.g.
 * command/exec resolves at process exit for interactive shells). These are
 * exempt from the client-side timeout — killing them would falsely mark a
 * live PTY as exited.
 */
const NO_TIMEOUT_METHODS = new Set(["command/exec"]);

export class AppServerConnection {
  private child: ChildProcess | null = null;
  private stdinStream: Writable | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingEntry>();

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly env: Record<string, string>,
    private readonly handlers: AppServerHandlers,
  ) {}

  spawn(): void {
    // Windows npm shims are .cmd files, which Node refuses to spawn without a
    // shell. Args here are gateway-controlled ("app-server"), so this is safe.
    const child = spawn(this.command, this.args, {
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32",
    });
    this.child = child;

    child.on("error", (err) => {
      // Spawn failures (ENOENT, EACCES) arrive here WITHOUT an exit event —
      // call onExit ourselves so the Supervisor's restart logic engages
      // instead of staying stuck in "starting" forever.
      this.failAllPending(new Error(`failed to spawn app-server: ${err.message}`));
      this.handlers.onExit(null, `spawn-error: ${err.message}`);
    });
    child.on("exit", (code, signal) => {
      this.failAllPending(new Error(`app-server exited (code=${code} signal=${signal})`));
      this.handlers.onExit(code, signal);
    });

    this.attach(child.stdin, child.stdout!, child.stderr!);
  }

  /** Wire a transport; separate from spawn() so tests (or sockets) can inject streams. */
  attach(stdin: Writable, stdout: Readable, stderr?: Readable): void {
    this.stdinStream = stdin;
    const lines = createInterface({ input: stdout });
    lines.on("line", (line) => this.handleLine(line));
    if (stderr) {
      stderr.setEncoding("utf8");
      stderr.on("data", (chunk: string) => this.handlers.onStderr(chunk));
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.handlers.onStderr(trimmed + "\n");
      return;
    }

    if (msg.method !== undefined && msg.id !== undefined && !("result" in msg) && !("error" in msg)) {
      void (async () => {
        try {
          const result = await this.handlers.onServerRequest(msg.id, msg.method, msg.params);
          this.writeFrame({ id: msg.id, result: result ?? null });
        } catch (err: any) {
          this.writeFrame({ id: msg.id, error: { code: -32000, message: err?.message ?? "error" } });
        }
      })();
      return;
    }
    if (msg.method !== undefined && msg.id === undefined) {
      this.handlers.onNotification(msg.method, msg.params);
      return;
    }
    if (msg.id !== undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new Error(`${msg.error.message ?? "app-server error"} (${msg.error.code})`));
      } else {
        entry.resolve(msg.result);
      }
    }
  }

  private writeFrame(frame: unknown): void {
    if (!this.stdinStream?.writable) return;
    this.stdinStream.write(JSON.stringify(frame) + "\n");
  }

  private failAllPending(err: Error): void {
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const noTimeout = NO_TIMEOUT_METHODS.has(method);
    return new Promise<T>((resolve, reject) => {
      const entry: PendingEntry = {
        resolve: (v) => resolve(v as T),
        reject,
        timer: noTimeout
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`app-server request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${method}`));
            }, REQUEST_TIMEOUT_MS),
      };
      this.pending.set(id, entry);
      this.writeFrame({ id, method, params: params ?? {} });
    });
  }

  notify(method: string, params?: unknown): void {
    this.writeFrame({ method, params: params ?? {} });
  }

  kill(): void {
    this.child?.kill();
    this.child = null;
  }
}

/** One-shot handshake required before any other call. */
export async function initialize(
  conn: AppServerConnection,
  clientInfo: { name: string; title: string; version: string },
): Promise<void> {
  await conn.request("initialize", { clientInfo });
  conn.notify("initialized");
}
