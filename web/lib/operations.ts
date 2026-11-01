import { operationId } from './ids';
import { INPUT_METHODS } from './workflows';
import { clearDraftSnapshot } from './drafts';
import { operationTransaction, stored } from './operation-store';
export type OperationState = 'pending' | 'unknown' | 'accepted' | 'not_sent';
export type TerminalResult = { terminalId: string };
export type TerminalOwner = { clientId: string; connectionId: string };
export type RecoveryOperation = Readonly<{ id: string; method: string }>;
export type Operation = {
  id: string; method: string; threadId?: string; projectId?: string; resourceId?: string;
  draftKey?: string; draftRevision?: string; createdAt: number; state: OperationState;
  resolvedThreadId?: string; terminalOwner?: TerminalOwner; terminalResult?: TerminalResult;
  /** Captured atomically before a force recovery, without message bodies or credentials. */
  recoveryOperations?: RecoveryOperation[];
  /** The destination thread has been loaded after this receipt was observed. */
  consumed?: true;
  /** Legacy JavaScript cannot join our transactions; retain its draft conservatively. */
  legacy?: true;
};
export type OperationHistoryEntry = Pick<Operation,
  'id' | 'method' | 'threadId' | 'projectId' | 'resolvedThreadId' | 'createdAt' | 'state'> & {
  closed: 'completed' | 'dismissed' | 'recovery_stopped' | 'legacy_closed' | 'collected';
};
const historyKey = 'history-v1';
let historyWarning = '';
function warnDamagedHistory() {
  historyWarning = '部分本地操作历史损坏，已忽略无法读取的历史；活动恢复记录不受影响。';
}
export const operationHistoryLimit = 500;
export const newestOperationFirst = (a: Pick<Operation, 'createdAt' | 'id'>, b: Pick<Operation, 'createdAt' | 'id'>) =>
  b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
