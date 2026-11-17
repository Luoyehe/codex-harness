import { expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { NativeRpc } from '../../src/runtime/native.js';
import * as posix from '../../src/runtime/posix-native.js';
import { captureProcesses, expectNativeClosed, expectProcessesStopped } from './process-identity.js';

test.runIf(process.platform === 'linux').each(['linux-stop', 'linux-natural', 'linux-pressure', 'portable-stop', 'portable-natural'])('native ownership cleanup confirms %s without signaling a reaped PGID', async mode => {
  const root = path.resolve('.work/posix-native'); mkdirSync(root, { recursive: true }); const cwd = mkdtempSync(path.join(root, 'home-'));
  const implementation = posix.posixNative;
  // Exercise the portable waitid path with real processes on Linux. This is
  // not evidence for macOS's distinct kqueue path.
  const command = vi.spyOn(posix, 'posixNative').mockImplementation(input => {
    const output = implementation(input);
    if (mode.startsWith('portable')) output.args = output.args.map(value => value.replaceAll("sys.platform=='linux'", "False"));
    return output;
  });
  const rawSignal = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('NativeRpc must not signal a historical numeric PID'); });
  const rpc = new NativeRpc({ bin: process.execPath, args: [path.resolve('tests/runtime/windows-job-fixture.mjs')], home: cwd, cwd, env: {}, dev: true });
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

test.runIf(process.platform === 'linux')('closing before the POSIX controller starts retains its stop request and confirms cleanup', async () => {
  const root = path.resolve('.work/posix-native'); mkdirSync(root, { recursive: true }); const cwd = mkdtempSync(path.join(root, 'early-'));
  const rpc = new NativeRpc({ bin: process.execPath, args: [path.resolve('tests/runtime/native-fixture.mjs')], home: cwd, cwd, env: {}, isolatedGroup: true });
  await rpc.close(); expectNativeClosed(rpc); expect(rpc['child'].exitCode).toBe(0);
});

test.runIf(process.platform === 'linux')('native shutdown may finish and persist its acknowledgement before forced descendant cleanup', async () => {
  const root = path.resolve('.work/posix-native'); mkdirSync(root, { recursive: true }); const cwd = mkdtempSync(path.join(root, 'graceful-')), marker = path.join(cwd, 'shutdown.txt');
  const rpc = new NativeRpc({ bin: process.execPath, args: [path.resolve('tests/runtime/windows-job-fixture.mjs')], home: cwd, cwd, env: { HARNESS_FIXTURE_SHUTDOWN_MARKER: marker }, dev: true });
  try {
    await rpc.initialize(); const result = await rpc.call('spawn', {}) as { rootPid: number; childPid: number }; const children = await captureProcesses([result.rootPid, result.childPid]);
    await rpc.close(); expectNativeClosed(rpc); expect(readFileSync(marker, 'utf8')).toBe('native shutdown completed'); await expectProcessesStopped(children);
  } finally { await rpc.close(); }
});
