import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isolatedTestEnvironment } from './test-environment.mjs';

export const goTestFile = 'deploy/caddy_dns_source/main_test.go';
export const goTestPattern = /^deploy\/caddy_dns_source\/[^/]+_test\.go$/;
const sourceNames = ['go.mod', 'go.sum', 'main.go', 'main_test.go'];
const packageName = 'codex-harness.invalid/caddy-dns';
const providerVersions = {
  alidns: 'v1.0.29', cloudflare: 'v0.2.4', digitalocean: 'v0.0.0-20250606074528-04bde2867106',
  huaweicloud: 'v1.0.1', route53: 'v1.6.2', tencentcloud: 'v0.4.3',
};
const archiveHashes = {
  linux: 'ccfe7ae822d2c2f41f4fe7c956199967a4dac22d0ee0d2b2bfdb440aab3b20c5',
  windows: '7ecd2d7260e82c59bcbd7f1077a07cee2dea607295b858df67195a1e4e09629b',
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const checks = ['module-verification', 'test-discovery', 'go-test', 'executable-build', 'version-plugin-probe'];

function ordinary(base, filename, kind = 'file') {
  const resolved = path.resolve(filename);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) throw Error('Go preparation must belong to this checkout');
  const parent = lstatSync(base);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw Error('Go checkout must be an ordinary directory');
  let current = path.resolve(base);
  for (const piece of path.relative(base, resolved).split(path.sep)) {
    current = path.join(current, piece);
    const info = lstatSync(current);
    if (info.isSymbolicLink() || (current === resolved && kind === 'file' ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())) throw Error('Go preparation requires ordinary paths');
  }
  return realpathSync(resolved);
}

function preparedPath(base, filename, folder, kind = 'file') {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || !path.resolve(filename).startsWith(path.resolve(base, folder) + path.sep)) throw Error('Go preparation path is outside its required workspace');
  return ordinary(base, filename, kind);
}

export function goSources(base) {
  return Object.fromEntries(sourceNames.map(name => [name, digest(readFileSync(ordinary(base, path.join(base, 'deploy/caddy_dns_source', name))))]));
}

export function goExpectedTests(base) {
  // The sealed recipe has one test file. Restrict declaration syntax deliberately;
  // Go's own discovery must agree before execution, so unsupported additions fail.
  const source = readFileSync(ordinary(base, path.join(base, goTestFile)), 'utf8');
  const names = [...source.matchAll(/^func\s+(Test[A-Za-z0-9_]+)\s*\(\s*\w+\s+\*testing\.T\s*\)/gm)].map(match => match[1]).sort();
  if (!names.length || new Set(names).size !== names.length) throw Error('Missing or duplicate Go test declarations');
  return names;
}

export function goPrerequisite(base, env = isolatedTestEnvironment(base)) {
  const filename = env.HARNESS_TEST_GO_MANIFEST || path.join(base, '.work/ci-go/prepared.json');
  if (!existsSync(filename)) return { status: 'skipped', reason: 'pinned-go-preparation-required', requiredVersion: '1.26.10' };
  try {
    preparedPath(base, filename, '.work');
    const manifest = JSON.parse(readFileSync(filename, 'utf8'));
    const platform = process.platform === 'win32' ? 'windows' : process.platform;
    if (!Object.hasOwn(archiveHashes, platform) || process.arch !== 'x64' || manifest.schemaVersion !== 1 || manifest.goVersion !== '1.26.10' || manifest.platform !== platform || manifest.architecture !== 'amd64' || manifest.archiveSha256 !== archiveHashes[platform]) throw Error('Pinned Go preparation metadata mismatch');
    preparedPath(base, manifest.binary, 'reference/runtime');
    preparedPath(base, manifest.archive, 'reference/runtime');
    preparedPath(base, manifest.moduleCache, '.work', 'directory');
    const sources = goSources(base);
    if (lstatSync(manifest.archive).size > 256 * 1024 ** 2 || lstatSync(manifest.binary).size > 256 * 1024 ** 2 || digest(readFileSync(manifest.binary)) !== manifest.goBinarySha256 || digest(readFileSync(manifest.archive)) !== manifest.archiveSha256 || !same(Object.keys(manifest.sources).sort(), sourceNames) || sourceNames.some(name => manifest.sources[name] !== sources[name])) throw Error('Prepared Go bytes or reviewed sources changed');
    return { status: 'ready', version: manifest.goVersion, binary: manifest.binary, moduleCache: manifest.moduleCache, manifest };
  } catch (error) { return { status: 'failed', reason: 'invalid-go-preparation', detail: error.message }; }
}

