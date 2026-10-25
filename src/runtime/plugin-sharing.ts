import { createHash } from 'node:crypto';
import path from 'node:path';
import { canonical, DeliveryError, jsonBytes, object, onlyKeys, string, type JsonObject, type JsonValue } from './types.js';
import { validateOfficial } from './validation.js';
type Call = (method: string, params: JsonValue) => Promise<JsonValue>;
interface Host {
  native: Call;
  select(params: JsonObject): Promise<{ plugin: JsonObject; locator: JsonObject }>;
  preview(cwd: string, relative: string): Promise<JsonObject>;
}
const hash = (value: JsonValue): string => createHash('sha256').update(canonical(value)).digest('hex');
function targets(value: JsonValue | undefined): JsonValue[] {
  if (!Array.isArray(value) || value.length > 64) throw new DeliveryError('invalid_params', 'Choose up to 64 explicit share targets');
  const seen = new Set<string>();
  for (const item of value) {
    validateOfficial('PluginShareTarget', item); const target = object(item); onlyKeys(target, ['principalType', 'principalId', 'role']); string(target.principalId, 'share principal', 256);
    const id = String(target.principalType) + ':' + String(target.principalId); if (seen.has(id)) throw new DeliveryError('invalid_params', 'Duplicate share target'); seen.add(id);
  }
  return value;
}
/** Remote sharing always carries an explicit audience and fresh displayed inventory. */
export class PluginSharing {
  constructor(private host: Host) {}
  private async request(method: string, params: JsonObject, schema: string, response: string, call = this.host.native): Promise<JsonObject> {
    validateOfficial(schema, params); jsonBytes(params, 1024 * 1024); const result = await call(method, params);
    try { validateOfficial(response, result); jsonBytes(result, 2 * 1024 * 1024); return object(result); }
    catch { throw new DeliveryError('invalid_native_response', 'Invalid native sharing response', call === this.host.native ? 'not_sent' : 'unknown'); }
  }
  async list(params: JsonObject): Promise<JsonObject> {
    onlyKeys(params, []); const result = await this.request('plugin/share/list', {}, 'PluginShareListParams', 'PluginShareListResponse');
    if (!Array.isArray(result.data) || result.data.length > 256) throw new DeliveryError('capacity', 'Shared plugin catalog exceeds its bounded view');
    return { data: result.data.map(value => { const item = object(value); return { ...item, previewHash: hash(item) }; }) };
  }
  async preview(params: JsonObject): Promise<JsonObject> {
    onlyKeys(params, ['cwd', 'pluginId']); const cwd = string(params.cwd, 'cwd'); const selected = await this.host.select(params), source = object(selected.plugin.source);
    if (source.type !== 'local') throw new DeliveryError('share_local_required', 'Saving a share requires an explicitly selected local plugin directory');
    const location = string(source.path, 'plugin path'), relative = path.relative(cwd, location).replaceAll('\\', '/');
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('../')) throw new DeliveryError('share_scope', 'Copy the plugin into the registered project before sharing it');
    const inventory = await this.host.preview(cwd, relative);
    const shown: JsonObject = { pluginId: selected.plugin.id!, pluginPath: inventory.path!, revision: inventory.revision!, files: inventory.files!, totalBytes: inventory.totalBytes!, destination: 'current_codex_account_plugin_sharing', previewKind: 'fresh_directory_inventory' };
    jsonBytes(shown, 1024 * 1024); return { ...shown, previewHash: hash(shown) };
  }
  private async selected(params: JsonObject): Promise<JsonObject> {
    const id = string(params.remotePluginId, 'remotePluginId', 256), previewHash = string(params.previewHash, 'previewHash', 64);
    const catalog = await this.list({}); const selected = (catalog.data as JsonValue[]).map(value => object(value)).filter(row => {
      const plugin = object(row.plugin); return plugin.remotePluginId === id || (plugin.shareContext && object(plugin.shareContext).remotePluginId === id);
    });
    if (selected.length !== 1 || selected[0]!.previewHash !== previewHash) throw new DeliveryError('share_changed', 'Shared plugin details changed; reload and review them');
    return selected[0]!;
  }
  async mutate(method: string, params: JsonObject, write: Call): Promise<JsonValue> {
    if (params.confirm !== true) throw new DeliveryError('invalid_params', 'Sharing changes require explicit confirmation');
    const suffix = method.slice('plugin/share/'.length);
    if (suffix === 'save') {
      onlyKeys(params, ['cwd', 'pluginId', 'previewHash', 'remotePluginId', 'remotePreviewHash', 'discoverability', 'shareTargets', 'confirm']);
      const preview = await this.preview({ cwd: params.cwd!, pluginId: params.pluginId! });
      if (params.previewHash !== preview.previewHash) throw new DeliveryError('share_changed', 'Plugin files changed; review the current inventory');
      validateOfficial('PluginShareDiscoverability', params.discoverability ?? null); const shareTargets = targets(params.shareTargets);
      if (params.remotePluginId !== undefined && params.remotePluginId !== null) await this.selected({ remotePluginId: params.remotePluginId, previewHash: params.remotePreviewHash! });
      else if (params.remotePreviewHash !== undefined) throw new DeliveryError('invalid_params', 'Remote preview applies only to an existing share');
      return this.request(method, { pluginPath: preview.pluginPath!, remotePluginId: params.remotePluginId ?? null, discoverability: params.discoverability!, shareTargets }, 'PluginShareSaveParams', 'PluginShareSaveResponse', write);
    }
    onlyKeys(params, suffix === 'updateTargets' ? ['remotePluginId', 'previewHash', 'discoverability', 'shareTargets', 'confirm'] : ['remotePluginId', 'previewHash', 'confirm']);
    await this.selected(params); const id = params.remotePluginId!;
    if (suffix === 'updateTargets') {
      validateOfficial('PluginShareUpdateDiscoverability', params.discoverability ?? null);
      return { ...await this.request(method, { remotePluginId: id, discoverability: params.discoverability!, shareTargets: targets(params.shareTargets) }, 'PluginShareUpdateTargetsParams', 'PluginShareUpdateTargetsResponse', write), remotePluginId: id };
    }
    if (suffix === 'delete') return { ...await this.request(method, { remotePluginId: id }, 'PluginShareDeleteParams', 'PluginShareDeleteResponse', write), remotePluginId: id, deleted: true };
    if (suffix === 'checkout') return this.request(method, { remotePluginId: id }, 'PluginShareCheckoutParams', 'PluginShareCheckoutResponse', write);
    throw new DeliveryError('method_not_found', 'Unknown sharing workflow');
  }
}
