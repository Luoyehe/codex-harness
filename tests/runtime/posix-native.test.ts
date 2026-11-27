import { expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { NativeRpc } from '../../src/runtime/native.js';
import * as posix from '../../src/runtime/posix-native.js';
import { captureProcesses, expectNativeClosed, expectProcessesStopped } from './process-identity.js';

test.runIf(process.platform === 'linux' || process.platform === 'darwin').each(process.platform === 'darwin' ? ['portable-stop', 'portable-natural'] : ['linux-stop', 'linux-natural', 'linux-pressure', 'portable-stop', 'portable-natural'])('native ownership cleanup confirms %s without signaling a reaped PGID', async mode => {
  const root = path.resolve('.work/posix-native'); mkdirSync(root, { recursive: true }); const cwd = mkdtempSync(path.join(root, 'home-'));
  const implementation = posix.posixNative;
  // On Linux, exercise the portable waitid path as well as the subreaper.
  // macOS exercises its actual kqueue path.
  const command = vi.spyOn(posix, 'posixNative').mockImplementation(input => {
    const output = implementation(input);
    if (mode.startsWith('portable')) output.args = output.args.map(value => value.replaceAll("sys.platform=='linux'", "False"));
    return output;
  });
  const rawSignal = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('NativeRpc must not signal a historical numeric PID'); });
  const rpc = new NativeRpc({ bin: process.execPath, args: [path.resolve('tests/runtime/posix-process-fixture.mjs')], home: cwd, cwd, env: {}, dev: true });
  try {
    await rpc.initialize(); const result = await rpc.call(mode.startsWith('portable') ? 'spawn-group' : 'spawn', {}) as { rootPid: number; childPid: number };
    const processes = await captureProcesses([result.rootPid, result.childPid]);
    let pending: Promise<unknown> | undefined;
    if (mode.endsWith('natural')) { await rpc.call('exit', {}); await expect.poll(() => rpc.connected).toBe(false); }
    if (mode.endsWith('pressure')) {
      await rpc.call('pause', {}); pending = rpc.call('hold', { text: 'x'.repeat(10 * 1024 * 1024) }).catch(error => error);
      await expect(rpc.call('hold', {}, { timeoutMs: 30 })).rejects.toMatchObject({ delivery: 'not_sent' });
    }
    await rpc.close(); expectNativeClosed(rpc); expect(rpc['child'].exitCode).toBe(0); await expectProcessesStopped(processes);
    if (pending) expect(await pending).toMatchObject({ delivery: 'unknown' });
    expect(rawSignal).not.toHaveBeenCalled();
  } finally { await rpc.close(); command.mockRestore(); rawSignal.mockRestore(); }
}, 15000);

test('closing before the POSIX controller starts retains its stop request and confirms cleanup', async () => {
  const root = path.resolve('.work/posix-native'); mkdirSync(root, { recursive: true }); const cwd = mkdtempSync(path.join(root, 'early-'));
  const rpc = new NativeRpc({ bin: process.execPath, args: [path.resolve('tests/runtime/native-fixture.mjs')], home: cwd, cwd, env: {}, isolatedGroup: true });
  await rpc.close(); expectNativeClosed(rpc); expect(rpc['child'].exitCode).toBe(0);
});

test('native shutdown may finish and persist its acknowledgement before forced descendant cleanup', async () => {
  const root = path.resolve('.work/posix-native'); mkdirSync(root, { recursive: true }); const cwd = mkdtempSync(path.join(root, 'graceful-')), marker = path.join(cwd, 'shutdown.txt');
  const rpc = new NativeRpc({ bin: process.execPath, args: [path.resolve('tests/runtime/posix-process-fixture.mjs')], home: cwd, cwd, env: { HARNESS_FIXTURE_SHUTDOWN_MARKER: marker }, dev: true });
  try {
    await rpc.initialize(); const result = await rpc.call(process.platform === 'linux' ? 'spawn' : 'spawn-group', {}) as { rootPid: number; childPid: number }; const children = await captureProcesses([result.rootPid, result.childPid]);
    await rpc.close(); expectNativeClosed(rpc); expect(readFileSync(marker, 'utf8')).toBe('native shutdown completed'); await expectProcessesStopped(children);
  } finally { await rpc.close(); }
});

test('portable cleanup refuses a permission failure while a live descendant remains, and accepts a confirmed late exit', () => {
  const script = posix.posixNative({ bin: process.execPath, args: [], env: {}, cwd: '/' }).args.at(-1)!;
  const fn = script.slice(script.indexOf('def portable_cleanup():'), script.indexOf('\ntry:\n    for sig', script.indexOf('def portable_cleanup():')));
  const fixture = `
import os, signal, time
from types import SimpleNamespace
calls=[]
child=SimpleNamespace(pid=123,returncode=None,wait=lambda timeout: calls.append('reaped'))
observed_exit=lambda: True
def denied(pid,sig):
    calls.append('denied'); raise PermissionError()
os.killpg=denied
${fn}
group_live=lambda deadline: True
try: portable_cleanup()
except PermissionError: pass
else: raise RuntimeError('live descendant permission failure was lost')
assert calls==['denied']
sequence=iter([True,False,False]); group_live=lambda deadline: next(sequence)
portable_cleanup()
assert calls==['denied','denied','reaped']
`;
  expect(() => execFileSync('/usr/bin/python3', ['-I', '-c', fixture])).not.toThrow();
});
