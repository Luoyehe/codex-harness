import { isDeepStrictEqual } from 'node:util';
import { DeliveryError, jsonBytes, object, onlyKeys, string, type JsonObject, type JsonValue } from './types.js';
import { validateOfficial } from './validation.js';

type Call = (method: string, params: JsonValue) => Promise<JsonValue>;
const stdioEnv = ['env', 'env_vars'];
const httpHeaders = ['http_headers', 'http_headers_helper'];
const bearer = ['bearer_token_env_var', 'bearer_token'];
const httpCredentials = [...httpHeaders, 'env_http_headers', ...bearer];
const stdioOnly = ['command', 'args', 'cwd', ...stdioEnv];
const httpOnly = ['url', 'auth', 'oauth', 'oauth_resource', ...httpCredentials];
function serverName(value: JsonValue | undefined): string { const name = string(value, 'server name', 128); if (/[\x00-\x1f\x7f]/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new DeliveryError('invalid_params', 'Invalid server name'); return name; }
function transport(value: JsonObject): string { return typeof value.command === 'string' ? 'stdio' : typeof value.url === 'string' ? 'http' : 'unsupported'; }
function map(value: JsonValue, environment: boolean, variableNames = false): JsonObject {
  const result = object(value); if (Object.keys(result).length > 64) throw new DeliveryError('capacity', 'Too many environment or header values');
  for (const [key, item] of Object.entries(result)) {
    if (!(environment ? /^[A-Za-z_][A-Za-z0-9_]*$/ : /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/).test(key)) throw new DeliveryError('invalid_params', 'Invalid environment or header name');
    const text = string(item, 'environment or header value', 16 * 1024, true);
    if (text.includes('\0') || text.includes('[redacted]') || (!environment && /[\r\n]/.test(text)) || (variableNames && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(text))) throw new DeliveryError('invalid_params', 'Invalid environment or header value');
  }
  jsonBytes(result, 64 * 1024); return result;
}
function httpUrl(value: JsonValue | undefined): string {
  const text = string(value, 'MCP URL', 4096); let url: URL; try { url = new URL(text); } catch { throw new DeliveryError('invalid_params', 'Invalid MCP URL'); }
  if (text.includes('[redacted]') || url.username || url.password || url.hash || /[\x00-\x20\x7f]/.test(text) || !['http:', 'https:'].includes(url.protocol)) throw new DeliveryError('invalid_params', 'MCP URL must use HTTP(S) without embedded credentials or fragments');
  return url.href;
}
function present(value: JsonObject, key: string): boolean { const item = value[key]; return item !== undefined && item !== null && item !== '' && (typeof item !== 'object' || Object.keys(item).length > 0); }
/** Merge against the unredacted user layer. Masked effective configuration is never written back. */
export class McpConfiguration {
  constructor(private native: Call, private controls?: (cwd: string, userFileOnly?: boolean) => Promise<JsonObject>) {}
  private async userEditor(cwd: string, optional = false): Promise<JsonObject> {
    if (!this.controls) return {};
    try { return await this.controls(cwd, true); }
    catch (error) {
      if (!(error instanceof DeliveryError) || (!optional && !['invalid_input', 'thread_history_invalid', 'history_compatibility_unavailable'].includes(error.code))) throw error;
      return {}; // Earlier controls and native-only clients can still read.
    }
  }
  private async source(cwd: string, editor?: JsonObject) {
    const value = await this.native('config/read', { cwd, includeLayers: true }); validateOfficial('ConfigReadResponse', value); const response = object(value);
    jsonBytes(response, 1024 * 1024);
    const layers = ((response.layers as JsonValue[] | null) ?? []).map(value => object(value));
    const users = layers.filter(layer => { const name = object(layer.name); return name.type === 'user' && name.profile === null; });
    if (users.length > 1) throw new DeliveryError('invalid_native_response', 'Ambiguous user configuration');
    const config = users.length ? object(users[0]!.config) : {};
    const baseVersion = users.length ? string(users[0]!.version, 'user version') : null;
    const servers = object(config.mcp_servers ?? {}), effective = object(object(response.config).mcp_servers ?? {});
    const session = layers.findIndex(layer => object(layer.name).type === 'sessionFlags');
    const locked = new Set<string>();
    // Requirements, MDM or another higher-priority authority can make an
    // enabled flag immutable. Reject before publishing a preference.
    for (const layer of session < 0 ? [] : layers.slice(0, session)) {
      if (layer.disabledReason) continue;
      for (const [name, row] of Object.entries(object(object(layer.config).mcp_servers ?? {}))) {
        if (typeof object(row).enabled === 'boolean') locked.add(name);
      }
    }
    const system = layers.find(layer => object(layer.name).type === 'system' && !layer.disabledReason);
    const systemServers = object(system ? object(system.config).mcp_servers ?? {} : {});
    const state = this.controls && system ? await this.controls(cwd) : {};
    const flags = object(state.flags ?? {}), flagsVersion = state.version ?? null;
    // The fixed helper owns the private switch file. Bind its writes to the exact
    // user TOML bytes, including native types that JSON cannot represent.
    const hasFileVersion = Object.hasOwn(state, 'fileVersion');
    const helperVersion = hasFileVersion ? (state.fileVersion ?? null) : baseVersion;
    const fileState = flagsVersion ? {} : editor ?? await this.userEditor(cwd, true);
    const version = flagsVersion ? [baseVersion ?? '', flagsVersion, ...(hasFileVersion ? [helperVersion ?? ''] : [])].join('|')
      : fileState.userConfigEdits === 1 ? [baseVersion ?? '', fileState.fileVersion ?? ''].join('|') : baseVersion;
    // Native lists layers in decreasing precedence. Session flags supplied by
    // this adapter contain only booleans, so the next lower explicit value
    // determines what restoring inheritance will do.
    const enabledExcept = (name: string, skip: (layer: JsonObject) => boolean): boolean => {
      for (const layer of layers) {
        if (layer.disabledReason || skip(layer)) continue;
        const entries = object(object(layer.config).mcp_servers ?? {});
        const enabled = Object.hasOwn(entries, name) ? object(entries[name]).enabled : undefined;
        if (typeof enabled === 'boolean') return enabled;
      }
      return true;
    };
    const withoutSession = (name: string) => enabledExcept(name, layer => object(layer.name).type === 'sessionFlags');
    const withoutUser = (name: string) => enabledExcept(name, layer => layer === users[0]);
    const codingPlanDefaults = new Set(Array.isArray(state.codingPlanHttpDefaults) ? state.codingPlanHttpDefaults : []);
    return { version, baseVersion, helperVersion, flagsVersion, flags, codingPlanDefaults, unassigned: object(state.unassigned ?? {}), managedOwners: object(state.managedOwners ?? {}), file: state.filePath, servers, effective, systemServers, locked, withoutSession, withoutUser };
  }
  async read(cwd: string): Promise<JsonValue> {
    const { version, servers, effective, flags, codingPlanDefaults, unassigned, managedOwners, systemServers, locked, withoutSession, withoutUser } = await this.source(cwd);
    const inheritedDetails = Object.entries(effective).filter(([name]) => !Object.hasOwn(servers, name)).map(([name, row]) => {
      const effectiveEnabled = object(row).enabled !== false, overridden = Object.hasOwn(flags, name);
      const overrideAllowed = Object.hasOwn(systemServers, name) && !locked.has(name);
      const enabled = overrideAllowed ? overridden ? flags[name] === true : withoutSession(name) : effectiveEnabled;
      return { name, transport: transport(object(row)), ...(typeof managedOwners[name] === 'string' ? { managedOwner: managedOwners[name] } : {}), ...(codingPlanDefaults.has(name) ? { codingPlanHttpDefaultOff: true } : {}), enabled, effectiveEnabled, restartRequired: enabled !== effectiveEnabled, overridden, overrideAllowed };
    });
    const inheritedNames = new Set(inheritedDetails.map(item => item.name));
    return { userVersion: version, ...(Object.keys(unassigned).length ? { unassigned } : {}), servers: Object.entries(servers).filter(([name]) => !inheritedNames.has(name)).map(([name, entry]) => {
      const value = object(entry);
      const effectiveEnabled = Object.hasOwn(effective, name) ? object(effective[name]).enabled !== false : null;
      const hasEnabledOverride = typeof value.enabled === 'boolean';
      const result: JsonObject = { name, transport: transport(value), hasEnabledOverride,
        enabled: hasEnabledOverride ? value.enabled! : effectiveEnabled ?? true, effectiveEnabled, inheritedEnabled: withoutUser(name),
        hasEnv: stdioEnv.some(key => present(value, key)), hasForwardedEnv: present(value, 'env_vars'),
        hasHttpHeaders: httpHeaders.some(key => present(value, key)), hasHeaderHelper: present(value, 'http_headers_helper'),
        hasBearerTokenEnvVar: bearer.some(key => present(value, key)), hasEnvHttpHeaders: present(value, 'env_http_headers'), hasOAuthConfig: present(value, 'oauth') };
      for (const key of ['command', 'args', 'url']) if (value[key] !== undefined) result[key] = value[key]!;
      return result;
    }), inheritedServers: [...inheritedNames], inheritedDetails };
  }
  async write(params: JsonObject, cwd: string, write: Call): Promise<JsonValue> {
    onlyKeys(params, ['cwd', 'expectedVersion', 'name', 'change']); const expectedVersion = params.expectedVersion === null ? null : string(params.expectedVersion, 'expectedVersion'), name = serverName(params.name), change = object(params.change);
    onlyKeys(change, ['type', 'transport', 'command', 'args', 'url', 'enabled', 'env', 'httpHeaders', 'bearerTokenEnvVar', 'envHttpHeaders', 'clearSecrets', 'legacyName']);
    // Capture the file witness before the official layer read. An external edit
    // between these reads or before publication will fail the helper's compare.
    const userEdit = change.type === 'upsert' || change.type === 'remove';
    const editor = userEdit ? await this.userEditor(cwd) : undefined;
    const { version, helperVersion, servers, effective, systemServers, flagsVersion, unassigned, locked, withoutSession, withoutUser } = await this.source(cwd, editor);
    if (version !== expectedVersion) throw new DeliveryError('config_conflict', 'User configuration changed; reload before saving');
    const original = Object.hasOwn(servers, name) ? object(servers[name]) : undefined;
    const next: JsonObject = { ...servers };
    if (change.type === 'discardLegacy') {
      onlyKeys(change, ['type', 'enabled']);
      if (!Object.hasOwn(unassigned, name) || typeof change.enabled !== 'boolean' || unassigned[name] !== change.enabled || typeof flagsVersion !== 'string')
        throw new DeliveryError('config_conflict', '旧开关记录已变化，请重新读取。');
      const saved = object(await write('harness/mcp/enabled-override', { cwd, name, enabled: change.enabled,
        expectedVersion: helperVersion, expectedFlags: flagsVersion, discardLegacy: true }));
      const state = await this.source(cwd);
      if (saved.written !== true || saved.version !== state.flagsVersion || Object.hasOwn(state.unassigned, name))
        throw new DeliveryError('config_readback_unknown', '旧开关记录的移除结果未确认。', 'unknown');
      return { status: 'ok', version: saved.version, filePath: saved.filePath! };
    }
    if (change.type === 'inherit') {
      onlyKeys(change, ['type', 'enabled', 'legacyName']);
      const recovery = change.legacyName === undefined ? {} : { legacyName: serverName(change.legacyName) };
      if (locked.has(name) || !Object.hasOwn(systemServers, name) || !Object.hasOwn(effective, name) || original || typeof flagsVersion !== 'string')
        throw new DeliveryError('mcp_missing', '该继承服务已变化，请重新读取有效配置。');
      if (change.enabled !== null && typeof change.enabled !== 'boolean') throw new DeliveryError('invalid_params', 'Choose an enabled override or restore inheritance');
      const desired = change.enabled ?? withoutSession(name);
      const saved = object(await write('harness/mcp/enabled-override', { cwd, name, enabled: change.enabled!, expectedVersion: helperVersion, expectedFlags: flagsVersion, ...recovery }));
      const state = await this.source(cwd);
      if (saved.written !== true || saved.version !== state.flagsVersion || saved.effective !== desired ||
          (recovery.legacyName !== undefined && Object.hasOwn(state.unassigned, recovery.legacyName)) ||
          (change.enabled === null ? Object.hasOwn(state.flags, name) : state.flags[name] !== change.enabled))
        throw new DeliveryError('config_readback_unknown', '继承服务设置已写入，但原生读回未确认。', 'unknown');
      return { version: saved.version, status: 'ok', filePath: saved.filePath!, effective: desired, restartRequired: object(effective[name]).enabled !== desired };
    } else if (change.type === 'remove') {
      onlyKeys(change, ['type']); if (!original) throw new DeliveryError('mcp_missing', 'This server is not defined in the user layer'); delete next[name];
    } else if (change.type === 'upsert') {
      if (change.legacyName !== undefined) throw new DeliveryError('invalid_params', 'Choose an inherited server to restore this switch');
      if (!['stdio', 'http'].includes(String(change.transport))) throw new DeliveryError('invalid_params', 'Choose stdio or HTTP transport');
      if (change.enabled !== undefined && typeof change.enabled !== 'boolean' && !(original && change.enabled === null))
        throw new DeliveryError('invalid_params', 'Choose a boolean switch, or restore inheritance for an existing user service');
      if (change.clearSecrets !== undefined && change.clearSecrets !== true) throw new DeliveryError('invalid_params', 'Only an explicit clearSecrets:true clears saved values');
      const value: JsonObject = { ...(original ?? {}) };
      const switching = original && transport(original) !== change.transport;
      if (switching)
        for (const key of change.transport === 'stdio' ? httpOnly : stdioOnly) delete value[key];
      if (change.clearSecrets === true || switching)
        for (const key of [...stdioEnv, ...httpCredentials]) delete value[key];
      if (change.enabled === null) delete value.enabled;
      else if (change.enabled !== undefined) value.enabled = change.enabled;
      if (change.transport === 'stdio') {
        if (change.url !== undefined || change.httpHeaders !== undefined || change.bearerTokenEnvVar !== undefined || change.envHttpHeaders !== undefined) throw new DeliveryError('invalid_params', 'stdio cannot include HTTP fields');
        if (change.command !== undefined) { const command = string(change.command, 'command', 4096); if (!command.trim() || command.includes('\0') || command.includes('[redacted]')) throw new DeliveryError('invalid_params', 'Command must be a program name or path'); value.command = command; }
        if (change.args !== undefined) { if (!Array.isArray(change.args) || change.args.length > 256) throw new DeliveryError('invalid_params', 'args must be an array'); value.args = change.args.map(arg => { const text = string(arg, 'argument', 8192, true); if (text.includes('\0') || text.includes('[redacted]')) throw new DeliveryError('invalid_params', 'Arguments cannot contain NUL or masked values'); return text; }); }
        if (change.env !== undefined) value.env = map(change.env, true);
        if (typeof value.command !== 'string' || !value.command) throw new DeliveryError('invalid_params', 'stdio requires a command');
      } else {
        if (change.command !== undefined || change.args !== undefined || change.env !== undefined) throw new DeliveryError('invalid_params', 'HTTP cannot include stdio fields');
        if (change.url !== undefined) value.url = httpUrl(change.url);
        if (typeof value.url !== 'string') throw new DeliveryError('invalid_params', 'HTTP requires a URL');
        // Disabling a legacy credential-bearing URL must remain possible. Its
        // bytes are preserved only in the private layer; enabling still requires
        // migrating to the supported secret fields.
        const disabled = change.enabled === false || (change.enabled === null && !withoutUser(name)) || (change.enabled === undefined &&
          (original?.enabled === false || (Object.hasOwn(effective, name) && object(effective[name]).enabled === false)));
        if (!(original && disabled && change.url === undefined && Object.keys(change).every(key => ['type', 'transport', 'enabled'].includes(key)))) httpUrl(value.url);
        if (change.httpHeaders !== undefined) value.http_headers = map(change.httpHeaders, false);
        if (change.envHttpHeaders !== undefined) value.env_http_headers = map(change.envHttpHeaders, false, true);
        if (change.bearerTokenEnvVar !== undefined) { const key = string(change.bearerTokenEnvVar, 'bearer token environment name', 128); if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new DeliveryError('invalid_params', 'Bearer token must name an environment variable'); value.bearer_token_env_var = key; delete value.bearer_token; }
      }
      next[name] = value;
    } else throw new DeliveryError('invalid_params', 'Choose upsert or remove');
    if (Object.keys(next).length > 128) throw new DeliveryError('capacity', 'At most 128 user MCP servers can be edited through the workspace');
    jsonBytes(next, 1024 * 1024);
    if (editor?.userConfigEdits !== 1 || !Object.hasOwn(editor, 'fileVersion'))
      throw new DeliveryError('control_update_required', '请先更新实例控制工具，再保存自定义 MCP 服务。');
    const target = Object.hasOwn(next, name) ? next[name] : undefined;
    const changes: JsonObject | null = target === undefined ? null : {};
    if (changes !== null) {
      const row = object(target);
      for (const key of new Set([...Object.keys(original ?? {}), ...Object.keys(row)])) {
        if (!isDeepStrictEqual(original?.[key], row[key])) changes[key] = row[key] ?? null;
      }
    }
    const receipt = await write('harness/mcp/user-edit', { cwd, name, changes, expectedVersion: editor.fileVersion! });
    try {
      // Codex reparses the live user file. An empty batch hot-reloads it without
      // reserializing even the unmodified parts of an inline table.
      const saved = object(receipt);
      if (typeof saved.fileVersion !== 'string') throw new Error('Invalid file revision');
      const current = await this.source(cwd);
      if (!isDeepStrictEqual(current.servers, next)) throw new Error('User layer changed');
      const result = await write('config/batchWrite', { expectedVersion: current.baseVersion, edits: [], reloadUserConfig: true });
      validateOfficial('ConfigWriteResponse', result);
      const witness = await this.controls!(cwd, true);
      if (object(result).version !== current.baseVersion || saved.fileVersion !== witness.fileVersion) throw new Error('User file changed');
      return result;
    } catch {
      throw new DeliveryError('config_readback_unknown', '已提交 MCP 配置，但未能确认原生配置读回和重新加载结果。', 'unknown');
    }
  }
}
