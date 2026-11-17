import { afterEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { JsonValue } from '../../src/runtime/types.js';

const control = vi.hoisted(() => ({
  cleanupError: undefined as Error | undefined, readError: undefined as Error | undefined,
  wait: undefined as Promise<void> | undefined, entered: undefined as (() => void) | undefined,
  probes: [] as { close: ReturnType<typeof vi.fn> }[],
}));
vi.mock('../../src/runtime/native.js', async () => {
  const { EventEmitter } = await import('node:events');
  class NativeRpc extends EventEmitter {
    connected = true; budget = { pending: 0, retainedBytes: 0 }; number: number;
    constructor() { super(); control.probes.push(this); this.number = control.probes.length; }
    initialize = vi.fn(async () => {});
    call = vi.fn(async () => {
      if (control.readError) throw control.readError;
      return { account: { type: 'chatgpt', email: `fixture-${this.number}@example.invalid`, planType: 'plus' }, requiresOpenaiAuth: true };
    });
    close = vi.fn(async () => { control.entered?.(); await control.wait; if (control.cleanupError) throw control.cleanupError; });
  }
  return { NativeRpc };
});
import { RuntimeService } from '../../src/runtime/service.js';
import type { NativeRpc } from '../../src/runtime/native.js';
const services: RuntimeService[] = [], homes: string[] = [], context = { clientId: 'account-fixture' };
function fixture(managed = true) {
  mkdirSync('.work/account-probe-lifecycle', { recursive: true });
  const home = mkdtempSync(path.resolve('.work/account-probe-lifecycle/case-')); homes.push(home);
  const main = Object.assign(new EventEmitter(), {
    connected: true, budget: { pending: 0, retainedBytes: 0 }, close: vi.fn(async () => {}),
    call: vi.fn(async (method: string): Promise<JsonValue> => method === 'model/list' ? { data: [{ id: 'fixture', model: 'fixture' }], nextCursor: null } : {}),
  });
  const service = new RuntimeService({ bin: 'never-spawned', home, cwd: home, workerHome: home, env: {}, dev: true, ...(managed ? { providerRegistry: {
    connections: [
      { id: 'default', modelProvider: 'harness_responses', name: 'Custom', kind: 'responses', enabled: true, models: [] },
      { id: 'a'.repeat(32), modelProvider: 'harness_chatgpt', name: 'ChatGPT', kind: 'chatgpt', enabled: true, models: [] },
    ], defaultProviderId: 'default', nativeCatalogProvider: 'harness_responses',
  } } : {}) }, main as unknown as NativeRpc);
  services.push(service); return { service, main, home };
}
function holdCleanup() {
  let release!: () => void, entered!: () => void;
  control.wait = new Promise(resolve => { release = resolve; });
  const closing = new Promise<void>(resolve => { entered = resolve; }); control.entered = entered;
  return { release, closing };
}
afterEach(async () => {
  control.cleanupError = undefined; control.readError = undefined; control.wait = undefined; control.entered = undefined;
  await Promise.all(services.splice(0).map(service => service.close().catch(() => {})));
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); control.probes.length = 0;
});

test.each([false, true])('unconfirmed cleanup invalidates the epoch and stays owned even after read failure=%s', async readFails => {
  const error = new Error('Fixture cleanup unconfirmed'); control.cleanupError = error;
  if (readFails) control.readError = new Error('Fixture read failed');
  const { service, main, home } = fixture(), fatal = vi.fn(); service.on('fatal', fatal);
  await expect(service.call('account/read', {}, context)).rejects.toBe(error);
  expect(service.status()).toMatchObject({ activity: { unknown: true } }); expect(fatal).toHaveBeenCalledOnce();
  await expect(service.call('account/read', {}, context)).rejects.toMatchObject({ code: 'activity_unknown' });
  await expect(service.call('thread/start', { cwd: home }, context)).rejects.toMatchObject({ code: 'activity_unknown' });
  // Catalog failures are per-provider: no stale account cache may authorize a native model read.
  await expect(service.call('model/list', {}, context)).resolves.toMatchObject({ data: [] });
  expect(main.call).not.toHaveBeenCalledWith('model/list', expect.anything()); expect(control.probes).toHaveLength(1);
  await expect(service.close()).rejects.toThrow('cleanup was not fully confirmed');
  expect(control.probes[0]!.close).toHaveBeenCalledTimes(2);
});

