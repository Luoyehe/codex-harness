import { afterEach, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { goExpectedTests, goPrerequisite, goSources, goTestFile, parseGoEvents, runGoTests, validateGoResult } from '../../scripts/go-tests.mjs';
import { reconcileCi, selectCiPlan } from '../../scripts/ci-checks.mjs';
import { prepareRun, executePlan } from '../../scripts/run-tests.mjs';
import { selectTests, testInventory } from '../../scripts/select-tests.mjs';

const roots: string[] = [];
const dnsPortableFile = 'tests/deploy/test_dns_caddy_build.py';
const dnsRootFile = 'tests/deploy/root/test_dns_caddy_build.py';
const dnsCoverage = [dnsPortableFile, dnsRootFile, goTestFile];
const dnsChanges = ['deploy/caddy_dns_source/main.go', 'deploy/caddy_dns_source/go.mod', 'deploy/caddy_dns_source/go.sum', 'deploy/dns_caddy_build.py', ...dnsCoverage];
const names = ['TestAliDNSDeadlineAndBodyLifetime', 'TestBuildPinsRejectMissingChangedOrReplacedDependency', 'TestEarlierParentDeadlineAndCancellationSurvive', 'TestOtherDestinationsAreUnchanged', 'TestProviderCaddyfileFields', 'TestTransportFailureCancelsTimer'];
const subtests = ['https://example.invalid/', 'http://alidns.aliyuncs.com/', 'https://alidns.aliyuncs.com.example.invalid/'].map(name => `TestOtherDestinationsAreUnchanged/${name}`);
const packageName = 'codex-harness.invalid/caddy-dns';
const proof = { caddyVersion: 'v2.11.7', goVersion: 'go1.26.10', providers: {
  alidns: 'v1.0.29', cloudflare: 'v0.2.4', digitalocean: 'v0.0.0-20250606074528-04bde2867106',
  huaweicloud: 'v1.0.1', route53: 'v1.6.2', tencentcloud: 'v0.4.3',
} };
function fixture() {
  const parent = path.resolve('.work/go-runner-regressions'); mkdirSync(parent, { recursive: true });
  const base = mkdtempSync(path.join(parent, 'case-')); roots.push(base);
  for (const name of ['main.go', 'main_test.go', 'go.mod', 'go.sum']) {
    const filename = path.join(base, 'deploy/caddy_dns_source', name); mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, readFileSync(path.resolve('deploy/caddy_dns_source', name)));
  }
  for (const name of [dnsPortableFile, dnsRootFile]) {
    const filename = path.join(base, name); mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, '# Selection fixture: never executed.\n');
  }
  return base;
}
function events() {
  return [{ Package: packageName, Action: 'start' }, ...[...names, ...subtests].flatMap(Test => [{ Package: packageName, Action: 'run', Test }, { Package: packageName, Action: 'pass', Test }]), { Package: packageName, Action: 'pass' }];
}
const json = (items: any[]) => items.map(item => JSON.stringify(item)).join('\n') + '\n';
function successful(base: string) {
  return { ...parseGoEvents(json(events()), names, 0), runtime: { version: '1.26.10', platform: 'linux', architecture: 'amd64' }, tests: [goTestFile], expectedTopLevel: names, sources: goSources(base), checks: ['module-verification', 'test-discovery', 'go-test', 'executable-build', 'version-plugin-probe'].map(name => ({ name, file: goTestFile, status: 'passed', exitCode: 0 })) };
}
afterEach(() => { for (const base of roots.splice(0)) rmSync(base, { recursive: true, force: true }); });

test('Go enters discovery, affected selection and exact targeted plans', () => {
  const base = fixture(); const extra = 'tests/tooling/other.test.ts'; mkdirSync(path.join(base, 'tests/tooling'), { recursive: true }); writeFileSync(path.join(base, extra), '');
  expect(testInventory(base)).toEqual([...dnsCoverage, extra].sort());
  expect(prepareRun('--targeted', [goTestFile], base).files).toEqual([goTestFile]);
  const inventory = testInventory(base);
  for (const changed of dnsChanges) {
    const plan = selectTests([changed], inventory);
    expect(plan.status).toBe('selected');
    expect(plan.groups.go).toEqual([goTestFile]);
    expect(plan.groups.deploy).toEqual([dnsPortableFile]);
    expect(plan.groups['deploy-root']).toEqual([dnsRootFile]);
  }
  expect(goExpectedTests(base)).toEqual(names);
});

