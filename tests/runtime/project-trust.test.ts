import { expect, test } from 'vitest';
import { ProjectTrust } from '../../src/runtime/project-trust.js';
import { object, type JsonObject } from '../../src/runtime/types.js';
test('exact trust edits preserve unrelated project fields and reject stale or implicit changes', async () => {
  const projects = { '/project': { note: 'retain', trust_level: 'untrusted' }, '/other': { trust_level: 'trusted', secret: 'preserve' } };
  const trust = new ProjectTrust(async () => ({ config: {}, origins: {}, layers: [{ name: { type: 'user', file: '/native/config.toml', profile: null }, config: { projects }, version: 'v1', disabledReason: null }] }));
  let written: JsonObject | undefined; const write = async (_method: string, params: unknown) => { written = object(params); return { status: 'ok', version: 'v2', filePath: '/native/config.toml', overriddenMetadata: null }; };
  expect(await trust.read('/project')).toMatchObject({ configuredTrust: 'untrusted', appliesTo: 'exact_registered_path' });
  await expect(trust.write({ expectedVersion: 'old', trustLevel: 'trusted', confirm: true }, '/project', write)).rejects.toHaveProperty('code', 'config_conflict');
  await expect(trust.write({ expectedVersion: 'v1', trustLevel: 'trusted' }, '/project', write)).rejects.toHaveProperty('delivery', 'not_sent'); expect(written).toBeUndefined();
  expect(await trust.write({ expectedVersion: 'v1', trustLevel: 'default', confirm: true }, '/project', write)).toMatchObject({ configuredTrust: null, appliesTo: 'next_project_load', hookTrustChanged: false });
  expect(written).toMatchObject({ expectedVersion: 'v1', edits: [{ keyPath: 'projects', value: { '/project': { note: 'retain' }, '/other': projects['/other'] }, mergeStrategy: 'replace' }] });
  expect(await trust.read('/not-configured')).toHaveProperty('configuredTrust', null);
});
