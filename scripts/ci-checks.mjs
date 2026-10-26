import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshot, root } from './snapshot.mjs';
import { gitChanges, nativePrerequisite, nativeTestFiles, runPythonTests, selectTests, testInventory } from './select-tests.mjs';
import { prepareRun, runVitest } from './run-tests.mjs';
import { releaseAuthorization } from './release-authorization.mjs';

const authorizationPath = 'verification/audit-evidence/release-closeout/authorization.json';
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) && !/^0+$/.test(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, value) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); };

export function selectCiPlan({ changed, available, head, sourceDigest, authorization }) {
  if (!commit(head)) throw Error('CI must inspect an explicit head commit');
  const selected = selectTests(changed, available);
  const full = selected.status === 'requires-full-audit';
  if (full && (!authorization || authorization.sourceDigest !== sourceDigest)) throw Error('Change scope requires complete review and an exact-source closeout authorization; no tests were started');
  const files = full ? [...available].sort() : Object.values(selected.groups).flat().sort();
  const rootFiles = files.filter(name => name.startsWith('tests/deploy/root/'));
  const standardFiles = files.filter(name => !name.startsWith('tests/deploy/root/'));
  return {
    schemaVersion: 1, head, sourceDigest, mode: full ? 'authorized-full' : selected.status,
    files, standardFiles, rootFiles,
    targets: [...(standardFiles.length ? ['linux', 'windows'] : []), ...(rootFiles.length ? ['linux-root'] : [])],
    selection: selected, ...(full ? { authorization } : {}),
  };
}

export function buildCiPlan(base = root, env = process.env) {
  const event = env.GITHUB_EVENT_PATH ? json(env.GITHUB_EVENT_PATH) : {};
  const head = env.HARNESS_CI_HEAD || event.pull_request?.head?.sha || env.GITHUB_SHA;
  let baseCommit = env.HARNESS_CI_BASE || event.pull_request?.base?.sha || event.before;
  const pullRequestBase = !env.HARNESS_CI_BASE && event.pull_request?.base?.sha;
  let authorization;
  const file = path.join(base, authorizationPath);
  if (existsSync(file)) {
    const checksum = env.HARNESS_AUTHORIZATION_SHA || hash(readFileSync(file));
    try { authorization = releaseAuthorization(base, authorizationPath, checksum); }
    catch (error) { if (env.HARNESS_AUTHORIZATION_SHA) throw error; }
  }
  // A new ref/tag has a zero before SHA. Only an explicitly reviewed base may
  // replace it; HEAD~1 could silently omit most of a new branch or rewrite.
  if ((env.HARNESS_CI_BASE || pullRequestBase) && !commit(baseCommit)) throw Error('Explicit and pull-request bases must be valid nonzero commits');
  if (!commit(baseCommit)) baseCommit = authorization?.baseCommit;
  if (!commit(baseCommit) || !commit(head)) throw Error('Provide an explicit nonzero base/head or a source-bound release authorization for a new ref');
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: base, encoding: 'utf8', windowsHide: true }).trim();
  if (actual !== head) throw Error('CI checkout does not match the requested head');
  const requestedBaseCommit = baseCommit;
  if (pullRequestBase) {
    // PR base branches may advance independently. Review only changes introduced
    // by the topic branch from the explicitly identified common ancestor.
    baseCommit = execFileSync('git', ['merge-base', '--all', baseCommit, head], { cwd: base, encoding: 'utf8', windowsHide: true }).trim();
    if (!commit(baseCommit)) throw Error('Pull request must have exactly one valid common ancestor');
  } else {
    execFileSync('git', ['merge-base', '--is-ancestor', baseCommit, head], { cwd: base, stdio: 'ignore', windowsHide: true });
  }
  const current = snapshot(base);
  const plan = selectCiPlan({ changed: gitChanges(baseCommit, head, base), available: testInventory(base), head, sourceDigest: current.digest, authorization });
  return { ...plan, baseCommit, ...(pullRequestBase ? { requestedBaseCommit } : {}) };
}

export function reconcileCi(plan, reports) {
  if (!Array.isArray(reports) || reports.length !== plan.targets.length || new Set(reports.map(item => item.target)).size !== reports.length) throw Error('Every expected platform report is required exactly once');
  const cases = new Map();
  for (const target of plan.targets) {
    const report = reports.find(item => item.target === target);
    const expected = target === 'linux-root' ? plan.rootFiles : plan.standardFiles;
    if (!report || report.head !== plan.head || report.sourceDigest !== plan.sourceDigest || report.sourceDigestAfter !== plan.sourceDigest || ![0, 3].includes(report.exitCode) || JSON.stringify(report.files) !== JSON.stringify(expected) || !Array.isArray(report.cases) || !report.cases.length) throw Error(`Incomplete or failed evidence for ${target}`);
    const seen = new Set();
    for (const item of report.cases) {
      if (typeof item.id !== 'string' || !item.id.startsWith(item.file + '::') || !expected.includes(item.file) || !['passed', 'skipped'].includes(item.status) || seen.has(item.id)) throw Error('Invalid, failed or duplicate case outcome');
      seen.add(item.id);
      const states = cases.get(item.id) ?? [];
      states.push({ target, status: item.status }); cases.set(item.id, states);
    }
    for (const file of expected) if (!report.cases.some(item => item.file === file)) throw Error(`Unexecuted selected file: ${file}`);
  }
  const gaps = [...cases].filter(([, values]) => !values.some(value => value.status === 'passed')).map(([id]) => id);
  if (gaps.length) throw Error(`Uncovered platform skips: ${gaps.join(', ')}`);
  return { status: plan.files.length ? 'passed' : 'no-behavior-change', sourceDigest: plan.sourceDigest, head: plan.head, files: plan.files.length, cases: cases.size, coverageGaps: [], note: plan.files.length ? 'All observed cases passed on an appropriate platform; individual skips remain recorded.' : 'No tests were run for documentation-only changes.' };
}

