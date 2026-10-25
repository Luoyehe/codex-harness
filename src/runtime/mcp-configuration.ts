import { DeliveryError, jsonBytes, object, onlyKeys, string, type JsonObject, type JsonValue } from './types.js';
import { validateOfficial } from './validation.js';

type Call = (method: string, params: JsonValue) => Promise<JsonValue>;
const sensitive = ['env', 'http_headers', 'bearer_token_env_var', 'env_http_headers', 'bearer_token'];
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
  constructor(private native: Call) {}
  private async source(cwd: string): Promise<{ version: string | null; servers: JsonObject; effective: JsonObject }> {
    const value = await this.native('config/read', { cwd, includeLayers: true }); validateOfficial('ConfigReadResponse', value); const response = object(value);
    jsonBytes(response, 1024 * 1024);
    const layers = (response.layers as JsonValue[] | null) ?? []; const users = layers.map(value => object(value)).filter(layer => { const name = object(layer.name); return name.type === 'user' && name.profile === null; });
    if (users.length > 1) throw new DeliveryError('invalid_native_response', 'Ambiguous user configuration');
    const config = users.length ? object(users[0]!.config) : {};
    return { version: users.length ? string(users[0]!.version, 'user version') : null, servers: object(config.mcp_servers ?? {}), effective: object(object(response.config).mcp_servers ?? {}) };
  }
  async read(cwd: string): Promise<JsonValue> {
    const { version, servers, effective } = await this.source(cwd);
    return { userVersion: version, servers: Object.entries(servers).map(([name, entry]) => {
      const value = object(entry), result: JsonObject = { name, transport: transport(value), enabled: value.enabled !== false, effectiveEnabled: Object.hasOwn(effective, name) ? object(effective[name]).enabled !== false : null,
        hasEnv: present(value, 'env'), hasHttpHeaders: present(value, 'http_headers'), hasBearerTokenEnvVar: present(value, 'bearer_token_env_var') || present(value, 'bearer_token'), hasEnvHttpHeaders: present(value, 'env_http_headers') };
      for (const key of ['command', 'args', 'url']) if (value[key] !== undefined) result[key] = value[key]!;
      return result;
    }), inheritedServers: Object.keys(effective).filter(name => !Object.hasOwn(servers, name)) };
  }
  async write(params: JsonObject, cwd: string, write: Call): Promise<JsonValue> {
    onlyKeys(params, ['cwd', 'expectedVersion', 'name', 'change']); const expectedVersion = string(params.expectedVersion, 'expectedVersion'), name = serverName(params.name), change = object(params.change);
    onlyKeys(change, ['type', 'transport', 'command', 'args', 'url', 'enabled', 'env', 'httpHeaders', 'bearerTokenEnvVar', 'envHttpHeaders', 'clearSecrets']);
    const { version, servers } = await this.source(cwd);
    if (version !== expectedVersion) throw new DeliveryError('config_conflict', 'User configuration changed; reload before saving');
    const original = Object.hasOwn(servers, name) ? object(servers[name]) : undefined;
    const next: JsonObject = { ...servers };
    if (change.type === 'remove') {
      onlyKeys(change, ['type']); if (!original) throw new DeliveryError('mcp_missing', 'This server is not defined in the user layer'); delete next[name];
    } else if (change.type === 'upsert') {
      if (!['stdio', 'http'].includes(String(change.transport))) throw new DeliveryError('invalid_params', 'Choose stdio or HTTP transport');
      if (change.enabled !== undefined && typeof change.enabled !== 'boolean') throw new DeliveryError('invalid_params', 'enabled must be boolean');
      if (change.clearSecrets !== undefined && change.clearSecrets !== true) throw new DeliveryError('invalid_params', 'Only an explicit clearSecrets:true clears saved values');
      const value: JsonObject = { ...(original ?? {}) };
      if (change.clearSecrets === true || (original && transport(original) !== change.transport)) for (const key of sensitive) delete value[key];
      if (change.enabled !== undefined) value.enabled = change.enabled;
      if (change.transport === 'stdio') {
        if (change.url !== undefined || change.httpHeaders !== undefined || change.bearerTokenEnvVar !== undefined || change.envHttpHeaders !== undefined) throw new DeliveryError('invalid_params', 'stdio cannot include HTTP fields');
        for (const key of ['url', 'http_headers', 'env_http_headers', 'bearer_token_env_var', 'bearer_token']) delete value[key];
        if (change.command !== undefined) { const command = string(change.command, 'command', 4096); if (!command.trim() || command.includes('\0') || command.includes('[redacted]')) throw new DeliveryError('invalid_params', 'Command must be a program name or path'); value.command = command; }
        if (change.args !== undefined) { if (!Array.isArray(change.args) || change.args.length > 256) throw new DeliveryError('invalid_params', 'args must be an array'); value.args = change.args.map(arg => { const text = string(arg, 'argument', 8192, true); if (text.includes('\0') || text.includes('[redacted]')) throw new DeliveryError('invalid_params', 'Arguments cannot contain NUL or masked values'); return text; }); }
        if (change.env !== undefined) value.env = map(change.env, true);
        if (typeof value.command !== 'string' || !value.command) throw new DeliveryError('invalid_params', 'stdio requires a command');
      } else {
        if (change.command !== undefined || change.args !== undefined || change.env !== undefined) throw new DeliveryError('invalid_params', 'HTTP cannot include stdio fields');
        for (const key of ['command', 'args', 'env', 'env_vars', 'cwd']) delete value[key];
        if (change.url !== undefined) value.url = httpUrl(change.url);
        if (typeof value.url !== 'string') throw new DeliveryError('invalid_params', 'HTTP requires a URL'); httpUrl(value.url);
        if (change.httpHeaders !== undefined) value.http_headers = map(change.httpHeaders, false);
        if (change.envHttpHeaders !== undefined) value.env_http_headers = map(change.envHttpHeaders, false, true);
        if (change.bearerTokenEnvVar !== undefined) { const key = string(change.bearerTokenEnvVar, 'bearer token environment name', 128); if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new DeliveryError('invalid_params', 'Bearer token must name an environment variable'); value.bearer_token_env_var = key; delete value.bearer_token; }
      }
      next[name] = value;
    } else throw new DeliveryError('invalid_params', 'Choose upsert or remove');
    if (Object.keys(next).length > 128) throw new DeliveryError('capacity', 'At most 128 user MCP servers can be edited through the workspace');
    jsonBytes(next, 1024 * 1024);
    const result = await write('config/batchWrite', { expectedVersion, edits: [{ keyPath: 'mcp_servers', value: next, mergeStrategy: 'replace' }], reloadUserConfig: true });
    try { validateOfficial('ConfigWriteResponse', result); } catch { throw new DeliveryError('invalid_native_response', 'MCP configuration write result is unknown', 'unknown'); }
    return result;
  }
}
