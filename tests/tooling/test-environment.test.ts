import { afterEach, expect, test, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { executePlan } from '../../scripts/run-tests.mjs';
import { isolatedPaths, isolatedTestEnvironment } from '../../scripts/test-environment.mjs';

const fixtures: string[] = [];
function fixture() {
  const parent = path.resolve('.work/test-environment-regressions'); mkdirSync(parent, { recursive: true });
  const base = mkdtempSync(path.join(parent, 'case-')); fixtures.push(base); return base;
}
function put(base: string, file: string, value: string) {
  const target = path.join(base, file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, value);
}
const forbidden = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_PARAMETERS', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'SSH_AUTH_SOCK', 'OPENAI_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'PYTHONPATH', 'NODE_OPTIONS'];
afterEach(() => { vi.unstubAllEnvs(); for (const base of fixtures.splice(0)) rmSync(base, { recursive: true, force: true }); });

test('the shared local and CI allowlist replaces host paths and removes configuration and credential injection', () => {
  const base = fixture(); const oldHome = path.join(base, 'artificial-home');
  const inherited = { Path: 'fixture-path', systemroot: 'fixture-system', HARNESS_TEST_NODE: 'fixture-node', HARNESS_TEST_PYTHON: 'fixture-python', HARNESS_TEST_CODEX_BIN: 'fixture-native', HOME: oldHome, USERPROFILE: oldHome, CODEX_HOME: oldHome, TMPDIR: oldHome, XDG_CONFIG_HOME: oldHome, ...Object.fromEntries(forbidden.map(key => [key, 'fixture-injected'])) };
  const original = { ...inherited }; const env = isolatedTestEnvironment(base, inherited);
  expect(inherited).toEqual(original);
  expect(env).toMatchObject({ PATH: 'fixture-path', SystemRoot: 'fixture-system', HARNESS_TEST_NODE: 'fixture-node', HARNESS_TEST_PYTHON: 'fixture-python', HARNESS_TEST_CODEX_BIN: 'fixture-native', GIT_CONFIG_NOSYSTEM: '1', PYTHONNOUSERSITE: '1' });
  for (const key of forbidden) expect(env[key]).toBeUndefined();
  for (const key of ['HOME', 'USERPROFILE', 'CODEX_HOME', 'TMPDIR', 'XDG_CONFIG_HOME']) expect(env[key]).not.toBe(oldHome);
  expect(env.HOME).toBe(env.USERPROFILE); expect(env.CODEX_HOME).toBe(path.join(env.HOME, 'codex'));
  expect(env.GIT_CONFIG_GLOBAL).toBe(process.platform === 'win32' ? 'NUL' : '/dev/null');
  expect(env.GIT_CONFIG_SYSTEM).toBe(env.GIT_CONFIG_GLOBAL);
});

test('both engines and prerequisite checks receive the same isolated environment without mutating the caller', () => {
  const base = fixture(); const oldHome = path.join(base, 'artificial-home');
  vi.stubEnv('HOME', oldHome); vi.stubEnv('CODEX_HOME', oldHome); vi.stubEnv('OPENAI_API_KEY', 'fixture-only');
  vi.stubEnv('HARNESS_TEST_CODEX_BIN', path.join(base, 'fixture-native'));
  const runVitest = vi.fn((_files: string[], _base: string, _env: NodeJS.ProcessEnv) => ({ status: 'passed', exitCode: 0 })); const runPythonTests = vi.fn((_files: string[], _base: string, _env: NodeJS.ProcessEnv) => ({ status: 'passed', exitCode: 0 }));
  const nativePrerequisite = vi.fn((_base: string, binary: string, _env: NodeJS.ProcessEnv) => ({ status: 'ready', binary })); const pythonPrerequisite = vi.fn((_env: NodeJS.ProcessEnv) => ({ status: 'ready' }));
  const plan = { files: ['tests/runtime/native-smoke.test.ts', 'tests/deploy/root/test_fixture.py'] };
  expect(executePlan(plan, base, { runVitest, runPythonTests, nativePrerequisite, pythonPrerequisite }).status).toBe('passed');
  const env = runVitest.mock.calls[0]![2];
  expect(runPythonTests.mock.calls[0]![2]).toBe(env); expect(pythonPrerequisite.mock.calls[0]![0]).toBe(env); expect(nativePrerequisite.mock.calls[0]![2]).toBe(env);
  expect(env.HOME).not.toBe(oldHome); expect(env.OPENAI_API_KEY).toBeUndefined(); expect(env.HARNESS_TEST_CODEX_BIN).toBe(path.join(base, 'fixture-native'));
  expect(process.env.HOME).toBe(oldHome); expect(process.env.OPENAI_API_KEY).toBe('fixture-only');
  runVitest.mockClear(); runPythonTests.mockClear();
  for (const status of ['skipped', 'failed']) {
    const result = executePlan(plan, base, { runVitest, runPythonTests, nativePrerequisite, pythonPrerequisite: () => ({ status, reason: 'fixture-unavailable' }) });
    expect(result).toMatchObject({ status, exitCode: status === 'failed' ? 1 : 3, results: [] });
  }
  expect(runVitest).not.toHaveBeenCalled(); expect(runPythonTests).not.toHaveBeenCalled();
});

