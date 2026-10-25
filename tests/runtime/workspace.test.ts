import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { beforeEach, expect, test, vi } from 'vitest';
import type { JsonObject } from '../../src/runtime/types.js';

const fixture = vi.hoisted(() => ({ stdout: '{"ok":true,"result":{"fixture":true}}', error: null as Error | null, bodies: [] as string[], calls: [] as unknown[][], kills: [] as string[] }));
vi.mock('node:child_process', () => ({ execFile: (...args: unknown[]) => {
  fixture.calls.push(args.slice(0, 3));
  const done = args[3] as (error: Error | null, stdout: string) => void;
  const stdin = Object.assign(new EventEmitter(), { end(body: string) { fixture.bodies.push(body); queueMicrotask(() => done(fixture.error, fixture.stdout)); }, destroy() {} });
  return { stdin, kill(signal: string) { fixture.kills.push(signal); } };
} }));
import { nativeCommand } from '../../src/runtime/native-launch.js';
import { runWorkspace, workspaceRequest } from '../../src/runtime/workspace.js';

const config = { bin: '/untrusted-command', env: { ADMIN_TOKEN: 'fixture-private', PATH: '/untrusted' }, cwd: '/native-only-project', args: ['--arbitrary'], launcher: { path: '/usr/lib/codex-harness/test/native-launch', user: 'ch-test-worker' } };
const root = { path: '/registered/project' };
beforeEach(() => { fixture.calls.length = fixture.bodies.length = fixture.kills.length = 0; fixture.stdout = '{"ok":true,"result":{"fixture":true}}'; fixture.error = null; });