test('DNS source and regression changes fail closed when any required identity coverage is absent', () => {
  const inventory = [...dnsCoverage, 'tests/tooling/other.test.ts'];
  for (const changed of dnsChanges) {
    for (const missing of dnsCoverage) {
      const plan = selectTests([changed], inventory.filter(name => name !== missing));
      expect(plan.status).toBe('requires-full-audit');
      expect(plan.requiresFullAudit).toContainEqual(expect.objectContaining({ path: missing }));
    }
  }
});

test('JSON parsing retains terminal cases and full subtest URLs', () => {
  const result = parseGoEvents(json(events()), names, 0);
  expect(result.status).toBe('passed'); expect(result.cases).toHaveLength(names.length + subtests.length);
  for (const name of subtests) expect(result.cases).toContainEqual({ file: goTestFile, id: `${goTestFile}::${name}`, status: 'passed' });
});

test('failed and skipped children remain visible even when their parent passes', () => {
  for (const [action, status, exitCode] of [['fail', 'failed', 1], ['skip', 'skipped', 3]] as const) {
    const changed = events(); changed.find(event => event.Test === subtests[0] && event.Action === 'pass')!.Action = action;
    const result = parseGoEvents(json(changed), names, action === 'fail' ? 1 : 0);
    expect(result).toMatchObject({ status, exitCode });
    expect(result.cases).toContainEqual({ file: goTestFile, id: `${goTestFile}::${subtests[0]}`, status });
  }
});

test('missing, duplicate, truncated, foreign and empty Go evidence all fail closed', () => {
  const variants = [
    events().filter(event => event.Test !== names[0]),
    events().filter(event => !(event.Test === subtests[0] && event.Action === 'pass')),
    [...events().slice(0, -1), { Package: packageName, Test: names[0], Action: 'pass' }, events().at(-1)],
    events().slice(0, -1),
    events().map((event, index) => index === 0 ? { ...event, Package: 'unexpected/package' } : event),
    [{ Package: packageName, Action: 'start' }, { Package: packageName, Action: 'pass' }],
    [{ Package: packageName, Action: 'build-fail', Output: 'compile error' }],
  ];
  for (const value of variants) expect(parseGoEvents(json(value), names, 0).exitCode).toBe(1);
  expect(parseGoEvents(json(events()) + '{', names, 0).exitCode).toBe(1);
  expect(parseGoEvents(json(events()), names, 124).exitCode).toBe(1);
});

test('missing preparation is explicit and a Go prerequisite blocks mixed-engine execution', () => {
  const base = fixture(); expect(goPrerequisite(base, {})).toMatchObject({ status: 'skipped', reason: 'pinned-go-preparation-required' });
  expect(runGoTests([goTestFile], base, {})).toMatchObject({ status: 'skipped', exitCode: 3, cases: [] });
  const js = vi.fn(); const go = vi.fn();
  expect(executePlan({ files: [goTestFile, 'tests/tooling/other.test.ts'] }, base, { runVitest: js, runGoTests: go }, {}).status).toBe('skipped');
  expect(js).not.toHaveBeenCalled(); expect(go).not.toHaveBeenCalled();
});

