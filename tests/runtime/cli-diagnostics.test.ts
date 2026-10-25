import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import type { WindowsProcessJob } from '../../src/runtime/windows-process.js';
import type { NativeOptions, NativeRpc } from '../../src/runtime/native.js';
import { object, type JsonValue, type RuntimeEvent } from '../../src/runtime/types.js';
const fixture = vi.hoisted(() => ({ jobs: [] as (WindowsProcessJob & { finish(code: number): void; fail(): void })[], commands: [] as string[][], gate: undefined as Promise<void> | undefined }));
vi.mock('../../src/runtime/windows-process.js', () => ({ windowsProcessJob: async (command: string[]) => {
  fixture.commands.push(command); await fixture.gate; let finish!: (code: number) => void, fail!: () => void;
  const exited = new Promise<number>((resolve, reject) => { finish = resolve; fail = () => reject(new Error('No cleanup proof')); }); void exited.catch(() => {});
  const job = { command: ['owned-controller'], env: {}, started: Promise.resolve(42), exited, finish, fail, signal: vi.fn(async () => {}), dispose: vi.fn() }; fixture.jobs.push(job); return job;
} }));
vi.mock('../../src/runtime/linux-process.js', async () => ({ linuxProcessJob: (await import('../../src/runtime/windows-process.js')).windowsProcessJob }));
import { RuntimeService } from '../../src/runtime/service.js';
class Native extends EventEmitter {
  connected = true; budget = { pending: 0, retainedBytes: 0 }; calls: { method: string; params: JsonValue }[] = [];
  async call(method: string, params: JsonValue, options?: NativeOptions) { options?.beforeWrite?.(); this.calls.push({ method, params }); return {}; }
  async close() { this.connected = false; }
}
const parent = path.resolve('.work/cli-diagnostics-tests'); mkdirSync(parent, { recursive: true }); const services: RuntimeService[] = [];
const owner = { clientId: 'owner', eventChannelId: 'channel', beforeWrite: () => {} };
function setup() {
  const cwd = mkdtempSync(path.join(parent, 'home-')), native = new Native(), events: RuntimeEvent[] = [];
  const service = new RuntimeService({ bin: process.execPath, home: cwd, workerHome: cwd, cwd, env: { HARNESS_PROVIDER_API_KEY: 'fixture-private-key' } }, native as unknown as NativeRpc); services.push(service); service.on('event', event => events.push(event));
  const notify = (method: string, params: JsonValue) => native.emit('notification', { method, params });
  return { cwd, service, native, events, run: () => service.call('diagnostics/cli/run', { kind: 'models-bundled' }, owner), handle: () => object(native.calls.at(-1)!.params).processHandle!, output: (processHandle: JsonValue, text: string, capReached = false, stream = 'stdout') => notify('process/outputDelta', { processHandle, deltaBase64: Buffer.from(text).toString('base64'), capReached, stream }), exit: (processHandle: JsonValue) => notify('process/exited', { processHandle, exitCode: 0, stdout: '', stderr: '', stdoutCapReached: false, stderrCapReached: false }) };
}
beforeEach(() => { fixture.jobs.length = 0; fixture.commands.length = 0; fixture.gate = undefined; });
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); vi.useRealTimers(); });
test('diagnostic maintenance holds until cleanup proof and output remains private and redacted', async () => {
  const f = setup(), pending = f.run(); await expect.poll(() => f.native.calls.length).toBe(1); const handle = f.handle(); expect(fixture.commands).toEqual([[process.execPath, 'debug', 'models', '--bundled']]);
  await expect(f.service.call('thread/start', { cwd: f.cwd }, owner)).rejects.toMatchObject({ code: 'configuration_busy' });
  f.output(handle, JSON.stringify({ models: [{ note: 'fixture-private-key' }] })); f.exit(handle); await Promise.resolve(); expect(object(object(f.service.status()).activity).pendingStarts).toBe(1); fixture.jobs[0]!.finish(0);
  const result = object(await pending); expect(result).toMatchObject({ kind: 'models-bundled', status: 'completed' });
  expect(await f.service.call('diagnostics/cli/result/read', { resultId: result.resultId! }, owner)).toMatchObject({ data: { models: [{ note: '[redacted]' }] } });
  await expect(f.service.call('diagnostics/cli/result/read', { resultId: result.resultId! }, { ...owner, eventChannelId: 'other' })).rejects.toMatchObject({ code: 'not_found' });
  expect(f.events.every(event => event.type === 'state')).toBe(true); expect(JSON.stringify(result)).not.toContain('fixture-private'); expect(object(object(f.service.status()).activity)).toMatchObject({ pendingStarts: 0, unknown: false });
});
test('disconnect while preparing revokes startup before any native command is written', async () => {
  const f = setup(); let release!: () => void; fixture.gate = new Promise(resolve => { release = resolve; }); const pending = f.run(), rejected = expect(pending).rejects.toMatchObject({ delivery: 'not_sent', code: 'client_disconnected' });
  const disconnected = f.service.clientDisconnected(owner.clientId, owner.eventChannelId); release(); await rejected; await disconnected; expect(f.native.calls).toEqual([]); expect(object(object(f.service.status()).activity)).toMatchObject({ pendingStarts: 0, unknown: false });
});
test('disconnect stops only the owned process before reporting the interrupted diagnostic', async () => {
  const f = setup(), pending = f.run(), rejected = expect(pending).rejects.toMatchObject({ delivery: 'unknown', code: 'client_disconnected' }); await expect.poll(() => f.native.calls.length).toBe(1); const handle = f.handle();
  fixture.jobs[0]!.signal = vi.fn(async () => { fixture.jobs[0]!.finish(-9); f.exit(handle); }); await f.service.clientDisconnected('other', 'channel'); expect(fixture.jobs[0]!.signal).not.toHaveBeenCalled();
  await f.service.clientDisconnected(owner.clientId, owner.eventChannelId); await rejected; expect(fixture.jobs[0]!.signal).toHaveBeenCalledOnce(); expect(object(object(f.service.status()).activity).pendingStarts).toBe(0);
});
test.each([true, false])('incomplete output explains its bounded failure without exposing raw partial output (%s)', async capped => {
  const f = setup(), pending = f.run(); await expect.poll(() => f.native.calls.length).toBe(1); const handle = f.handle(); f.output(handle, capped ? '{"models":[]}' : 'fixture-private-key malformed', capped); f.exit(handle); fixture.jobs[0]!.finish(0);
  const result = object(await pending); expect(result.status).toBe('failed'); const read = object(await f.service.call('diagnostics/cli/result/read', { resultId: result.resultId! }, owner)); expect(read).not.toHaveProperty('data'); expect(read).toMatchObject({ reason: capped ? 'output_truncated' : 'invalid_report', timedOut: false, stdoutCapReached: capped, stderrCapReached: false }); expect(JSON.stringify(read)).not.toContain('fixture-private-key'); expect(object(object(f.service.status()).activity).unknown).toBe(false);
});

