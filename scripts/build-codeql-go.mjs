import { execFileSync } from 'node:child_process';
import { appendFileSync, lstatSync, mkdtempSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { goPrerequisite } from './go-tests.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const execute = (file, args, options) => execFileSync(file, args, options);
function ready(base, env, prerequisite) {
  const prepared = prerequisite(base, env);
  if (prepared.status !== 'ready') throw Error('CodeQL requires the verified Go runtime and sealed module cache');
  return prepared;
}

export function prepareCodeqlGo(base = root, env = process.env, prerequisite = goPrerequisite) {
  const prepared = ready(base, env, prerequisite), directory = path.dirname(prepared.binary);
  if (!env.GITHUB_PATH || /[\r\n]/.test(directory)) throw Error('CodeQL Go preparation requires the Actions PATH output');
  appendFileSync(env.GITHUB_PATH, directory + '\n', 'utf8');
  return directory;
}

export function buildCodeqlGo(base = root, inherited = process.env, invoke = execute, prerequisite = goPrerequisite) {
  const prepared = ready(base, inherited, prerequisite), entry = inherited.CODEQL_ACTION_GO_BINARY;
  // The pinned Action records either its Linux tracing wrapper or the original
  // executable when the CLI supports static entrypoints. Never bypass that entry.
  if (!entry || !path.isAbsolute(entry) || !lstatSync(entry).isFile() || lstatSync(entry).isSymbolicLink())
    throw Error('CodeQL Go tracing entry is missing; prepare Go before CodeQL init');
  const env = { ...inherited, GOTOOLCHAIN: 'local', GOENV: 'off', GOWORK: 'off', GOTELEMETRY: 'off', CGO_ENABLED: '0',
    GOMODCACHE: prepared.moduleCache, GOPROXY: 'off', GOSUMDB: 'off', GOVCS: '*:off', GOAUTH: 'off' };
  // An inherited GOROOT can make a different compiler claim the prepared root.
  // Ask the actual init-selected entry without that override, then keep it absent.
  delete env.GOROOT;
  const options = { cwd: path.join(base, 'deploy/caddy_dns_source'), env };
  const identity = JSON.parse(invoke(entry, ['env', '-json', 'GOVERSION', 'GOROOT', 'GOOS', 'GOARCH'], {
    ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, maxBuffer: 64 * 1024,
  }));
  if (identity.GOVERSION !== `go${prepared.version}` || typeof identity.GOROOT !== 'string' ||
      realpathSync(identity.GOROOT) !== realpathSync(path.dirname(path.dirname(prepared.binary))) ||
      identity.GOOS !== prepared.manifest.platform || identity.GOARCH !== prepared.manifest.architecture)
    throw Error('CodeQL tracing entry does not use the verified Go toolchain');
  // A fresh cache guarantees real compilation even if the runner has built before.
  env.GOCACHE = mkdtempSync(path.join(base, '.work/codeql-build-'));
  invoke(entry, ['build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-o', path.join(base, '.work/codeql-caddy'), '.'], {
    ...options, stdio: 'inherit',
  });
  ready(base, inherited, prerequisite);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--prepare') prepareCodeqlGo();
  else if (process.argv.length === 2) buildCodeqlGo();
  else throw Error('Use --prepare before CodeQL init, or no argument to build after init');
}
