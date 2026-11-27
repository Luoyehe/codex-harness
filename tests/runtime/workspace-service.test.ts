import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import type { NativeOptions, NativeRpc } from '../../src/runtime/native.js';
import { DeliveryError, object, type JsonObject, type JsonValue } from '../../src/runtime/types.js';
const helper = vi.hoisted(() => ({ hook: undefined as undefined | ((action: string) => void), gate: undefined as PromiseWithResolvers<void> | undefined, calls: [] as { action: string; binding: unknown }[], result: undefined as JsonValue | undefined, failure: undefined as Error | undefined }));
const admissions = new EventEmitter();
vi.mock('../../src/runtime/workspace.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/runtime/workspace.js')>();
  return { ...actual, runWorkspace: async (_config: unknown, root: import('../../src/runtime/workspace.js').WorkspaceRoot, action: string, params: JsonObject, context: import('../../src/runtime/types.js').CallContext, internal = false) => {
    actual.workspaceRequest(root, action, params, context, internal);
    if (action === 'repository/identity') return { identity: root.path === '/independent' ? 'b'.repeat(64) : 'a'.repeat(64) };
    helper.hook?.(action);
    if (actual.workspaceMutations.has(action) || action === 'operation/ack') context.beforeWrite?.();
    helper.calls.push({ action, binding: root.worktreeBinding });
    admissions.emit('admitted');
    await helper.gate?.promise;
    if (helper.failure) throw helper.failure;
    if (helper.result !== undefined) return helper.result;
    if (action === 'operation/ack') return { acknowledged: true, operationId: params.operationId, removed: true };
    if (action === 'mkdir') return { path: params.path, created: true };
    const id = action === 'worktree/create' ? context.operationId : params.worktreeId;
    const binding = root.worktreeBinding ?? { version: 1, worktreeId: id!, originRoot: root.path, commonDir: '/project/.git', commonDevice: 1, commonInode: 2, gitDir: '/project/.git/worktrees/managed', gitDirDevice: 1, gitDirInode: 3, worktreeDevice: 1, worktreeInode: 4 };
    return { worktreeId: id!, path: `/native/worktrees/${String(id)}`, phase: 'active', revision: 'a'.repeat(64), head: 'b'.repeat(40), dirty: false, binding, ...(action === 'worktree/create' ? { created: true } : action === 'worktree/attach' ? { attached: true } : {}) };
  } };
});
import { RuntimeService } from '../../src/runtime/service.js';
class Native extends EventEmitter {
  connected = true; budget = {};
  async call(method: string, _params: JsonValue, options: NativeOptions = {}) { options.beforeWrite?.(); return method === 'remoteControl/status/read' ? { status: 'disabled', serverName: 'test', installationId: 'test', environmentId: null } : {}; }
  async close() { this.connected = false; }
}
const services: RuntimeService[] = [];
function setup() {
  const parent = path.resolve('.work/workspace-service'); mkdirSync(parent, { recursive: true }); const home = mkdtempSync(path.join(parent, 'case-')); const native = new Native();
  const service = new RuntimeService({ bin: '/unused', home, workerHome: home, nativeHome: '/native', cwd: '/', env: {}, launcher: { path: '/unused', user: 'ch-fixture-worker' } }, native as unknown as NativeRpc); services.push(service);
  return { service, native, context: { clientId: 'owner', operationId: randomUUID(), projectId: randomUUID(), gatewayRequestDigest: 'c'.repeat(64), beforeWrite: () => {} } };
}
function holdHelper(): () => void {
  helper.gate = Promise.withResolvers<void>();
  return helper.gate.resolve;
}
async function expectAdmitted(count: number, operation: Promise<unknown>): Promise<void> {
  if (helper.calls.length < count) await Promise.race([once(admissions, 'admitted'), operation]);
  expect(helper.calls).toHaveLength(count);
}
beforeEach(() => { helper.calls.length = 0; helper.hook = undefined; helper.gate = undefined; helper.result = undefined; helper.failure = undefined; });
afterEach(async () => {
  helper.gate?.resolve();
  admissions.removeAllListeners();
  await Promise.all(services.splice(0).map(service => service.close()));
});
test('worktree creation establishes a private binding and read never exposes nested recovery bindings', async () => {
  const { service, context } = setup();
  const created = await service.call('workspace/worktree/create', { cwd: '/project', ref: 'HEAD' }, context);
  expect(created).toMatchObject({ worktreeId: context.operationId, worktreeVersion: 1, created: true }); expect(created).not.toHaveProperty('binding');
  const read = await service.call('workspace/worktree/read', { cwd: '/project', worktreeId: context.operationId }, context);
  expect(read).not.toHaveProperty('binding'); expect(helper.calls.at(-1)?.binding).toMatchObject({ worktreeId: context.operationId, originRoot: '/project' });
  await expect(service.call('workspace/worktree/read', { cwd: '/other', worktreeId: context.operationId }, context)).rejects.toMatchObject({ code: 'worktree_unbound' });
  await expect(service.call('workspace/worktree/read', { cwd: '/project', worktreeId: context.operationId, binding: {} }, context)).rejects.toMatchObject({ code: 'invalid_params' });
  helper.result = { operationId: context.operationId, response: { result: { binding: { secret: 'inode' }, path: 'retained' } } };
  expect(await service.call('workspace/operation/read', { cwd: '/project', operationId: context.operationId }, context)).toEqual({ operationId: context.operationId, response: { result: { path: 'retained' } } });
});
test('worktree changes wait for prior file writes and exclude new work until acknowledged', async () => {
  const { service, context } = setup(); const release = holdHelper();
  const writing = service.call('workspace/mkdir', { cwd: '/project', path: 'folder' }, context);
  const creating = service.call('workspace/worktree/create', { cwd: '/project', ref: 'HEAD' }, { ...context, operationId: randomUUID() });
  await expectAdmitted(1, writing);
  expect(helper.calls.map(call => call.action)).toEqual(['mkdir']); release(); await writing; await creating;
  const complete = holdHelper();
  const next = service.call('workspace/worktree/create', { cwd: '/project', ref: 'HEAD' }, { ...context, operationId: randomUUID() });
  await expectAdmitted(3, next);
  await expect(service.call('workspace/mkdir', { cwd: '/project', path: 'other' }, { ...context, operationId: randomUUID() })).rejects.toMatchObject({ code: 'activity_busy' });
  complete(); await next;
});
test('worktree helper final boundary rejects newly active work and revoked owners before dispatch', async () => {
  for (const changed of ['activity', 'owner']) {
    const { service, native, context } = setup();
    helper.hook = () => { if (changed === 'activity') native.emit('notification', { method: 'turn/started', params: { threadId: 't', turn: { id: 'u' } } }); };
    await expect(service.call('workspace/worktree/create', { cwd: '/project', ref: 'HEAD' }, { ...context, beforeWrite: () => { if (changed === 'owner') throw new DeliveryError('client_disconnected', 'revoked'); } })).rejects.toMatchObject({ code: changed === 'activity' ? 'activity_busy' : 'client_disconnected', delivery: 'not_sent' });
    expect(helper.calls).toHaveLength(0); expect(object(object(service.status()).activity).unknown).toBe(false);
  }
});
test('service close waits for helper acknowledgement before closing the witness database', async () => {
  const { service, context } = setup(); const release = holdHelper();
  const pending = service.call('workspace/worktree/create', { cwd: '/project', ref: 'HEAD' }, context); await expectAdmitted(1, pending);
  let closed = false; const closing = service.close().then(() => { closed = true; }); await Promise.resolve(); expect(closed).toBe(false);
  release(); await expect(pending).resolves.toMatchObject({ created: true, worktreeVersion: 1 }); await closing;
});