export function isolatedPaths(base, rootFixtures = false) {
  const parent = path.join(base, '.work/ci-homes'); mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(path.join(parent, 'run-'));
  // Root fixtures intentionally drop UID. Keep their disposable temp ancestor
  // traversable without making the isolated home or any credentials readable.
  const temporary = rootFixtures ? mkdtempSync(path.join(tmpdir(), 'harness-ci-root-')) : path.join(home, 'tmp');
  if (rootFixtures) chmodSync(temporary, 0o755); else mkdirSync(temporary);
  for (const folder of ['appdata', 'localappdata']) mkdirSync(path.join(home, folder));
  return { home, temporary };
}
function isolatedEnvironment(base, target) {
  const { home, temporary } = isolatedPaths(base, target === 'linux-root');
  const env = {};
  for (const key of ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'SystemDrive', 'HARNESS_TEST_PYTHON', 'HARNESS_TEST_NODE', 'HARNESS_TEST_CODEX_BIN']) {
    const found = Object.keys(process.env).find(name => name.toLowerCase() === key.toLowerCase());
    if (found) env[key] = process.env[found];
  }
  Object.assign(env, { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, 'codex'), TMP: temporary, TEMP: temporary, TMPDIR: temporary, APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', LANG: 'C.UTF-8', NO_COLOR: '1', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost,[::1]' });
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
}

export function runCi(plan, target, base = root) {
  if (!plan.targets.includes(target) || snapshot(base).digest !== plan.sourceDigest) throw Error('Unknown target or source changed before execution');
  if ((target === 'windows') !== (process.platform === 'win32') || target.startsWith('linux') && process.platform !== 'linux' || target === 'linux-root' && process.getuid?.() !== 0 || target === 'linux' && process.getuid?.() === 0) throw Error('Wrong platform or execution identity');
  if (plan.mode === 'authorized-full') {
    const full = prepareRun('--full', ['--authorization', plan.authorization.path, '--sha256', plan.authorization.sha256], base);
    if (JSON.stringify(full.files) !== JSON.stringify(plan.files)) throw Error('Authorized full plan must include the exact complete inventory');
  }
  else {
    const selected = selectTests(plan.selection.changed, testInventory(base));
    if (!['selected', 'no-behavior-change'].includes(selected.status) || JSON.stringify(Object.values(selected.groups).flat().sort()) !== JSON.stringify(plan.files)) throw Error('Targeted plan was changed');
  }
  const files = target === 'linux-root' ? plan.rootFiles : plan.standardFiles;
  const expected = plan.files.filter(name => target === 'linux-root' ? name.startsWith('tests/deploy/root/') : !name.startsWith('tests/deploy/root/'));
  if (JSON.stringify(files) !== JSON.stringify(expected)) throw Error('Platform selection does not match the complete reviewed plan');
  if (!files.length) throw Error('An empty target is not a passing test job');
  isolatedEnvironment(base, target);
  const js = files.filter(name => /\.test\.tsx?$/.test(name)), python = files.filter(name => name.endsWith('.py'));
  if (js.some(name => nativeTestFiles.includes(name))) {
    const native = nativePrerequisite(base);
    if (native.status !== 'ready') throw Error('Independent official CLI prerequisite is not ready');
  }
  const results = [];
  if (js.length) results.push(runVitest(js, base));
  if (python.length) results.push(runPythonTests(python, base));
  const exitCode = results.some(item => item.exitCode === 1) ? 1 : results.some(item => item.exitCode) ? 3 : 0;
  return { schemaVersion: 1, target, head: plan.head, sourceDigest: plan.sourceDigest, sourceDigestAfter: snapshot(base).digest, files, exitCode, cases: results.flatMap(item => item.cases ?? []), results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, input, output] = process.argv.slice(2);
    if (mode === 'plan') {
      const plan = buildCiPlan(); save(input, plan);
      if (process.env.GITHUB_OUTPUT) {
        const { appendFileSync } = await import('node:fs');
        appendFileSync(process.env.GITHUB_OUTPUT, `tests=${plan.files.length > 0}\nstandard=${plan.standardFiles.length > 0}\nroot=${plan.rootFiles.length > 0}\n`);
      }
      console.log(JSON.stringify({ mode: plan.mode, base: plan.baseCommit, head: plan.head, files: plan.files.length, targets: plan.targets }));
    } else if (['linux', 'windows', 'linux-root'].includes(mode)) {
      const result = runCi(json(input), mode); save(output, result); process.exitCode = result.exitCode;
    } else if (mode === 'reconcile') {
      const reports = readdirSync(output).filter(name => /^result-(?:linux|windows|linux-root)\.json$/.test(name)).map(name => json(path.join(output, name)));
      const result = reconcileCi(json(input), reports); save(path.join(output, 'reconciled.json'), result); console.log(JSON.stringify(result));
    } else throw Error('Use plan, a platform target, or reconcile');
  } catch (error) { console.error('CI validation refused: ' + error.message); process.exitCode = 1; }
}
