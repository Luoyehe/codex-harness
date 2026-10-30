import { DatabaseSync } from 'node:sqlite';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, chmodSync, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { canonical, DeliveryError, jsonBytes, object, onlyKeys, string, type CallContext, type JsonObject, type JsonValue } from './types.js';
import { receiptResult } from '../gateway/receipt-result.js';
import { WorktreeBindings } from './worktree-bindings.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_ROWS = 2000;
const MAX_RESULT = 16 * 1024;
function sameDirectory(info: Stats, expected: Stats): boolean {
  return info.isDirectory() && !info.isSymbolicLink() && info.dev === expected.dev && info.ino === expected.ino && info.uid === expected.uid && info.mode === expected.mode;
}
function syncDirectory(directory: string, expected: Stats): void {
  const fd = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!sameDirectory(fstatSync(fd), expected)) throw new DeliveryError('witness_storage', 'Workspace witness directory was replaced');
    fsyncSync(fd);
    if (!sameDirectory(lstatSync(directory), expected)) throw new DeliveryError('witness_storage', 'Workspace witness directory was replaced');
  } finally { closeSync(fd); }
}
/** Only the supervisor writes this database. Native-owned recovery journals are never acceptance proofs. */
export class WorkspaceWitness {
  private db: DatabaseSync;
  private worktrees: WorktreeBindings;
  constructor(home: string, nativeHome?: string) {
    const parent = lstatSync(home);
    if (!parent.isDirectory() || parent.isSymbolicLink() || (process.getuid && (parent.uid !== process.getuid() || (parent.mode & 0o022) !== 0))) throw new DeliveryError('witness_storage', 'Unsafe workspace witness parent');
    const directory = path.join(home, 'workspace-witness'); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))) throw new DeliveryError('witness_storage', 'Unsafe workspace witness directory');
    // SQLite FULL synchronizes its own directory, not this directory's entry in
    // the installer-owned home. Repeat both barriers after an interrupted mkdir.
    // Windows is development-only and does not support this directory fsync.
    if (process.platform !== 'win32') try {
      syncDirectory(directory, info); syncDirectory(home, parent);
      if (!sameDirectory(lstatSync(directory), info)) throw new DeliveryError('witness_storage', 'Workspace witness directory was replaced');
    } catch { throw new DeliveryError('witness_storage', 'Workspace witness directory could not be made durable'); }
    const file = path.join(directory, 'witness.sqlite');
    const fd = openSync(file, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600);
    try { const stat = fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) throw new DeliveryError('witness_storage', 'Unsafe workspace witness database'); }
    finally { closeSync(fd); }
    for (const suffix of ['', '-wal', '-shm']) {
      try { const stat = lstatSync(file + suffix); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) throw new DeliveryError('witness_storage', 'Unsafe workspace witness sidecar'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    chmodSync(file, 0o600); this.db = new DatabaseSync(file, { timeout: 5000, allowExtension: false });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA max_page_count=8192;
      CREATE TABLE IF NOT EXISTS witnesses (
        id TEXT PRIMARY KEY, method TEXT NOT NULL, project_id TEXT NOT NULL, root TEXT NOT NULL,
        gateway_digest TEXT NOT NULL, helper_digest TEXT NOT NULL, result TEXT,
        created_at INTEGER NOT NULL
      ) STRICT;`);
    this.worktrees = new WorktreeBindings(this.db, nativeHome);
  }
  worktreeBinding(id: unknown, root: string): JsonObject { return this.worktrees.get(id, root); }
  /** A complete native not_sent response proves this reserved write did not happen. */
  discardNotSent(method: string, request: JsonObject, context: CallContext): void {
    const { operationId: _id, ...body } = request;
    const helperDigest = createHash('sha256').update(canonical(body)).digest('hex');
    this.db.prepare('DELETE FROM witnesses WHERE id=? AND method=? AND project_id=? AND root=? AND gateway_digest=? AND helper_digest=? AND result IS NULL')
      .run(String(context.operationId), method, String(context.projectId), String(request.root), String(context.gatewayRequestDigest), helperDigest);
  }
  reserve(method: string, request: JsonObject, context: CallContext): void {
    const id = string(context.operationId, 'operationId', 36); const projectId = string(context.projectId, 'projectId', 36); const gatewayDigest = string(context.gatewayRequestDigest, 'gatewayRequestDigest', 64);
    if (!UUID.test(id) || !UUID.test(projectId) || !SHA.test(gatewayDigest) || request.operationId !== id || method !== 'workspace/' + String(request.action)) throw new DeliveryError('invalid_params', 'Workspace witness requires matching gateway and helper identities');
    const { operationId: _id, ...body } = request; const helperDigest = createHash('sha256').update(canonical(body)).digest('hex');
    const root = string(request.root, 'registered project root', 4096);
    const prior = this.db.prepare('SELECT * FROM witnesses WHERE id=?').get(id);
    if (prior) {
      if (prior.method !== method || prior.project_id !== projectId || prior.root !== root || prior.gateway_digest !== gatewayDigest || prior.helper_digest !== helperDigest) throw new DeliveryError('operation_conflict', 'Workspace operation identity was already used');
      throw new DeliveryError('operation_unknown', 'Workspace operation was already dispatched; inspect its original witness', 'unknown');
    }
    const usage = this.db.prepare('SELECT count(*) AS count FROM witnesses').get()!;
    if (Number(usage.count) >= MAX_ROWS) throw new DeliveryError('capacity', 'Workspace witness storage is full; no new operation was sent');
    if (method === 'workspace/worktree/create') {
      // Native homes change with execution identity; this durable binding
      // budget is shared. Reserve its slot before writing to either helper.
      const pending = this.db.prepare("SELECT count(*) AS n FROM witnesses WHERE method='workspace/worktree/create' AND result IS NULL").get()!;
      this.worktrees.requireCreateCapacity(Number(pending.n));
    }
    this.db.prepare('INSERT INTO witnesses(id,method,project_id,root,gateway_digest,helper_digest,created_at) VALUES(?,?,?,?,?,?,?)').run(id, method, projectId, root, gatewayDigest, helperDigest, Date.now());
  }
  complete(method: string, request: JsonObject, result: JsonValue, context: CallContext): JsonValue {
    const id = string(context.operationId, 'operationId', 36); const row = object(result); const params = object(request.params);
    if (request.operationId !== id || method !== 'workspace/' + String(request.action)) throw new DeliveryError('invalid_native_response', 'Workspace request identity changed before acknowledgement', 'unknown');
    const worktree = String(request.action).startsWith('worktree/');
    if (worktree) {
      // The complete proof and its private binding commit together below.
    } else if (request.action === 'git/commit') {
      if (row.recoveryOperationId !== id || row.previousHead !== params.expectedHead || row.indexRevision !== params.expectedIndexRevision) throw new DeliveryError('invalid_native_response', 'Git commit acknowledgement identity mismatch', 'unknown');
    } else if (['git/stage', 'git/unstage', 'git/index/recovery/restore'].includes(String(request.action))) {
      if (row.recoveryOperationId !== id || row.head !== params.expectedHead || row.previousIndexRevision !== params.expectedIndexRevision) throw new DeliveryError('invalid_native_response', 'Git index acknowledgement identity mismatch', 'unknown');
      if (request.action === 'git/index/recovery/restore') {
        if (row.restoredFromOperationId !== params.recoveryOperationId) throw new DeliveryError('invalid_native_response', 'Index restore source identity mismatch', 'unknown');
      } else {
        const paths = request.action === 'git/stage' ? (params.files as JsonValue[]).map(value => object(value).path!) : params.paths as JsonValue[];
        if (row.selectedCount !== paths.length || row.pathsDigest !== createHash('sha256').update(canonical(paths)).digest('hex')) throw new DeliveryError('invalid_native_response', 'Git index selection identity mismatch', 'unknown');
      }
    } else if (request.action === 'git/index/recovery/discard') {
      if (row.recoveryOperationId !== params.recoveryOperationId) throw new DeliveryError('invalid_native_response', 'Index discard source identity mismatch', 'unknown');
    } else if (request.action === 'recovery/discard') {
      if (row.recoveryOperationId !== params.recoveryOperationId) throw new DeliveryError('invalid_native_response', 'Recovery discard source identity mismatch', 'unknown');
    } else {
      const expectedPath = request.action === 'copy' ? params.destination : params.path;
      if (row.path !== expectedPath || (request.action !== 'mkdir' && row.recoveryOperationId !== id)) throw new DeliveryError('invalid_native_response', 'Workspace acknowledgement identity mismatch', 'unknown');
      if (request.action === 'recovery/restore' && row.restoredFromOperationId !== params.recoveryOperationId) throw new DeliveryError('invalid_native_response', 'Recovery restore source identity mismatch', 'unknown');
    }
    if (request.action === 'write' && row.bytes !== Buffer.byteLength(String(params.text))) throw new DeliveryError('invalid_native_response', 'Workspace write size mismatch', 'unknown');
    const { operationId: _id, ...body } = request; const helperDigest = createHash('sha256').update(canonical(body)).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
    const acknowledged = this.db.prepare('SELECT id FROM witnesses WHERE id=? AND method=? AND project_id=? AND root=? AND helper_digest=? AND gateway_digest=? AND result IS NULL').get(id, method, String(context.projectId), String(request.root), helperDigest, String(context.gatewayRequestDigest));
    if (!acknowledged) throw new DeliveryError('witness_storage', 'Workspace acknowledgement could not be recorded', 'unknown');
    const generation = worktree ? this.worktrees.complete(String(request.action), request, row, String(context.projectId)) : undefined;
    const projected = receiptResult(method, generation === undefined ? result : { ...row, worktreeVersion: generation }); const text = jsonBytes(projected, MAX_RESULT);
    const changed = this.db.prepare('UPDATE witnesses SET result=? WHERE id=? AND method=? AND project_id=? AND root=? AND helper_digest=? AND gateway_digest=? AND result IS NULL')
      .run(text, id, method, String(context.projectId), String(request.root), helperDigest, String(context.gatewayRequestDigest));
    if (Number(changed.changes) !== 1) throw new DeliveryError('witness_storage', 'Workspace acknowledgement could not be recorded', 'unknown');
    this.db.exec('COMMIT');
    return projected;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  read(params: JsonObject): JsonValue {
    onlyKeys(params, ['operationId']); const id = string(params.operationId, 'operationId', 36);
    if (!UUID.test(id)) throw new DeliveryError('invalid_params', 'Invalid workspace operationId');
    const row = this.db.prepare('SELECT * FROM witnesses WHERE id=?').get(id);
    if (!row) return { operationId: id, state: 'not_received' };
    return { operationId: id, state: typeof row.result === 'string' ? 'completed' : 'unknown', method: String(row.method), projectId: String(row.project_id), root: String(row.root), gatewayRequestDigest: String(row.gateway_digest), helperRequestDigest: String(row.helper_digest), ...(typeof row.result === 'string' ? { result: JSON.parse(row.result) as JsonValue } : {}) };
  }
  usage(): JsonObject {
    const row = this.db.prepare('SELECT count(*) AS total,sum(result IS NULL) AS unresolved FROM witnesses').get()!;
    return { total: Number(row.total), unresolved: Number(row.unresolved ?? 0), limit: MAX_ROWS };
  }
  /** Private gateway reconciliation feed. Payloads and native paths are not needed here. */
  pending(params: JsonObject): JsonObject {
    onlyKeys(params, ['after', 'limit']);
    const after = params.after === undefined ? '' : string(params.after, 'after', 36);
    const limit = params.limit ?? 64;
    if ((after && !UUID.test(after)) || typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 64) throw new DeliveryError('invalid_params', 'Invalid witness page');
    const rows = this.db.prepare('SELECT * FROM witnesses WHERE result IS NOT NULL AND id>? ORDER BY id LIMIT ?').all(after, limit + 1);
    return { data: rows.slice(0, limit).map(row => ({ operationId: String(row.id), method: String(row.method), projectId: String(row.project_id),
      gatewayRequestDigest: String(row.gateway_digest), resultDigest: createHash('sha256').update(canonical(JSON.parse(String(row.result)) as JsonValue)).digest('hex') })),
      nextCursor: rows.length > limit ? String(rows[limit - 1]!.id) : null };
  }
  /** Only the authenticated gateway invokes this after persisting an accepted receipt. */
  async acknowledge(params: JsonObject, cleanup: (root: string, operationId: string, helperDigest: string) => Promise<void>): Promise<JsonObject> {
    onlyKeys(params, ['operationId', 'method', 'projectId', 'gatewayRequestDigest', 'resultDigest']);
    const id = string(params.operationId, 'operationId', 36), project = string(params.projectId, 'projectId', 36);
    const method = string(params.method, 'method', 128), gatewayDigest = string(params.gatewayRequestDigest, 'gatewayRequestDigest', 64), resultDigest = string(params.resultDigest, 'resultDigest', 64);
    if (!UUID.test(id) || !UUID.test(project) || !SHA.test(gatewayDigest) || !SHA.test(resultDigest)) throw new DeliveryError('invalid_params', 'Invalid witness acknowledgement');
    const row = this.db.prepare('SELECT * FROM witnesses WHERE id=?').get(id);
    if (!row) return { acknowledged: true, operationId: id, removed: false };
    if (typeof row.result !== 'string' || row.method !== method || row.project_id !== project || row.gateway_digest !== gatewayDigest ||
        createHash('sha256').update(canonical(JSON.parse(row.result) as JsonValue)).digest('hex') !== resultDigest) throw new DeliveryError('operation_conflict', 'Accepted gateway receipt does not match the completed witness');
    // Keep the proof if native cleanup fails, including after a lost acknowledgement.
    // A retry can safely finish both steps; the gateway journal prevents redispatch.
    await cleanup(String(row.root), id, String(row.helper_digest));
    const removed = this.db.prepare('DELETE FROM witnesses WHERE id=? AND method=? AND project_id=? AND gateway_digest=? AND result=?')
      .run(id, method, project, gatewayDigest, row.result);
    return { acknowledged: true, operationId: id, removed: Number(removed.changes) === 1 };
  }
  close(): void { this.db.close(); }
}
