import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRelative } from './release-audit.mjs';
import { evidencePath } from './snapshot.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const nativeTestFiles = ['tests/runtime/native-smoke.test.ts', 'tests/runtime/gateway-native.test.ts', 'tests/runtime/approval-native.test.ts', 'tests/runtime/workflows-native.test.ts', 'tests/runtime/extensions-native.test.ts', 'tests/runtime/mcp-native.test.ts', 'tests/runtime/organization-native.test.ts', 'tests/runtime/automation-native.test.ts', 'tests/runtime/process-native.test.ts', 'tests/runtime/input-native.test.ts', 'tests/runtime/remote-native.test.ts', 'tests/runtime/guardian-native.test.ts', 'tests/runtime/gateway-oauth-native.test.ts', 'tests/runtime/cli-diagnostics-native.test.ts'];
const nativeNames = new Set(nativeTestFiles);
const testPattern = /^(?:tests|web\/tests)\/.+\.test\.tsx?$/;
const pythonPattern = /^tests\/deploy\/(?:[^/]+\/)*test_[^/]+\.py$/;
const deploymentPairs = [
  ['tests/deploy/test_control_update.py', 'tests/deploy/root/test_control_update.py'],
  ['tests/deploy/test_https.py', 'tests/deploy/root/test_https.py'],
  ['tests/deploy/test_install_recovery.py', 'tests/deploy/root/test_release_reuse.py'],
  ['tests/deploy/test_management_boundaries.py', 'tests/deploy/root/test_management_boundaries.py'],
  ['tests/deploy/test_request_spool.py', 'tests/deploy/root/test_request_spool.py'],
  ['tests/deploy/test_provider_layers.py', 'tests/deploy/test_provider_gateway.py', 'tests/deploy/test_provider_bedrock.py', 'tests/deploy/root/test_provider_layers.py', 'tests/deploy/root/test_config_layer.py', 'tests/deploy/root/test_provider_extended.py'],
  ['tests/deploy/test_workspace.py', 'tests/deploy/test_workspace_recovery.py', 'tests/deploy/test_workspace_worktrees.py', 'tests/deploy/test_workspace_resources.py', 'tests/deploy/test_workspace_commit.py', 'tests/deploy/test_workspace_index.py', 'tests/deploy/test_workspace_search.py'],
];
const auditMetadata = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'vitest.config.ts', 'tsconfig.server.json', 'web/tsconfig.json', 'web/vite.config.ts', 'reference/PROVENANCE.json']);
const documentation = new Set(['README.md', 'LICENSE', 'NOTICE.md', 'AGENTS.md', 'ARCHITECTURE.md', 'FEATURES.md', 'PROBLEM-ACCEPTANCE.md', 'deploy/README.md', 'tests/runtime/README.md', 'reference/PROTOCOL-CONTRACT.md']);

