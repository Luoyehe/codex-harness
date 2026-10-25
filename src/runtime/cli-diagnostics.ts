import { randomUUID } from 'node:crypto';
import { Processes } from './processes.js';
import { DiagnosticRedactor } from './redaction.js';
import { validateOfficial } from './validation.js';
import { DeliveryError, jsonBytes, object, onlyKeys, string, type CallContext, type JsonObject, type JsonValue } from './types.js';
import type { NativeOptions } from './native.js';
type Write = (method: string, params: JsonValue, options?: NativeOptions) => Promise<JsonValue>;
interface Host { bin: string; cwd: string; native: Write; redactor: DiagnosticRedactor; configure(operation: (write: Write) => Promise<JsonValue>, context: CallContext): Promise<JsonValue>; available(): void; failEpoch(): Promise<void> }
interface Entry { resultId: string; kind: 'doctor' | 'models-bundled'; owner: CallContext; revoked: boolean; result?: JsonObject; process?: Processes; processHandle?: string; reject(error: Error): void; timer?: NodeJS.Timeout }
export const cliDiagnosticMethods = new Set(['diagnostics/cli/run', 'diagnostics/cli/result/read']);
/** Fixed read-only CLI diagnostics use the same independently owned process tree as terminals. */
export class CliDiagnostics {
  private entries = new Map<string, Entry>(); private closed = false;
  constructor(private host: Host) {}
  private public(entry: Entry): JsonObject { return { resultId: entry.resultId, kind: entry.kind, status: entry.result?.status ?? 'running' }; }
  async call(method: string, params: JsonObject, context: CallContext): Promise<JsonValue> {
    if (method === 'diagnostics/cli/result/read') {
      onlyKeys(params, ['resultId']); const entry = this.entries.get(string(params.resultId, 'resultId', 36));
      if (!entry || entry.revoked || entry.owner.clientId !== context.clientId || entry.owner.eventChannelId !== context.eventChannelId) throw new DeliveryError('not_found', 'Diagnostic result expired or belongs to another connection');
      return { ...this.public(entry), ...(entry.result ?? {}) };
    }
    onlyKeys(params, ['kind']); if (params.kind !== 'doctor' && params.kind !== 'models-bundled') throw new DeliveryError('invalid_params', 'Choose doctor or models-bundled');
    if (this.closed) throw new DeliveryError('runtime_unavailable', 'Runtime is closing');
    if (this.entries.size >= 8) { const expired = [...this.entries.values()].find(entry => entry.result); if (!expired) throw new DeliveryError('capacity', 'Diagnostic result capacity exhausted'); this.remove(expired); }
    let done!: () => void, reject!: (error: Error) => void; const ended = new Promise<void>((resolve, fail) => { done = resolve; reject = fail; }); void ended.catch(() => {});
    const entry: Entry = { resultId: randomUUID(), kind: params.kind, owner: { ...context }, revoked: false, reject }; this.entries.set(entry.resultId, entry);
    try {
      return await this.host.configure(async write => {
        const available = (): void => { if (entry.revoked || this.closed) throw new DeliveryError('client_disconnected', 'Diagnostic owner disconnected'); this.host.available(); };
        available();
        const processes = new Processes({ native: this.host.native, cwd: value => { if (value !== this.host.cwd) throw new DeliveryError('invalid_params', 'Diagnostic working directory is fixed'); return this.host.cwd; }, available, changed: () => {},
          start: async operation => { entry.processHandle = string(operation.params.processHandle, 'processHandle'); validateOfficial(operation.schema, operation.params); const value = await write(operation.method, operation.params, { beforeWrite: () => { available(); operation.beforeWrite?.(); } }); validateOfficial(operation.responseSchema, value); return value; },
          emit: data => { if (data.type === 'exit') done(); }, failEpoch: async () => { reject(new DeliveryError('diagnostics_cleanup_unknown', 'Diagnostic cleanup was not confirmed; runtime recovery is required', 'unknown')); await this.host.failEpoch(); },
        }); entry.process = processes;
        const command = entry.kind === 'doctor' ? [this.host.bin, 'doctor', '--json'] : [this.host.bin, 'debug', 'models', '--bundled'];
        await processes.call('process/spawn', { cwd: this.host.cwd, command, timeoutMs: 20000, outputBytesCap: 1024 * 1024 }, context); await ended;
        if (entry.revoked) throw new DeliveryError('client_disconnected', 'Diagnostic owner disconnected', 'unknown');
        const result = object(await processes.call('process/read', { processHandle: entry.processHandle! }, context));
        const stdout = Buffer.from(string(result.stdoutBase64, 'diagnostic output', 1500000, true), 'base64'), stderr = Buffer.from(string(result.stderrBase64, 'diagnostic error', 1500000, true), 'base64');
        let report: JsonObject;
        try {
          if (result.timedOut || result.stdoutCapReached || result.stderrCapReached || stderr.length > 65536) throw new Error('Output or execution budget exceeded');
          report = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stdout))); jsonBytes(report, 1024 * 1024);
          if (entry.kind === 'doctor') { if (report.schemaVersion !== 1 || typeof report.generatedAt !== 'string' || typeof report.codexVersion !== 'string' || !['ok', 'warn', 'warning', 'fail'].includes(String(report.overallStatus))) throw new Error('Unsupported doctor report'); object(report.checks); }
          else if (result.exitCode !== 0 || !Array.isArray(report.models)) throw new Error('Invalid bundled model catalog');
          entry.result = { status: 'completed', exitCode: result.exitCode!, data: this.host.redactor.value(report), ...(stderr.length ? { stderr: this.host.redactor.text(new TextDecoder('utf-8', { fatal: true }).decode(stderr)) } : {}) };
          jsonBytes(entry.result, 1024 * 1024);
        } catch {
          const timedOut = result.timedOut === true, stdoutCapReached = result.stdoutCapReached === true, stderrCapReached = result.stderrCapReached === true;
          entry.result = { status: 'failed', exitCode: result.exitCode!, reason: timedOut ? 'timed_out' : stdoutCapReached || stderrCapReached || stderr.length > 65536 ? 'output_truncated' : 'invalid_report', timedOut, stdoutCapReached, stderrCapReached, error: 'Diagnostic command ended without a complete supported report' };
        }
        await processes.call('process/remove', { processHandle: entry.processHandle! }, context); delete entry.process;
        entry.timer = setTimeout(() => this.remove(entry), 600000); entry.timer.unref(); return this.public(entry);
      }, context);
    } catch (error) { this.remove(entry); throw error; }
  }
  notification(method: string, params: JsonObject): boolean {
    const entry = [...this.entries.values()].find(entry => entry.processHandle === params.processHandle);
    return !!entry?.process && entry.process.notification(method, params);
  }
  private remove(entry: Entry): void { if (!this.entries.delete(entry.resultId)) return; clearTimeout(entry.timer); entry.process?.reset(); }
  async disconnect(clientId?: string, channel?: string): Promise<void> {
    const owned = [...this.entries.values()].filter(entry => (clientId === undefined || entry.owner.clientId === clientId) && (channel === undefined || entry.owner.eventChannelId === channel));
    owned.forEach(entry => { entry.revoked = true; });
    await Promise.all(owned.map(async entry => { await entry.process?.disconnect(clientId, channel); entry.reject(new DeliveryError('client_disconnected', 'Diagnostic connection closed after process cleanup', 'unknown')); this.remove(entry); }));
  }
  reset(): void { this.closed = true; for (const entry of this.entries.values()) { entry.revoked = true; entry.reject(new DeliveryError('runtime_unavailable', 'Runtime closed during diagnostic work', 'unknown')); this.remove(entry); } }
}
