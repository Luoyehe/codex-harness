import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DeliveryError, object, type JsonObject, type JsonValue } from '../../src/runtime/types.js';
import type { WindowsProcessJob } from '../../src/runtime/windows-process.js';
const fixture = vi.hoisted(() => ({ jobs: [] as (WindowsProcessJob & { finish(code: number): void })[], gate: undefined as Promise<void> | undefined }));
vi.mock('../../src/runtime/windows-process.js', () => ({ windowsProcessJob: async () => {
  await fixture.gate; let finish!: (code: number) => void;
  const job = { command: ['fixture-controller'], env: { HARNESS_WINDOWS_PROCESS_COMMAND: 'private' }, started: Promise.resolve(42), exited: new Promise<number>(resolve => { finish = resolve; }), finish: (code: number) => finish(code), signal: vi.fn(async () => {}), dispose: vi.fn() }; fixture.jobs.push(job); return job;
} }));
vi.mock('../../src/runtime/linux-process.js', async () => ({ linuxProcessJob: (await import('../../src/runtime/windows-process.js')).windowsProcessJob }));
import { Processes } from '../../src/runtime/processes.js';
const context = { clientId: 'owner', eventChannelId: 'channel', beforeWrite: () => {} };
const instances: Processes[] = [];
function setup() {
  const events: { data: JsonObject; channel?: string }[] = []; const calls: { method: string; params: JsonValue }[] = []; let nativeGate: Promise<void> | undefined; let available = true; let failed = 0;
  const processes = new Processes({ cwd: value => String(value), available: () => { if (!available) throw new DeliveryError('activity_unknown', 'Unavailable'); }, emit: (data, channel) => events.push({ data, channel }), changed: () => {},
    native: async (method, params, options) => { await nativeGate; options?.beforeWrite?.(); calls.push({ method, params }); return {}; },
    start: async (operation, owner) => { owner.beforeWrite?.(); operation.beforeWrite?.(); calls.push({ method: operation.method, params: operation.params }); return {}; },
    failEpoch: async () => { failed++; available = false; processes.reset(); },
  }); instances.push(processes);
  return { processes, events, calls, failCount: () => failed, pause: (gate: Promise<void>) => { nativeGate = gate; } };
}
const exit = (processes: Processes, handle: JsonValue, wrapperCode = 0) => processes.notification('process/exited', { processHandle: handle, exitCode: wrapperCode, stdout: '', stderr: '', stdoutCapReached: false, stderrCapReached: false });
const spawn = async (processes: Processes, extra: JsonObject = {}) => object(await processes.call('process/spawn', { cwd: '/fixture', command: ['fixture'], ...extra }, context)).processHandle!;
beforeEach(() => { fixture.jobs.length = 0; fixture.gate = undefined; });
afterEach(() => { for (const instance of instances.splice(0)) instance.reset(); vi.useRealTimers(); });