test('runner uses isolated offline state, compiles the executable, and checks its pinned plugin', () => {
  const base = fixture(); const cache = path.join(base, '.work/prepared/modules'); mkdirSync(cache, { recursive: true });
  const binary = path.join(base, '.work/prepared/go-fixture'); writeFileSync(binary, 'fixture');
  const ready = { status: 'ready', binary, moduleCache: cache, manifest: { platform: process.platform === 'win32' ? 'windows' : 'linux', goBinarySha256: createHash('sha256').update('fixture').digest('hex') } };
  const spawned = vi.fn((_binary: string, args: string[], options: any) => {
    expect(options.env).toMatchObject({ GOTOOLCHAIN: 'local', GOENV: 'off', GOWORK: 'off', GOAUTH: 'off', GOPROXY: 'off', GOFLAGS: '-mod=readonly' });
    expect(options.env.HOME).not.toBe('personal-home'); expect(options.env.OPENAI_API_KEY).toBeUndefined();
    expect(options.env.GOMODCACHE).not.toBe(cache); expect(options.env.GOCACHE.startsWith(path.join(base, '.work'))).toBe(true);
    return { status: 0, stdout: args.includes('-list') ? names.join('\n') : args.includes('-json') ? json(events()) : args[0] === 'harness-dns-build-check' ? JSON.stringify(proof) + '\n' : '', stderr: '' };
  });
  const result = runGoTests([goTestFile], base, { HOME: 'personal-home', OPENAI_API_KEY: 'fixture' }, { goPrerequisite: () => ready, spawnSync: spawned });
  expect(result.status, result.reason).toBe('passed'); expect(result.cases).toHaveLength(names.length + subtests.length);
  expect(spawned.mock.calls.map(call => call[1][0])).toEqual(['mod', 'test', 'test', 'build', 'harness-dns-build-check']);
  const failed = runGoTests([goTestFile], base, {}, { goPrerequisite: () => ready, spawnSync: () => ({ status: 1, stdout: '', stderr: 'fixture compile failure' }) });
  expect(failed).toMatchObject({ status: 'failed', cases: [], checks: [{ name: 'module-verification', status: 'failed' }] });
  const wrongProvider = runGoTests([goTestFile], base, {}, { goPrerequisite: () => ready, spawnSync: (binary: string, args: string[], options: any) =>
    args[0] === 'harness-dns-build-check' ? { status: 0, stdout: JSON.stringify({ ...proof, providers: { ...proof.providers, tencentcloud: 'v0.4.2' } }), stderr: '' } : spawned(binary, args, options) });
  expect(wrongProvider.status).toBe('failed'); expect(wrongProvider.reason).toMatch(/version\/plugin probe mismatch/);
});

test('CI reconciliation requires all Go top levels, observed subtests and actual build/probe checks', () => {
  const base = fixture(); const head = 'a'.repeat(40), sourceDigest = 'b'.repeat(64);
  const plan = selectCiPlan({ changed: [goTestFile], available: [...dnsCoverage, 'tests/tooling/other.test.ts'], head, sourceDigest });
  expect(plan.targets).toEqual(['linux', 'windows', 'linux-root']);
  expect(plan.standardFiles).toEqual([goTestFile, dnsPortableFile]);
  expect(plan.rootFiles).toEqual([dnsRootFile]);
  const go = successful(base);
  // Portable and privileged cases retain distinct file-scoped identities.
  const python = { id: `${dnsPortableFile}::DnsCaddyBuildTests.test_real_source_lock_and_architecture_are_recipe_inputs`, file: dnsPortableFile, status: 'passed' };
  const privileged = { id: `${dnsRootFile}::DnsCaddyBuildTests.test_initial_install_accepts_only_exact_pinned_user_owned_recipe`, file: dnsRootFile, status: 'passed' };
  const reports = plan.targets.map((target: string) => ({ target, head, sourceDigest, sourceDigestAfter: sourceDigest,
    files: target === 'linux-root' ? plan.rootFiles : plan.standardFiles, exitCode: 0,
    cases: target === 'linux-root' ? [privileged] : [...go.cases, python],
    results: target === 'linux-root' ? [] : [{ group: 'go', ...go, runtime: { ...go.runtime, platform: target } }],
  }));
  expect(validateGoResult(go, base)).toBe(true); expect(reconcileCi(plan, reports, base).cases).toBe(names.length + subtests.length + 2);
  for (const mutate of [
    (value: any) => value.cases.splice(0, 1),
    (value: any) => value.checks.pop(),
    (value: any) => value.expectedTopLevel.pop(),
    (value: any) => value.sources['main.go'] = 'f'.repeat(64),
  ]) { const changed = structuredClone(go); mutate(changed); expect(() => validateGoResult(changed, base)).toThrow(); }
  const changed = structuredClone(reports); changed[0].results = []; expect(() => reconcileCi(plan, changed, base)).toThrow(/Go execution/);
  expect(() => reconcileCi(plan, reports.filter(report => report.target !== 'linux-root'), base)).toThrow(/Every expected platform/);
  const skippedRoot = structuredClone(reports); skippedRoot[2].exitCode = 3; skippedRoot[2].cases[0].status = 'skipped';
  expect(() => reconcileCi(plan, skippedRoot, base)).toThrow(/Uncovered platform skips/);
});
