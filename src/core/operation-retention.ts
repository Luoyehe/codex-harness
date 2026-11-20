import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { LIMITS, type ErrorBody, type JsonObject, type JsonValue, type Receipt } from './contracts.js';
import { HarnessError } from './errors.js';
import { mcpOauthError, mcpOauthReceipt } from './mcp-oauth-receipt.js';

type Snapshot = { parts: Buffer[]; ends: number[]; bytes: number; expires: number };
function exportReceipt(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row,
    result: typeof row.result === 'string' ? mcpOauthReceipt(String(row.method), JSON.parse(row.result) as JsonValue) : null,
    error: typeof row.error === 'string' ? mcpOauthError(String(row.method), JSON.parse(row.error) as ErrorBody) : null };
}
const MAX_GENERATION = 0xffffffffffff;
const MAX_EXPORT_BYTES = 80 * 1024 * 1024;
const KEY = 'operationGeneration';
export const EMERGENCY_RECOVERY_KEY = 'emergencyRecoveryOperation';
export const OPERATION_EXPORT_TTL_MS = 10 * 60 * 1000;
export const OPERATION_EXPORT_SNAPSHOT_LIMIT = 2;
const scoped = /^([a-f0-9]{8})-([a-f0-9]{4})-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function operationId(generation: number): string {
  const random = randomUUID();
  if (generation === 0) return random;
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAX_GENERATION) throw new Error('Invalid operation generation');
  const prefix = generation.toString(16).padStart(12, '0');
  return `${prefix.slice(0, 8)}-${prefix.slice(8)}-8${random.slice(15)}`;
}

/** Bounded live receipts; retired generations are rejected without keeping every UUID forever. */
export class OperationRetention {
  // Two bounded generations allow separate tabs to finish their own exports.
  // Rotation still validates the latest live ledger, not a cached snapshot.
  private snapshots = new Map<string, Snapshot>();
  constructor(private readonly db: DatabaseSync, private readonly now: () => number = Date.now) {}

  generation(): number {
    const raw = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(KEY)?.value;
    if (raw === undefined) return 0;
    if (typeof raw !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(raw)) throw new HarnessError('journal_corrupt', '操作日志代际无效。');
    const generation = Number(raw);
    if (!Number.isSafeInteger(generation) || generation > MAX_GENERATION) throw new HarnessError('journal_corrupt', '操作日志代际超出范围。');
    return generation;
  }

  current(id: string): boolean {
    const generation = this.generation();
    if (!generation) return true; // Existing UUID clients remain supported before the first explicit rotation.
    const match = scoped.exec(id);
    return !!match && Number.parseInt(match[1]! + match[2]!, 16) === generation;
  }

  archived(id: string): Receipt | null {
    if (this.current(id)) return null;
    return {
      operationId: id, method: 'operation/archived', scope: 'operation:' + id,
      state: 'unknown', createdAt: 0, updatedAt: 0,
      error: { code: 'operation_archived', message: '该编号不属于当前操作代际，旧请求不会再次执行；请核对已导出的回执或实际历史。', delivery: 'unknown' },
    };
  }

  assertCurrent(id: string): void {
    if (!this.current(id)) throw new HarnessError('operation_archived', '操作编号不属于当前代际；不会执行或重放该请求，请核对历史。', 'unknown');
  }

  private nextGeneration(): number {
    let current = this.generation();
    if (!current) {
      // Legacy journals accepted all UUID versions. Never reuse a prefix already
      // present in a version-8 ID when entering the fenced format for the first time.
      for (const row of this.db.prepare('SELECT id FROM receipts UNION SELECT id FROM retired_operations UNION SELECT operation_id AS id FROM automation_runs').all()) {
        const match = scoped.exec(String(row.id));
        if (match) current = Math.max(current, Number.parseInt(match[1]! + match[2]!, 16));
      }
    }
    if (current >= MAX_GENERATION) throw new HarnessError('journal_capacity', '操作代际已耗尽，不能安全轮换。');
    return current + 1;
  }

