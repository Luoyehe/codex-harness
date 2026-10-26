import { spawnSync } from 'node:child_process';
import { readFileSync, lstatSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, snapshot, evidencePath } from './snapshot.mjs';
import { nativePrerequisite, nativeTestFiles, pythonPrerequisite, runPythonTests, testInventory } from './select-tests.mjs';
import { validateRelative } from './release-audit.mjs';
import { releaseAuthorization } from './release-authorization.mjs';

const requiredScopes = ['gateway-core', 'runtime-protocol', 'web-ux', 'deployment-release'];
const scopeAreas = {
  'gateway-core': [/^src\/core\//, /^src\/gateway\//],
  'runtime-protocol': [/^src\/runtime\//, /^protocol\//],
  'web-ux': [/^web\//],
  'deployment-release': [/^deploy\//, /^(?:scripts|\.github)\//],
};
const nativeNames = new Set(nativeTestFiles);
const jsTest = /^(?:tests|web\/tests)\/[A-Za-z0-9_./-]+\.test\.tsx?$/;
const pyTest = /^tests\/deploy\/(?:[A-Za-z0-9_-]+\/)*test_[A-Za-z0-9_-]+\.py$/;
const identity = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const clean = value => Array.isArray(value) && value.length === 0;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));

function ordinaryFile(base, name) {
  validateRelative(name); let current = base; const parts = name.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]); const info = lstatSync(current);
    if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())) throw new Error('Test/evidence path is not an ordinary repository file');
  }
  return current;
}

export function validateAuditRecord(record, current, base = root) {
  if (record?.schemaVersion !== 1 || !Array.isArray(record.rounds) || record.rounds.length < 3) throw new Error('Three recorded audit rounds are required');
  const inventory = snapshot(base, true);
  if (inventory.digest !== current.digest) throw new Error('Source changed while validating audit coverage');
  const expected = new Set(inventory.names);
  const rounds = record.rounds.slice(-3); const ids = new Set(); const reviewers = new Set(); const evidenceFiles = new Set(); let previous;
  for (const round of rounds) {
    if (!identity(round.id) || ids.has(round.id) || !Number.isSafeInteger(round.sequence) || round.sequence < 1 || round.digest !== current.digest || round.complete !== true || !clean(round.findings) || !clean(round.skipped) || !Array.isArray(round.scopes) || !requiredScopes.every(scope => round.scopes.includes(scope))) throw new Error('Each audit must be complete, clean, scoped and bound to the current source');
    if (!timestamp(round.startedAt) || !timestamp(round.completedAt) || Date.parse(round.startedAt) >= Date.parse(round.completedAt) || Date.parse(round.completedAt) > Date.now()) throw new Error('Audit timing evidence is invalid');
    if (previous && (round.sequence !== previous.sequence + 1 || Date.parse(round.startedAt) < Date.parse(previous.completedAt))) throw new Error('Audit rounds must be consecutive and independently completed');
    if (!Array.isArray(round.reviewers) || !round.reviewers.length) throw new Error('Independent reviewer evidence is required');
    const reviewed = new Set(); const inspected = new Set();
    for (const reviewer of round.reviewers) {
      if (!identity(reviewer.id) || reviewers.has(reviewer.id) || !Array.isArray(reviewer.scopes) || !reviewer.scopes.length || reviewer.scopes.some(scope => !requiredScopes.includes(scope))) throw new Error('Reviewer identities must be distinct and scopes explicit');
      if (typeof reviewer.evidence !== 'string' || !/^verification\/audit-evidence\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.json$/.test(reviewer.evidence) || !evidencePath(reviewer.evidence) || evidenceFiles.has(reviewer.evidence) || !/^[a-f0-9]{64}$/.test(reviewer.sha256)) throw new Error('Reviewer evidence requires a unique local JSON artifact and checksum');
      const bytes = readFileSync(ordinaryFile(base, reviewer.evidence));
      if (createHash('sha256').update(bytes).digest('hex') !== reviewer.sha256) throw new Error('Reviewer evidence checksum changed');
      const evidence = JSON.parse(bytes.toString('utf8'));
      if (evidence.schemaVersion !== 1 || evidence.roundId !== round.id || evidence.reviewerId !== reviewer.id || evidence.digest !== current.digest || evidence.complete !== true || !clean(evidence.findings) || !clean(evidence.skipped) || !Array.isArray(evidence.scopes) || reviewer.scopes.some(scope => !evidence.scopes.includes(scope)) || typeof evidence.method !== 'string' || evidence.method.trim().length < 20 || !Array.isArray(evidence.inspectedFiles) || !evidence.inspectedFiles.length) throw new Error('Reviewer artifact does not establish the declared clean audit');
      for (const name of evidence.inspectedFiles) { if (!expected.has(validateRelative(name))) throw new Error('Audit coverage must inspect current source, not its own evidence'); ordinaryFile(base, name); inspected.add(name); }
      for (const scope of reviewer.scopes) if (!scopeAreas[scope].every(area => evidence.inspectedFiles.some(name => area.test(name)))) throw new Error('Reviewer artifact is missing source evidence for its claimed scope coverage');
      reviewer.scopes.forEach(scope => reviewed.add(scope)); reviewers.add(reviewer.id); evidenceFiles.add(reviewer.evidence);
    }
    if (!requiredScopes.every(scope => reviewed.has(scope))) throw new Error('Reviewer evidence does not cover every required scope');
    if ([...expected].some(name => !inspected.has(name))) throw new Error('Complete audits must inspect the entire source inventory, including tests, configuration and documentation');
    ids.add(round.id); previous = round;
  }
  return rounds.map(round => round.id);
}

