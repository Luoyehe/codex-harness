import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ManagerClient } from '../../src/gateway/manager-client.js';
import { HarnessError } from '../../src/core/errors.js';

vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: vi.fn() }));
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), lstatSync: vi.fn() }));

class Helper extends EventEmitter {
  stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  stdout = new EventEmitter();
  kill = vi.fn(() => true);
  start() { this.emit('spawn'); }
  finish(value: unknown = { ok: true, result: {} }) { this.stdout.emit('data', Buffer.from(JSON.stringify(value))); this.emit('close', 0, null); }
}
let helpers: Helper[];
function client() {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  vi.mocked(lstatSync).mockReturnValue({ uid: 0, mode: 0o100755, isSymbolicLink: () => false, isFile: () => true } as ReturnType<typeof lstatSync>);
  try { return new ManagerClient('/trusted/manage'); }
  finally { Object.defineProperty(process, 'platform', platform); }
}
beforeEach(() => {
  helpers = []; vi.mocked(spawn).mockReset();
  vi.mocked(spawn).mockImplementation(() => { const child = new Helper(); helpers.push(child); return child as unknown as ChildProcess; });
});
afterEach(() => { vi.useRealTimers(); vi.mocked(spawn).mockReset(); vi.mocked(lstatSync).mockReset(); });

it('serializes concurrent reads and writes, freezes queued payloads and checks authorization at the actual stdin boundary', async () => {
  const manager = client(), params = { name: 'captured' }, written = vi.fn();
  const first = manager.call('provider/read', {});
  const second = manager.call('provider/write', params, 'original-operation', written);
  const third = manager.call('status', {});
  expect(helpers).toHaveLength(1); helpers[0]!.start();
  expect(written).not.toHaveBeenCalled(); params.name = 'changed after enqueue';
  helpers[0]!.finish({ ok: true, result: { revision: 'one' } });
  expect(helpers).toHaveLength(2); helpers[1]!.start();
  expect(written).toHaveBeenCalledTimes(1);
  expect(JSON.parse(helpers[1]!.stdin.end.mock.calls[0]![0])).toEqual({ method: 'provider/write', params: { name: 'captured' }, operationId: 'original-operation' });
  helpers[1]!.finish({ ok: true, result: { revision: 'two' } });
  helpers[2]!.start(); helpers[2]!.finish();
  expect(await Promise.all([first, second, third])).toEqual([{ revision: 'one' }, { revision: 'two' }, {}]);
  expect(spawn).toHaveBeenCalledTimes(3);
});

it('keeps real concurrent helper subprocesses from competing for their exclusive fixture lock', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const parent = path.resolve('.work/manager-client'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'run-')), closed: Promise<void>[] = [];
  const fixture = `
    import fs from 'node:fs'; import path from 'node:path';
    const root=process.argv[1],lock=path.join(root,'lock');let input='';
    process.stdin.setEncoding('utf8');process.stdin.on('data',part=>input+=part);
    process.stdin.on('end',()=>{
      const request=JSON.parse(input);let fd;
      try{fd=fs.openSync(lock,'wx');}catch{process.stdout.write(JSON.stringify({ok:false,error:{code:'busy',message:'Another management transaction is running',delivery:'not_sent'}}));return;}
      let watcher,timer,done=false;
      const finish=()=>{if(done||request.method==='status'&&!fs.existsSync(path.join(root,'release')))return;done=true;watcher?.close();clearTimeout(timer);fs.closeSync(fd);fs.unlinkSync(lock);process.stdout.write(JSON.stringify({ok:true,result:{method:request.method}}),()=>process.exit(0));};
      fs.writeFileSync(path.join(root,'ready'),request.method);
      if(request.method==='status'){watcher=fs.watch(root,finish);timer=setTimeout(()=>process.exit(2),10000);}finish();
    });`;
  vi.mocked(spawn).mockImplementation((command, args, options) => {
    expect(command).toBe('/usr/bin/sudo'); expect(args).toEqual(['-n', '/trusted/manage', 'rpc']);
    const child = actual.spawn(process.execPath, ['--input-type=module', '-e', fixture, directory], {
      ...options, cwd: directory, env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    });
    closed.push(new Promise(resolve => child.once('close', () => resolve()))); return child;
  });
  const manager = client(), calls: Promise<unknown>[] = [];
  try {
    calls.push(manager.call('status', {}));
    await expect.poll(() => existsSync(path.join(directory, 'ready')), { timeout: 5000 }).toBe(true);
    calls.push(manager.call('provider/read', {}), manager.call('provider/write', {}, 'original-operation'));
    expect(spawn).toHaveBeenCalledTimes(1);
    writeFileSync(path.join(directory, 'release'), '');
    expect(await Promise.all(calls)).toEqual([{ method: 'status' }, { method: 'provider/read' }, { method: 'provider/write' }]);
    expect(spawn).toHaveBeenCalledTimes(3);
  } finally {
    writeFileSync(path.join(directory, 'release'), ''); await Promise.allSettled(calls); await Promise.all(closed);
    rmSync(directory, { recursive: true, force: true });
  }
});

