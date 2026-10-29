import { expect, test, vi } from 'vitest';
import fs, { existsSync, mkdirSync, mkdtempSync, renameSync, symlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { WorkspaceWitness } from '../../src/runtime/workspace-witness.js';
import { RuntimeWorkspace } from '../../src/runtime/workspace-service.js';
import type { CallContext, JsonObject } from '../../src/runtime/types.js';

const helper = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../src/runtime/workspace.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/runtime/workspace.js')>();
  return { ...actual, runWorkspace: async (_config: unknown, _root: unknown, _action: string, params: JsonObject, context: CallContext) => {
    context.beforeWrite?.(); helper.calls++;
    return { path: params.path, created: true };
  } };
});

function fixture() {
  const root = path.resolve('.work/workspace-witness-durability'); mkdirSync(root, { recursive: true });
  const home = mkdtempSync(path.join(root, 'case-')), directory = path.join(home, 'workspace-witness');
  return { home, directory, file: path.join(directory, 'witness.sqlite') };
}

/** Linux uses real directory descriptors/fsync. Windows models only those syscalls. */
function barriers(home: string) {
  const directory = path.join(home, 'workspace-witness');
  const original = { open: fs.openSync, close: fs.closeSync, stat: fs.fstatSync, lstat: fs.lstatSync, sync: fs.fsyncSync };
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!, emulate = process.platform === 'win32';
  const handles = new Map<number, { path: string; stat: fs.Stats }>(), synced: string[] = [], flags: number[] = [];
  let next = -100;
  const control = { fail: undefined as string | undefined, beforeSync: undefined as ((name: string) => void) | undefined };
  if (emulate) Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  const spies = [
    vi.spyOn(fs, 'openSync').mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      if (args[0] !== home && args[0] !== directory) return original.open(...args);
      const fd = emulate ? next-- : original.open(...args);
      flags.push(Number(args[1])); handles.set(fd, { path: String(args[0]), stat: original.lstat(args[0]) }); return fd;
    }) as typeof fs.openSync),
    vi.spyOn(fs, 'fstatSync').mockImplementation(((...args: Parameters<typeof fs.fstatSync>) => {
      const entry = handles.get(args[0]); return entry && emulate ? entry.stat : original.stat(...args);
    }) as typeof fs.fstatSync),
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      const entry = handles.get(fd); if (!entry) return original.sync(fd);
      synced.push(entry.path); control.beforeSync?.(entry.path);
      if (control.fail === entry.path) throw Object.assign(new Error('Injected directory sync failure'), { code: 'EIO' });
      if (!emulate) original.sync(fd);
    }),
    vi.spyOn(fs, 'closeSync').mockImplementation(fd => {
      if (!handles.delete(fd) || !emulate) original.close(fd);
    }),
  ];
  syncBuiltinESMExports();
  return { control, handles, synced, flags, restore() {
    for (const spy of spies) spy.mockRestore(); syncBuiltinESMExports();
    if (emulate) Object.defineProperty(process, 'platform', platform);
  } };
}

test.each(['child', 'parent'])('failed %s directory sync blocks dispatch and an existing-directory retry repeats both barriers', async target => {
  const { home, directory, file } = fixture(), trace = barriers(home); helper.calls = 0;
  let boundary = 0, closed = false;
  const context = { clientId: 'fixture', operationId: randomUUID(), projectId: randomUUID(), gatewayRequestDigest: 'a'.repeat(64), beforeWrite() { boundary++; } };
  const service = new RuntimeWorkspace({ config: { bin: '/unused', cwd: '/', env: {}, workerHome: home, launcher: { path: '/unused', user: 'ch-fixture-worker' } },
    cwd: () => '/project', admit() {}, configure: operation => operation(() => {}), pending() {}, uncertain() {} });
  trace.control.fail = target === 'child' ? directory : home;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      trace.synced.length = 0;
      await expect(service.call('workspace/mkdir', { cwd: '/project', path: 'folder' }, context)).rejects.toMatchObject({ code: 'witness_storage', delivery: 'not_sent' });
      expect(trace.synced).toEqual(target === 'child' ? [directory] : [directory, home]);
      expect(trace.handles.size).toBe(0); expect(existsSync(directory)).toBe(true); expect(existsSync(file)).toBe(false);
      expect(helper.calls).toBe(0); expect(boundary).toBe(0);
    }
    trace.control.fail = undefined; trace.synced.length = 0;
    await expect(service.call('workspace/mkdir', { cwd: '/project', path: 'folder' }, context)).resolves.toEqual({ path: 'folder', created: true });
    expect(trace.synced).toEqual([directory, home]); expect(trace.handles.size).toBe(0); expect(helper.calls).toBe(1); expect(boundary).toBe(1);
    await service.close(); closed = true; trace.synced.length = 0;
    const restored = new WorkspaceWitness(home);
    try { expect(restored.read({ operationId: context.operationId })).toMatchObject({ state: 'completed' }); expect(trace.synced).toEqual([directory, home]); }
    finally { restored.close(); }
    for (const flag of [fs.constants.O_DIRECTORY, fs.constants.O_NOFOLLOW, fs.constants.O_NONBLOCK]) if (flag !== undefined) expect(trace.flags.every(value => (value & flag) === flag)).toBe(true);
  } finally { try { if (!closed) await service.close(); } finally { trace.restore(); } }
});

test('parent identity replacement during the barrier fails before SQLite is opened', () => {
  const { home, file } = fixture(), trace = barriers(home);
  trace.control.beforeSync = name => {
    if (name === home) { renameSync(home, home + '-replaced'); mkdirSync(home, { mode: 0o700 }); }
  };
  try {
    expect(() => new WorkspaceWitness(home)).toThrow(expect.objectContaining({ code: 'witness_storage' }));
    expect(trace.handles.size).toBe(0); expect(existsSync(file)).toBe(false);
    expect(existsSync(path.join(home + '-replaced', 'workspace-witness', 'witness.sqlite'))).toBe(false);
  } finally { trace.restore(); }
});

test('parent or witness directory symlinks cannot become durable witness storage', () => {
  for (const target of ['parent', 'child']) {
    const { home, directory } = fixture(), outside = fixture().home;
    const link = target === 'parent' ? home + '-link' : directory;
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => new WorkspaceWitness(target === 'parent' ? link : home)).toThrow(expect.objectContaining({ code: 'witness_storage' }));
    expect(existsSync(path.join(outside, 'witness.sqlite'))).toBe(false);
    expect(existsSync(path.join(outside, 'workspace-witness'))).toBe(false);
  }
});
