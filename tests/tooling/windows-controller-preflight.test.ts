import { expect, test } from 'vitest';
import { instrumentController, preflightEnvironment } from '../../scripts/windows-controller-preflight.mjs';
import { windowsJob } from '../../src/runtime/windows-job.js';

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
  const script = Buffer.from(diagnostic.args[4], 'base64').toString('utf16le');
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