test('internal receipt acknowledgement retains worktree binding and is protected by owner fence', async () => {
  const { service, context } = setup();
  await service.call('workspace/worktree/create', { cwd: '/project', ref: 'HEAD' }, context);
  const page = object(await service.call('workspace/witness/pending', {}, context)), ack = object((page.data as JsonValue[])[0]);
  await expect(service.call('workspace/operation/ack', { cwd: '/project', operationId: context.operationId, requestDigest: 'c'.repeat(64) }, context)).rejects.toMatchObject({ code: 'method_not_found' });
  await expect(service.call('workspace/witness/ack', ack, { ...context, beforeWrite() { throw new DeliveryError('client_disconnected', 'revoked'); } })).rejects.toMatchObject({ code: 'client_disconnected' });
  expect(await service.call('workspace/witness/read', { operationId: context.operationId }, context)).toMatchObject({ state: 'completed' });
  expect(await service.call('workspace/witness/ack', ack, context)).toMatchObject({ acknowledged: true, removed: true });
  expect(await service.call('runtime/maintenance/check', {}, context)).toMatchObject({ idle: true, workspaceWitness: { total: 0 } });
  expect(await service.call('workspace/worktree/read', { cwd: '/project', worktreeId: context.operationId }, context)).toMatchObject({ worktreeId: context.operationId });
});

