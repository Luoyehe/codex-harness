import { describe, expect, test, vi } from 'vitest';
import { execFile, spawn, type ExecFileOptions } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { NativeRpc } from '../../src/runtime/native.js';
import { windowsJob } from '../../src/runtime/windows-job.js';
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});
const roots = path.resolve('.work/windows-job-tests'); mkdirSync(roots, { recursive: true });
const fixture = path.resolve('tests/runtime/windows-job-fixture.mjs');
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
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
      expect.soft(existsSync(path.join(config.cwd, 'Microsoft', 'Windows', 'PowerShell'))).toBe(false);
      expect.soft(existsSync(redirected)).toBe(false); expect(parentEnv).toEqual(originalEnv);
    } finally { if (child.exitCode === null) { await job.signal().catch(() => child.kill()); await closed; } }
  }, 20000);

  test.each(['spawn', 'spawn-exit'])('close confirms detached descendants are gone after %s', async method => {
    const config = command(); const rpc = new NativeRpc({ ...config, home: config.cwd, dev: true }); let pids: number[] = [];
    try {
      await rpc.initialize(); const result = await rpc.call(method, {}) as { rootPid: number; childPid: number; args: string[] }; pids = [result.rootPid, result.childPid];
      expect(result.args).toEqual(config.args.slice(1));
      if (method === 'spawn-exit') await expect.poll(() => rpc.connected).toBe(false);
      await rpc.close(); expect(pids.map(alive)).toEqual([false, false]); expect(rpc.budget).toEqual({ pending: 0, retainedBytes: 0 });
    } finally { await rpc.close().catch(() => {}); for (const pid of pids) if (alive(pid)) process.kill(pid); }
  });
  test('shutdown remains responsive while native stdin is backpressured', async () => {
    const config = command(); const rpc = new NativeRpc({ ...config, home: config.cwd, dev: true }); let pids: number[] = [];
    try {
      await rpc.initialize(); const result = await rpc.call('spawn', {}) as { rootPid: number; childPid: number }; pids = [result.rootPid, result.childPid]; await rpc.call('pause', {});
      const pending = rpc.call('hold', { text: 'x'.repeat(10 * 1024 * 1024) }).catch(error => error);
      await expect(rpc.call('hold', {}, { timeoutMs: 30 })).rejects.toMatchObject({ delivery: 'not_sent' });
      const started = Date.now(); await rpc.close(); expect(Date.now() - started).toBeLessThan(6000);
      expect(await pending).toMatchObject({ delivery: 'unknown' }); expect(pids.map(alive)).toEqual([false, false]); expect(rpc.budget.retainedBytes).toBe(0);
    } finally { await rpc.close().catch(() => {}); for (const pid of pids) if (alive(pid)) process.kill(pid); }
  });
  test('owner process death kills its controller and detached descendants', async () => {
    const config = command(); const owner = spawn(process.execPath, [path.resolve('tests/runtime/windows-job-owner.mjs')], { cwd: config.cwd, env: config.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); let pids: number[] = [];
    owner.stderr.on('data', () => {}); owner.stdin.on('error', () => {});
    try {
      const ready = new Promise<void>((resolve, reject) => {
        let input = ''; const deadline = setTimeout(() => reject(new Error('Controller did not start')), 10000);
        owner.stdout.on('data', chunk => { input += chunk.toString(); for (;;) { const end = input.indexOf('\n'); if (end < 0) return; const value = JSON.parse(input.slice(0, end)); input = input.slice(end + 1); if (value.controllerPid) pids.push(value.controllerPid); if (value.result) { pids.push(value.result.rootPid, value.result.childPid); clearTimeout(deadline); resolve(); } } });
      });
      owner.stdin.end(JSON.stringify(config)); await ready; expect(pids).toHaveLength(3); expect(pids.every(alive)).toBe(true);
      owner.kill(); await expect.poll(() => pids.some(alive), { timeout: 6000 }).toBe(false);
    } finally { owner.kill(); for (const pid of pids) if (alive(pid)) process.kill(pid); }
  });
  test('controller failure kills the job but never reports a cleanup acknowledgement', async () => {
    const config = command(); const rpc = new NativeRpc({ ...config, home: config.cwd, dev: true }); let pids: number[] = [];
    try {
      await rpc.initialize(); const result = await rpc.call('spawn', {}) as { rootPid: number; childPid: number }; pids = [result.rootPid, result.childPid];
      process.kill(rpc.processId!); await expect(rpc.close()).rejects.toThrow(/acknowledged|confirm/);
      await expect.poll(() => pids.some(alive), { timeout: 6000 }).toBe(false);
    } finally { await rpc.close().catch(() => {}); for (const pid of pids) if (alive(pid)) process.kill(pid); }
  });
});
