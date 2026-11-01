import type { Api } from './api';
import { reconcileOperation, stopUnknownRecovery, type Operation } from './operations';

export type EmergencyOperation = Readonly<Pick<Operation, 'id' | 'method'>>;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const MAX_OPERATIONS = 200, READERS = 4, DEADLINE_MS = 12_000;

function checkedSnapshot(rows: readonly EmergencyOperation[]): void {
  if (!Array.isArray(rows) || rows.length > MAX_OPERATIONS || new Set(rows.map(row => row?.id)).size !== rows.length ||
      rows.some(row => !row || typeof row.id !== 'string' || !UUID.test(row.id) ||
        typeof row.method !== 'string' || !row.method || row.method.length > 256 || row.method === 'system/recover'))
    throw new Error('恢复前的操作快照无效，已保留本地操作记录。');
}

/** Capture immediately before explicit recovery submission, never infer a set from timestamps. */
export function captureEmergencyOperations(rows: readonly Operation[]): readonly EmergencyOperation[] {
  if (!Array.isArray(rows) || rows.length > MAX_OPERATIONS + 1)
    throw new Error('恢复记录超过预算，已保留原记录。');
  const snapshot = rows.filter(row => row.method !== 'system/recover' && ['pending', 'unknown'].includes(row.state))
    .map(({ id, method }) => Object.freeze({ id, method }));
  if (snapshot.length > MAX_OPERATIONS) throw new Error('恢复记录超过预算，已保留原记录。');
  checkedSnapshot(snapshot);
  return Object.freeze(snapshot);
}

/** Close only captured local reminders backed by a fresh explicit unknown receipt.
 * This sends read RPCs only; accepted/not-sent drafts remain for their normal workflows. */
export async function closeEmergencyOperations(
  api: Api, captured: readonly EmergencyOperation[], recoveryId: string,
  proof: Record<string, unknown>, signal?: AbortSignal,
): Promise<{ closedIds: string[]; retainedIds: string[]; errors: { id: string; reason: string }[]; interrupted: boolean }> {
  checkedSnapshot(captured);
  const result = proof?.result as Record<string, unknown> | undefined;
  if (!UUID.test(recoveryId) || proof?.operationId !== recoveryId || proof.method !== 'system/recover' || proof.state !== 'accepted' ||
      !result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 2 ||
      result.restarted !== true || typeof result.release !== 'string' || !/^[a-f0-9]{64}$/.test(result.release) ||
      captured.some(row => row.id === recoveryId))
    throw new Error('尚无本次强制恢复的完整成功证明，已保留本地操作记录。');
  // Copy even an explicitly supplied snapshot so callers cannot extend it while reads await.
  const rows = captured.map(({ id, method }) => ({ id, method }));
  const closed = new Set<string>(), errors: { id: string; reason: string }[] = [];
  const controller = new AbortController(), csrf = api.csrf;
  const abort = () => controller.abort();
  const authorized = () => !controller.signal.aborted && api.csrf === csrf && !api.externalAuthenticationRequired;
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const unsubscribe = api.onAuthenticationLost(abort);
  const timer = setTimeout(abort, DEADLINE_MS);
  let next = 0;
  const reader = async () => {
    while (authorized() && next < rows.length) {
      const row = rows[next++]!;
      try {
        const receipt = await api.call('operation/read', { operationId: row.id }, controller.signal);
        if (!authorized()) break;
        if (receipt.operationId !== row.id || receipt.method !== row.method || receipt.state !== 'unknown') continue;
        await reconcileOperation(row.id, receipt);
        if (!authorized()) break;
        // This transactional check refuses a concurrent accepted/not_sent fact.
        await stopUnknownRecovery(row.id, receipt);
        closed.add(row.id);
      } catch {
        errors.push({ id: row.id, reason: '原回执读取或本地关闭未完成，已保留记录供核对。' });
      }
    }
  };
  try { await Promise.all(Array.from({ length: Math.min(READERS, rows.length) }, reader)); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); unsubscribe(); }
  return { closedIds: rows.filter(row => closed.has(row.id)).map(row => row.id),
    retainedIds: rows.filter(row => !closed.has(row.id)).map(row => row.id), errors, interrupted: !authorized() };
}
