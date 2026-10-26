import { expect, test } from 'vitest';
// @ts-expect-error Repository tooling intentionally executes as plain ESM.
import { compatibilityReport } from '../../scripts/compatibility-watch.mjs';
test('official stable metadata must agree with the pinned CLI; drift never upgrades automatically', () => {
  const release = { tag_name: 'rust-v0.164.0', draft: false, prerelease: false };
  expect(compatibilityReport('0.164.0', { version: '0.164.0' }, release).status).toBe('current');
  expect(compatibilityReport('0.164.0', { version: '0.165.0' }, release).status).toBe('review-required');
  for (const bad of [{}, { ...release, prerelease: true }, { ...release, tag_name: 'rust-v0.165.0-beta.1' }]) expect(() => compatibilityReport('0.164.0', { version: '0.164.0' }, bad)).toThrow();
});
