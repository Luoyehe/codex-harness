import { afterEach, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gitChanges, nativePrerequisite, nativeTestFiles, runSelection, selectTests } from '../../scripts/select-tests.mjs';

const available = ['tests/core/ledger.test.ts', 'tests/gateway/auth.test.ts', 'tests/runtime/native.test.ts', ...nativeTestFiles, 'tests/deploy/test_deployment.py', 'web/tests/composer.test.tsx', 'tests/tooling/release-audit.test.ts', 'tests/tooling/select-tests.test.ts'];
const fixtures: string[] = [];
function fixture(): string { const parent = path.resolve('.work/tooling-selection'); mkdirSync(parent, { recursive: true }); const root = mkdtempSync(path.join(parent, 'case-')); fixtures.push(root); return root; }
function git(root: string, args: string[]): string { return execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim(); }
afterEach(() => { vi.unstubAllEnvs(); for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('source dependencies, Python deployment, browser and independent native tests stay in explicit groups', () => {
  const plan = selectTests(['src/core/contracts.ts', 'deploy/install.py', 'web/components/Composer.tsx'], available);
  expect(plan.status).toBe('selected'); expect(plan.groups.deploy).toEqual(['tests/deploy/test_deployment.py']);
  expect(plan.groups.native).toEqual([...nativeTestFiles].sort());
  expect(plan.groups.unit).toEqual(['tests/core/ledger.test.ts', 'tests/gateway/auth.test.ts', 'tests/runtime/native.test.ts', 'web/tests/composer.test.tsx']);
});

test('the one-stop shell entry retains deployment and operator journey coverage', () => {
  const operator = 'tests/deploy/test_operator.py';
  const plan = selectTests(['harness.sh'], [...available, operator]);
  expect(plan.status).toBe('selected');
  expect(plan.groups.deploy).toEqual(['tests/deploy/test_deployment.py', operator]);
  expect(plan.requiresFullAudit).toEqual([]);
});

test.each(['control_update'])('%s root ownership fixtures have a separate impact group and retain their unprivileged companions', (module) => {
  const ordinary = `tests/deploy/test_${module}.py`;
  const privileged = `tests/deploy/root/test_${module}.py`;
  const inventory = [...available, ordinary, privileged];
  const deployment = selectTests([`deploy/${module}.py`], inventory);
  expect(deployment.status).toBe('selected');
  expect(deployment.groups.deploy).toEqual([ordinary, 'tests/deploy/test_deployment.py'].sort());
  expect(deployment.groups['deploy-root']).toEqual([privileged]);
  for (const changed of [ordinary, privileged]) {
    const plan = selectTests([changed], inventory);
    expect(plan.groups.deploy).toEqual([ordinary]);
    expect(plan.groups['deploy-root']).toEqual([privileged]);
  }
  expect(selectTests([ordinary], inventory.filter(name => name !== privileged)).requiresFullAudit)
    .toContainEqual({ path: privileged, reason: 'missing-deployment-identity-coverage' });
});

test('proxy core and transaction fixture changes select exactly all four identity companions', () => {
  const ordinary = ['tests/deploy/test_proxy_core.py', 'tests/deploy/test_proxy_transaction.py'];
  const privileged = ['tests/deploy/root/test_proxy_core.py', 'tests/deploy/root/test_proxy_transaction.py'];
  const companions = [...ordinary, ...privileged], inventory = [...available, ...companions];
  for (const changed of companions) {
    const plan = selectTests([changed], inventory);
    expect(plan.status).toBe('selected');
    expect(plan.requiresFullAudit).toEqual([]);
    expect(plan.groups).toEqual({ unit: [], deploy: ordinary, 'deploy-root': privileged, native: [], go: [] });
    expect(plan.mappings).toEqual([{ path: changed, reason: 'changed-test', tests: [...companions].sort() }]);
    for (const missing of companions.filter(name => name !== changed)) {
      const incomplete = selectTests([changed], inventory.filter(name => name !== missing));
      expect(incomplete.status).toBe('requires-full-audit');
      expect(incomplete.requiresFullAudit).toEqual([{ path: missing, reason: 'missing-deployment-identity-coverage' }]);
    }
  }
});

test('project path fixtures retain real native/root filesystem identity coverage', () => {
  const ordinary = 'tests/deploy/test_project_creation.py', privileged = 'tests/deploy/root/test_project_identity.py';
  for (const changed of [ordinary, privileged]) {
    const plan = selectTests([changed], [...available, ordinary, privileged]);
    expect(plan.status).toBe('selected');
    expect(plan.groups).toEqual({ unit: [], deploy: [ordinary], 'deploy-root': [privileged], native: [], go: [] });
    const missing = changed === ordinary ? privileged : ordinary;
    expect(selectTests([changed], [...available, changed]).requiresFullAudit).toEqual([{ path: missing, reason: 'missing-deployment-identity-coverage' }]);
  }
});

test('the privileged group cannot disappear from execution or convert an unavailable interpreter to a pass', () => {
  const root = fixture();
  const ordinary = 'tests/deploy/test_https.py'; const privileged = 'tests/deploy/root/test_https.py';
  const plan = selectTests([privileged], [...available, ordinary, privileged]);
  vi.stubEnv('HARNESS_TEST_PYTHON', path.join(root, 'missing-python'));
  const result = runSelection(plan, 'deploy-root', root);
  expect(result.status).toBe('skipped'); expect(result.exitCode).toBe(3);
  expect(result.results).toContainEqual(expect.objectContaining({ group: 'deploy-root', tests: [privileged], status: 'skipped' }));
});
test('provider layer identity fixtures and workspace recovery companions remain jointly required', () => {
  const providers = ['tests/deploy/test_provider_layers.py', 'tests/deploy/test_provider_gateway.py', 'tests/deploy/test_provider_bedrock.py', 'tests/deploy/root/test_provider_layers.py', 'tests/deploy/root/test_config_layer.py', 'tests/deploy/root/test_provider_extended.py'];
  const workspace = ['tests/deploy/test_workspace.py', 'tests/deploy/test_workspace_recovery.py', 'tests/deploy/test_workspace_worktrees.py', 'tests/deploy/test_workspace_resources.py', 'tests/deploy/test_workspace_commit.py', 'tests/deploy/test_workspace_index.py', 'tests/deploy/test_workspace_search.py'];
  const inventory = [...available, ...providers, ...workspace];
  for (const changed of providers) {
    const plan = selectTests([changed], inventory);
    expect(plan.groups.deploy).toEqual(providers.slice(0, 3).sort());
    expect(plan.groups['deploy-root']).toEqual(providers.slice(3).sort());
  }
  for (const changed of workspace) expect(selectTests([changed], inventory).groups.deploy).toEqual([...workspace].sort());
  expect(selectTests([workspace[0]!], inventory.filter(name => name !== workspace[1])).requiresFullAudit).toContainEqual({ path: workspace[1], reason: 'missing-deployment-identity-coverage' });
});

test('a deleted source still maps to surviving regressions and a deleted test demands review', () => {
  expect(selectTests(['src/runtime/removed-module.ts'], available).groups.native).toHaveLength(nativeTestFiles.length);
  const plan = selectTests(['tests/runtime/removed.test.ts'], available); expect(plan.status).toBe('requires-full-audit'); expect(plan.requiresFullAudit[0].reason).toBe('deleted-test-requires-coverage-review');
});

test('unknown files, absent coverage, dependency metadata and an empty diff cannot silently pass', () => {
  for (const changed of [['new-surface/config.toml'], ['.github/workflows/unmapped.yml'], ['verification/runtime-config.json'], ['verification/hidden.mjs'], ['package.json'], ['pnpm-lock.yaml'], ['web/vite.config.ts'], []]) expect(selectTests(changed, available).status).toBe('requires-full-audit');
  const missing = selectTests(['deploy/install.py'], available.filter(file => !file.endsWith('.py'))); expect(missing.status).toBe('requires-full-audit'); expect(missing.requiresFullAudit[0].reason).toBe('missing-test-coverage');
  expect(runSelection(missing).exitCode).toBe(2);
  expect(selectTests(['src/runtime/service.ts'], available.filter(file => !file.endsWith('native-smoke.test.ts'))).status).toBe('requires-full-audit');
});

test('documentation is explicitly no-behavior-change and is never reported as a test pass', () => {
  const result = runSelection(selectTests(['README.md', 'scripts/RELEASE-PREFLIGHT.md', 'verification/audits.json'], available)); expect(result.status).toBe('no-behavior-change'); expect(result.results).toEqual([]); expect(result.note).toContain('not a test pass');
});

test('preflight dependencies and workflow pins retain the preflight contract regression', () => {
  const name = 'tests/tooling/release-preflight.test.ts', inventory = [...available, name, 'tests/tooling/ci-checks.test.ts'];
  for (const changed of ['scripts/release-preflight.mjs', 'scripts/snapshot.mjs', 'scripts/release-authorization.mjs', 'scripts/ci-checks.mjs', '.github/workflows/affected.yml', '.github/workflows/security.yml', '.github/workflows/compatibility.yml'])
    expect(selectTests([changed], inventory).groups.unit).toContain(name);
});

test('a rename is exposed as an old deletion and new addition without dropping either mapping', () => {
  const root = fixture(); git(root, ['init', '-q']); mkdirSync(path.join(root, 'src/runtime'), { recursive: true }); writeFileSync(path.join(root, 'src/runtime/old.ts'), 'export const value = 1;'); git(root, ['add', '.']); git(root, ['commit', '-qm', 'first']); const base = git(root, ['rev-parse', 'HEAD']);
  renameSync(path.join(root, 'src/runtime/old.ts'), path.join(root, 'src/runtime/new.ts')); git(root, ['add', '-A']); git(root, ['commit', '-qm', 'renamed']); const head = git(root, ['rev-parse', 'HEAD']);
  expect(gitChanges(base, head, root).sort()).toEqual(['src/runtime/new.ts', 'src/runtime/old.ts']); expect(() => gitChanges('0'.repeat(40), head, root)).toThrow();
});

test('missing independent native dependency is an explicit skip with nonzero exit', () => {
  expect(nativePrerequisite(fixture(), '')).toEqual({ status: 'skipped', reason: 'independent-official-cli-path-not-provided', requiredVersion: '0.164.0' });
  expect(nativePrerequisite(fixture(), path.resolve('outside-native-fixture'))).toEqual({ status: 'failed', reason: 'native-binary-must-belong-to-independent-runtime' });
  vi.stubEnv('HARNESS_TEST_CODEX_BIN', '');
  const result = runSelection(selectTests(['src/runtime/service.ts'], available), 'native', fixture()); expect(result.status).toBe('skipped'); expect(result.exitCode).toBe(3);
});

test('a group with no affected tests reports not-affected instead of a passing test result', () => {
  const result = runSelection(selectTests(['deploy/install.py'], available), 'unit'); expect(result.status).toBe('not-affected'); expect(result.results[0].status).toBe('not-affected');
});

test('unioning every affected domain cannot turn targeted orchestration into a full-suite shortcut', () => {
  const plan = selectTests(['src/core/contracts.ts', 'web/App.tsx', 'deploy/install.py', 'scripts/release-audit.mjs'], available); expect(plan.status).toBe('requires-full-audit'); expect(plan.requiresFullAudit.some((entry: { reason: string }) => entry.reason === 'selection-covers-full-inventory')).toBe(true);
});

test('CI entrypoints select exact changes and reconcile real identities without inventing audit rounds', () => {
  const workflow = readFileSync(path.resolve('.github/workflows/affected.yml'), 'utf8');
  expect(workflow).toContain('scripts/ci-checks.mjs'); expect(workflow).toContain('scripts/reviewed-history.mjs');
  expect(workflow).not.toMatch(/(?:vitest[^\n]*\brun|--full|test:full|audits\.json|passWithNoTests)/);
  expect(workflow).toContain('0.164.0'); expect(workflow).toContain('scripts/prepare-ci-native.mjs');
  const rootJob = workflow.split('\n  root_deploy:\n')[1].split('\n  coverage:\n')[0];
  expect(rootJob).toContain('runs-on: ubuntu-24.04');
  expect(rootJob).toContain('test "$RUNNER_ENVIRONMENT" = github-hosted');
  expect(rootJob).toContain('test "$(id -u)" -ne 0');
  expect(rootJob).toContain('test "$source_root" = "$(realpath "$GITHUB_WORKSPACE")"');
  expect(rootJob).toContain('mktemp -d /tmp/harness-ci-root-source.XXXXXX');
  expect(rootJob).toContain('/usr/bin/chown 0:0 "$root_checkout"');
  expect(rootJob).toContain('/usr/bin/chmod 0755 "$root_checkout"');
  expect(rootJob).toContain('git -C "$source_root" archive --format=tar HEAD');
  expect(rootJob).toContain('for entry in .git node_modules dist; do');
  expect(rootJob).toContain('/usr/bin/cp -a --no-preserve=ownership --');
  expect(rootJob).toContain('cd "$root_checkout"');
  expect(rootJob).toContain('/usr/bin/install -m 0644 "$root_checkout/.work/result-linux-root.json" "$source_root/.work/result-linux-root.json"');
  expect(rootJob).not.toContain('safe.directory');
  expect(rootJob).not.toContain('SUDO_UID=');
  expect(rootJob).toContain('/usr/bin/sudo -n -- /usr/bin/env -i');
  expect(rootJob).toContain('HARNESS_TEST_NODE=');
  expect(rootJob).toContain('scripts/ci-checks.mjs linux-root');
  expect(workflow).toContain('reconcile .work/ci-results/ci-plan.json');
  expect(workflow).toContain('if-no-files-found: error');
});
