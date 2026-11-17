import { describe, expect, test, vi } from 'vitest';
import { execFile, spawn, type ExecFileOptions } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { NativeRpc } from '../../src/runtime/native.js';
import { windowsJob, windowsPowerShellBootstrap } from '../../src/runtime/windows-job.js';
import { captureProcesses, expectProcessesStopped } from './process-identity.js';
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});
const roots = path.resolve('.work/windows-job-tests'); mkdirSync(roots, { recursive: true });
const fixture = path.resolve('tests/runtime/windows-job-fixture.mjs');
function command() {
  const cwd = mkdtempSync(path.join(roots, 'home-'));
  return { bin: process.execPath, args: [fixture, 'space and "quotes"', 'Unicode-中文', 'trailing\\'], cwd, env: { HOME: cwd, USERPROFILE: cwd, TEMP: cwd, TMP: cwd } };
}
describe.skipIf(process.platform !== 'win32')('Windows job ownership', () => {
  test.each([undefined, 'PSModuleAnalysisCachePath', 'PSMODULEANALYSISCACHEPATH'])('keeps the real native controller cache disabled with parent override %s', async cacheKey => {
    const config = command(), redirected = path.join(config.cwd, 'redirected-cache');
    const parentEnv = { ...config.env, ...(cacheKey ? { [cacheKey]: redirected } : {}) };
    const originalEnv = { ...parentEnv };
    const job = windowsJob({ ...config, args: ['-e', "process.stdout.write(JSON.stringify({cache:process.env.PSModuleAnalysisCachePath??null})+'\\n');setInterval(()=>{},1000)"], env: parentEnv });
    const child = spawn(job.command.bin, job.command.args, { cwd: job.command.cwd, env: job.command.env, windowsHide: true, stdio: 'pipe' });
    let output = '', error = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { error += bytes; });
    const closed = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    try {
      await expect.poll(() => output.includes('\n'), { timeout: 10000 }).toBe(true);
      await job.signal(); expect(await closed).toBe(0); expect(error).not.toMatch(/S="Error"|native launcher failed|cleanup was not confirmed/i);
      expect.soft(JSON.parse(output)).toEqual({ cache: 'NUL' });
      expect.soft(Object.entries(job.command.env).filter(([key]) => key.toLowerCase() === 'psmoduleanalysiscachepath')).toEqual([['PSModuleAnalysisCachePath', 'NUL']]);
      const signalOptions = vi.mocked(execFile).mock.calls.at(-1)![2] as ExecFileOptions;
      expect.soft(signalOptions.env?.PSModuleAnalysisCachePath).toBe('NUL');
      expect.soft(signalOptions.env?.PSModulePath).toBe(job.command.env.PSModulePath);
      const signalArgs = vi.mocked(execFile).mock.calls.at(-1)![1] as string[];
      expect.soft(Buffer.from(signalArgs[4]!, 'base64').toString('utf16le')).toContain(windowsPowerShellBootstrap);
      expect.soft(existsSync(path.join(config.cwd, 'Microsoft', 'Windows', 'PowerShell'))).toBe(false);
      expect.soft(existsSync(redirected)).toBe(false); expect(parentEnv).toEqual(originalEnv);
    } finally { if (child.exitCode === null) { await job.signal().catch(() => child.kill()); await closed; } }
  }, 20000);

  test.each(['spawn', 'spawn-exit'])('close confirms detached descendants are gone after %s', async method => {
    const config = command(); const rpc = new NativeRpc({ ...config, home: config.cwd, dev: true });
    try {
      await rpc.initialize(); const result = await rpc.call('spawn', {}) as { rootPid: number; childPid: number; args: string[] }; const processes = await captureProcesses([result.rootPid, result.childPid]);
      expect(result.args).toEqual([...config.args.slice(1), '-c', 'thread_unload_delay_secs=0']);
      if (method === 'spawn-exit') { await rpc.call('exit', {}); await expect.poll(() => rpc.connected).toBe(false); }
      await rpc.close(); await expectProcessesStopped(processes); expect(rpc.budget).toEqual({ pending: 0, retainedBytes: 0 });
    } finally { await rpc.close(); }
  });
  test('shutdown remains responsive while native stdin is backpressured', async () => {
    const config = command(); const rpc = new NativeRpc({ ...config, home: config.cwd, dev: true });
    try {
      await rpc.initialize(); const result = await rpc.call('spawn', {}) as { rootPid: number; childPid: number }; const processes = await captureProcesses([result.rootPid, result.childPid]); await rpc.call('pause', {});
      const pending = rpc.call('hold', { text: 'x'.repeat(10 * 1024 * 1024) }).catch(error => error);
      await expect(rpc.call('hold', {}, { timeoutMs: 30 })).rejects.toMatchObject({ delivery: 'not_sent' });
      const started = Date.now(); await rpc.close(); expect(Date.now() - started).toBeLessThan(6000);
      expect(await pending).toMatchObject({ delivery: 'unknown' }); await expectProcessesStopped(processes); expect(rpc.budget.retainedBytes).toBe(0);
    } finally { await rpc.close(); }
  });
  test('owner process death kills its controller and detached descendants', async () => {
    const config = command(); const owner = spawn(process.execPath, [path.resolve('tests/runtime/windows-job-owner.mjs')], { cwd: config.cwd, env: config.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); let pids: number[] = [];
    owner.stderr.on('data', () => {}); owner.stdin.on('error', () => {});
    try {
      const ready = new Promise<void>((resolve, reject) => {
        let input = ''; const deadline = setTimeout(() => reject(new Error('Controller did not start')), 10000);
        owner.stdout.on('data', chunk => { input += chunk.toString(); for (;;) { const end = input.indexOf('\n'); if (end < 0) return; const value = JSON.parse(input.slice(0, end)); input = input.slice(end + 1); if (value.controllerPid) pids.push(value.controllerPid); if (value.result) { pids.push(value.result.rootPid, value.result.childPid); clearTimeout(deadline); resolve(); } } });
      });
      owner.stdin.end(JSON.stringify(config)); await ready; expect(pids).toHaveLength(3); const processes = await captureProcesses(pids);
      owner.kill(); await expect.poll(async () => { try { await expectProcessesStopped(processes); return true; } catch { return false; } }, { timeout: 6000 }).toBe(true);
    } finally { owner.kill(); }
  });
  test('controller failure kills the job but never reports a cleanup acknowledgement', async () => {
    const config = command(); const rpc = new NativeRpc({ ...config, home: config.cwd, dev: true });
    try {
      await rpc.initialize(); const result = await rpc.call('spawn', {}) as { rootPid: number; childPid: number }; const processes = await captureProcesses([result.rootPid, result.childPid]);
      rpc['child'].kill(); await expect(rpc.close()).rejects.toThrow(/acknowledged|confirm/);
      await expect.poll(async () => { try { await expectProcessesStopped(processes); return true; } catch { return false; } }, { timeout: 6000 }).toBe(true);
    } finally { await rpc.close().catch(() => {}); }
  });
});
