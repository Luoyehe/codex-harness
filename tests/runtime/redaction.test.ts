import { expect, test } from 'vitest';
import { DiagnosticRedactor } from '../../src/runtime/redaction.js';

test('native diagnostics mask configured provider keys and OAuth bearer/token values', () => {
  const provider = ['fixture', 'provider', 'value'].join('-'); const redactor = new DiagnosticRedactor({ HARNESS_PROVIDER_API_KEY: provider, AWS_BEARER_TOKEN_BEDROCK: 'fixture-bedrock-secret' });
  expect(redactor.text('upstream says fixture-bedrock-secret')).toBe('upstream says [redacted]');
  const result = redactor.value({ code: -32000, message: `Failure for ${provider}; Bearer local.fixture.token`, data: { authorization: 'Bearer opaque', refresh_token: 'opaque-refresh', url: 'https://local.invalid/?access_token=opaque-url&ok=1' } });
  expect(JSON.stringify(result)).not.toContain(provider); expect(JSON.stringify(result)).not.toContain('opaque'); expect(JSON.stringify(result)).not.toContain('local.fixture.token'); expect(JSON.stringify(result)).toContain('-32000'); expect(JSON.stringify(result)).toContain('ok=1');
});
test('generic short key variables do not corrupt diagnostics while credential arguments and URLs remain protected', () => {
  const redactor = new DiagnosticRedactor({ KEY: 'a', DISPLAY_KEY: 'e', API_KEY: 'tiny' });
  expect(redactor.text('ordinary message')).toBe('ordinary message');
  expect(redactor.text('tiny')).toBe('[redacted]');
  expect(redactor.value(['--api-key', 'private-fixture', '--mode', 'safe'])).toEqual(['--api-key', '[redacted]', '--mode', 'safe']);
  const credentialUrl = ['https://', 'user', ':', 'private', '@localhost/x'].join('');
  expect(redactor.text(credentialUrl + ' --token=private X_API_KEY=private')).not.toContain('private');
  for (let i = 0; i < 255; i++) redactor.addSecret('fixture-secret-' + i);
  expect(() => redactor.addSecret('last-fixture')).toThrow('结束当前任务'); expect(redactor.text('fixture-secret-1')).toBe('[redacted]');
});

test('managed multi-provider variables are masked as bare values, assignments and structured keys', () => {
  const key = 'HARNESS_PROVIDER_KEY_' + 'A1'.repeat(16);
  const defaultValue = ['fixture', 'default', 'credential'].join('-'), namedValue = ['fixture', 'named', 'credential'].join('-');
  const redactor = new DiagnosticRedactor({ HARNESS_PROVIDER_KEY_DEFAULT: defaultValue, [key]: namedValue, HARNESS_PROVIDER_KEY_DISPLAY: 'visible-label' });
  expect(redactor.text(`${defaultValue}; ${namedValue}; visible-label`)).toBe('[redacted]; [redacted]; visible-label');
  expect(redactor.value({ details: [{ HARNESS_PROVIDER_KEY_DEFAULT: 'unregistered-value', [key]: ['opaque-value'] }], code: 400 })).toEqual({ details: [{ HARNESS_PROVIDER_KEY_DEFAULT: '[redacted]', [key]: '[redacted]' }], code: 400 });
  const empty = new DiagnosticRedactor({});
  expect(empty.text(`HARNESS_PROVIDER_KEY_DEFAULT=unknown-one; "${key}": "unknown-two"`)).not.toMatch(/unknown-one|unknown-two/);
  expect(empty.text('HARNESS_PROVIDER_KEY_DISPLAY=visible-label')).toContain('visible-label');
});

test('expired temporary credentials release space while configured and newly registered credentials stay masked', () => {
  const redactor = new DiagnosticRedactor({ API_KEY: 'permanent-fixture-key', TOKEN: '1' });
  for (let i = 0; i < 320; i++) redactor.addSecret('temporary-fixture-' + i, Date.now() - 1);
  redactor.addSecret('latest-fixture-key');
  expect(redactor.text('permanent-fixture-key latest-fixture-key 100 1')).toBe('[redacted] [redacted] 100 [redacted]');
});
