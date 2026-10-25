import { randomUUID } from 'node:crypto';
import { DeliveryError, integer, jsonBytes, object, onlyKeys, string, type CallContext, type JsonObject, type JsonValue } from './types.js';
import { validateOfficial } from './validation.js';
import { windowsProcessJob, type WindowsProcessJob } from './windows-process.js';
import { windowsPowerShellEnv } from './windows-job.js';
import { linuxProcessJob } from './linux-process.js';
import type { MetadataMutation } from './organization.js';
import type { NativeOptions } from './native.js';

interface Entry { processHandle: string; clientId: string; eventChannelId: string | undefined; cwd: string; tty: boolean; stdin: boolean; status: 'starting' | 'running' | 'exited'; revoked: boolean; dispatched: boolean; stdout: Buffer; stderr: Buffer; stdoutBytes: number; stderrBytes: number; stdoutCapReached: boolean; stderrCapReached: boolean; expiresAt: number; exitCode?: number; job?: WindowsProcessJob; timer?: NodeJS.Timeout; timedOut?: boolean; started: Promise<void>; startDone(): void; ended: Promise<void>; endDone(): void; stopping?: Promise<void> }
interface Host { native(method: string, params: JsonValue, options?: NativeOptions): Promise<JsonValue>; start(operation: MetadataMutation, context: CallContext): Promise<JsonValue>; cwd(value: JsonValue): string; available(): void; emit(data: JsonObject, channel?: string): void; changed(): void; failEpoch(): Promise<void> }
const owned = (entry: Entry, context: CallContext): boolean => entry.clientId === context.clientId && entry.eventChannelId === context.eventChannelId;
function base64(value: JsonValue | undefined, max: number): Buffer { const text = string(value, 'deltaBase64', Math.ceil(max / 3) * 4, true); if (text.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new DeliveryError('invalid_params', 'Invalid process byte encoding'); const bytes = Buffer.from(text, 'base64'); if (bytes.length > max || bytes.toString('base64') !== text) throw new DeliveryError('invalid_params', 'Invalid process byte encoding'); return bytes; }
const delay = (ms: number): Promise<void> => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref(); });

