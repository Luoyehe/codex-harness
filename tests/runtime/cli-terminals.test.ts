import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import type { WindowsProcessJob } from '../../src/runtime/windows-process.js';
import type { NativeOptions, NativeRpc } from '../../src/runtime/native.js';
import { DeliveryError, object, type JsonObject, type JsonValue, type RuntimeEvent } from '../../src/runtime/types.js';
const fixture = vi.hoisted(() => ({ jobs: [] as (WindowsProcessJob & { finish(code: number): void; fail(): void })[], commands: [] as string[][], gate: undefined as Promise<void> | undefined }));
vi.mock('../../src/runtime/windows-process.js', () => ({ windowsProcessJob: async (command: string[]) => {
  fixture.commands.push(command); await fixture.gate; let finish!: (code: number) => void, fail!: () => void;
  const exited = new Promise<number>((resolve, reject) => { finish = resolve; fail = () => reject(new Error('Missing independent cleanup proof')); }); void exited.catch(() => {});
  const job = { command: ['owned-controller'], env: { HARNESS_WINDOWS_PROCESS_COMMAND: 'private' }, started: Promise.resolve(42), exited, finish, fail, signal: vi.fn(async () => {}), dispose: vi.fn() }; fixture.jobs.push(job); return job;
} }));
vi.mock('../../src/runtime/linux-process.js', async () => ({ linuxProcessJob: (await import('../../src/runtime/windows-process.js')).windowsProcessJob }));
import { RuntimeService } from '../../src/runtime/service.js';
class Native extends EventEmitter {
  connected = true; budget = { pending: 0, retainedBytes: 0 }; calls: { method: string; params: JsonValue }[] = []; gates = new Map<string, Promise<void>>();
  async call(method: string, params: JsonValue, options?: NativeOptions) { await this.gates.get(method); options?.beforeWrite?.(); this.calls.push({ method, params }); return {}; }
  async close() { this.connected = false; }
}
const roots = path.resolve('.work/cli-terminal-tests'); mkdirSync(roots, { recursive: true }); const services: RuntimeService[] = [];
const owner = { clientId: 'owner', eventChannelId: 'channel', beforeWrite: () => {} };
function setup() {
  const cwd = mkdtempSync(path.join(roots, 'home-')), native = new Native(), events: RuntimeEvent[] = [];
  const service = new RuntimeService({ bin: process.execPath, home: cwd, workerHome: cwd, cwd, env: {} }, native as unknown as NativeRpc); services.push(service); service.on('event', event => events.push(event));
  return { service, native, events, cwd, open: () => service.call('terminal/open', { cwd, program: 'codex' }, owner), activity: () => object(object(service.status()).activity) };
}
const exit = (native: Native, processHandle: JsonValue, exitCode = 0) => native.emit('notification', { method: 'process/exited', params: { processHandle, exitCode, stdout: '', stderr: '', stdoutCapReached: false, stderrCapReached: false } });
const handle = (native: Native) => object(native.calls.find(call => call.method === 'process/spawn')!.params).processHandle!;
beforeEach(() => { fixture.jobs.length = 0; fixture.commands.length = 0; fixture.gate = undefined; });
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });

test('fixed CLI argv, private connection ownership, and independent cleanup proof protect the maintenance lease', async () => {
  const f = setup(); await expect(f.service.call('terminal/open', { cwd: f.cwd, program: 'codex', args: ['--dangerously-bypass-hook-trust'] }, owner)).rejects.toMatchObject({ code: 'invalid_params' });
  const result = object(await f.open()), terminalId = result.terminalId!, processHandle = handle(f.native); expect(Object.keys(result)).toEqual(['terminalId']); expect(fixture.commands).toEqual([[process.execPath, '--no-alt-screen']]);
  for (const changed of [{ ...owner, clientId: 'other' }, { ...owner, eventChannelId: 'other' }]) await expect(f.service.call('terminal/write', { terminalId, text: '/hooks' }, changed)).rejects.toMatchObject({ code: 'not_found' });
  f.native.emit('notification', { method: 'process/outputDelta', params: { processHandle, stream: 'stdout', deltaBase64: 'YQ==', capReached: false } });
  const event = f.events.find(event => event.type === 'terminal')!; expect(event).toMatchObject({ eventChannelId: 'channel', data: { terminalId, clientId: 'owner', type: 'output' } }); expect(object(event.data)).not.toHaveProperty('processHandle');
  exit(f.native, processHandle); await Promise.resolve(); expect(f.activity()).toMatchObject({ terminals: 1, unknown: false });
  await expect(f.service.call('thread/start', { cwd: f.cwd }, owner)).rejects.toMatchObject({ code: 'native_cli_busy' });
  fixture.jobs[0]!.finish(0); await expect.poll(() => f.activity().terminals).toBe(0); expect(f.activity().unknown).toBe(true);
  await expect(f.service.call('thread/start', { cwd: f.cwd }, owner)).rejects.toMatchObject({ code: 'activity_unknown' });
});

