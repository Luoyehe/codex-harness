import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';

export function isolatedPaths(base, rootFixtures = false) {
  const parent = path.join(base, '.work/test-homes'); mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(path.join(parent, 'run-'));
  // Root fixtures drop UID. Their temp ancestor must be traversable even when
  // the checkout and the test home are private; never use inherited TMPDIR.
  const temporary = rootFixtures && process.platform !== 'win32' ? mkdtempSync('/tmp/harness-test-root-') : path.join(home, 'tmp');
  if (temporary !== path.join(home, 'tmp')) chmodSync(temporary, 0o755); else mkdirSync(temporary);
  for (const folder of ['appdata', 'localappdata', 'config', 'cache', 'data', 'state']) mkdirSync(path.join(home, folder));
  return { home, temporary };
}

/** Share one allowlist across local and CI runners; never copy host credentials. */
export function isolatedTestEnvironment(base, inherited = process.env, { rootFixtures = process.getuid?.() === 0 } = {}) {
  const { home, temporary } = isolatedPaths(base, rootFixtures);
  const env = {};
  for (const key of ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'SystemDrive', 'HARNESS_TEST_PYTHON', 'HARNESS_TEST_NODE', 'HARNESS_TEST_CODEX_BIN']) {
    const found = Object.keys(inherited).find(name => name.toLowerCase() === key.toLowerCase());
    if (found !== undefined && inherited[found] !== undefined) env[key] = inherited[found];
  }
  return Object.assign(env, {
    HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, 'codex'),
    TMP: temporary, TEMP: temporary, TMPDIR: temporary,
    APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'),
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'), XDG_DATA_HOME: path.join(home, 'data'), XDG_STATE_HOME: path.join(home, 'state'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', LANG: 'C.UTF-8', NO_COLOR: '1',
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost,[::1]',
  });
}

/** Public CLI planning also invokes Git, before any test subprocess exists. */
export function isolateTestProcess(base, options) {
  const env = isolatedTestEnvironment(base, process.env, options);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  return env;
}
