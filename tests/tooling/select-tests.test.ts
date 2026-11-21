import { afterEach, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gitChanges, nativePrerequisite, nativeTestFiles, runSelection, selectTests, testInventory } from '../../scripts/select-tests.mjs';

const available = ['tests/core/ledger.test.ts', 'tests/gateway/auth.test.ts', 'tests/runtime/native.test.ts', ...nativeTestFiles, 'tests/deploy/test_deployment.py', 'web/tests/composer.test.tsx', 'tests/tooling/release-audit.test.ts', 'tests/tooling/select-tests.test.ts'];
const fixtures: string[] = [];
function fixture(): string { const parent = path.resolve('.work/tooling-selection'); mkdirSync(parent, { recursive: true }); const root = mkdtempSync(path.join(parent, 'case-')); fixtures.push(root); return root; }
function git(root: string, args: string[]): string { return execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim(); }
afterEach(() => { vi.unstubAllEnvs(); for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('shared transport, media and form changes select their browser, gateway and runtime consumers', () => {
  const inventory = testInventory();
  for (const [file, expected] of [
    ['src/shared/mcp-timeouts.ts', ['tests/runtime/mcp.test.ts', 'tests/runtime/mcp-native.test.ts', 'tests/runtime/native.test.ts', 'tests/gateway/worker-client.test.ts', 'web/tests/operations.test.ts']],
    ['tests/runtime/history-window-fixture.ts', ['tests/runtime/history-references.test.ts', 'web/tests/conversation-recovery.test.tsx']],
    ['src/shared/form-formats.ts', ['web/tests/prompts.test.tsx', 'tests/runtime/service.test.ts']],
    ['src/core/attachment-media.ts', ['web/tests/attachments.test.tsx', 'tests/runtime/visual-routing-native.test.ts']],
  ] as const) {
    const plan = selectTests([file], inventory);
    expect(plan.status).toBe('selected');
    expect(Object.values(plan.groups).flat()).toEqual(expect.arrayContaining([...expected]));
    expect(selectTests([file], inventory.filter(name => name !== expected[0])).requiresFullAudit)
      .toContainEqual({ path: expected[0], reason: 'missing-shared-consumer' });
  }
});

test('source dependencies, Python deployment, browser and independent native tests stay in explicit groups', () => {
  const plan = selectTests(['src/core/contracts.ts', 'deploy/install.py', 'web/components/Composer.tsx'], available);
  expect(plan.status).toBe('selected'); expect(plan.groups.deploy).toEqual(['tests/deploy/test_deployment.py']);
  expect(plan.groups.native).toEqual([...nativeTestFiles].sort());
  expect(plan.groups.unit).toEqual(['tests/core/ledger.test.ts', 'tests/gateway/auth.test.ts', 'tests/runtime/native.test.ts', 'web/tests/composer.test.tsx']);
});

test('the one-stop shell entry retains deployment and operator journey coverage', () => {
  const operator = 'tests/deploy/test_operator.py';
  const recovery = 'tests/deploy/root/test_v240_deploy_recovery.py';
  const plan = selectTests(['harness.sh'], [...available, operator, recovery]);
  expect(plan.groups['deploy-root']).toEqual([recovery]);
  expect(plan.status).toBe('selected');
  expect(plan.groups.deploy).toEqual(['tests/deploy/test_deployment.py', operator]);
  expect(plan.requiresFullAudit).toEqual([]);
});

test('the dependency audit and its workflow retain checks of the installed parser and deployment lock', () => {
  const required = ['tests/tooling/picomatch-patch.test.ts', 'tests/tooling/dependency-audit.test.ts', 'tests/deploy/test_dependency_lock.py', 'tests/deploy/test_dependency_patch.py', 'tests/deploy/test_deployment.py', 'tests/deploy/test_source_pack.py'];
  for (const input of ['patches/picomatch@4.0.7.patch', 'deploy/dependency_patch_contract.py', 'scripts/picomatch-patch-proof.mjs', 'scripts/dependency-audit.mjs', '.github/workflows/security.yml']) {
    const plan = selectTests([input], [...available, ...required]);
    expect(plan.groups.unit).toEqual(expect.arrayContaining(required.slice(0, 2)));
    expect(plan.groups.deploy).toEqual(expect.arrayContaining(required.slice(2)));
    expect(selectTests([input], available).requiresFullAudit).toContainEqual({ path: required[0], reason: 'missing-patch-regression' });
  }
});

test.each(['tests/runtime/mcp-oauth-fixture.mjs', 'tests/runtime/native-fixture.mjs'])('shared runtime helper %s retains runtime and gateway consumers', changed => {
  const gateway = 'tests/gateway/mcp-oauth.test.ts';
  const inventory = [...available, gateway];
  const plan = selectTests([changed], inventory);
  const unit = ['tests/gateway/auth.test.ts', gateway, 'tests/runtime/native.test.ts'].sort();
  const native = [...nativeTestFiles].sort();
  expect(plan.status).toBe('selected');
  expect(plan.requiresFullAudit).toEqual([]);
  expect(plan.groups).toEqual({ unit, native, deploy: [], 'deploy-root': [], go: [] });
  expect(plan.mappings).toEqual([{ path: changed, reason: 'runtime-fixture', tests: [...unit, ...native].sort() }]);
  expect(selectTests(['tests/runtime/native.test.ts'], inventory).groups.unit).toEqual(['tests/runtime/native.test.ts']);
  expect(selectTests(['tests/runtime/README.md'], inventory).noBehaviorChange).toEqual([{ path: 'tests/runtime/README.md', reason: 'documentation-or-audit-evidence-only' }]);
});

test('builtin MCP contract/checker changes retain offline vision and both managed credential render paths', () => {
  const required = ['tests/tooling/builtin-mcp.test.ts', 'tests/tooling/vision-compat.test.ts', 'tests/deploy/test_provider_registry.py', 'tests/deploy/root/test_provider_extended.py'];
  for (const changed of ['scripts/check-builtin-mcp.mjs', 'reference/BUILTIN-MCP-CONTRACT.json', 'tests/deploy/vision_stdio_probe.mjs']) {
    const auditConsumers = changed === 'tests/deploy/vision_stdio_probe.mjs' ? [] : ['tests/tooling/run-tests.test.ts', 'tests/tooling/ci-checks.test.ts',
      'tests/tooling/release-preflight.test.ts', 'tests/tooling/publish-release.test.ts'];
    const plan = selectTests([changed], [...available, ...required, ...auditConsumers]);
    expect(plan.status).toBe('selected');
    expect(plan.groups.unit).toEqual([...required.slice(0, 2), ...auditConsumers].sort());
    for (const omitted of auditConsumers)
      expect(selectTests([changed], [...available, ...required, ...auditConsumers.filter(file => file !== omitted)]).requiresFullAudit)
        .toContainEqual({ path: omitted, reason: 'missing-release-authority-regression' });
    expect(plan.groups.deploy).toEqual([required[2]]); expect(plan.groups['deploy-root']).toEqual([required[3]]);
    for (const missing of required) expect(selectTests([changed], [...available, ...required.filter(name => name !== missing)]).requiresFullAudit)
      .toContainEqual({ path: missing, reason: 'missing-builtin-mcp-coverage' });
  }
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

test('proxy identity companions and overlapping configuration fixtures are all selected', () => {
  const ordinary = ['tests/deploy/test_proxy_core.py', 'tests/deploy/test_proxy_transaction.py'];
  const privileged = ['tests/deploy/root/test_proxy_core.py', 'tests/deploy/root/test_proxy_transaction.py'];
  const configRoots = ['tests/deploy/root/test_config_layer.py', 'tests/deploy/root/test_execution_mode.py'];
  const companions = [...ordinary, ...privileged], inventory = [...available, ...companions, ...configRoots];
  for (const changed of companions) {
    const expectedRoots = changed.endsWith('/root/test_proxy_transaction.py') ? [...privileged, ...configRoots].sort() : privileged;
    const required = [...ordinary, ...expectedRoots].sort();
    const plan = selectTests([changed], inventory);
    expect(plan.status).toBe('selected');
    expect(plan.requiresFullAudit).toEqual([]);
    expect(plan.groups).toEqual({ unit: [], deploy: ordinary, 'deploy-root': expectedRoots, native: [], go: [] });
    expect(plan.mappings).toEqual([{ path: changed, reason: 'changed-test', tests: required }]);
    for (const missing of required.filter(name => name !== changed)) {
      const incomplete = selectTests([changed], inventory.filter(name => name !== missing));
      expect(incomplete.status).toBe('requires-full-audit');
      expect(incomplete.requiresFullAudit).toEqual([{ path: missing, reason: 'missing-deployment-identity-coverage' }]);
    }
  }
});

test('pinned toolchain changes retain ordinary, root and composed durability coverage', () => {
  const ordinary = 'tests/deploy/test_toolchain.py';
  const privileged = ['tests/deploy/root/test_toolchain.py', 'tests/deploy/root/test_tree_durability.py'];
  const companions = [ordinary, ...privileged], inventory = [...available, ...companions];
  for (const changed of companions) {
    const plan = selectTests([changed], inventory);
    expect(plan.status).toBe('selected');
    expect(plan.groups).toEqual({ unit: [], deploy: [ordinary], 'deploy-root': privileged, native: [], go: [] });
    for (const missing of companions.filter(name => name !== changed)) {
      expect(selectTests([changed], inventory.filter(name => name !== missing)).requiresFullAudit)
        .toEqual([{ path: missing, reason: 'missing-deployment-identity-coverage' }]);
    }
  }
  for (const changed of ['deploy/build.py', 'deploy/system.py']) {
    const plan = selectTests([changed], inventory);
    expect(plan.status).toBe('selected');
    expect(plan.groups.deploy).toContain(ordinary);
    expect(plan.groups['deploy-root']).toEqual(privileged);
    for (const missing of companions) {
      expect(selectTests([changed], inventory.filter(name => name !== missing)).requiresFullAudit)
        .toContainEqual({ path: missing, reason: 'missing-deployment-identity-coverage' });
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

test('installation fixture changes retain composed account recovery and release reuse coverage', () => {
  const ordinary = 'tests/deploy/test_install_recovery.py';
  const privileged = ['tests/deploy/root/test_account_recovery.py', 'tests/deploy/root/test_release_reuse.py'];
  const companions = [ordinary, ...privileged], inventory = [...available, ...companions];
  for (const changed of companions) {
    const plan = selectTests([changed], inventory);
    expect(plan.status).toBe('selected');
    expect(plan.requiresFullAudit).toEqual([]);
    expect(plan.groups).toEqual({ unit: [], deploy: [ordinary], 'deploy-root': privileged, native: [], go: [] });
    expect(plan.mappings).toEqual([{ path: changed, reason: 'changed-test', tests: [...companions].sort() }]);
    for (const missing of companions.filter(name => name !== changed)) {
      const incomplete = selectTests([changed], inventory.filter(name => name !== missing));
      expect(incomplete.status).toBe('requires-full-audit');
      expect(incomplete.requiresFullAudit).toEqual([{ path: missing, reason: 'missing-deployment-identity-coverage' }]);
    }
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
  const workspace = ['tests/deploy/test_workspace.py', 'tests/deploy/test_workspace_recovery.py', 'tests/deploy/test_workspace_worktrees.py', 'tests/deploy/test_workspace_resources.py', 'tests/deploy/test_workspace_commit.py', 'tests/deploy/test_workspace_index.py', 'tests/deploy/test_workspace_search.py', 'tests/deploy/test_repository_identity.py'];
  const configRoots = ['tests/deploy/root/test_execution_mode.py', 'tests/deploy/root/test_proxy_transaction.py'];
  const inventory = [...available, ...providers, ...workspace, ...configRoots];
  for (const changed of providers) {
    const plan = selectTests([changed], inventory);
    expect(plan.groups.deploy).toEqual(providers.slice(0, 3).sort());
    const extra = changed.endsWith('/root/test_config_layer.py') ? configRoots : [];
    expect(plan.groups['deploy-root']).toEqual([...providers.slice(3), ...extra].sort());
  }
  for (const changed of workspace) expect(selectTests([changed], inventory).groups.deploy).toEqual([...workspace].sort());
  expect(selectTests([workspace[0]!], inventory.filter(name => name !== workspace[1])).requiresFullAudit).toContainEqual({ path: workspace[1], reason: 'missing-deployment-identity-coverage' });
});

test('a deleted source still maps to surviving regressions and a deleted test demands review', () => {
  expect(selectTests(['src/runtime/removed-module.ts'], available).groups.native).toHaveLength(nativeTestFiles.length);
  const plan = selectTests(['tests/runtime/removed.test.ts'], available); expect(plan.status).toBe('requires-full-audit'); expect(plan.requiresFullAudit[0]?.reason).toBe('deleted-test-requires-coverage-review');
});

test('unknown files, absent coverage, dependency metadata and an empty diff cannot silently pass', () => {
  for (const changed of [['new-surface/config.toml'], ['.github/workflows/unmapped.yml'], ['verification/runtime-config.json'], ['verification/hidden.mjs'], ['package.json'], ['pnpm-lock.yaml'], ['web/vite.config.ts'], []]) expect(selectTests(changed, available).status).toBe('requires-full-audit');
  const missing = selectTests(['deploy/install.py'], available.filter(file => !file.endsWith('.py'))); expect(missing.status).toBe('requires-full-audit'); expect(missing.requiresFullAudit[0]?.reason).toBe('missing-test-coverage');
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
  expect(nativePrerequisite(fixture(), '')).toEqual({ status: 'skipped', reason: 'independent-official-cli-path-not-provided', requiredVersion: '0.169.0' });
  expect(nativePrerequisite(fixture(), path.resolve('outside-native-fixture'))).toEqual({ status: 'failed', reason: 'native-binary-must-belong-to-independent-runtime' });
  vi.stubEnv('HARNESS_TEST_CODEX_BIN', '');
  const result = runSelection(selectTests(['src/runtime/service.ts'], testInventory()), 'native', fixture()); expect(result.status).toBe('skipped'); expect(result.exitCode).toBe(3);
});

test('a group with no affected tests reports not-affected instead of a passing test result', () => {
  const result = runSelection(selectTests(['deploy/install.py'], available), 'unit'); expect(result.status).toBe('not-affected'); expect(result.results[0].status).toBe('not-affected');
});

test('unioning every affected domain cannot turn targeted orchestration into a full-suite shortcut', () => {
  const plan = selectTests(['src/core/contracts.ts', 'web/App.tsx', 'deploy/install.py', 'scripts/release-audit.mjs'], available); expect(plan.status).toBe('requires-full-audit'); expect(plan.requiresFullAudit.some((entry: { reason: string }) => entry.reason === 'selection-covers-full-inventory')).toBe(true);
});

test('CI entrypoints select exact changes and reconcile real identities without inventing audit rounds', () => {
  const workflow = readFileSync(path.resolve('.github/workflows/affected.yml'), 'utf8').replaceAll('\r\n', '\n');
  expect(workflow).toContain('scripts/ci-checks.mjs'); expect(workflow).toContain('scripts/reviewed-history.mjs');
  expect(workflow).not.toMatch(/(?:vitest[^\n]*\brun|--full|test:full|audits\.json|passWithNoTests)/);
  expect(workflow).toContain('0.169.0'); expect(workflow).toContain('scripts/prepare-ci-native.mjs');
  const rootSection = workflow.split('\n  root_deploy:\n')[1];
  if (!rootSection) throw new Error('Missing root_deploy job');
  const rootJob = rootSection.split('\n  coverage:\n')[0]!;
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
  expect(rootJob).toContain('test_mcp_native_configuration.py');
  expect(rootJob).toContain('console.log(prepareCiNative())');
  expect(rootJob).toContain('HARNESS_TEST_CODEX_BIN="$root_native"');
  expect(rootJob).toContain('/usr/bin/install -m 0644 "$root_checkout/.work/result-linux-root.json" "$source_root/.work/result-linux-root.json"');
  expect(rootJob).not.toContain('safe.directory');
  expect(rootJob).not.toContain('SUDO_UID=');
  expect(rootJob).toContain('/usr/bin/sudo -n -- /usr/bin/env -i');
  expect(rootJob).toContain('HARNESS_TEST_NODE=');
  expect(rootJob).toContain('scripts/ci-checks.mjs linux-root');
  expect(workflow).toContain('reconcile .work/ci-results/ci-plan.json');
  expect(workflow).toContain('if-no-files-found: error');
});

test('requires the specific deployment recovery, workspace acknowledgement and MCP override regressions', () => {
  const recovery = 'tests/deploy/root/test_v240_deploy_recovery.py';
  const ack = 'tests/deploy/test_workspace_ack.py';
  const privilegedMcp = 'tests/deploy/root/test_mcp_native_configuration.py';
  const overrides = ['tests/deploy/test_mcp_enabled_override.py', privilegedMcp, 'tests/runtime/mcp-configuration.test.ts', 'tests/runtime/mcp-native.test.ts'];
  const inventory = [...available, recovery, ack, ...overrides, 'tests/tooling/other.test.ts'];
  expect(selectTests(['tests/fixtures/mcp-system-native.mjs'], inventory).groups['deploy-root']).toContain(privilegedMcp);
  expect(selectTests(['tests/fixtures/native-env.ts'], inventory).groups.native).toEqual([...nativeTestFiles].sort());
  expect(selectTests(['tests/fixtures/native-env.ts'], inventory).groups['deploy-root']).toContain(privilegedMcp);
  expect(selectTests(['scripts/prepare-ci-native.mjs'], inventory).groups['deploy-root']).toContain(privilegedMcp);
  const actual = testInventory();
  for (const source of ['deploy/thread_history.py', 'src/runtime/thread-history-compatibility.ts',
      'src/runtime/queue-reply-identity.ts', 'src/runtime/queue-image-bindings.ts', 'src/runtime/native-media-event.ts']) {
    if (source.endsWith('native-media-event.ts')) expect(selectTests([source], actual).groups.unit).toContain('web/tests/conversation-recovery.test.tsx');
    const queueTest = 'tests/runtime/queue-handoff-native.test.ts';
    expect(selectTests([source], actual).groups.native).toContain(queueTest);
    expect(selectTests([source], actual).groups.deploy).toContain('tests/deploy/test_thread_history.py');
    expect(selectTests([source], actual.filter(name => name !== queueTest)).requiresFullAudit)
      .toContainEqual({ path: queueTest, reason: 'missing-deployment-identity-coverage' });
  }
  for (const name of ['https', 'units', 'dns_archive', 'dns_caddy_build', 'sudo_publish', 'service_proxy', 'diagnostic_secrets', 'harness']) {
    const source = name === 'harness' ? 'harness.sh' : 'deploy/'+name+'.py';
    expect(selectTests([source], inventory).groups['deploy-root']).toContain(recovery);
    expect(selectTests([source], inventory.filter(path => path !== recovery)).requiresFullAudit).toContainEqual({ path:recovery, reason:'missing-deployment-identity-coverage' });
  }
  for (const [source, required] of [['deploy/workspace_store.py',[ack]], ['deploy/mcp_enabled_override.py',overrides],
    ['src/runtime/mcp-configuration.ts',overrides], ['src/runtime/service.ts',overrides]] as const) {
    const plan = selectTests([source], inventory);
    expect(Object.values(plan.groups).flat()).toEqual(expect.arrayContaining([...required]));
    for (const path of required) expect(selectTests([source],inventory.filter(item => item !== path)).requiresFullAudit)
      .toContainEqual({ path, reason:'missing-deployment-identity-coverage' });
  }
});

test('MCP form, native editor and installed helper changes select each side of the save', () => {
  const inventory = testInventory();
  const required = ['web/tests/mcp-ui.test.tsx', 'tests/runtime/extensions-native.test.ts',
    'tests/deploy/root/test_mcp_native_configuration.py', 'tests/deploy/test_mcp_user_toml.py',
    'tests/deploy/test_mcp_user_config.py'];
  for (const source of ['web/components/McpConfiguration.tsx', 'src/runtime/mcp-configuration.ts',
    'deploy/mcp_user_config.py', 'deploy/mcp_user_toml.py', 'deploy/_tomli/_parser.py']) {
    const plan = selectTests([source], inventory);
    expect(plan.status).toBe('selected');
    expect(Object.values(plan.groups).flat()).toEqual(expect.arrayContaining(required));
    const absent = required[0]!;
    expect(selectTests([source], inventory.filter(name => name !== absent)).requiresFullAudit)
      .toContainEqual({ path: absent, reason: 'missing-mcp-edit-consumer' });
  }
});

test('selects all actual Python importers, including transitive dependencies across ordinary and root jobs', () => {
  const inventory = testInventory();
  const binary = process.env.HARNESS_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const graph = JSON.parse(execFileSync(binary,['scripts/deploy-test-imports.py','.'], {encoding:'utf8'})) as Record<string,string[]>;
  const ordinary='tests/deploy/', privileged=ordinary+'root/';
  expect(graph[ordinary+'test_control_update.py']).toContain(privileged+'test_config_layer.py');
  for (const [source, adjacent] of Object.entries(graph)) {
    const imports = new Set(adjacent);
    for (const relative of imports) for (const further of graph[relative] ?? []) imports.add(further);
    const plan = selectTests([source], inventory);
    expect([...plan.groups.deploy,...plan.groups['deploy-root']]).toEqual(expect.arrayContaining([...imports]));
  }
  const deep=selectTests([ordinary+'test_control_update.py'], inventory);
  expect(deep.groups['deploy-root']).toEqual(expect.arrayContaining(['test_candidate_archive.py','test_execution_mode.py','test_proxy_transaction.py'].map(name=>privileged+name)));
  const tooling = selectTests(['deploy/build_tool.mjs'], inventory);
  expect([...tooling.groups.unit,...tooling.groups.deploy]).toEqual(expect.arrayContaining(['tests/runtime/entrypoint.test.ts','tests/tooling/audit-remediation.test.ts','tests/deploy/test_control_update.py']));
});

test('derives deployment impact from nested and relative Python imports without executing test code', () => {
  const root = fixture();
  const dir = path.join(root,'tests/deploy/root'); mkdirSync(dir,{recursive:true});
  writeFileSync(path.join(root,'tests/deploy/test_shared.py'),"raise Exception('AST fixtures must never run')\n");
  writeFileSync(path.join(dir,'test_child.py'),"def fixture():\n from .. import test_shared as shared\n");
  writeFileSync(path.join(dir,'test_grandchild.py'),"from .test_child import (\n fixture as common,\n)\n");
  const binary = process.env.HARNESS_TEST_PYTHON || (process.platform==='win32'?'python':'python3');
  const graph=JSON.parse(execFileSync(binary,['scripts/deploy-test-imports.py',root],{encoding:'utf8'}));
  expect(graph).toEqual({'tests/deploy/test_shared.py':['tests/deploy/root/test_child.py'],
    'tests/deploy/root/test_child.py':['tests/deploy/root/test_grandchild.py']});
});

test('includes real worker, scheduler and browser consumers of automation approvals', () => {
  const inventory = testInventory();
  const required = ['tests/gateway/automation-scheduler.test.ts', 'tests/runtime/service.test.ts', 'tests/runtime/automation-native.test.ts',
    'tests/runtime/approval-native.test.ts', 'web/tests/automations.test.tsx', 'web/tests/prompts.test.tsx'];
  for (const source of ['src/core/automations.ts', 'src/gateway/automation-scheduler.ts', 'src/runtime/service.ts']) {
    expect(Object.values(selectTests([source], inventory).groups).flat()).toEqual(expect.arrayContaining(required));
    expect(selectTests([source], inventory.filter(path => path !== required[2])).requiresFullAudit)
      .toContainEqual({ path: required[2], reason: 'missing-automation-approval-consumer' });
  }
});
