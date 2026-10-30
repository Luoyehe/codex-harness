import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { executionPolicyFromEnvironment, prepareRuntimeHomes } from '../../src/runtime/main.js';
import * as launch from '../../src/runtime/native-launch.js';
import { RuntimeService, type RuntimeConfig } from '../../src/runtime/service.js';
import type { NativeRpc } from '../../src/runtime/native.js';
import { object } from '../../src/runtime/types.js';
import { createProject, resolveProject } from '../../src/runtime/projects.js';

const child = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), ...child }));
const revision = 'a'.repeat(64);
const nativePolicy: launch.ExecutionPolicy = { mode: 'native', rootAllowed: false, revision };
const rootPolicy: launch.ExecutionPolicy = { mode: 'root', rootAllowed: true, revision };
const launcher = (mode: 'native' | 'root') => ({ path: '/usr/lib/codex-harness/test/native-launch', user: mode === 'root' ? 'root' : 'ch-test-worker' });
const base: RuntimeConfig = { bin: '/fixed/codex', cwd: '/private/native', home: '/private/native/codex', workerHome: '/private/supervisor', env: { PRIVATE_VALUE: 'never-inherited' } };
const services: RuntimeService[] = [];
let output: unknown;
beforeEach(() => {
  child.execFile.mockReset(); child.spawn.mockReset(); output = { ...nativePolicy, effectiveUid: 123, requiresRestart: true };
  child.execFile.mockImplementation((_bin: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
    queueMicrotask(() => callback(null, JSON.stringify(output)));
    return { stdin: { on() {}, end: vi.fn() } };
  });
});
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); vi.restoreAllMocks(); });

