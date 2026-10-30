import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
function setup(file = ':memory:') {
  const ledger = new Ledger(file); const worker = new Worker();
  const manager: ManagerPort = { call: async (_m, _p, _id, before) => { before?.(); return {}; } };
  const dispatcher = new Dispatcher(ledger, worker, manager);
  dispatcher.event({ type: 'state', data: { epoch: 'one', connected: true, activity: { activeThreads: [], pendingStarts: 0, terminals: 0, unknown: false } } });
  return { ledger, worker, dispatcher, manager };
}
describe('gateway operation admission', () => {
  it('durably renames a registered project without a worker and replays the original receipt after restart without reverting a later name', async () => {
    const parent = path.resolve('.work/project-rename'); mkdirSync(parent, { recursive: true });
    const directory = mkdtempSync(path.join(parent, 'run-')), file = path.join(directory, 'journal.sqlite');
    let current = setup(file);
    const context: CallContext = { clientId: 'owner', requireAuthorization: vi.fn(), requireConnection() { throw new HarnessError('connection_required', 'Worker disconnected'); } };
    try {
      current.worker.connected = false; current.dispatcher.disconnected();
      const project = current.ledger.addProject('/native/unchanged', 'Original');
      const call = { method: 'project/rename', operationId: randomUUID(), params: { id: project.id, name: '  First name  ' } };
      const result = { ...project, name: 'First name' };
      expect(await current.dispatcher.call(call, context)).toEqual(result);
      expect(current.ledger.read(call.operationId)).toMatchObject({ method: 'project/rename', scope: 'project:' + project.id, state: 'accepted', result });
      expect(await current.dispatcher.call({ ...call, operationId: randomUUID(), params: { id: project.id, name: 'Later name' } }, context)).toEqual({ ...project, name: 'Later name' });
      expect(current.worker.calls).toBe(0);
      current.ledger.close(); current = setup(file); current.worker.connected = false;
      expect(current.ledger.recover()).toEqual({ unknown: 0, notSent: 0 });
      expect(await current.dispatcher.call(call, context)).toEqual(result);
      expect(await current.dispatcher.call({ method: 'operation/read', params: { operationId: call.operationId } }, context)).toMatchObject({ state: 'accepted', result });
      expect(current.ledger.projects()).toEqual([{ ...project, name: 'Later name' }]);
      await expect(current.dispatcher.call({ ...call, params: { id: project.id, name: 'Different payload' } }, context)).rejects.toMatchObject({ code: 'operation_conflict', delivery: 'not_sent' });
      expect(current.worker.calls).toBe(0);
    } finally { current.ledger.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('returns a durable not_found for a removed project and rejects unknown rename fields without dispatch', async () => {
    const { ledger, dispatcher, worker } = setup();
    try {
      const project = ledger.addProject('/native/project', 'Original'); ledger.removeProject(project.id);
      const call = { method: 'project/rename', operationId: randomUUID(), params: { id: project.id, name: 'Missing' } };
      await expect(dispatcher.call(call, { clientId: 'owner' })).rejects.toMatchObject({ code: 'not_found', delivery: 'not_sent' });
      expect(ledger.read(call.operationId)).toMatchObject({ state: 'not_sent', error: { code: 'not_found' } });
      await expect(dispatcher.call(call, { clientId: 'owner' })).rejects.toMatchObject({ code: 'not_found', delivery: 'not_sent' });
      const existing = ledger.addProject('/native/existing', 'Existing');
      await expect(dispatcher.call({ method: 'project/rename', operationId: randomUUID(), params: { id: existing.id, name: 'Changed', path: '/other' } }, { clientId: 'owner' })).rejects.toMatchObject({ code: 'invalid', delivery: 'not_sent' });
      expect(ledger.projects()).toEqual([existing]); expect(worker.calls).toBe(0);
    } finally { ledger.close(); }
  });
  it('proves a failed local rename was not sent when its transaction rolls back and the original receipt remains pending', async () => {
    const { ledger, dispatcher, worker } = setup();
    try {
      const project = ledger.addProject('/native/project', 'Original');
      const call = { method: 'project/rename', operationId: randomUUID(), params: { id: project.id, name: 'Uncommitted' } };
      const settled = vi.spyOn(ledger, 'settle').mockImplementationOnce(() => { throw new Error('fixture receipt storage failure'); });
      await expect(dispatcher.call(call, { clientId: 'owner' })).rejects.toMatchObject({ code: 'internal', delivery: 'not_sent' });
      expect(ledger.projects()).toEqual([project]); expect(ledger.read(call.operationId)?.state).toBe('not_sent');
      await expect(dispatcher.call(call, { clientId: 'owner' })).rejects.toMatchObject({ code: 'internal', delivery: 'not_sent' });
      expect(settled).toHaveBeenCalledTimes(2); expect(worker.calls).toBe(0);
    } finally { vi.restoreAllMocks(); ledger.close(); }
  });
  it('does not commit a renamed label when the journal can retain only an unknown result', async () => {
    const { ledger, dispatcher } = setup();
    try {
      const project = ledger.addProject('/native/project', 'Original'), operationId = randomUUID();
      const settle = ledger.settle.bind(ledger);
      vi.spyOn(ledger, 'settle').mockImplementationOnce(id => settle(id, { ok: false, error: { code: 'journal_capacity', message: 'fixture capacity', delivery: 'unknown' } }));
      await expect(dispatcher.call({ method: 'project/rename', operationId, params: { id: project.id, name: 'Uncommitted' } }, { clientId: 'owner' })).rejects.toMatchObject({ code: 'journal_capacity', delivery: 'not_sent' });
      expect(ledger.projects()).toEqual([project]); expect(ledger.read(operationId)).toMatchObject({ state: 'not_sent' });
    } finally { vi.restoreAllMocks(); ledger.close(); }
  });
  it('rechecks administrator authorization before committing a local project rename', async () => {
    const { ledger, dispatcher, worker } = setup(); let checks = 0;
    try {
      const project = ledger.addProject('/native/project', 'Original'), operationId = randomUUID();
      await expect(dispatcher.call({ method: 'project/rename', operationId, params: { id: project.id, name: 'Denied' } }, { clientId: 'owner', requireAuthorization() { if (++checks > 1) throw new HarnessError('unauthorized', 'Revoked'); } })).rejects.toMatchObject({ code: 'unauthorized', delivery: 'not_sent' });
      expect(checks).toBe(2); expect(ledger.projects()).toEqual([project]); expect(ledger.read(operationId)?.state).toBe('not_sent'); expect(worker.calls).toBe(0);
    } finally { ledger.close(); }
  });
  it('does not rename registered projects while a management transaction owns the gateway', async () => {
    const { ledger, dispatcher, manager } = setup(); let finish!: (value: JsonValue) => void;
    manager.call = async (_method, _params, _operationId, beforeWrite) => { beforeWrite?.(); return new Promise(resolve => { finish = resolve; }); };
    const pending = dispatcher.call({ method: 'system/restart', operationId: randomUUID(), params: {} }, { clientId: 'owner' });
    try {
      const project = ledger.addProject('/native/project', 'Original'), operationId = randomUUID();
      expect(dispatcher.maintenanceActive()).toBe(true);
      await expect(dispatcher.call({ method: 'project/rename', operationId, params: { id: project.id, name: 'Denied' } }, { clientId: 'owner' })).rejects.toMatchObject({ code: 'maintenance', delivery: 'not_sent' });
      expect(ledger.projects()).toEqual([project]); expect(ledger.read(operationId)?.state).toBe('not_sent');
    } finally { finish({ restarted: true, release: 'a'.repeat(64) }); await pending; ledger.close(); }
  });
  it('creates a managed project, persists its registration after a lost owner, and never creates twice on replay', async () => {
    const { ledger, worker, dispatcher } = setup(); let live = true;
    const context: CallContext = { clientId: 'owner', requireConnection() { if (!live) throw new HarnessError('connection_required', 'gone'); } };
    worker.run = async (method, params, current) => {
      expect(method).toBe('project/create'); expect(params).toEqual({ directory: 'new-project' }); current.beforeWrite?.(); live = false;
      return { path: '/native/projects/new-project', name: 'new-project' };
    };
    const call = { method: 'project/create', operationId: randomUUID(), params: { name: 'New project', directory: 'new-project' } };
    try {
      const project = await dispatcher.call(call, context);
      expect(project).toMatchObject({ name: 'New project', path: '/native/projects/new-project' });
      expect(ledger.projects()).toEqual([project]); expect(ledger.read(call.operationId)?.state).toBe('accepted');
      expect(await dispatcher.call(call, context)).toEqual(project); expect(worker.calls).toBe(1);
    } finally { ledger.close(); }
  });

  it('rejects malformed project creation before dispatch and exposes the managed location as a read', async () => {
    const { ledger, worker, dispatcher } = setup();
    try {
      await expect(dispatcher.call({ method: 'project/create', operationId: randomUUID(), params: { name: '', directory: 'project' } }, { clientId: 'owner' })).rejects.toMatchObject({ delivery: 'not_sent' });
      expect(worker.calls).toBe(0);
      worker.run = async method => { expect(method).toBe('project/defaults'); return { directory: '/native/projects' }; };
      expect(await dispatcher.call({ method: 'project/defaults', params: {} }, { clientId: 'owner' })).toEqual({ directory: '/native/projects' });
    } finally { ledger.close(); }
  });

  it('forwards a bounded absolute creation path without letting browser parameters select root identity', async () => {
    const { ledger, worker, dispatcher } = setup();
    const directory = '/root/' + ['a'.repeat(120), 'b'.repeat(120), 'c'.repeat(120)].join('/');
    worker.run = async (method, params, context) => {
      expect(method).toBe('project/create'); expect(params).toEqual({ directory }); context.beforeWrite?.();
      return { path: directory, name: 'c'.repeat(120) };
    };
    try {
      for (const invalid of [{ name: 'Project', directory, mode: 'root' }, { name: 'Project', directory: '/' + 'x'.repeat(4096) }]) {
        await expect(dispatcher.call({ method: 'project/create', operationId: randomUUID(), params: invalid }, { clientId: 'owner' })).rejects.toMatchObject({ delivery: 'not_sent' });
      }
      expect(worker.calls).toBe(0);
      const request = { method: 'project/create', operationId: randomUUID(), params: { name: 'Project', directory } };
      expect(await dispatcher.call(request, { clientId: 'owner' })).toMatchObject({ path: directory, name: 'Project' });
      expect(ledger.read(request.operationId)?.state).toBe('accepted');
      await dispatcher.call(request, { clientId: 'owner' }); expect(worker.calls).toBe(1);
    } finally { ledger.close(); }
  });

  it('registers a relative existing-directory input only after the worker resolves its actual location', async () => {
    const { ledger, worker, dispatcher } = setup();
    worker.run = async (method, params) => {
      expect(method).toBe('project/resolve'); expect(params).toEqual({ path: './nested//existing/' });
      return { path: '/native/projects/nested/existing', name: 'existing' };
    };
    const request = { method: 'project/add', operationId: randomUUID(), params: { name: 'Existing project', path: './nested//existing/' } };
    try {
      const project = await dispatcher.call(request, { clientId: 'owner' });
      expect(project).toMatchObject({ name: 'Existing project', path: '/native/projects/nested/existing' });
      expect(ledger.projects()).toEqual([project]); expect(ledger.read(request.operationId)?.state).toBe('accepted');
      expect(await dispatcher.call(request, { clientId: 'owner' })).toEqual(project); expect(worker.calls).toBe(1);
    } finally { ledger.close(); }
  });

  it('retains created directories as unknown when concurrent project registrations reach capacity, without replaying creation', async () => {
    const { ledger, worker, dispatcher } = setup();
    for (let index = 0; index < 127; index++) ledger.addProject('/existing/' + index, 'Existing ' + index);
    let release!: () => void, arrivals = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    worker.run = async (_method, params, context) => {
      context.beforeWrite?.(); if (++arrivals === 2) release(); await gate;
      return { path: '/native/projects/' + params.directory, name: params.directory! };
    };
    const calls = ['first', 'second'].map(directory => ({ method: 'project/create', operationId: randomUUID(), params: { directory, name: directory } }));
    try {
      const results = await Promise.allSettled(calls.map(call => dispatcher.call(call, { clientId: 'owner' })));
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const failedIndex = results.findIndex(result => result.status === 'rejected'), failed = calls[failedIndex]!;
      expect(results[failedIndex]).toMatchObject({ status: 'rejected', reason: { code: 'project_registration_failed', delivery: 'unknown', data: { path: '/native/projects/' + failed.params.directory } } });
      expect(ledger.read(failed.operationId)).toMatchObject({ state: 'unknown', error: { code: 'project_registration_failed', delivery: 'unknown' } });
      expect(ledger.projects()).toHaveLength(128);
      await expect(dispatcher.call(failed, { clientId: 'owner' })).rejects.toMatchObject({ code: 'operation_unknown', delivery: 'unknown' });
      expect(worker.calls).toBe(2);
    } finally { ledger.close(); }
  });

  it.each([true, false])('never classifies invalid positive project results as unsent (boundary callback: %s)', async boundary => {
    const { ledger, worker, dispatcher } = setup();
    worker.run = async (_method, _params, context) => { if (boundary) context.beforeWrite?.(); return { path: null }; };
    const call = { method: 'project/create', operationId: randomUUID(), params: { name: 'Project', directory: 'project' } };
    try {
      await expect(dispatcher.call(call, { clientId: 'owner' })).rejects.toMatchObject({ delivery: 'unknown' });
      expect(ledger.read(call.operationId)).toMatchObject({ state: 'unknown', error: { delivery: 'unknown' } });
      await expect(dispatcher.call(call, { clientId: 'owner' })).rejects.toMatchObject({ code: 'operation_unknown' });
      expect(worker.calls).toBe(1); expect(ledger.projects()).toEqual([]);
    } finally { ledger.close(); }
  });

  it('preserves a definite backend rejection before any positive acknowledgement', async () => {
    const { ledger, worker, dispatcher } = setup();
    worker.run = async (_method, _params, context) => { context.beforeWrite?.(); throw new HarnessError('project_exists', 'Directory exists'); };
    const call = { method: 'project/create', operationId: randomUUID(), params: { name: 'Project', directory: 'project' } };
    try {
      await expect(dispatcher.call(call, { clientId: 'owner' })).rejects.toMatchObject({ code: 'project_exists', delivery: 'not_sent' });
      expect(ledger.read(call.operationId)?.state).toBe('not_sent'); expect(ledger.projects()).toEqual([]);
    } finally { ledger.close(); }
  });

  it.each(['session revoked', 'owner replaced'] as const)('does not register a project when %s during path resolution', async change => {
    const { ledger, worker, dispatcher } = setup(); const operationId = randomUUID(), owner = {};
    let authenticated = true, currentOwner = owner, finish!: (value: JsonValue) => void;
    const context: CallContext = { clientId: 'owner', requireConnection() {
      if (!authenticated) throw new HarnessError('unauthorized', 'Session revoked');
      if (currentOwner !== owner) throw new HarnessError('connection_required', 'Connection replaced');
    } };
    worker.run = async (method, params) => {
      expect(method).toBe('project/resolve'); expect(params).toEqual({ path: '/requested' });
      return new Promise(resolve => { finish = resolve; });
    };
    const call = { method: 'project/add', operationId, params: { path: '/requested', name: 'Project' } };
    try {
      const pending = dispatcher.call(call, context);
      expect(ledger.projects()).toEqual([]); expect(ledger.read(operationId)?.state).toBe('pending');
      if (change === 'session revoked') authenticated = false; else currentOwner = {};
      finish({ path: '/resolved', name: 'Resolved' });
      const code = change === 'session revoked' ? 'unauthorized' : 'connection_required';
      await expect(pending).rejects.toMatchObject({ code, delivery: 'not_sent' });
      expect(ledger.projects()).toEqual([]);
      expect(ledger.read(operationId)).toMatchObject({ state: 'not_sent', error: { code, delivery: 'not_sent' } });
      authenticated = true; currentOwner = owner;
      await expect(dispatcher.call(call, context)).rejects.toMatchObject({ code, delivery: 'not_sent' });
      expect(worker.calls).toBe(1); expect(ledger.projects()).toEqual([]);
    } finally { ledger.close(); }
  });
  it('registers a project for the still-live owner and replays its accepted receipt after disconnect', async () => {
    const { ledger, worker, dispatcher } = setup(); let live = true, checks = 0, finish!: (value: JsonValue) => void;
    const context: CallContext = { clientId: 'owner', requireConnection() { checks++; if (!live) throw new HarnessError('connection_required', 'Disconnected'); } };
    worker.run = async () => new Promise(resolve => { finish = resolve; });
    const call = { method: 'project/add', operationId: randomUUID(), params: { path: '/requested', name: 'Project' } };
    try {
      const pending = dispatcher.call(call, context); finish({ path: '/resolved', name: 'Resolved' });
      const result = await pending;
      expect(result).toMatchObject({ path: '/resolved', name: 'Project' });
      expect(ledger.projects()).toEqual([result]); expect(checks).toBe(2);
      expect(ledger.read(call.operationId)).toMatchObject({ state: 'accepted', result });
      live = false;
      expect(await dispatcher.call(call, context)).toEqual(result);
      expect(worker.calls).toBe(1); expect(checks).toBe(2); expect(ledger.projects()).toEqual([result]);
    } finally { ledger.close(); }
  });
  it('persists an executed backend mutation acknowledgement after its browser owner disconnects', async () => {
    const { ledger, worker, dispatcher } = setup(); let live = true, finish!: (value: JsonValue) => void;
    const context: CallContext = { clientId: 'owner', requireConnection() { if (!live) throw new HarnessError('connection_required', 'Disconnected'); } };
    worker.run = async (_method, _params, current) => { current.beforeWrite?.(); return new Promise(resolve => { finish = resolve; }); };
    const call = { method: 'turn/start', operationId: randomUUID(), params: { threadId: 't', text: 'continue' } };
    try {
      const pending = dispatcher.call(call, context); expect(ledger.read(call.operationId)?.state).toBe('dispatching');
      live = false; finish({ turn: { id: 'completed-turn', status: 'completed' } });
      const result = await pending;
      expect(ledger.read(call.operationId)).toMatchObject({ state: 'accepted', result });
      expect(await dispatcher.call(call, context)).toEqual(result); expect(worker.calls).toBe(1);
    } finally { ledger.close(); }
  });
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
