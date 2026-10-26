import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Ledger } from '../../src/core/ledger.js';
import { HarnessError } from '../../src/core/errors.js';
import type { CallContext, JsonObject, JsonValue, WorkerPort } from '../../src/core/contracts.js';
import { Dispatcher } from '../../src/gateway/dispatch.js';
import type { ManagerPort } from '../../src/gateway/manager-client.js';
import { digest } from '../../src/core/validation.js';

class Worker implements WorkerPort {
  connected = true; calls = 0;
  run: (method: string, params: JsonObject, context: CallContext) => Promise<JsonValue> = async (_m, _p, c) => { c.beforeWrite?.(); return { turn: { id: 'turn', status: 'inProgress' } }; };
  async call(method: string, params: JsonObject, context: CallContext): Promise<JsonValue> { this.calls++; return this.run(method, params, context); }
}
function setup() {
  const ledger = new Ledger(':memory:'); const worker = new Worker();
  const manager: ManagerPort = { call: async (_m, _p, _id, before) => { before?.(); return {}; } };
  const dispatcher = new Dispatcher(ledger, worker, manager);
  dispatcher.event({ type: 'state', data: { epoch: 'one', connected: true, activity: { activeThreads: [], pendingStarts: 0, terminals: 0, unknown: false } } });
  return { ledger, worker, dispatcher, manager };
}
describe('gateway operation admission', () => {
  it('live voice frames require a connection and never create a durable payload or operation replay', async () => {
    const { ledger, worker, dispatcher } = setup(); const operationId = randomUUID(); let checked = 0;
    worker.run = async (_method, params) => ({ sequence: params.sequence! });
    try {
      expect(await dispatcher.call({ method: 'thread/realtime/appendText', params: { sessionHandle: 'session', sequence: 0, text: 'private audio context', role: 'user' }, operationId }, { clientId: 'owner', requireConnection: () => { checked++; } })).toEqual({ sequence: 0 });
      expect(checked).toBe(1); expect(ledger.read(operationId)).toBeNull();
    } finally { ledger.close(); }
  });
  it('native project roots resolve only registered harness IDs and never become execution project IDs', async () => {
    const { ledger, worker, dispatcher } = setup(); const registered = ledger.addProject(path.resolve('.work/registered-native-project'), 'Registered'); let forwarded: JsonObject | undefined;
    worker.run = async (_method, params, context) => { context.beforeWrite?.(); forwarded = params; return { project: { id: 'native-id', roots: params.roots, metadata: { secret: 'not in receipt' } } }; };
    const call = (params: JsonObject) => dispatcher.call({ method: 'nativeProject/create', params, operationId: randomUUID() }, { clientId: 'owner' });
    try {
      expect(await call({ name: 'Organization', projectIds: [registered.id], idempotencyKey: 'stable' })).toEqual({ project: { id: 'native-id' } });
      expect(forwarded).toEqual({ name: 'Organization', roots: [{ path: path.normalize(registered.path) }], idempotencyKey: 'stable' }); expect(ledger.projects()).toHaveLength(1);
      for (const invalid of [{ roots: [{ path: '/arbitrary' }] }, { projectIds: [registered.id], roots: [] }, { projectIds: [registered.id], cwd: '/override' }, { projectIds: [registered.id, registered.id] }, { projectIds: ['native-id'] }]) await expect(call({ name: 'Invalid', idempotencyKey: 'key', ...invalid })).rejects.toMatchObject({ delivery: 'not_sent' });
      expect(worker.calls).toBe(1);
    } finally { ledger.close(); }
  });
  it('open MCP subscriptions block management changes while ordinary task starts remain admitted', async () => {
    const { ledger, dispatcher } = setup();
    dispatcher.event({ type: 'state', data: { epoch: 'one', connected: true, activity: { activeThreads: [], pendingStarts: 0, terminals: 0, subscriptions: 1, unknown: false } } });
    try {
      await expect(dispatcher.call({ operationId: randomUUID(), method: 'system/provider/write', params: { kind: 'chatgpt' } }, { clientId: 'c' })).rejects.toMatchObject({ code: 'activity_busy' });
      await expect(dispatcher.call({ operationId: randomUUID(), method: 'mcp/reload', params: {} }, { clientId: 'c' })).rejects.toMatchObject({ code: 'activity_busy' });
      expect(await dispatcher.call({ operationId: randomUUID(), method: 'turn/start', params: { threadId: 't', text: 'continue' } }, { clientId: 'c' })).toMatchObject({ turn: { id: 'turn' } });
    } finally { ledger.close(); }
  });
  it('recovers a lost file acknowledgement only from a matching supervisor witness, without resending the write', async () => {
    const { ledger, worker, dispatcher } = setup(); const project = ledger.addProject('/registered', 'Project'); const operationId = randomUUID();
    let binding: CallContext | undefined; let proof: JsonObject = {}; const methods: string[] = [];
    worker.run = async (method, _params, context) => { methods.push(method); if (method === 'workspace/witness/read') return proof; context.beforeWrite?.(); binding = context; throw new HarnessError('lost', 'lost response', 'unknown'); };
    try {
      await expect(dispatcher.call({ method: 'workspace/write', operationId, params: { projectId: project.id, path: 'a', text: 'secret', expectedRevision: null } }, { clientId: 'c' })).rejects.toMatchObject({ delivery: 'unknown' });
      expect(binding).toMatchObject({ projectId: project.id, gatewayRequestDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
      proof = { operationId, state: 'completed', method: 'workspace/write', projectId: project.id, gatewayRequestDigest: '0'.repeat(64), result: { path: 'a', revision: 'b'.repeat(64), bytes: 6, recoveryOperationId: operationId } };
      expect(await dispatcher.call({ method: 'operation/read', params: { operationId } }, { clientId: 'c' })).toMatchObject({ state: 'unknown' });
      proof.gatewayRequestDigest = binding!.gatewayRequestDigest!;
      expect(await dispatcher.call({ method: 'operation/read', params: { operationId } }, { clientId: 'c' })).toMatchObject({ state: 'accepted', result: proof.result });
      expect(ledger.getMeta('activityUncertain')).toBe('false'); expect(methods.filter(method => method === 'workspace/write')).toHaveLength(1);
    } finally { ledger.close(); }
  });
  it('confirmation of one file write does not clear another unresolved operation', async () => {
    const { ledger } = setup(); const first = randomUUID(), other = randomUUID();
    try {
      const body = { method: 'workspace/mkdir', params: { projectId: 'p', path: 'dir' } };
      ledger.reserve(first, body.method, body.params, 'project:p'); ledger.dispatch(first); ledger.settle(first, { ok: false, error: { code: 'lost', message: 'lost', delivery: 'unknown' } });
      ledger.reserve(other, 'turn/start', {}, 'thread:t'); ledger.dispatch(other); ledger.settle(other, { ok: false, error: { code: 'lost', message: 'lost', delivery: 'unknown' } });
      // A different request digest cannot update this row, and must not clear ambiguity.
      expect(ledger.confirmWorkspace(first, body.method, 'project:p', '0'.repeat(64), { path: 'dir', created: true }).state).toBe('unknown');
      expect(ledger.getMeta('activityUncertain')).toBe('true');
      expect(ledger.confirmWorkspace(first, body.method, 'project:p', digest(body), { path: 'dir', created: true }).state).toBe('accepted');
      expect(ledger.getMeta('activityUncertain')).toBe('true'); expect(ledger.read(other)?.state).toBe('unknown');
    } finally { ledger.close(); }
  });
  it.each(['restore', 'discard'])('recovery %s uses registered project scope and can reconcile only its matching witness', async action => {
    const { ledger, worker, dispatcher } = setup(); const project = ledger.addProject('/registered', 'Project'); const operationId = randomUUID(), source = randomUUID();
    const method = 'workspace/recovery/' + action;
    const params: JsonObject = action === 'restore' ? { projectId: project.id, recoveryOperationId: source, slot: 'before', path: 'restored', sourceRevision: 'a'.repeat(64), expectedRevision: null } : { projectId: project.id, recoveryOperationId: source, expectedManifest: 'a'.repeat(64), confirm: true };
    const result: JsonObject = action === 'restore' ? { path: 'restored', kind: 'file', revision: 'b'.repeat(64), bytes: 3, restoredFromOperationId: source, recoveryOperationId: operationId } : { recoveryOperationId: source, discarded: true, receiptRetained: true };
    let binding: CallContext | undefined; let proof: JsonObject = {}; let sent = 0;
    worker.run = async (called, forwarded, context) => { if (called === 'workspace/witness/read') return proof; expect(forwarded.cwd).toBe('/registered'); expect(forwarded).not.toHaveProperty('projectId'); context.beforeWrite?.(); binding = context; sent++; throw new HarnessError('lost', 'lost response', 'unknown'); };
    try {
      await expect(dispatcher.call({ method, operationId, params }, { clientId: 'c' })).rejects.toMatchObject({ delivery: 'unknown' });
      proof = { operationId, state: 'completed', method, projectId: randomUUID(), gatewayRequestDigest: binding!.gatewayRequestDigest!, result };
      expect(await dispatcher.call({ method: 'operation/read', params: { operationId } }, { clientId: 'c' })).toMatchObject({ state: 'unknown' });
      proof.projectId = project.id;
      expect(await dispatcher.call({ method: 'operation/read', params: { operationId } }, { clientId: 'c' })).toMatchObject({ state: 'accepted', result });
      expect(sent).toBe(1);
    } finally { ledger.close(); }
  });
  it('allows an owned steer of active work but blocks a second task start and destructive history change', async () => {
    const { ledger, worker, dispatcher } = setup(); const calls: string[] = [];
    dispatcher.event({ type: 'state', data: { epoch: 'one', connected: true, activity: { activeThreads: ['t'], pendingStarts: 0, terminals: 0, unknown: false } } });
    worker.run = async (method, _p, context) => { calls.push(method); context.beforeWrite?.(); return { turnId: 'active' }; };
    try {
      const steer = { method: 'turn/steer', params: { threadId: 't', expectedTurnId: 'active', text: 'addition' }, operationId: randomUUID() };
      expect(await dispatcher.call(steer, { clientId: 'owner' })).toEqual({ turnId: 'active' });
      expect(await dispatcher.call(steer, { clientId: 'owner', requireConnection: () => { throw new Error('lease gone'); } })).toEqual({ turnId: 'active' });
      for (const method of ['thread/queue/start', 'review/start', 'thread/revert', 'thread/fork'])
        await expect(dispatcher.call({ method, params: { threadId: 't' }, operationId: randomUUID() }, { clientId: 'owner' })).rejects.toMatchObject({ code: 'thread_busy', delivery: 'not_sent' });
      expect(calls).toEqual(['turn/steer']);
    } finally { ledger.close(); }
  });
  it('resolves new review cwd from the registered project and rejects client overrides', async () => {
    const { ledger, worker, dispatcher } = setup(); const project = ledger.addProject('/registered', 'Project'); let input: JsonObject | undefined;
    worker.run = async (_method, params, context) => { input = params; context.beforeWrite?.(); return { thread: { id: 'review-thread' }, turn: { id: 'review-turn' }, reviewThreadId: 'review-thread' }; };
    try {
      const target = { type: 'uncommittedChanges' };
      await expect(dispatcher.call({ method: 'review/startNew', operationId: randomUUID(), params: { projectId: project.id, cwd: '/injected', target } }, { clientId: 'owner' })).rejects.toMatchObject({ delivery: 'not_sent' });
      expect(worker.calls).toBe(0);
      await dispatcher.call({ method: 'review/startNew', operationId: randomUUID(), params: { projectId: project.id, target } }, { clientId: 'owner' });
      expect(input).toEqual({ cwd: '/registered', target });
    } finally { ledger.close(); }
  });
  it.each([false, true])('publishes the released maintenance state after management settles (failed=%s)', async failed => {
    const { ledger, dispatcher, manager } = setup(); const states: Record<string, unknown>[] = [];
    dispatcher.on('event', event => { if (event.type === 'state') states.push(event.data); });
    manager.call = async (_m, _p, _id, before) => { before?.(); if (failed) throw new HarnessError('discovery_failed', 'discovery failed'); return { kind: 'chatgpt', revision: 'a'.repeat(32), hasApiKey: false, source: 'provider', models: [], applied: false, requiresConfirmation: false }; };
    try {
      const operation = dispatcher.call({ operationId: randomUUID(), method: 'system/models/refresh', params: {} }, { clientId: 'c' });
      if (failed) await expect(operation).rejects.toMatchObject({ code: 'discovery_failed' }); else await operation;
      expect(states.some(state => state.maintenance === true)).toBe(true);
      expect(states.at(-1)).toMatchObject({ maintenance: false, activityUncertain: false });
      expect(states.at(-1)).toEqual(dispatcher.status());
    } finally { ledger.close(); }
  });
  it('blocks late arrival after an explicit fence, without treating absence alone as proof', async () => {
    const { ledger, worker, dispatcher } = setup(); const id = randomUUID();
    try {
      expect(await dispatcher.call({ method: 'operation/read', params: { operationId: id } }, { clientId: 'c' })).toMatchObject({ state: 'not_received' });
      expect(await dispatcher.call({ method: 'operation/retire', params: { operationId: id } }, { clientId: 'c' })).toMatchObject({ state: 'not_sent' });
      await expect(dispatcher.call({ method: 'turn/start', params: { threadId: 't', text: 'late' }, operationId: id }, { clientId: 'c' })).rejects.toMatchObject({ delivery: 'not_sent', code: 'operation_retired' });
      expect(worker.calls).toBe(0);
    } finally { ledger.close(); }
  });
  it('retains uncertainty when a dispatched mutation returns an invalid receipt', async () => {
    const { ledger, worker, dispatcher } = setup(); const id = randomUUID();
    worker.run = async (_m, _p, context) => { context.beforeWrite?.(); return { turn: {} }; };
    try {
      await expect(dispatcher.call({ operationId: id, method: 'turn/start', params: { threadId: 't', text: 'a' } }, { clientId: 'c' })).rejects.toMatchObject({ delivery: 'unknown' });
      expect(ledger.read(id)).toMatchObject({ state: 'unknown' });
      expect(worker.calls).toBe(1);
    } finally { ledger.close(); }
  });
  it('returns saved accepted results even after the backend is disconnected', async () => {
    const { ledger, worker, dispatcher } = setup();
    try {
      const call = { operationId: randomUUID(), method: 'turn/start', params: { threadId: 't', text: 'hello' } };
      const result = await dispatcher.call(call, { clientId: 'c' }); worker.connected = false; dispatcher.disconnected();
      expect(await dispatcher.call(call, { clientId: 'c' })).toEqual(result); expect(worker.calls).toBe(1);
    } finally { ledger.close(); }
  });
  it('serializes concurrent work before the first native response arrives', async () => {
    const { ledger, worker, dispatcher } = setup(); let finish!: (value: JsonValue) => void;
    worker.run = async (_m, _p, context) => { context.beforeWrite?.(); return new Promise(resolve => { finish = resolve; }); };
    const first = dispatcher.call({ operationId: randomUUID(), method: 'turn/start', params: { threadId: 't', text: 'a' } }, { clientId: 'a' });
    try {
      await expect(dispatcher.call({ operationId: randomUUID(), method: 'turn/start', params: { threadId: 't', text: 'b' } }, { clientId: 'b' })).rejects.toMatchObject({ code: 'thread_busy', delivery: 'not_sent' });
      expect(worker.calls).toBe(1); finish({ turn: { id: 'first' } }); await first;
    } finally { ledger.close(); }
  });
  it('persists ambiguity and blocks new work without blocking receipt inspection', async () => {
    const { ledger, worker, dispatcher } = setup(); const id = randomUUID();
    const events: unknown[] = []; dispatcher.on('event', value => events.push(value));
    worker.run = async (_m, _p, context) => { context.beforeWrite?.(); throw new HarnessError('lost', 'lost', 'unknown'); };
    try {
      await expect(dispatcher.call({ operationId: id, method: 'turn/start', params: { threadId: 't', text: 'a' } }, { clientId: 'c' })).rejects.toMatchObject({ delivery: 'unknown' });
      await expect(dispatcher.call({ operationId: randomUUID(), method: 'turn/start', params: { threadId: 'other', text: 'b' } }, { clientId: 'c' })).rejects.toMatchObject({ code: 'activity_unknown' });
      expect(await dispatcher.call({ method: 'operation/read', params: { operationId: id } }, { clientId: 'c' })).toMatchObject({ state: 'unknown' });
      expect(worker.calls).toBe(1);
      expect(events.at(-1)).toMatchObject({ type: 'state', data: { activityUncertain: true } });
      dispatcher.event({ type: 'state', data: { epoch: 'two', connected: true, activity: { activeThreads: [], pendingStarts: 0, terminals: 0, unknown: false } } });
      expect(events.at(-1)).toMatchObject({ type: 'state', data: { activityUncertain: true } });
    } finally { ledger.close(); }
  });
  it('does not let a missing observation erase a delayed accepted operation', async () => {
    const { ledger, dispatcher } = setup(); const id = randomUUID();
    try {
      expect(await dispatcher.call({ method: 'operation/read', params: { operationId: id } }, { clientId: 'c' })).toMatchObject({ state: 'not_received' });
      await dispatcher.call({ operationId: id, method: 'turn/start', params: { threadId: 't', text: 'a' } }, { clientId: 'c' });
      expect(await dispatcher.call({ method: 'operation/read', params: { operationId: id } }, { clientId: 'c' })).toMatchObject({ state: 'accepted' });
    } finally { ledger.close(); }
  });
  it('holds maintenance admission while an async management command runs', async () => {
    const { ledger, dispatcher, manager } = setup(); let finish!: (value: JsonValue) => void;
    manager.call = async (_m, _p, _id, before) => { before?.(); return new Promise(resolve => { finish = resolve; }); };
    const pending = dispatcher.call({ operationId: randomUUID(), method: 'system/provider/write', params: { kind: 'chatgpt', expectedRevision: 'old' } }, { clientId: 'c' });
    try {
      await expect(dispatcher.call({ operationId: randomUUID(), method: 'turn/start', params: { threadId: 't', text: 'a' } }, { clientId: 'c' })).rejects.toMatchObject({ code: 'maintenance' });
      finish({ kind: 'chatgpt', revision: 'a'.repeat(32), hasApiKey: false, models: [] }); await pending;
    } finally { ledger.close(); }
  });
  it('allows explicit restart to recover stale activity while configuration changes remain blocked', async () => {
    const { ledger, dispatcher, manager } = setup(); let calls = 0;
    manager.call = async (_m, _p, _id, before) => { calls++; before?.(); return { restarted: true, release: 'a'.repeat(64) }; };
    dispatcher.event({ type: 'state', data: { epoch: 'lost', connected: false, activity: { activeThreads: ['uncertain'], pendingStarts: 1, terminals: 1, unknown: true } } });
    try {
      await expect(dispatcher.call({ operationId: randomUUID(), method: 'system/provider/write', params: { kind: 'chatgpt' } }, { clientId: 'c' })).rejects.toMatchObject({ code: 'activity_unknown' });
      expect(await dispatcher.call({ operationId: randomUUID(), method: 'system/restart', params: {} }, { clientId: 'c' })).toMatchObject({ restarted: true });
      expect(calls).toBe(1);
    } finally { ledger.close(); }
  });
  it('does not race explicit restart against an in-flight work submission', async () => {
    const { ledger, worker, dispatcher, manager } = setup(); let finish!: (value: JsonValue) => void; let managementCalls = 0;
    manager.call = async () => { managementCalls++; return {}; };
    worker.run = async (_m, _p, context) => { context.beforeWrite?.(); return new Promise(resolve => { finish = resolve; }); };
    const pending = dispatcher.call({ operationId: randomUUID(), method: 'turn/start', params: { threadId: 't', text: 'a' } }, { clientId: 'c' });
    try {
      await expect(dispatcher.call({ operationId: randomUUID(), method: 'system/restart', params: {} }, { clientId: 'c' })).rejects.toMatchObject({ code: 'activity_busy', delivery: 'not_sent' });
      expect(managementCalls).toBe(0);
      finish({ turn: { id: 'first' } }); await pending;
    } finally { ledger.close(); }
  });
});
