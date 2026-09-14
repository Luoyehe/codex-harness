import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
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
  /** Early loss of a live transport, before descendant cleanup can complete.
   * Managed workers use this to hand cleanup to their privileged owner. */
  onTransportLost?(error: Error): void;
  /** A trusted cleanup owner died without confirming its subtree was reaped.
   * This is deliberately NOT onExit: a replacement must not be started. */
  onCleanupUnconfirmed?(error: Error): void;
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  /** Timeout handle so a late response can be ignored after rejection. */
  timer?: ReturnType<typeof setTimeout>;
}

/** How long to wait for an app-server response before giving up (per call). */
const REQUEST_TIMEOUT_MS = 120_000;
export const RPC_LIMITS = { frameBytes: 36 * 1024 * 1024, queuedBytes: 48 * 1024 * 1024, pending: 64, controlReserve: 8, serverRequests: 32 } as const;
const CONTROL_METHODS = new Set(["turn/interrupt", "command/exec/terminate", "command/exec/resize"]);
const TERMINATE_GRACE_MS = 2_000;

/** A worker must never inherit control-plane credentials from the gateway.
 * Managed installations also enforce a separate OS identity; this scrub is
 * defense in depth, not a substitute for that filesystem/process boundary. */
export function appServerEnvironment(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides };
  for (const key of Object.keys(env)) {
    if (/^(GATEWAY_|EDGE_|AUTH_|AUTHELIA_|SUDO_)/i.test(key) || /^CODEX_HARNESS_MANAGED_WORKER$/i.test(key)) delete env[key];
  }
  return env;
}

/**
 * Methods whose response legitimately arrives long after the request (e.g.
 * command/exec resolves at process exit for interactive shells). These are
 * exempt from the client-side timeout — killing them would falsely mark a
 * live PTY as exited.
 */
const NO_TIMEOUT_METHODS = new Set(["command/exec"]);

/** The upstream explicitly rejected the request. Transport failures/timeouts
 * are deliberately different: their acceptance outcome is unknown. */
export class AppServerRequestError extends Error {
  constructor(message: string, readonly rpcError?: { code?: number | string; data?: unknown }) { super(message); }
}

/** Windows batch shims give us cmd.exe's PID. Killing only that wrapper
 * relies on every descendant voluntarily handling stdin EOF. taskkill /T
 * explicitly closes the owned process tree, including wedged descendants. */
function terminateChild(child: ChildProcess | null, force = false): void {
  if (!child) return;
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); }
    catch (error: any) { if (error?.code !== "ESRCH") throw error; }
    return;
  }
  if (!child.pid) return;
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

async function groupHasLiveMembers(pid: number): Promise<boolean> {
  try { process.kill(-pid, 0); } catch (error: any) { if (error?.code === "ESRCH") return false; }
  if (process.platform !== "linux") return true;
  // Orphan zombies cannot execute and may remain until PID1 reaps them. Do
  // not mistake them for running workers, but fail closed on unreadable state.
  const names = await readdir("/proc");
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let stat;
    try { stat = await readFile(`/proc/${name}/stat`, "utf8"); }
    catch (error: any) { if (error?.code === "ENOENT" || error?.code === "ESRCH") continue; throw error; }
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (Number(fields[2]) === pid && fields[0] !== "Z" && fields[0] !== "X") return true;
  }
  return false;
}

interface ProcessIdentity { pid: number; start: string; }
async function processIdentity(pid: number): Promise<{ identity: ProcessIdentity; parent: number; live: boolean } | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { identity: { pid, start: fields[19] }, parent: Number(fields[1]), live: fields[0] !== "Z" && fields[0] !== "X" };
  } catch (error: any) { if (error?.code === "ENOENT" || error?.code === "ESRCH") return null; throw error; }
}

