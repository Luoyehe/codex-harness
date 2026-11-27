import { afterEach, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { executePlan, runVitest } from '../../scripts/run-tests.mjs';
import { testInventory, selectionFailure, selectTests } from '../../scripts/select-tests.mjs';
import { beginTestWorkspace, finishTestWorkspace } from '../../scripts/test-retention.mjs';
import { requireSuccessfulJobs } from '../../scripts/ci-job-status.mjs';
import { sourceExecutableBits } from '../../scripts/snapshot.mjs';
import { cleanBuildDirectory } from '../../scripts/build-server.mjs';
import { createPnpmDirectory, verifyPnpmArchive } from '../../scripts/prepare-ci-pnpm.mjs';
import { official } from '../../scripts/compatibility-watch.mjs';

// The global setup must not even import browser modules in Node suites.
vi.mock('../../web/lib/operations', () => { throw Error('Browser-only setup imported in Node'); });
const fixtures: string[] = [];
function fixture() { mkdirSync('.work/v240-tooling-tests', { recursive: true }); const base = mkdtempSync(path.resolve('.work/v240-tooling-tests/run-')); fixtures.push(base); return base; }
function put(base: string, name: string, content: string) { const full = path.join(base, name); mkdirSync(path.dirname(full), { recursive: true }); writeFileSync(full, content); }
afterEach(() => { for (const base of fixtures.splice(0)) rmSync(base, { recursive: true, force: true }); });

test.each(['failure', 'cancelled', 'skipped', undefined])('coverage rejects planning result %s', result => {
  expect(() => requireSuccessfulJobs({ plan: { result }, standard: { result: 'skipped' }, macos_development: { result: 'skipped' }, root_deploy: { result: 'skipped' } })).toThrow();
});
test('coverage checks selected jobs while preserving an explicitly empty successful plan', () => {
  const needs = { plan: { result: 'success', outputs: { standard: 'false', root: 'false' } }, standard: { result: 'skipped' }, macos_development: { result: 'skipped' }, root_deploy: { result: 'skipped' } };
  expect(requireSuccessfulJobs(needs)).toBe(true);
  needs.plan.outputs.standard = 'true';
  for (const result of ['skipped', 'failure', 'cancelled']) { needs.standard.result = result; expect(() => requireSuccessfulJobs(needs)).toThrow(); }
  needs.standard.result = 'success'; expect(() => requireSuccessfulJobs(needs)).toThrow();
  needs.macos_development.result = 'success'; expect(requireSuccessfulJobs(needs)).toBe(true);
  delete (needs.plan.outputs as Partial<typeof needs.plan.outputs>).root; expect(() => requireSuccessfulJobs(needs)).toThrow();
});

test('checked release changes select their publication and exact-source preflight regressions', () => {
  const inventory = testInventory(process.cwd());
  for (const changed of ['scripts/publish-release.mjs', '.github/workflows/release.yml']) {
    const plan = selectTests([changed], inventory);
    expect(plan.groups.unit).toContain('tests/tooling/publish-release.test.ts');
    expect(plan.groups.unit).toContain('tests/tooling/release-preflight.test.ts');
  }
  const workflow = readFileSync('.github/workflows/affected.yml', 'utf8');
  expect(workflow).toContain("github.event_name == 'pull_request' && github.ref || github.sha");
  expect(workflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
});
test('all configured colocated and Unicode test paths enter inventory and execution', () => {
  const base = fixture(), names = ['web/components/select model.test.tsx', 'tests/core/测试+catalog.test.ts', 'tests/deploy/test_path+name.py'];
  for (const name of names) put(base, name, '');
  expect(testInventory(base)).toEqual([...names].sort());
  const js = vi.fn(() => ({ exitCode: 0 })), python = vi.fn(() => ({ exitCode: 0 }));
  expect(executePlan({ files: names }, base, { runVitest: js, runPythonTests: python, pythonPrerequisite: () => ({ status: 'ready' }) }).status).toBe('passed');
  expect(js).toHaveBeenCalledWith(names.slice(0, 2), base, expect.any(Object));
  expect(python).toHaveBeenCalledWith([names[2]], base, expect.any(Object));
  for (const files of [[], ['unhandled.test.js'], [names[0], names[0]]]) expect(() => executePlan({ files }, base)).toThrow();
});
test('actual Vitest executes exactly the selected colocated test', () => {
  const base = fixture();
  put(base, 'package.json', '{"type":"module"}');
  put(base, 'vitest.config.ts', "export default {test:{include:['web/**/*.test.ts','web/**/*.test.tsx']}};");
  put(base, 'web/components/select model.test.ts', "import {test,expect} from 'vitest'; test('selected',()=>expect(2+2).toBe(4));");
  put(base, 'web/components/select model.test.tsx', "throw Error('unselected companion must never execute');");
  expect(runVitest(['web/components/select model.test.ts'], base)).toMatchObject({ status: 'passed', cases: [{ file: 'web/components/select model.test.ts', status: 'passed' }] });
});
test('Git executable mode is portable without hiding POSIX working-tree chmod changes', () => {
  expect(sourceExecutableBits({ mode: 0o755 })).toBe(0o111);
  expect(sourceExecutableBits({ mode: 0o644 })).toBe(0);
});
test('clean local build removes obsolete output and preserves source', () => {
  const base = fixture(); put(base, 'src/still.ts', 'source'); put(base, 'dist/src/removed.js', 'obsolete');
  cleanBuildDirectory(base); expect(() => readFileSync(path.join(base, 'dist/src/removed.js'))).toThrow(); expect(readFileSync(path.join(base, 'src/still.ts'), 'utf8')).toBe('source');
});

test('the local build entrypoint invokes the installed compiler path and removes partial failed output', () => {
  const base = fixture(); put(base, 'package.json', '{"type":"module","devDependencies":{"typescript":"7.0.2"}}');
  put(base, 'deploy/build_tool.mjs', readFileSync('deploy/build_tool.mjs', 'utf8'));
  put(base, 'scripts/build-server.mjs', readFileSync('scripts/build-server.mjs', 'utf8'));
  put(base, 'node_modules/typescript/package.json', '{"name":"typescript","version":"7.0.2","bin":{"tsc":"./commands/compiler.cjs"}}');
  put(base, 'node_modules/typescript/commands/compiler.cjs', "const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/partial.js','partial');process.exit(1);");
  put(base, 'dist/stale.js', 'old output');
  expect(() => execFileSync(process.execPath, ['scripts/build-server.mjs'], { cwd: base, stdio: 'pipe' })).toThrow();
  expect(existsSync(path.join(base, 'dist'))).toBe(false);
  put(base, 'node_modules/typescript/commands/compiler.cjs', "const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/built.js','built');");
  execFileSync(process.execPath, ['scripts/build-server.mjs'], { cwd: base, stdio: 'pipe' });
  expect(readFileSync(path.join(base, 'dist/built.js'), 'utf8')).toBe('built');
});
test('ordinary Git additions ignore harmless OS files and private credential paths', () => {
  const base = fixture(); execFileSync('git', ['init', '-q'], { cwd: base });
  put(base, '.gitignore', readFileSync('.gitignore', 'utf8'));
  for (const name of ['.DS_Store', 'auth.json', 'key.pem']) put(base, name, 'synthetic nonsecret placeholder');
  const ignored = execFileSync('git', ['check-ignore', '.DS_Store', 'auth.json', 'key.pem'], { cwd: base, encoding: 'utf8' });
  expect(ignored.trim().split(/\r?\n/)).toEqual(['.DS_Store', 'auth.json', 'key.pem']);
});
test('pinned package distribution rejects changed bytes before extraction', () => { expect(() => verifyPnpmArchive(Buffer.from('changed'))).toThrow(/checksum/); });

test.each(['.work', '.work/ci-pnpm'])('pnpm preparation rejects redirected ancestor %s before writing outside the workspace', relative => {
  const base = fixture(), outside = fixture(), link = path.join(base, relative);
  mkdirSync(path.dirname(link), { recursive: true });
  put(outside, 'sentinel.txt', 'keep'); symlinkSync(outside, link, 'dir');
  expect(() => createPnpmDirectory(base)).toThrow(/Invalid pnpm output/);
  expect(readFileSync(path.join(outside, 'sentinel.txt'), 'utf8')).toBe('keep');
  expect(existsSync(path.join(outside, 'ci-pnpm'))).toBe(false);
});

test('pnpm preparation never extracts into a pre-existing package or launcher tree', () => {
  const base = fixture(), outside = fixture();
  put(outside, 'sentinel.txt', 'keep'); put(base, '.work/ci-pnpm/pnpm.tgz', 'old');
  symlinkSync(outside, path.join(base, '.work/ci-pnpm/package'), 'dir');
  const first = createPnpmDirectory(base), second = createPnpmDirectory(base);
  expect(first).not.toBe(second);
  expect(path.dirname(first)).toBe(path.join(base, '.work/ci-pnpm'));
  expect(existsSync(path.join(first, 'package'))).toBe(false);
  expect(readFileSync(path.join(base, '.work/ci-pnpm/pnpm.tgz'), 'utf8')).toBe('old');
  expect(readFileSync(path.join(outside, 'sentinel.txt'), 'utf8')).toBe('keep');
});

test('test retention deletes only owned completed directories and bounds failed diagnostics', () => {
  const base = fixture(), parent = path.join(base, '.work/test-homes'); mkdirSync(parent, { recursive: true });
  const create = () => { const target = mkdtempSync(path.join(parent, 'run-')); beginTestWorkspace(target); return target; };
  const active = create(), passed = create();
  finishTestWorkspace(passed, true); expect(existsSync(passed)).toBe(false);
  const failed = Array.from({ length: 5 }, () => { const dir = create(); finishTestWorkspace(dir, false); return dir; });
  expect(failed.filter(existsSync)).toHaveLength(3); expect(existsSync(active)).toBe(true);
  expect(() => finishTestWorkspace(base, true)).toThrow(/Unrecognized/);
});

test('selector failures identify stage without exposing arbitrary exception text', () => {
  const result = selectionFailure(Object.assign(Error('synthetic-private-path'), { code: 'EACCES' }), 'test-inventory');
  expect(JSON.stringify(result)).toContain('permission-denied');
  expect(JSON.stringify(result)).not.toContain('synthetic-private-path');
});
test('metadata rate limits stay unverified and explicit credentials are confined to GitHub', async () => {
  const seen: RequestInit[] = [];
  const fetcher = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => { seen.push(options!); return new Response('{"version":"0.169.0"}', { status: 200 }); });
  await official('https://registry.npmjs.org/@openai/codex/latest', { fetcher, token: 'synthetic' });
  expect(seen[0]!.headers).not.toHaveProperty('Authorization');
  await official('https://api.github.com/repos/openai/codex/releases/latest', { fetcher, token: 'synthetic' });
  expect(seen[1]!.headers).toHaveProperty('Authorization', 'Bearer synthetic');
  await expect(official('https://api.github.com/repos/openai/codex/releases/latest', { fetcher: async () => new Response('', { status: 429, headers: { 'retry-after': '30' } }) })).rejects.toMatchObject({ code: 'upstream-rate-limited', retryAfter: '30' });
  await expect(official('https://unapproved.invalid/', { fetcher })).rejects.toThrow(/Unapproved/);
});
