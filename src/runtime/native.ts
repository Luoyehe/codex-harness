import { MANUAL_MCP_DEFAULT_SECONDS, MANUAL_MCP_REPLY_GRACE_MS } from '../shared/mcp-timeouts.js';
import { NativeMediaEvent, type NativeHistoryShape } from './native-media-event.js';
import { QueueReplyIdentity } from './queue-reply-identity.js';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { DeliveryError, jsonBytes, LIMITS, type JsonValue } from './types.js';
import { APP_VERSION } from './metadata.js';
import { DiagnosticRedactor } from './redaction.js';
import { nativeCommand, type NativeLauncher } from './native-launch.js';
import { posixNative } from './posix-native.js';

export interface NativeConfig { bin: string; home: string; cwd: string; env: NodeJS.ProcessEnv; dev?: boolean; isolatedGroup?: boolean; args?: string[]; requestTimeoutMs?: number; launcher?: NativeLauncher; catalogProvider?: string }
export interface NativeOptions { classifyRejection?: (code: number, message: string) => string | undefined; historyWindowTail?: boolean; historyImageDisplayChars?: number; beforeWrite?: () => void; timeoutMs?: number; onWritten?: () => void }
interface Pending { historyShape?: NativeHistoryShape | undefined; frameKind?: 'history' | 'queue-read' | 'queue-write' | undefined; id: number; frame: Buffer | null; bytes: number; sent: boolean; flushed: boolean; resolved: boolean; timer: NodeJS.Timeout | null; options: NativeOptions; resolve: (value: JsonValue) => void; reject: (error: Error) => void }

