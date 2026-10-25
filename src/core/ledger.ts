import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ErrorBody, JsonValue, Project, Receipt, ReceiptState } from './contracts.js';
import { LIMITS } from './contracts.js';
import { HarnessError } from './errors.js';
import { digest, identifier, validText } from './validation.js';
import { Automations } from './automations.js';
import { Worktrees } from './worktrees.js';

type Row = Record<string, unknown>;
function receipt(row: Row): Receipt {
  return {
    operationId: String(row.id), method: String(row.method), scope: String(row.scope),
    state: row.state as ReceiptState, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    ...(typeof row.result === 'string' ? { result: JSON.parse(row.result) as JsonValue } : {}),
    ...(typeof row.error === 'string' ? { error: JSON.parse(row.error) as ErrorBody } : {}),
  };
}

/** A single gateway owns this journal. Completed IDs are permanent tombstones. */
export class Ledger {
  readonly #db: DatabaseSync;
  readonly automations: Automations;
  readonly worktrees: Worktrees;
  #depth = 0;
  constructor(file: string, readonly now: () => number = Date.now) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(file, { timeout: 5000, allowExtension: false });
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS receipts (
        id TEXT PRIMARY KEY, method TEXT NOT NULL, scope TEXT NOT NULL, digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','dispatching','accepted','not_sent','unknown')),
        result TEXT, error TEXT, bytes INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS retired_operations(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`);
    this.automations = new Automations(this.#db, now);
    this.worktrees = new Worktrees(this.#db, now);
  }
  transaction<T>(operation: () => T): T {
    const depth = this.#depth++, savepoint = `harness_${depth}`;
    try {
      this.#db.exec(depth ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
      try { const result = operation(); this.#db.exec(depth ? `RELEASE ${savepoint}` : 'COMMIT'); return result; }
      catch (error) { this.#db.exec(depth ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK'); throw error; }
    } finally { this.#depth--; }
  }
  recover(): { unknown: number; notSent: number } {
    return this.transaction(() => {
      const t = this.now();
      const notSent = Number(this.#db.prepare(`UPDATE receipts SET state='not_sent',updated_at=?,error=? WHERE state='pending'`)
        .run(t, JSON.stringify({ code: 'interrupted_before_dispatch', message: '服务在发送前中断，此操作未发出。', delivery: 'not_sent' })).changes);
      const unknown = Number(this.#db.prepare(`UPDATE receipts SET state='unknown',updated_at=?,error=? WHERE state='dispatching'`)
        .run(t, JSON.stringify({ code: 'interrupted_after_dispatch', message: '服务在操作完成确认前中断，请检查历史；不要重复发送。', delivery: 'unknown' })).changes);
      if (unknown) this.setMeta('activityUncertain', 'true');
      this.automations.recover();
      return { unknown, notSent };
    });
  }
  reserve(id: string, method: string, params: JsonValue, scope: string): { created: boolean; receipt: Receipt } {
    const fingerprint = digest({ method, params });
    return this.transaction(() => {
      if (this.#db.prepare('SELECT id FROM retired_operations WHERE id=?').get(id))
        throw new HarnessError('operation_retired', '该操作编号已被阻止，迟到的原请求不会执行。');
      const prior = this.#db.prepare('SELECT * FROM receipts WHERE id=?').get(id);
      if (prior) {
        if (prior.digest !== fingerprint || prior.scope !== scope) throw new HarnessError('operation_conflict', '该操作编号已用于不同内容。');
        return { created: false, receipt: receipt(prior) };
      }
      const totals = this.#db.prepare(`SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes,
        coalesce(sum(CASE WHEN state IN ('pending','dispatching') THEN 1 ELSE 0 END),0) AS pending FROM receipts`).get()!;
      const retired = Number(this.#db.prepare('SELECT count(*) AS count FROM retired_operations').get()!.count);
      if (Number(totals.count) + retired >= LIMITS.receiptCount || Number(totals.bytes) + (Number(totals.pending) + 1) * LIMITS.receiptBytes > LIMITS.receiptStorageBytes)
        throw new HarnessError('journal_capacity', '操作日志已达容量上限；请备份并由管理员处理，未执行新操作。');
      const t = this.now();
      this.#db.prepare(`INSERT INTO receipts(id,method,scope,digest,state,created_at,updated_at) VALUES(?,?,?,?,'pending',?,?)`)
        .run(id, method, scope, fingerprint, t, t);
      return { created: true, receipt: this.read(id)! };
    });
  }
  dispatch(id: string): void {
    const change = this.#db.prepare(`UPDATE receipts SET state='dispatching',updated_at=? WHERE id=? AND state='pending'`).run(this.now(), id);
    if (Number(change.changes) !== 1) throw new HarnessError('operation_state', '操作已离开发送前状态。');
  }
  settle(id: string, result: { ok: true; value: JsonValue } | { ok: false; error: ErrorBody }): Receipt {
    return this.transaction(() => {
      const prior = this.read(id);
      if (!prior || !['pending', 'dispatching'].includes(prior.state)) throw new HarnessError('operation_state', '不能覆盖已保存的操作结果。');
      let state: ReceiptState = result.ok ? 'accepted' : result.error.delivery === 'not_sent' ? 'not_sent' : 'unknown';
      let value = result.ok ? JSON.stringify(result.value) : null;
      let error = result.ok ? null : JSON.stringify(result.error);
      if (value !== null && Buffer.byteLength(value) > LIMITS.receiptBytes) {
        state = 'unknown'; value = null;
        error = JSON.stringify({ code: 'result_capacity', message: '操作可能已执行，但结果超过保存上限，请检查历史。', delivery: 'unknown' });
      }
      const bytes = Buffer.byteLength(value ?? '') + Buffer.byteLength(error ?? '');
      this.#db.prepare(`UPDATE receipts SET state=?,result=?,error=?,bytes=?,updated_at=? WHERE id=?`)
        .run(state, value, error, bytes, this.now(), id);
      if (state === 'unknown') this.setMeta('activityUncertain', 'true');
      return this.read(id)!;
    });
  }
  read(id: string): Receipt | null {
    const row = this.#db.prepare('SELECT * FROM receipts WHERE id=?').get(id);
    if (row) return receipt(row);
    const retired = this.#db.prepare('SELECT created_at FROM retired_operations WHERE id=?').get(id);
    return retired ? { operationId: id, method: 'operation/retire', scope: 'operation:' + id, state: 'not_sent', createdAt: Number(retired.created_at), updatedAt: Number(retired.created_at), error: { code: 'operation_retired', message: '该操作编号在登记前已被阻止，迟到请求不会执行。', delivery: 'not_sent' } } : null;
  }
  /** Fence only an unregistered ID. Existing records, including pending/unknown, are never changed. */
  retire(id: string): Receipt {
    return this.transaction(() => {
      const existing = this.read(id); if (existing) return existing;
      const count = this.#db.prepare('SELECT (SELECT count(*) FROM receipts) + (SELECT count(*) FROM retired_operations) AS count').get()!;
      if (Number(count.count) >= LIMITS.receiptCount) throw new HarnessError('journal_capacity', '操作日志已达容量上限，未阻止该请求。');
      this.#db.prepare('INSERT INTO retired_operations(id,created_at) VALUES(?,?)').run(id, this.now());
      return this.read(id)!;
    });
  }
  matchesDigest(id: string, fingerprint: unknown): boolean {
    if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) return false;
    return this.#db.prepare('SELECT digest FROM receipts WHERE id=?').get(id)?.digest === fingerprint;
  }
  /** Only a trusted manager's durable positive receipt may resolve an unknown management operation. */
  confirm(id: string, result: JsonValue): Receipt {
    const value = JSON.stringify(result);
    if (Buffer.byteLength(value) > LIMITS.receiptBytes) throw new HarnessError('capacity', '管理回执过大。');
    this.#db.prepare(`UPDATE receipts SET state='accepted',result=?,error=NULL,bytes=?,updated_at=? WHERE id=? AND state='unknown' AND method LIKE 'system/%'`)
      .run(value, Buffer.byteLength(value), this.now(), id);
    const stored = this.read(id);
    if (!stored) throw new HarnessError('operation_missing', '操作记录不存在。');
    return stored;
  }
  /** Only a supervisor-private positive witness, bound to this exact gateway request, can resolve file writes. */
  confirmWorkspace(id: string, method: string, scope: string, fingerprint: string, result: JsonValue): Receipt {
    if (!['workspace/write', 'workspace/mkdir', 'workspace/copy', 'workspace/remove', 'workspace/recovery/restore', 'workspace/recovery/discard', 'workspace/worktree/create', 'workspace/worktree/attach', 'workspace/worktree/archive', 'workspace/worktree/restore', 'workspace/git/commit', 'workspace/git/stage', 'workspace/git/unstage', 'workspace/git/index/recovery/restore', 'workspace/git/index/recovery/discard'].includes(method)) throw new HarnessError('operation_state', '此操作不是可核对的文件操作。');
    const value = JSON.stringify(result);
    if (Buffer.byteLength(value) > LIMITS.receiptBytes) throw new HarnessError('capacity', '文件操作回执过大。');
    return this.transaction(() => {
      const pending = this.read(id);
      if (pending?.state === 'unknown' && pending.method === method && pending.scope === scope && this.matchesDigest(id, fingerprint) && method.startsWith('workspace/worktree/')) this.worktrees.apply(method, scope.slice(8), id, result);
      this.#db.prepare(`UPDATE receipts SET state='accepted',result=?,error=NULL,bytes=?,updated_at=? WHERE id=? AND state='unknown' AND method=? AND scope=? AND digest=?`)
        .run(value, Buffer.byteLength(value), this.now(), id, method, scope, fingerprint);
      const stored = this.read(id); if (!stored) throw new HarnessError('operation_missing', '操作记录不存在。');
      if (!Number(this.#db.prepare(`SELECT count(*) AS count FROM receipts WHERE state='unknown'`).get()!.count)) this.setMeta('activityUncertain', 'false');
      return stored;
    });
  }
  getMeta(key: string): string | null {
    const row = this.#db.prepare('SELECT value FROM metadata WHERE key=?').get(key);
    return row ? String(row.value) : null;
  }
  setMeta(key: string, value: string): void {
    this.#db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
  projects(): Project[] {
    return this.#db.prepare('SELECT id,name,path FROM projects ORDER BY name,id').all().map(row => ({ id: String(row.id), name: String(row.name), path: String(row.path) }));
  }
  project(id: string): Project {
    identifier(id);
    const found = this.projects().find(project => project.id === id);
    if (!found) throw new HarnessError('project_missing', '项目已移除，请重新选择项目。');
    return found;
  }
  addProject(path: string, name: string): Project {
    validText(path, 4096); validText(name, 128);
    const found = this.projects().find(project => project.path === path);
    if (found) return found;
    if (this.projects().length >= 128) throw new HarnessError('capacity', '项目数量已达上限。');
    const id = randomUUID();
    this.#db.prepare('INSERT INTO projects(id,name,path) VALUES(?,?,?)').run(id, name, path);
    return { id, name, path };
  }
  removeProject(id: string): void { this.worktrees.protectRemoval(id); this.#db.prepare('DELETE FROM projects WHERE id=?').run(id); }
  close(): void { this.#db.close(); }
}