function historyEntry(record: Operation, closed: OperationHistoryEntry['closed']): OperationHistoryEntry {
  // Deliberately omit draft identities, terminal leases/results, recovery lists,
  // resource paths and all request/result/error bodies from display-only history.
  return { id: record.id, method: record.method, createdAt: record.createdAt, state: record.state, closed,
    ...(record.threadId ? { threadId: record.threadId } : {}),
    ...(record.projectId ? { projectId: record.projectId } : {}),
    ...(record.resolvedThreadId ? { resolvedThreadId: record.resolvedThreadId } : {}) };
}
async function readHistory(metadata: IDBObjectStore): Promise<OperationHistoryEntry[]> {
  const value: unknown = await stored(metadata.get(historyKey));
  if (value === undefined) return [];
  const rows: OperationHistoryEntry[] = [], ids = new Set<string>();
  let damaged = !Array.isArray(value) || value.length > operationHistoryLimit;
  for (const row of Array.isArray(value) ? value.slice(0, operationHistoryLimit) : []) {
    try {
      const record = checkedOperation(row);
      if (ids.has(record.id) || !['completed', 'dismissed', 'recovery_stopped', 'legacy_closed', 'collected'].includes(row.closed))
        throw new Error('Invalid display history');
      rows.push(historyEntry(record, row.closed)); ids.add(record.id);
    } catch { damaged = true; }
  }
  if (damaged) warnDamagedHistory();
  return rows;
}
async function archiveOperations(metadata: IDBObjectStore, additions: OperationHistoryEntry[]) {
  if (!additions.length) return;
  const history = new Map((await readHistory(metadata)).map(row => [row.id, row]));
  for (const row of additions) history.set(row.id, row);
  await stored(metadata.put([...history.values()].sort(newestOperationFirst).slice(0, operationHistoryLimit), historyKey));
}
type Scope = Pick<Operation, 'threadId' | 'projectId' | 'resourceId' | 'draftKey' | 'draftRevision' | 'terminalOwner'>;
export function isArchivedReceipt(receipt: Record<string, unknown>): boolean {
  const error = receipt.error as Record<string, unknown> | undefined;
  return typeof receipt.operationId === 'string' && receipt.scope === `operation:${receipt.operationId}` &&
    receipt.method === 'operation/archived' && receipt.state === 'unknown' && error?.code === 'operation_archived';
}
export function checkedTerminalResult(value: unknown): TerminalResult {
  const id = value && typeof value === 'object' ? (value as TerminalResult).terminalId : undefined;
  if (typeof id !== 'string' || !id || id.length > 256 || /[\x00-\x1f\x7f\ud800-\udfff]/u.test(id))
    throw new Error('终端已受理，但回执缺少有效终端标识。请查询原操作回执。');
  return { terminalId: id };
}
function checkedOperation(value: unknown, id?: string): Operation {
  if (!value || typeof value !== 'object') throw new Error('操作恢复记录损坏，已暂停新操作。');
  const record = value as Operation;
  if (typeof record.id !== 'string' || (id !== undefined && id !== record.id) ||
      typeof record.method !== 'string' || !Number.isFinite(record.createdAt) ||
      ['threadId', 'projectId', 'resourceId', 'draftKey', 'draftRevision', 'resolvedThreadId'].some((field) =>
        (value as Record<string, unknown>)[field] !== undefined && typeof (value as Record<string, unknown>)[field] !== 'string') ||
      !['pending', 'unknown', 'accepted', 'not_sent'].includes(record.state) ||
      (record.consumed !== undefined && record.consumed !== true) ||
      (record.legacy !== undefined && record.legacy !== true) ||
      (record.terminalOwner !== undefined && (!record.terminalOwner ||
        typeof record.terminalOwner.clientId !== 'string' || !record.terminalOwner.clientId ||
        typeof record.terminalOwner.connectionId !== 'string' || !record.terminalOwner.connectionId)))
    throw new Error('操作恢复记录损坏，已暂停新操作。');
  if (record.terminalResult !== undefined) checkedTerminalResult(record.terminalResult);
  if (record.recoveryOperations !== undefined && (record.method !== 'system/recover' ||
      !Array.isArray(record.recoveryOperations) || record.recoveryOperations.length > 200 ||
      new Set(record.recoveryOperations.map(row => row?.id)).size !== record.recoveryOperations.length ||
      record.recoveryOperations.some(row => !row || row.id === record.id ||
        typeof row.id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(row.id) ||
        typeof row.method !== 'string' || !row.method || row.method.length > 256 || row.method === 'system/recover')))
    throw new Error('强制恢复的操作清单损坏，已保留原记录。');
  return record;
}
const legacyPrefix = 'harness.operation.v1.';
const acceptedPrefix = 'harness.accepted.v1.';
const notSentPrefix = 'harness.not-sent.v1.';
const acknowledgedPrefix = 'harness.acknowledged.v1.';
const sentinel = legacyPrefix + 'client-update-required';
const seal = 'legacy-sealed';
let authorized = false;
let initialization: Promise<void> | undefined;
let initializedFactory: IDBFactory | undefined;
let storageWarning = '';
let channel: BroadcastChannel | undefined;
let subscribers = 0;
const changed = () => { window.dispatchEvent(new Event('harness-operations')); channel?.postMessage('changed'); };
export const operationStorageWarning = () => storageWarning;
export function reportOperationStorageError(error: unknown) {
  storageWarning = `操作恢复存储需要检查：${error instanceof Error ? error.message : String(error)}`;
  changed();
}
export function subscribeOperations(listener: () => void) {
  subscribers++;
  if (typeof BroadcastChannel !== 'undefined' && !channel) {
    channel = new BroadcastChannel('harness-operation-recovery-v2');
    channel.onmessage = () => window.dispatchEvent(new Event('harness-operations'));
  }
  window.addEventListener('harness-operations', listener);
  window.addEventListener('storage', listener);
  window.addEventListener('focus', listener);
  return () => {
    window.removeEventListener('harness-operations', listener);
    window.removeEventListener('storage', listener);
    window.removeEventListener('focus', listener);
    if (--subscribers === 0) { channel?.close(); channel = undefined; }
  };
}
function legacyKeys(storage: Storage): string[] {
  // Capture names once: key(i) indices can shift when another document acknowledges a record.
  return Object.keys(storage).filter((key) => key !== sentinel &&
    [legacyPrefix, acceptedPrefix, notSentPrefix, acknowledgedPrefix].some((prefix) => key.startsWith(prefix)));
}
async function consumeLegacyClosures(records: IDBObjectStore, metadata: IDBObjectStore, storage: Storage) {
  const consumed: string[] = [];
  const history: OperationHistoryEntry[] = [];
  for (const value of await stored(records.getAll()) as unknown[]) {
    const record = checkedOperation(value);
    if (record.legacy && storage.getItem(acknowledgedPrefix + record.id) === '1') {
      history.push(historyEntry(record, 'legacy_closed'));
      await stored(records.delete(record.id));
      consumed.push(acknowledgedPrefix + record.id);
    }
  }
  await archiveOperations(metadata, history);
  return consumed;
}
/** Only an authenticated gateway capability confirms the legacy admission fence. */
export async function initializeOperations(protocol: unknown, retry = false): Promise<void> {
  if (initializedFactory !== globalThis.indexedDB) {
    initialization = undefined;
    historyWarning = '';
    initializedFactory = globalThis.indexedDB;
  }
  authorized = protocol === 2;
  if (!authorized) {
    initialization = undefined;
    throw new Error('服务尚未确认安全的操作恢复协议，请更新服务并重新检查登录状态。');
  }
  if (retry) initialization = undefined;
  if (initialization) return initialization;
  const initialize = async () => {
    const storage = localStorage;
    const cleaned = await operationTransaction(async (records, metadata) => {
      const alreadySealed = await stored(metadata.get(seal));
      const keys = legacyKeys(storage);
      if (alreadySealed !== true) {
        if (alreadySealed !== undefined) throw new Error('操作恢复迁移标记损坏。');
        for (const key of keys.filter((item) => item.startsWith(legacyPrefix))) {
          const id = key.slice(legacyPrefix.length);
          const raw = storage.getItem(key);
          if (raw === null) continue; // A legacy acknowledgement removed it after the name snapshot.
          let latest: Operation;
          try {
            const record = checkedOperation(JSON.parse(raw), id);
            const accepted = storage.getItem(acceptedPrefix + id);
            const proof = accepted ?? storage.getItem(notSentPrefix + id);
            latest = proof === null ? record : checkedOperation(JSON.parse(proof), id);
            if (proof !== null && latest.state !== (accepted !== null ? 'accepted' : 'not_sent'))
              throw new Error('操作的证明记录损坏。');
            if (proof !== null && (['id', 'method', 'threadId', 'projectId', 'resourceId', 'draftKey', 'draftRevision', 'createdAt']
              .some((field) => record[field as keyof Operation] !== latest[field as keyof Operation]) ||
              record.terminalOwner?.clientId !== latest.terminalOwner?.clientId ||
              record.terminalOwner?.connectionId !== latest.terminalOwner?.connectionId))
              throw new Error('操作证明与原请求身份不一致，已保留原记录。');
          } catch (error) {
            // Old closed records were previously skipped entirely. Best-effort
            // display history must not introduce a new migration admission gate.
            if (storage.getItem(acknowledgedPrefix + id) !== '1') throw error;
            warnDamagedHistory(); continue;
          }
          if (storage.getItem(acknowledgedPrefix + id) === '1')
            await archiveOperations(metadata, [historyEntry(latest, 'legacy_closed')]);
          else await stored(records.add({ ...latest, legacy: true }));
        }
        await stored(metadata.put(true, seal));
      }
      await consumeLegacyClosures(records, metadata, storage);
      return keys;
    });
    // Source removal follows the committed identities + seal, never request success alone.
    storageWarning = '';
    try {
      for (const key of cleaned) storage.removeItem(key);
      storage.setItem(sentinel, JSON.stringify({ error: '请刷新页面以升级操作恢复存储。' }));
      if (storage.getItem(sentinel) === null) throw new Error('旧页面刷新提示尚未保存。');
    } catch (error) {
      // The server admission fence + committed seal provide safety. This UX sentinel is optional.
      reportOperationStorageError(error);
    }
    changed();
  };
  const pending = initialize();
  initialization = pending;
  try { await pending; }
  catch (error) { if (initialization === pending) initialization = undefined; throw error; }
}
async function ready() {
  if (!authorized) throw new Error('操作恢复尚未完成安全初始化，请重新检查登录状态。');
  await initializeOperations(2);
}
async function transact<T>(run: (records: IDBObjectStore, metadata: IDBObjectStore) => Promise<T>): Promise<T> {
  await ready();
  const storage = localStorage;
  const result = await operationTransaction(async (records, metadata) => {
    const consumed = await consumeLegacyClosures(records, metadata, storage);
    return { value: await run(records, metadata), consumed };
  });
  try { for (const key of result.consumed) storage.removeItem(key); }
  catch (error) { reportOperationStorageError(error); }
  return result.value;
}
export async function listOperations(): Promise<Operation[]> {
  return transact(async (records) => (await stored(records.getAll()) as unknown[])
    .map((record) => checkedOperation(record)).sort((a, b) => a.createdAt - b.createdAt));
}
/** A single snapshot for display only. Archived rows never re-enter recovery consumers. */
export async function listOperationHistory(): Promise<{ operations: Operation[]; history: OperationHistoryEntry[]; historyWarning: string }> {
  return transact(async (records, metadata) => {
    const operations = (await stored(records.getAll()) as unknown[]).map(row => checkedOperation(row));
    const ids = new Set(operations.map(row => row.id));
    const history = (await readHistory(metadata)).filter(row => !ids.has(row.id));
    return { operations, history, historyWarning };
  });
}
const threadReceiptMethods = new Set([...INPUT_METHODS, 'thread/fork', 'thread/convert', 'review/startNew']);
/** Keep fresh receipts available to settings refresh and new-thread handoff.
 * Only the view that has loaded the destination can make them collectible. */