export function parseGoEvents(output, expected, exitCode) {
  const cases = new Map(); const started = new Set(); let packageTerminal; let packageStarted = false; let reason;
  try {
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.Package !== packageName || typeof event.Action !== 'string') throw Error('Unexpected Go package or event');
      if (packageTerminal) throw Error('Go event after package completion');
      if (event.Test !== undefined) {
        if (typeof event.Test !== 'string' || !expected.includes(event.Test.split('/')[0])) throw Error('Unexpected Go test identity');
        const name = event.Test;
        if (event.Action === 'run') {
          if (started.has(name)) throw Error('Duplicate Go test start');
          started.add(name);
        } else if (['pass', 'fail', 'skip'].includes(event.Action)) {
          if (!started.has(name) || cases.has(name)) throw Error('Missing or duplicate Go test lifecycle');
          cases.set(name, { id: `${goTestFile}::${name}`, file: goTestFile, status: { pass: 'passed', fail: 'failed', skip: 'skipped' }[event.Action] });
        } else if (!['output', 'pause', 'cont'].includes(event.Action)) throw Error('Unexpected Go test action');
      } else if (['pass', 'fail', 'skip'].includes(event.Action)) packageTerminal = event.Action;
      else if (event.Action === 'start') { if (packageStarted) throw Error('Duplicate Go package start'); packageStarted = true; }
      else if (!['output', 'build-output'].includes(event.Action)) throw Error('Unexpected or failed Go package action');
    }
    if (!packageStarted || !packageTerminal || packageTerminal === 'skip' || expected.some(name => !cases.has(name)) || [...started].some(name => !cases.has(name))) throw Error('Incomplete Go test execution');
    if (exitCode !== 0 || packageTerminal !== 'pass' || [...cases.values()].some(item => item.status === 'failed')) throw Error('Go test process or package failed');
  } catch (error) { reason = error.message; }
  const values = [...cases.values()].sort((a, b) => a.id.localeCompare(b.id));
  const code = reason ? 1 : values.some(item => item.status === 'skipped') ? 3 : 0;
  return { status: code === 0 ? 'passed' : code === 3 ? 'skipped' : 'failed', exitCode: code, cases: values, observedTests: [...started].sort(), ...(reason ? { reason } : {}) };
}

export function validateGoResult(result, base) {
  const expected = goExpectedTests(base);
  if (!result || !same(result.tests, [goTestFile]) || !same(result.expectedTopLevel, expected) || !same(result.sources, goSources(base)) || !Array.isArray(result.cases) || !Array.isArray(result.observedTests) || !Array.isArray(result.checks) || ![0, 3].includes(result.exitCode) || result.status !== (result.exitCode === 0 ? 'passed' : 'skipped') || result.runtime?.version !== '1.26.10' || result.runtime?.architecture !== 'amd64' || !Object.hasOwn(archiveHashes, result.runtime?.platform)) throw Error('Incomplete source-bound Go evidence');
  if (!same(result.checks.map(item => item.name), checks) || result.checks.some(item => item.file !== goTestFile || item.status !== 'passed' || item.exitCode !== 0)) throw Error('Required Go verification, compilation or probe was not completed');
  const ids = new Set();
  for (const item of result.cases) {
    if (item.file !== goTestFile || typeof item.id !== 'string' || !item.id.startsWith(goTestFile + '::') || !expected.includes(item.id.slice(goTestFile.length + 2).split('/')[0]) || !['passed', 'skipped'].includes(item.status) || ids.has(item.id)) throw Error('Invalid Go case evidence');
    ids.add(item.id);
  }
  if (!same([...ids].sort(), result.observedTests.map(name => `${goTestFile}::${name}`).sort()) || expected.some(name => !ids.has(`${goTestFile}::${name}`)) || result.exitCode !== (result.cases.some(item => item.status === 'skipped') ? 3 : 0)) throw Error('Go top-level coverage or skip evidence is incomplete');
  return true;
}

