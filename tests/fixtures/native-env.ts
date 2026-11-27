import { mkdirSync } from 'node:fs';
import path from 'node:path';

interface NativeTestHome { home: string; codexHome: string; temporary: string; fixtureApiKey?: string }

/** The targeted runner verifies this executable before starting native tests. */
export function nativeTestBinary(): string {
  const binary = process.env.HARNESS_TEST_CODEX_BIN;
  if (!binary || !path.isAbsolute(binary)) throw new Error('Set HARNESS_TEST_CODEX_BIN to the absolute path of the pinned Codex CLI');
  return binary;
}

/** Real CLI tests use fresh homes and permit only their explicit loopback services. */
export function nativeTestEnvironment(options: NativeTestHome, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { home, codexHome, temporary } = options;
  if (![home, codexHome, temporary].every(value => path.isAbsolute(value) && path.resolve(value) === value)) throw new Error('Native tests require absolute normalized homes');
  for (const child of [codexHome, temporary]) {
    const relative = path.relative(home, child);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Native test configuration and temporary files must remain inside the isolated home');
  }
  const env: NodeJS.ProcessEnv = {};
  if (inherited.PATH !== undefined) env.PATH = inherited.PATH;
  for (const directory of [codexHome, temporary]) mkdirSync(directory, { recursive: true });
  Object.assign(env, {
    HOME: home, CODEX_HOME: codexHome, TMPDIR: temporary,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost,::1,[::1]',
  });
  if (options.fixtureApiKey !== undefined) env.HARNESS_PROVIDER_API_KEY = options.fixtureApiKey;
  return env;
}
