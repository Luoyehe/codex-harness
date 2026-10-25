import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PluginSharing } from '../../src/runtime/plugin-sharing.js';
import { Feedback } from '../../src/runtime/feedback.js';
import { object, type JsonObject, type JsonValue } from '../../src/runtime/types.js';
import { receiptResult } from '../../src/gateway/receipt-result.js';
const plugin: JsonObject = { id: 'fixture@test', remotePluginId: 'remote', version: '1', localVersion: null, name: 'fixture', shareContext: null, source: { type: 'local', path: '/project/plugin' }, installed: true, installedAt: null, enabled: true, installPolicy: 'AVAILABLE', installPolicySource: null, mustShowInstallationInterstitial: null, authPolicy: 'ON_USE', availability: 'AVAILABLE', disabledReason: null, eligiblePlanTypes: null, interface: null, keywords: [] };
function sharing() {
  let revision = 'a'.repeat(64), version = '1'; const writes: { method: string; params: JsonObject }[] = [];
  const service = new PluginSharing({ native: async () => ({ data: [{ plugin: { ...plugin, version }, localPluginPath: '/project/plugin' }] }), select: async () => ({ plugin, locator: {} }), preview: async () => ({ path: '/project/plugin', files: [{ path: '.codex-plugin/plugin.json', bytes: 2, sha256: 'b'.repeat(64) }], totalBytes: 2, revision }) });
  const write = async (method: string, input: JsonValue): Promise<JsonValue> => { writes.push({ method, params: object(input) }); if (method.endsWith('/save')) return { remotePluginId: 'remote', shareUrl: 'https://chatgpt.com/plugin/fixture', canPublishToWorkspace: false }; if (method.endsWith('/updateTargets')) return { principals: [], discoverability: 'PRIVATE' }; return {}; };
  return { service, writes, write, change: () => { revision = 'c'.repeat(64); }, remoteChange: () => { version = '2'; } };
}
test('plugin saving binds fresh file inventory and explicit audience without accepting raw paths', async () => {
  const f = sharing(), preview = await f.service.preview({ cwd: '/project', pluginId: plugin.id! });
  const params = { cwd: '/project', pluginId: plugin.id!, previewHash: preview.previewHash!, discoverability: 'PRIVATE', shareTargets: [], confirm: true };
  await expect(f.service.mutate('plugin/share/save', { ...params, confirm: false }, f.write)).rejects.toHaveProperty('code', 'invalid_params');
  await expect(f.service.mutate('plugin/share/save', { ...params, pluginPath: '/secret' }, f.write)).rejects.toHaveProperty('delivery', 'not_sent');
  const result = await f.service.mutate('plugin/share/save', params, f.write); expect(receiptResult('plugin/share/save', result)).toHaveProperty('remotePluginId', 'remote');
  expect(f.writes[0]!.params).toEqual({ pluginPath: '/project/plugin', remotePluginId: null, discoverability: 'PRIVATE', shareTargets: [] });
  f.change(); await expect(f.service.mutate('plugin/share/save', params, f.write)).rejects.toHaveProperty('code', 'share_changed'); expect(f.writes).toHaveLength(1);
});
test('share mutations require a fresh existing remote identity and distinct principals', async () => {
  const f = sharing(); const selected = object((await f.service.list({})).data![0]);
  const params = { remotePluginId: 'remote', previewHash: selected.previewHash!, confirm: true };
  await expect(f.service.mutate('plugin/share/updateTargets', { ...params, discoverability: 'PRIVATE', shareTargets: [{ principalId: 'u', principalType: 'user', role: 'reader' }, { principalId: 'u', principalType: 'user', role: 'editor' }] }, f.write)).rejects.toHaveProperty('code', 'invalid_params');
  expect(await f.service.mutate('plugin/share/delete', params, f.write)).toEqual({ remotePluginId: 'remote', deleted: true });
  f.remoteChange(); await expect(f.service.mutate('plugin/share/delete', params, f.write)).rejects.toHaveProperty('code', 'share_changed'); expect(f.writes).toHaveLength(1);
});
test('feedback validates conversation scope, explicit logs and fixed unique destination', async () => {
  // Minimal native result is supplied by the fixture schema helper below.
  const { nativeThread } = await import('./fixture-values.js');
  const feedback = new Feedback(async () => ({ thread: nativeThread({ id: 'thread', cwd: '/project' }) })); const context = { clientId: 'owner', operationId: randomUUID() };
  const params = { cwd: '/project', threadId: 'thread', classification: 'bug', reason: 'Private feedback body', includeLogs: false, confirm: true }; let written: JsonObject | undefined;
  const write = async (_method: string, body: JsonValue) => { written = object(body); return { savedPath: written.savePath!, threadId: 'thread', promptHash: null }; };
  await expect(feedback.submit('feedback/save', { ...params, savePath: '/secret' }, context, write)).rejects.toHaveProperty('delivery', 'not_sent');
  await expect(feedback.submit('feedback/save', { ...params, cwd: '/other' }, context, write)).rejects.toHaveProperty('code', 'feedback_scope');
  const result = await feedback.submit('feedback/save', params, context, write); expect(written).toMatchObject({ extraLogFiles: [], includeLogs: false, threadId: 'thread' });
  expect(String(written!.savePath)).toContain(context.operationId); expect(receiptResult('feedback/save', result)).not.toHaveProperty('reason');
});
