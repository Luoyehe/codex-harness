import { afterEach, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { executePlan, prepareRun, validateAuditRecord } from '../../scripts/run-tests.mjs';
import { snapshot } from '../../scripts/snapshot.mjs';
import { nativeTestFiles, runPythonTests } from '../../scripts/select-tests.mjs';
import { goTestFile } from '../../scripts/go-tests.mjs';

const fixtures: string[] = [];
const scopes = ['gateway-core', 'runtime-protocol', 'web-ux', 'deployment-release'];
const files = ['tests/core/example.test.ts', ...nativeTestFiles, 'web/tests/example.test.tsx', 'tests/deploy/test_example.py', 'tests/deploy/root/test_example.py', goTestFile];
const inspected = ['src/core/example.ts', 'src/gateway/example.ts', 'src/runtime/example.ts', 'protocol/example.json', 'web/example.tsx', 'deploy/example.py', 'scripts/example.mjs'];
function put(root: string, name: string, content: string): void { const file = path.join(root, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content); }
function fixture(): string {
  const parent = path.resolve('.work/tooling-gate'); mkdirSync(parent, { recursive: true }); const root = mkdtempSync(path.join(parent, 'case-')); fixtures.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore', windowsHide: true }); put(root, '.gitignore', '.work/\n'); put(root, 'src/core/example.ts', 'export const fixture = 1;\n');
  for (const name of [...files, ...inspected.slice(1)]) put(root, name, '// Unexecuted gate fixture.\n'); return root;
}
function audited(root: string) {
  const current = snapshot(root);
  const rounds = [1, 2, 3].map(sequence => {
    const id = `round-${sequence}`; const reviewerId = `independent-reviewer-${sequence}`; const evidence = `verification/audit-evidence/${id}/${reviewerId}.json`;
    const bytes = JSON.stringify({ schemaVersion: 1, roundId: id, reviewerId, digest: current.digest, complete: true, findings: [], skipped: [], scopes, method: 'Independent fixture review of declared boundary behavior.', inspectedFiles: snapshot(root, true).names });
    put(root, evidence, bytes);
    return { id, sequence, digest: current.digest, complete: true, findings: [], skipped: [], scopes, startedAt: `2026-01-0${sequence}T00:00:00Z`, completedAt: `2026-01-0${sequence}T01:00:00Z`, reviewers: [{ id: reviewerId, scopes, evidence, sha256: createHash('sha256').update(bytes).digest('hex') }] };
  });
  const record = { schemaVersion: 1, rounds }; put(root, 'verification/audits.json', JSON.stringify(record)); return { current, record };
}
afterEach(() => { vi.unstubAllEnvs(); for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('targeted refuses empty, directory, missing, traversal and duplicate-disguised full inventories', () => {
  const root = fixture();
  for (const args of [[], ['tests'], ['tests/missing.test.ts'], ['tests/../src/core/example.ts'], files, [...files, files[0]], files.filter(name => name.endsWith('.ts') || name.endsWith('.tsx'))]) expect(() => prepareRun('--targeted', args, root)).toThrow();
  expect(prepareRun('--targeted', ['tests/core/example.test.ts'], root).files).toEqual(['tests/core/example.test.ts']);
  expect(prepareRun('--targeted', ['tests/deploy/test_example.py'], root).files).toEqual(['tests/deploy/test_example.py']);
  expect(prepareRun('--targeted', ['tests/deploy/root/test_example.py'], root).files).toEqual(['tests/deploy/root/test_example.py']);
});

test('full gate accepts three independently evidenced clean rounds without running any tests', () => {
  const root = fixture(); audited(root); const plan = prepareRun('--full', [], root);
  expect(plan.auditRounds).toEqual(['round-1', 'round-2', 'round-3']); expect(plan.files.sort()).toEqual([...files].sort());
});

test('a source fix resets eligibility and code hidden under verification changes the snapshot', () => {
  const root = fixture(); const { current } = audited(root);
  put(root, 'verification/WORKLOG.md', 'Updated evidence only.'); expect(snapshot(root).digest).toBe(current.digest);
  put(root, 'verification/hidden.mjs', 'export const behavior = 1;'); expect(snapshot(root).digest).not.toBe(current.digest); expect(() => prepareRun('--full', [], root)).toThrow();
  rmSync(path.join(root, 'verification/hidden.mjs')); put(root, 'src/core/example.ts', 'export const fixture = 2;'); expect(() => prepareRun('--full', [], root)).toThrow();
});

test('unclean, incomplete, skipped, missing-scope, reordered and reused-reviewer rounds are rejected', () => {
  const root = fixture(); const { current, record } = audited(root);
  const variants = [
    (value: any) => value.rounds.pop(),
    (value: any) => value.rounds[2].findings.push('new actionable issue'),
    (value: any) => value.rounds[2].complete = false,
    (value: any) => value.rounds[2].skipped.push('unreviewed deployment'),
    (value: any) => value.rounds[2].scopes.pop(),
    (value: any) => value.rounds[2].sequence = 5,
    (value: any) => value.rounds[2].startedAt = value.rounds[0].startedAt,
    (value: any) => value.rounds[2].reviewers[0].id = value.rounds[1].reviewers[0].id,
    (value: any) => value.rounds[2].reviewers[0].scopes = ['gateway-core'],
  ];
  for (const mutate of variants) { const changed = structuredClone(record); mutate(changed); expect(() => validateAuditRecord(changed, current, root)).toThrow(); }
});

test('changed reviewer bytes, absent artifacts and mismatched snapshot evidence are rejected', () => {
  const root = fixture(); const { current, record } = audited(root); const reviewer = record.rounds[2].reviewers[0]; const file = path.join(root, reviewer.evidence); const original = readFileSync(file, 'utf8');
  writeFileSync(file, original + '\n'); expect(() => validateAuditRecord(record, current, root)).toThrow(/checksum/);
  const changed = JSON.parse(original); changed.digest = 'f'.repeat(64); const bytes = JSON.stringify(changed); writeFileSync(file, bytes); reviewer.sha256 = createHash('sha256').update(bytes).digest('hex'); expect(() => validateAuditRecord(record, current, root)).toThrow(/artifact/);
  rmSync(file); expect(() => validateAuditRecord(record, current, root)).toThrow();
});

test('scope names alone cannot substitute for inspecting the claimed source areas', () => {
  const root = fixture(); const { current, record } = audited(root); const reviewer = record.rounds[2].reviewers[0]; const file = path.join(root, reviewer.evidence); const evidence = JSON.parse(readFileSync(file, 'utf8')); evidence.inspectedFiles = ['src/core/example.ts']; const bytes = JSON.stringify(evidence); writeFileSync(file, bytes); reviewer.sha256 = createHash('sha256').update(bytes).digest('hex');
  expect(() => validateAuditRecord(record, current, root)).toThrow(/scope coverage/);
});
test('one source file per scope cannot authorize a partial review as a complete audit', () => {
  const root = fixture(); const { current, record } = audited(root); const reviewer = record.rounds[2].reviewers[0];
  const file = path.join(root, reviewer.evidence), evidence = JSON.parse(readFileSync(file, 'utf8'));
  evidence.inspectedFiles = inspected;
  const bytes = JSON.stringify(evidence); writeFileSync(file, bytes); reviewer.sha256 = createHash('sha256').update(bytes).digest('hex');
  expect(() => validateAuditRecord(record, current, root)).toThrow(/entire source inventory/);
});

test('full execution plan requires all three engines before starting and includes Go', () => {
  const root = fixture(); audited(root); const plan = prepareRun('--full', [], root); const vitest = vi.fn(() => ({ status: 'passed', exitCode: 0 })); const python = vi.fn(() => ({ status: 'passed', exitCode: 0 })); const go = vi.fn(() => ({ status: 'passed', exitCode: 0 }));
  const skipped = executePlan(plan, root, { nativePrerequisite: () => ({ status: 'skipped', reason: 'fixture missing native' }), pythonPrerequisite: () => ({ status: 'ready' }), goPrerequisite: () => ({ status: 'ready' }), runVitest: vitest, runPythonTests: python, runGoTests: go });
  expect(skipped.status).toBe('skipped'); expect(skipped.exitCode).toBe(3); expect(vitest).not.toHaveBeenCalled(); expect(python).not.toHaveBeenCalled();
  const result = executePlan(plan, root, { nativePrerequisite: () => ({ status: 'ready', binary: path.join(root, 'fixture-native') }), pythonPrerequisite: () => ({ status: 'ready' }), goPrerequisite: () => ({ status: 'ready' }), runVitest: vitest, runPythonTests: python, runGoTests: go });
  expect(result.status).toBe('passed'); expect(vitest.mock.calls[0][0]).toEqual(expect.arrayContaining(['tests/runtime/native-smoke.test.ts', 'web/tests/example.test.tsx'])); expect(python.mock.calls[0][0]).toEqual(['tests/deploy/root/test_example.py', 'tests/deploy/test_example.py']);
  expect(go.mock.calls[0][0]).toEqual([goTestFile]);
});

test('an unavailable Python dependency is skipped explicitly, with no tests reported passed', () => {
  const root = fixture(); vi.stubEnv('HARNESS_TEST_PYTHON', path.join(root, 'absent-python'));
  expect(runPythonTests(['tests/deploy/test_example.py'], root)).toMatchObject({ status: 'skipped', exitCode: 3, reason: 'python-interpreter-unavailable' });
});

test('Python collection refuses an empty selected file even when another selected file has tests', () => {
  const root = fixture(); put(root, 'tests/deploy/test_example.py', 'import unittest\nclass Check(unittest.TestCase):\n def test_behavior(self): self.assertEqual(2+2,4)\n'); put(root, 'tests/deploy/test_empty.py', '# no tests\n');
  expect(runPythonTests(['tests/deploy/test_example.py', 'tests/deploy/test_empty.py'], root)).toMatchObject({ status: 'failed', exitCode: 1 });
});

test('a Python platform skip remains a nonzero coverage gap', () => {
  const root = fixture(); put(root, 'tests/deploy/test_example.py', "import unittest\nclass Check(unittest.TestCase):\n @unittest.skip('fixture platform is unavailable')\n def test_behavior(self): pass\n");
  expect(runPythonTests(['tests/deploy/test_example.py'], root)).toMatchObject({ status: 'skipped', exitCode: 3 });
});

test('Python class setup failures and skips preserve each collected case identity', () => {
  for (const [raised, status, exitCode] of [["RuntimeError('broken fixture')", 'failed', 1], ["unittest.SkipTest('unavailable fixture')", 'skipped', 3]] as const) {
    const root = fixture(); put(root, 'tests/deploy/test_example.py', `import unittest\nclass Check(unittest.TestCase):\n @classmethod\n def setUpClass(cls): raise ${raised}\n def test_behavior(self): pass\n`);
    expect(runPythonTests(['tests/deploy/test_example.py'], root)).toMatchObject({ status, exitCode, cases: [{ id: 'tests/deploy/test_example.py::Check.test_behavior', status }] });
  }
});
