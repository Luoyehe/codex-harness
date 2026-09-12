import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { InitializeParams } from "../../../../protocol/InitializeParams.js";

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

/** The upstream explicitly rejected the request. Transport failures/timeouts
 * are deliberately different: their acceptance outcome is unknown. */
export class AppServerRequestError extends Error {}

/** Windows batch shims give us cmd.exe's PID. Killing only that wrapper
 * relies on every descendant voluntarily handling stdin EOF. taskkill /T
 * explicitly closes the owned process tree, including wedged descendants. */
function terminateChild(child: ChildProcess | null): void {
  if (!child) return;
  if (process.platform !== "win32" || !child.pid) { child.kill(); return; }
  if (child.exitCode !== null || child.signalCode !== null) return;
  const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
    stdio: "ignore", windowsHide: true, detached: true,
  });
  killer.on("error", () => { try { child.kill(); } catch { /* already exited */ } });
  killer.on("exit", (code) => {
    if (code !== 0) { try { child.kill(); } catch { /* already exited */ } }
  });
  // The helper must survive the gateway's signal handler exiting immediately.
  killer.unref();
}

function windowsLaunch(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const environmentValue = (name: string) => Object.entries(env).find(([key]) => key.toLowerCase() === name)?.[1];
  const extensions = (environmentValue("pathext") || ".COM;.EXE;.BAT;.CMD").split(";");
  const directories = /[\\/]/.test(command)
    ? [""]
    : [process.cwd(), ...(environmentValue("path") || "").split(path.delimiter).map((dir) => dir.replace(/^"|"$/g, ""))];
  // Prefer executable/PATHEXT candidates to an extensionless npm POSIX shim.
  const suffixes = path.extname(command) ? [""] : [...extensions, ""];
  let resolved = command;
  outer: for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = path.resolve(directory, command + suffix);
      try { if (statSync(candidate).isFile()) { resolved = candidate; break outer; } } catch { /* next PATH candidate */ }
    }
  }
  if (!/\.(cmd|bat)$/i.test(resolved)) return { command: resolved, args, windowsVerbatimArguments: false };
  // cmd.exe needs its own escaping, independently of CreateProcess quoting.
  // npm's local .bin shims expand %* through a second cmd parsing pass.
  const meta = /([()\][%!^"`<>&|;, *?])/g;
  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(resolved);
  const escapedArgs = args.map((argument) => {
    let quoted = '"' + argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
    quoted = quoted.replace(meta, "^$1");
    return doubleEscape ? quoted.replace(meta, "^$1") : quoted;
  });
  const shellCommand = [path.normalize(resolved).replace(meta, "^$1"), ...escapedArgs].join(" ");
  return {
    command: environmentValue("comspec") || "cmd.exe",
    args: ["/d", "/s", "/c", `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  };
}

export class AppServerConnection {
  private child: ChildProcess | null = null;
  private stdinStream: Writable | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingEntry>();
  private transportError: Error | null = null;
  private exitReported = false;
  private attached = false;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly env: Record<string, string>,
    private readonly handlers: AppServerHandlers,
  ) {}

  spawn(): void {
    if (this.attached || this.child || this.exitReported) {
      throw new Error("app-server connection has already been started");
    }
    let child: ChildProcess;
    try {
      const env = { ...process.env, ...this.env };
      // Normalize casing before PATH lookup and CreateProcess; Windows treats
      // environment keys case-insensitively, while JS objects do not.
      if (process.platform === "win32") {
        for (const key of Object.keys(this.env)) {
          for (const inherited of Object.keys(env)) {
            if (inherited !== key && inherited.toLowerCase() === key.toLowerCase()) delete env[inherited];
          }
        }
      }
      const launch = process.platform === "win32" ? windowsLaunch(this.command, this.args, env) : { command: this.command, args: this.args, windowsVerbatimArguments: false };
      child = spawn(launch.command, launch.args, {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
      });
    } catch (err: any) {
      const failure = new Error(`failed to spawn app-server: ${err?.message ?? String(err)}`);
      this.markTransportFailed(failure);
      this.reportExit(null, "spawn-error");
      return;
    }
    this.child = child;

    child.on("error", (err) => {
      // Spawn failures (ENOENT, EACCES) arrive here WITHOUT an exit event —
      // call onExit ourselves so the Supervisor's restart logic engages
      // instead of staying stuck in "starting" forever.
      const failure = new Error(`failed to spawn app-server: ${err.message}`);
      this.markTransportFailed(failure);
      this.reportExit(null, `spawn-error: ${err.message}`);
    });
    child.on("exit", (code, signal) => {
      this.markTransportFailed(new Error(`app-server exited (code=${code} signal=${signal})`));
      this.reportExit(code, signal);
    });

    this.attach(child.stdin!, child.stdout!, child.stderr!);
  }

  /** Wire a transport; separate from spawn() so tests (or sockets) can inject streams. */
  attach(stdin: Writable, stdout: Readable, stderr?: Readable): void {
    if (this.attached || this.exitReported) throw new Error("app-server transport is already attached or closed");
    this.attached = true;
    this.transportError = null;
    this.stdinStream = stdin;
    const lines = createInterface({ input: stdout });
    lines.on("line", (line) => this.handleLine(line));
    // A broken stdio transport can happen before the child emits `exit`.
    // Reject requests immediately, especially command/exec (which otherwise
    // deliberately has no response timeout).
    stdin.on("error", (err) => this.failTransport(new Error(`app-server stdin failed: ${err.message}`)));
    stdin.on("close", () => this.failTransport(new Error("app-server stdin closed")));
    stdout.on("error", (err) => this.failTransport(new Error(`app-server stdout failed: ${err.message}`)));
    stdout.on("end", () => this.failTransport(new Error("app-server stdout ended")));
    stdout.on("close", () => this.failTransport(new Error("app-server stdout closed")));
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

    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
      this.reportMalformedFrame();
      return;
    }
    const hasMethod = Object.prototype.hasOwnProperty.call(msg, "method");
    const hasId = Object.prototype.hasOwnProperty.call(msg, "id");
    const hasResult = Object.prototype.hasOwnProperty.call(msg, "result");
    const hasError = Object.prototype.hasOwnProperty.call(msg, "error");
    const validId = (
      typeof msg.id === "string"
        ? msg.id.length > 0 && msg.id.length <= 256
        : typeof msg.id === "number" && Number.isSafeInteger(msg.id)
    );

    if (hasMethod) {
      if (
        typeof msg.method !== "string" ||
        msg.method.length === 0 ||
        msg.method.length > 512 ||
        (hasId && !validId) ||
        hasResult ||
        hasError
      ) {
        this.reportMalformedFrame();
        return;
      }
    }

    if (hasMethod && hasId) {
      void (async () => {
        try {
          const result = await this.handlers.onServerRequest(msg.id, msg.method, msg.params);
          this.writeFrame({ id: msg.id, result: result ?? null }, (err) => {
            this.handlers.onStderr(`[gateway-rpc] failed to answer server request ${String(msg.id)}: ${err.message}\n`);
          });
        } catch (err: any) {
          this.writeFrame(
            { id: msg.id, error: { code: -32000, message: err?.message ?? "error" } },
            (writeErr) => {
              this.handlers.onStderr(`[gateway-rpc] failed to reject server request ${String(msg.id)}: ${writeErr.message}\n`);
            },
          );
        }
      })();
      return;
    }
    if (hasMethod) {
      try {
        this.handlers.onNotification(msg.method, msg.params);
      } catch (err: any) {
        this.handlers.onStderr(`[gateway-rpc] notification handler failed: ${err?.message ?? String(err)}\n`);
      }
      return;
    }
    if (hasId && validId && typeof msg.id === "number" && Number.isInteger(msg.id) && msg.id > 0 && hasResult !== hasError) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (hasError) {
        const error = msg.error && typeof msg.error === "object" ? msg.error : {};
        const message = typeof error.message === "string" ? error.message.slice(0, 2_000) : "app-server error";
        const code = typeof error.code === "number" || typeof error.code === "string" ? String(error.code).slice(0, 64) : "unknown";
        entry.reject(new AppServerRequestError(`${message} (${code})`));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    this.reportMalformedFrame();
  }

  private reportMalformedFrame(): void {
    // Do not echo the frame: tool arguments or credentials can be embedded in
    // malformed payloads and must not be copied into the journal.
    this.handlers.onStderr("[gateway-rpc] ignored malformed JSON-RPC frame\n");
  }

  private writeFrame(frame: unknown, onError?: (err: Error) => void): void {
    const stream = this.stdinStream;
    if (this.transportError) {
      onError?.(this.transportError);
      return;
    }
    if (!stream || !stream.writable || stream.destroyed) {
      const failure = new Error("app-server stdin is not writable");
      this.failTransport(failure);
      onError?.(failure);
      return;
    }
    let encoded: string;
    try {
      encoded = JSON.stringify(frame) + "\n";
    } catch (err: any) {
      onError?.(new Error(`failed to serialize app-server frame: ${err?.message ?? String(err)}`));
      return;
    }
    try {
      stream.write(encoded, (err?: Error | null) => {
        if (!err) return;
        const failure = new Error(`app-server write failed: ${err.message}`);
        this.failTransport(failure);
        onError?.(failure);
      });
    } catch (err: any) {
      const failure = new Error(`app-server write failed: ${err?.message ?? String(err)}`);
      this.failTransport(failure);
      onError?.(failure);
    }
  }

  private markTransportFailed(err: Error): void {
    if (!this.transportError) this.transportError = err;
    this.stdinStream = null;
    this.failAllPending(this.transportError);
  }

  private failTransport(err: Error): void {
    if (this.transportError) return;
    this.markTransportFailed(err);
    // Do not rely solely on a child exit: a wedged child can leave one pipe
    // broken indefinitely. Reporting once lets the supervisor advance its
    // generation immediately; killing releases the remaining resources.
    try { terminateChild(this.child); } catch { /* already gone */ }
    this.reportExit(null, "transport-error");
  }

  private reportExit(code: number | null, signal: string | null): void {
    if (this.exitReported) return;
    this.exitReported = true;
    this.handlers.onExit(code, signal);
  }

  private failAllPending(err: Error): void {
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (typeof method !== "string" || method.length === 0 || method.length > 512) {
      return Promise.reject(new Error("invalid app-server request method"));
    }
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
      this.writeFrame({ id, method, params: params ?? {} }, (err) => {
        const current = this.pending.get(id);
        if (current !== entry) return;
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(err);
      });
    });
  }

  notify(method: string, params?: unknown): void {
    this.writeFrame({ method, params: params ?? {} });
  }

  kill(): void {
    this.markTransportFailed(new Error("app-server connection closed"));
    try { terminateChild(this.child); } catch { /* supervisor still advances generation */ }
    this.child = null;
    this.reportExit(null, "killed");
  }
}

/** One-shot handshake required before any other call. */
export async function initialize(
  conn: Pick<AppServerConnection, "request" | "notify">,
  clientInfo: { name: string; title: string; version: string },
): Promise<void> {
  await conn.request("initialize", { clientInfo, capabilities: null } satisfies InitializeParams);
  conn.notify("initialized");
}
