import { afterEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, watch, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RuntimeService } from '../../src/runtime/service.js';
import { NativeRpc } from '../../src/runtime/native.js';
import { DeliveryError, LIMITS, type JsonObject } from '../../src/runtime/types.js';

const services: RuntimeService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });
function setup(stage: string, startupDelayMs = 0) {
  const parent = path.resolve('.work/defaults-lifecycle'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'run-')); const marker = path.join(root, 'probe.pid');
  const main = Object.assign(new EventEmitter(), {
    connected: true, budget: { pending: 0, retainedBytes: 0 }, readGate: undefined as Promise<void> | undefined,
    async call() { await this.readGate; return { config: {} }; }, async close() { this.connected = false; },
  });
  const fixture = path.resolve('tests/runtime/native-fixture.mjs');
  const args = startupDelayMs ? ['--input-type=module', '-e', `await new Promise(resolve => setTimeout(resolve, ${startupDelayMs})); await import(${JSON.stringify(pathToFileURL(fixture).href)});`] : [fixture];
  const service = new RuntimeService({ bin: process.execPath, args, home: root, workerHome: root, cwd: root, dev: true,
    env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), HARNESS_FIXTURE_HOLD: stage, HARNESS_FIXTURE_PID_FILE: marker },
  }, main as unknown as NativeRpc);
  services.push(service); return { service, main, marker, root };
}

function heldPid(marker: string, pending: Promise<unknown>): Promise<number> {
  let watcher: ReturnType<typeof watch> | undefined, timer: NodeJS.Timeout | undefined;
  return new Promise<number>((resolve, reject) => {
    const check = () => {
      try { const text = readFileSync(marker, 'utf8'), pid = Number(text); if (/^[1-9]\d*\n$/.test(text) && Number.isSafeInteger(pid)) resolve(pid); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') reject(error); }
    };
    watcher = watch(path.dirname(marker), check); watcher.once('error', reject);
    // Match the real Windows controller startup budget in windows-job.test.ts.
    timer = setTimeout(() => reject(new Error('Defaults fixture did not reach its held stage within the controller startup budget')), 10000);
    void pending.then(value => reject(new Error('Defaults probe ended before held readiness', { cause: value })), reject);
    check();
  }).finally(() => { watcher?.close(); if (timer) clearTimeout(timer); });
}

test.each([['initialize', 0], ['thread/start', 0], ['thread/start', 1200]] as const)('closing the service awaits its actual defaults child held at %s with %d ms startup delay', async (stage, startupDelayMs) => {
  const { service, main, marker, root } = setup(stage, startupDelayMs);
  const pending = service.call('defaults/read', { cwd: root }, { clientId: 'test' }).catch((error: unknown) => error);
  const pid = await heldPid(marker, pending);
  expect(() => process.kill(pid, 0)).not.toThrow();
  const closing = service.close(); expect(service.close()).toBe(closing); await closing;
  expect(main.connected).toBe(false); expect(() => process.kill(pid, 0)).toThrow();
  expect(await pending).toMatchObject({ code: 'runtime_lost', delivery: 'unknown' });
  await expect(service.call('defaults/read', { cwd: root }, { clientId: 'test' })).rejects.toMatchObject({ code: 'runtime_unavailable' });
});

test('held readiness diagnoses early probe failure and waits for a complete PID record', async () => {
  const { marker } = setup('initialize'), failure = new Error('Fixture exited before its hold');
  await expect(heldPid(marker, Promise.resolve(failure))).rejects.toMatchObject({ message: 'Defaults probe ended before held readiness', cause: failure });
  writeFileSync(marker, String(process.pid)); let ready = false;
  const waiting = heldPid(marker, new Promise(() => {})).then(pid => { ready = true; return pid; });
  await Promise.resolve(); expect(ready).toBe(false);
  writeFileSync(marker, `${process.pid}\n`); expect(await waiting).toBe(process.pid);
});

test('a config read completing after shutdown cannot create a new defaults process', async () => {
  const { service, main, marker, root } = setup('initialize'); let resume!: () => void;
  main.readGate = new Promise(resolve => { resume = resolve; });
  const pending = service.call('defaults/read', { cwd: root }, { clientId: 'test' }).catch((error: unknown) => error);
  await service.close(); resume();
  expect(await pending).toMatchObject({ code: 'runtime_unavailable', delivery: 'not_sent' }); expect(existsSync(marker)).toBe(false);
});

function concurrentDefaults() {
  const parent = path.resolve('.work/defaults-concurrency'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'run-')), started = path.join(root, 'started.jsonl'), controls = path.join(root, 'controls.json');
  const fixture = path.join(root, 'fixture.mjs');
  writeFileSync(fixture, `import readline from 'node:readline'; import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line); if (m.method === 'initialized') return;
 if (m.method === 'initialize') { send({ id: m.id, result: {} }); return; }
 if (m.method !== 'thread/start') throw Error('Unexpected probe method');
 const index = existsSync(process.env.STARTED) ? readFileSync(process.env.STARTED, 'utf8').trim().split('\\n').length + 1 : 1;
 appendFileSync(process.env.STARTED, JSON.stringify({ pid: process.pid, params: m.params }) + '\\n');
 const timer = setInterval(() => {
  let control; try { control = JSON.parse(readFileSync(process.env.CONTROLS, 'utf8'))[index]; } catch { return; }
  if (!control) return; clearInterval(timer);
  if (control.error) { send({ id: m.id, error: { code: -32000, message: 'fixture rejection' } }); return; }
  send({ id: m.id, result: { model: m.params.model ?? control.model ?? 'fixture-default', modelProvider: 'fixture', reasoningEffort: 'low', cwd: m.params.cwd, approvalPolicy: 'never', sandbox: { type: 'readOnly' }, activePermissionProfile: null } });
 }, 10);
});\n`);
  const main = Object.assign(new EventEmitter(), {
    connected: true, budget: { pending: 0, retainedBytes: 0 }, config: { revision: 'initial' } as JsonObject, reads: [] as JsonObject[],
    async call(method: string, params: JsonObject) { expect(method).toBe('config/read'); this.reads.push({ ...params, config: this.config }); return { config: this.config }; },
    async close() { this.connected = false; },
  });
  const service = new RuntimeService({ bin: process.execPath, args: [fixture], home: root, workerHome: root, cwd: root, dev: true,
    env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), STARTED: started, CONTROLS: controls },
  }, main as unknown as NativeRpc);
  services.push(service);
  const starts = (): { pid: number; params: JsonObject }[] => existsSync(started) ? readFileSync(started, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const released: Record<string, JsonObject> = {};
  const release = (index: number, result: JsonObject = {}) => { released[index] = result; writeFileSync(controls, JSON.stringify(released)); };
  const held = async (count = 1) => {
    await vi.waitFor(() => expect(starts()).toHaveLength(count), { timeout: 10000 });
    // A successor cannot start until its predecessor's real OS process exited.
    for (const previous of starts().slice(0, -1)) expect(() => process.kill(previous.pid, 0)).toThrow();
  };
  const read = (options: JsonObject = {}, cwd = root) => service.call('defaults/read', { cwd, options }, { clientId: 'test' });
  return { root, service, main, starts, release, held, read };
}

