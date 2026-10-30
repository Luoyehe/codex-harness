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
import { OperationRetention, operationId } from './operation-retention.js';
import { mcpOauthError, mcpOauthReceipt } from './mcp-oauth-receipt.js';

type Row = Record<string, unknown>;
const workspaceConfirmations = new Set(['workspace/write', 'workspace/mkdir', 'workspace/copy', 'workspace/remove', 'workspace/recovery/restore', 'workspace/recovery/discard', 'workspace/worktree/create', 'workspace/worktree/attach', 'workspace/worktree/archive', 'workspace/worktree/restore', 'workspace/git/commit', 'workspace/git/stage', 'workspace/git/unstage', 'workspace/git/index/recovery/restore', 'workspace/git/index/recovery/discard']);
const payloadBytes = "length(CAST(coalesce(result,'') AS BLOB)) + length(CAST(coalesce(error,'') AS BLOB))";
const recoverable = `method LIKE 'system/%' OR method IN (${[...workspaceConfirmations].map(method => `'${method}'`).join(',')})`;
function receipt(row: Row): Receipt {
  const state = row.state as ReceiptState;
  const error = typeof row.error === 'string' ? mcpOauthError(String(row.method), JSON.parse(row.error) as ErrorBody) : undefined;
  return {
    operationId: String(row.id), method: String(row.method), scope: String(row.scope),
    state, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    // A legacy full journal may retain its old payload when only the state can
    // be persisted. That payload is evidence, never an accepted response.
    ...(state === 'accepted' && typeof row.result === 'string' ? { result: mcpOauthReceipt(String(row.method), JSON.parse(row.result) as JsonValue) } : {}),
    ...(state !== 'accepted' && error ? { error: { ...error, ...(['unknown', 'not_sent'].includes(state) ? { delivery: state as 'unknown' | 'not_sent' } : {}) } } : {}),
  };
}