/** Browser-owned process handles never expose the shared native connection's handles. */
export class Processes {
  private entries = new Map<string, Entry>(); private reservedBytes = 0;
  constructor(private host: Host) {}
  get active(): number { return [...this.entries.values()].filter(entry => entry.status !== 'exited').length; }
  private remove(entry: Entry): void { if (!this.entries.delete(entry.processHandle)) return; clearTimeout(entry.timer); this.reservedBytes -= entry.stdout.length + entry.stderr.length; entry.job?.dispose(); }
  private collect(): void { for (const entry of this.entries.values()) if (entry.status === 'exited' && entry.expiresAt < Date.now()) this.remove(entry); }
  private owner(value: JsonValue | undefined, context: CallContext): Entry { const entry = this.entries.get(string(value, 'processHandle')); if (!entry || !owned(entry, context) || entry.revoked) throw new DeliveryError('not_found', 'Process is unavailable for this connection and runtime epoch'); return entry; }
  private summary(entry: Entry): JsonObject { return { processHandle: entry.processHandle, cwd: entry.cwd, tty: entry.tty, status: entry.status, timedOut: entry.timedOut === true, ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}), stdoutCapReached: entry.stdoutCapReached, stderrCapReached: entry.stderrCapReached }; }
  async call(method: string, params: JsonObject, context: CallContext): Promise<JsonValue> {
    this.collect();
    if (method === 'process/spawn') return this.spawn(params, context);
    if (method === 'process/list') { onlyKeys(params, []); return { data: [...this.entries.values()].filter(entry => owned(entry, context) && !entry.revoked).map(entry => this.summary(entry)) }; }
    const entry = this.owner(params.processHandle, context);
    if (method === 'process/read') { onlyKeys(params, ['processHandle']); return { ...this.summary(entry), stdoutBase64: entry.stdout.subarray(0, entry.stdoutBytes).toString('base64'), stderrBase64: entry.stderr.subarray(0, entry.stderrBytes).toString('base64') }; }
    if (method === 'process/remove') { onlyKeys(params, ['processHandle']); if (entry.status !== 'exited') throw new DeliveryError('process_running', 'Stop the process before removing its output'); context.beforeWrite?.(); this.remove(entry); return { removed: true }; }
    if (method === 'process/kill') { onlyKeys(params, ['processHandle']); context.beforeWrite?.(); await this.stop(entry); return { processHandle: entry.processHandle, stopped: true }; }
    if (entry.status !== 'running') throw new DeliveryError('process_not_running', 'Process is not ready for input');
    if (method === 'process/writeStdin') { onlyKeys(params, ['processHandle', 'deltaBase64', 'closeStdin']); if (!entry.stdin) throw new DeliveryError('stdin_closed', 'This process has no open input stream'); if (params.deltaBase64 != null) base64(params.deltaBase64, 64 * 1024); if (params.deltaBase64 == null && params.closeStdin !== true) throw new DeliveryError('invalid_params', 'Input requires bytes or closeStdin'); validateOfficial('ProcessWriteStdinParams', params); }
    else if (method === 'process/resizePty') { onlyKeys(params, ['processHandle', 'size']); if (!entry.tty) throw new DeliveryError('not_tty', 'This process does not have a terminal'); this.size(params.size); validateOfficial('ProcessResizePtyParams', params); }
    else throw new DeliveryError('method_not_found', 'Unsupported process workflow');
    this.host.available(); let accepted = false;
    try { const result = await this.host.native(method, params, { beforeWrite: () => { this.owner(entry.processHandle, context); this.host.available(); context.beforeWrite?.(); } }); accepted = true; validateOfficial(method === 'process/writeStdin' ? 'ProcessWriteStdinResponse' : 'ProcessResizePtyResponse', result); if (params.closeStdin === true) entry.stdin = false; return { processHandle: entry.processHandle }; }
    catch (error) { if (accepted || !(error instanceof DeliveryError) || error.delivery === 'unknown') { await this.host.failEpoch(); throw new DeliveryError('process_control_unknown', 'Process input/control could not be confirmed; runtime cleanup completed', 'unknown'); } throw error; }
  }
  private size(value: JsonValue | undefined): JsonObject { const size = object(value, 'size'); onlyKeys(size, ['rows', 'cols']); return { rows: integer(size.rows, 'rows', 1, 500), cols: integer(size.cols, 'cols', 1, 500) }; }
  private async spawn(params: JsonObject, context: CallContext): Promise<JsonValue> {
    this.host.available(); if (process.platform !== 'win32' && process.platform !== 'linux') throw new DeliveryError('unsupported_platform', 'Owned process execution requires Windows Jobs or Linux subreaping'); onlyKeys(params, ['cwd', 'command', 'tty', 'streamStdin', 'size', 'env', 'timeoutMs', 'outputBytesCap']); const cwd = this.host.cwd(params.cwd!);
    if (!Array.isArray(params.command) || !params.command.length || params.command.length > 128) throw new DeliveryError('invalid_params', 'Command requires a bounded argv list'); const command = params.command.map((arg, index) => string(arg, 'argument', 8192, index !== 0));
    for (const name of ['tty', 'streamStdin']) if (params[name] !== undefined && typeof params[name] !== 'boolean') throw new DeliveryError('invalid_params', 'Process stream flags must be boolean');
    const tty = params.tty === true, stdin = tty || params.streamStdin === true, cap = params.outputBytesCap === undefined ? 256 * 1024 : integer(params.outputBytesCap, 'outputBytesCap', 1024, 1024 * 1024); const timeoutMs = params.timeoutMs === undefined ? 3600000 : integer(params.timeoutMs, 'timeoutMs', 1, 86400000);
    const p: JsonObject = { command, cwd, tty, streamStdin: stdin, streamStdoutStderr: true, outputBytesCap: cap, timeoutMs: timeoutMs + 30000 }; if (params.size != null) { if (!tty) throw new DeliveryError('invalid_params', 'Terminal size requires tty'); p.size = this.size(params.size); }
    if (params.env != null) { const env = object(params.env, 'env'); if (Object.keys(env).length > 128) throw new DeliveryError('capacity', 'Too many environment overrides'); for (const [name, value] of Object.entries(env)) { if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || name.startsWith('HARNESS_WINDOWS_') || name.startsWith('HARNESS_LINUX_')) throw new DeliveryError('invalid_params', 'Invalid process environment name'); if (value !== null) string(value, 'environment value', 8192, true); } p.env = env; } jsonBytes(p, 256 * 1024);
    if (this.entries.size >= 64 || this.active >= 16 || [...this.entries.values()].filter(entry => owned(entry, context) && entry.status !== 'exited').length >= 4 || this.reservedBytes + 2 * cap > 32 * 1024 * 1024) throw new DeliveryError('capacity', 'Process or retained-output capacity exhausted');
    let startDone!: () => void, endDone!: () => void; const entry: Entry = { processHandle: randomUUID(), clientId: context.clientId, eventChannelId: context.eventChannelId, cwd, tty, stdin, status: 'starting', revoked: false, dispatched: false, stdout: Buffer.alloc(cap), stderr: Buffer.alloc(cap), stdoutBytes: 0, stderrBytes: 0, stdoutCapReached: false, stderrCapReached: false, expiresAt: Infinity, started: new Promise(resolve => { startDone = resolve; }), startDone: () => startDone(), ended: new Promise(resolve => { endDone = resolve; }), endDone: () => endDone() };
    this.entries.set(entry.processHandle, entry); this.reservedBytes += 2 * cap; this.host.changed();
    try {
      entry.job = await (process.platform === 'win32' ? windowsProcessJob(command, cwd) : linuxProcessJob(command, cwd)); p.command = entry.job.command;
      const env = { ...(p.env === undefined ? {} : object(p.env)), ...entry.job.env }; p.env = process.platform === 'win32' ? windowsPowerShellEnv(env) : env;
      p.processHandle = entry.processHandle; validateOfficial('ProcessSpawnParams', p);
      await this.host.start({ method: 'process/spawn', params: p, schema: 'ProcessSpawnParams', responseSchema: 'ProcessSpawnResponse', beforeWrite: () => { if (entry.revoked || this.entries.get(entry.processHandle) !== entry) throw new DeliveryError('client_disconnected', 'Process owner disconnected before start'); entry.dispatched = true; } }, context);
      if (entry.job) await entry.job.started; if (entry.status === 'starting') { entry.status = 'running'; entry.timer = setTimeout(() => { entry.timedOut = true; void this.stop(entry).catch(() => {}); }, timeoutMs); entry.timer.unref(); } entry.startDone(); this.host.changed(); return { processHandle: entry.processHandle, cwd, tty };
    } catch (error) {
      entry.startDone();
      if (error instanceof DeliveryError && error.delivery === 'not_sent') { this.remove(entry); entry.endDone(); this.host.changed(); }
      else { await this.host.failEpoch(); throw new DeliveryError('process_start_unknown', 'Process start could not be confirmed; the runtime was closed for cleanup', 'unknown'); }
      throw error;
    }
  }
  notification(method: string, params: JsonObject): boolean {
    if (method !== 'process/outputDelta' && method !== 'process/exited') return false;
    const entry = typeof params.processHandle === 'string' ? this.entries.get(params.processHandle) : undefined; if (!entry) return true;
    if (method === 'process/outputDelta') {
      validateOfficial('ProcessOutputDeltaNotification', params); const stream = params.stream === 'stdout' ? 'stdout' : 'stderr'; const bytes = base64(params.deltaBase64, 1024 * 1024); const used = stream === 'stdout' ? entry.stdoutBytes : entry.stderrBytes;
      if (used + bytes.length > entry[stream].length) throw new Error('Native process exceeded its bounded output cap'); bytes.copy(entry[stream], used); if (stream === 'stdout') { entry.stdoutBytes += bytes.length; entry.stdoutCapReached ||= params.capReached === true; } else { entry.stderrBytes += bytes.length; entry.stderrCapReached ||= params.capReached === true; }
      if (!entry.revoked) this.host.emit({ clientId: entry.clientId, processHandle: entry.processHandle, type: 'output', stream, deltaBase64: params.deltaBase64!, capReached: params.capReached! }, entry.eventChannelId);
    } else { validateOfficial('ProcessExitedNotification', params); if (params.stdout !== '' || params.stderr !== '') throw new Error('Native process duplicated streamed output'); void this.finished(entry, params).catch(async () => { try { await this.host.failEpoch(); } catch { /* Runtime.close retains cleanup failure. */ } }); }
    return true;
  }
  private async finished(entry: Entry, params: JsonObject): Promise<void> {
    const exitCode = entry.job ? await entry.job.exited : integer(params.exitCode, 'exitCode', -2147483648, 2147483647); if (entry.job && params.exitCode !== 0) throw new Error('Process controller exited without confirmed cleanup');
    if (this.entries.get(entry.processHandle) !== entry) return; clearTimeout(entry.timer); entry.exitCode = exitCode; entry.status = 'exited'; entry.expiresAt = Date.now() + 600000; entry.timer = setTimeout(() => this.remove(entry), 600000); entry.timer.unref(); entry.stdoutCapReached ||= params.stdoutCapReached === true; entry.stderrCapReached ||= params.stderrCapReached === true; entry.job?.dispose(); entry.endDone(); this.host.changed();
    if (!entry.revoked) this.host.emit({ ...this.summary(entry), clientId: entry.clientId, type: 'exit' }, entry.eventChannelId); else this.remove(entry);
  }
  private stop(entry: Entry): Promise<void> {
    if (entry.stopping) return entry.stopping;
    entry.stopping = Promise.resolve().then(async () => { await entry.started; if (entry.status === 'exited' || this.entries.get(entry.processHandle) !== entry) return;
      try {
        if (entry.job) await entry.job.signal(); else { const response = await this.host.native('process/kill', { processHandle: entry.processHandle }); validateOfficial('ProcessKillResponse', response); }
        await Promise.race([entry.ended, delay(6000).then(() => { throw new Error('Process exit acknowledgement timed out'); })]);
      } catch { await this.host.failEpoch(); }
    }); return entry.stopping;
  }
  async disconnect(clientId?: string, channel?: string): Promise<void> { const entries = [...this.entries.values()].filter(entry => (clientId === undefined || entry.clientId === clientId) && (channel === undefined || entry.eventChannelId === channel)); for (const entry of entries) entry.revoked = true; await Promise.all(entries.map(async entry => { await this.stop(entry); this.remove(entry); })); }
  reset(): void { for (const entry of this.entries.values()) { entry.revoked = true; clearTimeout(entry.timer); entry.startDone(); entry.endDone(); entry.job?.dispose(); } this.entries.clear(); this.reservedBytes = 0; }
}