test('maintenance waits for native acknowledgement cleanup to finish', async () => {
  const { service, context } = setup();
  await service.call('workspace/mkdir', { cwd: '/project', path: 'folder' }, context);
  const page = object(await service.call('workspace/witness/pending', {}, context)), ack = object((page.data as JsonValue[])[0]);
  const release = holdHelper();
  const cleanup = service.call('workspace/witness/ack', ack, context);
  await expect(service.call('runtime/maintenance/check', {}, context)).rejects.toMatchObject({ code: 'activity_busy' });
  release(); await cleanup;
  await expect(service.call('runtime/maintenance/check', {}, context)).resolves.toMatchObject({ idle: true });
});

test.each([
  ['mkdir', { path: 'folder' }, null],
  ['worktree/create', { ref: 'HEAD' }, { binding: null }],
] as const)('positive %s helper reply with malformed result retains its unknown witness and prevents replay', async (action, params, result) => {
  const { service, context } = setup(); helper.result = action === 'worktree/create' ? { ...result, worktreeId: context.operationId } : result;
  await expect(service.call(`workspace/${action}`, { cwd: '/project', ...params }, context)).rejects.toMatchObject({ code: 'workspace_witness', delivery: 'unknown' });
  expect(helper.calls).toHaveLength(1);
  expect(await service.call('workspace/witness/read', { operationId: context.operationId }, context)).toMatchObject({ state: 'unknown', method: `workspace/${action}` });
  expect(object(object(service.status()).activity).unknown).toBe(true);
  await expect(service.call(`workspace/${action}`, { cwd: '/project', ...params }, context)).rejects.toBeInstanceOf(DeliveryError);
  // Querying the original creation may inspect its read-only recovery record.
  expect(helper.calls.filter(call => call.action !== 'worktree/reconcile-create')).toHaveLength(1);
});

test('positive helper reply with mismatched identity preserves the original unknown outcome', async () => {
  const { service, context } = setup(); helper.result = { path: 'another-folder', created: true };
  await expect(service.call('workspace/mkdir', { cwd: '/project', path: 'folder' }, context)).rejects.toMatchObject({ code: 'invalid_native_response', delivery: 'unknown' });
  expect(await service.call('workspace/witness/read', { operationId: context.operationId }, context)).toMatchObject({ state: 'unknown' });
  expect(object(object(service.status()).activity).unknown).toBe(true);
});

