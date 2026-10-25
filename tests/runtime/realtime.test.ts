import { afterEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { RuntimeService } from '../../src/runtime/service.js';
import type { NativeOptions, NativeRpc } from '../../src/runtime/native.js';
import { DeliveryError, object, type JsonValue, type RuntimeEvent } from '../../src/runtime/types.js';
class Native extends EventEmitter {
  connected = true; budget = {}; calls: { method: string; params: JsonValue }[] = []; gate?: Promise<void>; gateMethod?: string; stopFailure = false; inputFailure = false; unsupported = false; emitStart = true; emitClose = true;
  beforeCall?: (method: string) => void;
  async call(method: string, params: JsonValue, options: NativeOptions = {}): Promise<JsonValue> {
    this.beforeCall?.(method); options.beforeWrite?.(); this.calls.push({ method, params }); if (method === this.gateMethod) await this.gate;
    if (method === 'thread/read' || method === 'thread/start') return { thread: { id: 'thread', status: { type: 'idle' }, historyMode: 'paginated', turns: [] } };
    if (method === 'thread/turns/list') return { data: [], nextCursor: null, backwardsCursor: null };
    if (method === 'thread/timeline/list') return { data: [], nextCursor: null, activeRealtimeSessionAtPageStart: null };
    if (method === 'thread/realtime/start' && this.unsupported) throw new DeliveryError('unsupported', 'Voice unavailable with this provider');
    if (method === 'turn/start') return { turn: { id: 'turn', status: 'inProgress', items: [], error: null } };
    if (method === 'thread/realtime/start' && this.emitStart) { this.emit('notification', { method: 'thread/realtime/started', params: { threadId: 'thread', realtimeSessionId: object(params).realtimeSessionId, version: 'v3' } }); this.emit('notification', { method: 'thread/realtime/sdp', params: { threadId: 'thread', sdp: 'private SDP answer' } }); }
    if (method === 'thread/realtime/stop' && this.stopFailure) throw new DeliveryError('lost', 'unknown stop', 'unknown');
    if (method === 'thread/realtime/stop' && this.emitClose) this.emit('notification', { method: 'thread/realtime/closed', params: { threadId: 'thread', reason: 'requested' } });
    if (method === 'thread/realtime/appendText' && this.inputFailure) throw new DeliveryError('lost', 'unknown input', 'unknown');
    return {};
  }
  async close() { this.connected = false; }
}
const services: RuntimeService[] = []; const context = { clientId: 'owner', eventChannelId: 'channel', beforeWrite: () => {} };
async function setup() {
  const parent = path.resolve('.work/realtime-tests'); mkdirSync(parent, { recursive: true }); const home = mkdtempSync(path.join(parent, 'home-')); const native = new Native();
  const service = new RuntimeService({ bin: process.execPath, home, workerHome: home, cwd: home, env: {} }, native as unknown as NativeRpc); services.push(service); const events: RuntimeEvent[] = []; service.on('event', event => events.push(event)); await service.call('thread/start', { cwd: home }, context);
  return { service, native, events };
}
afterEach(async () => { try { await Promise.all(services.splice(0).map(service => service.close())); } finally { vi.useRealTimers(); } });
const start = async (service: RuntimeService, owner = context) => object(await service.call('thread/realtime/start', { threadId: 'thread', outputModality: 'audio', transport: { type: 'webrtc', sdp: 'offer' } }, owner)).sessionHandle!;
const notification = (native: Native, suffix: string, params: Record<string, unknown> = {}) => native.emit('notification', { method: `thread/realtime/${suffix}`, params: { threadId: 'thread', ...params } });
const nativeId = (native: Native) => object(native.calls.findLast(call => call.method === 'thread/realtime/start')!.params).realtimeSessionId!;
test('unsupported voice start preserves fresh creation provenance but accepted voice requires history reloading after stop', async () => {
  const first = await setup(); first.native.unsupported = true;
  await expect(start(first.service)).rejects.toMatchObject({ code: 'unsupported', delivery: 'not_sent' });
  await expect(first.service.call('turn/start', { threadId: 'thread', text: 'first normal input' }, context)).resolves.toMatchObject({ turn: { id: 'turn' } });
  const second = await setup(); const sessionHandle = await start(second.service); await second.service.call('thread/realtime/stop', { sessionHandle }, context);
  await expect(second.service.call('turn/start', { threadId: 'thread', text: 'must read voice history' }, context)).rejects.toMatchObject({ code: 'history_incomplete' });
});
test('voice requires explicit loading and keeps early SDP private while holding idle barriers between frames', async () => {
  const { service, events } = await setup(); await expect(service.call('thread/realtime/start', { threadId: 'unloaded', outputModality: 'audio' }, context)).rejects.toMatchObject({ code: 'session_not_loaded' });
  const sessionHandle = await start(service); expect(await service.call('thread/realtime/read', { sessionHandle }, context)).toMatchObject({ state: 'active', sdp: 'private SDP answer', nextSequence: 0 });
  expect(events.filter(event => event.type === 'realtime')).toHaveLength(2); expect(events.filter(event => event.type === 'realtime').every(event => event.eventChannelId === 'channel' && object(event.data).clientId === 'owner')).toBe(true);
  expect(events.some(event => event.type === 'notification' && String(object(event.data).method).startsWith('thread/realtime'))).toBe(false);
  for (const owner of [{ ...context, clientId: 'other' }, { ...context, eventChannelId: 'other' }]) await expect(service.call('thread/realtime/read', { sessionHandle }, owner)).rejects.toMatchObject({ code: 'not_found' });
  expect(object(object(service.status()).activity).activeThreads).toContain('thread');
  await expect(service.call('memory/reset', { confirm: true }, context)).rejects.toMatchObject({ code: 'activity_busy' });
  await expect(service.call('turn/start', { threadId: 'thread', text: 'race' }, context)).rejects.toMatchObject({ code: 'thread_busy' });
  await expect(service.call('thread/goal/clear', { threadId: 'thread' }, context)).rejects.toMatchObject({ code: 'voice_busy' });
  await service.call('thread/realtime/stop', { sessionHandle }, context); expect(object(object(service.status()).activity).activeThreads).toEqual([]);
});
test('audio is bounded PCM16 and concurrent live inputs use one monotonic serialized sequence', async () => {
  const { service, native } = await setup(); const sessionHandle = await start(service);
  await expect(service.call('thread/realtime/appendAudio', { sessionHandle, sequence: 0, audio: { data: 'YQ==', sampleRate: 24000, numChannels: 1, samplesPerChannel: 1, itemId: null } }, context)).rejects.toMatchObject({ code: 'invalid_params' });
  let release!: () => void; native.gateMethod = 'thread/realtime/appendText'; native.gate = new Promise(resolve => { release = resolve; });
  const first = service.call('thread/realtime/appendText', { sessionHandle, sequence: 0, role: 'user', text: 'one' }, context);
  const second = service.call('thread/realtime/appendSpeech', { sessionHandle, sequence: 1, text: 'two' }, context);
  await expect.poll(() => native.calls.filter(call => call.method === 'thread/realtime/appendText').length).toBe(1); expect(native.calls.some(call => call.method === 'thread/realtime/appendSpeech')).toBe(false);
  await expect(service.call('thread/realtime/appendText', { sessionHandle, sequence: 0, role: 'user', text: 'duplicate' }, context)).rejects.toMatchObject({ code: 'sequence_conflict' });
  release(); await first; await second; expect(await service.call('thread/realtime/read', { sessionHandle }, context)).toMatchObject({ nextSequence: 2, lastAcceptedSequence: 1 });
  expect(native.calls.filter(call => call.method.includes('/append')).map(call => object(call.params).text)).toEqual(['one', 'two']);
});
test('disconnect during accepted asynchronous startup waits before stop and suppresses late private events', async () => {
  const { service, native, events } = await setup(); let release!: () => void; native.gateMethod = 'thread/realtime/start'; native.gate = new Promise(resolve => { release = resolve; });
  const pending = start(service); await expect.poll(() => native.calls.some(call => call.method === 'thread/realtime/start')).toBe(true);
  const closing = service.clientDisconnected(context.clientId, context.eventChannelId); expect(native.calls.some(call => call.method === 'thread/realtime/stop')).toBe(false);
  release(); await pending; await closing; expect(native.calls.at(-1)?.method).toBe('thread/realtime/stop'); expect(events.filter(event => event.type === 'realtime')).toHaveLength(0); expect(object(object(service.status()).activity).activeThreads).toEqual([]);
});
test.each(['input', 'stop'])('an unknown voice %s outcome closes the epoch without frame replay', async failure => {
  const { service, native } = await setup(); const sessionHandle = await start(service); native.inputFailure = failure === 'input'; native.stopFailure = failure === 'stop';
  if (failure === 'input') await expect(service.call('thread/realtime/appendText', { sessionHandle, sequence: 0, text: 'one', role: 'user' }, context)).rejects.toMatchObject({ delivery: 'unknown' });
  else await service.call('thread/realtime/stop', { sessionHandle }, context);
  expect(native.connected).toBe(false); expect(object(object(service.status()).activity).unknown).toBe(true);
  expect(native.calls.filter(call => call.method === 'thread/realtime/appendText')).toHaveLength(failure === 'input' ? 1 : 0);
});
test('voice queue reserves a bounded number of frames and late closure prevents queued sends', async () => {
  const { service, native } = await setup(); const sessionHandle = await start(service); let release!: () => void; native.gateMethod = 'thread/realtime/appendText'; native.gate = new Promise(resolve => { release = resolve; });
  const pending = Array.from({ length: 8 }, (_, sequence) => service.call('thread/realtime/appendText', { sessionHandle, sequence, text: 'bounded', role: 'user' }, context));
  const settled = Promise.allSettled(pending); await expect(service.call('thread/realtime/appendText', { sessionHandle, sequence: 8, text: 'overflow', role: 'user' }, context)).rejects.toMatchObject({ code: 'capacity' });
  await expect.poll(() => native.calls.filter(call => call.method === 'thread/realtime/appendText').length).toBe(1);
  native.emit('notification', { method: 'thread/realtime/closed', params: { threadId: 'thread', reason: 'fixture closed' } }); release();
  const results = await settled; expect(results.filter(result => result.status === 'rejected')).toHaveLength(7); expect(native.calls.filter(call => call.method === 'thread/realtime/appendText')).toHaveLength(1);
});

test.each(['response-first', 'closed-first'])('stop keeps its owner and activity barrier until both boundaries settle: %s', async order => {
  const { service, native, events } = await setup(); const sessionHandle = await start(service); native.emitClose = false;
  let release = () => {}; if (order === 'closed-first') { native.gateMethod = 'thread/realtime/stop'; native.gate = new Promise(resolve => { release = resolve; }); }
  let settled = false; const stopping = service.call('thread/realtime/stop', { sessionHandle }, context).then(result => { settled = true; return result; });
  await expect.poll(() => native.calls.filter(call => call.method === 'thread/realtime/stop').length).toBe(1);
  notification(native, 'transcript/done', { role: 'assistant', text: 'final old-owner transcript' });
  expect(events.filter(event => event.type === 'realtime').at(-1)).toMatchObject({ eventChannelId: context.eventChannelId, data: { clientId: context.clientId, sessionHandle, params: { text: 'final old-owner transcript' } } });
  expect(await service.call('thread/realtime/read', { sessionHandle }, context)).toMatchObject({ state: 'stopping' });
  expect(object(object(service.status()).activity).activeThreads).toContain('thread'); expect(settled).toBe(false);
  await expect(start(service, { ...context, clientId: 'replacement' })).rejects.toMatchObject({ code: 'voice_busy' });
  notification(native, 'closed', { reason: 'requested' });
  if (order === 'closed-first') {
    await Promise.resolve(); expect(settled).toBe(false);
    expect(await service.call('thread/realtime/read', { sessionHandle }, context)).toMatchObject({ state: 'stopping' });
    expect(events.filter(event => event.type === 'realtime' && object(event.data).method === 'thread/realtime/closed')).toHaveLength(0);
    release();
  }
  await expect(stopping).resolves.toMatchObject({ state: 'closed', stopped: true, reason: 'requested' });
  expect(object(object(service.status()).activity).activeThreads).not.toContain('thread');
  expect(events.filter(event => event.type === 'realtime' && object(event.data).method === 'thread/realtime/closed')).toHaveLength(1);
});

test('same-thread restart rejects old identities and gates thread-only events until the matching native started event', async () => {
  const { service, native, events } = await setup(); const first = await start(service), oldId = nativeId(native);
  await service.call('thread/realtime/stop', { sessionHandle: first }, context);
  const owner = { ...context, clientId: 'next-owner', eventChannelId: 'next-channel' };
  await service.call('thread/history', { threadId: 'thread' }, owner); native.emitStart = false;
  const second = await start(service, owner), nextId = nativeId(native); const before = events.filter(event => event.type === 'realtime').length;
  notification(native, 'started', { realtimeSessionId: oldId, version: 'v1' });
  notification(native, 'sdp', { sdp: 'old SDP' });
  notification(native, 'transcript/delta', { role: 'assistant', delta: 'old speech' });
  notification(native, 'outputAudio/delta', { audio: { data: 'AAA=', sampleRate: 24000, numChannels: 1, samplesPerChannel: 1, itemId: null } });
  notification(native, 'closed', { reason: 'requested' });
  notification(native, 'item/completed', { item: { id: 'old-transcript', realtimeSessionId: oldId, type: 'transcriptSegment', role: 'assistant', text: 'old private transcript' } });
  expect(events.filter(event => event.type === 'realtime')).toHaveLength(before);
  expect(await service.call('thread/realtime/read', { sessionHandle: second }, owner)).toMatchObject({ state: 'starting', realtimeSessionId: nextId });
  notification(native, 'started', { realtimeSessionId: nextId, version: 'v3' });
  notification(native, 'sdp', { sdp: 'new SDP' });
  notification(native, 'item/completed', { item: { id: 'late-old-promotion', realtimeSessionId: oldId, type: 'bemItemPromoted', turnId: 'old-turn', itemId: 'old-item', presentation: { type: 'wholeItem' } } });
  notification(native, 'item/completed', { item: { id: 'new-transcript', realtimeSessionId: nextId, type: 'transcriptSegment', role: 'assistant', text: 'new private transcript' } });
  notification(native, 'transcript/delta', { role: 'assistant', delta: 'new speech' });
  const delivered = events.filter(event => event.type === 'realtime').slice(before);
  expect(delivered).toHaveLength(4); expect(delivered.every(event => event.eventChannelId === owner.eventChannelId && object(event.data).clientId === owner.clientId && object(event.data).sessionHandle === second)).toBe(true);
  expect(JSON.stringify(delivered)).not.toContain('old');
  expect(await service.call('thread/realtime/read', { sessionHandle: second }, owner)).toMatchObject({ state: 'active', sdp: 'new SDP', realtimeSessionId: nextId });
  await service.call('thread/realtime/stop', { sessionHandle: second }, owner);
});

test('an error-only accepted startup can be stopped and restarted without waiting for a started event', async () => {
  const { service, native, events } = await setup(); native.emitStart = false; const sessionHandle = await start(service);
  notification(native, 'error', { message: 'controlled provider startup rejection' });
  expect(events.filter(event => event.type === 'realtime').at(-1)).toMatchObject({ data: { state: 'starting', method: 'thread/realtime/error' } });
  await expect(service.call('thread/realtime/stop', { sessionHandle }, context)).resolves.toMatchObject({ state: 'closed', stopped: true });
  await service.call('thread/history', { threadId: 'thread' }, context); native.emitStart = true;
  const replacement = await start(service); expect(await service.call('thread/realtime/read', { sessionHandle: replacement }, context)).toMatchObject({ state: 'active' });
});

test.each(['natural', 'before-stop-write'])('a %s closure does not enqueue a later stop against another session', async phase => {
  const { service, native } = await setup(); const sessionHandle = await start(service);
  if (phase === 'natural') notification(native, 'closed', { reason: 'transport_closed' });
  else native.beforeCall = method => { if (method === 'thread/realtime/stop') notification(native, 'closed', { reason: 'transport_closed' }); };
  await expect(service.call('thread/realtime/stop', { sessionHandle }, context)).resolves.toMatchObject({ state: 'closed', stopped: true });
  expect(native.calls.some(call => call.method === 'thread/realtime/stop')).toBe(false); expect(native.connected).toBe(true);
  delete native.beforeCall; await service.call('thread/history', { threadId: 'thread' }, context);
  expect(await service.call('thread/realtime/read', { sessionHandle: await start(service) }, context)).toMatchObject({ state: 'active' });
});

test('missing closed notification has a bounded deadline and confirms whole-epoch cleanup before reporting stopped', async () => {
  const { service, native } = await setup(); const sessionHandle = await start(service); native.emitClose = false;
  let cleanup!: () => void; const cleanupGate = new Promise<void>(resolve => { cleanup = resolve; });
  native.close = async () => { await cleanupGate; native.connected = false; }; vi.useFakeTimers();
  let settled = false; const stopping = service.call('thread/realtime/stop', { sessionHandle }, context).then(result => { settled = true; return result; });
  await vi.advanceTimersByTimeAsync(9999); expect(settled).toBe(false); expect(native.connected).toBe(true);
  expect(await service.call('thread/realtime/read', { sessionHandle }, context)).toMatchObject({ state: 'stopping' });
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toBe(false); expect(native.connected).toBe(true); expect(object(object(service.status()).activity).unknown).toBe(true);
  cleanup();
  await expect(stopping).resolves.toMatchObject({ state: 'closed', stopped: true, reason: 'runtime_closed' });
  expect(native.connected).toBe(false); expect(object(object(service.status()).activity).unknown).toBe(true);
  expect(native.calls.filter(call => call.method === 'thread/realtime/stop')).toHaveLength(1);
});

test('unconfirmed native process cleanup rejects stop instead of returning stopped true', async () => {
  const { service, native } = await setup(); const sessionHandle = await start(service); native.stopFailure = true;
  native.close = async () => { throw new Error('controlled process cleanup failure'); };
  try {
    await expect(service.call('thread/realtime/stop', { sessionHandle }, context)).rejects.toThrow('Runtime process cleanup was not fully confirmed');
    expect(object(object(service.status()).activity).unknown).toBe(true);
  } finally { services.splice(services.indexOf(service), 1); }
});

test.each(['start', 'input', 'stop-response', 'closed'])('epoch reset wakes cleanup waiting for %s and does not dispatch late cleanup', async phase => {
  const { service, native, events } = await setup(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let pending: Promise<unknown> = Promise.resolve(); let handle: JsonValue | undefined;
  if (phase === 'start') { native.gateMethod = 'thread/realtime/start'; native.gate = gate; pending = start(service); }
  else {
    handle = await start(service);
    if (phase === 'input') { native.gateMethod = 'thread/realtime/appendText'; native.gate = gate; pending = service.call('thread/realtime/appendText', { sessionHandle: handle, sequence: 0, text: 'held', role: 'user' }, context); }
    if (phase === 'stop-response') { native.gateMethod = 'thread/realtime/stop'; native.gate = gate; }
    if (phase === 'closed') native.emitClose = false;
  }
  if (phase === 'start' || phase === 'input') await expect.poll(() => native.calls.some(call => call.method === native.gateMethod)).toBe(true);
  const before = events.filter(event => event.type === 'realtime').length;
  const disconnecting = service.clientDisconnected(context.clientId, context.eventChannelId);
  if (phase === 'stop-response' || phase === 'closed') await expect.poll(() => native.calls.some(call => call.method === 'thread/realtime/stop')).toBe(true);
  await service.close(); await disconnecting;
  const stopCount = native.calls.filter(call => call.method === 'thread/realtime/stop').length;
  release(); await pending; await Promise.resolve();
  expect(native.connected).toBe(false); expect(native.calls.filter(call => call.method === 'thread/realtime/stop')).toHaveLength(stopCount);
  expect(events.filter(event => event.type === 'realtime')).toHaveLength(before);
  expect(object(object(service.status()).activity).activeThreads).not.toContain('thread');
});

test('disconnect while startup is definitively rejected does not close an unrelated native epoch', async () => {
  const { service, native } = await setup(); let release!: () => void; native.gateMethod = 'thread/realtime/start'; native.gate = new Promise(resolve => { release = resolve; }); native.unsupported = true;
  const pending = start(service), rejected = expect(pending).rejects.toMatchObject({ code: 'unsupported', delivery: 'not_sent' });
  await expect.poll(() => native.calls.some(call => call.method === 'thread/realtime/start')).toBe(true);
  const disconnecting = service.clientDisconnected(context.clientId, context.eventChannelId); release(); await rejected; await disconnecting;
  expect(native.connected).toBe(true); expect(native.calls.some(call => call.method === 'thread/realtime/stop')).toBe(false);
});

test('the full 256 KiB PCM16 limit is accepted and an oversized frame consumes no sequence or native write', async () => {
  const { service, native } = await setup(); const sessionHandle = await start(service);
  const frame = (bytes: number) => ({ sessionHandle, sequence: 0, audio: { data: Buffer.alloc(bytes).toString('base64'), sampleRate: 24000, numChannels: 1, samplesPerChannel: null, itemId: null } });
  await expect(service.call('thread/realtime/appendAudio', frame(256 * 1024 + 2), context)).rejects.toMatchObject({ code: 'invalid_params' });
  expect(native.calls.some(call => call.method === 'thread/realtime/appendAudio')).toBe(false);
  await expect(service.call('thread/realtime/appendAudio', frame(256 * 1024), context)).resolves.toMatchObject({ sequence: 0, accepted: true, nextSequence: 1 });
  expect(native.calls.filter(call => call.method === 'thread/realtime/appendAudio')).toHaveLength(1);
});
