import { describe, expect, it, vi } from 'vitest';
import { ManagedProviders } from '../../src/runtime/providers.js';
import type { JsonObject } from '../../src/runtime/types.js';

const chatgpt = { id: 'default', name: 'ChatGPT', kind: 'chatgpt', modelProvider: 'harness_chatgpt', enabled: true, models: [] };
const custom = { id: 'a'.repeat(32), name: 'Personal', kind: 'responses', modelProvider: 'harness_' + 'a'.repeat(32),
  enabled: true, model: 'same-model', catalogPath: '/fixture/providers/catalog-' + 'a'.repeat(32) + '.json',
  models: [{ id: 'same-model', defaultEffort: 'max', efforts: ['low', 'max'], inputModalities: ['text'] }] };
const registry = (connections: JsonObject[] = [chatgpt, custom]) => ({ connections, defaultProviderId: 'default', nativeCatalogProvider: 'harness_chatgpt' });

describe('managed provider catalogs and routing', () => {
  it('does not expose bundled ChatGPT choices before login', async () => {
    const native = vi.fn().mockResolvedValue({ account: null, requiresOpenaiAuth: true });
    const result = await new ManagedProviders(registry()).list({}, native);
    expect(result).toMatchObject({ data: [{ model: 'same-model', providerName: 'Personal', modelProvider: custom.modelProvider }] });
    expect(native.mock.calls.map(row => row[0])).toEqual(['account/read']);
  });
  it('filters bundled choices in an existing unconfigured installation too', async () => {
    const native = vi.fn().mockResolvedValue({ account: null, requiresOpenaiAuth: true });
    await expect(new ManagedProviders().list({}, native)).resolves.toEqual({ data: [], nextCursor: null });
  });
  it('keeps a legacy installation usable before its first registry migration', () => {
    expect(new ManagedProviders().selection({ modelProvider: 'harness_responses', model: 'saved-model' }, false))
      .toEqual({ modelProvider: 'harness_responses', model: 'saved-model' });
  });
  it('does not mistake an API-key login for a ChatGPT login and recognizes legacy thread aliases', async () => {
    const managed = new ManagedProviders(registry());
    const native = vi.fn().mockResolvedValue({ account: { type: 'apiKey' }, requiresOpenaiAuth: true });
    await expect(managed.list({ modelProvider: 'openai' }, native)).resolves.toMatchObject({ data: [] });
    expect(native.mock.calls.map(row => row[0])).toEqual(['account/read']);
    expect(() => managed.assertThread('openai', { modelProvider: 'harness_chatgpt' })).not.toThrow();
    expect(managed.sameProvider('openai', custom.modelProvider)).toBe(false);
    expect(() => managed.assertThread('openai', { modelProvider: custom.modelProvider })).toThrow(/切换供应商菜单/);
  });
  it('returns provider-scoped capabilities even when model IDs are equal', async () => {
    const native = vi.fn(async (method: string) => method === 'account/read' ? { account: { type: 'chatgpt' } } :
      { data: [{ id: 'same-model', model: 'same-model', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }], nextCursor: null });
    const result = await new ManagedProviders(registry()).list({}, native) as JsonObject;
    expect(result.data).toMatchObject([
      { modelProvider: 'harness_chatgpt', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
      { modelProvider: custom.modelProvider, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'max' }] },
    ]);
  });
  it('selects a provider and isolated catalog while keeping native turn params provider-free', () => {
    const managed = new ManagedProviders(registry());
    expect(managed.selection({ modelProvider: custom.modelProvider }, false)).toEqual({ modelProvider: custom.modelProvider, model: 'same-model', effort: 'max' });
    expect(managed.selection({ modelProvider: custom.modelProvider, model: 'same-model', effort: 'max' }, true)).toEqual({ model: 'same-model', effort: 'max' });
    expect(managed.catalogOverride(custom.modelProvider)).toEqual({ model_catalog_json: custom.catalogPath });
    expect(managed.displayName(custom.modelProvider)).toBe('Personal');
    expect(() => managed.assertThread('harness_chatgpt', { modelProvider: custom.modelProvider })).toThrow(/切换供应商菜单/);
  });
  it('requires restoring a disabled source and never targets a disabled provider', () => {
    const managed = new ManagedProviders(registry([chatgpt, { ...custom, enabled: false }]));
    expect(() => managed.assertThread(custom.modelProvider, {})).toThrow(/恢复原供应商配置/);
    expect(() => managed.resumeSelection({ modelProvider: custom.modelProvider, model: 'same-model' })).toThrow(/停用/);
  });
  it('requires a concrete target model and treats known aliases as the same provider', () => {
    const managed = new ManagedProviders(registry());
    expect(() => managed.assertThread('openai', { modelProvider: 'harness_chatgpt', model: 'gpt-fixture' })).not.toThrow();
    expect(managed.sameProvider('openai', 'harness_chatgpt')).toBe(true);
    expect(managed.sameProvider('openai', custom.modelProvider)).toBe(false);
    expect(() => managed.resumeSelection({ modelProvider: 'harness_chatgpt' })).toThrow(/model/);
    expect(managed.resumeSelection({ modelProvider: 'harness_chatgpt', model: 'gpt-fixture' })).not.toHaveProperty('effort');
  });
  it('does not silently route an unavailable provider or a disabled historical thread', async () => {
    const managed = new ManagedProviders(registry([chatgpt, { ...custom, enabled: false }]));
    expect(() => managed.selection({ modelProvider: custom.modelProvider }, false)).toThrow(/停用/);
    expect(() => managed.assertThread(custom.modelProvider, {})).toThrow(/停用/);
    const native = vi.fn().mockResolvedValue({ account: null });
    await expect(managed.list({}, native)).resolves.toMatchObject({ data: [] });
  });
  it('cold resume selects only an explicit enabled provider and never accepts settings overrides', () => {
    const managed = new ManagedProviders(registry([chatgpt, custom]));
    expect(managed.resumeSelection({ modelProvider: custom.modelProvider })).toMatchObject({ modelProvider: custom.modelProvider, model: custom.model });
    expect(() => managed.resumeSelection({ model: custom.model })).toThrow();
    expect(() => managed.resumeSelection({ modelProvider: custom.modelProvider, sandbox: 'danger-full-access' })).toThrow(/Unsupported/);
    expect(() => new ManagedProviders(registry([chatgpt, { ...custom, enabled: false }])).resumeSelection({ modelProvider: custom.modelProvider })).toThrow(/停用/);
    expect(() => new ManagedProviders().resumeSelection({ modelProvider: 'unknown', model: 'x' })).toThrow(/停用/);
  });
  it('does not carry the default model effort into a different model', () => {
    const managed = new ManagedProviders(registry([chatgpt, { ...custom, effort: 'max', models: [...custom.models,
      { id: 'small', defaultEffort: 'low', efforts: ['low'] }, { id: 'plain', defaultEffort: null, efforts: [] }] }]));
    expect(managed.selection({ modelProvider: custom.modelProvider, model: 'small' }, false)?.effort).toBe('low');
    expect(managed.selection({ modelProvider: custom.modelProvider, model: 'plain' }, false)).not.toHaveProperty('effort');
    expect(managed.selection({ modelProvider: custom.modelProvider }, false)?.effort).toBe('max');
  });
  it('uses a provider-specific native directory for a non-default authenticated service', async () => {
    const bedrock = { ...custom, kind: 'bedrock-mantle' };
    const other = vi.fn().mockResolvedValue([{ id: 'aws-model', model: 'aws-model' }]);
    const native = vi.fn().mockResolvedValue({ account: null });
    await expect(new ManagedProviders(registry([chatgpt, bedrock])).list({ modelProvider: bedrock.modelProvider }, native, other))
      .resolves.toMatchObject({ data: [{ model: 'aws-model', modelProvider: bedrock.modelProvider }] });
    expect(native).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalledWith(bedrock.modelProvider, false, false);
  });
});