async function descendantsOf(pid: number): Promise<ProcessIdentity[]> {
  const rows = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const row = await processIdentity(Number(name));
    if (row) rows.push(row);
  }
  const descendants = new Set([pid]);
  for (;;) {
    const previous = descendants.size;
    for (const row of rows) if (descendants.has(row.parent)) descendants.add(row.identity.pid);
    if (descendants.size === previous) break;
  }
  return rows.filter((row) => row.identity.pid !== pid && descendants.has(row.identity.pid)).map((row) => row.identity);
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
  private closingInput: Writable | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingEntry>();
  private transportError: Error | null = null;
  private exitReported = false;
  private attached = false;
  private activeServerRequests = 0;
  private writeBlocked = false;
  private queuedBytes = 0;
  private writeQueue: Array<{ encoded: string; bytes: number; control: boolean; id?: number; onError?: (err: Error) => void }> = [];
  private terminationTimer: ReturnType<typeof setTimeout> | null = null;
  private terminating = false;
  private exitCompleting = false;
  private terminationSetup: Promise<void> | null = null;
  private descendantIdentities: ProcessIdentity[] = [];
  private exitResolve!: () => void;
  private exitReject!: (error: Error) => void;
  private readonly exitPromise = new Promise<void>((resolve, reject) => { this.exitResolve = resolve; this.exitReject = reject; });
  private intentionalClose = false;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly env: Record<string, string>,
    private readonly handlers: AppServerHandlers,
    private readonly options: { terminateGraceMs?: number; requestTimeoutMs?: number; cleanExitCode?: number } = {},
  ) {
    // An unexpected owner exit can precede an explicit kill() waiter.
    void this.exitPromise.catch(() => {});
    if (options.cleanExitCode !== undefined && (!Number.isInteger(options.cleanExitCode) || options.cleanExitCode < 0 || options.cleanExitCode > 255)) {
      throw new Error("cleanExitCode must be an integer exit status");
    }
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0 || this.requestTimeoutMs > 2_147_483_647) {
      throw new Error("app-server requestTimeoutMs must be a positive bounded integer");
    }
  }

  spawn(): void {
    if (this.attached || this.child || this.exitReported) {
      throw new Error("app-server connection has already been started");
    }
    let child: ChildProcess;
    try {
      const env = appServerEnvironment(this.env);
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
        detached: process.platform !== "win32",
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
      if (!child.pid) this.reportExit(null, "spawn-error");
      else this.beginTermination();
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
    const decoder = new StringDecoder("utf8");
    let buffered = "";
    let bufferedBytes = 0;
    stdout.on("data", (chunk: Buffer | string) => {
      if (this.transportError) return;
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      let offset = 0;
      for (;;) {
        const newline = text.indexOf("\n", offset);
        const part = newline < 0 ? text.slice(offset) : text.slice(offset, newline);
        const partBytes = Buffer.byteLength(part);
        if (bufferedBytes + partBytes > RPC_LIMITS.frameBytes) {
          buffered = "";
          bufferedBytes = 0;
          this.failTransport(new Error("app-server frame exceeded byte limit"));
          return;
        }
        buffered += part;
        bufferedBytes += partBytes;
        if (newline < 0) break;
        this.handleLine(buffered);
        buffered = "";
        bufferedBytes = 0;
        if (this.transportError) return;
        offset = newline + 1;
      }
    });
    stdin.on("drain", () => { this.writeBlocked = false; this.flushWrites(); });
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
      this.handlers.onStderr("[gateway-rpc] ignored non-JSON stdout frame\n");
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
      if (this.activeServerRequests >= RPC_LIMITS.serverRequests) {
        this.writeFrame({ id: msg.id, error: { code: -32000, message: "gateway server-request concurrency limit reached" } });
        return;
      }
      this.activeServerRequests += 1;
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
        } finally {
          this.activeServerRequests -= 1;
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
        entry.reject(new AppServerRequestError(`${message} (${code})`, { code: error.code, data: error.data }));
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

  private writeFrame(frame: any, onError?: (err: Error) => void): void {
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
      onError?.(new AppServerRequestError(`failed to serialize app-server frame: ${err?.message ?? String(err)}`));
      return;
    }
    const bytes = Buffer.byteLength(encoded);
    if (bytes > RPC_LIMITS.frameBytes || this.queuedBytes + stream.writableLength + bytes > RPC_LIMITS.queuedBytes) {
      const failure = new AppServerRequestError("app-server outgoing queue/frame byte limit reached; request was not sent");
      if (onError) onError(failure);
      else this.failTransport(failure); // notifications/control replies cannot be silently lost
      return;
    }
    this.writeQueue.push({ encoded, bytes, control: !frame.method || CONTROL_METHODS.has(frame.method), id: frame.method ? frame.id : undefined, onError });
    this.queuedBytes += bytes;
    this.flushWrites();
  }

  private flushWrites(): void {
    const stream = this.stdinStream;
    if (this.transportError || this.writeBlocked || !stream) return;
    while (this.writeQueue.length && !this.writeBlocked && !this.transportError) {
      const controlIndex = this.writeQueue.findIndex((entry) => entry.control);
      const entry = this.writeQueue.splice(controlIndex < 0 ? 0 : controlIndex, 1)[0];
      this.queuedBytes -= entry.bytes;
      try {
        const ready = stream.write(entry.encoded, (err?: Error | null) => {
          if (!err) return;
          const failure = new Error(`app-server write failed: ${err.message}`);
          this.failTransport(failure);
          entry.onError?.(failure);
        });
        this.writeBlocked = !ready;
      } catch (err: any) {
        const failure = new Error(`app-server write failed: ${err?.message ?? String(err)}`);
        this.failTransport(failure);
        entry.onError?.(failure);
      }
    }
  }

  private markTransportFailed(err: Error): void {
    const firstFailure = !this.transportError;
    if (firstFailure) this.transportError = err;
    // Save input for EOF shutdown after the termination path captures child
    // identities. Closing first could orphan a detached PTY before capture.
    const stream = this.stdinStream;
    this.stdinStream = null;
    if (this.child && stream && !stream.destroyed) this.closingInput = stream;
    const queued = this.writeQueue.splice(0);
    this.queuedBytes = 0;
    for (const entry of queued) entry.onError?.(new AppServerRequestError("app-server transport closed before queued request was sent"));
    this.failAllPending(this.transportError!);
    if (firstFailure && !this.intentionalClose) this.handlers.onTransportLost?.(err);
  }

  private failTransport(err: Error): void {
    if (this.transportError) return;
    this.markTransportFailed(err);
    this.beginTermination();
  }

  private beginTermination(): void {
    if (this.terminating || this.exitReported || this.exitCompleting) return;
    this.terminating = true;
    if (!this.child?.pid) { this.closingInput?.destroy(); this.closingInput = null; this.reportExit(null, "transport-closed"); return; }
    const child = this.child;
    if (this.options.cleanExitCode !== undefined) {
      // The root-owned launcher observes EOF and reaps across UID/session
      // boundaries. Killing sudo/the launcher would destroy that authority.
      // Wait for its real, verified exit; no local timeout can prove cleanup.
      this.closingInput?.destroy();
      this.closingInput = null;
      return;
    }
    this.terminationSetup = (async () => {
      // PTY jobs can create their own process groups. Capture their identities
      // before asking the parent to exit, and never signal a reused PID.
      if (process.platform === "linux") {
        try { this.descendantIdentities = await descendantsOf(child.pid!); }
        catch { this.handlers.onStderr("[gateway-rpc] could not enumerate app-server descendants\n"); }
      }
      // This EOF is also the authenticated shutdown signal for a privileged
      // backend launcher; its supervisor owns cross-UID descendant cleanup.
      this.closingInput?.destroy();
      this.closingInput = null;
      try { terminateChild(child); } catch { /* escalate below */ }
      await this.signalDescendants("SIGTERM");
      this.terminationTimer = setTimeout(() => {
        try { terminateChild(child, true); } catch (error: any) {
          this.handlers.onStderr(`[gateway-rpc] could not terminate app-server process group: ${error?.code ?? "unknown"}\n`);
        }
        void this.signalDescendants("SIGKILL");
      }, this.options.terminateGraceMs ?? TERMINATE_GRACE_MS);
    })();
  }

  private async signalDescendants(signal: NodeJS.Signals): Promise<void> {
    for (const identity of this.descendantIdentities) {
      try {
        const current = await processIdentity(identity.pid);
        if (current?.live && current.identity.start === identity.start) process.kill(identity.pid, signal);
      } catch { /* liveness check below fails closed when signalling is denied */ }
    }
  }

  private async descendantsAreLive(): Promise<boolean> {
    for (const identity of this.descendantIdentities) {
      const current = await processIdentity(identity.pid);
      if (current?.live && current.identity.start === identity.start) return true;
    }
    return false;
  }

  private reportExit(code: number | null, signal: string | null): void {
    if (this.exitReported || this.exitCompleting) return;
    this.exitCompleting = true;
    if (this.options.cleanExitCode !== undefined) {
      if (code === this.options.cleanExitCode && signal === null) this.finishExit(code, signal);
      else {
        const error = new Error(`worker cleanup was not confirmed (owner code=${code} signal=${signal}); restart the complete managed service before retrying`);
        this.exitReported = true;
        this.closingInput?.destroy();
        this.closingInput = null;
        this.exitReject(error);
        this.handlers.onStderr(`[gateway-rpc] ${error.message}\n`);
        this.handlers.onCleanupUnconfirmed?.(error);
      }
      return;
    }
    if (process.platform !== "win32" && this.child?.pid) {
      const child = this.child;
      void (async () => {
        await this.terminationSetup;
        try { terminateChild(child, true); } catch { /* check live state below */ }
        await this.signalDescendants("SIGKILL");
        // Do not report a synthetic exit or overlap a replacement while an
        // old descendant can still execute. An unexpected permission boundary
        // therefore fails closed instead of silently orphaning processes.
        let warned = false;
        let delay = 25;
        for (;;) {
          try { if (!await groupHasLiveMembers(child.pid!) && !await this.descendantsAreLive()) break; }
          catch { if (!warned) { this.handlers.onStderr("[gateway-rpc] cannot verify old process group termination; replacement paused\n"); warned = true; } }
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(delay * 2, 1000);
        }
        this.finishExit(code, signal);
      })();
      return;
    }
    this.finishExit(code, signal);
  }

  private finishExit(code: number | null, signal: string | null): void {
    this.exitReported = true;
    if (this.terminationTimer) clearTimeout(this.terminationTimer);
    this.terminationTimer = null;
    this.closingInput?.destroy();
    this.closingInput = null;
    this.exitResolve();
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
    const limit = RPC_LIMITS.pending + (CONTROL_METHODS.has(method) ? RPC_LIMITS.controlReserve : 0);
    if (this.pending.size >= limit) return Promise.reject(new AppServerRequestError("app-server pending request limit reached; request was not sent"));
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
              const queuedIndex = this.writeQueue.findIndex((entry) => entry.id === id);
              if (queuedIndex >= 0) {
                this.queuedBytes -= this.writeQueue.splice(queuedIndex, 1)[0].bytes;
                reject(new AppServerRequestError("app-server request expired in outgoing queue; request was not sent"));
              } else reject(new Error(`app-server request timed out after ${this.requestTimeoutMs / 1000}s: ${method}`));
            }, this.requestTimeoutMs),
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

  kill(): Promise<void> {
    this.intentionalClose = true;
    this.markTransportFailed(new Error("app-server connection closed"));
    this.beginTermination();
    return this.exitPromise;
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