test.each(['native', 'root'] as const)('managed %s launch keeps fixed verbs and a clean environment', mode => {
  const config = { ...base, launcher: launcher(mode), args: ['caller-command'], catalogProvider: 'provider_a' };
  for (const verb of ['identity', 'version', 'resolve-project', 'workspace'] as const)
    expect(launch.nativeCommand(config, verb)).toEqual({ bin: '/usr/bin/sudo', args: ['-n', '-u', launcher(mode).user, '--', launcher(mode).path, verb], cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
  expect(launch.nativeCommand(config, 'app-server').args).toEqual(['-n', '-u', launcher(mode).user, '--', launcher(mode).path, 'catalog-server', 'provider_a']);
  expect(() => launch.nativeCommand(base, 'identity')).toThrow('require an identity launcher');
});

test('legacy compatibility permits only an exact worker identity with no new policy labels', () => {
  expect(executionPolicyFromEnvironment({}, 'ch-test-worker')).toBeUndefined();
  expect(() => executionPolicyFromEnvironment({}, 'root')).toThrow('Invalid managed execution policy');
  expect(() => executionPolicyFromEnvironment({}, 'nobody')).toThrow('Invalid managed execution policy');
  expect(() => executionPolicyFromEnvironment({ HARNESS_EXECUTION_MODE: 'native' }, 'ch-test-worker')).toThrow('Invalid managed execution policy');
});

test.each([
  ['native', '0', 'ch-test-worker', false], ['native', '1', 'ch-test-worker', true], ['root', '1', 'root', true],
] as const)('complete managed policy %s/%s is explicit and root authorization is preserved', (mode, allowed, user, rootAllowed) => {
  expect(executionPolicyFromEnvironment({ HARNESS_EXECUTION_MODE: mode, HARNESS_ROOT_ALLOWED: allowed, HARNESS_EXECUTION_REVISION: revision }, user)).toEqual({ mode, rootAllowed, revision });
});

test.each([
  { mode: 'root', allowed: '0', user: 'root' }, { mode: 'native', allowed: '1', user: 'root' },
  { mode: 'root', allowed: '1', user: 'ch-test-worker' }, { mode: 'sudo', allowed: '1', user: 'root' },
  { mode: 'native', allowed: 'true', user: 'ch-test-worker' }, { mode: 'native', allowed: '0', user: 'ch-test-worker', revision: 'old' },
])('invalid or mismatched managed identity is refused: %j', value => {
  expect(() => executionPolicyFromEnvironment({ HARNESS_EXECUTION_MODE: value.mode, HARNESS_ROOT_ALLOWED: value.allowed, HARNESS_EXECUTION_REVISION: value.revision ?? revision }, value.user)).toThrow('Invalid managed execution policy');
});

test.each([nativePolicy, rootPolicy])('identity probe validates actual %s UID before native startup', async policy => {
  output = { ...policy, effectiveUid: policy.mode === 'root' ? 0 : 123, requiresRestart: true };
  expect(await launch.readNativeExecutionMode({ ...base, launcher: launcher(policy.mode) }, policy)).toEqual(output);
  expect(child.execFile.mock.calls[0]!.slice(0, 2)).toEqual(['/usr/bin/sudo', ['-n', '-u', launcher(policy.mode).user, '--', launcher(policy.mode).path, 'identity']]);
  expect(child.execFile.mock.calls[0]![2]).toMatchObject({ cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, timeout: 10000, maxBuffer: 8192 });
});

test.each([
  { effectiveUid: 0 }, { effectiveUid: -1 }, { effectiveUid: 0.5 }, { effectiveUid: 0x100000000 },
  { revision: 'b'.repeat(64) }, { rootAllowed: true }, { mode: 'root' }, { requiresRestart: false }, { home: '/caller-selected-home' },
])('startup rejects mismatched identity without spawning an app-server: %j', patch => {
  output = { ...nativePolicy, effectiveUid: 123, requiresRestart: true, ...patch };
  return expect(RuntimeService.create({ ...base, launcher: launcher('native'), executionPolicy: nativePolicy })).rejects.toMatchObject({ code: 'native_identity_mismatch', delivery: 'not_sent' }).then(() => { expect(child.spawn).not.toHaveBeenCalled(); });
});

test('root startup requires authorization and an actual UID zero, never a missing policy fallback', async () => {
  await expect(RuntimeService.create({ ...base, launcher: launcher('root') })).rejects.toMatchObject({ code: 'native_identity_mismatch' });
  expect(child.execFile).not.toHaveBeenCalled();
  output = { ...rootPolicy, effectiveUid: 123, requiresRestart: true };
  await expect(RuntimeService.create({ ...base, launcher: launcher('root'), executionPolicy: rootPolicy })).rejects.toMatchObject({ code: 'native_identity_mismatch' });
  expect(child.spawn).not.toHaveBeenCalled();
});

test('worker state reports its immutable startup identity and legacy state does not invent a UID', async () => {
  const roots = path.resolve('.work/execution-mode-tests'); mkdirSync(roots, { recursive: true });
  const workerHome = mkdtempSync(path.join(roots, 'state-'));
  const native = Object.assign(new EventEmitter(), { connected: true, budget: { pending: 0, retainedBytes: 0 }, close: async () => {} });
  const identity: launch.ExecutionMode = { ...rootPolicy, effectiveUid: 0, requiresRestart: true };
  const service = new RuntimeService({ ...base, workerHome }, native as unknown as NativeRpc, identity); services.push(service);
  identity.mode = 'native'; identity.effectiveUid = 123;
  const first = object(service.status()); expect(first.executionMode).toEqual({ ...rootPolicy, effectiveUid: 0, requiresRestart: true });
  object(first.executionMode).mode = 'native'; expect(object(object(service.status()).executionMode).mode).toBe('root');
  native.connected = false; native.emit('fatal');
  expect(service.status()).toMatchObject({ connected: false, executionMode: { mode: 'root', effectiveUid: 0 }, activity: { unknown: true } });
  const legacy = new RuntimeService({ ...base, workerHome }, native as unknown as NativeRpc); services.push(legacy);
  expect(object(legacy.status()).executionMode).toBeUndefined();
});

test('supervisor creates only its own storage for managed homes and retains dev home setup', () => {
  const roots = path.resolve('.work/execution-mode-tests'); mkdirSync(roots, { recursive: true });
  const directory = mkdtempSync(path.join(roots, 'homes-'));
  const config = { ...base, workerHome: path.join(directory, 'supervisor'), home: path.join(directory, 'worker-root', 'codex'), launcher: launcher('root') };
  prepareRuntimeHomes(config);
  expect(existsSync(config.workerHome)).toBe(true); expect(existsSync(path.dirname(config.home))).toBe(false);
  prepareRuntimeHomes({ ...config, launcher: undefined }); expect(existsSync(config.home)).toBe(true);
});

test.each(['native', 'root'] as const)('%s project creation and resolution share auto paths while keeping the actual launcher identity', async mode => {
  const roots = path.resolve('.work/execution-mode-tests'); mkdirSync(roots, { recursive: true });
  const identity: launch.ExecutionMode = { ...(mode === 'root' ? rootPolicy : nativePolicy), effectiveUid: mode === 'root' ? 0 : 123, requiresRestart: true };
  const workerHome = mkdtempSync(path.join(roots, 'project-auto-')), nativeHome = '/native-home-' + mode;
  const native = Object.assign(new EventEmitter(), { connected: true, budget: { pending: 0, retainedBytes: 0 }, close: async () => {} });
  const service = new RuntimeService({ ...base, workerHome, nativeHome, launcher: launcher(mode) }, native as unknown as NativeRpc, identity); services.push(service);
  expect(await service.call('project/defaults', {}, { clientId: 'owner' })).toEqual({ directory: path.join(nativeHome, 'projects') });
  for (const [input, normalized] of [['//srv//projects/../new folder///', '/srv/new folder'], ['./parent/../new/', 'new'], ['../shared/', '../shared'], ['name\\child', 'name\\child']]) {
    const beforeWrite = vi.fn();
    output = { path: path.posix.resolve(nativeHome, 'projects', normalized!), name: path.posix.basename(normalized!) };
    expect(await service.call('project/create', { directory: input! }, { clientId: 'owner', beforeWrite })).toEqual(output);
    expect(beforeWrite).toHaveBeenCalledOnce();
    expect(child.execFile.mock.results.at(-1)!.value.stdin.end).toHaveBeenCalledWith(JSON.stringify({ directory: normalized }));
    expect(child.execFile.mock.calls.at(-1)![1]).toEqual(['-n', '-u', launcher(mode).user, '--', launcher(mode).path, 'resolve-project']);
    expect(await service.call('project/resolve', { path: input! }, { clientId: 'owner' })).toEqual(output);
    expect(child.execFile.mock.results.at(-1)!.value.stdin.end).toHaveBeenCalledWith(JSON.stringify({ path: normalized }));
  }
  await expect(service.call('project/create', { directory: 'new', mode: 'root' }, { clientId: 'owner', beforeWrite: () => {} })).rejects.toMatchObject({ code: 'invalid_params', delivery: 'not_sent' });
});

test.each(['native', 'root'] as const)('%s creation validates the helper JSON byte budget before dispatch and accepts a long valid leaf acknowledgement', async mode => {
  const config = { ...base, launcher: launcher(mode) }, before = vi.fn();
  const directory = '/srv/' + '"'.repeat(2050);
  await expect(createProject(config, '/native-home', directory, before)).rejects.toMatchObject({ code: 'capacity', delivery: 'not_sent' });
  await expect(resolveProject(config, directory, '/native-home')).rejects.toMatchObject({ code: 'capacity', delivery: 'not_sent' });
  expect(before).not.toHaveBeenCalled(); expect(child.execFile).not.toHaveBeenCalled();
  const name = '项'.repeat(70); output = { path: '/srv/' + name, name };
  expect(await createProject(config, '/native-home', '/srv/' + name, before)).toEqual(output);
  expect(before).toHaveBeenCalledOnce();
});

test.each(['project_parent_unavailable', 'project_permission_denied', 'project_read_only'])('helper %s remains not_sent while invalid positive creation acknowledgements remain unknown', async code => {
  const config = { ...base, launcher: launcher('root') };
  child.execFile.mockImplementationOnce((_bin: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
    queueMicrotask(() => callback(new Error('helper rejected'), JSON.stringify({ error: { code, message: 'Specific parent failure', delivery: 'not_sent' } })));
    return { stdin: { on() {}, end() {} } };
  });
  await expect(createProject(config, '/native-root', '/missing/new', () => {})).rejects.toMatchObject({ code, delivery: 'not_sent' });
  output = { path: '/srv/new', name: null };
  await expect(createProject(config, '/native-root', '/srv/new', () => {})).rejects.toMatchObject({ code: 'project_unavailable', delivery: 'unknown' });
});
