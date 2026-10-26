import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { root } from './snapshot.mjs';

const encoded = script => ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
const bounded = value => String(value ?? '').slice(-32768);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

export function preflightEnvironment(home, inherited = process.env) {
  const env = {};
  for (const key of ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'SystemDrive']) {
    const found = Object.keys(inherited).find(name => name.toLowerCase() === key.toLowerCase());
    if (found) env[key] = inherited[found];
  }
  return { ...env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, 'codex'), TEMP: path.join(home, 'tmp'), TMP: path.join(home, 'tmp'), TMPDIR: path.join(home, 'tmp'), APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'), PSModuleAnalysisCachePath: 'NUL', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost,[::1]' };
}

// Instrument only the trusted launcher produced by the actual built module.
// The production controller, ownership flags and cleanup checks are unchanged.
export function instrumentController(args) {
  if (args.length !== 5 || args[3] !== '-EncodedCommand') throw Error('Unexpected Windows controller argument shape');
  let script = Buffer.from(args[4], 'base64').toString('utf16le');
  const check = 'static void Check(bool okay) { if(!okay) throw new IOException("Windows process ownership operation failed"); }';
  const replacement = 'static void Check(bool okay,[System.Runtime.CompilerServices.CallerLineNumber] int line=0) { int error=Marshal.GetLastWin32Error(); Console.Error.WriteLine("harness-preflight-check line="+line+" okay="+okay+" win32="+(okay?0:error)); if(!okay) throw new IOException("Windows process ownership operation failed: line="+line+" win32="+error); }';
  if (!script.includes(check) || !script.includes("Add-Type -TypeDefinition @'\n") || !script.includes("'@\nexit [HarnessWindowsJob]")) throw Error('Windows controller diagnostic hooks drifted');
  const lines = script.slice(script.indexOf("Add-Type -TypeDefinition @'\n") + "Add-Type -TypeDefinition @'\n".length, script.indexOf("\n'@")).split('\n');
  const checks = lines.flatMap((line, index) => line.includes('Check(') && !line.includes('static void Check(') ? [{ line: index + 1, operation: line.trim() }] : []);
  script = script.replace(check, replacement);
  const innerCatch = /} catch \{ Console\.Error\.WriteLine\("Windows (?:native process|process ownership) cleanup was not confirmed"\); return 1; }/;
  const outerCatch = /} catch \{ \[Console\]::Error\.WriteLine\('Windows (?:native|process) launcher failed'\); exit 1 }/;
  if (!innerCatch.test(script) || !outerCatch.test(script)) throw Error('Windows controller exception hooks drifted');
  script = script.replace(innerCatch, '} catch(Exception error) { Console.Error.WriteLine("harness-preflight-native-exception "+error); return 1; }');
  script = script.replace(outerCatch, "} catch { [Console]::Error.WriteLine('harness-preflight-powershell-exception ' + $_.Exception.ToString()); exit 1 }");
  script = script.replace("Add-Type -TypeDefinition @'\n", "[Console]::Error.WriteLine('harness-preflight-before-add-type')\n$preflightCompile=[Diagnostics.Stopwatch]::StartNew()\nAdd-Type -TypeDefinition @'\n");
  script = script.replace("'@\nexit [HarnessWindowsJob]", "'@\n$preflightCompile.Stop()\n[Console]::Error.WriteLine('harness-preflight-after-add-type elapsedMs=' + $preflightCompile.ElapsedMilliseconds)\nexit [HarnessWindowsJob]");
  script = "[Console]::Error.WriteLine('harness-preflight-powershell-started')\n" + script;
  return { args: encoded(script), checks };
}

function launch(bin, args, cwd, env) {
  const start = Date.now();
  const process = spawn(bin, args, { cwd, env, windowsHide: true, stdio: 'pipe' });
  const result = { spawned: false, pid: process.pid, exitCode: null, signal: null, stdout: '', stderr: '', elapsedMs: 0 };
  const closed = new Promise(resolve => {
    process.once('spawn', () => { result.spawned = true; });
    process.once('error', error => { result.error = { code: error.code ?? null, message: bounded(error.message) }; });
    process.once('close', (code, signal) => { result.exitCode = code; result.signal = signal; result.elapsedMs = Date.now() - start; resolve(result); });
  });
  process.stdout.on('data', bytes => { result.stdout = bounded(result.stdout + bytes); });
  process.stderr.on('data', bytes => {
    result.stderr = bounded(result.stderr + bytes);
    if (result.powershellStartedMs === undefined && result.stderr.includes('harness-preflight-powershell-started')) result.powershellStartedMs = Date.now() - start;
    if (result.compileStartedMs === undefined && result.stderr.includes('harness-preflight-before-add-type')) result.compileStartedMs = Date.now() - start;
    const compiled = /harness-preflight-after-add-type elapsedMs=(\d+)/.exec(result.stderr);
    if (compiled) result.compileMs = Number(compiled[1]);
  });
  process.stdin.on('error', () => {});
  return { process, result, closed, start };
}