  private archive(): { data: Buffer; digest: string; receipts: number; retirements: number; blocked: string[] } {
    const receipts = this.db.prepare('SELECT * FROM receipts ORDER BY id').all().map(exportReceipt);
    const retiredOperations = this.db.prepare('SELECT * FROM retired_operations ORDER BY id').all();
    const data = Buffer.from(JSON.stringify({ format: 1, generation: this.generation(), receipts, retiredOperations }), 'utf8');
    if (data.length > MAX_EXPORT_BYTES) throw new HarnessError('journal_capacity', '完整操作归档超过导出上限，日志保持原样。');
    const blocked: string[] = [];
    if (this.db.prepare('SELECT value FROM metadata WHERE key=?').get('activityUncertain')?.value === 'true') blocked.push('activity_uncertain');
    if (receipts.some(row => ['pending', 'dispatching', 'unknown'].includes(String(row.state)))) blocked.push('unresolved_operations');
    const active = this.db.prepare("SELECT count(*) AS count FROM automation_runs WHERE state IN ('queued','dispatching','running','needs_attention','stopping','unknown')").get()!;
    if (Number(active.count)) blocked.push('unresolved_automation_runs');
    return { data, digest: createHash('sha256').update(data).digest('hex'), receipts: receipts.length, retirements: retiredOperations.length, blocked };
  }

  /** Use a separate WAL read transaction in production so writes can proceed during export. */
  async previewLarge(check: () => void): Promise<JsonObject> {
    const file = this.db.location();
    const reader = file ? new DatabaseSync(file, { readOnly: true, allowExtension: false }) : this.db;
    const stamp = () => reader.prepare('SELECT total_changes() AS n').get()!.n;
    const initial = stamp();
    const validate = () => {
      check();
      if (!file && stamp() !== initial) throw new HarnessError('journal_changed', '预览期间日志已变更，请重试。');
    };
    if (file) reader.exec('BEGIN');
    try {
      const view = new OperationRetention(reader, this.now);
      const generation = view.generation(), nextGeneration = view.nextGeneration();
      const hash = createHash('sha256'), parts: Buffer[] = [], ends: number[] = [];
      let pending: Buffer[] = [], bytes = 0, chunkBytes = 0;
      const append = (value: string) => {
        const data = Buffer.from(value);
        bytes += data.length; chunkBytes += data.length;
        if (bytes > MAX_EXPORT_BYTES) throw new HarnessError('journal_capacity', '完整操作归档超过导出上限，日志保持原样。');
        pending.push(data); hash.update(data);
      };
      const flush = () => {
        if (pending.length) { parts.push(Buffer.concat(pending, chunkBytes)); ends.push(bytes); pending = []; chunkBytes = 0; }
      };
      let receipts = 0, retirements = 0, unresolved = false;
      append(`{"format":1,"generation":${generation},"receipts":[`);
      for (const table of ['receipts', 'retired_operations'] as const) {
        if (table === 'retired_operations') append('],"retiredOperations":[');
        let count = 0;
        for (const row of reader.prepare(`SELECT * FROM ${table} ORDER BY id`).iterate()) {
          if (count++) append(',');
          if (table === 'receipts') {
            unresolved ||= ['pending', 'dispatching', 'unknown'].includes(String(row.state));
            append(JSON.stringify(exportReceipt(row))); receipts++;
          } else { append(JSON.stringify(row)); retirements++; }
          if (chunkBytes >= 256 * 1024 || count % 64 === 0) { flush(); await yieldTurn(); validate(); }
        }
      }
      append(']}'); flush(); validate();
      const blocked: string[] = [];
      if (reader.prepare("SELECT value FROM metadata WHERE key='activityUncertain'").get()?.value === 'true') blocked.push('activity_uncertain');
      if (unresolved) blocked.push('unresolved_operations');
      if (reader.prepare("SELECT 1 FROM automation_runs WHERE state IN ('queued','dispatching','running','needs_attention','stopping','unknown') LIMIT 1").get()) blocked.push('unresolved_automation_runs');
      const last = reader.prepare("SELECT value FROM metadata WHERE key='lastOperationRotation'").get()?.value;
      const digest = hash.digest('hex');
      this.retain(digest, { parts, ends, bytes, expires: this.now() + OPERATION_EXPORT_TTL_MS });
      return { generation, nextGeneration, digest, bytes, receipts, retirements, blocked,
        ...(typeof last === 'string' ? { lastRotation: JSON.parse(last) as JsonValue } : {}) };
    } finally { if (file) { try { reader.exec('ROLLBACK'); } finally { reader.close(); } } }
  }
  private retain(digest: string, snapshot: Snapshot) {
    for (const [key, previous] of this.snapshots) if (previous.expires <= this.now()) this.snapshots.delete(key);
    this.snapshots.delete(digest); this.snapshots.set(digest, snapshot);
    while (this.snapshots.size > OPERATION_EXPORT_SNAPSHOT_LIMIT) this.snapshots.delete(this.snapshots.keys().next().value!);
  }
  preview(): JsonObject {
    const archive = this.archive();
    this.retain(archive.digest, { parts: [archive.data], ends: [archive.data.length], bytes: archive.data.length, expires: this.now() + OPERATION_EXPORT_TTL_MS });
    const lastRotation = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('lastOperationRotation')?.value;
    return { generation: this.generation(), nextGeneration: this.nextGeneration(), digest: archive.digest,
      bytes: archive.data.length, receipts: archive.receipts, retirements: archive.retirements, blocked: archive.blocked,
      ...(typeof lastRotation === 'string' ? { lastRotation: JSON.parse(lastRotation) as JsonValue } : {}) };
  }

