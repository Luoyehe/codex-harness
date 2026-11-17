import { afterEach, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildCodeqlGo, prepareCodeqlGo } from '../../scripts/build-codeql-go.mjs';
import { selectTests, testInventory } from '../../scripts/select-tests.mjs';

const fixtures: string[] = [];
function fixture() {
  const parent = path.resolve('.work/codeql-go-tests'); mkdirSync(parent, { recursive: true });
  const base = mkdtempSync(path.join(parent, 'run-')); fixtures.push(base);
  const goroot = path.join(base, 'runtime/go'), binary = path.join(goroot, 'bin/go'), entry = path.join(base, 'wrapper/go');
  for (const folder of [path.dirname(binary), path.dirname(entry), path.join(base, 'deploy/caddy_dns_source'), path.join(base, '.work')]) mkdirSync(folder, { recursive: true });
  writeFileSync(binary, 'fixture'); writeFileSync(entry, 'fixture');
  const identity = { GOVERSION: 'go1.26.10', GOROOT: goroot, GOOS: process.platform === 'win32' ? 'windows' : 'linux', GOARCH: 'amd64' };
  const prepared = { status: 'ready', version: '1.26.10', binary, moduleCache: path.join(base, 'modules'), manifest: { platform: identity.GOOS, architecture: 'amd64' } };
  const prerequisite = vi.fn(() => prepared), env = { CODEQL_ACTION_GO_BINARY: entry };
  return { base, entry, binary, identity, prerequisite, env };
}
afterEach(() => { for (const base of fixtures.splice(0)) rmSync(base, { recursive: true, force: true }); });

test('only verified preparation publishes the compiler directory before CodeQL initialization', () => {
  const f = fixture(), output = path.join(f.base, 'github-path');
  expect(() => prepareCodeqlGo(f.base, { GITHUB_PATH: output }, () => ({ status: 'failed', reason: 'invalid-go-preparation', detail: 'fixture failure' }))).toThrow(/verified Go/);
  expect(existsSync(output)).toBe(false);
  prepareCodeqlGo(f.base, { GITHUB_PATH: output }, f.prerequisite);
  expect(readFileSync(output, 'utf8')).toBe(path.dirname(f.binary) + '\n');
  expect(() => prepareCodeqlGo(f.base, {}, f.prerequisite)).toThrow(/PATH output/);
});

test('build uses the exact init-selected entry, verifies its backend, and preserves tracing with an empty compiler cache', () => {
  const f = fixture(), inherited = { ...f.env, CODEQL_TRACER_LOG: 'fixture-trace', LD_PRELOAD: 'fixture-preload', PATH: 'fixture-action-path', GOROOT: 'spoofed-root' };
  const calls: any[] = [];
  const invoke = vi.fn((binary: string, args: string[], options: any) => {
    calls.push({ binary, args, env: { ...options.env } });
    expect(binary).toBe(f.entry); expect(options.env.GOROOT).toBeUndefined();
    expect(options.env).toMatchObject({ CODEQL_TRACER_LOG: 'fixture-trace', LD_PRELOAD: 'fixture-preload', PATH: 'fixture-action-path', GOTOOLCHAIN: 'local', GOENV: 'off', GOPROXY: 'off', GOSUMDB: 'off', GOVCS: '*:off', GOAUTH: 'off' });
    return args[0] === 'env' ? JSON.stringify(f.identity) : '';
  });
  buildCodeqlGo(f.base, inherited, invoke, f.prerequisite);
  expect(calls.map(call => call.args[0])).toEqual(['env', 'build']);
  expect(calls[1].args).toContain('-mod=readonly');
  expect(calls[1].env.GOCACHE.startsWith(path.join(f.base, '.work/codeql-build-'))).toBe(true);
  expect(f.prerequisite).toHaveBeenCalledTimes(2);
  // A newer CLI may explicitly select the original compiler rather than a wrapper.
  buildCodeqlGo(f.base, { CODEQL_ACTION_GO_BINARY: f.binary }, (_binary: string, args: string[]) => args[0] === 'env' ? JSON.stringify(f.identity) : '', f.prerequisite);
});

