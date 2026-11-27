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
test('positive worktree replies with invalid registration identity stay unknown and never replay the native action', async () => {
  const f = setup(); let calls = 0;
  f.set(async () => { calls++; return { ...f.result, worktreeId: 'not-a-uuid' }; });
  try {
    await expect(f.dispatcher.call(f.create, { clientId: 'owner' })).rejects.toMatchObject({ delivery: 'unknown' });
    expect(f.ledger.read(f.id)).toMatchObject({ state: 'unknown', error: { delivery: 'unknown' } });
    expect(f.ledger.projects()).toHaveLength(1);
    await expect(f.dispatcher.call(f.create, { clientId: 'owner' })).rejects.toMatchObject({ code: 'operation_unknown' });
    expect(calls).toBe(1);
  } finally { f.ledger.close(); }
});
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
test.each([false, true])('notifies browsers and scheduler after a committed archive (lost reply: %s)', async lost => {
  const f = setup(), context = { clientId: 'owner' }, operationId = randomUUID();
  const method = 'workspace/worktree/archive', params = { projectId: f.origin.id, worktreeId: f.id, expectedRevision: f.result.revision!, confirm: true };
  const result = { ...f.result, archived: true, phase: 'archived', path: '/native/worktree-state/' + f.id + '/checkout', worktreeVersion: 2 };
  const notifications: string[] = [];
  try {
    await f.dispatcher.call(f.create, context);
    f.dispatcher.on('automation-changed', () => notifications.push('scheduler:' + f.ledger.read(operationId)?.state));
    f.dispatcher.on('event', event => { if (event.type === 'automation' && event.data.changed) notifications.push('browser'); });
    f.set(async (called, _p, c) => {
      if (called === 'workspace/witness/read') return { operationId, state: 'completed', method, projectId: f.origin.id, gatewayRequestDigest: digest({ method, params }), result };
      if (called === 'workspace/witness/ack') return { operationId, acknowledged: true, removed: true };
      c.beforeWrite?.(); if (lost) throw new HarnessError('lost', 'lost', 'unknown'); return result;
    });
    const request = f.dispatcher.call({ method, params, operationId }, context);
    if (lost) { await expect(request).rejects.toMatchObject({ delivery: 'unknown' }); expect(notifications).toEqual([]); }
    else await request;
    for (let index = 0; index < 2; index++) await f.dispatcher.call({ method: 'operation/read', params: { operationId } }, context);
    expect(notifications).toEqual(['scheduler:accepted', 'browser']);
    expect(() => f.ledger.project(f.id)).toThrow();
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
test('retired worktrees free project registration without allowing a late older acknowledgement to resurrect them', async () => {
  const f = setup();
  try {
    await f.dispatcher.call(f.create, { clientId: 'owner' });
    f.set(async (_method, _params, context) => { context.beforeWrite?.(); return { ...f.result, phase: 'retired', path: '/native/worktree-state/retired/' + f.id + '/checkout', retired: true, retained: true, worktreeVersion: 2 }; });
    await f.dispatcher.call({ method: 'workspace/worktree/retire', operationId: randomUUID(), params: { projectId: f.origin.id, worktreeId: f.id, expectedRevision: f.result.revision!, confirm: true } }, { clientId: 'owner' });
    expect(f.ledger.worktrees.list(f.origin.id)).toEqual({ data: [] }); expect(() => f.ledger.project(f.id)).toThrow();
    f.ledger.transaction(() => f.ledger.worktrees.apply('workspace/worktree/create', f.origin.id, f.id, f.result));
    expect(() => f.ledger.project(f.id)).toThrow(); expect(() => f.ledger.removeProject(f.origin.id)).not.toThrow();
  } finally { f.ledger.close(); }
});
test('allows the scoped worker to admit two independent repositories without releasing global configuration fences', async () => {
  const f=setup(), second=f.ledger.addProject('/independent','Independent');
  let release!:()=>void; const gate=new Promise<void>(done=>{release=done;});
  const starts:string[]=[];
  f.set(async (method, params, context) => {
    if(method!=='workspace/worktree/create')return {};
    context.beforeWrite?.(); starts.push(String(params.cwd)); await gate;
    return {...f.result,worktreeId:context.operationId!,path:'/native/worktrees/'+context.operationId};
  });
  f.dispatcher.event({type:'state',data:{repositoryScopes:1,connected:true,activity:{activeThreads:['elsewhere'],pendingStarts:0,terminals:0,unknown:false}}});
  const a=f.dispatcher.call(f.create,{clientId:'a'});
  const b=f.dispatcher.call({...f.create,params:{...f.create.params,projectId:second.id},operationId:randomUUID()},{clientId:'b'});
  try {
    await expect.poll(()=>starts.sort()).toEqual(['/independent','/origin']);
    await expect(f.dispatcher.call({...f.create,operationId:randomUUID()},{clientId:'a'})).rejects.toMatchObject({code:'thread_busy',delivery:'not_sent'});
    await expect(f.dispatcher.call({method:'mcp/reload',params:{},operationId:randomUUID()},{clientId:'a'})).rejects.toMatchObject({code:'activity_busy',delivery:'not_sent'});
  } finally {release();await Promise.allSettled([a,b]);f.ledger.close();}
});

test('custom names survive existing databases, archive, restart and binding replay without renaming siblings', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'worktree-names-')), filename = join(dir, 'ledger.sqlite');
  let ledger = new Ledger(filename);
  try {
    const origin = ledger.addProject('/origin', 'Origin'), a = randomUUID(), b = randomUUID();
    const active = (id: string, version = 1) => ({ worktreeId: id, worktreeVersion: version, phase: 'active', path: '/native/worktrees/' + id, head: 'a'.repeat(40), revision: 'b'.repeat(64), created: true });
    for (const id of [a, b]) ledger.transaction(() => ledger.worktrees.apply('workspace/worktree/create', origin.id, id, active(id)));
    const sibling = ledger.project(b).name;
    ledger.renameProject(a, '自定义名称');
    const names = () => (ledger.worktrees.list(origin.id) as {data: {worktreeId:string;name:string}[]}).data;
    expect(names()).toContainEqual(expect.objectContaining({ worktreeId: a, name: '自定义名称' }));
    ledger.close();
    const old = new DatabaseSync(filename);
    old.prepare('UPDATE worktree_projects SET name=? WHERE id=?').run('旧快照名', a); old.close();
    ledger = new Ledger(filename);
    expect(names()).toContainEqual(expect.objectContaining({ worktreeId: a, name: '自定义名称' }));
    ledger.transaction(() => ledger.worktrees.apply('workspace/worktree/archive', origin.id, randomUUID(), { ...active(a, 2), phase: 'archived', path: '/native/worktree-state/' + a + '/checkout' }));
    ledger.close(); ledger = new Ledger(filename);
    ledger.transaction(() => ledger.worktrees.apply('workspace/worktree/restore', origin.id, randomUUID(), active(a, 3)));
    ledger.transaction(() => ledger.worktrees.apply('workspace/worktree/create', origin.id, a, active(a)));
    expect(ledger.project(a).name).toBe('自定义名称'); expect(ledger.project(b).name).toBe(sibling);
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});
