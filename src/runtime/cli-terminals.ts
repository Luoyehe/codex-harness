import { randomUUID } from 'node:crypto';
import { Processes } from './processes.js';
import { DeliveryError, integer, object, onlyKeys, string, type CallContext, type JsonObject, type JsonValue } from './types.js';
import type { NativeOptions } from './native.js';
import type { MetadataMutation } from './organization.js';
interface Entry { terminalId: string; clientId: string; channel: string | undefined; processHandle?: string; revoked: boolean; dispatched: boolean }
interface Host { bin: string; native(method: string, params: JsonValue, options?: NativeOptions): Promise<JsonValue>; start(operation: MetadataMutation, context: CallContext): Promise<JsonValue>; available(): void; cwd(value: JsonValue): string; emit(data: JsonObject, channel?: string): void; changed(): void; settled(): void; failEpoch(): Promise<void> }
/** A fixed native CLI gets its own process-tree controller and a global maintenance lease. */
export class CliTerminals {
  private entries = new Map<string, Entry>(); private processes: Processes;
  constructor(private host: Host) {
    this.processes = new Processes({ ...host, start: (operation, context) => {
      const entry = [...this.entries.values()][0]; if (!entry || entry.revoked) throw new DeliveryError('client_disconnected', 'CLI terminal owner disconnected');
      entry.processHandle = string(operation.params.processHandle, 'processHandle'); const before = operation.beforeWrite;
      return host.start({ ...operation, idle: true, beforeWrite: () => { if (entry.revoked) throw new DeliveryError('client_disconnected', 'CLI terminal owner disconnected'); before?.(); entry.dispatched = true; } }, context);
    }, emit: (data, channel) => {
      const entry = [...this.entries.values()].find(item => item.processHandle === data.processHandle); if (!entry) return;
      if (!entry.revoked) { const { processHandle: _process, ...publicData } = data; host.emit({ ...publicData, terminalId: entry.terminalId }, channel); }
      if (data.type === 'exit') this.finish(entry);
    } });
  }
  get active() { return this.entries.size; }
  has(terminalId: JsonValue | undefined) { return typeof terminalId === 'string' && this.entries.has(terminalId); }
  private finish(entry: Entry) { if (!this.entries.delete(entry.terminalId)) return; if (entry.dispatched) this.host.settled(); this.host.changed(); }
  async open(params: JsonObject, context: CallContext): Promise<JsonValue> {
    onlyKeys(params, ['cwd', 'projectId', 'program', 'rows', 'cols']); if (params.program !== 'codex' && params.program !== 'codex-cloud') throw new DeliveryError('invalid_params', 'Fixed native CLI selection required');
    this.host.available(); if (this.active) throw new DeliveryError('native_cli_busy', 'A native CLI terminal is already open');
    const cwd = this.host.cwd(params.cwd!), size = { rows: integer(params.rows ?? 24, 'rows', 1, 500), cols: integer(params.cols ?? 80, 'cols', 1, 500) };
    const entry: Entry = { terminalId: randomUUID(), clientId: context.clientId, channel: context.eventChannelId, revoked: false, dispatched: false }; this.entries.set(entry.terminalId, entry); this.host.changed();
    try {
      await this.processes.call('process/spawn', { cwd, command: params.program === 'codex-cloud' ? [this.host.bin, 'cloud'] : [this.host.bin, '--no-alt-screen'], env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' }, tty: true, streamStdin: true, size, timeoutMs: 3600000, outputBytesCap: 1024 * 1024 }, context);
      return { terminalId: entry.terminalId };
    } catch (error) { if (error instanceof DeliveryError && error.delivery === 'not_sent') { entry.dispatched = false; this.finish(entry); } throw error; }
  }
  async call(method: string, params: JsonObject, context: CallContext): Promise<JsonValue> {
    const entry = this.entries.get(string(params.terminalId, 'terminalId')); if (!entry || entry.revoked || entry.clientId !== context.clientId || entry.channel !== context.eventChannelId || !entry.processHandle) throw new DeliveryError('not_found', 'CLI terminal is unavailable for this connection');
    const processHandle = entry.processHandle;
    if (method === 'terminal/close') { onlyKeys(params, ['terminalId']); await this.processes.call('process/kill', { processHandle }, context); this.finish(entry); return {}; }
    if (method === 'terminal/resize') { onlyKeys(params, ['terminalId', 'rows', 'cols']); await this.processes.call('process/resizePty', { processHandle, size: { rows: integer(params.rows, 'rows', 1, 500), cols: integer(params.cols, 'cols', 1, 500) } }, context); return {}; }
    onlyKeys(params, ['terminalId', 'text', 'deltaBase64', 'closeStdin']); if (params.text !== undefined && params.deltaBase64 !== undefined) throw new DeliveryError('invalid_params', 'Use text or base64');
    const deltaBase64 = params.text === undefined ? params.deltaBase64 : Buffer.from(string(params.text, 'text', 65536, true)).toString('base64');
    await this.processes.call('process/writeStdin', { processHandle, ...(deltaBase64 !== undefined ? { deltaBase64 } : {}), ...(params.closeStdin !== undefined ? { closeStdin: params.closeStdin } : {}) }, context); return {};
  }
  notification(method: string, params: JsonObject) { return [...this.entries.values()].some(entry => entry.processHandle === params.processHandle) && this.processes.notification(method, params); }
  async disconnect(clientId?: string, channel?: string) {
    const owned = [...this.entries.values()].filter(entry => (clientId === undefined || entry.clientId === clientId) && (channel === undefined || entry.channel === channel)); owned.forEach(entry => { entry.revoked = true; });
    await this.processes.disconnect(clientId, channel); for (const entry of owned) this.finish(entry);
  }
  reset() { this.entries.clear(); this.processes.reset(); }
}
