import { afterEach, expect, test, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { controllerProbe, instrumentController, preflightEnvironment } from '../../scripts/windows-controller-preflight.mjs';
import { windowsJob } from '../../src/runtime/windows-job.js';

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: vi.fn(),
}));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

function fixtureController() {
  const child = Object.assign(new EventEmitter(), {
    pid: 123456, exitCode: null as number | null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => { child.exitCode = 1; child.emit('close', 1, null); return true; }),
  });
  vi.mocked(spawn).mockImplementationOnce(() => {
    queueMicrotask(() => {
      child.emit('spawn');
      child.stdout.write(JSON.stringify({ fixture: 'harness-preflight', pid: 654321 }) + '\n');
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  const command = windowsJob({ bin: process.execPath, args: ['-e', '0'], cwd: process.cwd(), env: {} }).command;
  return { child, command };
}

test.each(['windows-job', 'windows-process'])('confirmed %s cleanup never probes or kills a recycled PID', async kind => {
  const { child, command } = fixtureController();
  const numericKill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const ownership = {
    ...(kind === 'windows-process' ? { started: Promise.resolve(654321), exited: Promise.resolve(1) } : {}),
    signal: async () => { child.exitCode = 0; child.emit('close', 0, null); },
  };
  const result = await controllerProbe(kind, command, process.cwd(), {}, ownership);
  expect(result.status).toBe('passed');
  expect(result.cleanupConfirmed).toBe(true);
  expect(numericKill).not.toHaveBeenCalled();
  expect(child.kill).not.toHaveBeenCalled();
});

test('failed ownership proof stays failed and cleanup uses only the owned controller', async () => {
  const { child, command } = fixtureController();
  const numericKill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const dispose = vi.fn();
  const result = await controllerProbe('windows-process', command, process.cwd(), {}, {
    started: Promise.resolve(654321), signal: async () => { throw Error('shutdown not acknowledged'); }, dispose,
  });
  expect(result.status).toBe('failed');
  expect(result.failure).toBe('shutdown not acknowledged');
  expect(result.cleanupConfirmed).not.toBe(true);
  expect(child.kill).toHaveBeenCalledOnce();
  expect(numericKill).not.toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledOnce();
});

test('nonzero controller exit cannot become successful cleanup', async () => {
  const { child, command } = fixtureController();
  const result = await controllerProbe('windows-job', command, process.cwd(), {}, {
    signal: async () => { child.exitCode = 1; child.emit('close', 1, null); },
  });
  expect(result.status).toBe('failed');
  expect(result.failure).toBe('Controller exit code 1');
  expect(result.cleanupConfirmed).not.toBe(true);
});

test('preflight isolates profile and secrets while retaining only required Windows bootstrap paths', () => {
  const env = preflightEnvironment('fixture-home', { Path: 'fixture-path', SYSTEMROOT: 'fixture-windows', OPENAI_API_KEY: 'must-not-copy', GITHUB_TOKEN: 'must-not-copy', HOME: 'private-home', PSModuleAnalysisCachePath: 'private-cache' });
  expect(env.PATH).toBe('fixture-path'); expect(env.SystemRoot).toBe('fixture-windows');
  expect(env.HOME).toBe('fixture-home'); expect(env.PSModuleAnalysisCachePath).toBe('NUL');
  expect(JSON.stringify(env)).not.toMatch(/must-not-copy|private-/);
});

test('diagnostic copy keeps real ownership checks and adds exact Win32 and PowerShell stages', () => {
  const job = windowsJob({ bin: process.execPath, args: ['-e', '0'], cwd: process.cwd(), env: {} });
  const before = [...job.command.args];
  const diagnostic = instrumentController(job.command.args);
  const script = Buffer.from(diagnostic.args[4]!, 'base64').toString('utf16le');
  expect(job.command.args).toEqual(before);
  expect(script).toContain('Check(AssignProcessToJobObject(job,child.process))');
  expect(script).toContain('limits.basic.flags=0x2000');
  expect(script).toContain('Marshal.GetLastWin32Error()');
  expect(script).toContain('harness-preflight-before-add-type');
  expect(script).toContain('harness-preflight-after-add-type');
  expect(script).toContain('harness-preflight-powershell-exception');
  expect(diagnostic.checks.some((value: { operation: string }) => value.operation.includes('AssignProcessToJobObject'))).toBe(true);
});

test('unknown controller shapes fail explicitly instead of pretending to inspect new code', () => {
  expect(() => instrumentController(['-Command', 'unrelated'])).toThrow('argument shape');
  expect(() => instrumentController(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from('unrelated', 'utf16le').toString('base64')])).toThrow('hooks drifted');
});
