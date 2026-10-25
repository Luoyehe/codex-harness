import type { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import type { JsonObject, JsonValue } from './contracts.js';
import { HarnessError } from './errors.js';
import { object, uuid, validText } from './validation.js';

/** Gateway project registration is derived from positive supervisor receipts, never native journals. */
export class Worktrees {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number) {
    db.exec(`CREATE TABLE IF NOT EXISTS worktree_projects(
      id TEXT PRIMARY KEY, origin_id TEXT NOT NULL, active_path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, phase TEXT NOT NULL, head TEXT NOT NULL, revision TEXT NOT NULL,
      generation INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;`);
  }
  list(originId: string): JsonValue {
    return { data: this.db.prepare('SELECT w.*,p.id AS registered_id FROM worktree_projects w LEFT JOIN projects p ON p.id=w.id WHERE w.origin_id=? ORDER BY w.updated_at DESC,w.id').all(originId).map(row => ({
      worktreeId: String(row.id), projectId: row.registered_id === null ? null : String(row.id), originProjectId: String(row.origin_id), name: String(row.name), path: String(row.active_path), lastConfirmedPhase: String(row.phase), head: String(row.head), revision: String(row.revision), worktreeVersion: Number(row.generation), updatedAt: Number(row.updated_at),
    })) };
  }
  require(originId: string, id: unknown): void {
    if (!this.db.prepare('SELECT id FROM worktree_projects WHERE id=? AND origin_id=?').get(uuid(id), originId)) throw new HarnessError('worktree_missing', '此项目没有对应的受管工作树。');
  }
  protectRemoval(id: string): void {
    if (this.db.prepare('SELECT id FROM worktree_projects WHERE origin_id=? OR id=? LIMIT 1').get(id, id)) throw new HarnessError('worktree_registered', '此项目关联受管工作树；请从工作树面板归档，保留原始项目供恢复使用。');
  }
  apply(method: string, originId: string, operationId: string, input: JsonValue): void {
    object(input); const id = uuid(input.worktreeId); const creating = method === 'workspace/worktree/create';
    if (creating && id !== operationId) throw new HarnessError('worktree_identity', '工作树创建编号与原操作不一致。', 'unknown');
    const origin = this.db.prepare('SELECT name FROM projects WHERE id=?').get(originId);
    if (!origin) throw new HarnessError('project_missing', '工作树来源项目已移除，暂不能自动登记。', 'unknown');
    const prior = this.db.prepare('SELECT * FROM worktree_projects WHERE id=?').get(id);
    if (prior && prior.origin_id !== originId) throw new HarnessError('worktree_identity', '工作树来源不一致。', 'unknown');
    if (!prior && !creating) throw new HarnessError('worktree_missing', '工作树创建回执尚未登记。', 'unknown');
    const generation = input.worktreeVersion;
    if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) throw new HarnessError('worktree_identity', '工作树状态缺少可信版本。', 'unknown');
    // A delayed positive proof can resolve its own receipt without rolling back later state.
    if (prior && Number(prior.generation) >= generation) return;
    const activePath = prior ? String(prior.active_path) : validText(input.path, 4096);
    if (!activePath.startsWith('/') || path.posix.normalize(activePath) !== activePath || path.posix.basename(activePath) !== id || path.posix.basename(path.posix.dirname(activePath)) !== 'worktrees') throw new HarnessError('worktree_identity', '受管工作树目录无效。', 'unknown');
    const phase = input.phase; const expected = phase === 'active' ? activePath : path.posix.join(path.posix.dirname(path.posix.dirname(activePath)), 'worktree-state', id, 'checkout');
    if (!['active', 'archived'].includes(String(phase)) || input.path !== expected) throw new HarnessError('worktree_identity', '工作树位置与状态不一致。', 'unknown');
    const name = prior ? String(prior.name) : String(origin.name).slice(0, 100) + ' · ' + id.slice(0, 8);
    if (phase === 'active') {
      const collision = this.db.prepare('SELECT id,path FROM projects WHERE id=? OR path=?').all(id, activePath);
      if (collision.some(row => row.id !== id || row.path !== activePath)) throw new HarnessError('project_conflict', '工作树目录已由另一个项目登记。', 'unknown');
      if (!collision.length && Number(this.db.prepare('SELECT count(*) AS n FROM projects').get()!.n) >= 128) throw new HarnessError('capacity', '项目数量已达上限；工作树创建结果仍保留，释放空间后核对原回执。', 'unknown');
      this.db.prepare('INSERT INTO projects(id,path,name) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING').run(id, activePath, name);
    } else this.db.prepare('DELETE FROM projects WHERE id=? AND path=?').run(id, activePath);
    this.db.prepare(`INSERT INTO worktree_projects(id,origin_id,active_path,name,phase,head,revision,generation,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET phase=excluded.phase,head=excluded.head,revision=excluded.revision,generation=excluded.generation,updated_at=excluded.updated_at`)
      .run(id, originId, activePath, name, String(phase), validText(input.head, 64), validText(input.revision, 64), generation, this.now());
  }
}