test('disconnect while preparing revokes startup without dispatching or requiring a restart', async () => {
  const f = setup(); let release!: () => void; fixture.gate = new Promise(resolve => { release = resolve; });
  const opening = f.open(), rejected = expect(opening).rejects.toMatchObject({ code: 'client_disconnected', delivery: 'not_sent' });
  expect(f.activity().terminals).toBe(1); const cleanup = f.service.clientDisconnected(owner.clientId, owner.eventChannelId); release(); await rejected; await cleanup;
  expect(f.native.calls).toEqual([]); expect(f.activity()).toMatchObject({ terminals: 0, unknown: false }); expect(fixture.jobs[0]!.dispose).toHaveBeenCalled();
});

test('cloud terminal selects exactly the fixed cloud TUI and uses the same owner cleanup barrier', async () => {
  const f = setup(); await expect(f.service.call('terminal/open', { cwd: f.cwd, program: 'codex-cloud', args: ['exec', 'do work'] }, owner)).rejects.toMatchObject({ code: 'invalid_params' });
  const terminalId = object(await f.service.call('terminal/open', { cwd: f.cwd, program: 'codex-cloud' }, owner)).terminalId!, processHandle = handle(f.native);
  expect(fixture.commands).toEqual([[process.execPath, 'cloud']]);
  await expect(f.service.call('terminal/open', { cwd: f.cwd, program: 'codex' }, owner)).rejects.toMatchObject({ code: 'native_cli_busy' });
  await expect(f.service.call('terminal/write', { terminalId, text: 'x' }, { ...owner, eventChannelId: 'other' })).rejects.toMatchObject({ code: 'not_found' });
  fixture.jobs[0]!.signal = vi.fn(async () => { fixture.jobs[0]!.finish(1); exit(f.native, processHandle, 1); });
  await f.service.clientDisconnected(owner.clientId, owner.eventChannelId); expect(f.activity()).toMatchObject({ terminals: 0, unknown: true });
});

test('legacy direct writes cannot cross a CLI reservation and outstanding writes prevent CLI dispatch', async () => {
  const f = setup(); let releaseWrite!: () => void; f.native.gates.set('thread/name/set', new Promise(resolve => { releaseWrite = resolve; }));
  const write = f.service.call('thread/name/set', { threadId: 'thread', name: 'renamed' }, owner), rejected = expect(write).rejects.toMatchObject({ code: 'native_cli_busy', delivery: 'not_sent' });
  let prepare!: () => void; fixture.gate = new Promise(resolve => { prepare = resolve; }); const opening = f.open();
  releaseWrite(); await rejected; prepare(); const terminalId = object(await opening).terminalId!; expect(f.native.calls.map(call => call.method)).toEqual(['process/spawn']);
  const processHandle = handle(f.native); fixture.jobs[0]!.signal = vi.fn(async () => { fixture.jobs[0]!.finish(0); exit(f.native, processHandle); });
  await f.service.call('terminal/close', { terminalId }, owner); expect(f.activity()).toMatchObject({ terminals: 0, unknown: true });
  const second = setup(); let complete!: () => void; second.native.gates.set('thread/name/set', new Promise(resolve => { complete = resolve; }));
  const pending = second.service.call('thread/name/set', { threadId: 'thread', name: 'name' }, owner); await expect(second.open()).rejects.toMatchObject({ code: 'activity_busy' }); complete(); await pending;
  expect(second.native.calls.map(call => call.method)).toEqual(['thread/name/set']); expect(second.activity()).toMatchObject({ terminals: 0, unknown: false });
});

test('active turns and ordinary processes prevent CLI startup, and final owner loss never dispatches', async () => {
  const first = setup(); first.native.emit('notification', { method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn' } } });
  await expect(first.open()).rejects.toMatchObject({ code: 'activity_busy' }); expect(first.native.calls).toEqual([]);
  const second = setup(); await second.service.call('process/spawn', { cwd: second.cwd, command: ['fixture'] }, owner); await expect(second.open()).rejects.toMatchObject({ code: 'activity_busy' }); expect(second.activity().processes).toBe(1);
  const third = setup(); await expect(third.service.call('terminal/open', { cwd: third.cwd, program: 'codex' }, { ...owner, beforeWrite: () => { throw new DeliveryError('client_disconnected', 'Owner revoked'); } })).rejects.toMatchObject({ code: 'client_disconnected' });
  expect(third.native.calls).toEqual([]); expect(third.activity()).toMatchObject({ terminals: 0, unknown: false });
});

test('controller failure closes the runtime without publishing a successful terminal exit', async () => {
  const f = setup(); await f.open(); const processHandle = handle(f.native); exit(f.native, processHandle); fixture.jobs[0]!.fail();
  await expect.poll(() => f.native.connected).toBe(false); expect(f.activity().unknown).toBe(true); expect(f.events.some(event => event.type === 'terminal' && object(event.data).type === 'exit')).toBe(false);
});
