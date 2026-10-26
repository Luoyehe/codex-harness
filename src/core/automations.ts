import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { JsonObject, JsonValue } from './contracts.js';
import { HarnessError } from './errors.js';
import { canonical, identifier, object, uuid, validText } from './validation.js';
import { nextScheduled, schedule, schedulePreview, type Schedule } from './schedule.js';

export const automationReads = new Set(['automation/list', 'automation/read', 'automation/runs', 'automation/preview']);
export const automationWrites = new Set(['automation/create', 'automation/update', 'automation/pause', 'automation/resume', 'automation/remove', 'automation/run', 'automation/stop', 'automation/acknowledge']);
export interface AutomationSpec { name: string; projectId: string; text: string; options: JsonObject; schedule: Schedule; maxRunMinutes: number }
export interface Automation extends AutomationSpec { id: string; revision: number; state: 'active' | 'paused' | 'removed'; nextAt: number | null; createdAt: number; updatedAt: number }
export type RunState = 'queued' | 'dispatching' | 'running' | 'needs_attention' | 'stopping' | 'completed' | 'failed' | 'interrupted' | 'unknown' | 'closed_unknown' | 'not_sent' | 'skipped' | 'canceled';
export interface AutomationRun { id: string; automationId: string; revision: number; scheduledAt: number; manual: boolean; operationId: string; clientId: string; state: RunState; threadId: string | null; turnId: string | null; startedAt: number | null; finishedAt: number | null; stopRequested: boolean; stopSent: boolean; code: string | null; spec: AutomationSpec }
type Row = Record<string, unknown>;
const active = ['queued', 'dispatching', 'running', 'needs_attention', 'stopping', 'unknown'];
const pending = ['dispatching', 'running', 'needs_attention', 'stopping'];
function keys(value: JsonObject, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) throw new HarnessError('invalid', '自动化参数包含不支持的字段。'); }
function positive(value: unknown, min: number, max: number): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new HarnessError('invalid', '自动化数值超出范围。'); return value; }
export function automationSpec(value: JsonValue): AutomationSpec {
  object(value); keys(value, ['name', 'projectId', 'text', 'options', 'schedule', 'maxRunMinutes']);
  const name = validText(value.name, 128).trim(), text = validText(value.text, 16_384).trim();
  if (!name || !text || Buffer.byteLength(text) > 16_384) throw new HarnessError('invalid', '名称和指令不能为空，指令最多 16 KiB。');
  const options = value.options ?? {}; object(options); canonical(options, 8192);
  return { name, text, projectId: uuid(value.projectId), options, schedule: schedule(value.schedule!), maxRunMinutes: positive(value.maxRunMinutes ?? 30, 1, 120) };
}
function job(row: Row): Automation { return { ...JSON.parse(String(row.spec)) as AutomationSpec, id: String(row.id), revision: Number(row.revision), state: row.state as Automation['state'], nextAt: row.next_at === null ? null : Number(row.next_at), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }; }
function run(row: Row): AutomationRun { return { id: String(row.id), automationId: String(row.automation_id), revision: Number(row.revision), scheduledAt: Number(row.scheduled_at), manual: row.manual === 1, operationId: String(row.operation_id), clientId: String(row.client_id), state: row.state as RunState, threadId: row.thread_id === null ? null : String(row.thread_id), turnId: row.turn_id === null ? null : String(row.turn_id), startedAt: row.started_at === null ? null : Number(row.started_at), finishedAt: row.finished_at === null ? null : Number(row.finished_at), stopRequested: row.stop_requested === 1, stopSent: row.stop_sent === 1, code: row.code === null ? null : String(row.code), spec: JSON.parse(String(row.spec)) as AutomationSpec }; }
function publicRun(value: AutomationRun): JsonObject { const { spec: _spec, clientId: _client, ...result } = value; return result; }
/** Shares the gateway journal connection. Every mutation is called inside Ledger.transaction. */
export class Automations {
  constructor(private db: DatabaseSync, private now: () => number, private createOperationId: () => string = randomUUID) {
    db.exec(`CREATE TABLE IF NOT EXISTS automations(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,state TEXT NOT NULL,spec TEXT NOT NULL,next_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS automation_runs(id TEXT PRIMARY KEY,automation_id TEXT NOT NULL,revision INTEGER NOT NULL,scheduled_at INTEGER NOT NULL,manual INTEGER NOT NULL,operation_id TEXT NOT NULL UNIQUE,client_id TEXT NOT NULL,state TEXT NOT NULL,thread_id TEXT,turn_id TEXT,started_at INTEGER,finished_at INTEGER,stop_requested INTEGER NOT NULL DEFAULT 0,stop_sent INTEGER NOT NULL DEFAULT 0,code TEXT,spec TEXT NOT NULL) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS automation_occurrence ON automation_runs(automation_id,revision,scheduled_at) WHERE manual=0;
      CREATE INDEX IF NOT EXISTS automation_run_order ON automation_runs(automation_id,scheduled_at DESC);`);
  }
  get(id: string): Automation { const row = this.db.prepare('SELECT * FROM automations WHERE id=?').get(uuid(id)); if (!row || row.state === 'removed') throw new HarnessError('automation_missing', '计划已移除。'); return job(row); }
  getRun(id: string): AutomationRun { const row = this.db.prepare('SELECT * FROM automation_runs WHERE id=?').get(uuid(id)); if (!row) throw new HarnessError('automation_run_missing', '运行记录不存在。'); return run(row); }
  read(method: string, params: JsonObject): JsonValue {
    if (method === 'automation/list') { keys(params, []); return { data: this.db.prepare("SELECT * FROM automations WHERE state!='removed' ORDER BY created_at,id").all().map(row => job(row)) as unknown as JsonValue }; }
    if (method === 'automation/preview') { keys(params, ['schedule']); return { next: schedulePreview(schedule(params.schedule!), this.now()), missedPolicy: 'skip_after_5_minutes', dstPolicy: 'skip_nonexistent_first_repeated' }; }
    if (method === 'automation/read') { keys(params, ['id']); return this.get(uuid(params.id)) as unknown as JsonValue; }
    keys(params, ['id', 'before', 'limit']); const id = uuid(params.id); this.get(id); const limit = positive(params.limit ?? 50, 1, 100);
    const before = params.before == null ? Number.MAX_SAFE_INTEGER : positive(params.before, 0, Number.MAX_SAFE_INTEGER);
    const rows = this.db.prepare('SELECT rowid AS cursor,* FROM automation_runs WHERE automation_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?').all(id, before, limit + 1);
    return { data: rows.slice(0, limit).map(row => publicRun(run(row))), next: rows.length > limit ? Number(rows[limit - 1]!.cursor) : null };
  }
  command(method: string, params: JsonObject): JsonValue {
    const now = this.now();
    if (method === 'automation/acknowledge') {
      keys(params, ['runId', 'confirm']); const current = this.getRun(uuid(params.runId));
      if (params.confirm !== true || current.state !== 'unknown') throw new HarnessError('invalid', '仅可明确关闭结果未知的记录。');
      this.finish(current.id, 'closed_unknown', 'closed_by_user_without_success_claim'); return { runId: current.id, state: 'closed_unknown' };
    }
    if (method === 'automation/create') {
      keys(params, ['spec', 'enabled']); if (params.enabled !== undefined && typeof params.enabled !== 'boolean') throw new HarnessError('invalid', '启用状态必须是布尔值。');
      const spec = automationSpec(params.spec!), nextAt = nextScheduled(spec.schedule, now);
      if (nextAt === null) throw new HarnessError('invalid', '计划时间必须在未来。');
      if (Number(this.db.prepare("SELECT count(*) AS count FROM automations WHERE state!='removed'").get()!.count) >= 64) throw new HarnessError('capacity', '最多保留 64 个自动化计划。');
      const id = randomUUID(); this.db.prepare('INSERT INTO automations VALUES(?,1,?,?,?,?,?)').run(id, params.enabled === false ? 'paused' : 'active', JSON.stringify(spec), nextAt, now, now); return { id, revision: 1 };
    }
    if (method === 'automation/stop') {
      keys(params, ['runId']); const current = this.getRun(uuid(params.runId));
      if (current.state === 'unknown') throw new HarnessError('operation_unknown', '此运行结果未知，请核对会话后恢复服务，不会重新发送停止请求。');
      if (current.state === 'queued') this.finish(current.id, 'canceled', 'user_canceled');
      else if (pending.includes(current.state)) this.db.prepare('UPDATE automation_runs SET stop_requested=1 WHERE id=?').run(current.id);
      return { runId: current.id, state: this.getRun(current.id).state, stopRequested: pending.includes(current.state) };
    }
    keys(params, method === 'automation/update' ? ['id', 'expectedRevision', 'spec'] : ['id', 'expectedRevision']);
    const current = this.get(uuid(params.id));
    if (positive(params.expectedRevision, 1, Number.MAX_SAFE_INTEGER) !== current.revision) throw new HarnessError('automation_conflict', '计划已修改，请读取最新版本。');
    if (method === 'automation/run') { const created = this.enqueue(current, now, true); return { id: current.id, runId: created.id, operationId: created.operationId, state: created.state }; }
    if (method === 'automation/remove' && this.forJob(current.id).some(item => active.includes(item.state))) throw new HarnessError('automation_busy', '请先结束或核对仍在运行的任务，再移除计划。');
    const spec = method === 'automation/update' ? automationSpec(params.spec!) : this.spec(current);
    let state = current.state;
    if (method === 'automation/remove') state = 'removed';
    if (method === 'automation/pause') state = 'paused';
    if (method === 'automation/resume') state = 'active';
    const nextAt = method === 'automation/pause' || method === 'automation/remove' ? current.nextAt : nextScheduled(spec.schedule, now);
    if (state === 'active' && nextAt === null) throw new HarnessError('invalid', '该一次性计划已经过期，请修改时间或手动运行。');
    this.db.prepare('UPDATE automations SET revision=revision+1,state=?,spec=?,next_at=?,updated_at=? WHERE id=?').run(state, state === 'removed' ? JSON.stringify({ ...spec, text: '', options: {} }) : JSON.stringify(spec), nextAt, now, current.id);
    return { id: current.id, revision: current.revision + 1, state };
  }
  private spec(value: Automation): AutomationSpec { const { name, projectId, text, options, schedule, maxRunMinutes } = value; return { name, projectId, text, options, schedule, maxRunMinutes }; }
  private forJob(id: string): AutomationRun[] { return this.db.prepare('SELECT * FROM automation_runs WHERE automation_id=?').all(id).map(run); }
  private enqueue(value: Automation, at: number, manual: boolean, skipped?: string): AutomationRun {
    if (!skipped && this.forJob(value.id).some(item => active.includes(item.state))) throw new HarnessError('automation_busy', '该计划仍有未完成或结果未知的运行。');
    // Retain 1,000 bounded execution records. Durable dispatch IDs remain in the main ledger independently.
    const count = Number(this.db.prepare('SELECT count(*) AS count FROM automation_runs').get()!.count);
    if (count >= 1000) this.db.prepare("DELETE FROM automation_runs WHERE id IN (SELECT id FROM automation_runs WHERE state IN ('completed','failed','interrupted','closed_unknown','not_sent','skipped','canceled') ORDER BY rowid LIMIT ?)").run(count - 999);
    if (Number(this.db.prepare('SELECT count(*) AS count FROM automation_runs').get()!.count) >= 1000) throw new HarnessError('capacity', '自动化运行记录已满，请核对未完成的运行。');
    const id = randomUUID(), operationId = this.createOperationId(), clientId = randomUUID();
    this.db.prepare('INSERT INTO automation_runs(id,automation_id,revision,scheduled_at,manual,operation_id,client_id,state,finished_at,code,spec) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, value.id, value.revision, at, Number(manual), operationId, clientId, skipped ? 'skipped' : 'queued', skipped ? this.now() : null, skipped ?? null, JSON.stringify(this.spec(value)));
    return this.getRun(id);
  }
  collectDue(): void {
    const now = this.now();
    for (const row of this.db.prepare("SELECT * FROM automations WHERE state='active' AND next_at<=? ORDER BY next_at,id").all(now)) {
      const value = job(row), busy = this.forJob(value.id).some(item => active.includes(item.state));
      this.enqueue(value, value.nextAt!, false, now - value.nextAt! > 300_000 ? 'missed_window' : busy ? 'previous_run_unresolved' : undefined);
      const next = nextScheduled(value.schedule, now);
      this.db.prepare('UPDATE automations SET next_at=?,state=?,updated_at=? WHERE id=?').run(next, next === null ? 'paused' : 'active', now, value.id);
    }
  }
  outstanding(): AutomationRun[] { return this.db.prepare("SELECT * FROM automation_runs WHERE state IN ('queued','dispatching','running','needs_attention','stopping','unknown') ORDER BY rowid").all().map(run); }
  claim(id: string): AutomationRun | null { const change = this.db.prepare("UPDATE automation_runs SET state='dispatching',started_at=? WHERE id=? AND state='queued'").run(this.now(), id); return Number(change.changes) ? this.getRun(id) : null; }
  accepted(id: string, threadId: string, turnId: string, status: string): void {
    identifier(threadId); identifier(turnId);
    this.db.prepare("UPDATE automation_runs SET state='running',thread_id=?,turn_id=?,finished_at=NULL,code=NULL WHERE id=? AND state IN ('dispatching','unknown')").run(threadId, turnId, id);
    if (['completed', 'failed', 'interrupted'].includes(status)) this.finish(id, status as RunState);
  }
  partial(id: string, threadId: string): void { identifier(threadId); this.db.prepare('UPDATE automation_runs SET thread_id=? WHERE id=?').run(threadId, id); }
  finish(id: string, state: RunState, code: string | null = null): void {
    if (!['completed', 'failed', 'interrupted', 'unknown', 'closed_unknown', 'not_sent', 'canceled'].includes(state)) throw new Error('Invalid final automation state');
    this.db.prepare("UPDATE automation_runs SET state=?,code=?,finished_at=? WHERE id=? AND state IN ('queued','dispatching','running','needs_attention','stopping','unknown')").run(state, code, this.now(), id);
  }
  attention(threadId: string): void { this.db.prepare("UPDATE automation_runs SET state='needs_attention' WHERE thread_id=? AND state='running'").run(threadId); }
  requestStop(id: string): void { this.db.prepare("UPDATE automation_runs SET stop_requested=1 WHERE id=? AND state IN ('running','needs_attention')").run(id); }
  claimStop(id: string): boolean { return !!Number(this.db.prepare("UPDATE automation_runs SET stop_sent=1,state='stopping' WHERE id=? AND state IN ('running','needs_attention') AND stop_requested=1 AND stop_sent=0").run(id).changes); }
  recover(): void { this.db.prepare("UPDATE automation_runs SET state='unknown',code='gateway_restarted',finished_at=? WHERE state IN ('dispatching','running','needs_attention','stopping')").run(this.now()); }
}