  release(digest: string): void { this.snapshots.delete(digest); }

  chunk(digest: string, offset: number, limit = 512 * 1024): JsonObject {
    if (!/^[a-f0-9]{64}$/.test(digest) || !Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 512 * 1024) throw new HarnessError('invalid', '归档分块参数无效。');
    const archive = this.snapshots.get(digest);
    if (!archive || archive.expires <= this.now()) { this.snapshots.delete(digest); throw new HarnessError('journal_changed', '归档已过期或超出最近两个预览的保留上限，请重新预览并导出。'); }
    if (offset >= archive.bytes) throw new HarnessError('journal_changed', '归档位置无效，请重新预览并导出。');
    const end = Math.min(offset + limit, archive.bytes), slices: Buffer[] = [];
    for (let index = 0; index < archive.parts.length; index++) {
      const edge = archive.ends[index]!, start = index ? archive.ends[index - 1]! : 0;
      if (edge <= offset) continue;
      slices.push(archive.parts[index]!.subarray(Math.max(0, offset - start), end - start));
      if (edge >= end) break;
    }
    return { digest, offset, totalBytes: archive.bytes, base64: Buffer.concat(slices, end - offset).toString('base64'), nextOffset: end === archive.bytes ? null : end };
  }

  /** Caller holds the maintenance lease and wraps this method in a SQLite transaction. */
  rotate(params: { digest: string; nextGeneration: number; exportedDigest: string }): JsonObject {
    const archive = this.archive(), next = this.nextGeneration();
    if (archive.blocked.length) throw new HarnessError('journal_busy', '仍有未完成或结果未知的操作，不能归档清理。');
    if (params.digest !== archive.digest || params.exportedDigest !== archive.digest || params.nextGeneration !== next)
      throw new HarnessError('journal_changed', '必须导出并确认当前完整回执后才能轮换。');
    this.db.prepare('DELETE FROM receipts').run();
    this.db.prepare('DELETE FROM retired_operations').run();
    this.db.prepare('DELETE FROM metadata WHERE key=?').run(EMERGENCY_RECOVERY_KEY);
    this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY, String(next));
    const result = { rotated: true, generation: next, archivedDigest: archive.digest, receipts: archive.receipts, retirements: archive.retirements, rotatedAt: this.now() };
    this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('lastOperationRotation', JSON.stringify(result));
    this.snapshots.clear();
    return result;
  }

  usage(): JsonObject {
    const row = this.db.prepare('SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM receipts').get()!;
    const retired = this.db.prepare('SELECT count(*) AS count FROM retired_operations').get()!;
    const runs = this.db.prepare('SELECT count(*) AS count FROM automation_runs').get()!;
    return { generation: this.generation(), receipts: Number(row.count), receiptBytes: Number(row.bytes),
      receiptCountLimit: LIMITS.receiptCount, receiptByteLimit: LIMITS.receiptStorageBytes,
      retirements: Number(retired.count), automationRuns: Number(runs.count), automationRunLimit: 1000,
      automationCompletedRunsAutomaticallyRecycled: true };
  }
}
