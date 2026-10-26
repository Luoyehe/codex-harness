import { afterEach, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildCiPlan, isolatedPaths, reconcileCi, selectCiPlan } from '../../scripts/ci-checks.mjs';
import { releaseAuthorization } from '../../scripts/release-authorization.mjs';
import { snapshot } from '../../scripts/snapshot.mjs';
import { nativeTestFiles } from '../../scripts/select-tests.mjs';

const fixtures: string[] = [];
const head = 'a'.repeat(40), digest = 'b'.repeat(64);
const available = ['tests/core/example.test.ts', 'tests/deploy/test_example.py', 'tests/deploy/root/test_example.py', ...nativeTestFiles].sort();
const checksum = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function fixture() {
  mkdirSync('.work/ci-gate-tests', { recursive: true });
  const base = mkdtempSync(path.resolve('.work/ci-gate-tests/case-')); fixtures.push(base);
  execFileSync('git', ['init', '-q'], { cwd: base, windowsHide: true });
  writeFileSync(path.join(base, '.gitignore'), '.work/\n');
  writeFileSync(path.join(base, 'package.json'), JSON.stringify({ version: '2.0.1' }));
  for (const name of available) { const file = path.join(base, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, '// Fixture: never executed.\n'); }
  execFileSync('git', ['add', '.'], { cwd: base, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base'], { cwd: base, windowsHide: true });
  const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: base, encoding: 'utf8', windowsHide: true }).trim();
  return { base, baseCommit };
}
function approve(base: string, baseCommit: string) {
  const current = snapshot(base);
  const value = { schemaVersion: 1, kind: 'explicit-user-release-closeout', auditRoundsWaived: true, sourceDigest: current.digest, sourceFiles: current.files, baseCommit, version: '2.0.1', approvedAt: '2026-01-01T00:00:00Z', userInstruction: 'Fixture explicit instruction to validate the complete reviewed repair and release it.', auditWaiverInstruction: 'Fixture user explicitly waives repeated clean rounds for this specific repair closeout.', repairsReviewed: true, unresolvedBlockers: [], scopes: ['full-tests'] };
  const name = 'verification/audit-evidence/release-closeout/authorization.json';
  mkdirSync(path.dirname(path.join(base, name)), { recursive: true });
  const bytes = JSON.stringify(value); writeFileSync(path.join(base, name), bytes);
  return { value, name, sha256: checksum(bytes) };
}
afterEach(() => { for (const base of fixtures.splice(0)) rmSync(base, { recursive: true, force: true }); });

test.runIf(process.platform !== 'win32')('root fixtures have a traversable disposable temp outside their private home', () => {
  const { base } = fixture(); const paths = isolatedPaths(base, true); fixtures.push(paths.temporary);
  expect(paths.temporary.startsWith(paths.home + path.sep)).toBe(false);
  expect(statSync(paths.temporary).mode & 0o777).toBe(0o755);
  expect(statSync(paths.home).mode & 0o777).toBe(0o700);
});

test('a root-only change does not launch empty standard jobs', () => {
  const plan = selectCiPlan({ changed: ['tests/deploy/root/test_example.py'], available, head, sourceDigest: digest });
  expect(plan.targets).toEqual(['linux-root']); expect(plan.standardFiles).toEqual([]);
});

test('build metadata requires explicit current-source authorization, never an implicit full run', () => {
  expect(() => selectCiPlan({ changed: ['package.json'], available, head, sourceDigest: digest })).toThrow(/complete review/);
  expect(() => selectCiPlan({ changed: ['package.json'], available, head, sourceDigest: digest, authorization: { sourceDigest: 'c'.repeat(64) } })).toThrow();
  const plan = selectCiPlan({ changed: ['package.json'], available, head, sourceDigest: digest, authorization: { sourceDigest: digest } });
  expect(plan.mode).toBe('authorized-full'); expect(plan.files).toEqual(available);
  expect(plan.targets).toEqual(['linux', 'windows', 'linux-root']);
});

test('authorization requires matching bytes, source, version, user instruction and no unresolved blocker', () => {
  const { base, baseCommit } = fixture(); const approval = approve(base, baseCommit);
  expect(releaseAuthorization(base, approval.name, approval.sha256).baseCommit).toBe(baseCommit);
  expect(() => releaseAuthorization(base, approval.name, 'a'.repeat(64))).toThrow(/checksum/);
  for (const mutation of [
    (v: any) => v.unresolvedBlockers.push('unfixed'),
    (v: any) => v.version = '2.0.0',
    (v: any) => v.sourceDigest = '0'.repeat(64),
    (v: any) => v.repairsReviewed = false,
    (v: any) => v.userInstruction = '',
    (v: any) => v.auditRoundsWaived = false,
  ]) {
    const changed = structuredClone(approval.value); mutation(changed); const bytes = JSON.stringify(changed);
    writeFileSync(path.join(base, approval.name), bytes);
    expect(() => releaseAuthorization(base, approval.name, checksum(bytes))).toThrow();
  }
  writeFileSync(path.join(base, approval.name), JSON.stringify(approval.value));
  writeFileSync(path.join(base, 'new-source.ts'), 'export const changed = true;');
  expect(() => releaseAuthorization(base, approval.name, approval.sha256)).toThrow(/source/);
});

