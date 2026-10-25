import { afterEach, expect, test } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, watch, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RuntimeService } from '../../src/runtime/service.js';
import type { NativeRpc } from '../../src/runtime/native.js';

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
