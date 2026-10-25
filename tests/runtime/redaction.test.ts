import { expect, test } from 'vitest';
import { DiagnosticRedactor } from '../../src/runtime/redaction.js';

test('native diagnostics mask configured provider keys and OAuth bearer/token values', () => {
  const provider = ['fixture', 'provider', 'value'].join('-'); const redactor = new DiagnosticRedactor({ HARNESS_PROVIDER_API_KEY: provider, AWS_BEARER_TOKEN_BEDROCK: 'fixture-bedrock-secret' });
  expect(redactor.text('upstream says fixture-bedrock-secret')).toBe('upstream says [redacted]');
  const result = redactor.value({ code: -32000, message: `Failure for ${provider}; Bearer local.fixture.token`, data: { authorization: 'Bearer opaque', refresh_token: 'opaque-refresh', url: 'https://local.invalid/?access_token=opaque-url&ok=1' } });
  expect(JSON.stringify(result)).not.toContain(provider); expect(JSON.stringify(result)).not.toContain('opaque'); expect(JSON.stringify(result)).not.toContain('local.fixture.token'); expect(JSON.stringify(result)).toContain('-32000'); expect(JSON.stringify(result)).toContain('ok=1');
});