test.runIf(process.platform === 'win32')('forces the final Windows spawn environment to disable cache despite case-variant user overrides', async () => {
  const { processes, calls } = setup();
  const env = { PSModuleAnalysisCachePath: 'canonical-cache', PSMODULEANALYSISCACHEPATH: 'uppercase-cache', psmoduleanalysiscachepath: 'lowercase-cache', Kept: 'value', Removed: null };
  const originalEnv = { ...env };
  await spawn(processes, { env });
  const finalEnv = object(object(calls[0]!.params).env);
  expect(Object.entries(finalEnv).filter(([key]) => key.toLowerCase() === 'psmoduleanalysiscachepath')).toEqual([['PSModuleAnalysisCachePath', 'NUL']]);
  expect(finalEnv).toMatchObject({ Kept: 'value', Removed: null, HARNESS_WINDOWS_PROCESS_COMMAND: 'private' });
  expect(env).toEqual(originalEnv);
});
test('private output and native exit wait for an independent process-tree cleanup proof', async () => {
  const { processes, events } = setup(); const processHandle = await spawn(processes, { outputBytesCap: 1024 });
  for (const owner of [{ ...context, clientId: 'other' }, { ...context, eventChannelId: 'other' }]) await expect(processes.call('process/read', { processHandle }, owner)).rejects.toMatchObject({ code: 'not_found' });
  processes.notification('process/outputDelta', { processHandle, stream: 'stdout', deltaBase64: Buffer.alloc(1024, 65).toString('base64'), capReached: true });
  expect(events).toMatchObject([{ channel: 'channel', data: { type: 'output', clientId: 'owner', processHandle, capReached: true } }]);
  exit(processes, processHandle); await Promise.resolve(); expect(object(await processes.call('process/read', { processHandle }, context)).status).toBe('running');
  fixture.jobs[0]!.finish(7); await expect.poll(async () => object(await processes.call('process/read', { processHandle }, context)).status).toBe('exited');
  expect(object(await processes.call('process/read', { processHandle }, context))).toMatchObject({ exitCode: 7, stdoutCapReached: true }); expect(processes.active).toBe(0);
});
test('disconnect revokes a process still preparing before any native write', async () => {
  const { processes, calls } = setup(); let release!: () => void; fixture.gate = new Promise(resolve => { release = resolve; });
  const pending = spawn(processes); const rejected = expect(pending).rejects.toMatchObject({ code: 'client_disconnected', delivery: 'not_sent' });
  const cleanup = processes.disconnect('owner', 'channel'); release(); await rejected; await cleanup; expect(calls).toHaveLength(0); expect(processes.active).toBe(0); expect(fixture.jobs[0]!.dispose).toHaveBeenCalled();
});
test('disconnect signals only its owned jobs and suppresses late output during cleanup', async () => {
  const { processes, events } = setup(); const processHandle = await spawn(processes); const job = fixture.jobs[0]!;
  job.signal = vi.fn(async () => { processes.notification('process/outputDelta', { processHandle, stream: 'stderr', deltaBase64: 'YQ==', capReached: false }); job.finish(-9); exit(processes, processHandle); });
  await processes.disconnect('other', 'channel'); expect(job.signal).not.toHaveBeenCalled(); await processes.disconnect('owner', 'channel');
  expect(job.signal).toHaveBeenCalledOnce(); expect(events).toHaveLength(0); expect(await processes.call('process/list', {}, context)).toEqual({ data: [] });
});
test('a wrapper failure never publishes a clean exit and forces whole-runtime cleanup', async () => {
  const { processes, events, failCount } = setup(); const processHandle = await spawn(processes); fixture.jobs[0]!.finish(7); exit(processes, processHandle, 1);
  await expect.poll(failCount).toBe(1); expect(events.some(event => event.data.type === 'exit')).toBe(false); expect(processes.active).toBe(0);
});
test('input validates flags and bytes and repeats owner checks after asynchronous transport waits', async () => {
  const { processes, calls, pause } = setup(); const processHandle = await spawn(processes, { streamStdin: true });
  await expect(processes.call('process/resizePty', { processHandle, size: { rows: 24, cols: 80 } }, context)).rejects.toMatchObject({ code: 'not_tty' });
  await expect(processes.call('process/writeStdin', { processHandle, deltaBase64: 'Y===' }, context)).rejects.toMatchObject({ code: 'invalid_params' });
  let release!: () => void; pause(new Promise(resolve => { release = resolve; })); let revoked = false;
  const writing = processes.call('process/writeStdin', { processHandle, deltaBase64: 'YQ==' }, { ...context, beforeWrite: () => { if (revoked) throw new DeliveryError('client_disconnected', 'revoked'); } });
  const rejected = expect(writing).rejects.toMatchObject({ code: 'client_disconnected', delivery: 'not_sent' }); revoked = true; release(); await rejected; expect(calls.map(call => call.method)).toEqual(['process/spawn']);
});
test('active process and output retention budgets are bounded; completed output expires without another request', async () => {
  vi.useFakeTimers(); const { processes } = setup(); const handles = [];
  for (let i = 0; i < 4; i++) handles.push(await spawn(processes));
  await expect(spawn(processes)).rejects.toMatchObject({ code: 'capacity' });
  fixture.jobs[0]!.finish(0); exit(processes, handles[0]!); await Promise.resolve();
  await vi.advanceTimersByTimeAsync(600001); expect(fixture.jobs[0]!.dispose).toHaveBeenCalled();
  await expect(processes.call('process/read', { processHandle: handles[0]! }, context)).rejects.toMatchObject({ code: 'not_found' });
});