test('concurrent identical defaults share one actual child and its completed cache', async () => {
  const f = concurrentDefaults(), first = f.read(); await f.held();
  const others = Array.from({ length: 7 }, () => f.read());
  await vi.waitFor(() => expect(f.main.reads).toHaveLength(8)); expect(f.starts()).toHaveLength(1);
  f.release(1); const values = await Promise.all([first, ...others]);
  expect(values.every(value => JSON.stringify(value) === JSON.stringify(values[0]))).toBe(true);
  expect(await f.read()).toEqual(values[0]); expect(f.starts()).toHaveLength(1);
});

test('different cwd and options wait for cleanup and reread changed configuration before choosing a cache key', async () => {
  const f = concurrentDefaults(), other = path.join(f.root, 'other'); mkdirSync(other);
  const first = f.read({ model: 'first' }); await f.held();
  let settled = false; const second = f.read({ model: 'second' }, other).finally(() => { settled = true; });
  await vi.waitFor(() => expect(f.main.reads).toHaveLength(2)); expect(settled).toBe(false);
  f.main.config = { revision: 'changed-while-waiting' }; f.release(1); await first; await f.held(2);
  expect(f.main.reads.at(-1)).toMatchObject({ cwd: other, config: { revision: 'changed-while-waiting' } });
  expect(f.starts()[1]!.params).toMatchObject({ cwd: other, model: 'second', ephemeral: true });
  f.release(2); expect(await second).toMatchObject({ cwd: other, model: 'second' });
  expect(await f.read({ model: 'second' }, other)).toMatchObject({ cwd: other, model: 'second' }); expect(f.starts()).toHaveLength(2);
});

test('account invalidation cannot share or repopulate an older defaults generation', async () => {
  const f = concurrentDefaults(), first = f.read(); await f.held();
  f.main.emit('notification', { method: 'account/updated', params: {} });
  const second = f.read(); f.release(1, { model: 'old-account' }); await f.held(2);
  f.release(2, { model: 'new-account' });
  expect(await first).toMatchObject({ model: 'new-account' }); expect(await second).toMatchObject({ model: 'new-account' });
  expect(await f.read()).toMatchObject({ model: 'new-account' }); expect(f.starts()).toHaveLength(2);
});

