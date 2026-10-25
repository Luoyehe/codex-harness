import { afterEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { RuntimeService } from '../../src/runtime/service.js';
import type { NativeOptions, NativeRpc } from '../../src/runtime/native.js';
import { DeliveryError, object, type JsonObject, type JsonValue, type RuntimeEvent } from '../../src/runtime/types.js';
import { receiptResult } from '../../src/gateway/receipt-result.js';
const roots = path.resolve('.work/predictions-tests'); mkdirSync(roots, { recursive: true });
const turn = { id: 'turn', rootTurnId: null, items: [], itemsView: 'summary', status: 'completed', error: null, startedAt: 1, completedAt: 2, durationMs: 1000 };
class Native extends EventEmitter {
  connected = true; budget = { pending: 0, retainedBytes: 0 }; calls: { method: string; params: JsonValue }[] = []; source = { ...turn }; status = 'idle'; gate?: Promise<void>; before?: (method: string) => void; failure?: DeliveryError; early = false;
  async call(method: string, params: JsonValue, options?: NativeOptions): Promise<JsonValue> {
    if (method === 'thread/turns/list') await this.gate; this.before?.(method); options?.beforeWrite?.(); this.calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: 'thread', historyMode: 'paginated', status: { type: this.status }, canAcceptDirectInput: true, turns: [] } };
    if (method === 'thread/turns/list') return { data: [{ ...this.source, itemsView: object(params).itemsView ?? 'full' }], nextCursor: null, backwardsCursor: null };
    if (method === 'thread/timeline/list') return { data: [], nextCursor: null, activeRealtimeSessionAtPageStart: null };
    if (method === 'thread/prediction/request') { if (this.early) this.update({ type: 'completed', text: 'Private editable suggestion' }); if (this.failure) throw this.failure; }
    if (method === 'turn/start') return { turn: { ...turn, id: 'new-turn', itemsView: 'full', status: 'inProgress' } };
    return {};
  }
  update(result: JsonObject, sourceTurnId = 'turn') { this.emit('notification', { method: 'thread/prediction/updated', params: { threadId: 'thread', sourceTurnId, result } }); }
  async close() { this.connected = false; }
}
const services: RuntimeService[] = [], owner = { clientId: 'owner', eventChannelId: 'channel', beforeWrite: () => {} };
function setup() { const cwd = mkdtempSync(path.join(roots, 'home-')), native = new Native(), events: RuntimeEvent[] = []; const service = new RuntimeService({ bin: process.execPath, home: cwd, workerHome: cwd, cwd, env: {} }, native as unknown as NativeRpc); services.push(service); service.on('event', event => events.push(event)); return { service, native, events, history: () => service.call('thread/history', { threadId: 'thread' }, owner), request: () => service.call('thread/prediction/request', { threadId: 'thread', sourceTurnId: 'turn' }, owner), read: (predictionId: JsonValue, context = owner) => service.call('thread/prediction/read', { threadId: 'thread', predictionId }, context), activity: () => object(object(service.status()).activity) }; }
afterEach(async () => { vi.useRealTimers(); await Promise.all(services.splice(0).map(service => service.close())); });

test('predictions require complete history and latest completed source, keep text owner-private and receipts text-free', async () => {
  const f = setup(); await expect(f.request()).rejects.toMatchObject({ code: 'history_incomplete' }); await f.history();
  f.native.source.id = 'newer'; await expect(f.request()).rejects.toMatchObject({ code: 'prediction_stale' }); f.native.source.id = 'turn';
  f.native.early = true; const result = object(await f.request()); expect(result).toMatchObject({ threadId: 'thread', sourceTurnId: 'turn', requested: true }); expect(Object.keys(result)).toHaveLength(4);
  const read = object(await f.read(result.predictionId!)); expect(read).toMatchObject({ state: 'completed', result: { type: 'completed', text: 'Private editable suggestion' } });
  expect(receiptResult('thread/prediction/request', { ...read, requested: true })).toEqual(result);
  for (const changed of [{ ...owner, clientId: 'other' }, { ...owner, eventChannelId: 'other' }]) await expect(f.read(result.predictionId!, changed)).rejects.toMatchObject({ code: 'not_found' });
  expect(f.events.filter(event => event.type === 'prediction')).toMatchObject([{ eventChannelId: 'channel', data: { clientId: 'owner', state: 'completed' } }]);
  expect(f.events.some(event => event.type === 'notification' && object(event.data).method === 'thread/prediction/updated')).toBe(false);
  await expect(f.request()).rejects.toMatchObject({ code: 'prediction_already_requested' }); expect(f.native.calls.filter(call => call.method === 'thread/prediction/request')).toHaveLength(1);
});