test('workspace requires a fixed native launcher and never uses configured generic binary', () => {
  expect(nativeCommand(config, 'workspace')).toEqual({ bin: '/usr/bin/sudo', args: ['-n', '-u', 'ch-test-worker', '--', config.launcher.path, 'workspace'], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, cwd: '/' });
  expect(() => nativeCommand({ ...config, launcher: undefined }, 'workspace')).toThrow('identity launcher');
});
test('read requests cannot smuggle a root, command, environment or mutation identity', () => {
  for (const params of [{ path: 'a', root: '/other' }, { path: 'a', command: 'anything' }, { path: 'a', env: {} }]) expect(() => workspaceRequest(root, 'read', params, { clientId: 'c' })).toThrow();
  expect(() => workspaceRequest(root, 'shell', {}, { clientId: 'c' })).toThrow();
  expect(workspaceRequest(root, 'read', { path: 'a' }, { clientId: 'c', operationId: randomUUID() })).not.toHaveProperty('operationId');
});
test('path escapes, metadata and binary or unversioned edits fail before dispatch', async () => {
  for (const name of ['/etc/private', '../secret', 'a/../b', 'a\\b', '.git/config', '.harness-workspace/state', 'a\0b']) await expect(runWorkspace(config, root, 'read', { path: name }, { clientId: 'c' })).rejects.toMatchObject({ delivery: 'not_sent' });
  await expect(runWorkspace(config, root, 'write', { path: 'a', text: 'new' }, { clientId: 'c', operationId: randomUUID(), beforeWrite() {} })).rejects.toThrow();
  expect(fixture.calls).toHaveLength(0);
});
test('mutation sends bounded JSON only after the durable write boundary', async () => {
  const operationId = randomUUID(); let admitted = false;
  await expect(runWorkspace(config, root, 'write', { path: 'AGENTS.md', text: 'new', expectedRevision: null }, { clientId: 'c', operationId, beforeWrite() { expect(fixture.bodies).toHaveLength(0); admitted = true; } })).resolves.toEqual({ fixture: true });
  expect(admitted).toBe(true);
  expect(JSON.parse(fixture.bodies[0]!)).toEqual({ version: 1, action: 'write', root: root.path, params: { path: 'AGENTS.md', text: 'new', expectedRevision: null }, operationId });
  expect(fixture.calls[0]![2]).toMatchObject({ env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, cwd: '/', timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  expect(JSON.stringify(fixture.calls)).not.toContain('fixture-private');
});
test('owner fence failure sends no body and stops the waiting helper', async () => {
  const lost = new Error('owner lost');
  await expect(runWorkspace(config, root, 'mkdir', { path: 'folder' }, { clientId: 'c', operationId: randomUUID(), beforeWrite() { throw lost; } })).rejects.toBe(lost);
  expect(fixture.bodies).toHaveLength(0);
  expect(fixture.kills).toEqual(['SIGTERM']);
});
test('reads do not consume the mutation boundary', async () => {
  const beforeWrite = vi.fn();
  await runWorkspace(config, root, 'git/status', {}, { clientId: 'c', beforeWrite });
  expect(beforeWrite).not.toHaveBeenCalled();
  expect(JSON.parse(fixture.bodies[0]!)).not.toHaveProperty('operationId');
});

test('literal search is read only and rejects regex-like execution options or broad paths', async () => {
  const beforeWrite = vi.fn();
  await runWorkspace(config, root, 'search', { query: '[a.*]', mode: 'text', limit: 10 }, { clientId: 'c', beforeWrite });
  expect(beforeWrite).not.toHaveBeenCalled();
  for (const params of [{ query: '' }, { query: 'a\nb' }, { query: 'x', path: '../' }, { query: 'x', mode: 'shell' }, { query: 'x', limit: 101 }, { query: 'x', regex: true }]) expect(() => workspaceRequest(root, 'search', params, { clientId: 'c' })).toThrow();
});

test('download uses an explicit revision and bounded larger response without a write receipt', async () => {
  const beforeWrite = vi.fn();
  await runWorkspace(config, root, 'download', { path: 'feedback.zip', expectedRevision: 'a'.repeat(64) }, { clientId: 'c', beforeWrite });
  expect(beforeWrite).not.toHaveBeenCalled();
  expect(JSON.parse(fixture.bodies[0]!)).not.toHaveProperty('operationId');
  expect(fixture.calls[0]![2]).toMatchObject({ maxBuffer: 12 * 1024 * 1024 });
  expect(() => workspaceRequest(root, 'download', { path: 'feedback.zip' }, { clientId: 'c' })).toThrow();
});
test('truncated or missing mutation results remain unknown with no replay', async () => {
  fixture.stdout = ''; fixture.error = new Error('timeout');
  await expect(runWorkspace(config, root, 'mkdir', { path: 'folder' }, { clientId: 'c', operationId: randomUUID(), beforeWrite() {} })).rejects.toMatchObject({ code: 'workspace_unavailable', delivery: 'unknown' });
  expect(fixture.calls).toHaveLength(1);
});
test('explicit helper conflicts preserve their delivery result', async () => {
  fixture.stdout = '{"ok":false,"error":{"code":"conflict","message":"Workspace changed","delivery":"unknown"}}';
  await expect(runWorkspace(config, root, 'remove', { path: 'a', expectedRevision: 'a'.repeat(64), confirm: true, recursive: false }, { clientId: 'c', operationId: randomUUID(), beforeWrite() {} })).rejects.toMatchObject({ code: 'conflict', message: 'Workspace changed', delivery: 'unknown' });
});
test('delete and git choices require exact safe fields', () => {
  for (const params of [{ path: 'a', expectedRevision: 'a'.repeat(64) }, { path: 'a', expectedRevision: 'a'.repeat(64), confirm: true, recursive: true }]) expect(() => workspaceRequest(root, 'remove', params, { clientId: 'c', operationId: randomUUID() })).toThrow();
  expect(() => workspaceRequest(root, 'git/diff', { staged: 'true' }, { clientId: 'c' })).toThrow();
});

test('commit binds explicit HEAD and index versions and author before the durable boundary', async () => {
  const params = { expectedHead: 'a'.repeat(40), expectedHeadRevision: 'b'.repeat(64), expectedIndexRevision: 'c'.repeat(64), author: { name: 'Fixture', email: 'fixture@example.invalid' }, message: 'Commit staged changes' };
  const operationId = randomUUID(); const beforeWrite = vi.fn();
  await runWorkspace(config, root, 'git/commit', params, { clientId: 'c', operationId, beforeWrite });
  expect(beforeWrite).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fixture.bodies[0]!)).toMatchObject({ action: 'git/commit', params, operationId });
  expect(fixture.calls[0]![2]).toMatchObject({ timeout: 90000 });
  for (const changed of [{ expectedHead: 'HEAD' }, { expectedIndexRevision: 'bad' }, { author: { name: 'a\nb', email: 'x@example.invalid' } }, { author: { name: 'Fixture', email: 'invalid' } }, { message: ' ' }, { args: ['--amend'] }]) expect(() => workspaceRequest(root, 'git/commit', { ...params, ...changed }, { clientId: 'c', operationId })).toThrow();
  expect(workspaceRequest(root, 'git/commit', params, { clientId: 'c', operationId }).params).not.toBe(params);
});
test('recovery reads are nonmutating while restore and discard require exact source identities', async () => {
  const source = randomUUID(); const beforeWrite = vi.fn();
  await runWorkspace(config, root, 'recovery/read', { operationId: source }, { clientId: 'c', beforeWrite });
  expect(beforeWrite).not.toHaveBeenCalled();
  const params = { recoveryOperationId: source, slot: 'before', path: 'restored', sourceRevision: 'a'.repeat(64), expectedRevision: null };
  for (const changed of [{ path: '../outside' }, { slot: 'state.json' }, { expectedRevision: false }, { sourceRevision: 'bad' }]) expect(() => workspaceRequest(root, 'recovery/restore', { ...params, ...changed }, { clientId: 'c', operationId: randomUUID() })).toThrow();
  await runWorkspace(config, root, 'recovery/restore', params, { clientId: 'c', operationId: randomUUID(), beforeWrite });
  expect(beforeWrite).toHaveBeenCalledTimes(1);
  expect(() => workspaceRequest(root, 'recovery/discard', { recoveryOperationId: source, expectedManifest: 'a'.repeat(64) }, { clientId: 'c', operationId: randomUUID() })).toThrow();
});
test('managed worktree creation uses the durable id and never accepts a destination or caller binding', async () => {
  const operationId = randomUUID();
  await runWorkspace(config, root, 'worktree/create', { ref: 'HEAD' }, { clientId: 'c', operationId, beforeWrite() {} });
  expect(JSON.parse(fixture.bodies[0]!)).toMatchObject({ action: 'worktree/create', operationId, params: { ref: 'HEAD' } });
  expect(fixture.calls[0]![2]).toMatchObject({ timeout: 90000 });
  for (const params of [{ ref: 'HEAD', destination: '/arbitrary' }, { ref: 'HEAD', binding: {} }, { ref: '--exec' }, { ref: 'HEAD~1' }]) expect(() => workspaceRequest(root, 'worktree/create', params, { clientId: 'c', operationId })).toThrow();
});
test('existing worktrees require an internal immutable binding and browser fields cannot substitute it', () => {
  const worktreeId = randomUUID();
  const binding = { version: 1, worktreeId, originRoot: root.path, commonDir: root.path + '/.git', commonDevice: 1, commonInode: 2,
    gitDir: root.path + '/.git/worktrees/id', gitDirDevice: 1, gitDirInode: 3, worktreeDevice: 1, worktreeInode: 4 };
  expect(() => workspaceRequest(root, 'worktree/read', { worktreeId }, { clientId: 'c' })).toThrow('supervisor-owned');
  expect(() => workspaceRequest(root, 'worktree/read', { worktreeId, binding }, { clientId: 'c' })).toThrow();
  const request = workspaceRequest({ ...root, worktreeBinding: binding }, 'worktree/read', { worktreeId }, { clientId: 'c' });
  binding.worktreeInode = 99;
  expect(request.binding).toMatchObject({ worktreeInode: 4 });
  expect(() => workspaceRequest({ ...root, worktreeBinding: binding }, 'worktree/archive', { worktreeId, expectedRevision: 'a'.repeat(64) }, { clientId: 'c', operationId: randomUUID() })).toThrow('confirmation');
});
