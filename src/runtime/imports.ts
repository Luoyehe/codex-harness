import { createHash } from 'node:crypto';
import { canonical, DeliveryError, integer, jsonBytes, object, onlyKeys, string, type JsonObject, type JsonValue } from './types.js';
import { validateOfficial } from './validation.js';
type Call = (method: string, params: JsonObject) => Promise<JsonValue>;
const executableTypes = new Set(['CONFIG', 'PLUGINS', 'MCP_SERVER_CONFIG', 'SUBAGENTS', 'HOOKS', 'COMMANDS']);
const hash = (value: JsonValue): string => createHash('sha256').update(canonical(value)).digest('hex');
interface Waiting { resolve(value: JsonValue): void; reject(error: Error): void; timer: NodeJS.Timeout }
/** Native imports are asynchronous mutations; configuration stays locked until matching completion. */
export class Imports {
  private closed = false;
  private completed = new Map<string, JsonObject>();
  private waiting = new Map<string, Waiting>();
  constructor(private native: Call) {}
  notification(method: string, params: JsonObject): void {
    if (method !== 'externalAgentConfig/import/completed') return;
    try {
      validateOfficial('ExternalAgentConfigImportCompletedNotification', params); jsonBytes(params, 1024 * 1024); const id = string(params.importId, 'importId', 128);
      this.completed.set(id, structuredClone(params)); while (this.completed.size > 16) this.completed.delete(this.completed.keys().next().value!);
      const waiter = this.waiting.get(id); if (waiter) { clearTimeout(waiter.timer); this.waiting.delete(id); waiter.resolve(params); }
    } catch { /* Malformed events cannot prove completion; the bounded wait remains unknown. */ }
  }
  close(): void { this.closed = true; for (const waiter of this.waiting.values()) { clearTimeout(waiter.timer); waiter.reject(new DeliveryError('import_unknown', 'Runtime disconnected before import completion', 'unknown')); } this.waiting.clear(); this.completed.clear(); }
  private scope(params: JsonObject): { cwd: string; includeHome: boolean; maxSessionAgeDays: number; maxSessions: number } {
    const cwd = string(params.cwd, 'cwd', 4096);
    if (params.includeNativeHome !== undefined && typeof params.includeNativeHome !== 'boolean') throw new DeliveryError('invalid_params', 'includeNativeHome must be explicit boolean');
    return { cwd, includeHome: params.includeNativeHome === true, maxSessionAgeDays: integer(params.maxSessionAgeDays ?? 30, 'maximum session age', 1, 3650), maxSessions: integer(params.maxSessions ?? 100, 'maximum sessions', 1, 200) };
  }
  async preview(params: JsonObject): Promise<JsonObject> {
    onlyKeys(params, ['cwd', 'includeNativeHome', 'maxSessionAgeDays', 'maxSessions']); const scope = this.scope(params);
    const response = await this.native('externalAgentConfig/detect', { cwds: [scope.cwd], includeHome: scope.includeHome, maxSessionAgeDays: scope.maxSessionAgeDays, maxSessions: scope.maxSessions, migrationSource: 'claude-code' });
    validateOfficial('ExternalAgentConfigDetectResponse', response); jsonBytes(response, 1024 * 1024);
    const result = object(response); if (!Array.isArray(result.items) || result.items.length > 64) throw new DeliveryError('capacity', 'Migration discovery exceeds 64 item groups');
    const items = result.items.map(value => {
      const item = object(value); if (item.cwd !== scope.cwd && !(item.cwd === null && scope.includeHome)) throw new DeliveryError('import_scope', 'Native detection returned an item outside the selected scope');
      return { ...item, itemId: hash({ scope, item }), requiresExecutionReview: executableTypes.has(String(item.itemType)) };
    });
    return { source: 'claude-code', items, previewHash: hash({ scope, items }), scope: { cwd: scope.cwd, includeNativeHome: scope.includeHome },
      // Detection reports planned item groups, not a frozen copy of file bytes.
      previewKind: 'fresh_native_migration_inventory', trustInherited: false };
  }
  async apply(params: JsonObject, write: Call): Promise<JsonValue> {
    if (this.closed) throw new DeliveryError('runtime_unavailable', 'Import runtime is closed');
    onlyKeys(params, ['cwd', 'includeNativeHome', 'maxSessionAgeDays', 'maxSessions', 'previewHash', 'itemIds', 'confirm', 'allowNativeExecution']);
    const previewHash = string(params.previewHash, 'previewHash', 64);
    if (params.confirm !== true || !Array.isArray(params.itemIds) || !params.itemIds.length || params.itemIds.length > 64 || params.itemIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) || new Set(params.itemIds).size !== params.itemIds.length) throw new DeliveryError('invalid_params', 'Select distinct migration items and confirm the import');
    const previewParams: JsonObject = {}; for (const key of ['cwd', 'includeNativeHome', 'maxSessionAgeDays', 'maxSessions']) if (params[key] !== undefined) previewParams[key] = params[key]!;
    const fresh = await this.preview(previewParams);
    if (fresh.previewHash !== previewHash) throw new DeliveryError('import_changed', 'Detected migration items changed; review the new inventory');
    const selected = (fresh.items as JsonValue[]).map(value => object(value)).filter(item => (params.itemIds as JsonValue[]).includes(item.itemId!));
    if (selected.length !== params.itemIds.length) throw new DeliveryError('import_changed', 'Selected migration item is no longer present');
    if (selected.some(item => item.requiresExecutionReview === true) && params.allowNativeExecution !== true) throw new DeliveryError('import_execution_review', 'Review executable configuration before importing; it can become active under current project policy');
    const migrationItems = selected.map(item => { const { itemId: _id, requiresExecutionReview: _review, ...value } = item; return value; });
    const response = await write('externalAgentConfig/import', { migrationItems, migrationSource: 'claude-code', source: 'codex-harness' });
    if (this.closed) throw new DeliveryError('import_unknown', 'Runtime disconnected before import completion', 'unknown');
    let id: string;
    try { validateOfficial('ExternalAgentConfigImportResponse', response); id = string(object(response).importId, 'importId', 128); }
    catch { throw new DeliveryError('import_unknown', 'Import was sent without a valid import identity', 'unknown'); }
    let completed: JsonValue;
    if (this.completed.has(id)) completed = this.completed.get(id)!;
    else completed = await new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new DeliveryError('import_unknown', 'Import completion was not confirmed; inspect its recorded history', 'unknown', { importId: id })); }, 90_000); timer.unref(); this.waiting.set(id, { resolve, reject, timer });
    });
    return { importId: id, completed: true, itemTypeResults: object(completed).itemTypeResults! };
  }
  async history(params: JsonObject): Promise<JsonValue> {
    onlyKeys(params, ['cwd', 'includeNativeHome']); const scope = this.scope(params);
    const response = await this.native('externalAgentConfig/import/readHistories', {}); validateOfficial('ExternalAgentConfigImportHistoriesReadResponse', response); jsonBytes(response, 2 * 1024 * 1024);
    const data = object(response).data as JsonValue[];
    return { data: data.slice(0, 200).map(value => {
      const row = object(value); const filter = (entries: JsonValue): JsonValue[] => (entries as JsonValue[]).filter(item => object(item).cwd === scope.cwd || (scope.includeHome && object(item).cwd === null));
      return { ...row, successes: filter(row.successes!), failures: filter(row.failures!) };
    }).filter(row => (row.successes as JsonValue[]).length || (row.failures as JsonValue[]).length), complete: data.length <= 200 };
  }
}
