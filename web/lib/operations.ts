import { operationId } from './ids';
import { INPUT_METHODS } from './workflows';
export type OperationState = 'pending' | 'unknown' | 'accepted' | 'not_sent';
export function isArchivedReceipt(receipt: Record<string, unknown>): boolean {
  const error = receipt.error as Record<string, unknown> | undefined;
  return (
    typeof receipt.operationId === 'string' &&
    receipt.scope === `operation:${receipt.operationId}` &&
    receipt.method === 'operation/archived' &&
    receipt.state === 'unknown' &&
    error?.code === 'operation_archived'
  );
}
export type TerminalResult = { terminalId: string };
export type TerminalOwner = { clientId: string; connectionId: string };
export type Operation = {
  id: string;
  method: string;
  threadId?: string;
  projectId?: string;
  resourceId?: string;
  draftKey?: string;
  draftRevision?: string;
  createdAt: number;
  state: OperationState;
  resolvedThreadId?: string;
  terminalOwner?: TerminalOwner;
  terminalResult?: TerminalResult;
};
export function checkedTerminalResult(value: unknown): TerminalResult {
  const id = value && typeof value === 'object' ? (value as TerminalResult).terminalId : undefined;
  if (typeof id !== 'string' || !id || id.length > 256 || /[\x00-\x1f\x7f\ud800-\udfff]/u.test(id))
    throw new Error('终端已受理，但回执缺少有效终端标识。请查询原操作回执。');
  return { terminalId: id };
}
const prefix = 'harness.operation.v1.';
const acceptedPrefix = 'harness.accepted.v1.';
const notSentPrefix = 'harness.not-sent.v1.';
const acknowledgedPrefix = 'harness.acknowledged.v1.';
const changed = () => window.dispatchEvent(new Event('harness-operations'));
const isOperation = (v: unknown): v is Operation => {
  if (!v || typeof v !== 'object') return false;
  const r = v as Operation;
  if (
    r.terminalOwner !== undefined &&
    (!r.terminalOwner ||
      typeof r.terminalOwner.clientId !== 'string' ||
      !r.terminalOwner.clientId ||
      typeof r.terminalOwner.connectionId !== 'string' ||
      !r.terminalOwner.connectionId)
  )
    return false;
  if (r.terminalResult !== undefined) {
    try {
      checkedTerminalResult(r.terminalResult);
    } catch {
      return false;
    }
  }
  return (
    typeof r.id === 'string' &&
    typeof r.method === 'string' &&
    Number.isFinite(r.createdAt) &&
    ['pending', 'unknown', 'accepted', 'not_sent'].includes(r.state)
  );
};
export function listOperations(storage: Storage = localStorage): Operation[] {
  const result: Operation[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(prefix)) continue;
    const id = key.slice(prefix.length);
    if (storage.getItem(acknowledgedPrefix + id) === '1') continue;
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? 'null');
    if (!isOperation(parsed) || key !== prefix + parsed.id)
      throw new Error('操作恢复记录损坏。为避免重复提交，已暂停新操作。');
    const accepted = storage.getItem(acceptedPrefix + id),
      proof = accepted ?? storage.getItem(notSentPrefix + id);
    if (proof !== null) {
      const value: unknown = JSON.parse(proof);
      if (
        !isOperation(value) ||
        value.id !== id ||
        value.state !== (accepted !== null ? 'accepted' : 'not_sent')
      )
        throw new Error('操作的证明记录损坏。');
      result.push(value);
    } else result.push(parsed);
  }
  return result.sort((a, b) => a.createdAt - b.createdAt);
}
export function createOperation(
  method: string,
  scope: {
    threadId?: string;
    projectId?: string;
    resourceId?: string;
    draftKey?: string;
    draftRevision?: string;
    terminalOwner?: TerminalOwner;
  },
  storage: Storage = localStorage,
  generation = 0,
): Operation {
  const records = listOperations(storage);
  if (records.length >= 200) throw new Error('恢复记录已达到 200 条上限。请先处理已完成的记录。');
  if (
    records.some(
      (r) =>
        ['pending', 'unknown'].includes(r.state) &&
        (r.method === method ||
          (INPUT_METHODS.includes(r.method) && INPUT_METHODS.includes(method))) &&
        r.threadId === scope.threadId &&
        r.projectId === scope.projectId &&
        r.resourceId === scope.resourceId &&
        (method !== 'terminal/open' ||
          (r.terminalOwner?.clientId === scope.terminalOwner?.clientId &&
            r.terminalOwner?.connectionId === scope.terminalOwner?.connectionId)),
    )
  )
    throw new Error('此操作还有待确认的请求。请先查询回执。');
  const record: Operation = {
    id: operationId(generation),
    method,
    ...scope,
    createdAt: Date.now(),
    state: 'pending',
  };
  storage.setItem(prefix + record.id, JSON.stringify(record));
  if (storage.getItem(prefix + record.id) !== JSON.stringify(record))
    throw new Error('无法持久保存操作标识，尚未发送请求。');
  changed();
  return record;
}
export function updateOperation(
  id: string,
  state: OperationState,
  resolvedThreadId?: string,
  storage: Storage = localStorage,
  terminalResult?: TerminalResult,
) {
  if (storage.getItem(acknowledgedPrefix + id) === '1') return;
  const raw = storage.getItem(prefix + id);
  if (!raw) return;
  const record: unknown = JSON.parse(
    storage.getItem(acceptedPrefix + id) ?? storage.getItem(notSentPrefix + id) ?? raw,
  );
  if (!isOperation(record)) throw new Error('恢复记录无法读取。');
  // An accepted receipt is a monotonic fact; stale failures cannot undo it.
  if (
    (record.state === 'accepted' || storage.getItem(acceptedPrefix + id) !== null) &&
    state !== 'accepted'
  )
    return;
  if (record.state === 'not_sent' && state === 'unknown') return;
  const terminal =
    state === 'accepted' && record.method === 'terminal/open' && terminalResult
      ? checkedTerminalResult(terminalResult)
      : undefined;
  if (terminal && record.terminalResult && record.terminalResult.terminalId !== terminal.terminalId)
    throw new Error('同一操作返回了不同的终端标识，已保留原回执。');
  const next = JSON.stringify({
    ...record,
    state,
    ...(resolvedThreadId ? { resolvedThreadId } : {}),
    ...(terminal ? { terminalResult: terminal } : {}),
  });
  // Separate immutable proof and acknowledgement keys survive cross-tab read/write races.
  if (state === 'accepted') storage.setItem(acceptedPrefix + id, next);
  if (state === 'not_sent') storage.setItem(notSentPrefix + id, next);
  storage.setItem(prefix + id, next);
  if (state === 'accepted' && record.draftKey && record.draftRevision)
    clearDraftSnapshot(record.draftKey, record.draftRevision);
  changed();
}
export function acknowledgeOperation(id: string, storage: Storage = localStorage) {
  const record = listOperations(storage).find((r) => r.id === id);
  if (!record || !['accepted', 'not_sent'].includes(record.state))
    throw new Error('未知操作仍需保留，不能据此重复发送。');
  if (record.state === 'accepted' && record.draftKey && record.draftRevision)
    clearDraftSnapshot(record.draftKey, record.draftRevision);
  acknowledge(id, storage);
}
/** Local closure only. It never changes the server receipt or clears an unsent draft. */
export function stopUnknownRecovery(
  id: string,
  proof: Record<string, unknown>,
  storage: Storage = localStorage,
) {
  const record = listOperations(storage).find((r) => r.id === id);
  if (
    proof.operationId !== id ||
    proof.state !== 'unknown' ||
    !record ||
    record.state !== 'unknown'
  )
    throw new Error('需要当前操作的明确未知回执，不能根据暂未登记或处理中停止恢复。');
  acknowledge(id, storage);
}
function acknowledge(id: string, storage: Storage) {
  storage.setItem(acknowledgedPrefix + id, '1');
  if (storage.getItem(acknowledgedPrefix + id) !== '1')
    throw new Error('无法保存停止恢复标记，仍需保留此操作。');
  storage.removeItem(prefix + id);
  storage.removeItem(acceptedPrefix + id);
  storage.removeItem(notSentPrefix + id);
  changed();
}
export function reconcileOperation(id: string, result: Record<string, unknown>) {
  const state = result.state ?? result.status ?? result.delivery;
  const details = result.result as Record<string, unknown> | undefined;
  const thread = details?.thread as { id?: string } | undefined;
  if (state === 'accepted')
    updateOperation(
      id,
      'accepted',
      thread?.id ?? (typeof details?.threadId === 'string' ? details.threadId : undefined),
      localStorage,
      details && Object.hasOwn(details, 'terminalId') ? checkedTerminalResult(details) : undefined,
    );
  else if (state === 'not_sent') updateOperation(id, 'not_sent');
  else {
    const error = result.error as Record<string, unknown> | undefined,
      data = error?.data as Record<string, unknown> | undefined;
    updateOperation(id, 'unknown', typeof data?.threadId === 'string' ? data.threadId : undefined);
  } // not_received is observation, never safe-to-retry evidence.
}
import { clearDraftSnapshot } from './drafts';