/** A single gateway owns this journal. A retired generation can never dispatch again. */
export class Ledger {
  readonly #db: DatabaseSync;
  readonly automations: Automations;
  readonly worktrees: Worktrees;
  private readonly retention: OperationRetention;
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
    // Older recover() calls wrote errors without charging them. Repair only
    // accounting; never discard legacy receipts, even when already over quota.
    this.#db.exec(`UPDATE receipts SET bytes=${payloadBytes} WHERE bytes<>(${payloadBytes})`);
    this.retention = new OperationRetention(this.#db, now);
    this.automations = new Automations(this.#db, now, () => this.newOperationId());
    this.worktrees = new Worktrees(this.#db, now);
  }
  operationGeneration(): number { return this.retention.generation(); }
  newOperationId(): string { return operationId(this.operationGeneration()); }
  maintenancePreview(): JsonValue { return this.retention.preview(); }
  maintenanceChunk(params: { digest: string; offset: number; limit?: number }): JsonValue {
    return this.retention.chunk(params.digest, params.offset, params.limit);
  }
  rotate(params: { digest: string; nextGeneration: number; exportedDigest: string }): JsonValue {
    return this.transaction(() => this.retention.rotate(params));
  }
  usage(): JsonValue { return this.retention.usage(); }
  hasWorkspaceReceipts(): boolean {
    return !!this.#db.prepare("SELECT 1 FROM receipts WHERE state='accepted' AND method LIKE 'workspace/%' LIMIT 1").get();
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
      let unknown = 0, notSent = 0;
      for (const row of this.#db.prepare("SELECT id,state FROM receipts WHERE state IN ('pending','dispatching') ORDER BY id").all()) {
        const dispatched = row.state === 'dispatching';
        this.settle(String(row.id), { ok: false, error: dispatched
          ? { code: 'interrupted_after_dispatch', message: '服务在操作完成确认前中断，请检查历史；不要重复发送。', delivery: 'unknown' }
          : { code: 'interrupted_before_dispatch', message: '服务在发送前中断，此操作未发出。', delivery: 'not_sent' } });
        if (dispatched) unknown++; else notSent++;
      }
      this.automations.recover();
      return { unknown, notSent };
    });
  }
  private capacity(excludeId = ''): { count: number; bytes: number; pending: number; recovery: number } {
    // This gateway is the sole live journal writer. Offline manager recovery
    // stops both services; the next constructor repairs its legacy counters.
    // Every write below maintains bytes, so admission need not reread payloads.
    const row = this.#db.prepare(`SELECT count(*) AS count,coalesce(sum(actual),0) AS bytes,
      coalesce(sum(CASE WHEN state IN ('pending','dispatching') THEN max(0,${LIMITS.receiptBytes}-actual) ELSE 0 END),0) AS pending,
      coalesce(sum(CASE WHEN state='unknown' AND (${recoverable}) THEN max(0,${LIMITS.receiptBytes}-actual) ELSE 0 END),0) AS recovery
      FROM (SELECT state,method,bytes AS actual FROM receipts WHERE id<>?)`).get(excludeId)!;
    return { count: Number(row.count), bytes: Number(row.bytes), pending: Number(row.pending), recovery: Number(row.recovery) };
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
      this.retention.assertCurrent(id);
      const totals = this.capacity();
      const retired = Number(this.#db.prepare('SELECT count(*) AS count FROM retired_operations').get()!.count);
      // An unknown recoverable operation still owns its eventual positive
      // receipt's capacity. Settling a lost acknowledgement must not release it.
      if (totals.count + retired >= LIMITS.receiptCount || totals.bytes + totals.pending + totals.recovery + LIMITS.receiptBytes > LIMITS.receiptStorageBytes)
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
      const prior = this.#db.prepare('SELECT * FROM receipts WHERE id=?').get(id);
      if (!prior || !['pending', 'dispatching'].includes(String(prior.state))) throw new HarnessError('operation_state', '不能覆盖已保存的操作结果。');
      let state: ReceiptState = result.ok ? 'accepted' : result.error.delivery === 'not_sent' ? 'not_sent' : 'unknown';
      let value = result.ok ? JSON.stringify(mcpOauthReceipt(String(prior.method), result.value)) : null;
      let error = result.ok ? null : JSON.stringify(mcpOauthError(String(prior.method), result.error));
      if (value !== null && Buffer.byteLength(value) > LIMITS.receiptBytes) {
        state = 'unknown'; value = null;
        error = JSON.stringify({ code: 'result_capacity', message: '操作可能已执行，但结果超过保存上限，请检查历史。', delivery: 'unknown' });
      }
      if (error !== null && Buffer.byteLength(error) > LIMITS.receiptBytes)
        error = JSON.stringify({ code: 'error_capacity', message: '操作错误详情超过保存上限，请核对操作状态。', delivery: state === 'not_sent' ? 'not_sent' : 'unknown' });
      let bytes = Buffer.byteLength(value ?? '') + Buffer.byteLength(error ?? '');
      const totals = this.capacity(id);
      if (totals.bytes + totals.pending + bytes > LIMITS.receiptStorageBytes) {
        // Only legacy journals can lack an admitted operation's promised room.
        // Do not claim acceptance when its result cannot be retained. Settling
        // inherited pending work may reduce overcommitment, but cannot grow an
        // already full physical payload budget, even for a short diagnostic.
        state = state === 'not_sent' ? 'not_sent' : 'unknown'; value = null;
        error = JSON.stringify({ code: 'journal_capacity', message: '操作日志没有足够空间保存结果，请核对原操作；不要重复发送。', delivery: state });
        bytes = Buffer.byteLength(error);
      }
      if (totals.bytes + bytes <= LIMITS.receiptStorageBytes) {
        this.#db.prepare(`UPDATE receipts SET state=?,result=?,error=?,bytes=?,updated_at=? WHERE id=?`)
          .run(state, value, error, bytes, this.now(), id);
      } else {
        this.#db.prepare(`UPDATE receipts SET state=?,bytes=${payloadBytes},updated_at=? WHERE id=?`).run(state, this.now(), id);
      }
      if (state === 'unknown') this.setMeta('activityUncertain', 'true');
      return this.read(id)!;
    });
  }
  read(id: string): Receipt | null {
    const row = this.#db.prepare('SELECT * FROM receipts WHERE id=?').get(id);
    if (row) return receipt(row);
    const retired = this.#db.prepare('SELECT created_at FROM retired_operations WHERE id=?').get(id);
    return retired ? { operationId: id, method: 'operation/retire', scope: 'operation:' + id, state: 'not_sent', createdAt: Number(retired.created_at), updatedAt: Number(retired.created_at), error: { code: 'operation_retired', message: '该操作编号在登记前已被阻止，迟到请求不会执行。', delivery: 'not_sent' } } : this.retention.archived(id);
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
    return this.transaction(() => {
      const prior = this.read(id);
      if (!prior) throw new HarnessError('operation_missing', '操作记录不存在。');
      if (prior.state !== 'unknown' || !prior.method.startsWith('system/')) return prior;
      this.confirmationCapacity(id, Buffer.byteLength(value));
      this.#db.prepare(`UPDATE receipts SET state='accepted',result=?,error=NULL,bytes=?,updated_at=? WHERE id=?`)
        .run(value, Buffer.byteLength(value), this.now(), id);
      this.confirmed(); return this.read(id)!;
    });
  }
  private confirmationCapacity(id: string, bytes: number): void {
    const totals = this.capacity(id);
    const previous = Number(this.#db.prepare('SELECT bytes FROM receipts WHERE id=?').get(id)!.bytes);
    // Keep actual outstanding dispatch promises, but do not demand that every
    // other legacy unknown's previously unreserved maximum fit before making
    // progress on a positive proof that does fit.
    // Already oversized legacy evidence may converge one truthful proof at a
    // time. Only a strict payload reduction can retain an inherited excess;
    // outstanding dispatch promises stay unchanged and no new bytes are added.
    const reducesLegacyExcess = totals.bytes + previous > LIMITS.receiptStorageBytes && bytes < previous;
    if (totals.bytes + totals.pending + bytes > LIMITS.receiptStorageBytes && !reducesLegacyExcess)
      throw new HarnessError('journal_capacity', '操作日志没有足够空间保存核对回执，原记录保持未知。', 'unknown');
  }
  private confirmed(): void {
    if (!this.#db.prepare("SELECT 1 FROM receipts WHERE state='unknown' LIMIT 1").get()) this.setMeta('activityUncertain', 'false');
  }
  /** Only a supervisor-private positive witness, bound to this exact gateway request, can resolve file writes. */
  confirmWorkspace(id: string, method: string, scope: string, fingerprint: string, result: JsonValue): Receipt {
    if (!workspaceConfirmations.has(method)) throw new HarnessError('operation_state', '此操作不是可核对的文件操作。');
    const value = JSON.stringify(result);
    if (Buffer.byteLength(value) > LIMITS.receiptBytes) throw new HarnessError('capacity', '文件操作回执过大。');
    return this.transaction(() => {
      const pending = this.read(id);
      if (!pending) throw new HarnessError('operation_missing', '操作记录不存在。');
      if (pending.state !== 'unknown' || pending.method !== method || pending.scope !== scope || !this.matchesDigest(id, fingerprint)) return pending;
      this.confirmationCapacity(id, Buffer.byteLength(value));
      if (method.startsWith('workspace/worktree/')) this.worktrees.apply(method, scope.slice(8), id, result);
      this.#db.prepare(`UPDATE receipts SET state='accepted',result=?,error=NULL,bytes=?,updated_at=? WHERE id=?`)
        .run(value, Buffer.byteLength(value), this.now(), id);
      this.confirmed(); return this.read(id)!;
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
  renameProject(id: string, name: string): Project {
    identifier(id); identifier(validText(name, 128, '项目名称'), '项目名称');
    const label = name.trim(); if (!label) throw new HarnessError('invalid', '项目名称不能为空。');
    const row = this.#db.prepare('SELECT path FROM projects WHERE id=?').get(id);
    if (!row) throw new HarnessError('not_found', '项目已移除，请重新读取项目列表。');
    this.#db.prepare('UPDATE projects SET name=? WHERE id=?').run(label, id);
    return { id, name: label, path: String(row.path) };
  }
  removeProject(id: string): void { this.worktrees.protectRemoval(id); this.#db.prepare('DELETE FROM projects WHERE id=?').run(id); }
  close(): void { this.#db.close(); }
}
