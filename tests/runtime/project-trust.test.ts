import path from 'node:path';
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

test('verified repository and linked-primary trust remain visible with or without a local project config', async () => {
  const linked = path.resolve('linked'), primary = path.resolve('primary'), outside = path.resolve('outside');
  const projects = { [outside]: { trust_level: 'trusted' }, [primary]: { trust_level: 'trusted' } };
  const user = { name: { type: 'user', file: path.resolve('native', 'config.toml'), profile: null }, config: { projects }, version: 'v1', disabledReason: null };
  const layer = { name: { type: 'project', dotCodexFolder: path.join(linked, '.codex') }, config: {}, version: 'project', disabledReason: null };
  for (const present of [true, false]) {
    const trust = new ProjectTrust(async () => ({ config: { projects }, origins: {}, layers: present ? [layer, user] : [user] }), async () => ({ roots: [linked, primary] }));
    await expect(trust.read(path.join(linked, 'child').split(path.sep).join('/'))).resolves.toMatchObject({ effectiveTrust: 'trusted', trustSourcePath: primary, trustEvidence: present ? 'native_project_layer' : 'native_project_root', configuredTrust: null });
  }
  const withoutRepository = new ProjectTrust(async () => ({ config: { projects }, origins: {}, layers: [user] }), async () => ({ roots: [] }));
  await expect(withoutRepository.read(path.join(outside, 'child'))).resolves.toMatchObject({ trustSourcePath: null, effectiveTrust: null });
});

test('a filesystem-root layer applies to descendants while a sibling prefix supplies no layer evidence', async () => {
  const cwd = path.resolve('checkout-other', 'child');
  const repository = path.resolve('primary'), projects = { [repository]: { trust_level: 'trusted' } };
  const user = { name: { type: 'user', file: path.resolve('native/config.toml'), profile: null }, config: { projects }, version: 'v1', disabledReason: null };
  for (const [root, applicable] of [[path.parse(cwd).root, true], [path.resolve('checkout'), false]] as const) {
    const layer = { name: { type: 'project', dotCodexFolder: path.join(root, '.codex') }, config: {}, version: 'p1', disabledReason: null };
    const trust = new ProjectTrust(async () => ({ config: { projects }, origins: {}, layers: [layer, user] }), async () => ({ roots: [repository] }));
    await expect(trust.read(cwd)).resolves.toMatchObject({
      effectiveTrust: applicable ? 'trusted' : null,
      trustEvidence: applicable ? 'native_project_layer' : 'unobserved',
    });
  }
});