test('definite helper rejection before a positive reply releases its witness without marking runtime uncertain', async () => {
  const { service, context } = setup(); helper.failure = new DeliveryError('permission_denied', 'Directory is not writable');
  await expect(service.call('workspace/mkdir', { cwd: '/project', path: 'folder' }, context)).rejects.toMatchObject({ code: 'permission_denied', delivery: 'not_sent' });
  expect(helper.calls).toHaveLength(1);
  expect(await service.call('workspace/witness/read', { operationId: context.operationId }, context)).toMatchObject({ state: 'not_received' });
  expect(object(object(service.status()).activity).unknown).toBe(false);
  helper.failure = undefined;
  await expect(service.call('workspace/mkdir', { cwd: '/project', path: 'folder' }, context)).resolves.toMatchObject({ created: true });
});
test('permits overlapping independent repository writes but holds the common repository across two registered worktrees', async () => {
  const { service, context } = setup(); const release = holdHelper();
  const origin = service.call('workspace/worktree/create', {cwd:'/project',ref:'HEAD'}, context);
  let separate: Promise<JsonValue> | undefined;
  try {
    await expectAdmitted(1, origin);
    separate = service.call('workspace/worktree/create', {cwd:'/independent',ref:'HEAD'}, {...context,projectId:randomUUID(),operationId:randomUUID()});
    await expectAdmitted(2, separate);
    await expect(service.call('workspace/worktree/create',{cwd:'/linked',ref:'HEAD'},{...context,projectId:randomUUID(),operationId:randomUUID()}))
      .rejects.toMatchObject({code:'activity_busy',delivery:'not_sent'});
    expect(helper.calls).toHaveLength(2);
  } finally { release(); await Promise.all([origin, separate]); }
});

test('an active conversation blocks its Git worktrees and permits a mutation in an independent repository', async () => {
  const { service, context, native } = setup();
  const nativeRead = vi.spyOn(native, 'call').mockResolvedValueOnce({
    thread: { id: 'busy', cwd: '/project', status: { type: 'active' } },
  } as Awaited<ReturnType<typeof native.call>>);
  await service.call('thread/read', { threadId: 'busy' }, context);
  expect(nativeRead).toHaveBeenCalledWith('thread/read', { threadId: 'busy' });
  const create = (cwd: string) => service.call('workspace/worktree/create', { cwd, ref: 'HEAD' },
    { ...context, operationId: randomUUID(), projectId: randomUUID() });
  await expect(create('/linked')).rejects.toMatchObject({ code: 'activity_busy', delivery: 'not_sent' });
  await expect(create('/independent')).resolves.toMatchObject({ created: true });
  expect(helper.calls.map(call => call.action)).toEqual(['worktree/create']);
});

test('an admitted worktree write retains its verified repository identity throughout the mutation', async () => {
  const { RepositoryLeases } = await import('../../src/runtime/repository-leases.js');
  const identities = new Map([['/origin', 'first'], ['/linked', 'first']]);
  const leases = new RepositoryLeases(async cwd => identities.get(cwd)!, () => []);
  let release!: () => void;
  const admitted = new Promise<void>(done => { release = done; });
  let entered!: () => void;
  const started = new Promise<void>(done => { entered = done; });
  const first = leases.run('/origin', true, async () => { entered(); await admitted; });
  await started;
  try {
    identities.set('/origin', 'replacement');
    await expect(leases.run('/linked', true, async () => {})).rejects.toMatchObject({ code: 'activity_busy' });
  } finally { release(); await first; }
  await expect(leases.run('/linked', true, async () => 'ok')).resolves.toBe('ok');
});

test('a Git write and normal work in a standalone directory are admitted in either order', async () => {
  const { RepositoryLeases } = await import('../../src/runtime/repository-leases.js');
  const plain = '/standalone', root = '/repository', nestedLinked = '/other-checkout/child';
  const identity = async (cwd: string) => cwd === plain ? 'ordinary-directory-id' : 'git-common-id';
  const leases = new RepositoryLeases(identity, () => [plain]);
  await leases.run(root, true, async check => {
    check();
    await expect(leases.run(plain, false, async () => 'started')).resolves.toBe('started');
    await expect(leases.run(nestedLinked, false, async () => 'started')).rejects.toMatchObject({ code: 'activity_busy' });
  });
});
