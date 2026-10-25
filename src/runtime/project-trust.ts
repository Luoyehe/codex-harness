import { DeliveryError, jsonBytes, object, onlyKeys, string, type JsonObject, type JsonValue } from './types.js';
import { validateOfficial } from './validation.js';
type Call = (method: string, params: JsonValue) => Promise<JsonValue>;
/** A scoped user preference. This never grants trust to a hook's changed content hash. */
export class ProjectTrust {
  constructor(private native: Call) {}
  private async source(cwd: string): Promise<{ version: string | null; projects: JsonObject; layers: JsonValue[] }> {
    const response = await this.native('config/read', { cwd, includeLayers: true }); validateOfficial('ConfigReadResponse', response); jsonBytes(response, 1024 * 1024);
    const layers = (object(response).layers as JsonValue[] | null) ?? [], users = layers.map(value => object(value)).filter(layer => { const name = object(layer.name); return name.type === 'user' && name.profile === null; });
    if (users.length > 1) throw new DeliveryError('invalid_native_response', 'Ambiguous base user configuration');
    return { version: users.length ? string(users[0]!.version, 'user version') : null, projects: object((users.length ? object(users[0]!.config) : {}).projects ?? {}), layers };
  }
  async read(cwd: string): Promise<JsonValue> {
    const state = await this.source(cwd), entry = Object.hasOwn(state.projects, cwd) ? object(state.projects[cwd]) : {};
    return { cwd, userVersion: state.version, configuredTrust: entry.trust_level ?? null, appliesTo: 'exact_registered_path',
      projectLayers: state.layers.map(value => object(value)).filter(layer => object(layer.name).type === 'project').map(layer => ({ name: layer.name!, disabledReason: layer.disabledReason ?? null })) };
  }
  async write(params: JsonObject, cwd: string, write: Call): Promise<JsonValue> {
    onlyKeys(params, ['cwd', 'expectedVersion', 'trustLevel', 'confirm']);
    if (params.confirm !== true || !['trusted', 'untrusted', 'default'].includes(String(params.trustLevel))) throw new DeliveryError('invalid_params', 'Choose and confirm an exact project trust preference');
    const expectedVersion = string(params.expectedVersion, 'expectedVersion'), state = await this.source(cwd);
    if (state.version !== expectedVersion) throw new DeliveryError('config_conflict', 'User configuration changed; reread before changing project trust');
    const projects: JsonObject = { ...state.projects }, entry: JsonObject = Object.hasOwn(projects, cwd) ? { ...object(projects[cwd]) } : {};
    if (params.trustLevel === 'default') delete entry.trust_level; else entry.trust_level = params.trustLevel!;
    if (Object.keys(entry).length) projects[cwd] = entry; else delete projects[cwd]; jsonBytes(projects, 512 * 1024);
    const body = { expectedVersion, edits: [{ keyPath: 'projects', value: projects, mergeStrategy: 'replace' }], reloadUserConfig: true };
    validateOfficial('ConfigBatchWriteParams', body); const result = await write('config/batchWrite', body);
    try { validateOfficial('ConfigWriteResponse', result); } catch { throw new DeliveryError('trust_unknown', 'Project trust save was not confirmed', 'unknown'); }
    return { ...object(result), cwd, configuredTrust: params.trustLevel === 'default' ? null : params.trustLevel!, appliesTo: 'next_project_load', hookTrustChanged: false };
  }
}
