import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import type { NativeOptions, NativeRpc } from '../../src/runtime/native.js';
import { DeliveryError, object, type JsonObject, type JsonValue } from '../../src/runtime/types.js';
const helper = vi.hoisted(() => ({ hook: undefined as undefined | ((action: string) => void), gate: undefined as Promise<void> | undefined, calls: [] as { action: string; binding: unknown }[], result: undefined as JsonValue | undefined }));
vi.mock('../../src/runtime/workspace.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/runtime/workspace.js')>();
  return { ...actual, runWorkspace: async (_config: unknown, root: import('../../src/runtime/workspace.js').WorkspaceRoot, action: string, params: JsonObject, context: import('../../src/runtime/types.js').CallContext, internal = false) => {
    actual.workspaceRequest(root, action, params, context, internal); helper.hook?.(action);
    if (actual.workspaceMutations.has(action) || action === 'operation/ack') context.beforeWrite?.();
    helper.calls.push({ action, binding: root.worktreeBinding }); await helper.gate;
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
beforeEach(() => { helper.calls.length = 0; helper.hook = undefined; helper.gate = undefined; helper.result = undefined; });
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });
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
  const { service, context } = setup(); let release!: () => void; helper.gate = new Promise(resolve => { release = resolve; });
  const writing = service.call('workspace/mkdir', { cwd: '/project', path: 'folder' }, context);
  const creating = service.call('workspace/worktree/create', { cwd: '/project', ref: 'HEAD' }, { ...context, operationId: randomUUID() });
  expect(helper.calls.map(call => call.action)).toEqual(['mkdir']); helper.gate = undefined; release(); await writing; await creating;
  let complete!: () => void; helper.gate = new Promise(resolve => { complete = resolve; });
  const next = service.call('workspace/worktree/create', { cwd: '/project', ref: 'HEAD' }, { ...context, operationId: randomUUID() });
  await expect.poll(() => helper.calls.length).toBe(3);
  await expect(service.call('workspace/mkdir', { cwd: '/project', path: 'other' }, { ...context, operationId: randomUUID() })).rejects.toMatchObject({ code: 'configuration_busy' });
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
  const { service, context } = setup(); let release!: () => void; helper.gate = new Promise(resolve => { release = resolve; });
  const pending = service.call('workspace/worktree/create', { cwd: '/project', ref: 'HEAD' }, context); await expect.poll(() => helper.calls.length).toBe(1);
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
  let release!: () => void; helper.gate = new Promise(resolve => { release = resolve; });
  const cleanup = service.call('workspace/witness/ack', ack, context);
  await expect(service.call('runtime/maintenance/check', {}, context)).rejects.toMatchObject({ code: 'activity_busy' });
  release(); await cleanup;
  await expect(service.call('runtime/maintenance/check', {}, context)).resolves.toMatchObject({ idle: true });
});
