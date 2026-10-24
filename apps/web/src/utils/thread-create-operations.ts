export interface ThreadCreateOperation {
  clientOperationId: string;
  cwd: string;
  state: "unknown" | "accepted" | "not_received" | "rejected" | "acknowledged_unknown";
  threadId?: string;
  error?: string;
  /** Recovery source, not a second status authority. Retained across async reads. */
  legacy?: boolean;
}

export const LEGACY_THREAD_CREATE_KEY = "codex-harness-thread-create-operation-v1";
export const THREAD_CREATE_PREFIX = "codex-harness-thread-create-operation-v2:";
// Migration never writes the current receipt key: another tab may already have
// settled that ID between our legacy read and our write. Current receipts and
// completion markers always override these recovery-only snapshots.
export const THREAD_CREATE_LEGACY_PREFIX = "codex-harness-thread-create-legacy-v2:";
export const THREAD_CREATE_RESOLVED_PREFIX = "codex-harness-thread-create-resolved-v2:";
const MAX_KEYS = 4_096;
const MAX_RECORDS = 100;
const MAX_RECORD_CHARS = 8_192;
const idPattern = /^[a-z0-9-]{36}$/i;
type StoredOperation = ThreadCreateOperation | { clientOperationId: string; state: "resolved"; cwd: string };

function parse(raw: string, expectedId?: string): StoredOperation {
  if (raw.length > MAX_RECORD_CHARS) throw new Error("会话创建记录超过读取预算");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("会话创建记录格式无效");
  const entry = value as Record<string, unknown>;
  if (typeof entry.clientOperationId !== "string" || !idPattern.test(entry.clientOperationId) ||
      expectedId !== undefined && expectedId !== entry.clientOperationId ||
      typeof entry.cwd !== "string" || entry.cwd.length > 4_096 || entry.cwd.includes("\0") ||
      !["unknown", "accepted", "acknowledged_unknown", "rejected", "not_received", "resolved"].includes(String(entry.state)) ||
      entry.state === "accepted" && (typeof entry.threadId !== "string" || !entry.threadId || entry.threadId.length > 256)) {
    throw new Error("会话创建记录格式无效");
  }
  // Absence is only an observation at query time; an original request on a
  // different connection can still arrive later. Old snapshots stay unknown.
  return { clientOperationId: entry.clientOperationId, cwd: entry.cwd, state: (entry.state === "not_received" ? "unknown" : entry.state) as StoredOperation["state"],
    ...(entry.state === "accepted" ? { threadId: entry.threadId as string } : {}) } as StoredOperation;
}

export function isThreadCreateStorageKey(key: string | null): boolean {
  return key === null || key === LEGACY_THREAD_CREATE_KEY || key.startsWith(THREAD_CREATE_PREFIX) || key.startsWith(THREAD_CREATE_LEGACY_PREFIX) || key.startsWith(THREAD_CREATE_RESOLVED_PREFIX);
}

export function threadCreateStorageEvidence(key: string | null, raw: string | null): ThreadCreateOperation | null {
  if (!key?.startsWith(THREAD_CREATE_PREFIX) || raw === null) return null;
  try {
    const operation = parse(raw, key.slice(THREAD_CREATE_PREFIX.length));
    return operation.state === "resolved" || operation.state === "unknown" ? null : operation;
  } catch { return null; }
}