export function runGoTests(files, base, inherited = isolatedTestEnvironment(base), dependencies = {}) {
  const result = { status: 'failed', exitCode: 1, tests: files, cases: [], checks: [] };
  if (!same(files, [goTestFile])) return { ...result, reason: 'go-selection-must-cover-exact-sealed-package' };
  const ready = (dependencies.goPrerequisite ?? goPrerequisite)(base, inherited);
  if (ready.status !== 'ready') return { ...result, ...ready, exitCode: ready.status === 'skipped' ? 3 : 1 };
  const invoke = dependencies.spawnSync ?? spawnSync;
  try {
    result.sources = goSources(base); result.expectedTopLevel = goExpectedTests(base);
    result.runtime = { version: '1.26.10', platform: ready.manifest.platform, architecture: 'amd64' };
    const parent = path.join(base, '.work/go-test-runs'); mkdirSync(parent, { recursive: true });
    const directory = mkdtempSync(path.join(parent, 'run-'));
    const source = path.join(directory, 'source'); mkdirSync(source);
    for (const name of sourceNames) cpSync(path.join(base, 'deploy/caddy_dns_source', name), path.join(source, name));
    const cache = path.join(directory, 'modules');
    let count = 0; let bytes = 0;
    cpSync(ready.moduleCache, cache, { recursive: true, filter: filename => {
      const info = lstatSync(filename); count++;
      if (info.isSymbolicLink() || !info.isDirectory() && (!info.isFile() || info.nlink !== 1)) throw Error('Non-ordinary prepared module cache');
      if (info.isFile()) bytes += info.size;
      if (count > 150000 || bytes > 3 * 1024 ** 3 || info.isFile() && info.size > 256 * 1024 ** 2) throw Error('Go module cache copy budget exceeded');
      return true;
    } });
    const env = { ...isolatedTestEnvironment(base, inherited), GOTOOLCHAIN: 'local', GOENV: 'off', GOWORK: 'off', GOTELEMETRY: 'off', GOVCS: '*:off', GOAUTH: 'off',
      GOMAXPROCS: '2', GOFLAGS: '-mod=readonly', CGO_ENABLED: '0', GOOS: ready.manifest.platform, GOARCH: 'amd64', GOPROXY: 'off', GOSUMDB: 'off',
      GOPRIVATE: '', GONOPROXY: 'none', GONOSUMDB: 'none', GOPATH: path.join(directory, 'gopath'), GOMODCACHE: cache, GOCACHE: path.join(directory, 'cache') };
    const execute = (name, binary, args, timeout = 900000) => {
      const child = invoke(binary, args, { cwd: source, env, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true, shell: false });
      const passed = !child.error && child.status === 0;
      result.checks.push({ name, file: goTestFile, status: passed ? 'passed' : 'failed', exitCode: child.status ?? 1 });
      if (name !== 'go-test' && !passed) throw Error(`${name} failed: ${(child.error?.message || child.stderr || '').slice(0, 4096)}`);
      return child;
    };
    execute('module-verification', ready.binary, ['mod', 'verify'], 120000);
    const discovered = execute('test-discovery', ready.binary, ['test', '-p=2', '-list', '^Test', '.']);
    const names = discovered.stdout.split(/\r?\n/).filter(line => /^Test\S+$/.test(line)).sort();
    if (!same(names, result.expectedTopLevel)) throw Error('Go discovery differs from source test declarations');
    const tested = execute('go-test', ready.binary, ['test', '-json', '-p=2', '-count=1', '-timeout=120s', '.']);
    const parsed = parseGoEvents(tested.stdout || '', result.expectedTopLevel, tested.error ? 1 : tested.status);
    result.cases = parsed.cases; result.observedTests = parsed.observedTests;
    if (parsed.exitCode === 1) throw Error(parsed.reason);
    const binary = path.join(directory, process.platform === 'win32' ? 'caddy.exe' : 'caddy');
    execute('executable-build', ready.binary, ['build', '-p=2', '-trimpath', '-buildvcs=false', '-ldflags=-buildid=', '-o', binary, '.']);
    const probe = execute('version-plugin-probe', binary, ['harness-dns-build-check'], 30000);
    const proof = JSON.parse(probe.stdout);
    if (!proof || !same(Object.keys(proof).sort(), ['caddyVersion', 'goVersion', 'providers']) ||
        proof.goVersion !== 'go1.26.10' || proof.caddyVersion !== 'v2.11.7' || !proof.providers ||
        !same(Object.keys(proof.providers).sort(), Object.keys(providerVersions)) ||
        Object.entries(providerVersions).some(([name, version]) => proof.providers[name] !== version)) throw Error('Compiled Caddy version/plugin probe mismatch');
    if (!same(result.sources, goSources(base)) || sourceNames.some(name => digest(readFileSync(path.join(source, name))) !== result.sources[name]) || digest(readFileSync(ready.binary)) !== ready.manifest.goBinarySha256) throw Error('Go source, lock or runtime changed during execution');
    result.status = parsed.status; result.exitCode = parsed.exitCode;
    validateGoResult(result, base);
    return result;
  } catch (error) { return { ...result, status: 'failed', exitCode: 1, reason: error.message }; }
}