test('account changes during cleanup trigger a fresh bounded read before publishing a result', async () => {
  const held = holdCleanup(), { service, main } = fixture();
  const pending = service.call('account/read', {}, context); await held.closing;
  main.emit('notification', { method: 'account/updated', params: { authMode: null } }); held.release();
  await expect(pending).resolves.toMatchObject({ account: { email: 'fixture-2@example.invalid' } }); expect(control.probes).toHaveLength(2);
});

test('repeated account changes exhaust the retry instead of returning an old account or looping', async () => {
  const { service, main } = fixture();
  control.entered = () => main.emit('notification', { method: 'account/updated', params: { authMode: null } });
  await expect(service.call('account/read', {}, context)).rejects.toMatchObject({ code: 'account_changed' }); expect(control.probes).toHaveLength(2);
});

test('whole-service close during probe cleanup rejects the old success and cached reads', async () => {
  const held = holdCleanup(), { service } = fixture();
  const pending = service.call('account/read', {}, context), rejected = expect(pending).rejects.toMatchObject({ code: 'runtime_unavailable' });
  await held.closing; const stopped = service.close(); held.release(); await stopped; await rejected;
  await expect(service.call('account/read', {}, context)).rejects.toMatchObject({ code: 'runtime_unavailable' });
  await expect(service.call('model/list', {}, context)).resolves.toMatchObject({ data: [] }); expect(control.probes).toHaveLength(1);
});

test('concurrent account and catalog reads share a probe and publish/cache only after confirmed cleanup', async () => {
  const held = holdCleanup(), { service, main } = fixture(); let settled = false;
  const first = service.call('account/read', {}, context).then(result => { settled = true; return result; }); await held.closing;
  const second = service.call('account/read', {}, context), catalog = service.call('model/list', {}, context);
  await Promise.resolve(); expect(settled).toBe(false); expect(main.call).not.toHaveBeenCalled(); expect(control.probes).toHaveLength(1);
  held.release(); const results = await Promise.all([first, second]); expect(results[0]).toEqual(results[1]);
  await expect(catalog).resolves.toMatchObject({ data: [{ model: 'fixture', modelProvider: 'harness_chatgpt' }] });
  await service.call('model/list', {}, context); expect(control.probes).toHaveLength(1);
  main.connected = false;
  await expect(service.call('account/read', {}, context)).rejects.toMatchObject({ code: 'runtime_unavailable' });
  const calls = main.call.mock.calls.length;
  await expect(service.call('model/list', {}, context)).resolves.toMatchObject({ data: [] }); expect(main.call).toHaveBeenCalledTimes(calls);
});

test('old-generation completion cannot clear the replacement generation singleflight', async () => {
  const held = holdCleanup(), { service, main } = fixture();
  const old = service.call('account/read', {}, context); await held.closing;
  main.emit('notification', { method: 'account/updated', params: { authMode: null } });
  const replacement = service.call('account/read', {}, context); await Promise.resolve(); held.release();
  const results = await Promise.all([old, replacement]);
  expect(results[0]).toEqual(results[1]); expect(results[0]).toMatchObject({ account: { email: 'fixture-2@example.invalid' } });
  expect(control.probes).toHaveLength(2);
});

test('main-process account reads reject close and retry account changes after the native await', async () => {
  const { service, main } = fixture(false); let release!: () => void;
  main.call.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return { account: { type: 'chatgpt', email: 'old@example.invalid' } }; });
  main.call.mockResolvedValueOnce({ account: null });
  const pending = service.call('account/read', {}, context);
  main.emit('notification', { method: 'account/updated', params: { authMode: null } }); release();
  await expect(pending).resolves.toEqual({ account: null }); expect(main.call).toHaveBeenCalledTimes(2);
  main.call.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return { account: null }; });
  const closingRead = service.call('account/read', {}, context), rejected = expect(closingRead).rejects.toMatchObject({ code: 'runtime_unavailable' });
  await service.close(); release(); await rejected; expect(control.probes).toHaveLength(0);
});