test('request preparation reserves the thread and final context/owner changes reject before native dispatch', async () => {
  for (const kind of ['owner', 'context', 'turn'] as const) {
    const f = setup(); await f.history(); let release!: () => void; f.native.gate = new Promise(resolve => { release = resolve; });
    const pending = f.request(), rejection = expect(pending).rejects.toMatchObject({ delivery: 'not_sent' });
    await expect.poll(() => (f.activity().activeThreads as string[]).includes('thread')).toBe(true);
    await expect(f.service.call('turn/start', { threadId: 'thread', text: 'race' }, owner)).rejects.toMatchObject({ code: 'thread_busy' });
    if (kind === 'owner') await f.service.clientDisconnected(owner.clientId, owner.eventChannelId);
    else f.native.before = method => { if (method === 'thread/prediction/request') f.native.emit('notification', { method: kind === 'turn' ? 'turn/started' : 'thread/status/changed', params: kind === 'turn' ? { threadId: 'thread', turn: { id: 'new' } } : { threadId: 'thread', status: { type: 'idle' } } }); };
    release(); await rejection; expect(f.native.calls.some(call => call.method === 'thread/prediction/request')).toBe(false);
  }
});

test('pending prediction blocks global maintenance but explicit new input invalidates it and late results never restore text', async () => {
  const f = setup(); await f.history(); const result = object(await f.request()); expect(f.activity().pendingStarts).toBe(1);
  await expect(f.service.call('account/logout', {}, owner)).rejects.toMatchObject({ code: 'activity_busy' });
  await f.service.call('turn/start', { threadId: 'thread', text: 'Explicit next input' }, owner); expect(await f.read(result.predictionId!)).toMatchObject({ state: 'stale' });
  f.native.update({ type: 'completed', text: 'Never restore this old draft' }); const read = object(await f.read(result.predictionId!)); expect(read.state).toBe('stale'); expect(read).not.toHaveProperty('result'); expect(f.activity().pendingStarts).toBe(0);
});

test('disconnected source ownership is never reassigned, unknown requests are never replayed and unsolicited results stay private', async () => {
  const f = setup(); await f.history(); const result = object(await f.request()); await f.service.clientDisconnected(owner.clientId, owner.eventChannelId);
  await expect(f.read(result.predictionId!)).rejects.toMatchObject({ code: 'not_found' }); const count = f.events.filter(event => event.type === 'prediction').length;
  f.native.update({ type: 'completed', text: 'secret' }); f.native.update({ type: 'completed', text: 'unsolicited' }, 'unrequested'); expect(f.events.filter(event => event.type === 'prediction')).toHaveLength(count);
  await expect(f.request()).rejects.toMatchObject({ code: 'prediction_already_requested' });
  const second = setup(); await second.history(); second.native.failure = new DeliveryError('lost', 'Unknown native delivery', 'unknown'); await expect(second.request()).rejects.toMatchObject({ delivery: 'unknown' }); await expect(second.request()).rejects.toMatchObject({ code: 'prediction_already_requested' });
});

test('timeout and malformed terminal notifications retain a recovery requirement; completed results expire without source reuse', async () => {
  vi.useFakeTimers(); const f = setup(); await f.history(); const result = object(await f.request()); await vi.advanceTimersByTimeAsync(60001); expect(await f.read(result.predictionId!)).toMatchObject({ state: 'unknown' }); expect(f.activity().unknown).toBe(true);
  const second = setup(); await second.history(); const bad = object(await second.request()); second.native.update({ type: 'completed', text: 'x'.repeat(17000) }); expect(await second.read(bad.predictionId!)).toMatchObject({ state: 'unknown' }); expect(second.activity().unknown).toBe(true);
  const third = setup(); await third.history(); const ok = object(await third.request()); third.native.update({ type: 'completed', text: null }); expect(await third.read(ok.predictionId!)).toMatchObject({ state: 'completed', result: { text: null } }); await vi.advanceTimersByTimeAsync(600001); await expect(third.read(ok.predictionId!)).rejects.toMatchObject({ code: 'not_found' }); await expect(third.request()).rejects.toMatchObject({ code: 'prediction_already_requested' });
});
