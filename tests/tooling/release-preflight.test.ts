import { afterEach, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { committedSource, parsePreflightArgs, releasePreflight, toolPins } from '../../scripts/release-preflight.mjs';
import { snapshot } from '../../scripts/snapshot.mjs';

const fixtures: string[] = [], fixtureRoot = path.resolve('.work/release-preflight-tests');
const authorizationPath = 'verification/audit-evidence/release-closeout/authorization.json';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const git = (base: string, ...args: string[]) => execFileSync('git', args, { cwd: base, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function put(base: string, name: string, value: string) { const file = path.join(base, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, value); }
function commit(base: string, message: string) {
  git(base, 'add', '.'); git(base, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', message);
  return git(base, 'rev-parse', 'HEAD');
}
function fixture() {
  mkdirSync(fixtureRoot, { recursive: true }); const base = realpathSync(mkdtempSync(path.join(fixtureRoot, 'case-'))); fixtures.push(base);
  git(base, 'init', '-q'); git(base, 'config', 'core.autocrlf', 'false');
  put(base, '.gitignore', '.work/\nnode_modules/\ndist/\nweb/dist/\n');
  const pkg = { type: 'module', version: '2.2.0', packageManager: 'pnpm@11.22.0', codexVersion: '0.164.0', devDependencies: { typescript: '7.0.2', vite: '8.3.5' } };
  put(base, 'package.json', JSON.stringify(pkg));
  put(base, 'deploy/common.py', 'NODE_VERSION = "24.22.1"\nPNPM_VERSION = "11.22.0"\nCODEX_VERSION = "0.164.0"\n');
  for (const name of ['affected', 'security', 'compatibility']) put(base, `.github/workflows/${name}.yml`, readFileSync(`.github/workflows/${name}.yml`, 'utf8'));
  const files = ['tests/core/example.test.ts', 'tests/core/other.test.ts', 'tests/deploy/test_example.py', 'tests/deploy/root/test_example.py'];
  for (const name of files) put(base, name, '// Inert inventory fixture; never executed.\n');
  put(base, 'web/tsconfig.json', '{}'); put(base, 'tsconfig.server.json', '{}'); put(base, 'web/vite.config.ts', '// Inert configuration fixture.\n');
  const prBase = commit(base, 'baseline');
  pkg.version = '2.3.0'; put(base, 'package.json', JSON.stringify(pkg)); const pushBase = commit(base, 'version update');
  put(base, files[0]!, '// Changed inventory fixture; never executed.\n');
  const current = snapshot(base);
  const authorization = { schemaVersion: 1, kind: 'explicit-user-release-closeout', auditRoundsWaived: true, sourceDigest: current.digest, sourceFiles: current.files, baseCommit: prBase, version: pkg.version, approvedAt: '2026-01-01T00:00:00Z', userInstruction: 'Fixture instruction authorizes complete reviewed release tests.', auditWaiverInstruction: 'Fixture explicit audit gate exception for this exact source.', repairsReviewed: true, unresolvedBlockers: [], scopes: ['full-tests'] };
  const bytes = JSON.stringify(authorization); put(base, authorizationPath, bytes); const head = commit(base, 'candidate');
  // Tiny offline executables test orchestration and evidence binding, not real TS/Vite correctness.
  const log = `const fs = require('node:fs'); fs.mkdirSync('.work', {recursive:true}); fs.appendFileSync('.work/build-invocations.txt', JSON.stringify(process.argv.slice(2))+'\\n');\n`;
  put(base, 'node_modules/typescript/package.json', JSON.stringify({ version: pkg.devDependencies.typescript }));
  put(base, 'node_modules/typescript/bin/tsc', log + `if(!process.argv.includes('--noEmit')) { for(const name of ['gateway','runtime']) { fs.mkdirSync('dist/src/'+name,{recursive:true}); fs.writeFileSync('dist/src/'+name+'/main.js','export {};'); } }`);
  put(base, 'node_modules/vite/package.json', JSON.stringify({ version: pkg.devDependencies.vite }));
  put(base, 'node_modules/vite/bin/vite.js', log + `fs.mkdirSync('web/dist',{recursive:true}); fs.writeFileSync('web/dist/index.html','<html>Fixture</html>');`);
  return { base, files, options: { head, pushBase, prBase, authorizationSha256: hash(bytes) } };
}
afterEach(() => { for (const base of fixtures.splice(0)) { if (!base.startsWith(realpathSync(fixtureRoot) + path.sep)) throw Error('Unsafe fixture cleanup'); rmSync(base, { recursive: true, force: true }); } });

test('preflight binds two actual plans and reusable build outputs without executing tests', () => {
  const { base, files, options } = fixture();
  expect(() => releasePreflight(options, base)).toThrow(/build evidence is missing/);
  put(base, 'dist/stale.js', 'Stale artifact must not survive a rebuild.');
  const result = releasePreflight({ ...options, build: true }, base);
  expect(result).toMatchObject({ status: 'ready-for-ci', testsExecuted: false, releaseGatePassed: false, head: options.head });
  expect(result.plans.push).toMatchObject({ mode: 'selected', files: [files[0]], baseCommit: options.pushBase });
  expect(result.plans.pullRequest).toMatchObject({ mode: 'authorized-full', files: [...files].sort(), baseCommit: options.prBase });
  expect(result.plans.pullRequest.targets).toEqual(['linux', 'windows', 'linux-root']);
  expect(existsSync(path.join(base, 'dist/stale.js'))).toBe(false);
  const calls = readFileSync(path.join(base, '.work/build-invocations.txt'), 'utf8');
  expect(calls.trim().split('\n').map(line => JSON.parse(line))).toEqual([['--noEmit', '-p', 'web/tsconfig.json'], ['-p', 'tsconfig.server.json'], ['build', '--config', 'web/vite.config.ts']]);
  expect(releasePreflight(options, base).build.rebuilt).toBe(false);
  expect(readFileSync(path.join(base, '.work/build-invocations.txt'), 'utf8')).toBe(calls);
  // Evidence-only commits retain identical source; the original build identity remains honest.
  put(base, 'verification/reports/note.md', 'Fixture evidence only.'); const nextHead = commit(base, 'evidence');
  expect(releasePreflight({ ...options, head: nextHead }, base).build.builtForHead).toBe(options.head);
});

test('wrong head, authorization checksum or uncommitted authorization cannot pass', () => {
  const { base, options } = fixture();
  expect(() => releasePreflight({ ...options, head: options.pushBase }, base)).toThrow(/checked-out commit/);
  expect(() => releasePreflight({ ...options, authorizationSha256: '0'.repeat(64) }, base)).toThrow(/checksum/);
  const bytes = readFileSync(path.join(base, authorizationPath), 'utf8') + '\n'; put(base, authorizationPath, bytes);
  expect(() => releasePreflight({ ...options, authorizationSha256: hash(bytes) }, base)).toThrow(/committed bytes/);
});

test('raw source comparison catches assume-unchanged edits and untracked source', () => {
  const { base, files, options } = fixture();
  git(base, 'update-index', '--assume-unchanged', files[0]!);
  put(base, files[0]!, '// Hidden from Git stat checks.\n');
  expect(git(base, 'diff', '--name-only')).toBe('');
  expect(() => committedSource(base, options.head)).toThrow(/bytes or executable bits/);
  put(base, files[0]!, '// Changed inventory fixture; never executed.\n');
  put(base, 'new-source.ts', 'export {};');
  expect(() => committedSource(base, options.head)).toThrow(/inventory differs/);
});

test('altered, additional and missing emitted artifacts invalidate build evidence', () => {
  const { base, options } = fixture(); releasePreflight({ ...options, build: true }, base);
  const name = 'dist/src/runtime/main.js', original = readFileSync(path.join(base, name), 'utf8');
  put(base, name, 'export const stale = true;'); expect(() => releasePreflight(options, base)).toThrow(/stale or outputs changed/);
  put(base, name, original); put(base, 'dist/extra.js', 'extra'); expect(() => releasePreflight(options, base)).toThrow(/stale or outputs changed/);
  rmSync(path.join(base, 'dist/extra.js')); rmSync(path.join(base, name)); expect(() => releasePreflight(options, base)).toThrow(/Required build output missing/);
});

test('failed rebuild clears prior success and source changes during building never publish a record', () => {
  const { base, options } = fixture(); releasePreflight({ ...options, build: true }, base);
  put(base, 'node_modules/vite/bin/vite.js', 'process.exit(1);');
  expect(() => releasePreflight({ ...options, build: true }, base)).toThrow();
  expect(existsSync(path.join(base, '.work/release-preflight-build.json'))).toBe(false);
  expect(() => releasePreflight(options, base)).toThrow(/build evidence is missing/);
  put(base, 'node_modules/vite/bin/vite.js', `require('node:fs').writeFileSync('tests/core/example.test.ts','changed during build');`);
  expect(() => releasePreflight({ ...options, build: true }, base)).toThrow(/bytes or executable bits/);
  expect(existsSync(path.join(base, '.work/release-preflight-build.json'))).toBe(false);
});

test('tool pin drift and a selected-only release PR are explicit blockers', () => {
  const { base, options } = fixture();
  expect(() => toolPins(base, '24.15.0')).toThrow(/pins disagree/);
  expect(() => releasePreflight({ ...options, prBase: options.pushBase }, base)).toThrow(/authorized full inventory/);
  const name = '.github/workflows/security.yml'; put(base, name, readFileSync(path.join(base, name), 'utf8').replaceAll('24.22.1', '24.15.0'));
  expect(() => toolPins(base)).toThrow(/Workflow Node pin disagrees: security/);
  put(base, name, readFileSync(path.join(base, name), 'utf8').replaceAll('24.15.0', '24.22.1'));
  const affected = '.github/workflows/affected.yml'; put(base, affected, readFileSync(path.join(base, affected), 'utf8').replace('branches: [main]', "branches: ['**']"));
  expect(() => toolPins(base)).toThrow(/workflow triggers differ/);
});

test('CLI rejects unknown, duplicate and missing values and retains explicit build opt-in', () => {
  expect(parsePreflightArgs(['--head', 'a', '--push-base', 'b', '--pr-base', 'c', '--authorization-sha256', 'd'])).toEqual({ head: 'a', pushBase: 'b', prBase: 'c', authorizationSha256: 'd' });
  expect(parsePreflightArgs(['--build'])).toEqual({ build: true });
  for (const args of [['--full'], ['--build', '--build'], ['--head'], ['--head', '--build'], ['--head', 'a', '--head', 'b']]) expect(() => parsePreflightArgs(args)).toThrow();
  expect(() => releasePreflight({}, process.cwd())).toThrow(/Exact nonzero/);
});
