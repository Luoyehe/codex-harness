import { expect, test } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { windowsJob, windowsPowerShellBootstrap, windowsPowerShellEnv } from '../../src/runtime/windows-job.js';
import { windowsProcessJob } from '../../src/runtime/windows-process.js';

test('bootstrap removes every spelling of caller module paths without changing unrelated overrides', () => {
  const input = { PSModulePath: 'one', PSMODULEPATH: 'two', psmodulepath: null, PSModuleAnalysisCachePath: 'cache', Keep: 'value' };
  const output = windowsPowerShellEnv(input);
  expect(Object.entries(output).filter(([name]) => name.toLowerCase() === 'psmodulepath')).toEqual([['PSModulePath', path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')]]);
  expect(output.PSModuleAnalysisCachePath).toBe('NUL'); expect(output.Keep).toBe('value'); expect(input.PSMODULEPATH).toBe('two');
});

test.runIf(process.platform === 'win32')('both real launchers reject an executable caller module with the inbox Utility name', async () => {
  const parent = path.resolve('.work/windows-module-tests'); mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(path.join(parent, 'home-')), modules = path.join(home, 'modules'), shadow = path.join(modules, 'Microsoft.PowerShell.Utility'), marker = path.join(home, 'untrusted-module-loaded');
  mkdirSync(shadow, { recursive: true });
  writeFileSync(path.join(shadow, 'Microsoft.PowerShell.Utility.psd1'), "@{RootModule='Microsoft.PowerShell.Utility.psm1';ModuleVersion='1.0.0';FunctionsToExport=@('ConvertFrom-Json','Add-Type','Start-Sleep');CmdletsToExport=@()}\n");
  writeFileSync(path.join(shadow, 'Microsoft.PowerShell.Utility.psm1'), "[IO.File]::WriteAllText($env:HARNESS_FIXTURE_MODULE_MARKER,'executed')\nfunction ConvertFrom-Json { throw 'untrusted fixture module selected' }\nfunction Add-Type { throw 'untrusted fixture module selected' }\nfunction Start-Sleep { throw 'untrusted fixture module selected' }\nExport-ModuleMember -Function ConvertFrom-Json,Add-Type,Start-Sleep\n");
  const env = { HOME: home, USERPROFILE: home, TMP: home, TEMP: home, HARNESS_FIXTURE_MODULE_MARKER: marker, PSModulePath: modules, PSMODULEPATH: modules };
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows', powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Only this negative-control child permits our locally generated unsigned
  // fixture module. No machine policy or production launcher policy changes.
  // Prove discovery executes the shadow; protected launchers must not select it.
  expect(() => execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';'{}' | ConvertFrom-Json", 'utf16le').toString('base64')], { cwd: home, env: { ...env, SystemRoot: systemRoot, PSModuleAnalysisCachePath: 'NUL' }, windowsHide: true, timeout: 10000, stdio: 'pipe' })).toThrow();
  expect(existsSync(marker)).toBe(true); unlinkSync(marker);
  const args = ['-e', "process.stdout.write('owned-fixture-ready\\n');setInterval(()=>{},1000)"];
  for (const kind of ['protocol', 'standalone'] as const) {
    const protocol = kind === 'protocol' ? windowsJob({ bin: process.execPath, args, cwd: home, env }) : undefined;
    const standalone = kind === 'standalone' ? await windowsProcessJob([process.execPath, ...args], home) : undefined;
    const bin = protocol ? protocol.command.bin : standalone!.command[0]!;
    const commandArgs = protocol ? protocol.command.args : standalone!.command.slice(1);
    const commandEnv = protocol ? protocol.command.env : windowsPowerShellEnv({ ...env, ...standalone!.env });
    const job = protocol ?? standalone!;
    let output = '', stderr = '';
    const child = spawn(bin, [...commandArgs], { cwd: home, env: commandEnv, windowsHide: true, stdio: 'pipe' });
    child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; }); child.stdin.on('error', () => {});
    const closed = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    try {
      expect(Buffer.from(commandArgs[4]!, 'base64').toString('utf16le')).toContain(windowsPowerShellBootstrap);
      await expect.poll(() => output, { timeout: 10000, message: kind }).toContain('owned-fixture-ready');
      await job.signal(); expect(await closed).toBe(0); expect(stderr).toBe(''); expect(existsSync(marker)).toBe(false);
    } finally { if (child.exitCode === null) { child.kill(); await closed; } standalone?.dispose(); }
  }
}, 25000);
