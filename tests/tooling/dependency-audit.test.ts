import { afterEach, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { checkDependencyAudit, classifyDependencyAudit } from '../../scripts/dependency-audit.mjs';
import { verifyInstalledPicomatch } from '../../scripts/picomatch-patch-proof.mjs';

const roots: string[] = [], area = path.resolve('.work/dependency-audit-tests');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const ghsa = 'GHSA-fc5q-39xc-vjpf', patchHash = hash('inert patch bytes\n');
function put(base: string, name: string, value: string) { const file = path.join(base, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, value); }
function report() {
  return { advisories: { '1247710': { id: 1247710, github_advisory_id: ghsa, module_name: 'picomatch', severity: 'high', vulnerable_versions: '<=4.0.7', findings: [{ version: '4.0.7', paths: ['.>vite>picomatch'] }] } }, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 1, critical: 0 } } };
}
function fixture() {
  mkdirSync(area, { recursive: true }); const base = mkdtempSync(path.join(area, 'case-')); roots.push(base);
  // Inert package fixtures establish byte/ownership validation only; never execute glob patterns.
  const contents = { 'package.json': JSON.stringify({ name: 'picomatch', version: '4.0.7', main: 'index.js' }), 'index.js': '// inert approved entry\n', 'lib/parse.js': '// inert approved parser\n', 'lib/picomatch.js': '// inert approved matcher\n', 'README.md': 'inert package\n' };
  const patch = 'inert patch bytes\n', integrity = 'sha512-' + Buffer.alloc(64, 7).toString('base64');
  const contract = { schemaVersion: 1, package: 'picomatch', version: '4.0.7', patchPath: 'patches/picomatch@4.0.7.patch', patchSha256: hash(patch), lockPatchHash: patchHash, upstreamIntegrity: integrity, files: Object.fromEntries(Object.entries(contents).map(([name, text]) => [name, hash(text)])) };
  put(base, 'deploy/dependency_patch_contract.py', 'APPROVED_PATCH = ' + JSON.stringify(contract) + '\n');
  put(base, contract.patchPath, patch);
  put(base, 'pnpm-workspace.yaml', JSON.stringify({ patchedDependencies: { 'picomatch@4.0.7': contract.patchPath } }));
  put(base, 'pnpm-lock.yaml', `lockfileVersion: '9.0'\n\npatchedDependencies:\n  picomatch@4.0.7: ${patchHash}\n\npackages:\n  picomatch@4.0.7:\n    resolution: {integrity: ${integrity}}\n\nsnapshots:\n  picomatch@4.0.7(patch_hash=${patchHash}): {}\n  vite@8.3.5:\n    dependencies:\n      picomatch: 4.0.7(patch_hash=${patchHash})\n`);
  put(base, 'package.json', JSON.stringify({ name: 'fixture', devDependencies: { vite: '8.3.5' } }));
  const instance = `node_modules/.pnpm/picomatch@4.0.7_patch_hash=${patchHash}/node_modules/picomatch`;
  for (const [name, text] of Object.entries(contents)) put(base, instance + '/' + name, text);
  const consumer = 'node_modules/.pnpm/vite@8.3.5/node_modules/vite';
  put(base, consumer + '/package.json', JSON.stringify({ name: 'vite', dependencies: { picomatch: '^4.0.7' } }));
  symlinkSync(path.join(base, instance), path.join(base, 'node_modules/.pnpm/vite@8.3.5/node_modules/picomatch'), 'dir');
  put(base, 'dependency-audit.json', JSON.stringify(report(), null, 2) + '\n');
  return { base, instance, contract, contents, consumer };
}
afterEach(() => { for (const base of roots.splice(0)) { if (!base.startsWith(area + path.sep)) throw Error('Unsafe fixture cleanup'); rmSync(base, { recursive: true, force: true }); } });

test('classifies only the exact advisory after proving all installed package bytes and preserves raw report', () => {
  const { base } = fixture(), original = readFileSync(path.join(base, 'dependency-audit.json'));
  const result = checkDependencyAudit(base, 1);
  expect(result).toMatchObject({ status: 'passed', auditExit: 1, originalCounts: { high: 1, moderate: 1 }, locallyRemediated: [{ ghsa, package: 'picomatch', classification: 'locally-remediated', version: '4.0.7' }], unresolved: [] });
  expect(result.proof.instances).toHaveLength(1); expect(result.proof.consumers).toHaveLength(1);
  expect(readFileSync(path.join(base, 'dependency-audit.json'))).toEqual(original);
  expect(JSON.stringify(result)).not.toContain(base.replaceAll('\\', '\\\\'));
});

