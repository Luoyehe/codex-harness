import { mkdirSync } from 'node:fs';
import path from 'node:path';

interface NativeTestHome { home: string; codexHome: string; temporary: string; fixtureApiKey?: string }
const systemKeys = ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'SystemDrive'];

/** Real CLI tests use fresh homes and permit only their explicit loopback services. */
export function nativeTestEnvironment(options: NativeTestHome, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { home, codexHome, temporary } = options;
  if (![home, codexHome, temporary].every(value => path.isAbsolute(value) && path.resolve(value) === value)) throw new Error('Native tests require absolute normalized homes');
  for (const child of [codexHome, temporary]) {
    const relative = path.relative(home, child);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Native test configuration and temporary files must remain inside the isolated home');
  }
  const env: NodeJS.ProcessEnv = {};
  for (const key of systemKeys) {
    const original = Object.keys(inherited).find(name => name.toLowerCase() === key.toLowerCase());
    if (original !== undefined && inherited[original] !== undefined) env[key] = inherited[original];
  }
  const appData = path.join(home, 'appdata'), localAppData = path.join(home, 'localappdata');
  for (const directory of [codexHome, temporary, appData, localAppData]) mkdirSync(directory, { recursive: true });
  Object.assign(env, {
    HOME: home, USERPROFILE: home, CODEX_HOME: codexHome, TEMP: temporary, TMP: temporary, TMPDIR: temporary,
    APPDATA: appData, LOCALAPPDATA: localAppData,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost,::1,[::1]',
  });
  if (options.fixtureApiKey !== undefined) env.HARNESS_PROVIDER_API_KEY = options.fixtureApiKey;
  return env;
}
