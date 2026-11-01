import path from 'node:path';
import { DeliveryError, jsonBytes, object, string, type JsonObject, type JsonValue } from './types.js';

const text = (value: JsonValue | undefined, maximum: number): string => typeof value === 'string' ? Array.from(value).slice(0, maximum).join('') : '';
const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

/** Creation acknowledgements bridge native indexing lag, never replace persisted pagination. */
export class LiveThreadList {
  private rows = new Map<string, JsonObject>();
  private reservations = 0;
  constructor(private maximum = 2048) {}
  reserve(): () => void {
    if (this.rows.size + this.reservations >= this.maximum) throw new DeliveryError('thread_list_capacity', 'Refresh the project list or close an unused newly created thread before creating another');
    this.reservations++; let released = false;
    return () => { if (!released) { released = true; this.reservations--; } };
  }
  capture(thread: JsonObject, cwd: string): void {
    if (thread.ephemeral === true || thread.parentThreadId != null) return;
    const id = string(thread.id, 'created thread id', 256);
    const source = typeof thread.source === 'string' ? thread.source : 'appServer';
    if (!['cli', 'vscode', 'appServer', 'exec'].includes(source)) return;
    if (!this.rows.has(id) && this.rows.size >= this.maximum) throw new DeliveryError('thread_list_capacity', 'New thread listing capacity exceeded');
    const now = Math.floor(Date.now() / 1000);
    const row: JsonObject = {
      id, cwd: string(thread.cwd ?? cwd, 'created thread cwd'), source,
      modelProvider: text(thread.modelProvider, 256), preview: text(thread.preview, 256), name: typeof thread.name === 'string' ? text(thread.name, 128) : null,
      createdAt: typeof thread.createdAt === 'number' ? thread.createdAt : now,
      updatedAt: typeof thread.updatedAt === 'number' ? thread.updatedAt : now,
      recencyAt: typeof thread.recencyAt === 'number' ? thread.recencyAt : now,
      status: { type: typeof thread.status === 'object' && thread.status !== null && !Array.isArray(thread.status) ? text(thread.status.type, 32) : 'idle' },
      parentThreadId: null, ephemeral: false,
    };
    jsonBytes(row, 8192); this.rows.set(id, row);
  }
  notification(method: string, params: JsonObject): void {
    if (typeof params.threadId !== 'string') return;
    if (['thread/closed', 'thread/deleted', 'thread/archived'].includes(method)) { this.rows.delete(params.threadId); return; }
    const row = this.rows.get(params.threadId); if (!row) return;
    if (method === 'thread/name/updated') row.name = text(params.threadName, 128) || null;
    if (method === 'thread/status/changed') row.status = { type: text(object(params.status).type, 32) };
    if (method === 'turn/started' || method === 'turn/completed') {
      row.status = { type: method === 'turn/started' ? 'active' : 'idle' };
      row.updatedAt = row.recencyAt = Math.floor(Date.now() / 1000);
    }
    if (method === 'thread/settings/updated') { const settings = object(params.threadSettings); if (typeof settings.modelProvider === 'string') row.modelProvider = text(settings.modelProvider, 256); }
  }
  preview(id: string, value: string): void { const row = this.rows.get(id); if (row && !row.preview) row.preview = text(value, 256); }
  remove(id: string): void { this.rows.delete(id); }
  page(params: JsonObject, persisted: JsonObject): JsonObject {
    for (const value of persisted.data as JsonValue[]) { const row = object(value); if (typeof row.id === 'string') this.rows.delete(row.id); }
    if (params.cursor != null || params.archived === true) return persisted;
    const cwd = typeof params.cwd === 'string' ? params.cwd : undefined;
    const search = typeof params.searchTerm === 'string' ? params.searchTerm.toLowerCase() : '';
    const rows = [...this.rows.values()].filter(row => (!cwd || samePath(String(row.cwd), cwd)) && (!search || String(row.name || row.preview).toLowerCase().includes(search)));
    const sort = params.sortKey === 'created_at' ? 'createdAt' : params.sortKey === 'updated_at' ? 'updatedAt' : 'recencyAt';
    rows.sort((a, b) => (Number(a[sort]) - Number(b[sort]) || String(a.id).localeCompare(String(b.id))) * (params.sortDirection === 'asc' ? 1 : -1));
    // A separate field keeps the native limit and cursor authoritative. The
    // full cache remains retained even when this bounded view is truncated.
    return { ...persisted, liveData: rows.slice(0, 100), liveDataTruncated: rows.length > 100 };
  }
  clear(): void { this.rows.clear(); }
}
