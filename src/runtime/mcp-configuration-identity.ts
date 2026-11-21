import { createHmac, randomBytes } from 'node:crypto';
import type { McpConfiguration } from './mcp-configuration.js';
import type { DiagnosticRedactor } from './redaction.js';
import { DeliveryError, object, onlyKeys, string, type JsonObject, type JsonValue } from './types.js';

type Group = 'user' | 'inherited' | 'legacy';
type Entry = { name: string; id: string };
const entries = (value: JsonValue | undefined) => (value as JsonValue[]).map(row => object(row));
const logicalName = (name: string) => name.replace(/-(?:default|[0-9a-f]{32})$/, '');
const stale = () => new DeliveryError('config_conflict', '服务配置或标识已变化，请重新读取并选择服务。');

/** Browser identifiers are separate from redacted display names and never contain native names. */
export class McpConfigurationIdentity {
  private readonly key = randomBytes(32);
  constructor(private config: McpConfiguration, private redactor: DiagnosticRedactor) {}
  private id(cwd: string, group: Group | 'version', value: string): string {
    return createHmac('sha256', this.key).update(JSON.stringify([cwd, group, value])).digest('hex');
  }
  private version(cwd: string, value: JsonValue): JsonValue {
    return typeof value === 'string' && this.redactor.text(value) !== value ? this.id(cwd, 'version', value) : value;
  }
  private indexes(cwd: string, raw: JsonObject) {
    const index = (group: Group, names: string[]) => names.map(name => ({ name, id: this.id(cwd, group, name) }));
    return {
      user: index('user', entries(raw.servers).map(row => String(row.name))),
      inherited: index('inherited', entries(raw.inheritedDetails).map(row => String(row.name))),
      legacy: index('legacy', Object.keys(object(raw.unassigned ?? {}))),
    };
  }
  async read(cwd: string): Promise<JsonValue> {
    const raw = object(await this.config.read(cwd)), ids = this.indexes(cwd, raw);
    const inherited = entries(raw.inheritedDetails), flags = object(raw.unassigned ?? {});
    const rows = (source: JsonObject[], keys: Entry[]) => source.map((row, i) => {
      const key = keys[i]!;
      const result: JsonObject = { name: this.redactor.text(key.name), id: key.id, transport: row.transport! };
      for (const field of ['enabled', 'effectiveEnabled', 'hasEnabledOverride', 'hasEnv', 'hasForwardedEnv', 'hasHttpHeaders', 'hasHeaderHelper', 'hasBearerTokenEnvVar', 'hasEnvHttpHeaders', 'hasOAuthConfig',
        'restartRequired', 'overrideAllowed', 'overridden', 'codingPlanHttpDefaultOff'])
        if (row[field] !== undefined) result[field] = row[field]!;
      for (const field of ['command', 'args', 'url', 'managedOwner'])
        if (row[field] !== undefined) result[field] = this.redactor.value(row[field]!);
      return result;
    });
    const legacySwitches = ids.legacy.map(entry => ({
      id: entry.id, name: this.redactor.text(entry.name), enabled: flags[entry.name]!,
      targetIds: ids.inherited.filter((target, i) => inherited[i]!.overrideAllowed === true &&
        logicalName(target.name) === logicalName(entry.name)).map(target => target.id),
    }));
    return {
      userVersion: this.version(cwd, raw.userVersion!),
      servers: rows(entries(raw.servers), ids.user), inheritedDetails: rows(inherited, ids.inherited),
      inheritedServers: ids.inherited.map(row => this.redactor.text(row.name)),
      ...(legacySwitches.length ? { legacySwitches,
        unassigned: Object.fromEntries(legacySwitches.map(row => [row.name, row.enabled])) } : {}),
    };
  }
  async write(params: JsonObject, cwd: string, write: Parameters<McpConfiguration['write']>[2]): Promise<JsonValue> {
    onlyKeys(params, ['cwd', 'expectedVersion', 'name', 'id', 'legacyId', 'createOnly', 'change']);
    const change = { ...object(params.change) };
    if ((params.id === undefined) === (params.name === undefined) ||
        (params.createOnly !== undefined && (params.createOnly !== true || params.id !== undefined || change.type !== 'upsert')) ||
        (params.legacyId !== undefined && (change.type !== 'inherit' || change.legacyName !== undefined)))
      throw new DeliveryError('invalid_params', '请选择一项已有配置或提供新增服务名称。');
    const raw = object(await this.config.read(cwd));
    if (params.expectedVersion !== this.version(cwd, raw.userVersion!)) throw stale();
    const ids = this.indexes(cwd, raw);
    const resolve = (group: Group, id: JsonValue) => {
      const entry = ids[group].find(row => row.id === id);
      if (!entry) throw stale();
      return entry.name;
    };
    const group = change.type === 'inherit' ? 'inherited' : change.type === 'discardLegacy' ? 'legacy' : 'user';
    const name = params.id === undefined ? string(params.name, 'server name', 128) : resolve(group, params.id);
    if (params.createOnly && ids.user.some(row => row.name === name))
      throw new DeliveryError('config_conflict', '此用户服务名称已存在，请重新读取并选择编辑。');
    // Older clients can still submit ordinary names. Their redacted display strings cannot identify a row.
    if ((params.id === undefined && !params.createOnly && name.includes('[redacted]')) ||
        (typeof change.legacyName === 'string' && change.legacyName.includes('[redacted]'))) throw stale();
    if (params.legacyId !== undefined) change.legacyName = resolve('legacy', params.legacyId);
    // The private writer rechecks this exact version at its own mutation boundary.
    try {
      const result = object(await this.config.write({ cwd, name, expectedVersion: raw.userVersion!, change }, cwd, write));
      return { ...result,
        ...(typeof result.filePath === 'string' ? { filePath: this.redactor.text(result.filePath) } : {}),
        ...(typeof result.version === 'string' ? { version: this.version(cwd, result.version) } : {}),
        ...(result.overriddenMetadata ? { overriddenMetadata: this.redactor.value(result.overriddenMetadata) } : {}) };
    } catch (error) {
      if (error instanceof DeliveryError)
        throw new DeliveryError(error.code, this.redactor.text(error.message), error.delivery,
          error.data === undefined ? undefined : this.redactor.value(error.data));
      throw error;
    }
  }
}