test('zero-base new refs require an explicit reviewed ancestor, rather than HEAD~1', () => {
  const { base, baseCommit } = fixture();
  mkdirSync(path.join(base, '.work'), { recursive: true }); const event = path.join(base, '.work/event.json');
  writeFileSync(event, JSON.stringify({ before: '0'.repeat(40) }));
  const env = { GITHUB_EVENT_PATH: event, GITHUB_SHA: baseCommit };
  expect(() => buildCiPlan(base, env)).toThrow(/nonzero/);
  approve(base, baseCommit);
  expect(buildCiPlan(base, env).baseCommit).toBe(baseCommit);
  expect(() => buildCiPlan(base, { ...env, HARNESS_CI_HEAD: 'a'.repeat(40) })).toThrow(/checkout/);
});

test('a PR uses the shared ancestor when its target branch advanced independently', () => {
  const { base, baseCommit } = fixture();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: base, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('switch', '-c', 'advanced-main');
  writeFileSync(path.join(base, 'README.md'), 'Independent target branch update.\n');
  git('add', 'README.md'); git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'advance target');
  const targetHead = git('rev-parse', 'HEAD');
  git('switch', '-c', 'topic', baseCommit);
  writeFileSync(path.join(base, 'tests/core/example.test.ts'), '// Topic branch fixture change.\n');
  git('add', 'tests/core/example.test.ts'); git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'topic change');
  const topicHead = git('rev-parse', 'HEAD');
  mkdirSync(path.join(base, '.work'), { recursive: true }); const event = path.join(base, '.work/event.json');
  writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: targetHead }, head: { sha: topicHead } } }));
  const env = { GITHUB_EVENT_PATH: event, GITHUB_SHA: topicHead };
  const plan = buildCiPlan(base, env);
  expect(plan.baseCommit).toBe(baseCommit); expect(plan.requestedBaseCommit).toBe(targetHead);
  expect(plan.selection.changed).toEqual(['tests/core/example.test.ts']);
  expect(plan.mode).toBe('selected');
  // An explicitly chosen base retains the strict ancestor requirement.
  expect(() => buildCiPlan(base, { ...env, HARNESS_CI_BASE: targetHead })).toThrow();
  expect(() => buildCiPlan(base, { ...env, HARNESS_CI_BASE: 'HEAD~1' })).toThrow(/valid nonzero/);
});

test('coverage reconciles exact per-case platform complements and rejects failures, gaps and stale reports', () => {
  const files = ['tests/runtime/platform.test.ts', 'tests/deploy/root/test_example.py'];
  const plan: any = { head, sourceDigest: digest, files, standardFiles: files.slice(0, 1), rootFiles: files.slice(1), targets: ['linux', 'windows', 'linux-root'] };
  const reports: any[] = plan.targets.map((target: string) => ({ head, sourceDigest: digest, sourceDigestAfter: digest, target, exitCode: target === 'linux-root' ? 0 : 3, files: target === 'linux-root' ? plan.rootFiles : plan.standardFiles, cases: target === 'linux-root' ? [{ id: `${files[1]}::root_case`, file: files[1], status: 'passed' }] : ['linux_case', 'windows_case'].map(name => ({ id: `${files[0]}::${name}`, file: files[0], status: name.startsWith(target) ? 'passed' : 'skipped' })) }));
  expect(reconcileCi(plan, reports)).toMatchObject({ status: 'passed', cases: 3, coverageGaps: [] });
  for (const mutate of [
    (r: any[]) => r.pop(),
    (r: any[]) => r[0].cases[0].status = 'failed',
    (r: any[]) => r[0].cases[0].status = 'skipped',
    (r: any[]) => r[0].sourceDigestAfter = 'c'.repeat(64),
    (r: any[]) => r[0].cases.push(r[0].cases[0]),
    (r: any[]) => r[2].cases = [],
    (r: any[]) => r[0].exitCode = 1,
  ]) { const changed = structuredClone(reports); mutate(changed); expect(() => reconcileCi(plan, changed)).toThrow(); }
});

test('documentation-only CI explicitly reports that no tests ran', () => {
  const plan = selectCiPlan({ changed: ['README.md'], available, head, sourceDigest: digest });
  expect(plan.targets).toEqual([]); expect(reconcileCi(plan, [])).toMatchObject({ status: 'no-behavior-change', cases: 0 });
});

test('hosted root work is scoped and every matrix result is reconciled before the coverage gate passes', () => {
  const workflow = readFileSync('.github/workflows/affected.yml', 'utf8');
  expect(workflow).toContain("branches: ['**']"); expect(workflow).toContain('workflow_dispatch:');
  expect(workflow).toContain('scripts/ci-checks.mjs plan'); expect(workflow).toContain('scripts/ci-checks.mjs reconcile');
  expect(workflow).toContain('test "$RUNNER_ENVIRONMENT" = github-hosted');
  expect(workflow).toContain('/usr/bin/sudo -n -- /usr/bin/env -i');
  expect(workflow).toContain('if: always() && needs.plan.result');
  expect(workflow).not.toContain('pull_request_target:');
});
