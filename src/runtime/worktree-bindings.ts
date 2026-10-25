import type { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { canonical, DeliveryError, object, onlyKeys, string, type JsonObject, type JsonValue } from './types.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function absolute(value: unknown): string {
  const name = string(value, 'managed worktree path', 4096);
  if (!name.startsWith('/') || path.posix.normalize(name) !== name || /[\u0000-\u001f\u007f]/.test(name)) throw new DeliveryError('worktree_unbound', 'Invalid managed worktree path', 'unknown');
  return name;
}
/** Supervisor-private inode bindings are established only with a live creation acknowledgement. */
export class WorktreeBindings {
  constructor(private readonly db: DatabaseSync, private readonly nativeHome?: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS managed_worktrees(id TEXT PRIMARY KEY, root TEXT NOT NULL, project_id TEXT NOT NULL, binding TEXT NOT NULL, generation INTEGER NOT NULL) STRICT;`);
  }
  get(id: unknown, root: string): JsonObject {
    const key = string(id, 'worktreeId', 36); if (!UUID.test(key)) throw new DeliveryError('invalid_params', 'Invalid worktree id');
    const row = this.db.prepare('SELECT binding FROM managed_worktrees WHERE id=? AND root=?').get(key, root);
    if (!row) throw new DeliveryError('worktree_unbound', 'This worktree has no supervisor-owned creation proof');
    return object(JSON.parse(String(row.binding)) as JsonValue);
  }
  complete(action: string, request: JsonObject, result: JsonObject, projectId: string): number {
    const params = object(request.params), root = absolute(request.root), creating = action === 'worktree/create';
    const id = string(creating ? request.operationId : params.worktreeId, 'worktreeId', 36);
    if (!this.nativeHome || !UUID.test(id) || result.worktreeId !== id) throw new DeliveryError('worktree_unbound', 'Worktree identity or native home is not configured', 'unknown');
    const home = absolute(this.nativeHome); const binding = object(result.binding);
    onlyKeys(binding, ['version', 'worktreeId', 'originRoot', 'commonDir', 'commonDevice', 'commonInode', 'gitDir', 'gitDirDevice', 'gitDirInode', 'worktreeDevice', 'worktreeInode']);
    if (binding.version !== 1 || binding.worktreeId !== id || binding.originRoot !== root) throw new DeliveryError('worktree_unbound', 'Worktree binding identity mismatch', 'unknown');
    for (const key of ['commonDir', 'gitDir']) absolute(binding[key]);
    for (const key of ['commonDevice', 'commonInode', 'gitDirDevice', 'gitDirInode', 'worktreeDevice', 'worktreeInode']) if (typeof binding[key] !== 'number' || !Number.isSafeInteger(binding[key]) || binding[key] < 0) throw new DeliveryError('worktree_unbound', 'Invalid worktree inode binding', 'unknown');
    const archived = action === 'worktree/archive', phase = archived ? 'archived' : 'active';
    const expected = archived ? path.posix.join(home, 'worktree-state', id, 'checkout') : path.posix.join(home, 'worktrees', id);
    if (result.phase !== phase || result.path !== expected || result[creating ? 'created' : action.slice(9) === 'attach' ? 'attached' : archived ? 'archived' : 'restored'] !== true) throw new DeliveryError('worktree_unbound', 'Worktree phase or fixed location mismatch', 'unknown');
    if (creating) {
      if (Number(this.db.prepare('SELECT count(*) AS n FROM managed_worktrees').get()!.n) >= 32) throw new DeliveryError('capacity', 'Managed worktree retention budget reached', 'unknown');
      this.db.prepare('INSERT INTO managed_worktrees(id,root,project_id,binding,generation) VALUES(?,?,?,?,1)').run(id, root, projectId, canonical(binding));
      return 1;
    } else {
      const prior = this.db.prepare('SELECT * FROM managed_worktrees WHERE id=? AND root=? AND project_id=?').get(id, root, projectId);
      if (!prior || canonical(binding) !== prior.binding || canonical(object(request.binding)) !== prior.binding) throw new DeliveryError('worktree_unbound', 'Worktree acknowledgement differs from the recorded binding', 'unknown');
      this.db.prepare('UPDATE managed_worktrees SET generation=generation+1 WHERE id=?').run(id); return Number(prior.generation) + 1;
    }
  }
}