test.each(['patch', 'missing-patch', 'lock', 'upstream-integrity', 'unpatched-resolution', 'workspace', 'parser', 'entry', 'package-version', 'missing-file', 'extra-file', 'extra-directory', 'contract'] as const)('rejects changed %s rather than treating a declared patch as proof', kind => {
  const { base, instance, contract } = fixture();
  const mutate = (name: string, transform: (value: string) => string) => put(base, name, transform(readFileSync(path.join(base, name), 'utf8')));
  if (kind === 'patch') put(base, contract.patchPath, 'changed');
  if (kind === 'missing-patch') rmSync(path.join(base, contract.patchPath));
  if (kind === 'lock') mutate('pnpm-lock.yaml', text => text.replace(patchHash, 'c'.repeat(64)));
  if (kind === 'upstream-integrity') mutate('pnpm-lock.yaml', text => text.replace(contract.upstreamIntegrity, 'sha512-' + Buffer.alloc(64, 8).toString('base64')));
  if (kind === 'unpatched-resolution') mutate('pnpm-lock.yaml', text => text.replace(`      picomatch: 4.0.7(patch_hash=${patchHash})`, '      picomatch: 4.0.7'));
  if (kind === 'workspace') put(base, 'pnpm-workspace.yaml', '{}');
  if (kind === 'parser') put(base, instance + '/lib/parse.js', '// old parser\n');
  if (kind === 'entry') put(base, instance + '/index.js', '// changed entry\n');
  if (kind === 'package-version') mutate(instance + '/package.json', text => text.replace('4.0.7', '4.0.8'));
  if (kind === 'missing-file') rmSync(path.join(base, instance, 'README.md'));
  if (kind === 'extra-file') put(base, instance + '/extra.js', '// unexpected source\n');
  if (kind === 'extra-directory') mkdirSync(path.join(base, instance, 'unreviewed'));
  if (kind === 'contract') put(base, 'deploy/dependency_patch_contract.py', 'print("must not execute")\n');
  expect(() => checkDependencyAudit(base, 1)).toThrow();
});

test('rejects absent install, an unpatched second instance and redirected consumer resolution', () => {
  const absent = fixture(); rmSync(path.join(absent.base, 'node_modules'), { recursive: true });
  expect(() => checkDependencyAudit(absent.base, 1)).toThrow();
  const mixed = fixture();
  for (const [name, text] of Object.entries(mixed.contents)) put(mixed.base, 'node_modules/.pnpm/picomatch@4.0.7/node_modules/picomatch/' + name, name === 'lib/parse.js' ? '// unpatched\n' : text);
  expect(() => checkDependencyAudit(mixed.base, 1)).toThrow(/approved patched/);
  const shadow = fixture();
  for (const [name, text] of Object.entries(shadow.contents)) put(shadow.base, shadow.consumer + '/node_modules/picomatch/' + name, name === 'lib/parse.js' ? '// unpatched shadow\n' : text);
  expect(() => checkDependencyAudit(shadow.base, 1)).toThrow(/approved patched/);
  const redirect = fixture(), outside = path.join(redirect.base, 'substituted-package');
  for (const [name, text] of Object.entries(redirect.contents)) put(outside, name, text);
  const link = path.join(redirect.base, 'node_modules/.pnpm/vite@8.3.5/node_modules/picomatch'); rmSync(link);
  symlinkSync(outside, link, 'dir');
  expect(() => checkDependencyAudit(redirect.base, 1)).toThrow(/escaped|outside/);
});

test('does not classify another package, advisory, version or critical variant as locally repaired', () => {
  const { base } = fixture(), proof = verifyInstalledPicomatch(base);
  for (const change of [
    (value: ReturnType<typeof report>) => { value.advisories['1247710'].module_name = 'other-package'; },
    (value: ReturnType<typeof report>) => { value.advisories['1247710'].github_advisory_id = 'GHSA-aaaa-bbbb-cccc'; },
    (value: ReturnType<typeof report>) => { value.advisories['1247710'].findings[0]!.version = '4.0.6'; },
    (value: ReturnType<typeof report>) => { value.advisories['1247710'].severity = 'critical'; value.metadata.vulnerabilities.high = 0; value.metadata.vulnerabilities.critical = 1; },
  ]) {
    const value = report(); change(value);
    expect(classifyDependencyAudit(value, 1, proof)).toMatchObject({ status: 'blocked', locallyRemediated: [], unresolved: [expect.any(Object)] });
  }
  const extra = report();
  const value = { ...extra, advisories: { ...extra.advisories, '2': { ...extra.advisories['1247710'], id: 2, github_advisory_id: 'GHSA-aaaa-bbbb-cccc' } } };
  value.metadata.vulnerabilities.high = 2;
  expect(classifyDependencyAudit(value, 1, proof)).toMatchObject({ status: 'blocked', locallyRemediated: [expect.any(Object)], unresolved: [expect.any(Object)] });
});

