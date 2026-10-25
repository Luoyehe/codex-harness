import { afterEach, expect, test } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { RuntimeService } from '../../src/runtime/service.js';
import { DeliveryError, object, type JsonValue } from '../../src/runtime/types.js';
import type { NativeOptions, NativeRpc } from '../../src/runtime/native.js';
class Native extends EventEmitter {
  connected = true; budget = {}; calls: { method: string; params: JsonValue }[] = []; pages: JsonValue[] = []; before?: () => void;
  async call(method: string, params: JsonValue, options: NativeOptions = {}): Promise<JsonValue> {
    if (method === 'thread/backgroundTerminals/terminate') this.before?.(); options.beforeWrite?.(); this.calls.push({ method, params });
    if (['thread/start', 'thread/read'].includes(method)) return { thread: { id: 'thread', status: { type: 'idle' }, historyMode: 'paginated', turns: [] } };
    if (method === 'thread/backgroundTerminals/list') return this.pages.shift() ?? { data: [], nextCursor: null };
    if (method === 'thread/backgroundTerminals/terminate') return { terminated: false };
    return {};
  }
  async close() { this.connected = false; }
}
const services: RuntimeService[] = []; const context = { clientId: 'owner', eventChannelId: 'channel', beforeWrite: () => {} };
async function setup() { const parent = path.resolve('.work/thread-terminals-tests'); mkdirSync(parent, { recursive: true }); const home = mkdtempSync(path.join(parent, 'home-')); const native = new Native(); const service = new RuntimeService({ bin: process.execPath, home, workerHome: home, cwd: home, env: {} }, native as unknown as NativeRpc); services.push(service); await service.call('thread/start', { cwd: home }, context); return { service, native }; }
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });
const terminal = { itemId: 'item', processId: 'native-process', command: 'fixture', cwd: '/project', osPid: null, cpuPercent: null, rssKb: null };
test('thread shell requires explicit unsandboxed consent and accepted work blocks a second input before native events', async () => {
  const { service, native } = await setup();
  await expect(service.call('thread/shellCommand', { threadId: 'thread', command: 'fixture' }, context)).rejects.toMatchObject({ code: 'confirmation_required' });
  expect(await service.call('thread/shellCommand', { threadId: 'thread', command: 'fixture', confirmUnsandboxed: true }, context)).toEqual({ threadId: 'thread', submitted: true });
  expect(native.calls.at(-1)).toEqual({ method: 'thread/shellCommand', params: { threadId: 'thread', command: 'fixture', timeoutMs: 3600000 } });
  expect(object(object(service.status()).activity).activeThreads).toContain('thread');
  await expect(service.call('thread/shellCommand', { threadId: 'thread', command: 'second', confirmUnsandboxed: true }, context)).rejects.toMatchObject({ code: 'history_incomplete' });
});
test('background termination requires fresh same-thread discovery and preserves native false results', async () => {
  const { service, native } = await setup();
  await expect(service.call('thread/backgroundTerminals/terminate', { threadId: 'thread', processId: 'arbitrary-pid' }, context)).rejects.toMatchObject({ code: 'not_found' });
  native.pages.push({ data: [], nextCursor: 'next' }, { data: [terminal], nextCursor: null });
  expect(await service.call('thread/backgroundTerminals/terminate', { threadId: 'thread', processId: terminal.processId }, context)).toEqual({ threadId: 'thread', processId: terminal.processId, terminated: false });
  expect(native.calls.filter(call => call.method === 'thread/backgroundTerminals/terminate')).toHaveLength(1);
  expect(native.calls.at(-2)).toMatchObject({ params: { threadId: 'thread', cursor: 'next' } });
});
test('owner revocation after discovery prevents termination and cursor loops never dispatch it', async () => {
  const { service, native } = await setup(); native.pages.push({ data: [], nextCursor: 'loop' }, { data: [], nextCursor: 'loop' });
  await expect(service.call('thread/backgroundTerminals/terminate', { threadId: 'thread', processId: terminal.processId }, context)).rejects.toMatchObject({ code: 'cursor_loop' });
  native.pages.push({ data: [terminal], nextCursor: null }); let revoked = false; native.before = () => { revoked = true; };
  await expect(service.call('thread/backgroundTerminals/terminate', { threadId: 'thread', processId: terminal.processId }, { ...context, beforeWrite: () => { if (revoked) throw new DeliveryError('client_disconnected', 'revoked'); } })).rejects.toMatchObject({ code: 'client_disconnected' });
  expect(native.calls.some(call => call.method === 'thread/backgroundTerminals/terminate')).toBe(false);
});
test('native cleanup acknowledgement is represented only as a request and requires consent', async () => {
  const { service } = await setup(); await expect(service.call('thread/backgroundTerminals/clean', { threadId: 'thread' }, context)).rejects.toMatchObject({ code: 'confirmation_required' });
  expect(await service.call('thread/backgroundTerminals/clean', { threadId: 'thread', confirm: true }, context)).toEqual({ threadId: 'thread', cleanupRequested: true });
});
