import { expect, test } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { RuntimeService } from '../../src/runtime/service.js';
import type { NativeOptions, NativeRpc } from '../../src/runtime/native.js';
import { DeliveryError, object, type JsonValue, type RuntimeEvent } from '../../src/runtime/types.js';

function home(): string { const parent = path.resolve('.work/terminal-cleanup'); mkdirSync(parent, { recursive: true }); return mkdtempSync(path.join(parent, 'run-')); }

test('native capacity during gateway loss closes the whole process instead of orphaning terminal sessions', async () => {
  const root = home();
  const service = await RuntimeService.create({ bin: process.execPath, args: [path.resolve('tests/runtime/terminal-cleanup-fixture.mjs')], home: root, workerHome: root, cwd: root, env: {}, requestTimeoutMs: 2000 });
  const pid = service.native.processId!; const events: RuntimeEvent[] = []; let fatalObserved = false; let mainClosing: Promise<void> | undefined;
  service.on('event', event => events.push(event)); service.on('fatal', () => { fatalObserved = true; mainClosing ??= service.close(); });
  try {
    await service.call('conversation/start', { cwd: root, text: 'Local protocol fixture only' }, { clientId: 'another-owner', eventChannelId: 'another-channel' });
    for (let index = 0; index < 16; index++) await service.call('terminal/open', { cwd: root }, { clientId: `owner-${Math.floor(index / 2)}`, eventChannelId: 'channel' });
    const requests = Promise.allSettled(Array.from({ length: 48 }, () => service.native.call('hold', {})));
    expect(service.native.budget.pending).toBe(64);
    await service.gatewayDisconnected('channel'); const outcomes = await requests;
    expect(service.native.connected).toBe(false); expect(service.native.budget).toEqual({ pending: 0, retainedBytes: 0 });
    expect(fatalObserved).toBe(true); expect(mainClosing).toBe(service.close());
    expect(object(object(service.status()).activity)).toMatchObject({ terminals: 0, unknown: true, activeThreads: ['fixture-thread'] });
    expect(events.some(event => event.type === 'notification' && object(event.data).method === 'turn/completed')).toBe(false);
    expect(outcomes.some(result => result.status === 'rejected' && (result.reason as DeliveryError).delivery === 'unknown')).toBe(true);
    await expect(service.call('thread/start', { cwd: root }, { clientId: 'another-owner' })).rejects.toMatchObject({ code: 'runtime_unavailable' });
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { await service.close(); }
});

function controlled() {
  const root = home();
  const native = Object.assign(new EventEmitter(), {
    connected: true, budget: { pending: 0, retainedBytes: 0 }, closeCalls: 0, terminateCalls: 0,
    end: undefined as ((result: JsonValue) => void) | undefined, closeGate: undefined as Promise<void> | undefined, closeError: undefined as Error | undefined, naturalExit: false,
    async call(method: string, params: JsonValue, options: NativeOptions = {}): Promise<JsonValue> {
      options.beforeWrite?.(); options.onWritten?.();
      if (method === 'command/exec') return new Promise(resolve => { this.end = resolve; });
      if (method === 'command/exec/terminate') { this.terminateCalls++; if (this.naturalExit) this.end?.({ exitCode: 0, stdout: '', stderr: '' }); throw new DeliveryError(this.naturalExit ? 'native_error' : 'capacity', 'Terminate was not accepted'); }
      return params;
    },
    async close() { this.closeCalls++; this.connected = false; await this.closeGate; this.end?.({ exitCode: -1, stdout: '', stderr: '' }); if (this.closeError) throw this.closeError; },
  });
  const service = new RuntimeService({ bin: process.execPath, home: root, workerHome: root, cwd: root, env: {} }, native as unknown as NativeRpc);
  return { service, native, root, owner: { clientId: 'owner', eventChannelId: 'channel' } };
}

test.each(['client', 'gateway'])('%s disconnection shares and awaits the service close acknowledgement', async kind => {
  const { service, native, root, owner } = controlled(); let release!: () => void; native.closeGate = new Promise(resolve => { release = resolve; });
  try {
    await service.call('terminal/open', { cwd: root }, owner);
    let finished = false;
    const disconnecting = (kind === 'client' ? service.clientDisconnected(owner.clientId, owner.eventChannelId) : service.gatewayDisconnected(owner.eventChannelId)).then(() => { finished = true; });
    await expect.poll(() => native.closeCalls).toBe(1);
    const closing = service.close(); expect(service.close()).toBe(closing); expect(finished).toBe(false);
    await expect(service.call('thread/start', { cwd: root }, owner)).rejects.toMatchObject({ code: 'runtime_unavailable' });
    release(); await Promise.all([disconnecting, closing]);
    expect(finished).toBe(true); expect(native.closeCalls).toBe(1); expect(native.terminateCalls).toBe(1);
  } finally { release(); await service.close(); }
});

test('a failed whole-process cleanup remains a failure for both disconnect and later close callers', async () => {
  const { service, native, root, owner } = controlled(); native.closeError = new Error('No process-tree acknowledgement');
  await service.call('terminal/open', { cwd: root }, owner);
  await expect(service.gatewayDisconnected(owner.eventChannelId)).rejects.toThrow('cleanup was not confirmed');
  await expect(service.close()).rejects.toThrow('cleanup was not fully confirmed');
  expect(native.closeCalls).toBe(1); expect(object(service.status()).connected).toBe(false);
});

test('a confirmed natural terminal exit racing a rejected terminate does not close unrelated native work', async () => {
  const { service, native, root, owner } = controlled(); native.naturalExit = true;
  try {
    await service.call('terminal/open', { cwd: root }, owner); await service.clientDisconnected(owner.clientId, owner.eventChannelId);
    expect(native.closeCalls).toBe(0); expect(service.native.connected).toBe(true); expect(object(object(service.status()).activity).terminals).toBe(0);
  } finally { await service.close(); }
});