export function testInventory(base = root) {
  const names = [];
  function visit(folder) {
    if (!existsSync(path.join(base, folder))) return;
    for (const entry of readdirSync(path.join(base, folder), { withFileTypes: true })) {
      const name = `${folder}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('Symlink test inventory is unsupported');
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile() && (testPattern.test(name) || pythonPattern.test(name))) names.push(name);
    }
  }
  visit('tests'); visit('web/tests'); return names.sort();
}

export function selectTests(changed, available) {
  const plan = { status: 'selected', changed: [], groups: { unit: [], deploy: [], 'deploy-root': [], native: [] }, mappings: [], requiresFullAudit: [], noBehaviorChange: [], checks: ['typecheck', 'build', 'source-security'] };
  const inventory = new Set(available.map(validateRelative));
  const selected = new Set();
  const domain = prefix => [...inventory].filter(name => name.startsWith(prefix));
  function add(name, candidates, reason) {
    const found = [...new Set(candidates)].filter(candidate => inventory.has(candidate));
    if (!found.length) plan.requiresFullAudit.push({ path: name, reason: 'missing-test-coverage' });
    else { found.forEach(file => selected.add(file)); plan.mappings.push({ path: name, reason, tests: found.sort() }); }
  }
  for (const name of [...new Set(changed.map(validateRelative))].sort()) {
    plan.changed.push(name);
    if (auditMetadata.has(name)) plan.requiresFullAudit.push({ path: name, reason: 'shared-build-or-dependency-metadata' });
    else if (testPattern.test(name) || pythonPattern.test(name)) {
      if (inventory.has(name)) {
        const related = deploymentPairs.find(pair => pair.includes(name)) ?? [name];
        for (const required of related) if (!inventory.has(required)) plan.requiresFullAudit.push({ path: required, reason: 'missing-deployment-identity-coverage' });
        add(name, related, 'changed-test');
      }
      // Deleting a test must not silently remove its coverage obligation.
      else plan.requiresFullAudit.push({ path: name, reason: 'deleted-test-requires-coverage-review' });
    } else if (name.startsWith('src/core/')) add(name, [...domain('tests/core/'), ...domain('tests/gateway/'), ...domain('tests/runtime/')], 'shared-server-core');
    else if (name.startsWith('src/gateway/')) add(name, [...domain('tests/gateway/'), 'tests/runtime/gateway-native.test.ts', ...(name.endsWith('/manager-client.ts') ? domain('tests/deploy/') : [])], 'gateway-boundary');
    else if (name.startsWith('src/runtime/') || name.startsWith('protocol/')) add(name, [...domain('tests/runtime/'), ...domain('tests/gateway/')], 'runtime-protocol-boundary');
    else if (name.startsWith('deploy/')) {
      if (documentation.has(name)) plan.noBehaviorChange.push({ path: name, reason: 'documentation-only' });
      else add(name, domain('tests/deploy/'), 'deployment-python');
    } else if (name.startsWith('tests/deploy/')) {
      // Privileged integration helpers have no safe automatic local substitute.
      plan.requiresFullAudit.push({ path: name, reason: 'deployment-integration-helper-needs-isolated-review' });
    } else if (name.startsWith('web/')) add(name, domain('web/tests/'), 'browser-behavior-and-shared-ui');
    else if (name.startsWith('tests/runtime/') && !documentation.has(name)) add(name, domain('tests/runtime/'), 'runtime-fixture');
    else if (name === 'scripts/release-audit.mjs') add(name, ['tests/tooling/release-audit.test.ts', 'tests/tooling/select-tests.test.ts', 'tests/tooling/run-tests.test.ts'], 'release-scanner-and-dependent-gates');
    else if (name === 'scripts/select-tests.mjs') add(name, ['tests/tooling/select-tests.test.ts', 'tests/tooling/run-tests.test.ts'], 'affected-test-selection-and-runner');
    else if (['scripts/run-tests.mjs', 'scripts/release-authorization.mjs', 'scripts/python-tests.py', 'scripts/ci-checks.mjs', 'scripts/prepare-ci-native.mjs'].includes(name)) add(name, ['tests/tooling/run-tests.test.ts', 'tests/tooling/ci-checks.test.ts', 'tests/tooling/prepare-ci-native.test.ts'], 'test-execution-and-release-gates');
    else if (name === 'scripts/snapshot.mjs') add(name, ['tests/tooling/run-tests.test.ts', 'tests/tooling/select-tests.test.ts'], 'source-snapshot-and-evidence-classification');
    else if (['.github/workflows/affected.yml', '.github/workflows/security.yml', '.github/workflows/compatibility.yml', 'scripts/compatibility-watch.mjs'].includes(name)) add(name, ['tests/tooling/select-tests.test.ts', 'tests/tooling/ci-checks.test.ts', 'tests/tooling/compatibility-watch.test.ts', 'tests/tooling/release-audit.test.ts', ...domain('tests/deploy/')], 'ci-orchestration-and-deployment-identities');
    else if (name === '.gitignore' || name === '.gitattributes') add(name, ['tests/tooling/release-audit.test.ts', 'tests/tooling/select-tests.test.ts', 'tests/tooling/run-tests.test.ts'], 'source-inventory-policy');
    else if (documentation.has(name) || evidencePath(name)) plan.noBehaviorChange.push({ path: name, reason: 'documentation-or-audit-evidence-only' });
    else plan.requiresFullAudit.push({ path: name, reason: 'unknown-change-mapping' });
  }
  for (const name of [...selected].sort()) {
    if (nativeNames.has(name)) plan.groups.native.push(name);
    else if (pythonPattern.test(name)) plan.groups[name.startsWith('tests/deploy/root/') ? 'deploy-root' : 'deploy'].push(name);
    else plan.groups.unit.push(name);
  }
  // The declared runtime boundary includes real-CLI coverage. Its removal cannot
  // quietly reduce a later runtime change to mock-only verification.
  if (plan.changed.some(name => /^(?:src\/(?:core|runtime)\/|protocol\/)/.test(name))) {
    for (const required of nativeNames) if (!inventory.has(required)) plan.requiresFullAudit.push({ path: required, reason: 'missing-required-native-regression' });
  } else if (plan.changed.some(name => name.startsWith('src/gateway/')) && !inventory.has('tests/runtime/gateway-native.test.ts')) plan.requiresFullAudit.push({ path: 'tests/runtime/gateway-native.test.ts', reason: 'missing-required-native-regression' });
  if (!plan.changed.length) plan.requiresFullAudit.push({ path: '.', reason: 'empty-change-set' });
  const jsInventory = [...inventory].filter(name => testPattern.test(name));
  if ((selected.size > 0 && selected.size === inventory.size) || (jsInventory.length && jsInventory.every(name => selected.has(name)))) plan.requiresFullAudit.push({ path: '.', reason: 'selection-covers-full-inventory' });
  if (plan.requiresFullAudit.length) plan.status = 'requires-full-audit';
  else if (!selected.size) plan.status = 'no-behavior-change';
  return plan;
}

export function gitChanges(base, head, cwd = root) {
  // Never interpret user-controlled revisions as options or read an ancestor repo.
  if (![base, head].every(value => typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value) && !/^0+$/.test(value))) throw new Error('Explicit nonzero base and head commit IDs are required');
  const run = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  if (realpathSync(run(['rev-parse', '--show-toplevel']).trim()) !== realpathSync(cwd)) throw new Error('Change selection must run at its own repository root');
  // No rename detection: renamed files appear as both old deletion and new addition.
  return run(['diff', '--name-only', '-z', '--no-renames', '--diff-filter=ACDMRTUXB', base, head, '--']).split('\0').filter(Boolean).map(validateRelative);
}

export function nativePrerequisite(base = root, explicit = process.env.HARNESS_TEST_CODEX_BIN) {
  if (!explicit) return { status: 'skipped', reason: 'independent-official-cli-path-not-provided', requiredVersion: '0.164.0' };
  const runtime = path.resolve(base, 'reference/runtime');
  const candidate = path.resolve(explicit);
  if (!path.isAbsolute(explicit) || !candidate.startsWith(runtime + path.sep)) return { status: 'failed', reason: 'native-binary-must-belong-to-independent-runtime' };
  if (!existsSync(candidate)) return { status: 'skipped', reason: 'independent-official-cli-not-installed', requiredVersion: '0.164.0' };
  if (!lstatSync(candidate).isFile() || !realpathSync(candidate).startsWith(realpathSync(runtime) + path.sep)) return { status: 'failed', reason: 'invalid-native-binary-path' };
  // Provenance is the independently installed official package, not a PATH shim.
  let directory = path.dirname(candidate); let official = false;
  while (directory.startsWith(runtime + path.sep)) {
    const manifest = path.join(directory, 'package.json');
    if (existsSync(manifest)) {
      try { const value = JSON.parse(readFileSync(manifest, 'utf8')); if (value.name === '@openai/codex' && /^0\.164\.0(?:-(?:linux|win32|darwin)-(?:x64|arm64)(?:-musl)?)?$/.test(value.version)) official = true; } catch { return { status: 'failed', reason: 'unreadable-native-package-metadata' }; }
    }
    directory = path.dirname(directory);
  }
  if (!official) return { status: 'failed', reason: 'official-0.164.0-package-metadata-not-found' };
  const homes = path.join(base, '.work/native-version'); mkdirSync(homes, { recursive: true }); const isolated = mkdtempSync(path.join(homes, 'check-'));
  const home = path.join(isolated, 'home'); const temporary = path.join(isolated, 'tmp'); mkdirSync(home); mkdirSync(temporary);
  const env = { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, 'codex'), TEMP: temporary, TMP: temporary };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC']) if (process.env[key]) env[key] = process.env[key];
  const checked = spawnSync(candidate, ['--version'], { cwd: base, env, encoding: 'utf8', timeout: 15000, maxBuffer: 4096, windowsHide: true });
  if (checked.error || checked.status !== 0 || checked.stdout.trim() !== 'codex-cli 0.164.0') return { status: 'failed', reason: 'native-version-check-failed' };
  return { status: 'ready', version: '0.164.0', binary: candidate };
}

export function pythonPrerequisite() {
  const binary = process.env.HARNESS_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const checked = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 15000, maxBuffer: 4096, windowsHide: true });
  if (checked.error || checked.status !== 0) return { status: 'skipped', reason: 'python-interpreter-unavailable' };
  const version = `${checked.stdout ?? ''}${checked.stderr ?? ''}`.trim();
  if (!/^Python 3\.(?:1[1-9]|[2-9][0-9])\.\d+$/.test(version)) return { status: 'failed', reason: 'python-3.11-or-later-required' };
  return { status: 'ready', binary, version };
}

export function runPythonTests(files, base = root) {
  const prerequisite = pythonPrerequisite();
  if (prerequisite.status !== 'ready') return { ...prerequisite, exitCode: prerequisite.status === 'skipped' ? 3 : 1, tests: files };
  if (!files.length) return { status: 'failed', exitCode: 1, reason: 'empty-python-selection', tests: [] };
  const reports = path.join(base, '.work/test-results'); mkdirSync(reports, { recursive: true });
  const output = path.join(mkdtempSync(path.join(reports, 'python-')), 'cases.json');
  const child = spawnSync(prerequisite.binary, ['-B', path.join(root, 'scripts/python-tests.py'), output, ...files], { cwd: base, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'inherit', shell: false, windowsHide: true });
  const code = child.status ?? 1;
  try {
    const report = JSON.parse(readFileSync(output, 'utf8'));
    if (report.exitCode !== code || JSON.stringify(report.files) !== JSON.stringify(files) || !Array.isArray(report.cases) || !report.cases.length || new Set(report.cases.map(item => item.id)).size !== report.cases.length || files.some(file => !report.cases.some(item => item.file === file))) throw Error('Invalid per-case Python evidence');
    return { status: code === 0 ? 'passed' : code === 3 ? 'skipped' : 'failed', exitCode: code === 0 ? 0 : code === 3 ? 3 : 1, tests: files, cases: report.cases };
  } catch { return { status: 'failed', exitCode: 1, tests: files, reason: 'missing-or-invalid-python-evidence' }; }
}

export function runSelection(plan, group = 'all', base = root) {
  if (plan.status === 'requires-full-audit') return { status: 'requires-full-audit', exitCode: 2, results: [] };
  if (plan.status === 'no-behavior-change') return { status: 'no-behavior-change', exitCode: 0, results: [], note: 'No tests were run; this is not a test pass.' };
  const groups = group === 'all' ? ['unit', 'deploy', 'deploy-root', 'native'] : [group];
  if (groups.some(name => !['unit', 'deploy', 'deploy-root', 'native'].includes(name))) throw new Error('Unknown test group');
  const results = []; let exitCode = 0;
  for (const kind of groups) {
    const files = plan.groups[kind];
    if (!files.length) { results.push({ group: kind, status: 'not-affected', tests: [] }); continue; }
    if (kind === 'deploy' || kind === 'deploy-root') {
      const result = runPythonTests(files, base); results.push({ group: kind, ...result });
      if (result.exitCode && exitCode !== 1) exitCode = result.exitCode;
      continue;
    }
    const env = { ...process.env };
    if (kind === 'native') {
      const prerequisite = nativePrerequisite(base);
      if (prerequisite.status !== 'ready') { results.push({ group: kind, ...prerequisite, tests: files }); exitCode = prerequisite.status === 'skipped' && exitCode !== 1 ? 3 : 1; continue; }
      env.HARNESS_TEST_CODEX_BIN = prerequisite.binary;
    }
    const child = spawnSync(process.execPath, [path.join(base, 'scripts/run-tests.mjs'), '--targeted', ...files], { cwd: base, env, stdio: 'inherit', shell: false, windowsHide: true });
    const code = child.status ?? 1;
    results.push({ group: kind, status: code === 0 ? 'passed' : code === 3 ? 'skipped' : 'failed', tests: files });
    if (code && exitCode !== 1) exitCode = code === 3 ? 3 : 1;
  }
  return { status: results.every(result => result.status === 'not-affected') ? 'not-affected' : exitCode === 0 ? 'passed' : exitCode === 3 ? 'skipped' : 'failed', exitCode, results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2); let changed; let run; let base; let head;
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--base') base = args[++index];
      else if (args[index] === '--head') head = args[++index];
      else if (args[index] === '--run') run = args[++index];
      else if (args[index] === '--changed') { changed = args.slice(index + 1); break; }
      else throw new Error('Unknown selection argument');
    }
    if (changed && (base || head)) throw new Error('Choose an explicit change list or base/head, not both');
    const plan = selectTests(changed ?? gitChanges(base, head), testInventory());
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    if (plan.status === 'requires-full-audit') process.exitCode = 2;
    else if (run) { const result = runSelection(plan, run); process.stdout.write(JSON.stringify(result, null, 2) + '\n'); process.exitCode = result.exitCode; }
  } catch {
    process.stderr.write(JSON.stringify({ status: 'requires-full-audit', reason: 'invalid-or-unreadable-change-selection' }) + '\n'); process.exitCode = 2;
  }
}