export function prepareRun(mode, args, base = root) {
  const available = testInventory(base); const all = new Set(available); let files; let auditRounds; let authorization;
  if (mode === '--targeted') {
    if (!args.length) throw new Error('Provide explicit affected test files; an empty selection is not a full-test shortcut');
    files = [...new Set(args.map(validateRelative))].sort();
    for (const name of files) {
      if ((!jsTest.test(name) && !pyTest.test(name)) || !all.has(name)) throw new Error('Targeted tests require existing exact repository-relative test files');
      ordinaryFile(base, name);
    }
    const jsInventory = available.filter(name => jsTest.test(name));
    if (files.length === available.length || (jsInventory.length && jsInventory.every(name => files.includes(name)))) throw new Error('Selecting the complete JavaScript or repository inventory requires the audited --full mode');
  } else if (mode === '--full') {
    if (args.length) {
      if (args.length !== 4 || args[0] !== '--authorization' || args[2] !== '--sha256') throw new Error('Full testing requires an exact authorization file and checksum');
      authorization = releaseAuthorization(base, args[1], args[3]);
    } else {
      const current = snapshot(base);
      const record = JSON.parse(readFileSync(ordinaryFile(base, 'verification/audits.json'), 'utf8'));
      auditRounds = validateAuditRecord(record, current, base);
    }
    files = available;
    if (!files.some(name => pyTest.test(name)) || ![...nativeNames].every(name => files.includes(name))) throw new Error('Full inventory must include deployment and native regressions');
  } else throw new Error('Use --targeted <files...> or the audited --full mode');
  return { mode, files, ...(auditRounds ? { auditRounds } : {}), ...(authorization ? { authorization } : {}) };
}

