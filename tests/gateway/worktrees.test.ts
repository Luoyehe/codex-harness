import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Ledger } from '../../src/core/ledger.js';
import { Dispatcher } from '../../src/gateway/dispatch.js';
import { HarnessError } from '../../src/core/errors.js';
import { digest } from '../../src/core/validation.js';
import type { CallContext, JsonObject, JsonValue, WorkerPort } from '../../src/core/contracts.js';
function setup() {
  const ledger = new Ledger(':memory:'), origin = ledger.addProject('/origin', 'Origin'), id = randomUUID();
  const result: JsonObject = { worktreeId: id, worktreeVersion: 1, phase: 'active', path: '/native/worktrees/' + id, head: 'a'.repeat(40), revision: 'b'.repeat(64), created: true };
  let run = async (_m: string, _p: JsonObject, c: CallContext): Promise<JsonValue> => { c.beforeWrite?.(); return result; };
  const worker: WorkerPort = { connected: true, call: (m, p, c) => run(m, p, c) }, dispatcher = new Dispatcher(ledger, worker, { call: async () => ({}) });
  dispatcher.event({ type: 'state', data: { connected: true, activity: { activeThreads: [], pendingStarts: 0, terminals: 0, unknown: false } } });
  const create = { method: 'workspace/worktree/create', operationId: id, params: { projectId: origin.id, ref: 'HEAD' } };
  return { ledger, origin, id, result, dispatcher, create, set: (next: typeof run) => { run = next; } };
}
test('worktree creation, archive and restore register exact projects atomically with receipts', async () => {
  const f = setup(); const context = { clientId: 'owner' };
  try {
    await f.dispatcher.call(f.create, context); expect(f.ledger.project(f.id).path).toBe(f.result.path);
    expect(() => f.ledger.removeProject(f.origin.id)).toThrow(); expect(() => f.ledger.removeProject(f.id)).toThrow();
    f.set(async (method, params, c) => { expect(params.cwd).toBe('/origin'); expect(params).not.toHaveProperty('projectId'); c.beforeWrite?.(); return method.endsWith('archive') ? { ...f.result, created: false, archived: true, phase: 'archived', path: '/native/worktree-state/' + f.id + '/checkout', worktreeVersion: 2 } : { ...f.result, created: false, restored: true, worktreeVersion: 3 }; });
    await f.dispatcher.call({ method: 'workspace/worktree/archive', operationId: randomUUID(), params: { projectId: f.origin.id, worktreeId: f.id, expectedRevision: f.result.revision!, confirm: true } }, context);
    expect(() => f.ledger.project(f.id)).toThrow(); expect(f.ledger.projects()).toHaveLength(1);
    expect(f.ledger.worktrees.list(f.origin.id)).toMatchObject({ data: [{ projectId: null, lastConfirmedPhase: 'archived' }] });
    await f.dispatcher.call({ method: 'workspace/worktree/restore', operationId: randomUUID(), params: { projectId: f.origin.id, worktreeId: f.id, expectedRevision: f.result.revision!, confirm: true } }, context);
    expect(f.ledger.project(f.id).path).toBe(f.result.path);
  } finally { f.ledger.close(); }
});
test('lost creation acknowledgement registers only matching positive witness and never repeats creation', async () => {
  const f = setup(); let sent = 0; let proof: JsonObject = {};
  f.set(async (method, _params, c) => { if (method === 'workspace/witness/read') return proof; if (method === 'workspace/witness/ack') return { acknowledged: true, operationId: f.id, removed: true }; sent++; c.beforeWrite?.(); throw new HarnessError('lost', 'lost', 'unknown'); });
  try {
    await expect(f.dispatcher.call(f.create, { clientId: 'owner' })).rejects.toMatchObject({ delivery: 'unknown' }); expect(f.ledger.projects()).toHaveLength(1);
    proof = { operationId: f.id, state: 'completed', method: f.create.method, projectId: f.origin.id, gatewayRequestDigest: '0'.repeat(64), result: f.result };
    expect(await f.dispatcher.call({ method: 'operation/read', params: { operationId: f.id } }, { clientId: 'owner' })).toMatchObject({ state: 'unknown' });
    proof.gatewayRequestDigest = digest({ method: f.create.method, params: f.create.params });
    expect(await f.dispatcher.call({ method: 'operation/read', params: { operationId: f.id } }, { clientId: 'owner' })).toMatchObject({ state: 'accepted' });
    await f.dispatcher.call(f.create, { clientId: 'owner' }); expect(sent).toBe(1); expect(f.ledger.project(f.id).path).toBe(f.result.path);
  } finally { f.ledger.close(); }
});
test('delayed earlier positive proof cannot undo a later archive', () => {
  const f = setup();
  try {
    f.ledger.transaction(() => f.ledger.worktrees.apply(f.create.method, f.origin.id, f.id, f.result));
    f.ledger.transaction(() => f.ledger.worktrees.apply('workspace/worktree/archive', f.origin.id, randomUUID(), { ...f.result, phase: 'archived', path: '/native/worktree-state/' + f.id + '/checkout', worktreeVersion: 3 }));
    f.ledger.transaction(() => f.ledger.worktrees.apply('workspace/worktree/attach', f.origin.id, randomUUID(), { ...f.result, worktreeVersion: 2 }));
    expect(() => f.ledger.project(f.id)).toThrow(); expect(f.ledger.worktrees.list(f.origin.id)).toMatchObject({ data: [{ worktreeVersion: 3, lastConfirmedPhase: 'archived' }] });
  } finally { f.ledger.close(); }
});
test('worktree management excludes active tasks and blocks project removal during dispatch', async () => {
  const f = setup();
  try {
    f.dispatcher.event({ type: 'state', data: { connected: true, activity: { activeThreads: ['busy'], pendingStarts: 0, terminals: 0, unknown: false } } });
    await expect(f.dispatcher.call(f.create, { clientId: 'owner' })).rejects.toMatchObject({ code: 'activity_busy', delivery: 'not_sent' });
    f.dispatcher.event({ type: 'state', data: { connected: true, activity: { activeThreads: [], pendingStarts: 0, terminals: 0, unknown: false } } });
    f.set(async (_method, _params, c) => { await expect(f.dispatcher.call({ method: 'project/remove', operationId: randomUUID(), params: { id: f.origin.id } }, { clientId: 'owner' })).rejects.toMatchObject({ code: 'maintenance' }); c.beforeWrite?.(); return { ...f.result, worktreeId: c.operationId! }; });
    const id = randomUUID(); f.result.path = '/native/worktrees/' + id;
    await f.dispatcher.call({ ...f.create, operationId: id }, { clientId: 'owner' }); expect(f.ledger.project(f.origin.id)).toBeDefined();
  } finally { f.ledger.close(); }
});