test('missing initialization or mismatched backend refuses before any build', () => {
  const f = fixture(), invoke = vi.fn();
  expect(() => buildCodeqlGo(f.base, {}, invoke, f.prerequisite)).toThrow(/tracing entry/);
  expect(invoke).not.toHaveBeenCalled();
  for (const change of [{ GOVERSION: 'go1.25.0' }, { GOROOT: f.base }, { GOOS: 'unexpected' }, { GOARCH: 'arm64' }]) {
    const wrong = vi.fn(() => JSON.stringify({ ...f.identity, ...change }));
    expect(() => buildCodeqlGo(f.base, f.env, wrong, f.prerequisite)).toThrow(/verified Go toolchain/);
    expect(wrong).toHaveBeenCalledTimes(1);
  }
  expect(() => buildCodeqlGo(f.base, f.env, () => { throw Error('entry failed'); }, f.prerequisite)).toThrow('entry failed');
  expect(() => buildCodeqlGo(f.base, f.env, (_binary: string, args: string[]) => {
    if (args[0] === 'env') return JSON.stringify(f.identity);
    throw Error('build failed');
  }, f.prerequisite)).toThrow('build failed');
});

test.skipIf(process.platform !== 'linux')('real shell entry forwards arguments and tracing environment to the backend', () => {
  const f = fixture(), program = path.join(f.base, 'go-fixture.cjs'), log = path.join(f.base, 'calls.jsonl');
  writeFileSync(program, `const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,trace:process.env.CODEQL_FIXTURE_TRACE})+'\\n');if(args[0]==='env')process.stdout.write(${JSON.stringify(JSON.stringify(f.identity))});else fs.writeFileSync(args[args.indexOf('-o')+1],'built');`);
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(f.entry, `#!/bin/bash\nexec ${quote(process.execPath)} ${quote(program)} "$@"\n`); chmodSync(f.entry, 0o755);
  buildCodeqlGo(f.base, { ...process.env, ...f.env, CODEQL_FIXTURE_TRACE: 'preserved' }, execFileSync, f.prerequisite);
  expect(readFileSync(path.join(f.base, '.work/codeql-caddy'), 'utf8')).toBe('built');
  expect(readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))).toEqual([
    { args: ['env', '-json', 'GOVERSION', 'GOROOT', 'GOOS', 'GOARCH'], trace: 'preserved' },
    { args: ['build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-o', path.join(f.base, '.work/codeql-caddy'), '.'], trace: 'preserved' },
  ]);
});

test('security workflow finishes preparation and PATH publication before init, then builds before analysis', () => {
  const workflow = readFileSync('.github/workflows/security.yml', 'utf8');
  const commands = ['actions/setup-node@', 'actions/setup-python@', 'python -B scripts/prepare-ci-go.py', 'node scripts/build-codeql-go.mjs --prepare', 'github/codeql-action/init@', 'run: node scripts/build-codeql-go.mjs\n', 'github/codeql-action/analyze@'];
  const positions = commands.map(command => workflow.indexOf(command));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(workflow.match(/python -B scripts\/prepare-ci-go.py/g)).toHaveLength(1);
  expect(workflow).toContain('language: go\n            build: manual');
});

test('helper, preparation and Security changes cannot omit the tracing-entry regression', () => {
  const inventory = testInventory(process.cwd()), regression = 'tests/tooling/codeql-go.test.ts';
  for (const name of ['scripts/build-codeql-go.mjs', 'scripts/prepare-ci-go.py', '.github/workflows/security.yml']) {
    expect(selectTests([name], inventory).groups.unit).toContain(regression);
    expect(selectTests([name], inventory.filter(file => file !== regression)).requiresFullAudit).toContainEqual({ path: regression, reason: 'missing-codeql-entry-regression' });
  }
});
