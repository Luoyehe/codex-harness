import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { Extensions, type ExtensionHost } from '../../src/runtime/extensions.js';
import { DiagnosticRedactor } from '../../src/runtime/redaction.js';
import { canonical, DeliveryError, object, type JsonObject, type JsonValue } from '../../src/runtime/types.js';

const context = { clientId: 'c', operationId: '00000000-0000-0000-0000-000000000001', beforeWrite: () => {} };
const plugin: JsonObject = { id: 'fixture@test', remotePluginId: null, version: '1', localVersion: null, name: 'fixture', shareContext: null, source: { type: 'local', path: '/project/plugin' }, installed: false, installedAt: null, enabled: true, installPolicy: 'AVAILABLE', installPolicySource: null, mustShowInstallationInterstitial: null, authPolicy: 'ON_USE', availability: 'AVAILABLE', disabledReason: null, eligiblePlanTypes: null, interface: null, keywords: [] };
const detail = (summary: JsonObject): JsonObject => ({ marketplaceName: 'test', marketplacePath: '/project/marketplace.json', summary, shareUrl: null, description: 'Fixture details', skills: [], onboardingSkill: null, hooks: [], apps: [], appTemplates: [], mcpServers: [], scheduledTasks: null });
const digest = (value: JsonValue) => createHash('sha256').update(canonical(value)).digest('hex');
function setup(responses: Record<string, JsonValue | ((params: JsonObject) => JsonValue)>) {
  const calls: { method: string; params: JsonObject; write: boolean }[] = [];
  const invoke = async (method: string, params: JsonValue, write: boolean) => { const p = object(params); calls.push({ method, params: p, write }); const value = responses[method]; if (value === undefined) throw new Error('Unexpected native method '+method); return typeof value === 'function' ? value(p) : structuredClone(value); };
  const host: ExtensionHost = { native: (method, params) => invoke(method, params, false), configure: fn => fn((method, params) => invoke(method, params, true)), cwd: value => { if (value !== '/project') throw new DeliveryError('invalid_project', 'unknown project'); return value; }, redactor: new DiagnosticRedactor({ HARNESS_PROVIDER_API_KEY: 'provider-secret' }) };
  return { service: new Extensions(host), calls, host };
}
describe('extension workflows', () => {
  test('memory switches write only selected leaves with the current user version', async () => {
    const { service, calls } = setup({ 'config/batchWrite': { status: 'ok', version: 'v2', filePath: '/native/config.toml', overriddenMetadata: null } });
    await service.call('settings/write', { expectedVersion: 'v1', changes: [{ key: 'memories.generate_memories', value: false }, { key: 'memories.use_memories', value: true }] }, context);
    expect(calls[0]).toEqual({ method: 'config/batchWrite', params: { expectedVersion: 'v1', edits: [{ keyPath: 'memories.generate_memories', value: false, mergeStrategy: 'replace' }, { keyPath: 'memories.use_memories', value: true, mergeStrategy: 'replace' }], reloadUserConfig: true }, write: true });
  });
  test('local plugin skill content uses its fresh unique catalog path through the scoped reader', async () => {
    const skill: JsonObject = { name: 'fixture', description: 'Fixture', shortDescription: null, interface: null, path: '/project/plugin/skills/fixture/SKILL.md', enabled: true };
    const state = { ...detail(plugin), skills: [skill] };
    const { service, host } = setup({ 'plugin/list': { marketplaces: [{ name: 'test', path: '/project/marketplace.json', interface: null, plugins: [plugin] }], marketplaceLoadErrors: [], featuredPluginIds: [] }, 'plugin/read': () => ({ plugin: state }) });
    const reads: unknown[] = []; host.resource = async (cwd, action, params) => { reads.push({ cwd, action, params }); return { text: 'Skill contents' }; };
    await expect(service.call('plugin/skill/read', { cwd: '/project', pluginId: plugin.id!, skillName: 'fixture' }, context)).resolves.toEqual({ contents: 'Skill contents' });
    expect(reads).toEqual([{ cwd: '/project', action: 'resource/skill/read', params: { path: skill.path } }]);
    await expect(service.call('plugin/skill/read', { cwd: '/project', pluginId: plugin.id!, skillName: 'fixture', path: '/private/SKILL.md' }, context)).rejects.toMatchObject({ delivery: 'not_sent' });
    state.skills = [skill, skill]; await expect(service.call('plugin/skill/read', { cwd: '/project', pluginId: plugin.id!, skillName: 'fixture' }, context)).rejects.toMatchObject({ code: 'skill_unavailable' }); expect(reads).toHaveLength(1);
  });
  test('skill mutations resolve a current catalog identity and never accept an arbitrary native path', async () => {
    const { service, calls } = setup({ 'skills/list': { data: [{ cwd: '/project', skills: [{ name: 'fixture', description: 'Test', path: '/project/.agents/skills/fixture/SKILL.md', scope: 'repo', enabled: true, pluginId: null }], errors: [] }] }, 'skills/config/write': { effectiveEnabled: false } });
    const catalog = object(await service.call('skills/list', { cwd: '/project' }, context)); const skill = object((object((catalog.data as JsonValue[])[0]).skills as JsonValue[])[0]);
    await expect(service.call('skills/config/write', { cwd: '/project', skillId: skill.skillId!, enabled: false }, context)).resolves.toEqual({ effectiveEnabled: false });
    expect(calls.at(-1)).toEqual({ method: 'skills/config/write', params: { path: '/project/.agents/skills/fixture/SKILL.md', enabled: false }, write: true });
    await expect(service.call('skills/config/write', { cwd: '/project', path: '/private/key', enabled: true }, context)).rejects.toMatchObject({ delivery: 'not_sent' });
    await expect(service.call('skills/config/write', { cwd: '/project', skillId: 'a'.repeat(64), enabled: false }, context)).rejects.toMatchObject({ code: 'skill_unavailable' });
  });
  test('plugin install binds the displayed details to fresh catalog identity, policy and the operation ID', async () => {
    const state = structuredClone(plugin); const { service, calls } = setup({ 'plugin/list': () => ({ marketplaces: [{ name: 'test', path: '/project/marketplace.json', interface: null, plugins: [state] }], marketplaceLoadErrors: [], featuredPluginIds: [] }), 'plugin/read': () => ({ plugin: detail(state) }), 'plugin/install': { authPolicy: 'ON_USE', appsNeedingAuth: [] } });
    const shown = object(await service.call('plugin/read', { cwd: '/project', pluginId: state.id! }, context));
    expect(shown.previewHash).toBe(digest(detail(state)));
    expect(await service.call('plugin/install', { cwd: '/project', pluginId: state.id!, previewHash: shown.previewHash! }, context)).toEqual({ pluginId: state.id, authPolicy: 'ON_USE', appsNeedingAuth: [] });
    expect(calls.at(-1)).toMatchObject({ method: 'plugin/install', params: { marketplacePath: '/project/marketplace.json', pluginName: 'fixture', installAttemptId: context.operationId }, write: true });
    state.version = '2'; await expect(service.call('plugin/install', { cwd: '/project', pluginId: state.id!, previewHash: shown.previewHash! }, context)).rejects.toMatchObject({ code: 'plugin_changed' });
    state.availability = 'DISABLED_BY_ADMIN'; await expect(service.call('plugin/install', { cwd: '/project', pluginId: state.id!, previewHash: shown.previewHash! }, context)).rejects.toMatchObject({ code: 'plugin_unavailable' });
    expect(calls.filter(call => call.write)).toHaveLength(1);
  });
  test('configuration writes cannot change provider authority, output paths, profiles or overwrite masked secrets', async () => {
    const { service, calls } = setup({ 'config/batchWrite': { status: 'ok', version: 'v2', filePath: '/native/config.toml', overriddenMetadata: null } });
    for (const key of ['model_provider', 'model_providers', 'openai_base_url', 'chatgpt_base_url', 'profiles', 'sqlite_home', 'log_dir']) await expect(service.call('settings/write', { expectedVersion: 'v1', changes: [{ key, value: 'injected' }] }, context)).rejects.toMatchObject({ delivery: 'not_sent' });
    await expect(service.call('settings/write', { expectedVersion: 'v1', changes: [{ key: 'mcp_servers', value: { fixture: { env: '[redacted]' } } }] }, context)).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(calls).toHaveLength(0);
    await service.call('settings/write', { expectedVersion: 'v1', changes: [{ key: 'model_reasoning_effort', value: 'high' }] }, context);
    expect(calls[0]).toEqual({ method: 'config/batchWrite', params: { expectedVersion: 'v1', edits: [{ keyPath: 'model_reasoning_effort', value: 'high', mergeStrategy: 'replace' }], reloadUserConfig: true }, write: true });
  });
  test('effective configuration masks environment/header secrets in every layer and exposes the base user revision', async () => {
    const config: JsonObject = {};
    config.mcp_servers = { fixture: { env: { NOT_NAMED_SECRET: 'do-not-expose' }, http_headers: { custom: 'hidden-header' }, api_key: 'hidden-key' } };
    const { service } = setup({ 'config/read': { config, origins: {}, layers: [{ name: { type: 'user', file: '/native/config.toml', profile: null }, version: 'base-version', config: { nested: { api_key: 'hidden-key' } }, disabledReason: null }] } });
    const result = object(await service.call('settings/read', { cwd: '/project' }, context)); const text = JSON.stringify(result);
    expect(result.userVersion).toBe('base-version'); expect(text).not.toContain('do-not-expose'); expect(text).not.toContain('hidden-header'); expect(text).not.toContain('hidden-key');
  });
  test('feature enablement validates a bounded fresh catalog and refuses retired features', async () => {
    const { service, calls } = setup({ 'experimentalFeature/list': { data: ['stable', 'removed'].map(stage => ({ name: stage, stage, displayName: null, description: null, announcement: null, enabled: false, defaultEnabled: false })), nextCursor: null }, 'experimentalFeature/enablement/set': { enablement: { stable: true } } });
    await service.call('experimentalFeature/enablement/set', { enablement: { stable: true } }, context);
    await expect(service.call('experimentalFeature/enablement/set', { enablement: { removed: true } }, context)).rejects.toMatchObject({ code: 'feature_unavailable' });
    await expect(service.call('experimentalFeature/enablement/set', { enablement: { invented: true } }, context)).rejects.toMatchObject({ code: 'feature_unavailable' });
    expect(calls.filter(call => call.write)).toHaveLength(1);
  });
  test('memory reset requires an explicit confirmation and invalid mutation acknowledgements remain unknown', async () => {
    const { service, calls } = setup({ 'memory/reset': {}, 'skills/list': { data: [] }, 'config/batchWrite': {} });
    await expect(service.call('memory/reset', {}, context)).rejects.toMatchObject({ delivery: 'not_sent' }); expect(calls).toHaveLength(0);
    await expect(service.call('memory/reset', { confirm: true }, context)).resolves.toEqual({});
    await expect(service.call('settings/write', { expectedVersion: 'v', changes: [{ key: 'model_reasoning_effort', value: 'high' }] }, context)).rejects.toMatchObject({ delivery: 'unknown' });
  });
});
