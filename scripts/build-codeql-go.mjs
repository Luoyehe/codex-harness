import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { goPrerequisite } from './go-tests.mjs';

const base = fileURLToPath(new URL('..', import.meta.url));
const prepared = goPrerequisite(base);
if (prepared.status !== 'ready') throw Error('CodeQL requires the verified Go runtime and sealed module cache');
execFileSync(prepared.binary, ['build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-o', path.join(base, '.work/codeql-caddy'), '.'], {
  cwd: path.join(base, 'deploy/caddy_dns_source'), stdio: 'inherit', windowsHide: true,
  // Keep CodeQL's tracing environment while sealing toolchain and dependencies.
  env: { ...process.env, GOTOOLCHAIN: 'local', GOENV: 'off', GOWORK: 'off', GOTELEMETRY: 'off', CGO_ENABLED: '0',
    GOMODCACHE: prepared.moduleCache, GOPROXY: 'off', GOSUMDB: 'off', GOVCS: '*:off', GOAUTH: 'off' },
});