/** One process, one protocol epoch. A failed process is never restarted in place. */
export class NativeRpc extends EventEmitter {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private queue: Pending[] = [];
  private nextId = 1;
  private retained = 0;
  private input = Buffer.alloc(0);
  private inputBytes = 0;
  private mediaEvent?: NativeMediaEvent;
  private historyReply?: { reader: NativeMediaEvent; entry: Pending };
  private discardingHistoryFrame = false;
  private queueReply?: { reader: QueueReplyIdentity; entry: Pending };
  private writing = false;
  private ready = false;
  private failed = false;
  private exited = false;
  private exitCode: number | null = null;
  private closePromise?: Promise<void>;
  private exitPromise: Promise<void>;
  private posixController = false;
  private redactor: DiagnosticRedactor;
  constructor(readonly config: NativeConfig) {
    super();
    this.redactor = new DiagnosticRedactor(config.env);
    let command = nativeCommand({ ...config, env: { ...config.env, CODEX_HOME: config.home } }, 'app-server');
    if (!config.launcher && (config.dev || config.isolatedGroup)) {
      command = posixNative(command); this.posixController = true;
    }
    // The local POSIX controller alone gets a separate stop pipe. Its native
    // child receives exactly three descriptors; service descriptors stay out.
    this.child = spawn(command.bin, command.args, { cwd: command.cwd, env: command.env, stdio: this.posixController ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    this.child.stdio[3]?.on('error', error => this.fail(error));
    this.child.once('exit', code => { this.exitCode = code; this.fail(new Error('Native process exited')); });
    this.exitPromise = new Promise(resolve => {
      this.child.once('close', () => { this.exited = true; this.fail(new Error('Native process exited')); this.pending.clear(); this.queue = []; this.retained = 0; this.input = Buffer.alloc(0); this.inputBytes = 0; resolve(); });
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
      const historyShape = method === 'thread/timeline/list' ? 'timeline' :
        ['thread/items/list', 'thread/items/read'].includes(method) ? 'items' :
        method === 'thread/read' && params && typeof params === 'object' && !Array.isArray(params) && params.includeTurns === true ? 'thread' : undefined;
      const entry: Pending = { historyShape, frameKind: method === 'thread/queue/list' ? 'queue-read' : ['thread/queue/add','thread/queue/update'].includes(method) ? 'queue-write' : historyShape ? 'history' : undefined, id, frame, bytes: frame.length, sent: false, flushed: false, resolved: false, timer: null, options, resolve, reject };
      this.pending.set(id, entry); this.retained += entry.bytes; this.queue.push(entry);
      const slowOperation = method === 'mcpServer/tool/call' || method === 'plugin/install';
      const fallback = method === 'mcpServer/tool/call' ? MANUAL_MCP_DEFAULT_SECONDS * 1000 + MANUAL_MCP_REPLY_GRACE_MS :
        method === 'plugin/install' ? 320_000 : (this.config.requestTimeoutMs ?? 30_000);
      const timeout = options.timeoutMs ?? fallback;
      if (timeout > 0) entry.timer = setTimeout(() => {
        if (entry.resolved) return;
        if (entry.sent && slowOperation) {
          entry.resolved = true;
          reject(new DeliveryError('timeout', '此操作已提交但结果尚未确认，请核对原回执。', 'unknown'));
          this.release(entry);
        } else if (entry.sent) this.fail(new Error('Native request timed out after write'));
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
  private finishOversizedQueue(entry: Pending, reader: QueueReplyIdentity): void {
    entry.resolved = true;
    entry.reject(new DeliveryError('queue_frame_unconfirmed', '原生待办回执超过传输容量。请核对原操作、会话内容和队列，勿重复提交。', 'unknown', reader.proof()));
    this.release(entry);
  }
  private finishHistoryReply(entry: Pending, reader: NativeMediaEvent): void {
    if (entry.resolved) return;
    const value = reader.historyReply(entry.id, entry.historyShape!);
    entry.resolved = true;
    if (value) entry.resolve(value);
    else entry.reject(new DeliveryError('history_frame_capacity', '单页历史超过传输容量，请缩小读取窗口。'));
    this.release(entry);
  }
  private finishMediaEvent(): boolean {
    const projection = this.mediaEvent?.projection();
    delete this.mediaEvent;
    if (!projection) { this.fail(new Error('Invalid oversized native notification')); return false; }
    this.emit('notification', projection); return true;
  }
  private receive(chunk: Buffer): void {
    if (this.failed) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset); const end = newline < 0 ? chunk.length : newline;
      const piece = chunk.subarray(offset, end);
      if (this.discardingHistoryFrame) {
        this.queueReply?.reader.update(piece);
        this.mediaEvent?.update(piece);
        this.historyReply?.reader.update(piece);
        if (newline < 0) return;
        if (this.queueReply) this.finishOversizedQueue(this.queueReply.entry, this.queueReply.reader);
        delete this.queueReply;
        if (this.historyReply) this.finishHistoryReply(this.historyReply.entry, this.historyReply.reader);
        delete this.historyReply;
        if (this.mediaEvent && !this.finishMediaEvent()) return;
        this.discardingHistoryFrame = false; offset = newline + 1; continue;
      }
      if (this.inputBytes + piece.length > LIMITS.frameBytes) {
        // This pinned server prefixes successful responses with their numeric ID.
        // Only positively identified reads and queue replies are drained. An oversized
        // mutation reply cannot prove its exact identity, so its outcome stays unknown.
        const prefix = (this.inputBytes ? this.input.subarray(0, Math.min(this.inputBytes, 128)) : piece.subarray(0, 128)).toString('ascii');
        const match = /^\{"id":([0-9]+),"result":/.exec(prefix);
        const entry = match ? this.pending.get(Number(match[1])) : undefined;
        if (!entry && NativeMediaEvent.matches(prefix)) {
          this.mediaEvent = new NativeMediaEvent();
          this.mediaEvent.update(this.input.subarray(0, this.inputBytes)); this.mediaEvent.update(piece);
          if (newline >= 0 && !this.finishMediaEvent()) return;
        } else if (!entry?.frameKind || !entry.sent || entry.resolved) {
          this.fail(new Error('Native frame exceeds byte budget')); return;
        } else if (entry.frameKind === 'history' && entry.options.historyImageDisplayChars) {
          const reader = new NativeMediaEvent();
          reader.update(this.input.subarray(0, this.inputBytes)); reader.update(piece);
          if (newline < 0) this.historyReply = { reader, entry };
          else this.finishHistoryReply(entry, reader);
        } else if (entry.frameKind === 'queue-write') {
          const reader = new QueueReplyIdentity(entry.id);
          reader.update(this.input.subarray(0, this.inputBytes)); reader.update(piece);
          if (newline < 0) this.queueReply = { reader, entry };
          else this.finishOversizedQueue(entry, reader);
        } else {
          entry.resolved = true;
          entry.reject(entry.frameKind === 'queue-read' ? new DeliveryError('queue_frame_capacity', '原生队列页超过传输容量，正在核对已保存的队列摘要。')
            : new DeliveryError('history_frame_capacity', '单页历史超过传输容量，请缩小读取窗口。'));
          this.release(entry);
        }
        this.input = Buffer.alloc(0); this.inputBytes = 0;
        if (newline < 0) { this.discardingHistoryFrame = true; return; }
        offset = newline + 1; continue;
      }
      if (this.inputBytes + piece.length > this.input.length) {
        const next = Buffer.allocUnsafe(Math.min(LIMITS.frameBytes, Math.max(this.inputBytes + piece.length, this.input.length * 2, 8192)));
        this.input.copy(next, 0, 0, this.inputBytes); this.input = next;
      }
      piece.copy(this.input, this.inputBytes); this.inputBytes += piece.length;
      if (newline < 0) return;
      const line = this.input.subarray(0, this.inputBytes); this.input = Buffer.alloc(0); this.inputBytes = 0; offset = newline + 1;
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
          const code = entry.options.classifyRejection?.(nativeError.code, nativeError.message) ?? 'native_error';
          entry.reject(new DeliveryError(code, this.redactor.text(nativeError.message), 'not_sent', this.redactor.value(message.error as JsonValue)));
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
    if (this.posixController) {
      // The bound controller handles stop independently of native stdin and
      // keeps its own child identities until descendant cleanup is confirmed.
      const control = this.child.stdio[3];
      if (control && 'destroy' in control) control.destroy();
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([this.exitPromise, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('POSIX native cleanup was not confirmed')), 6000); })]);
        if (this.exitCode !== 0) throw new Error('POSIX native controller exited without confirming cleanup');
      } finally { if (timeout) clearTimeout(timeout); }
      return;
    }
    if (this.exited) return;
    this.child.kill('SIGTERM');
    const force = setTimeout(() => this.child.kill('SIGKILL'), 1500);
    try { await this.exitPromise; } finally { clearTimeout(force); }
  }
}