export function readThreadCreateOperations(): {
  records: Record<string, ThreadCreateOperation>; resolvedIds: string[]; overflow: boolean; error: string | null;
} {
  const candidates = new Map<string, StoredOperation>();
  const current = new Map<string, StoredOperation>();
  const completed = new Map<string, StoredOperation>();
  const legacyIds = new Set<string>();
  let overflow = false;
  let error: string | null = null;
  const failed = () => { error = "本地会话创建记录未能完整读取或迁移；已暂停新建。请恢复本站存储后重试读取，原记录未删除。"; };
  try {
    const raw = localStorage.getItem(LEGACY_THREAD_CREATE_KEY);
    if (raw !== null) {
      try {
        const legacy = parse(raw);
        if (legacy.state === "resolved") throw new Error("无效的旧创建记录");
        candidates.set(legacy.clientOperationId, legacy);
        legacyIds.add(legacy.clientOperationId);
        const key = THREAD_CREATE_LEGACY_PREFIX + legacy.clientOperationId;
        // Leave the old key intact: compare-then-remove cannot safely delete a
        // shared legacy slot while an older tab can still replace it.
        if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(legacy));
      } catch { failed(); }
    }
    const length = localStorage.length;
    overflow = length > MAX_KEYS;
    for (let index = 0; index < Math.min(length, MAX_KEYS); index++) {
      const key = localStorage.key(index);
      if (!key) continue;
      const prefix = key.startsWith(THREAD_CREATE_PREFIX) ? THREAD_CREATE_PREFIX
        : key.startsWith(THREAD_CREATE_LEGACY_PREFIX) ? THREAD_CREATE_LEGACY_PREFIX
        : key.startsWith(THREAD_CREATE_RESOLVED_PREFIX) ? THREAD_CREATE_RESOLVED_PREFIX : null;
      if (!prefix) continue;
      try {
        const value = localStorage.getItem(key);
        if (value === null) continue;
        const operation = parse(value, key.slice(prefix.length));
        if (prefix === THREAD_CREATE_LEGACY_PREFIX) legacyIds.add(operation.clientOperationId);
        if (prefix === THREAD_CREATE_RESOLVED_PREFIX && operation.state !== "resolved") throw new Error("无效的创建完成标记");
        (prefix === THREAD_CREATE_RESOLVED_PREFIX ? completed : prefix === THREAD_CREATE_PREFIX ? current : candidates).set(operation.clientOperationId, operation);
      } catch { failed(); }
    }
  } catch { failed(); }
  // A completion marker can fall beyond the enumeration budget. Resolve each
  // legacy identity directly before exposing its recovery snapshot again.
  for (const id of legacyIds) {
    try {
      const raw = localStorage.getItem(THREAD_CREATE_PREFIX + id);
      if (raw !== null) current.set(id, parse(raw, id));
      const done = localStorage.getItem(THREAD_CREATE_RESOLVED_PREFIX + id);
      if (done !== null) {
        const operation = parse(done, id);
        if (operation.state !== "resolved") throw new Error("无效的创建完成标记");
        completed.set(id, operation);
      }
    } catch { failed(); }
  }
  for (const [id, operation] of current) candidates.set(id, operation);
  for (const [id, operation] of completed) candidates.set(id, operation);
  const records: Record<string, ThreadCreateOperation> = {};
  let retained = 0;
  const resolvedIds: string[] = [];
  for (const [id, operation] of candidates) {
    if (operation.state === "resolved") { resolvedIds.push(id); continue; }
    if (++retained > MAX_RECORDS) { overflow = true; continue; }
    records[id] = { ...operation, ...(legacyIds.has(id) ? { legacy: true } : {}) };
  }
  return { records, resolvedIds, overflow, error };
}

/** Writes only this operation. Prompts, credentials and attachments never enter storage. */
export function saveThreadCreateOperation(operation: ThreadCreateOperation): void {
  localStorage.setItem(THREAD_CREATE_PREFIX + operation.clientOperationId, JSON.stringify({
    clientOperationId: operation.clientOperationId, cwd: operation.cwd, state: operation.state,
    ...(operation.state === "accepted" ? { threadId: operation.threadId } : {}),
  }));
}

/** Only legacy identities need a tombstone; ordinary completed creations leave
 * no permanent keys. Capture first so clearing cannot race a legacy migration. */
export function finishThreadCreateOperation(operation: ThreadCreateOperation): void {
  const id = operation.clientOperationId;
  const legacyRaw = localStorage.getItem(LEGACY_THREAD_CREATE_KEY);
  let legacy = operation.legacy === true;
  if (legacyRaw !== null) {
    const source = parse(legacyRaw);
    if (source.clientOperationId === id) {
      legacy = true;
      const snapshotKey = THREAD_CREATE_LEGACY_PREFIX + id;
      if (localStorage.getItem(snapshotKey) === null) localStorage.setItem(snapshotKey, JSON.stringify(source));
    }
  }
  legacy ||= localStorage.getItem(THREAD_CREATE_LEGACY_PREFIX + id) !== null;
  // Separate immutable completion keys cannot be overwritten by a receipt
  // lookup that started before another tab acknowledged the legacy record.
  if (legacy) localStorage.setItem(THREAD_CREATE_RESOLVED_PREFIX + id, JSON.stringify({ clientOperationId: id, cwd: operation.cwd, state: "resolved" }));
  localStorage.removeItem(THREAD_CREATE_PREFIX + id);
}