test('a changed config value alone does not reuse an in-flight or cached defaults result', async () => {
  const f = concurrentDefaults(), first = f.read(); await f.held();
  f.main.config = { revision: 'different-config-same-cwd-and-options' };
  const second = f.read(); await vi.waitFor(() => expect(f.main.reads).toHaveLength(2));
  f.release(1, { model: 'old-config' }); expect(await first).toMatchObject({ model: 'old-config' }); await f.held(2);
  f.release(2, { model: 'new-config' }); expect(await second).toMatchObject({ model: 'new-config' });
  expect(await f.read()).toMatchObject({ model: 'new-config' }); expect(f.starts()).toHaveLength(2);
});

test('a definitive shared probe rejection releases capacity and is not cached', async () => {
  const f = concurrentDefaults(), first = f.read(); await f.held(); const second = f.read();
  const results = Promise.allSettled([first, second]); await vi.waitFor(() => expect(f.main.reads).toHaveLength(2));
  f.release(1, { error: true }); const failed = await results;
  expect(failed).toEqual([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'native_error', delivery: 'not_sent' }) }), expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'native_error', delivery: 'not_sent' }) })]);
  const retry = f.read(); await f.held(2); f.release(2); expect(await retry).toMatchObject({ model: 'fixture-default' });
  expect((f.service.status() as JsonObject).activity).toMatchObject({ unknown: false });
});

test('close rejects shared active reads with their native outcome and never starts a queued different key', async () => {
  const f = concurrentDefaults(), first = f.read(); await f.held();
  const second = f.read(), other = f.read({ model: 'other' });
  const results = Promise.allSettled([first, second, other]); await vi.waitFor(() => expect(f.main.reads).toHaveLength(3));
  // The main config callback increments reads before its caller resumes. Let
  // both consumers actually join/wait before testing shutdown of that state.
  await new Promise<void>(resolve => setImmediate(resolve));
  const closing = f.service.close(); expect(f.service.close()).toBe(closing); await closing;
  const failed = await results;
  for (const value of failed.slice(0, 2)) expect(value).toMatchObject({ status: 'rejected', reason: { code: 'runtime_lost', delivery: 'unknown' } });
  expect(failed[2]).toMatchObject({ status: 'rejected', reason: { code: 'runtime_unavailable', delivery: 'not_sent' } });
  expect(f.starts()).toHaveLength(1); expect(() => process.kill(f.starts()[0]!.pid, 0)).toThrow();
});

test('defaults request capacity is bounded before config reads and reusable after shared completion', async () => {
  const f = concurrentDefaults(), first = f.read(); await f.held();
  const rest = Array.from({ length: LIMITS.pending - 1 }, () => f.read());
  await vi.waitFor(() => expect(f.main.reads).toHaveLength(LIMITS.pending));
  await expect(f.read()).rejects.toMatchObject({ code: 'capacity', delivery: 'not_sent' }); expect(f.main.reads).toHaveLength(LIMITS.pending);
  f.release(1); await Promise.all([first, ...rest]); expect(await f.read()).toMatchObject({ model: 'fixture-default' }); expect(f.starts()).toHaveLength(1);
});

test('the total defaults deadline ends a blocked config read without starting a late probe', async () => {
  const { service, main, marker, root } = setup('initialize'); let resume!: () => void;
  main.readGate = new Promise(resolve => { resume = resolve; });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const result = service.call('defaults/read', { cwd: root }, { clientId: 'test' }).catch(error => error);
    await vi.advanceTimersByTimeAsync(30000); expect(await result).toMatchObject({ code: 'timeout', delivery: 'unknown' });
    resume(); await Promise.resolve(); await Promise.resolve(); expect(existsSync(marker)).toBe(false);
  } finally { vi.useRealTimers(); }
});

test('unconfirmed probe cleanup still marks unknown and prevents the waiting key from starting', async () => {
  const f = concurrentDefaults(), original = NativeRpc.prototype.close, fatal = vi.fn(); f.service.on('fatal', fatal);
  const cleanup = vi.spyOn(NativeRpc.prototype, 'close').mockImplementation(async function(this: NativeRpc) {
    await original.call(this); throw new DeliveryError('cleanup_unconfirmed', 'fixture cleanup acknowledgement lost', 'unknown');
  });
  try {
    const first = f.read(); await f.held(); const other = f.read({ model: 'other' });
    const results = Promise.allSettled([first, other]); await vi.waitFor(() => expect(f.main.reads).toHaveLength(2)); f.release(1);
    const failed = await results; expect(failed[0]).toMatchObject({ status: 'rejected', reason: { code: 'cleanup_unconfirmed', delivery: 'unknown' } });
    expect(failed[1]).toMatchObject({ status: 'rejected', reason: { code: 'activity_unknown' } });
    expect((f.service.status() as JsonObject).activity).toMatchObject({ unknown: true }); expect(fatal).toHaveBeenCalledOnce(); expect(f.starts()).toHaveLength(1);
  } finally { cleanup.mockRestore(); }
});