export function runVitest(files, base = root, env = process.env) {
  const require = createRequire(path.join(base, 'package.json'));
  const entry = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const reports = path.join(base, '.work/test-results'); mkdirSync(reports, { recursive: true });
  const output = path.join(mkdtempSync(path.join(reports, 'run-')), 'vitest.json');
  // Positional Vitest filters are substrings. Explicitly exclude all unselected
  // files, so an exact .ts request cannot accidentally also run a .tsx sibling.
  const excludes = testInventory(base).filter(name => jsTest.test(name) && !files.includes(name)).flatMap(name => ['--exclude', name]);
  const child = spawnSync(process.execPath, [entry, 'run', ...files, ...excludes, '--passWithNoTests=false', '--allowOnly=false', '--reporter=default', '--reporter=json', `--outputFile.json=${output}`], { cwd: base, env, stdio: 'inherit', shell: false, windowsHide: true });
  if (child.error || child.status !== 0) return { status: 'failed', exitCode: 1, tests: files };
  try {
    const report = JSON.parse(readFileSync(output, 'utf8'));
    const executed = new Set(report.testResults.map(result => path.relative(base, result.name).replaceAll('\\', '/')));
    if (report.success !== true || !Number.isSafeInteger(report.numTotalTests) || report.numTotalTests < 1 || report.numFailedTests !== 0 || files.some(name => !executed.has(name)) || [...executed].some(name => !files.includes(name))) throw new Error('Test report did not cover exactly the requested files');
    const cases = report.testResults.flatMap(result => {
      const file = path.relative(base, result.name).replaceAll('\\', '/');
      return result.assertionResults.map(assertion => ({ id: `${file}::${assertion.fullName}`, file, status: assertion.status === 'passed' ? 'passed' : ['pending', 'todo', 'skipped'].includes(assertion.status) ? 'skipped' : 'failed' }));
    });
    if (new Set(cases.map(item => item.id)).size !== cases.length) throw new Error('Duplicate test identities cannot establish complete coverage');
    if (report.numPendingTests || report.numTodoTests || report.testResults.some(result => !result.assertionResults?.length || result.assertionResults.some(assertion => ['pending', 'todo', 'skipped'].includes(assertion.status)))) return { status: 'skipped', exitCode: 3, tests: files, cases };
    if (report.numPassedTests !== report.numTotalTests || report.testResults.some(result => result.assertionResults.some(assertion => assertion.status !== 'passed'))) throw new Error('Test assertions were not all verified as passed');
    return { status: 'passed', exitCode: 0, tests: files, cases };
  } catch { return { status: 'failed', exitCode: 1, tests: files, reason: 'missing-or-invalid-test-evidence' }; }
}

export function executePlan(plan, base = root, dependencies = {}) {
  const js = plan.files.filter(name => jsTest.test(name)); const python = plan.files.filter(name => pyTest.test(name));
  const hasNative = js.some(name => nativeNames.has(name)); const env = { ...process.env }; const prerequisites = [];
  if (hasNative) {
    const native = (dependencies.nativePrerequisite ?? nativePrerequisite)(base); prerequisites.push({ group: 'native', ...native });
    if (native.status === 'ready') env.HARNESS_TEST_CODEX_BIN = native.binary;
  }
  if (python.length) prerequisites.push({ group: 'deploy', ...(dependencies.pythonPrerequisite ?? pythonPrerequisite)() });
  if (prerequisites.some(item => item.status !== 'ready')) return { status: prerequisites.some(item => item.status === 'failed') ? 'failed' : 'skipped', exitCode: prerequisites.some(item => item.status === 'failed') ? 1 : 3, prerequisites, results: [] };
  const results = [];
  if (js.length) results.push({ group: 'javascript', ...(dependencies.runVitest ?? runVitest)(js, base, env) });
  if (python.length) results.push({ group: 'deploy', ...(dependencies.runPythonTests ?? runPythonTests)(python, base) });
  const exitCode = results.some(result => result.exitCode === 1) ? 1 : results.some(result => result.exitCode) ? 3 : 0;
  return { status: exitCode === 0 ? 'passed' : exitCode === 3 ? 'skipped' : 'failed', exitCode, prerequisites, results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, ...args] = process.argv.slice(2); const plan = prepareRun(mode, args);
    const result = executePlan(plan); process.stdout.write(JSON.stringify(result, null, 2) + '\n'); process.exitCode = result.exitCode;
  } catch (error) { process.stderr.write(`Tests not started: ${error.message}\n`); process.exitCode = 1; }
}
