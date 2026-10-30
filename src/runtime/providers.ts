import path from 'node:path';
import { DeliveryError, integer, object, onlyKeys, string, type JsonObject, type JsonValue } from './types.js';

type NativeCall = (method: string, params: JsonObject) => Promise<JsonValue>;
type Connection = JsonObject & { id: string; modelProvider: string; enabled: boolean; kind: string; name: string; models: JsonObject[] };

/** Public root-managed metadata. Credentials never cross this boundary. */
export class ManagedProviders {
  private connections: Connection[] = [];
  private defaultId = '';
  private nativeProvider = '';
  private matches(row: Connection, provider: JsonValue | undefined): boolean {
    return row.modelProvider === provider || row.kind === 'chatgpt' && row.id === 'default' && provider === 'openai';
  }
  constructor(registry?: JsonObject) {
    if (!registry) return;
    if (!Array.isArray(registry.connections) || registry.connections.length < 1 || registry.connections.length > 16)
      throw new Error('Invalid managed provider registry');
    const ids = new Set<string>(), nativeIds = new Set<string>();
    this.connections = registry.connections.map(value => {
      const row = object(value);
      const id = string(row.id, 'provider id', 32), modelProvider = string(row.modelProvider, 'native provider', 80);
      if (!/^(?:default|[a-f0-9]{32})$/.test(id) || !/^[a-z0-9_-]+$/.test(modelProvider) || ids.has(id) || nativeIds.has(modelProvider) ||
          typeof row.enabled !== 'boolean' || !Array.isArray(row.models) || row.models.length > 1000) throw new Error('Invalid provider record');
      ids.add(id); nativeIds.add(modelProvider);
      if (row.catalogPath !== undefined && (!path.isAbsolute(string(row.catalogPath, 'catalog path')) || !/catalog-(?:default|[a-f0-9]{32})\.json$/.test(String(row.catalogPath)))) throw new Error('Invalid provider catalog path');
      return { ...row, id, modelProvider, enabled: row.enabled, kind: string(row.kind, 'provider kind', 64), name: string(row.name, 'provider name', 256), models: row.models.map(item => object(item)) };
    });
    this.defaultId = string(registry.defaultProviderId, 'default provider', 32);
    this.nativeProvider = string(registry.nativeCatalogProvider, 'catalog provider', 80);
    if (!this.connections.some(row => row.id === this.defaultId && row.enabled) || !this.connections.some(row => row.modelProvider === this.nativeProvider && row.enabled)) throw new Error('Default provider is disabled');
  }
  selection(input: JsonValue | undefined, turn: boolean): JsonObject | undefined {
    if (!this.connections.length) {
      // An upgraded single-provider generation may not have runtime.json yet.
      // Its native managed configuration still validates the provider; keep
      // existing conversations usable until the next provider save migrates it.
      return input === undefined ? undefined : object(input);
    }
    const value = input === undefined ? {} : object(input, 'options');
    const { modelProvider, ...ordinary } = value;
    const selected = modelProvider === undefined ? this.connections.find(row => row.id === this.defaultId)! :
      this.connections.find(row => this.matches(row, modelProvider) && row.enabled);
    if (!selected) throw new DeliveryError('provider_unavailable', '所选模型供应商不存在或已停用，请重新选择。');
    if (turn) return ordinary; // Provider is immutable for an existing native thread.
    const model = ordinary.model ?? selected.model ?? selected.models[0]?.id;
    const metadata = selected.models.find(row => row.id === model);
    const configuredEffort = model === selected.model ? selected.effort : undefined;
    const effort = configuredEffort ?? metadata?.defaultEffort;
    return { ...ordinary, modelProvider: selected.modelProvider,
      ...(ordinary.model === undefined && typeof model === 'string' ? { model } : {}),
      ...(ordinary.effort === undefined && typeof effort === 'string' && effort ? { effort } : {}) };
  }
  catalogOverride(modelProvider: JsonValue | undefined): JsonObject {
    const row = this.connections.find(value => this.matches(value, modelProvider) && value.enabled);
    return typeof row?.catalogPath === 'string' ? { model_catalog_json: row.catalogPath } : {};
  }
  accountProvider(): string | undefined {
    const rows = this.connections.filter(row => row.enabled && (row.kind === 'chatgpt' || row.kind === 'chatgpt-gateway'));
    return rows.some(row => row.modelProvider === this.nativeProvider) ? undefined : rows[0]?.modelProvider;
  }
  assertThread(provider: JsonValue | undefined, options: JsonValue | undefined): void {
    const requested = options === undefined ? undefined : object(options).modelProvider;
    const actual = this.connections.find(row => row.enabled && this.matches(row, provider));
    if (requested !== undefined && requested !== provider && !(actual && this.matches(actual, requested))) throw new DeliveryError('provider_mismatch', '已有对话不能切换模型供应商，请新建对话。');
    if (this.connections.length && !actual)
      throw new DeliveryError('provider_unavailable', '此对话的模型供应商已停用或移除，请恢复该供应商后继续。');
  }
  async list(params: JsonObject, native: NativeCall, other?: (provider: string, usesChatgpt: boolean, includeHidden: boolean) => Promise<JsonObject[]>): Promise<JsonValue> {
    onlyKeys(params, ['cursor', 'limit', 'includeHidden', 'modelProvider']);
    const limit = params.limit === undefined ? 50 : integer(params.limit, 'limit', 1, 100);
    if (params.includeHidden !== undefined && typeof params.includeHidden !== 'boolean') throw new DeliveryError('invalid_params', 'Invalid includeHidden');
    if (!this.connections.length) {
      const account = object(await native('account/read', { refreshToken: false }));
      if (account.requiresOpenaiAuth !== false && object(account.account ?? {}).type !== 'chatgpt') return { data: [], nextCursor: null };
      const { modelProvider: _provider, ...nativeParams } = params;
      return native('model/list', { ...nativeParams, limit });
    }
    const data: JsonObject[] = [];
    const failures: JsonObject[] = [];
    for (const connection of this.connections) {
      if (!connection.enabled || params.modelProvider && !this.matches(connection, params.modelProvider)) continue;
      const usesChatgpt = connection.kind === 'chatgpt' || connection.kind === 'chatgpt-gateway';
      let rows: JsonObject[];
      try {
        rows = usesChatgpt || connection.kind.startsWith('bedrock-')
          ? connection.modelProvider === this.nativeProvider
            ? await readNativeCatalog(native, usesChatgpt, params.includeHidden === true)
            : other ? await other(connection.modelProvider, usesChatgpt, params.includeHidden === true) : []
          : connection.models.map(model => this.model(model));
      } catch {
        failures.push({ modelProvider: connection.modelProvider, name: connection.name, message: '无法读取模型目录，请检查该供应商的登录或连接。' });
        continue;
      }
      for (const row of rows) data.push({ ...row, modelProvider: connection.modelProvider, providerId: connection.id, providerName: connection.name,
        ...(connection.kind === 'chatgpt' && connection.id === 'default' ? { providerAliases: ['openai'] } : {}) });
    }
    let offset = 0;
    if (params.cursor != null) {
      const cursor = string(params.cursor, 'cursor', 24);
      if (!/^providers:[0-9]+$/.test(cursor)) throw new DeliveryError('invalid_params', 'Invalid provider cursor');
      offset = Number(cursor.slice(10));
      if (!Number.isSafeInteger(offset) || offset > data.length) throw new DeliveryError('catalog_changed', '模型目录已更新，请刷新。');
    }
    return { data: data.slice(offset, offset + limit), nextCursor: offset + limit < data.length ? 'providers:' + (offset + limit) : null, providerErrors: failures };
  }
  private model(value: JsonObject): JsonObject {
    return { id: value.id!, model: value.id!, displayName: value.id!, defaultReasoningEffort: value.defaultEffort ?? null,
      supportedReasoningEfforts: Array.isArray(value.efforts) ? value.efforts.map(effort => ({ reasoningEffort: effort })) : [],
      inputModalities: value.inputModalities ?? ['text'] };
  }
}

export async function readNativeCatalog(native: NativeCall, usesChatgpt: boolean, includeHidden = false): Promise<JsonObject[]> {
  if (usesChatgpt && object(object(await native('account/read', { refreshToken: false })).account ?? {}).type !== 'chatgpt') return [];
  const rows: JsonObject[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = object(await native('model/list', { limit: 100, includeHidden, ...(cursor ? { cursor } : {}) }));
    if (!Array.isArray(result.data) || result.data.length > 100) throw new DeliveryError('invalid_native_response', 'Invalid model directory');
    rows.push(...result.data.map(row => object(row)));
    if (result.nextCursor == null) return rows;
    const next = string(result.nextCursor, 'model cursor');
    if (seen.has(next)) throw new DeliveryError('catalog_budget', 'Model catalog is incomplete');
    seen.add(next); cursor = next;
  }
  throw new DeliveryError('catalog_budget', 'Model catalog exceeds 1000 entries');
}
