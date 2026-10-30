import { afterEach, describe, expect, test } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { RuntimeService, type RuntimeConfig } from '../../src/runtime/service.js';
import type { NativeRpc, NativeOptions } from '../../src/runtime/native.js';
import { DeliveryError, object, type JsonValue, type RuntimeEvent } from '../../src/runtime/types.js';
import { validatePrompt } from '../../src/runtime/validation.js';
import { Ledger } from '../../src/core/ledger.js';
import { Dispatcher } from '../../src/gateway/dispatch.js';
import { AutomationScheduler } from '../../src/gateway/automation-scheduler.js';

const roots = path.resolve('.work/runtime-tests'); mkdirSync(roots, { recursive: true });
class FakeNative extends EventEmitter {
  connected = true; budget = { pending: 0, retainedBytes: 0 }; calls: { method: string; params: JsonValue }[] = []; responses: { id: string | number; result: JsonValue }[] = [];
  beforeNativeWrite?: (method: string) => void;
  readGate?: Promise<void>;
  pageGate?: Promise<void>;
  turnError?: DeliveryError;
  page: JsonValue = { data: [], nextCursor: null, backwardsCursor: null };
  timeline: JsonValue = { data: [], nextCursor: null, activeRealtimeSessionAtPageStart: null };
  timelineGate?: Promise<void>;
  historyMode = 'paginated';
  terminalEnds = new Map<string, (result: JsonValue) => void>();
  async call(method: string, params: JsonValue, options: NativeOptions = {}): Promise<JsonValue> {
    this.beforeNativeWrite?.(method); options.beforeWrite?.(); this.calls.push({ method, params }); options.onWritten?.();
    if (method === 'thread/read') { await this.readGate; return { thread: { id: object(params).threadId!, status: { type: 'idle' }, historyMode: this.historyMode, turns: [] } }; }
    if (method === 'thread/start') return { thread: { id: 'created-thread', status: { type: 'idle' }, historyMode: this.historyMode, turns: [] } };
    if (method === 'thread/turns/list') { const page = this.page; await this.pageGate; return page; }
    if (method === 'thread/timeline/list') { const page = this.timeline; await this.timelineGate; return page; }
    if (method === 'turn/start') { if (this.turnError) throw this.turnError; return { turn: { id: 'turn-1', status: 'inProgress', items: [] } }; }
    if (method === 'command/exec') return new Promise(resolve => { this.terminalEnds.set(String(object(params).processId), resolve); });
    if (method === 'command/exec/terminate') { this.terminalEnds.get(String(object(params).processId))?.({ exitCode: 0, stdout: '', stderr: '' }); this.terminalEnds.delete(String(object(params).processId)); return {}; }
    if (method === 'account/login/start') return { type: 'chatgptDeviceCode', loginId: 'login', userCode: 'private-code', verificationUrl: 'https://auth.example/device' };
    if (method === 'account/login/cancel') return { status: 'canceled' };
    if (method === 'remoteControl/status/read') return { status: 'disabled', serverName: 'test', installationId: 'test', environmentId: null };
    return {};
  }
  async respond(id: string | number, result: JsonValue, beforeWrite?: () => void): Promise<void> { beforeWrite?.(); this.responses.push({ id, result }); }
  async rejectRequest(): Promise<void> {}
  async close(): Promise<void> { this.connected = false; for (const end of this.terminalEnds.values()) end({ exitCode: -1 }); this.terminalEnds.clear(); }
}
const services: RuntimeService[] = [];
function setup(): { service: RuntimeService; native: FakeNative; events: RuntimeEvent[]; cwd: string } {
  const cwd = mkdtempSync(path.join(roots, 'service-')); const native = new FakeNative(); const config: RuntimeConfig = { bin: process.execPath, home: cwd, workerHome: cwd, cwd, env: {} }; const service = new RuntimeService(config, native as unknown as NativeRpc); services.push(service); const events: RuntimeEvent[] = []; service.on('event', event => events.push(event)); return { service, native, events, cwd };
}
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });
const context = { clientId: 'client-a' };
describe('history reconciles exact live turns without trusting mixed lifecycle snapshots', () => {
  const row = (id: string, status: string): JsonValue => ({ id, status, items: [], itemsView: 'full' });
  const page = (...data: JsonValue[]): JsonValue => ({ data, nextCursor: null, backwardsCursor: null });
  const notify = (native: FakeNative, method: string, id = 'live', status = 'completed', threadId = 't') => native.emit('notification', { method, params: { threadId, turn: { id, status, items: [] } } });

  test.each(['paginated', 'legacy'])('%s history keeps the accepted turn active despite an idle status and a synthetic interrupted row', async mode => {
    const { service, native } = setup(), original = native.call.bind(native);
    native.historyMode = mode;
    const live = row('live', 'interrupted'), older = row('older', 'interrupted');
    native.page = page(live, older);
    native.call = async (method, params, options) => {
      const result = await original(method, params, options);
      if (method === 'thread/read' && object(params).includeTurns) object(object(result).thread).turns = [older, live];
      return result;
    };
    notify(native, 'turn/started');
    native.emit('notification', { method: 'thread/status/changed', params: { threadId: 't', status: { type: 'idle' } } });
    const result = object(await service.call('thread/history', { threadId: 't' }, context));
    expect(result).toMatchObject({ complete: true, turns: [older, { ...object(live), status: 'inProgress' }] });
    expect(object(object(service.status()).activity).activeThreads).toContain('t');
    expect(object(live).status).toBe('interrupted');
  });

  test.each(['completed', 'failed', 'interrupted'])('cold %s history and status-only activity have no live identity to override old turns', async status => {
    const { service, native } = setup(); native.page = page(row('old', status));
    expect(await service.call('thread/history', { threadId: 'cold' }, context)).toMatchObject({ complete: true, turns: [row('old', status)] });
    native.emit('notification', { method: 'thread/status/changed', params: { threadId: 't', status: { type: 'active', activeFlags: [] } } });
    expect(await service.call('thread/history', { threadId: 't' }, context)).toMatchObject({ complete: true, turns: [row('old', status)] });
  });

  test('a streamed item does not stale history or settle its exact live turn', async () => {
    const { service, native } = setup(); native.page = page(row('live', 'interrupted')); notify(native, 'turn/started');
    native.beforeNativeWrite = method => { if (method === 'thread/timeline/list') native.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 't', turnId: 'live', itemId: 'message', delta: 'text' } }); };
    expect(await service.call('thread/history', { threadId: 't' }, context)).toMatchObject({ complete: true, turns: [row('live', 'inProgress')] });
  });

  test('completion between the turn and timeline pages discards the traversal and its write permission', async () => {
    const { service, native } = setup(); native.page = page(row('live', 'interrupted')); notify(native, 'turn/started');
    native.beforeNativeWrite = method => { if (method === 'thread/timeline/list') notify(native, 'turn/completed'); };
    await expect(service.call('thread/history', { threadId: 't' }, context)).rejects.toMatchObject({ code: 'history_stale' });
    await expect(service.call('turn/start', { threadId: 't', text: 'requires a fresh read' }, context)).rejects.toMatchObject({ code: 'history_incomplete' });
    native.beforeNativeWrite = undefined;
    expect(await service.call('thread/history', { threadId: 't' }, context)).toMatchObject({ complete: true, turns: [row('live', 'completed')] });
  });

  test('a changed lifecycle between cursor requests rejects the old cursor before another native page', async () => {
    const { service, native } = setup(); notify(native, 'turn/started');
    native.page = { data: [row('live', 'interrupted')], nextCursor: 'older', backwardsCursor: null };
    const first = object(await service.call('thread/history', { threadId: 't' }, context)); expect(first.complete).toBe(false);
    notify(native, 'turn/completed'); const calls = native.calls.length;
    await expect(service.call('thread/history', { threadId: 't', cursor: first.nextCursor! }, context)).rejects.toMatchObject({ code: 'history_stale' });
    expect(native.calls).toHaveLength(calls);
    await expect(service.call('thread/history', { threadId: 't', cursor: first.nextCursor! }, context)).rejects.toMatchObject({ code: 'invalid_cursor' });
    await expect(service.call('turn/start', { threadId: 't', text: 'blocked' }, context)).rejects.toMatchObject({ code: 'history_incomplete' });
  });

  test('an accepted turn response without a started notification fences history already loading for another owner', async () => {
    const { service, native } = setup(), original = native.call.bind(native);
    await service.call('thread/history', { threadId: 't' }, context);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), written = new Promise<void>(resolve => { entered = resolve; });
    let starting: Promise<JsonValue>;
    native.call = async (method, params, options) => {
      const result = await original(method, params, options);
      if (method === 'turn/start') { entered(); await gate; }
      if (method === 'thread/timeline/list') { release(); await starting; }
      return result;
    };
    starting = service.call('turn/start', { threadId: 't', text: 'start' }, context); await written;
    await expect(service.call('thread/history', { threadId: 't' }, { clientId: 'reader' })).rejects.toMatchObject({ code: 'history_stale' });
    expect(await starting).toMatchObject({ turn: { id: 'turn-1', status: 'inProgress' } });
    native.call = original; native.page = page(row('turn-1', 'interrupted'));
    expect(await service.call('thread/history', { threadId: 't' }, { clientId: 'reader' })).toMatchObject({ turns: [row('turn-1', 'inProgress')] });
  });

  test('an unknown live turn stays unknown and does not rewrite interrupted history as known in-progress', async () => {
    const { service, native } = setup(); notify(native, 'turn/started'); native.emit('fatal', new Error('lost native connection'));
    native.page = page(row('live', 'interrupted'));
    expect(await service.call('thread/history', { threadId: 't' }, context)).toMatchObject({ complete: true, turns: [row('live', 'interrupted')] });
    expect(object(object(service.status()).activity).unknown).toBe(true);
    notify(native, 'turn/completed');
    expect(await service.call('thread/history', { threadId: 't' }, context)).toMatchObject({ turns: [row('live', 'completed')] });
    expect(object(object(service.status()).activity).unknown).toBe(true);
  });

  test.each(['completed', 'failed', 'interrupted'])('the most recent exact %s notification overrides stale history without inventing a missing turn', async status => {
    const { service, native } = setup(); notify(native, 'turn/completed', 'old', 'completed'); notify(native, 'turn/completed', 'live', status);
    native.page = page(row('live', 'inProgress'), row('old', 'interrupted'));
    expect(await service.call('thread/history', { threadId: 't' }, context)).toMatchObject({ turns: [row('old', 'interrupted'), row('live', status)] });
    expect(await service.call('thread/history', { threadId: 'different-thread' }, context)).toMatchObject({ turns: [row('old', 'interrupted'), row('live', 'inProgress')] });
    native.page = page(row('old', 'interrupted'));
    expect(await service.call('thread/history', { threadId: 't' }, context)).toMatchObject({ complete: true, turns: [row('old', 'interrupted')] });
  });

  test.each(['thread/closed', 'thread/deleted', 'thread/reverted'])('%s clears terminal evidence and fences an in-flight historical read', async method => {
    const { service, native } = setup(); notify(native, 'turn/completed'); native.page = page(row('live', 'interrupted'));
    native.beforeNativeWrite = call => { if (call === 'thread/timeline/list') native.emit('notification', { method, params: { threadId: 't' } }); };
    await expect(service.call('thread/history', { threadId: 't' }, context)).rejects.toMatchObject({ code: 'history_stale' });
    native.beforeNativeWrite = undefined;
    expect(await service.call('thread/history', { threadId: 't' }, context)).toMatchObject({ complete: true, turns: [row('live', 'interrupted')] });
  });

  test('completion before automation acceptance wins over stale history and does not replay or retain the worker lease', async () => {
    const { service, native, cwd } = setup(), original = native.call.bind(native), leases = new Set<string>();
    let now = Date.parse('2026-01-01T00:00:00Z'), observedEarlyCompletion = false;
    const ledger = new Ledger(':memory:', () => now);
    const worker = { connected: true, clientConnected: async (id: string) => { leases.add(id); }, clientDisconnected: async (id: string) => { leases.delete(id); }, call: service.call.bind(service) };
    const dispatcher = new Dispatcher(ledger, worker, { call: async () => { throw new Error('Unexpected manager call'); } });
    service.on('event', event => dispatcher.event(event));
    dispatcher.event({ type: 'state', data: service.status() });
    const scheduler = new AutomationScheduler(ledger, dispatcher, worker, () => now);
    try {
      native.call = async (method, params, options) => {
        const result = await original(method, params, options);
        if (method === 'turn/start') {
          const run = ledger.automations.outstanding()[0]!;
          expect(run).toMatchObject({ state: 'dispatching', threadId: null, turnId: null }); expect(leases.size).toBe(1);
          notify(native, 'turn/started', 'turn-1', 'inProgress', 'created-thread');
          notify(native, 'turn/completed', 'turn-1', 'completed', 'created-thread');
          observedEarlyCompletion = true;
        }
        // Even metadata and the first history page can still describe the old turn.
        if (method === 'thread/read' && observedEarlyCompletion) object(object(result).thread).turns = [row('turn-1', 'inProgress')];
        return result;
      };
      native.page = page(row('turn-1', 'interrupted'));
      const project = ledger.addProject(cwd, 'Early completion');
      const created = object(await dispatcher.call({ method: 'automation/create', operationId: randomUUID(), params: { spec: { name: 'Once', projectId: project.id, text: 'offline test', options: {}, schedule: { kind: 'once', at: now + 60_000, timeZone: 'UTC' }, maxRunMinutes: 1 } } }, { clientId: 'browser', requireConnection: () => {} }));
      scheduler.start(); await scheduler.tick(); now += 60_000; await scheduler.tick();
      const runs = object(ledger.automations.read('automation/runs', { id: created.id! })).data as JsonValue[];
      expect(observedEarlyCompletion).toBe(true); expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ state: 'completed', threadId: 'created-thread', turnId: 'turn-1' });
      expect(ledger.read(String(object(runs[0]).operationId))).toMatchObject({ state: 'accepted', result: { turn: { id: 'turn-1', status: 'inProgress' } } });
      expect(leases.size).toBe(0); expect(object(object(service.status()).activity).activeThreads).toEqual([]);
      await service.call('thread/read', { threadId: 'created-thread' }, context);
      expect(object(object(service.status()).activity).activeThreads).toEqual([]);
      await scheduler.tick(); expect(native.calls.filter(call => call.method === 'turn/start')).toHaveLength(1);
      expect(native.calls.filter(call => call.method === 'turn/interrupt')).toHaveLength(0);
    } finally { await scheduler.close(); ledger.close(); }
  });
});

