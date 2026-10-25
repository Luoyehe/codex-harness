import { expect, test } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { nativeTestEnvironment } from '../fixtures/native-env.js';

function home() {
  const parent = path.resolve('.work/native-env-tests'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'case-'));
  return { home: root, codexHome: path.join(root, 'codex'), temporary: path.join(root, 'tmp') };
}

test('native test environments discard inherited credentials, config loaders and proxy bypasses', () => {
  const options = home();
  const env = nativeTestEnvironment(options, {
    Path: 'fixture-system-path', SystemRoot: 'fixture-system-root',
    HOME: 'inherited-home', USERPROFILE: 'inherited-profile', CODEX_HOME: 'inherited-codex', APPDATA: 'inherited-appdata', TMPDIR: 'inherited-temporary',
    OPENAI_API_KEY: 'inherited-key', HARNESS_PROVIDER_API_KEY: 'inherited-provider', AWS_PROFILE: 'inherited-profile', PERSONAL_TEST_SETTING: 'inherited-value',
    NODE_OPTIONS: '--import inherited-code', PYTHONSTARTUP: 'inherited-code', GIT_CONFIG_GLOBAL: 'inherited-config',
    HTTP_PROXY: 'http://external.invalid', https_proxy: 'http://external.invalid', All_Proxy: 'http://external.invalid', NO_PROXY: '*', no_proxy: '*',
  });
  expect(env).toMatchObject({ HOME: options.home, USERPROFILE: options.home, CODEX_HOME: options.codexHome, TEMP: options.temporary, TMP: options.temporary, TMPDIR: options.temporary,
    APPDATA: path.join(options.home, 'appdata'), LOCALAPPDATA: path.join(options.home, 'localappdata'), PATH: 'fixture-system-path', SystemRoot: 'fixture-system-root',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost,::1,[::1]' });
  for (const name of ['OPENAI_API_KEY', 'HARNESS_PROVIDER_API_KEY', 'AWS_PROFILE', 'PERSONAL_TEST_SETTING', 'NODE_OPTIONS', 'PYTHONSTARTUP', 'https_proxy', 'All_Proxy', 'no_proxy']) expect(env[name]).toBeUndefined();
});

test('only explicitly supplied local provider credentials enter the isolated test environment', () => {
  const env = nativeTestEnvironment({ ...home(), fixtureApiKey: 'local-protocol-fixture' }, { HARNESS_PROVIDER_API_KEY: 'inherited-provider' });
  expect(env.HARNESS_PROVIDER_API_KEY).toBe('local-protocol-fixture');
});

test('misdirected test configuration and temp paths are rejected before directory creation', () => {
  const options = home();
  for (const changed of [{ codexHome: path.dirname(options.home) }, { temporary: path.dirname(options.home) }, { codexHome: options.home }, { home: 'relative-home' }]) {
    expect(() => nativeTestEnvironment({ ...options, ...changed }, {})).toThrow();
  }
});
