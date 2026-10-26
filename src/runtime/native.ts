import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { DeliveryError, jsonBytes, LIMITS, type JsonValue } from './types.js';
import { APP_VERSION } from './metadata.js';
import { DiagnosticRedactor } from './redaction.js';
import { nativeCommand, type NativeLauncher } from './native-launch.js';
import { windowsJob } from './windows-job.js';

export interface NativeConfig { bin: string; home: string; cwd: string; env: NodeJS.ProcessEnv; dev?: boolean; isolatedGroup?: boolean; args?: string[]; requestTimeoutMs?: number; launcher?: NativeLauncher }
export interface NativeOptions { beforeWrite?: () => void; timeoutMs?: number; onWritten?: () => void }
interface Pending { id: number; frame: Buffer | null; bytes: number; sent: boolean; flushed: boolean; resolved: boolean; timer: NodeJS.Timeout | null; options: NativeOptions; resolve: (value: JsonValue) => void; reject: (error: Error) => void }

/** One process, one protocol epoch. A failed process is never restarted in place. */
export class NativeRpc extends EventEmitter {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private queue: Pending[] = [];
  private nextId = 1;
  private retained = 0;
  private input = Buffer.alloc(0);
  private writing = false;
  private ready = false;
  private failed = false;
  private exited = false;
  private exitCode: number | null = null;
  private closePromise?: Promise<void>;
  private exitPromise: Promise<void>;
  private windowsSignal?: () => Promise<void>;
  private redactor: DiagnosticRedactor;
  constructor(readonly config: NativeConfig) {
    super();
    this.redactor = new DiagnosticRedactor(config.env);
    let command = nativeCommand({ ...config, env: { ...config.env, CODEX_HOME: config.home } }, 'app-server');
    if (process.platform === 'win32' && !config.launcher && (config.dev || config.isolatedGroup)) {
      const job = windowsJob(command); command = job.command; this.windowsSignal = job.signal;
    }
    // Exactly three descriptors: control sockets and any parent service descriptors never enter the native UID.
    this.child = spawn(command.bin, command.args, { cwd: command.cwd, env: command.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: !config.launcher && (config.dev === true || config.isolatedGroup === true) && process.platform !== 'win32' });
    this.child.once('exit', code => { this.exitCode = code; this.fail(new Error('Native process exited')); });
    this.exitPromise = new Promise(resolve => {
      this.child.once('close', () => { this.exited = true; this.fail(new Error('Native process exited')); this.pending.clear(); this.queue = []; this.retained = 0; this.input = Buffer.alloc(0); resolve(); });
    });
    this.child.on('error', error => this.fail(error));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    // Deliberately do not retain or relay stderr: upstream can include credentials or prompt text.
    this.child.stderr.on('data', () => {});
  }
  async initialize(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'codex_harness', title: 'Codex Harness', version: APP_VERSION }, capabilities: { experimentalApi: true, requestAttestation: false, explicitGatewayOauth: true } }, {}, true);
    await this.writeMessage({ method: 'initialized' });
    if (this.failed) throw new DeliveryError('runtime_unavailable', 'Native initialization failed');
    this.ready = true;
  }
  call(method: string, params: JsonValue, options: NativeOptions = {}): Promise<JsonValue> { return this.request(method, params, options, false); }
  get connected(): boolean { return this.ready && !this.failed; }
  get processId(): number | undefined { return this.child.pid; }
  get budget(): { pending: number; retainedBytes: number } { return { pending: this.pending.size, retainedBytes: this.retained }; }
  private request(method: string, params: JsonValue, options: NativeOptions, initializing: boolean): Promise<JsonValue> {
    if (this.failed || (!this.ready && !initializing)) return Promise.reject(new DeliveryError('runtime_unavailable', 'Native runtime is not ready'));
    let frame: Buffer;
    const id = this.nextId++;
    try { frame = Buffer.from(jsonBytes({ id, method, params }) + '\n'); } catch (error) { return Promise.reject(error); }
    if (this.pending.size >= LIMITS.pending || this.retained + frame.length > LIMITS.retainedBytes) return Promise.reject(new DeliveryError('capacity', 'Native request budget exhausted'));
    return new Promise((resolve, reject) => {
      const entry: Pending = { id, frame, bytes: frame.length, sent: false, flushed: false, resolved: false, timer: null, options, resolve, reject };
      this.pending.set(id, entry); this.retained += entry.bytes; this.queue.push(entry);
      const timeout = options.timeoutMs ?? this.config.requestTimeoutMs ?? 30000;
      if (timeout > 0) entry.timer = setTimeout(() => {
        if (entry.resolved) return;
        if (entry.sent) this.fail(new Error('Native request timed out after write'));
        else { entry.resolved = true; entry.flushed = true; this.queue = this.queue.filter(item => item !== entry); reject(new DeliveryError('timeout', 'Native request timed out before write')); this.release(entry); }
      }, timeout);
      this.pump();
    });
  }
  private pump(): void {
    if (this.writing || this.failed) return;
    const entry = this.queue.shift(); if (!entry) return;
    if (entry.resolved) { this.pump(); return; }
    try { entry.options.beforeWrite?.(); } catch (error) { entry.resolved = true; entry.flushed = true; entry.reject(new DeliveryError(error instanceof DeliveryError ? error.code : 'before_write', error instanceof Error ? error.message : 'Write rejected', 'not_sent', error instanceof DeliveryError ? error.data : undefined)); this.release(entry); this.pump(); return; }
    this.writing = true; entry.sent = true;
    try {
      this.child.stdin.write(entry.frame!, error => {
        entry.frame = null; entry.flushed = true; this.writing = false;
        if (error) this.fail(error);
        else { try { entry.options.onWritten?.(); } catch (failure) { this.fail(failure instanceof Error ? failure : new Error('Write callback failed')); } }
        this.release(entry); this.pump();
      });
    } catch (error) { this.writing = false; this.fail(error instanceof Error ? error : new Error('Native write failed')); }
  }
  private release(entry: Pending): void {
    if (!entry.resolved || !entry.flushed || !this.pending.delete(entry.id)) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.frame = null; this.retained -= entry.bytes;
  }
  async respond(id: string | number, result: JsonValue, beforeWrite?: () => void): Promise<void> { await this.writeMessage({ id, result }, beforeWrite); }
  async rejectRequest(id: string | number, code: number, message: string): Promise<void> { await this.writeMessage({ id, error: { code, message } }); }
  private writeMessage(value: JsonValue, beforeWrite?: () => void): Promise<void> {
    if (this.failed) return Promise.reject(new DeliveryError('runtime_unavailable', 'Native runtime is unavailable'));
    let frame: Buffer; try { frame = Buffer.from(jsonBytes(value) + '\n'); } catch (error) { return Promise.reject(error); }
    if (this.retained + frame.length > LIMITS.retainedBytes || this.pending.size >= LIMITS.pending) return Promise.reject(new DeliveryError('capacity', 'Native write budget exhausted'));
    // Responses share the same bounded writer, but do not wait for another response.
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const entry: Pending = { id, frame, bytes: frame.length, sent: false, flushed: false, resolved: false, timer: null, options: { ...(beforeWrite ? { beforeWrite } : {}), onWritten: () => { entry.resolved = true; resolve(); } }, resolve: () => resolve(), reject };
      this.pending.set(id, entry); this.retained += entry.bytes; this.queue.push(entry);
      entry.timer = setTimeout(() => { if (entry.sent) this.fail(new Error('Native response write timed out')); else { entry.resolved = true; entry.flushed = true; this.queue = this.queue.filter(item => item !== entry); reject(new DeliveryError('timeout', 'Response timed out before write')); this.release(entry); } }, 15000);
      this.pump();
    });
  }
  private receive(chunk: Buffer): void {
    if (this.failed) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset); const end = newline < 0 ? chunk.length : newline;
      const piece = chunk.subarray(offset, end);
      if (this.input.length + piece.length > LIMITS.frameBytes) { this.fail(new Error('Native frame exceeds byte budget')); return; }
      this.input = Buffer.concat([this.input, piece]);
      if (newline < 0) return;
      const line = this.input; this.input = Buffer.alloc(0); offset = newline + 1;
      if (!line.length) continue;
      try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(line);
        const message = JSON.parse(decoded) as Record<string, unknown>;
        jsonBytes(message);
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid native frame');
        if (typeof message.method === 'string') {
          if (typeof message.id === 'string' || typeof message.id === 'number') this.emit('request', message);
          else this.emit('notification', message);
          continue;
        }
        if (typeof message.id !== 'number') continue;
        const entry = this.pending.get(message.id); if (!entry || entry.resolved) continue;
        if ('error' in message) {
          const nativeError = message.error as Record<string, unknown>;
          if ('result' in message || !nativeError || typeof nativeError !== 'object' || Array.isArray(nativeError) || typeof nativeError.code !== 'number' || !Number.isSafeInteger(nativeError.code) || typeof nativeError.message !== 'string') throw new Error('Invalid native error response');
          entry.resolved = true;
          // Native rejection is definitive: the operation was not accepted.
          entry.reject(new DeliveryError('native_error', this.redactor.text(nativeError.message), 'not_sent', this.redactor.value(message.error as JsonValue)));
        } else if ('result' in message) { entry.resolved = true; entry.resolve(message.result as JsonValue); }
        else throw new Error('Invalid native response');
        this.release(entry);
      } catch (error) { this.fail(error instanceof Error ? error : new Error('Invalid native frame')); return; }
    }
  }
  private fail(error: Error): void {
    if (this.failed) return; this.failed = true; this.ready = false;
    for (const entry of this.pending.values()) { if (entry.timer) clearTimeout(entry.timer); if (!entry.resolved) { entry.resolved = true; entry.reject(new DeliveryError('runtime_lost', error.message, entry.sent ? 'unknown' : 'not_sent')); } if (!entry.sent) { entry.flushed = true; this.release(entry); } }
    this.queue = []; this.emit('fatal', error); void this.close().catch(() => this.emit('cleanup-unknown'));
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = Promise.resolve().then(() => this.stop()); return this.closePromise;
  }
  private async stop(): Promise<void> {
    this.fail(new Error('Native runtime closed'));
    if (this.windowsSignal) {
      let timeout: NodeJS.Timeout | undefined;
      try {
        if (!this.exited && this.exitCode === null) {
          // Stop is independent of stdin: a blocked native reader cannot delay
          // the job controller. Natural exit may close the event first.
          try { await this.windowsSignal(); } catch (error) { if (!this.exited || this.exitCode !== 0) throw error; }
        }
        await Promise.race([this.exitPromise, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Windows native cleanup was not confirmed')), 6000); })]);
        if (this.exitCode !== 0) throw new Error('Windows native launcher exited without confirming cleanup');
      } catch (error) {
        // Closing the sole job-owning process handle kills every remaining job
        // member even if its controller failed. Do not call that an acknowledgement.
        this.child.kill(); throw error;
      } finally { if (timeout) clearTimeout(timeout); }
      return;
    }
    if (this.config.launcher) {
      // The root-owned launcher supervises the different-UID process tree. A zero exit is its cleanup acknowledgement.
      // fail() has classified written work as unknown and queued work as
      // not_sent. Close now: end() waits for buffered writes and cannot signal
      // EOF when both the supervisor and native stdin are backpressured.
      this.child.stdin.destroy(); let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([this.exitPromise, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Native launcher cleanup was not confirmed')), 6000); })]);
        if (this.exitCode !== 0) throw new Error('Native launcher exited without confirming cleanup');
      } finally { if (timeout) clearTimeout(timeout); }
      return;
    }
    const pid = this.child.pid;
    const isolated = this.config.dev || this.config.isolatedGroup;
    if (this.exited && !isolated) return;
    const kill = (signal: NodeJS.Signals): void => {
      try { if (pid && isolated && process.platform !== 'win32') process.kill(-pid, signal); else this.child.kill(signal); } catch {}
    };
    kill('SIGTERM');
    const force = setTimeout(() => {
      kill('SIGKILL');
    }, 1500);
    try {
      await this.exitPromise;
      if (pid && isolated && process.platform !== 'win32') {
        try { process.kill(-pid, 0); process.kill(-pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        for (let attempt = 0; attempt < 20; attempt++) {
          try { process.kill(-pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error; }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('Native process group termination was not confirmed');
      }
    } finally { clearTimeout(force); }
  }
}