async function deadline(promise, timeoutMs, stage) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${stage} timeout after ${timeoutMs}ms`)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

async function basicPowerShell(bin, home, env, stage) {
  const script = "$ErrorActionPreference='Stop';[Console]::WriteLine(([pscustomobject]@{version=$PSVersionTable.PSVersion.ToString();languageMode=$ExecutionContext.SessionState.LanguageMode.ToString();is64Bit=[Environment]::Is64BitProcess;addTypeAvailable=[bool](Get-Command Add-Type -ErrorAction Stop)} | ConvertTo-Json -Compress))";
  const run = launch(bin, encoded(script), home, env);
  try { await deadline(run.closed, 10000, stage); }
  catch (error) { run.result.failure = error.message; run.process.kill(); await deadline(run.closed, 2000, `${stage}-kill`).catch(() => {}); }
  return { stage, status: !run.result.failure && run.result.exitCode === 0 ? 'passed' : 'failed', ...run.result };
}

async function controllerProbe(kind, command, home, env, job) {
  const instrumented = instrumentController(command.args);
  const run = launch(command.bin, instrumented.args, home, { ...env, ...command.env });
  let childPid;
  let ready;
  const childReady = new Promise(resolve => { ready = resolve; });
  run.process.stdout.on('data', () => {
    const line = run.result.stdout.split('\n').find(value => value.startsWith('{"fixture":"harness-preflight"'));
    if (!line) return;
    try { const value = JSON.parse(line); if (Number.isSafeInteger(value.pid) && value.pid > 0) { childPid = value.pid; ready(); } } catch {}
  });
  try {
    await deadline(Promise.race([childReady, run.closed.then(() => { throw Error('Controller exited before child-ready'); })]), 10000, `${kind}-startup`);
    if (job.started) { const nativePid = await job.started; if (nativePid !== childPid) throw Error('Controller ownership PID differs from fixture PID'); }
    run.result.childReady = true; run.result.childReadyMs = Date.now() - run.start;
    const signalAt = Date.now();
    try { await job.signal(); run.result.signalAcknowledged = true; }
    finally { run.result.signalElapsedMs = Date.now() - signalAt; }
    if (job.exited) run.result.childExitCode = await deadline(job.exited, 6000, `${kind}-cleanup-proof`);
    await deadline(run.closed, 6000, `${kind}-controller-exit`);
    if (run.result.exitCode !== 0) throw Error(`Controller exit code ${run.result.exitCode}`);
    if (alive(childPid)) throw Error('Owned fixture child survived confirmed controller exit');
    run.result.cleanupConfirmed = true;
  } catch (error) { run.result.failure = bounded(error.message); }
  finally {
    if (run.process.exitCode === null) run.process.kill();
    await deadline(run.closed, 2000, `${kind}-kill`).catch(() => {});
    if (childPid && alive(childPid)) { try { process.kill(childPid); run.result.forcedChildCleanup = true; } catch {} }
    job.dispose?.();
  }
  return { stage: kind, status: run.result.cleanupConfirmed && !run.result.failure ? 'passed' : 'failed', checks: instrumented.checks, ...run.result };
}

export async function runWindowsControllerPreflight(base = root) {
  if (process.platform !== 'win32') throw Error('Windows controller preflight requires Windows');
  const parent = path.join(base, '.work/windows-controller-preflight'); mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(path.join(parent, 'home-'));
  for (const folder of ['tmp', 'appdata', 'localappdata', 'codex']) mkdirSync(path.join(home, folder));
  const env = preflightEnvironment(home);
  // These are the same sparse caller variables used by the real ownership
  // fixtures. Compare their PowerShell bootstrap with CI's sterile environment.
  const sparse = { HOME: home, USERPROFILE: home, TEMP: env.TEMP, TMP: env.TMP };
  const { windowsJob } = await import(pathToFileURL(path.join(base, 'dist/src/runtime/windows-job.js')).href);
  const { windowsProcessJob } = await import(pathToFileURL(path.join(base, 'dist/src/runtime/windows-process.js')).href);
  const command = { bin: process.execPath, args: ['-e', 'console.log(JSON.stringify({fixture:"harness-preflight",pid:process.pid}));setInterval(()=>{},1000)'], cwd: home, env: sparse };
  const job = windowsJob(command);
  const results = [await basicPowerShell(job.command.bin, home, env, 'powershell-ci-environment')];
  results.push(await basicPowerShell(job.command.bin, home, { ...sparse, SystemRoot: job.command.env.SystemRoot, PSModuleAnalysisCachePath: 'NUL' }, 'powershell-sparse-environment'));
  results.push(await controllerProbe('windows-job', job.command, home, sparse, job));
  const standalone = await windowsProcessJob([command.bin, ...command.args], home);
  results.push(await controllerProbe('windows-process', { bin: standalone.command[0], args: standalone.command.slice(1), env: standalone.env }, home, sparse, standalone));
  return { schemaVersion: 1, platform: process.platform, node: process.version, status: results.every(result => result.status === 'passed') ? 'passed' : 'failed', fixture: 'independent-home-fixed-node-child-no-model', results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = path.resolve(process.argv[2] ?? '.work/windows-controller-preflight.json');
  let report;
  try { report = await runWindowsControllerPreflight(); }
  catch (error) { report = { status: 'failed', error: bounded(error.message) }; }
  mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, error: report.error, results: report.results?.map(({ stage, status, elapsedMs, powershellStartedMs, compileStartedMs, compileMs, childReadyMs, signalElapsedMs, exitCode, failure }) => ({ stage, status, elapsedMs, powershellStartedMs, compileStartedMs, compileMs, childReadyMs, signalElapsedMs, exitCode, failure })) }));
  process.exitCode = report.status === 'passed' ? 0 : 1;
}