test('timeout reports timed_out only after its owned process tree confirms cleanup', async () => {
  vi.useFakeTimers(); const f = setup(), pending = f.run(); await vi.waitFor(() => expect(f.native.calls.length).toBe(1)); const handle = f.handle();
  fixture.jobs[0]!.signal = vi.fn(async () => { fixture.jobs[0]!.finish(-9); f.exit(handle); }); await vi.advanceTimersByTimeAsync(20001);
  const result = object(await pending); expect(result).toMatchObject({ status: 'failed' }); expect(result).not.toHaveProperty('reason');
  expect(await f.service.call('diagnostics/cli/result/read', { resultId: result.resultId! }, owner)).toMatchObject({ reason: 'timed_out', exitCode: -9, timedOut: true, stdoutCapReached: false, stderrCapReached: false }); expect(object(object(f.service.status()).activity)).toMatchObject({ pendingStarts: 0, unknown: false });
});

test.each(['warning', 'fail', 'unrecognized'])('doctor report status %s follows the pinned observed report contract', async overallStatus => {
  const f = setup(), pending = f.service.call('diagnostics/cli/run', { kind: 'doctor' }, owner); await expect.poll(() => f.native.calls.length).toBe(1);
  const report = { schemaVersion: 1, generatedAt: '2026-10-25T00:00:00Z', codexVersion: '0.164.0', overallStatus, checks: {} };
  f.output(f.handle(), JSON.stringify(report)); f.exit(f.handle()); fixture.jobs[0]!.finish(overallStatus === 'fail' ? 1 : 0); const result = object(await pending);
  const read = object(await f.service.call('diagnostics/cli/result/read', { resultId: result.resultId! }, owner));
  if (overallStatus === 'unrecognized') expect(read).toMatchObject({ status: 'failed', reason: 'invalid_report' });
  else expect(read).toMatchObject({ status: 'completed', exitCode: overallStatus === 'fail' ? 1 : 0, data: report });
});
test('missing controller proof closes the epoch and never leaves a successful result', async () => {
  const f = setup(), pending = f.run(), rejected = expect(pending).rejects.toMatchObject({ delivery: 'unknown' }); await expect.poll(() => f.native.calls.length).toBe(1); f.output(f.handle(), '{"models":[]}'); f.exit(f.handle()); fixture.jobs[0]!.fail(); await rejected; await expect.poll(() => f.native.connected).toBe(false);
});
test('retained results expire instead of becoming an unbounded diagnostic archive', async () => {
  const f = setup(); vi.useFakeTimers(); const pending = f.run(); await vi.waitFor(() => expect(f.native.calls.length).toBe(1)); f.output(f.handle(), '{"models":[]}'); f.exit(f.handle()); fixture.jobs[0]!.finish(0); const result = object(await pending);
  await vi.advanceTimersByTimeAsync(600001); await expect(f.service.call('diagnostics/cli/result/read', { resultId: result.resultId! }, owner)).rejects.toMatchObject({ code: 'not_found' });
});