test('unknown diagnostics, truncated counts and contradictory exit status fail closed', () => {
  const { base } = fixture(), proof = verifyInstalledPicomatch(base);
  for (const value of [null, [], {}, { error: { code: 'ENETUNREACH' } }, { ...report(), error: 'failure' }, { ...report(), advisories: {} }, { ...report(), metadata: { vulnerabilities: { high: 1 } } }]) expect(() => classifyDependencyAudit(value, 1, proof)).toThrow();
  expect(() => classifyDependencyAudit(report(), 2, proof)).toThrow();
  expect(() => classifyDependencyAudit(report(), 0, proof)).toThrow();
  expect(() => classifyDependencyAudit({ advisories: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0 } } }, 1, proof)).toThrow();
  put(base, 'dependency-audit.json', '{'); expect(() => checkDependencyAudit(base, 1)).toThrow();
  expect(readFileSync(path.join(base, 'dependency-audit.json'), 'utf8')).toBe('{');
});

test('workflow retains the scanner exit, checks installed content and uploads original plus classification', () => {
  const workflow = readFileSync('.github/workflows/security.yml', 'utf8');
  const install = workflow.indexOf('pnpm install --frozen-lockfile --ignore-scripts');
  const audit = workflow.indexOf('pnpm audit --audit-level high --json > dependency-audit.json');
  const gate = workflow.indexOf('node scripts/dependency-audit.mjs --audit-exit "$audit_status"');
  expect(install).toBeGreaterThan(0); expect(audit).toBeGreaterThan(install); expect(gate).toBeGreaterThan(audit);
  expect(workflow).toContain('audit_status=$?'); expect(workflow).toContain('set -e');
  expect(workflow).toContain('dependency-audit.json\n            dependency-audit-classification.json');
  expect(workflow).not.toContain('continue-on-error:'); expect(workflow).not.toContain('ignoreCves');
  expect(existsSync('scripts/picomatch-patch-proof.mjs')).toBe(true);
});

test('actual gate CLI preserves raw bytes and reports safe precise failures without accepting a saved proof', () => {
  const { base, instance } = fixture();
  for (const name of ['dependency-audit.mjs', 'picomatch-patch-proof.mjs']) put(base, 'scripts/' + name, readFileSync('scripts/' + name, 'utf8'));
  const raw = readFileSync(path.join(base, 'dependency-audit.json'));
  const invoke = () => spawnSync(process.execPath, ['scripts/dependency-audit.mjs', '--audit-exit', '1'], { cwd: base, encoding: 'utf8' });
  expect(invoke().status).toBe(0);
  expect(JSON.parse(readFileSync(path.join(base, 'dependency-audit-classification.json'), 'utf8'))).toMatchObject({ status: 'passed' });
  // A prior successful classification cannot stand in for a new installed-byte check.
  rmSync(path.join(base, 'dependency-audit-classification.json'));
  put(base, instance + '/lib/parse.js', '// changed after successful proof\n');
  expect(invoke().status).toBe(1);
  const failed = readFileSync(path.join(base, 'dependency-audit-classification.json'), 'utf8');
  expect(JSON.parse(failed)).toMatchObject({ status: 'blocked', stage: 'installed-patch-proof', reason: expect.stringContaining('approved patched content') });
  expect(failed).not.toContain(base); expect(readFileSync(path.join(base, 'dependency-audit.json'))).toEqual(raw);
  // No arbitrary pre-existing output, including a link, may overwrite the raw report.
  expect(invoke().status).toBe(1); expect(readFileSync(path.join(base, 'dependency-audit-classification.json'), 'utf8')).toBe(failed);
  rmSync(path.join(base, 'dependency-audit-classification.json'));
  linkSync(path.join(base, 'dependency-audit.json'), path.join(base, 'dependency-audit-classification.json'));
  expect(invoke().status).toBe(1); expect(readFileSync(path.join(base, 'dependency-audit.json'))).toEqual(raw);
});
