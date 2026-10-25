import { expect, test, vi } from 'vitest';
import { execFile, spawn, type ChildProcessWithoutNullStreams, type ExecFileOptions } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { windowsProcessJob, type WindowsProcessJob } from '../../src/runtime/windows-process.js';
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});
const isolatedEnv = (cwd: string) => ({ HOME: cwd, USERPROFILE: cwd, TEMP: cwd, TMP: cwd });

test.runIf(process.platform === 'win32').each([false, true])('keeps real standalone launcher and signal caches disabled with custom parent path %s', async custom => {
  const root = path.resolve('.work/windows-process-tests'); mkdirSync(root, { recursive: true }); const cwd = mkdtempSync(path.join(root, 'cache-'));
  const redirected = path.join(cwd, 'redirected-cache');
  const parentEnv = { ...isolatedEnv(cwd), ...(custom ? { PSModuleAnalysisCachePath: redirected } : {}) };
  const originalEnv = { ...parentEnv };
  const job = await windowsProcessJob([process.execPath, '-e', "process.stdout.write(JSON.stringify({cache:process.env.PSModuleAnalysisCachePath??null})+'\\n');setInterval(()=>{},1000)"], cwd);
  const child = spawn(job.command[0]!, job.command.slice(1), { cwd, env: { ...parentEnv, ...job.env }, windowsHide: true, stdio: 'pipe' });
  let output = '', error = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { error += bytes; });
  const closed = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  try {
    const pid = await job.started;
    await expect.poll(() => output.includes('\n'), { timeout: 10000 }).toBe(true);
    await job.signal(); expect(await job.exited).toBe(1); expect(await closed).toBe(0); expect(() => process.kill(pid, 0)).toThrow();
    expect(error).toBe(''); expect.soft(JSON.parse(output)).toEqual({ cache: 'NUL' });
    expect.soft(job.env.PSModuleAnalysisCachePath).toBe('NUL');
    const signalOptions = vi.mocked(execFile).mock.calls.at(-1)![2] as ExecFileOptions;
    expect.soft(signalOptions.env?.PSModuleAnalysisCachePath).toBe('NUL');
    expect.soft(existsSync(path.join(cwd, 'Microsoft', 'Windows', 'PowerShell'))).toBe(false);
    expect.soft(existsSync(redirected)).toBe(false); expect(parentEnv).toEqual(originalEnv);
  } finally { if (child.exitCode === null) { await job.signal().catch(() => child.kill()); await closed; } job.dispose(); }
}, 20000);

test.runIf(process.platform === 'win32')('standalone Windows job preserves child exit and closes descendants before its separate proof', async () => {
  const root = path.resolve('.work/windows-process-tests'); mkdirSync(root, { recursive: true }); const cwd = mkdtempSync(path.join(root, 'case-')); const fixture = path.join(cwd, 'fixture.mjs'), childFile = path.join(cwd, 'child.json');
  writeFileSync(fixture, "import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true,windowsHide:true});writeFileSync(process.argv[2],JSON.stringify({child:child.pid}));child.unref();process.stdout.write('ordinary-output');setTimeout(()=>process.exit(7),100);");
  let controller: ChildProcessWithoutNullStreams | undefined; let job: WindowsProcessJob | undefined; let childPid: number | undefined;
  try {
    job = await windowsProcessJob([process.execPath, fixture, childFile], cwd); controller = spawn(job.command[0]!, job.command.slice(1), { cwd, env: { ...isolatedEnv(cwd), ...job.env }, windowsHide: true, stdio: 'pipe' }); let output = '', error = ''; controller.stdout.on('data', bytes => { output += bytes; }); controller.stderr.on('data', bytes => { error += bytes; });
    const closed = new Promise<number | null>(resolve => controller!.on('close', resolve)); await job.started; expect(await job.exited).toBe(7); childPid = JSON.parse(readFileSync(childFile, 'utf8')).child;
    expect(() => process.kill(childPid!, 0)).toThrow(); expect(await closed).toBe(0); expect(output).toBe('ordinary-output'); expect(error).toBe('');
  } finally { if (controller && controller.exitCode === null) { try { await job?.signal(); } catch { controller.kill(); } } job?.dispose(); if (childPid) expect(() => process.kill(childPid!, 0)).toThrow(); }
}, 20000);

test.runIf(process.platform === 'win32')('job shutdown proof stays independent of stderr output and open stdin', async () => {
  const root = path.resolve('.work/windows-process-tests'); mkdirSync(root, { recursive: true }); const cwd = mkdtempSync(path.join(root, 'case-'));
  const job = await windowsProcessJob([process.execPath, '-e', "process.stderr.write('error-output');setInterval(()=>{},1000)"], cwd); const child = spawn(job.command[0]!, job.command.slice(1), { cwd, env: { ...isolatedEnv(cwd), ...job.env }, windowsHide: true, stdio: 'pipe' }); child.stdout.resume(); let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; }); const closed = new Promise(resolve => child.on('close', resolve));
  try { const pid = await job.started; await expect.poll(() => stderr).toContain('error-output'); await job.signal(); expect(await job.exited).toBe(1); expect(() => process.kill(pid, 0)).toThrow(); await closed; }
  finally { if (child.exitCode === null) child.kill(); job.dispose(); }
}, 20000);