export async function consumeThreadOperations(threadId: string, ids: string[]): Promise<void> {
  if (!threadId || ids.length === 0) return;
  const changedRecords = await transact(async (records) => {
    let changed = false;
    for (const id of new Set(ids)) {
      const value: unknown = await stored(records.get(id));
      if (value === undefined) continue;
      const record = checkedOperation(value, id);
      if (record.state !== 'accepted' || record.consumed ||
          !threadReceiptMethods.has(record.method) ||
          (record.resolvedThreadId ?? record.threadId) !== threadId) continue;
      // Retry any interrupted draft cleanup before allowing the receipt to be
      // collected. A newer revision remains untouched by clearDraftSnapshot.
      if (!record.legacy && record.draftKey && record.draftRevision) clearDraftSnapshot(record.draftKey, record.draftRevision);
      await stored(records.put({ ...record, consumed: true }));
      changed = true;
    }
    return changed;
  });
  if (changedRecords) changed();
}

/** Allocating an ID is separate from committing it; only this promise permits dispatch. */
export async function createOperation(
  method: string, scope: Scope, generation = 0, id = operationId(generation),
): Promise<Operation> {
  const record: Operation = structuredClone({ id, method, ...scope, createdAt: Date.now(), state: 'pending' });
  await transact(async (store, metadata) => {
    if ((await readHistory(metadata)).some(row => row.id === id))
      throw new Error('这个操作编号已关闭，不能重新发送；新尝试需要新的操作编号。');
    let records = (await stored(store.getAll()) as unknown[]).map((value) => checkedOperation(value));
    if (records.length >= 160) {
      // Ordinary API successes are already auto-acknowledged. Reconciled successes
      // stay available to the immediate proof reader, then can age out under pressure.
      // Thread handoffs and typed owner receipts still need their explicit consumer.
      const collectible = records.filter((row) => row.state === 'not_sent' ||
        row.state === 'accepted' && (row.consumed ||
          !threadReceiptMethods.has(row.method) && !['terminal/open', 'system/recover'].includes(row.method)))
        .sort((a, b) => -newestOperationFirst(a, b)).slice(0, Math.max(0, records.length - 128));
      await archiveOperations(metadata, collectible.map(row => historyEntry(row, 'collected')));
      for (const row of collectible) await stored(store.delete(row.id));
      const removed = new Set(collectible.map((row) => row.id));
      records = records.filter((row) => !removed.has(row.id));
    }
    // One reserved slot lets an explicit emergency recovery operate at the ordinary budget.
    if (records.length >= (method === 'system/recover' ? 201 : 200)) throw new Error('恢复记录已达到 200 条上限。请在设置 → 操作记录中查询待确认结果，或打开尚未加载的已受理会话。');
    if (records.some((r) => ['pending', 'unknown'].includes(r.state) &&
      (r.method === method || (INPUT_METHODS.includes(r.method) && INPUT_METHODS.includes(method))) &&
      r.threadId === scope.threadId && r.projectId === scope.projectId && r.resourceId === scope.resourceId &&
      (method !== 'terminal/open' || (r.terminalOwner?.clientId === scope.terminalOwner?.clientId &&
        r.terminalOwner?.connectionId === scope.terminalOwner?.connectionId))))
      throw new Error('此操作还有待确认的请求。请先查询回执。');
    if (method === 'system/recover') record.recoveryOperations = records
      .filter(row => row.method !== 'system/recover' && ['pending', 'unknown'].includes(row.state))
      .map(({ id: previousId, method: previousMethod }) => ({ id: previousId, method: previousMethod }));
    checkedOperation(record);
    await stored(store.add(record));
    if (JSON.stringify(await stored(store.get(id))) !== JSON.stringify(record))
      throw new Error('无法持久保存操作标识，尚未发送请求。');
  });
  changed();
  return record;
}
export async function updateOperation(
  id: string, state: OperationState, resolvedThreadId?: string, terminalResult?: TerminalResult,
) {
  const updated = await transact(async (records) => {
    const value: unknown = await stored(records.get(id));
    if (value === undefined) return;
    const record = checkedOperation(value, id);
    if (record.state === 'accepted' && state !== 'accepted') return;
    if (record.state === 'not_sent' && state === 'unknown') return;
    const terminal = state === 'accepted' && record.method === 'terminal/open' && terminalResult
      ? checkedTerminalResult(terminalResult) : undefined;
    if (terminal && record.terminalResult && terminal.terminalId !== record.terminalResult.terminalId)
      throw new Error('同一操作返回了不同的终端标识，已保留原回执。');
    const next = { ...record, state, ...(resolvedThreadId ? { resolvedThreadId } : {}),
      ...(terminal ? { terminalResult: terminal } : {}) };
    await stored(records.put(next));
    return next;
  });
  try {
    if (updated?.state === 'accepted' && !updated.legacy && updated.draftKey && updated.draftRevision)
      clearDraftSnapshot(updated.draftKey, updated.draftRevision);
  } finally { changed(); }
}
export async function acknowledgeOperation(id: string) {
  const removed = await transact(async (records, metadata) => {
    const value: unknown = await stored(records.get(id));
    if (value === undefined) return;
    const record = checkedOperation(value, id);
    if (!['accepted', 'not_sent'].includes(record.state)) throw new Error('未知操作仍需保留，不能据此重复发送。');
    await archiveOperations(metadata, [historyEntry(record, record.state === 'accepted' ? 'completed' : 'dismissed')]);
    await stored(records.delete(id));
    return record;
  });
  try {
    if (removed?.state === 'accepted' && !removed.legacy && removed.draftKey && removed.draftRevision)
      clearDraftSnapshot(removed.draftKey, removed.draftRevision);
  } finally { changed(); }
}
/** Local closure only. It never changes the server receipt or clears an unsent draft. */
export async function stopUnknownRecovery(id: string, proof: Record<string, unknown>) {
  await transact(async (records, metadata) => {
    const value: unknown = await stored(records.get(id));
    if (proof.operationId !== id || proof.state !== 'unknown' || value === undefined ||
        checkedOperation(value, id).state !== 'unknown')
      throw new Error('需要当前操作的明确未知回执，不能根据暂未登记或处理中停止恢复。');
    await archiveOperations(metadata, [historyEntry(checkedOperation(value, id), 'recovery_stopped')]);
    await stored(records.delete(id));
  });
  changed();
}
export async function reconcileOperation(id: string, result: Record<string, unknown>) {
  const state = result.state ?? result.status ?? result.delivery;
  const details = result.result as Record<string, unknown> | undefined;
  const thread = details?.thread as { id?: string } | undefined;
  if (state === 'accepted') await updateOperation(id, 'accepted',
    thread?.id ?? (typeof details?.threadId === 'string' ? details.threadId : undefined),
    details && Object.hasOwn(details, 'terminalId') ? checkedTerminalResult(details) : undefined);
  else if (state === 'not_sent') await updateOperation(id, 'not_sent');
  else {
    const error = result.error as Record<string, unknown> | undefined;
    const data = error?.data as Record<string, unknown> | undefined;
    await updateOperation(id, 'unknown', typeof data?.threadId === 'string' ? data.threadId : undefined);
  }
}