describe('RuntimeService admission and recovery', () => {
  test('cold notLoaded history retains pagination and authorizes only its fully hydrated owner to resume', async () => {
    const { service, native } = setup(), original = native.call.bind(native);
    native.call = async (method, params, options) => {
      const result = await original(method, params, options);
      if (method === 'thread/read') object(object(result).thread).status = { type: 'notLoaded' };
      return result;
    };
    native.page = { data: [], nextCursor: 'older', backwardsCursor: null };
    const first = object(await service.call('thread/history', { threadId: 'cold' }, context));
    expect(first.complete).toBe(false);
    await expect(service.call('thread/resume', { threadId: 'cold' }, context)).rejects.toMatchObject({ code: 'history_incomplete' });
    native.page = { data: [], nextCursor: null, backwardsCursor: null };
    expect(await service.call('thread/history', { threadId: 'cold', cursor: first.nextCursor! }, context)).toMatchObject({ complete: true });
    await expect(service.call('thread/resume', { threadId: 'cold' }, { clientId: 'other' })).rejects.toMatchObject({ code: 'history_incomplete' });
    native.beforeNativeWrite = method => { if (method === 'thread/resume') throw new DeliveryError('resume_reached', 'Native resume admission reached'); };
    await expect(service.call('thread/resume', { threadId: 'cold' }, context)).rejects.toMatchObject({ code: 'resume_reached', delivery: 'not_sent' });
  });
  test('maintenance refuses accepted turns and uncertain activity', async () => {
    const { service, native } = setup();
    await expect(service.call('runtime/maintenance/check', {}, context)).resolves.toMatchObject({ idle: true, workspaceWitness: { total: 0, limit: 2000 } });
    native.emit('notification', { method: 'turn/started', params: { threadId: 't', turn: { id: 'u' } } });
    await expect(service.call('runtime/maintenance/check', {}, context)).rejects.toMatchObject({ code: 'activity_busy' });
    native.emit('notification', { method: 'thread/status/changed', params: { threadId: 't', status: { type: 'idle' } } });
    await expect(service.call('runtime/maintenance/check', {}, context)).rejects.toMatchObject({ code: 'activity_busy' });
    native.emit('notification', { method: 'turn/completed', params: { threadId: 't', turn: { id: 'u', status: 'completed' } } });
    await expect(service.call('runtime/maintenance/check', {}, context)).resolves.toMatchObject({ idle: true });
    native.emit('fatal', new Error('disconnected'));
    await expect(service.call('runtime/maintenance/check', {}, context)).rejects.toMatchObject({ code: 'activity_unknown' });
  });
  test('maintenance requires remote control disabled and rechecks activity after the native status read', async () => {
    const { service, native } = setup(), original = native.call.bind(native);
    let active = false;
    native.call = async (method, params, options) => method === 'remoteControl/status/read'
      ? { status: active ? 'connected' : 'disabled', serverName: 'test', installationId: 'test', environmentId: null }
      : original(method, params, options);
    active = true;
    await expect(service.call('runtime/maintenance/check', {}, context)).rejects.toMatchObject({ code: 'remote_control_active' });
    native.call = async (method, params, options) => {
      if (method === 'remoteControl/status/read') {
        native.emit('notification', { method: 'turn/started', params: { threadId: 'external', turn: { id: 'u' } } });
        return { status: 'disabled', serverName: 'test', installationId: 'test', environmentId: null };
      }
      return original(method, params, options);
    };
    await expect(service.call('runtime/maintenance/check', {}, context)).rejects.toMatchObject({ code: 'activity_busy' });
  });
  test('browsing more than the activity cache size retains admission for subsequent work', async () => {
    const { service } = setup();
    for (let index = 0; index < 2200; index++) {
      expect(await service.call('thread/read', { threadId: `historical-${index}` }, context)).toHaveProperty('thread');
    }
    expect(object(object(service.status()).activity).unknown).toBe(false);
    await expect(service.call('account/logout', {}, { ...context, beforeWrite: () => {} })).resolves.toEqual({});
  });

  test('failed reads of nonexistent threads do not exhaust or poison the activity cache', async () => {
    const { service, native } = setup();
    native.beforeNativeWrite = method => { if (method === 'thread/read') throw new DeliveryError('native_error', 'No such thread'); };
    for (let index = 0; index < 2200; index++) {
      await expect(service.call('thread/read', { threadId: `missing-${index}` }, context)).rejects.toMatchObject({ code: 'native_error' });
    }
    expect(object(object(service.status()).activity).unknown).toBe(false);
    await expect(service.call('account/logout', {}, { ...context, beforeWrite: () => {} })).resolves.toEqual({});
  });

  test('completed history caches recycle without retaining permission for an evicted traversal', async () => {
    const { service } = setup();
    for (let index = 0; index < 270; index++) {
      expect(await service.call('thread/history', { threadId: `history-${index}` }, context)).toMatchObject({ complete: true });
    }
    await expect(service.call('turn/start', { threadId: 'history-0', text: 'requires a fresh read' }, context)).rejects.toMatchObject({ code: 'history_incomplete' });
    expect(await service.call('thread/history', { threadId: 'history-0' }, context)).toMatchObject({ complete: true });
    await expect(service.call('turn/start', { threadId: 'history-0', text: 'now verified' }, context)).resolves.toHaveProperty('turn');
  });
  test('device login is configuration-gated, owner-scoped and revoked by gateway disconnection', async () => {
    const { service } = setup(), owner = { ...context, eventChannelId: 'channel', beforeWrite: () => {} };
    await expect(service.call('account/login', {}, context)).rejects.toMatchObject({ code: 'operation_required' });
    expect(await service.call('account/login', {}, owner)).toEqual({ type: 'chatgptDeviceCode', loginId: 'login' });
    expect(await service.call('account/login/handoff', { loginId: 'login' }, owner)).toMatchObject({ userCode: 'private-code' });
    await expect(service.call('account/login/handoff', { loginId: 'login' }, { ...owner, eventChannelId: 'other' })).rejects.toMatchObject({ code: 'not_found' });
    await service.gatewayDisconnected('channel');
    await expect(service.call('account/login/handoff', { loginId: 'login' }, owner)).rejects.toMatchObject({ code: 'not_found' });
  });
  test('activity arriving at the final account login boundary prevents native dispatch', async () => {
    const { service, native } = setup(); native.beforeNativeWrite = method => { if (method === 'account/login/start') native.emit('notification', { method: 'turn/started', params: { threadId: 't', turn: { id: 'u' } } }); };
    await expect(service.call('account/login', {}, { ...context, beforeWrite: () => {} })).rejects.toMatchObject({ code: 'activity_busy' });
    expect(native.calls.some(call => call.method === 'account/login/start')).toBe(false);
  });
  test('old voice-only history must finish its own cursor chain before granting a thread proof', async () => {
    const { service, native } = setup(); const item = { id: 'voice', realtimeSessionId: 'session', type: 'transcriptSegment', role: 'user', text: 'older voice context' };
    native.timeline = { data: [{ type: 'realtime', position: 1, item }], nextCursor: 'native-voice-cursor', activeRealtimeSessionAtPageStart: 'session' };
    const first = object(await service.call('thread/history', { threadId: 't' }, context)); expect(first).toMatchObject({ complete: false, turnsComplete: true, timelineComplete: false, timeline: [{ item }] });
    await expect(service.call('turn/start', { threadId: 't', text: 'blocked' }, context)).rejects.toMatchObject({ code: 'history_incomplete' });
    native.timeline = { data: [], nextCursor: null, activeRealtimeSessionAtPageStart: null };
    expect(await service.call('thread/history', { threadId: 't', cursor: first.nextCursor! }, context)).toMatchObject({ turns: [], complete: true, turnsComplete: true, timelineComplete: true });
    expect(object(native.calls.at(-1)!.params).cursor).toBe('native-voice-cursor'); await service.call('turn/start', { threadId: 't', text: 'complete context' }, context);
  });
  test('voice changes during a timeline read revoke that traversal instead of publishing stale completeness', async () => {
    const { service, native } = setup(); let release!: () => void; native.timelineGate = new Promise(resolve => { release = resolve; });
    const pending = service.call('thread/history', { threadId: 't' }, context); const rejected = expect(pending).rejects.toMatchObject({ code: 'history_stale' });
    await expect.poll(() => native.calls.some(call => call.method === 'thread/timeline/list')).toBe(true);
    native.emit('notification', { method: 'thread/realtime/item/completed', params: { threadId: 't', item: { id: 'voice', realtimeSessionId: 'session', type: 'transcriptSegment', role: 'assistant', text: 'new context' } } });
    release(); await rejected; await expect(service.call('turn/start', { threadId: 't', text: 'blocked' }, context)).rejects.toMatchObject({ code: 'history_incomplete' });
  });
  test('combined history byte accounting never grants completeness after oversized voice pages', async () => {
    const { service, native } = setup(); const voice = { type: 'realtime', position: 1, item: { id: 'voice', realtimeSessionId: 'session', type: 'transcriptSegment', role: 'user', text: 'x'.repeat(4 * 1024 * 1024) } };
    native.timeline = { data: [voice], nextCursor: 'more', activeRealtimeSessionAtPageStart: null }; const first = object(await service.call('thread/history', { threadId: 't' }, context));
    native.timeline = { data: [{ ...voice, position: 2 }], nextCursor: null, activeRealtimeSessionAtPageStart: null };
    await expect(service.call('thread/history', { threadId: 't', cursor: first.nextCursor! }, context)).rejects.toMatchObject({ code: 'capacity' });
    await expect(service.call('turn/start', { threadId: 't', text: 'blocked' }, context)).rejects.toMatchObject({ code: 'history_incomplete' });
  });
  test('extension configuration requires an idle runtime and rechecks native activity at its final write boundary', async () => {
    const { service, native } = setup();
    await expect(service.call('memory/reset', { confirm: true }, context)).rejects.toMatchObject({ code: 'operation_required' });
    native.beforeNativeWrite = method => { if (method === 'memory/reset') native.emit('notification', { method: 'turn/started', params: { threadId: 't', turn: { id: 'u' } } }); };
    await expect(service.call('memory/reset', { confirm: true }, { ...context, beforeWrite: () => {} })).rejects.toMatchObject({ code: 'activity_busy' });
    expect(native.calls.some(call => call.method === 'memory/reset')).toBe(false);
    expect(object(object(service.status()).activity).unknown).toBe(false);
  });
  test('conversation/start validates before creation and checks the owner before both native mutations', async () => {
    const { service, native, cwd } = setup(); let boundaries = 0;
    await expect(service.call('conversation/start', { cwd, text: '' }, context)).rejects.toMatchObject({ delivery: 'not_sent' }); expect(native.calls).toHaveLength(0);
    const result = object(await service.call('conversation/start', { cwd, text: 'first message' }, { ...context, beforeWrite: () => boundaries++ }));
    expect(object(result.thread).id).toBe('created-thread'); expect(object(result.turn).id).toBe('turn-1'); expect(boundaries).toBe(2); expect(native.calls.map(call => call.method)).toEqual(['thread/start', 'thread/read', 'turn/start']);
  });
  test.each(['client_disconnected', 'gateway_disconnected'])('conversation creation retains partial identity without sending its first turn after %s', async code => {
    const { service, native, cwd } = setup(); const owner = { ...context, eventChannelId: 'channel' }; let revoked = false; let checks = 0;
    const attachmentId = object(await service.call('attachment/upload', { name: 'unsent.txt', base64: 'dW5zZW50' }, owner)).attachmentId!;
    let unblock!: () => void; native.readGate = new Promise(resolve => { unblock = resolve; });
    const pending = service.call('conversation/start', { cwd, text: 'first message', attachmentIds: [attachmentId] }, { ...owner, beforeWrite: () => { checks++; if (revoked) throw new DeliveryError(code, 'Owner was revoked'); } });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'conversation_start_incomplete', delivery: 'unknown', data: { phase: 'first_turn', threadId: 'created-thread', causeCode: code, causeDelivery: 'not_sent' } });
    await expect.poll(() => native.calls.some(call => call.method === 'thread/read')).toBe(true); revoked = true;
    if (code === 'client_disconnected') await service.clientDisconnected(owner.clientId, owner.eventChannelId); else await service.gatewayDisconnected(owner.eventChannelId);
    unblock(); await rejected;
    expect(checks).toBe(2); expect(native.calls.map(call => call.method)).toEqual(['thread/start', 'thread/read']);
    expect(object(object(service.status()).activity)).toMatchObject({ unknown: false, activeThreads: [] });
    await expect(service.call('attachment/remove', { attachmentId }, context)).resolves.toEqual({});
  });
  test('a created conversation whose first turn is rejected remains unknown with partial thread identity', async () => {
    const { service, native, cwd } = setup(); native.beforeNativeWrite = method => { if (method === 'turn/start') throw new DeliveryError('fixture_rejection', 'first turn rejected'); };
    await expect(service.call('conversation/start', { cwd, text: 'first message' }, context)).rejects.toMatchObject({ code: 'conversation_start_incomplete', delivery: 'unknown', data: { phase: 'first_turn', threadId: 'created-thread', causeDelivery: 'not_sent' } });
    expect(object(object(service.status()).activity)).toMatchObject({ unknown: false, activeThreads: [] });
    expect(await service.call('thread/history', { threadId: 'created-thread' }, context)).toMatchObject({ complete: true, turns: [] });
  });
  test('parallel new operations cannot enter the same thread', async () => {
    const { service, native } = setup(); await service.call('thread/history', { threadId: 't' }, context); let unblock!: () => void; native.readGate = new Promise(resolve => { unblock = resolve; });
    const first = service.call('turn/start', { threadId: 't', text: 'first' }, context);
    await expect(service.call('turn/start', { threadId: 't', text: 'second' }, { clientId: 'client-b' })).rejects.toMatchObject({ code: 'thread_busy', delivery: 'not_sent' });
    unblock(); await first; expect(native.calls.filter(call => call.method === 'turn/start')).toHaveLength(1);
    expect(object(native.calls.find(call => call.method === 'turn/start')!.params).input).toEqual([{ type: 'text', text: 'first', text_elements: [] }]);
  });
  test.each(['metadata', 'notification'])('an idle %s cannot release a known in-progress turn before its matching completion', async source => {
    const { service, native, cwd } = setup(); const owner = { ...context, beforeWrite: () => {} };
    const created = object(await service.call('conversation/start', { cwd, text: 'first' }, owner)), threadId = object(created.thread).id!, turnId = object(created.turn).id!;
    await service.call('thread/history', { threadId }, owner);
    if (source === 'metadata') await service.call('thread/read', { threadId }, owner);
    else native.emit('notification', { method: 'thread/status/changed', params: { threadId, status: { type: 'idle' } } });
    await expect(service.call('turn/start', { threadId, text: 'must wait' }, owner)).rejects.toMatchObject({ code: 'thread_busy', delivery: 'not_sent' });
    expect(object(service.status()).activity).toMatchObject({ activeThreads: [threadId], unknown: false });
    await expect(service.call('thread/memoryMode/set', { threadId, mode: 'disabled' }, owner)).rejects.toMatchObject({ code: 'thread_busy', delivery: 'not_sent' });
    await expect(service.call('nativeProject/import', { name: 'Must wait', roots: [{ path: cwd }], threadIds: [], idempotencyKey: 'fixture-import' }, owner)).rejects.toMatchObject({ code: 'activity_busy', delivery: 'not_sent' });
    await expect(service.call('memory/reset', { confirm: true }, owner)).rejects.toMatchObject({ code: 'activity_busy', delivery: 'not_sent' });
    expect(native.calls.filter(call => ['turn/start', 'thread/memoryMode/set', 'project/import', 'memory/reset'].includes(call.method)).map(call => call.method)).toEqual(['turn/start']);
    native.emit('notification', { method: 'turn/completed', params: { threadId, turn: { id: 'different-turn', status: 'completed' } } });
    await expect(service.call('turn/start', { threadId, text: 'still must wait' }, owner)).rejects.toMatchObject({ code: 'thread_busy' });
    native.emit('notification', { method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
    expect(object(service.status()).activity).toMatchObject({ activeThreads: [], unknown: false });
    await expect(service.call('turn/start', { threadId, text: 'after completion' }, owner)).resolves.toMatchObject({ turn: { status: 'inProgress' } });
    expect(native.calls.filter(call => call.method === 'turn/start')).toHaveLength(2);
  });
  test('completion cannot clear an unknown outcome and a fresh runtime epoch can recover from native history', async () => {
    const { service, native, cwd } = setup(); native.turnError = new DeliveryError('fixture_lost', 'fixture', 'unknown');
    await expect(service.call('conversation/start', { cwd, text: 'uncertain' }, context)).rejects.toMatchObject({ code: 'conversation_start_incomplete' });
    await service.call('thread/read', { threadId: 'created-thread' }, context);
    for (const method of ['turn/started', 'turn/completed']) native.emit('notification', { method, params: { threadId: 'created-thread', turn: { id: 'observed', status: method === 'turn/started' ? 'inProgress' : 'completed' } } });
    await expect(service.call('turn/start', { threadId: 'created-thread', text: 'no retry' }, context)).rejects.toMatchObject({ code: 'activity_unknown' });
    const oldEpoch = object(service.status()).epoch; await service.close();
    const recovered = setup(); expect(object(recovered.service.status()).epoch).not.toBe(oldEpoch);
    await expect(recovered.service.call('turn/start', { threadId: 'created-thread', text: 'read history first' }, context)).rejects.toMatchObject({ code: 'history_incomplete' });
    await recovered.service.call('thread/history', { threadId: 'created-thread' }, context);
    await expect(recovered.service.call('turn/start', { threadId: 'created-thread', text: 'recovered' }, context)).resolves.toMatchObject({ turn: { status: 'inProgress' } });
  });
  test('native active event at the final write boundary prevents a second turn', async () => {
    const { service, native } = setup(); await service.call('thread/history', { threadId: 't' }, context); native.beforeNativeWrite = method => { if (method === 'turn/start') native.emit('notification', { method: 'thread/status/changed', params: { threadId: 't', status: { type: 'active', activeFlags: [] } } }); };
    await expect(service.call('turn/start', { threadId: 't', text: 'hello' }, context)).rejects.toMatchObject({ code: 'thread_busy', delivery: 'not_sent' });
    expect(native.calls.filter(call => call.method === 'turn/start')).toHaveLength(0);
  });
  test('invalid approval remains pending and valid answer preserves native request id', async () => {
    const { service, native, events } = setup(); native.emit('request', { id: 'native-request', method: 'item/fileChange/requestApproval', params: { threadId: 't', turnId: 'u', itemId: 'i', reason: null, grantRoot: null } });
    const id = object(events.find(event => event.type === 'prompt')!.data).promptId!;
    await expect(service.call('prompt/answer', { promptId: id, response: { decision: 'yes' } }, context)).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(object(await service.call('prompt/list', {}, context)).prompts).toHaveLength(1); expect(native.responses).toHaveLength(0);
    await service.call('prompt/answer', { promptId: id, response: { decision: 'accept' } }, context); expect(native.responses).toEqual([{ id: 'native-request', result: { decision: 'accept' } }]); expect(object(await service.call('prompt/list', {}, context)).prompts).toHaveLength(0);
  });
  test('incomplete permission restrictions remain pending without dispatching a response', async () => {
    const { service, native, events } = setup();
    const entries = [{ path: { type: 'path', path: '/fixture' }, access: 'write' }, { path: { type: 'path', path: '/fixture/reference' }, access: 'read' }, { path: { type: 'path', path: '/fixture/private' }, access: 'deny' }];
    const permissions = { fileSystem: { entries } };
    native.emit('request', { id: 'permissions-request', method: 'item/permissions/requestApproval', params: { threadId: 't', turnId: 'u', itemId: 'i', permissions } });
    const promptId = object(events.find(event => event.type === 'prompt')!.data).promptId!;
    for (const granted of [[entries[0]!, entries[2]!], [entries[0]!, entries[1]!]]) {
      await expect(service.call('prompt/answer', { promptId, response: { permissions: { fileSystem: { entries: granted } }, scope: 'turn' } }, context)).rejects.toMatchObject({ code: 'invalid_params', delivery: 'not_sent' });
      expect(native.responses).toEqual([]); expect(object(await service.call('prompt/list', {}, context)).prompts).toHaveLength(1);
    }
    const response = { permissions, scope: 'turn' };
    await service.call('prompt/answer', { promptId, response }, context);
    expect(native.responses).toEqual([{ id: 'permissions-request', result: response }]);
    expect(native.responses[0]!.result).toBe(response); expect(object(await service.call('prompt/list', {}, context)).prompts).toEqual([]);
  });
  test('history preserves a long opaque cursor and refuses loops without publishing a false complete result', async () => {
    const { service, native } = setup(); const cursor = 'x'.repeat(1007); native.page = { data: [{ id: '2', items: [], itemsView: 'full' }, { id: '1', items: [], itemsView: 'full' }], nextCursor: cursor, backwardsCursor: null };
    const first = object(await service.call('thread/history', { threadId: 't' }, context)); expect(first.turns).toEqual([{ id: '1', items: [], itemsView: 'full' }, { id: '2', items: [], itemsView: 'full' }]); expect(first.complete).toBe(false);
    native.page = { data: [], nextCursor: cursor, backwardsCursor: null };
    await expect(service.call('thread/history', { threadId: 't', cursor: first.nextCursor! }, context)).rejects.toMatchObject({ code: 'cursor_loop' }); expect(object(native.calls.at(-1)!.params).cursor).toBe(cursor);
  });
  test('legacy history uses full read and does not call unsupported pagination', async () => {
    const { service, native } = setup(); native.historyMode = 'legacy'; expect(object(await service.call('thread/history', { threadId: 't' }, context))).toMatchObject({ complete: true, legacy: true }); expect(native.calls.some(call => call.method === 'thread/turns/list')).toBe(false);
  });
  test('terminal open returns before final exit, enforces owner, and disconnect terminates it', async () => {
    const { service, native, events, cwd } = setup(); const opened = object(await service.call('terminal/open', { cwd }, context)); const terminalId = opened.terminalId!;
    await expect(service.call('terminal/write', { terminalId, text: 'hello' }, { clientId: 'other' })).rejects.toMatchObject({ code: 'not_found' });
    await service.call('terminal/write', { terminalId, text: '\n' }, context); expect(object(native.calls.at(-1)!.params).deltaBase64).toBe('Cg==');
    await service.clientDisconnected(context.clientId); expect(native.calls.at(-1)!.method).toBe('command/exec/terminate'); expect(events.some(event => event.type === 'terminal' && object(event.data).type === 'exit')).toBe(true);
  });
  test('event channels isolate identical client ids, terminal cleanup, and history admission', async () => {
    const { service, native, events, cwd } = setup();
    const first = { clientId: 'same-client', eventChannelId: 'channel-a' }, second = { clientId: 'same-client', eventChannelId: 'channel-b' };
    const a = object(await service.call('terminal/open', { cwd }, first)), b = object(await service.call('terminal/open', { cwd }, second));
    await expect(service.call('terminal/write', { terminalId: a.terminalId!, text: 'wrong channel' }, second)).rejects.toMatchObject({ code: 'not_found' });
    native.emit('notification', { method: 'command/exec/outputDelta', params: { processId: b.terminalId, deltaBase64: 'Yg==', stream: 'stdout', capReached: false } });
    expect(events.find(event => event.type === 'terminal' && object(event.data).type === 'output')?.eventChannelId).toBe(second.eventChannelId);
    await service.call('thread/history', { threadId: 't' }, first); await service.call('thread/history', { threadId: 't' }, second);
    await service.gatewayDisconnected(first.eventChannelId);
    expect(native.calls.filter(call => call.method === 'command/exec/terminate').map(call => object(call.params).processId)).toEqual([a.terminalId]);
    await expect(service.call('turn/start', { threadId: 't', text: 'stale history' }, first)).rejects.toMatchObject({ code: 'history_incomplete' });
    await service.call('terminal/write', { terminalId: b.terminalId!, text: 'still live' }, second);
    await service.call('turn/start', { threadId: 't', text: 'current history' }, second);
  });
  test('attachment capability survives administrator tab replacement and keeps referenced bytes', async () => {
    const { service } = setup(); const upload = object(await service.call('attachment/upload', { name: 'data.txt', mimeType: 'text/plain', base64: 'aGVsbG8=' }, context)); const attachmentId = upload.attachmentId!;
    expect(object(await service.call('attachment/read', { attachmentId }, { clientId: 'replacement-tab' })).base64).toBe('aGVsbG8=');
    await expect(service.call('attachment/read', { attachmentId: '/arbitrary/path' }, context)).rejects.toMatchObject({ code: 'not_found' });
    await service.call('thread/history', { threadId: 't' }, { clientId: 'replacement-tab' });
    await service.call('turn/start', { threadId: 't', text: '', attachmentIds: [attachmentId] }, { clientId: 'replacement-tab' });
    await expect(service.call('attachment/remove', { attachmentId }, context)).rejects.toMatchObject({ code: 'attachment_in_use' });
    expect(object(await service.call('attachment/read', { attachmentId, threadId: 't' }, { clientId: 'other' })).base64).toBe('aGVsbG8=');
  });
  test('requires full item hydration and a continuous complete traversal for the same client', async () => {
    const { service, native } = setup();
    for (const itemsView of ['notLoaded', 'summary', null]) {
      native.page = { data: [{ id: 'turn', items: [], ...(itemsView ? { itemsView } : {}) }], nextCursor: null, backwardsCursor: null };
      await expect(service.call('thread/history', { threadId: 't' }, context)).rejects.toMatchObject({ code: 'invalid_native_response' });
      await expect(service.call('turn/start', { threadId: 't', text: 'blocked' }, context)).rejects.toMatchObject({ code: 'history_incomplete' });
    }
    native.page = { data: [{ id: 'recent', items: [], itemsView: 'full' }], nextCursor: '', backwardsCursor: null };
    const first = object(await service.call('thread/history', { threadId: 't' }, context)); expect(first).toMatchObject({ complete: false });
    await expect(service.call('thread/history', { threadId: 't', cursor: 'unvisited' }, context)).rejects.toMatchObject({ code: 'invalid_cursor' });
    await expect(service.call('turn/start', { threadId: 't', text: 'blocked' }, context)).rejects.toMatchObject({ code: 'history_incomplete' });
    native.page = { data: [{ id: 'old', items: [], itemsView: 'full' }], nextCursor: null, backwardsCursor: null };
    await service.call('thread/history', { threadId: 't', cursor: first.nextCursor! }, context);
    await expect(service.call('turn/start', { threadId: 't', text: 'other client' }, { clientId: 'other' })).rejects.toMatchObject({ code: 'history_incomplete' });
    await service.call('turn/start', { threadId: 't', text: 'allowed' }, context);
    expect(native.calls.filter(call => call.method === 'turn/start')).toHaveLength(1);
  });
  test('releases disconnected traversal capacity and fences a late response and final turn write', async () => {
    const { service, native } = setup();
    for (let i = 0; i < 257; i++) { const clientId = `client-${i}`; await service.call('thread/history', { threadId: 't' }, { clientId }); await service.clientDisconnected(clientId); }
    let unblock!: () => void; native.pageGate = new Promise(resolve => { unblock = resolve; });
    const pending = service.call('thread/history', { threadId: 't' }, context); const rejected = expect(pending).rejects.toMatchObject({ code: 'history_stale' });
    await service.clientDisconnected(context.clientId); unblock(); await rejected; delete native.pageGate;
    await expect(service.call('turn/start', { threadId: 't', text: 'stale' }, context)).rejects.toMatchObject({ code: 'history_incomplete' });
    await service.call('thread/history', { threadId: 't' }, context);
    native.beforeNativeWrite = method => { if (method === 'turn/start') void service.clientDisconnected(context.clientId); };
    await expect(service.call('turn/start', { threadId: 't', text: 'disconnected' }, context)).rejects.toMatchObject({ code: 'history_incomplete', delivery: 'not_sent' });
    expect(native.calls.filter(call => call.method === 'turn/start')).toHaveLength(0);
  });
  test('an older history completion cannot supersede a newer incomplete traversal', async () => {
    const { service, native } = setup(); await service.call('thread/read', { threadId: 't' }, context);
    let unblock!: () => void; native.pageGate = new Promise(resolve => { unblock = resolve; });
    const pending = service.call('thread/history', { threadId: 't' }, context); const rejected = expect(pending).rejects.toMatchObject({ code: 'history_stale' });
    delete native.pageGate; native.page = { data: [], nextCursor: 'next', backwardsCursor: null };
    await service.call('thread/history', { threadId: 't' }, context); unblock(); await rejected;
    await expect(service.call('turn/start', { threadId: 't', text: 'stale' }, context)).rejects.toMatchObject({ code: 'history_incomplete' });
  });
  test('only definitive rejected turns release newly reserved attachments', async () => {
    for (const delivery of ['not_sent', 'unknown'] as const) {
      const { service, native } = setup(); await service.call('thread/history', { threadId: 't' }, context);
      const upload = object(await service.call('attachment/upload', { name: 'rejected.txt', base64: 'Zml4dHVyZQ==' }, context));
      native.turnError = new DeliveryError('fixture_rejection', 'fixture', delivery);
      await expect(service.call('turn/start', { threadId: 't', attachmentIds: [upload.attachmentId!] }, context)).rejects.toMatchObject({ delivery });
      if (delivery === 'not_sent') await expect(service.call('attachment/remove', { attachmentId: upload.attachmentId! }, context)).resolves.toEqual({});
      else await expect(service.call('attachment/remove', { attachmentId: upload.attachmentId! }, context)).rejects.toMatchObject({ code: 'attachment_in_use' });
    }
  });
  test('a definitively rejected first native turn remains fresh and does not publish unknown activity', async () => {
    const { service, native, cwd } = setup(); native.turnError = new DeliveryError('fixture_rejection', 'fixture', 'not_sent');
    await expect(service.call('conversation/start', { cwd, text: 'first' }, context)).rejects.toMatchObject({ code: 'conversation_start_incomplete', delivery: 'unknown', data: { causeDelivery: 'not_sent' } });
    expect(object(object(service.status()).activity)).toMatchObject({ unknown: false, activeThreads: [] });
    expect(await service.call('thread/history', { threadId: 'created-thread' }, context)).toMatchObject({ complete: true, turns: [] });
  });
  test('an uncertain first turn retains its activity barrier and cannot use the fresh-thread shortcut', async () => {
    const { service, native, cwd } = setup(); native.turnError = new DeliveryError('fixture_lost', 'fixture', 'unknown');
    await expect(service.call('conversation/start', { cwd, text: 'first' }, context)).rejects.toMatchObject({ code: 'conversation_start_incomplete', data: { causeDelivery: 'unknown' } });
    expect(object(object(service.status()).activity)).toMatchObject({ unknown: true, activeThreads: ['created-thread'] });
    await expect(service.call('turn/start', { threadId: 'created-thread', text: 'no retry' }, context)).rejects.toMatchObject({ code: 'activity_unknown' });
  });
  test('late rejection and status-only activity cannot restore empty-history creation provenance', async () => {
    const { service, native, cwd } = setup(); await service.call('thread/start', { cwd }, context);
    native.beforeNativeWrite = method => {
      if (method !== 'thread/read') return;
      native.emit('notification', { method: 'turn/started', params: { threadId: 'created-thread', turn: { id: 'observed' } } });
      native.emit('notification', { method: 'turn/completed', params: { threadId: 'created-thread', turn: { id: 'observed', status: 'completed' } } });
      throw new DeliveryError('fixture_rejection', 'metadata read rejected');
    };
    await expect(service.call('turn/start', { threadId: 'created-thread', text: 'rejected' }, context)).rejects.toMatchObject({ delivery: 'not_sent' });
    delete native.beforeNativeWrite;
    native.page = { data: [{ id: 'observed', items: [], itemsView: 'full' }], nextCursor: null, backwardsCursor: null };
    expect(await service.call('thread/history', { threadId: 'created-thread' }, context)).toMatchObject({ turns: [{ id: 'observed' }] });
    const second = setup(); await second.service.call('thread/start', { cwd: second.cwd }, context);
    for (const type of ['active', 'idle']) second.native.emit('notification', { method: 'thread/status/changed', params: { threadId: 'created-thread', status: { type } } });
    second.native.page = native.page;
    expect(await second.service.call('thread/history', { threadId: 'created-thread' }, context)).toMatchObject({ turns: [{ id: 'observed' }] });
  });
  test('read-only resume refuses configuration overrides before issuing any RPC', async () => {
    const { service, native } = setup();
    await expect(service.call('thread/resume', { threadId: 't', options: { sandbox: 'danger-full-access' } }, context)).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(native.calls).toHaveLength(0);
  });
});
describe('official approval responses and form semantics', () => {
  test('required empty string, zero and false remain valid and missing required fields fail', () => {
    const params = { mode: 'form', requestedSchema: { type: 'object', properties: { empty: { type: 'string', enum: ['', 'other'] }, flag: { type: 'boolean' }, count: { type: 'integer', minimum: 0 }, values: { type: 'array', items: { type: 'string' }, minItems: 0 } }, required: ['empty', 'flag', 'count', 'values'], additionalProperties: false } };
    expect(() => validatePrompt('mcpServer/elicitation/request', params, { action: 'accept', content: { empty: '', flag: false, count: 0, values: [] }, _meta: null })).not.toThrow();
    expect(() => validatePrompt('mcpServer/elicitation/request', params, { action: 'accept', content: { flag: false, count: 0, values: [] }, _meta: null })).toThrow(DeliveryError);
  });
  test('unsupported schemas/extensions can be canceled but cannot be accepted', () => {
    const params = { mode: 'openai/form', requestedSchema: { type: 'object' } };
    expect(() => validatePrompt('mcpServer/elicitation/request', params, { action: 'accept', content: {}, _meta: null })).toThrow();
    expect(() => validatePrompt('mcpServer/elicitation/request', params, { action: 'cancel', content: null, _meta: null })).not.toThrow();
    expect(() => validatePrompt('mcpServer/elicitation/request', params, { action: 'cancel' })).not.toThrow();
    expect(() => validatePrompt('mcpServer/elicitation/request', { mode: 'url' }, { action: 'accept' })).not.toThrow();
  });
  test('permission grants cannot add paths; omitted grants and null requested fields are preserved', () => {
    const params = { permissions: { network: { enabled: true }, fileSystem: { read: ['/a'], write: null } } };
    expect(() => validatePrompt('item/permissions/requestApproval', params, { permissions: {}, scope: 'turn' })).not.toThrow();
    expect(() => validatePrompt('item/permissions/requestApproval', params, { permissions: { fileSystem: { read: null, write: null } }, scope: 'turn' })).not.toThrow();
    expect(() => validatePrompt('item/permissions/requestApproval', params, { permissions: { fileSystem: { read: ['/a'], write: null, globScanMaxDepth: 1 } }, scope: 'turn' })).toThrow();
    expect(() => validatePrompt('item/permissions/requestApproval', params, { permissions: { fileSystem: { read: ['/a'], write: null, globScanMaxDepth: null } }, scope: 'turn' })).not.toThrow();
    expect(() => validatePrompt('item/permissions/requestApproval', { permissions: { fileSystem: { read: ['/a'], globScanMaxDepth: 1 } } }, { permissions: { fileSystem: { read: ['/a'], globScanMaxDepth: 1 } }, scope: 'turn' })).not.toThrow();
    expect(() => validatePrompt('item/permissions/requestApproval', params, { permissions: { fileSystem: { read: ['/a'], write: null, globScanMaxDepth: 0 } }, scope: 'turn' })).toThrow();
    expect(() => validatePrompt('item/permissions/requestApproval', params, { permissions: { fileSystem: { read: ['/b'], write: null } }, scope: 'turn' })).toThrow();
  });
});