it('expires queued requests as not_sent and does not release a sent timed-out helper until close', async () => {
  vi.useFakeTimers(); const manager = client();
  const first = manager.call('provider/write', {}, 'first').catch(error => error); helpers[0]!.start();
  await vi.advanceTimersByTimeAsync(60000);
  const second = manager.call('provider/read', {}).catch(error => error);
  await vi.advanceTimersByTimeAsync(60000);
  expect(await first).toMatchObject({ code: 'manager_timeout', delivery: 'unknown' });
  expect(helpers[0]!.kill).toHaveBeenCalledWith('SIGTERM'); expect(helpers).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(60000);
  expect(await second).toMatchObject({ code: 'manager_timeout', delivery: 'not_sent' });
  const third = manager.call('status', {}); expect(helpers).toHaveLength(1);
  helpers[0]!.emit('close', null, 'SIGTERM'); expect(helpers).toHaveLength(2);
  helpers[1]!.start(); helpers[1]!.finish(); expect(await third).toEqual({});
  expect(spawn).toHaveBeenCalledTimes(2);
});

it('revalidates a queued write and withholds the next helper until the rejected helper closes', async () => {
  const manager = client(), first = manager.call('status', {}); helpers[0]!.start();
  let authorized = true;
  const second = manager.call('provider/write', {}, 'original', () => { if (!authorized) throw new HarnessError('unauthorized', 'Session revoked'); }).catch(error => error);
  const third = manager.call('provider/read', {}); authorized = false; helpers[0]!.finish(); await first;
  helpers[1]!.start(); expect(await second).toMatchObject({ code: 'unauthorized', delivery: 'not_sent' });
  expect(helpers[1]!.stdin.end).not.toHaveBeenCalled(); expect(helpers).toHaveLength(2);
  helpers[1]!.emit('close', null, 'SIGTERM'); helpers[2]!.start(); helpers[2]!.finish(); await third;
});

it.each(['stdin-error', 'stdin-throw', 'stdout-error', 'bad-json'] as const)('preserves unknown after a sent %s and releases only on close without replay', async failure => {
  const manager = client(), first = manager.call('provider/write', {}, 'original').catch(error => error);
  const second = manager.call('operation/read', { operationId: 'original' });
  if (failure === 'stdin-throw') helpers[0]!.stdin.end.mockImplementationOnce(() => { throw new Error('fixture write throw'); });
  helpers[0]!.start();
  if (failure === 'stdin-error') helpers[0]!.stdin.emit('error', new Error('fixture pipe error'));
  if (failure === 'stdout-error') helpers[0]!.stdout.emit('error', new Error('fixture output error'));
  if (failure === 'bad-json') { helpers[0]!.stdout.emit('data', Buffer.from('{')); helpers[0]!.emit('close', 1, null); }
  expect(await first).toMatchObject({ delivery: 'unknown' });
  if (failure !== 'bad-json') { expect(helpers).toHaveLength(1); helpers[0]!.emit('close', 1, null); }
  helpers[1]!.start(); helpers[1]!.finish(); await second;
  expect(spawn).toHaveBeenCalledTimes(2);
});

it('handles both synchronous spawn failure and asynchronous pre-write errors without sending a mutation', async () => {
  const manager = client(); vi.mocked(spawn).mockImplementationOnce(() => { throw new Error('fixture spawn throw'); });
  await expect(manager.call('provider/write', {}, 'first')).rejects.toMatchObject({ code: 'manager_unavailable', delivery: 'not_sent' });
  const second = manager.call('provider/write', {}, 'second').catch(error => error), third = manager.call('status', {});
  helpers[0]!.emit('error', new Error('fixture spawn error'));
  expect(await second).toMatchObject({ code: 'manager_unavailable', delivery: 'not_sent' });
  expect(helpers).toHaveLength(1); expect(helpers[0]!.stdin.end).not.toHaveBeenCalled();
  helpers[0]!.emit('close', -1, null); helpers[1]!.start(); helpers[1]!.finish(); await third;
});

it('preserves a real external busy response instead of retrying the original write', async () => {
  const manager = client(), first = manager.call('provider/write', {}, 'original').catch(error => error);
  helpers[0]!.start(); helpers[0]!.finish({ ok: false, error: { code: 'busy', message: 'Another management transaction is running', delivery: 'not_sent' } });
  expect(await first).toMatchObject({ code: 'busy', delivery: 'not_sent' }); expect(spawn).toHaveBeenCalledTimes(1);
});

it.each(['count', 'bytes'] as const)('bounds queued %s and releases reservations after helper completion', async budget => {
  const manager = client(), count = budget === 'count' ? 32 : 8, params = budget === 'bytes' ? { value: 'x'.repeat(1000000) } : {};
  const calls = Array.from({ length: count }, () => manager.call('provider/read', params));
  await expect(manager.call('provider/read', params)).rejects.toMatchObject({ code: 'capacity', delivery: 'not_sent' });
  expect(helpers).toHaveLength(1);
  for (let index = 0; index < count; index++) { helpers[index]!.start(); helpers[index]!.finish(); }
  await Promise.all(calls);
  const next = manager.call('status', {}); helpers[count]!.start(); helpers[count]!.finish(); await next;
});
