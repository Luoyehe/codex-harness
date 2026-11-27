import { ordinaryFile, validateAuditRecord } from './audit-rounds.mjs';
export { validateAuditRecord } from './audit-rounds.mjs';
import { withTestReport } from './test-retention.mjs';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, snapshot } from './snapshot.mjs';
import { nativePrerequisite, nativeTestFiles, pythonPrerequisite, runPythonTests, testInventory } from './select-tests.mjs';
import { validateRelative } from './release-audit.mjs';
import { releaseAuthorization } from './release-authorization.mjs';
import { isolatedTestEnvironment, isolateTestProcess } from './test-environment.mjs';
import { goPrerequisite, goTestFile, goTestPattern, runGoTests } from './go-tests.mjs';
import { javascriptTestPattern as jsTest, pythonTestPattern as pyTest, validateTestPath } from './test-paths.mjs';

const nativeNames = new Set(nativeTestFiles);

export function prepareRun(mode, args, base = root) {
  const available = testInventory(base); const all = new Set(available); let files; let auditRounds; let authorization;
  if (mode === '--targeted') {
    if (!args.length) throw new Error('Provide explicit affected test files; an empty selection is not a full-test shortcut');
    files = [...new Set(args.map(validateRelative))].sort();
    for (const name of files) {
      if ((!jsTest.test(name) && !pyTest.test(name) && !goTestPattern.test(name)) || !all.has(name)) throw new Error('Targeted tests require existing exact repository-relative test files');
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
    if (!files.some(name => pyTest.test(name)) || ![...nativeNames].every(name => files.includes(name)) || !files.includes(goTestFile)) throw new Error('Full inventory must include deployment, native and Go regressions');
  } else throw new Error('Use --targeted <files...> or the audited --full mode');
  return { mode, files, ...(auditRounds ? { auditRounds } : {}), ...(authorization ? { authorization } : {}) };
}

export function runVitest(files, base = root, env = isolatedTestEnvironment(base)) {
  const require = createRequire(path.join(base, 'package.json'));
  const entry = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  return withTestReport(base, 'vitest', output => {
    // Positional Vitest filters are substrings. Explicitly exclude all unselected
    // files, so an exact .ts request cannot accidentally also run a .tsx sibling.
    const excludes = testInventory(base).filter(name => jsTest.test(name) && !files.includes(name)).flatMap(name => ['--exclude', name]);
    const child = spawnSync(process.execPath, [entry, 'run', ...files, ...excludes, '--passWithNoTests=false', '--allowOnly=false', '--reporter=default', '--reporter=json', `--outputFile.json=${output}`], { cwd: base, env, stdio: 'inherit', shell: false });
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
  });
}

export function executePlan(plan, base = root, dependencies = {}, env = isolatedTestEnvironment(base)) {
  if (!Array.isArray(plan?.files) || !plan.files.length || new Set(plan.files).size !== plan.files.length) throw Error('Execution requires a nonempty unique test plan');
  for (const name of plan.files) {
    validateTestPath(name);
    if ([jsTest, pyTest, goTestPattern].filter(pattern => pattern.test(name)).length !== 1) throw Error('Unclassified test file in execution plan');
  }
  const js = plan.files.filter(name => jsTest.test(name)); const python = plan.files.filter(name => pyTest.test(name));
  const go = plan.files.filter(name => goTestPattern.test(name));
  const hasNative = js.some(name => nativeNames.has(name)); const prerequisites = [];
  if (hasNative) {
    const native = (dependencies.nativePrerequisite ?? nativePrerequisite)(base, env.HARNESS_TEST_CODEX_BIN, env); prerequisites.push({ group: 'native', ...native });
    if (native.status === 'ready') env.HARNESS_TEST_CODEX_BIN = native.binary;
  }
  if (python.length) prerequisites.push({ group: 'deploy', ...(dependencies.pythonPrerequisite ?? pythonPrerequisite)(env) });
  if (go.length) prerequisites.push({ group: 'go', ...(dependencies.goPrerequisite ?? goPrerequisite)(base, env) });
  if (prerequisites.some(item => item.status !== 'ready')) return { status: prerequisites.some(item => item.status === 'failed') ? 'failed' : 'skipped', exitCode: prerequisites.some(item => item.status === 'failed') ? 1 : 3, prerequisites, results: [] };
  const results = [];
  if (js.length) results.push({ group: 'javascript', ...(dependencies.runVitest ?? runVitest)(js, base, env) });
  if (python.length) results.push({ group: 'deploy', ...(dependencies.runPythonTests ?? runPythonTests)(python, base, env) });
  if (go.length) results.push({ group: 'go', ...(dependencies.runGoTests ?? runGoTests)(go, base, env) });
  const exitCode = results.some(result => result.exitCode === 1) ? 1 : results.some(result => result.exitCode) ? 3 : 0;
  return { status: exitCode === 0 ? 'passed' : exitCode === 3 ? 'skipped' : 'failed', exitCode, prerequisites, results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const env = isolateTestProcess(root);
    const [mode, ...args] = process.argv.slice(2); const plan = prepareRun(mode, args);
    const result = executePlan(plan, root, {}, env); process.stdout.write(JSON.stringify(result, null, 2) + '\n'); process.exitCode = result.exitCode;
  } catch (error) { process.stderr.write(`Tests not started: ${error.message}\n`); process.exitCode = 1; }
}