test('root temporary ancestors stay outside private homes even with an inherited private TMPDIR', () => {
  const base = fixture(); vi.stubEnv('TMPDIR', path.join(base, 'nonexistent-private-temp'));
  const paths = isolatedPaths(base, true);
  if (process.platform !== 'win32') {
    fixtures.push(paths.temporary);
    expect(paths.temporary.startsWith(paths.home + path.sep)).toBe(false);
    expect(statSync(paths.temporary).mode & 0o777).toBe(0o755);
    expect(statSync(paths.home).mode & 0o777).toBe(0o700);
    if (process.getuid?.() === 0) {
      const visible = path.join(paths.temporary, 'visible'); writeFileSync(visible, 'fixture'); chmodSync(visible, 0o644);
      const child = spawnSync(process.execPath, ['-e', 'require("node:fs").readFileSync(process.argv[1])', visible], { uid: 65534, gid: 65534, cwd: paths.temporary, env: isolatedTestEnvironment(base), encoding: 'utf8' });
      expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
    }
  } else expect(paths.temporary).toBe(path.join(paths.home, 'tmp'));
});

test('the real targeted CLI isolates JavaScript and Python Git fixtures from artificial host hooks and injected Git overrides', () => {
  const base = fixture(); const oldHome = path.join(base, 'artificial-home'); const hooks = path.join(oldHome, 'hooks');
  put(oldHome, 'hooks/pre-commit', '#!/bin/sh\nprintf "fixture-hook-ran\\n" >> hook-marker\n'); chmodSync(path.join(hooks, 'pre-commit'), 0o755);
  put(oldHome, '.gitconfig', `[core]\n hooksPath = "${hooks.replaceAll('\\', '/')}"\n[commit]\n gpgsign = true\n`);
  put(oldHome, 'codex/auth.json', '{"fixture":"must-remain-unread"}');
  // Start from the same allowlist, then add only artificial hostile state. The
  // positive control never reads the developer's HOME or system Git config.
  const inherited = { ...isolatedTestEnvironment(base), HOME: oldHome, USERPROFILE: oldHome, CODEX_HOME: path.join(oldHome, 'codex'), OPENAI_API_KEY: 'fixture-only', AWS_SECRET_ACCESS_KEY: 'fixture-only' };
  const controlEnv = { ...inherited }; delete controlEnv.GIT_CONFIG_GLOBAL;
  const control = path.join(base, 'control'); mkdirSync(control);
  const git = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe', windowsHide: true });
  git(control, controlEnv, 'init', '-q'); put(control, 'fixture.txt', 'fixture'); git(control, controlEnv, 'add', '.');
  git(control, controlEnv, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'positive-control');
  expect(readFileSync(path.join(control, 'hook-marker'), 'utf8')).toBe('fixture-hook-ran\n');
  for (const file of ['run-tests.mjs', 'select-tests.mjs', 'test-environment.mjs', 'snapshot.mjs', 'release-audit.mjs', 'release-authorization.mjs', 'python-tests.py']) put(base, 'scripts/' + file, readFileSync(path.resolve('scripts', file), 'utf8'));
  put(base, 'package.json', JSON.stringify({ type: 'module', scripts: { 'test:targeted': 'node scripts/run-tests.mjs --targeted' } }));
  put(base, 'vitest.config.mjs', "export default { test: { include: ['tests/**/*.test.ts'], maxWorkers: 1 } };\n");
  put(base, 'tests/tooling/unselected.test.ts', "throw Error('unselected fixture must not run');\n");
  const absentKeys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_PARAMETERS', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'SSH_AUTH_SOCK', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'PYTHONPATH'];
  put(base, 'tests/tooling/probe.test.ts', `import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
test('isolated JavaScript child', () => {
  for (const key of ${JSON.stringify(absentKeys)}) expect(process.env[key]).toBeUndefined();
  expect(process.env.HOME).not.toBe(${JSON.stringify(oldHome)});
  expect(existsSync(path.join(process.env.CODEX_HOME!, 'auth.json'))).toBe(false);
  const cwd = path.resolve('js-repo'); mkdirSync(cwd);
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git('init', '-q'); writeFileSync(path.join(cwd, 'fixture.txt'), 'fixture'); git('add', '.');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'isolated');
  expect(existsSync(path.join(cwd, 'hook-marker'))).toBe(false);
  writeFileSync('js-home.json', JSON.stringify(process.env.HOME));
});\n`);
  put(base, 'tests/deploy/test_probe.py', `import json, os, pathlib, subprocess, unittest
class Probe(unittest.TestCase):
 def test_isolated_python_child(self):
  for key in ${JSON.stringify(absentKeys)}: self.assertNotIn(key, os.environ)
  self.assertNotEqual(os.environ['HOME'], ${JSON.stringify(oldHome)})
  self.assertFalse((pathlib.Path(os.environ['CODEX_HOME']) / 'auth.json').exists())
  cwd = pathlib.Path('python-repo'); cwd.mkdir()
  def git(*args): subprocess.run(['git', *args], cwd=cwd, check=True, capture_output=True)
  git('init', '-q'); (cwd / 'fixture.txt').write_text('fixture'); git('add', '.')
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'isolated')
  self.assertFalse((cwd / 'hook-marker').exists())
  pathlib.Path('python-home.json').write_text(json.dumps(os.environ['HOME']))
`);
  const env = { ...inherited, GIT_CONFIG_GLOBAL: path.join(oldHome, '.gitconfig'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooks, GIT_CONFIG_PARAMETERS: `'core.hooksPath=${hooks.replaceAll('\\', '/')}'`, GIT_DIR: path.join(control, '.git'), GIT_WORK_TREE: control, GIT_CONFIG: path.join(oldHome, '.gitconfig'), PYTHONPATH: oldHome };
  const child = spawnSync(process.execPath, ['scripts/run-tests.mjs', '--targeted', 'tests/tooling/probe.test.ts', 'tests/deploy/test_probe.py'], { cwd: base, env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  expect(child.error).toBeUndefined(); expect(child.status, child.stdout + child.stderr).toBe(0);
  expect(JSON.parse(readFileSync(path.join(base, 'js-home.json'), 'utf8'))).toBe(JSON.parse(readFileSync(path.join(base, 'python-home.json'), 'utf8')));
  expect(existsSync(path.join(base, 'js-repo/hook-marker'))).toBe(false); expect(existsSync(path.join(base, 'python-repo/hook-marker'))).toBe(false);
  expect(readFileSync(path.join(control, 'hook-marker'), 'utf8')).toBe('fixture-hook-ran\n');
  const unavailable = spawnSync(process.execPath, ['scripts/run-tests.mjs', '--targeted', 'tests/tooling/probe.test.ts', 'tests/deploy/test_probe.py'], { cwd: base, env: { ...env, HARNESS_TEST_PYTHON: path.join(base, 'absent-python') }, encoding: 'utf8', timeout: 15000, windowsHide: true });
  expect(unavailable.status).toBe(3); expect(JSON.parse(unavailable.stdout)).toMatchObject({ status: 'skipped', results: [] });
  // Exercise planning only: an unaudited artificial repository must reach the
  // audit rejection without following injected GIT_DIR or a global fsmonitor.
  put(base, '.gitignore', '.work/\nnode_modules/\nartificial-home/\ncontrol/\njs-repo/\npython-repo/\n');
  put(base, 'verification/audits.json', '{"schemaVersion":1,"rounds":[]}');
  const safe = isolatedTestEnvironment(base); git(base, safe, 'init', '-q'); git(base, safe, 'add', '.');
  put(oldHome, 'hooks/fsmonitor', '#!/bin/sh\nprintf "fixture-fsmonitor-ran\\n" >> fsmonitor-marker\nprintf "\\0"\n'); chmodSync(path.join(hooks, 'fsmonitor'), 0o755);
  put(oldHome, '.gitconfig', `[core]\n hooksPath = "${hooks.replaceAll('\\', '/')}"\n fsmonitor = "${path.join(hooks, 'fsmonitor').replaceAll('\\', '/')}"\n`);
  git(control, controlEnv, 'ls-files', '--cached');
  expect(existsSync(path.join(control, 'fsmonitor-marker'))).toBe(true);
  const refused = spawnSync(process.execPath, ['scripts/run-tests.mjs', '--full'], { cwd: base, env, encoding: 'utf8', timeout: 15000, windowsHide: true });
  expect(refused.status).toBe(1); expect(refused.stderr).toContain('Three recorded audit rounds are required');
  expect(existsSync(path.join(base, 'fsmonitor-marker'))).toBe(false);
}, 45000);
