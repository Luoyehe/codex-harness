import { isArchivedReceipt } from '../lib/operations';
import { useEffect, useRef, useState } from 'react';
import type { Api } from '../lib/api';
import {
  acknowledgeOperation,
  listOperations,
  reconcileOperation,
  stopUnknownRecovery,
  operationStorageWarning,
  subscribeOperations,
  initializeOperations,
  type Operation,
} from '../lib/operations';
import { message, object } from '../lib/types';
const operationNames: Record<string, string> = {
  'project/add': '添加已有项目', 'project/create': '新建项目', 'project/rename': '重命名项目', 'project/remove': '移除项目',
  'conversation/start': '开始新会话', 'turn/start': '发送消息', 'turn/steer': '追加指令', 'turn/interrupt': '停止任务',
  'thread/resume': '加载会话', 'thread/name/set': '重命名会话', 'thread/archive': '归档会话',
  'thread/unarchive': '取消会话归档', 'thread/delete': '删除会话', 'terminal/open': '打开终端',
  'system/provider/write': '保存模型供应商', 'system/models/refresh': '刷新模型目录',
  'system/restart': '重启服务', 'system/execution-mode/write': '切换执行权限',
};
export function useOperations() {
  const [operations, setOperations] = useState<Operation[]>([]),
    [error, setError] = useState(''), [warning, setWarning] = useState('');
  useEffect(() => {
    let revision = 0, disposed = false;
    const read = async () => {
      const current = ++revision;
      try {
        const records = await listOperations();
        if (disposed || current !== revision) return;
        setOperations(records);
        setError('');
        setWarning(operationStorageWarning());
      } catch (e) {
        if (!disposed && current === revision) setError(message(e));
      }
    };
    void read();
    const unsubscribe = subscribeOperations(() => void read());
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
  return { operations, error, warning };
}
export function Recovery({
  api,
  operations,
  error: storeError,
  warning = '',
  openThread,
  runtimeReady,
  recoveryEpoch,
  openWorkspace,
  showCompleted = false,
}: {
  api: Api;
  operations: Operation[];
  error: string;
  warning?: string;
  openThread: (id: string) => void;
  runtimeReady: boolean;
  recoveryEpoch: string;
  openWorkspace?: (projectId: string, path?: string) => void;
  showCompleted?: boolean;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState('');
  const [observations, setObservations] = useState<
      Record<string, { epoch: number; receipt: Record<string, unknown>; readOnly: boolean }>
    >({}),
    [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const scope = `${recoveryEpoch}:${runtimeReady}`;
  const lifecycle = useRef({ scope, generation: 0 });
  if (lifecycle.current.scope !== scope)
    lifecycle.current = { scope, generation: lifecycle.current.generation + 1 };
  const generation = lifecycle.current.generation;
  useEffect(() => {
    const ids = new Set(operations.map((o) => o.id));
    setObservations((current) =>
      Object.keys(current).some((id) => !ids.has(id))
        ? Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id)))
        : current,
    );
    setConfirmed((current) =>
      Object.keys(current).some((id) => !ids.has(id))
        ? Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id)))
        : current,
    );
  }, [operations]);
  const read = async (id: string, retire = false) => {
    const epoch = lifecycle.current.generation;
    setBusy(id);
    setError('');
    setConfirmed((c) => ({ ...c, [id]: false }));
    try {
      const receipt = await api.call(retire ? 'operation/retire' : 'operation/read', {
        operationId: id,
      });
      if (receipt.operationId !== id) throw new Error('操作回执身份不匹配。');
      await reconcileOperation(id, receipt);
      if (lifecycle.current.generation === epoch)
        setObservations((o) => ({ ...o, [id]: { epoch, receipt, readOnly: !retire } }));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy('');
    }
  };
  const pending = operations.filter((o) => ['pending', 'unknown'].includes(o.state));
  // Successful receipts still drive draft cleanup and reconciliation, but do not
  // need the user's attention on every page visit.
  const attention = showCompleted ? operations : operations.filter((o) => o.state !== 'accepted');
  const nearCapacity = operations.length >= 180;
  if (!attention.length && !storeError && !warning && !error && !nearCapacity) return null;
  return (
    <details className="recovery" open={showCompleted || Boolean(storeError) || pending.length > 0 || nearCapacity}>
      <summary>
        {showCompleted ? `本地操作记录 ${operations.length} 条` : pending.length
          ? `${pending.length} 笔操作等待确认`
          : attention.length ? `${attention.length} 笔操作未执行` : nearCapacity ? '本地操作记录接近上限' : '操作记录需要检查'}
      </summary>
      {pending.length > 0 && <p className="muted small">
        查询只读取结果。暂未收到记录不代表原请求不会到达；未知操作不会自动重发。
      </p>}
      {attention.some(operation => operation.state === 'not_sent') && <p className="muted small">
        确定未发送的操作没有执行，不属于结果未知，也不会阻塞新的消息。可查看失败原因；确认后点击“已知悉”移除提醒。
      </p>}
      {nearCapacity && <p role="status" className="workspace-warning">本地保留 {operations.length}/200 条操作记录。请在设置 → 操作记录中查看尚未处理的结果并清理已完成记录。</p>}
      {(error || storeError) && (
        <p role="alert" className="error">
          {storeError || error}
        </p>
      )}
      {warning && <p role="status" className="workspace-warning">{warning} 已保存的操作仍可查询；请重新检查恢复存储。</p>}
      {(storeError || warning) && <button className="button small" onClick={async () => {
        try { const session = await api.session(); await initializeOperations(session.operationRecoveryProtocol); setError(''); }
        catch (e) { setError(message(e)); }
      }}>重新检查恢复存储</button>}
      <div className="recovery-list">
        {attention.map((o) => {
          const observation = observations[o.id],
            receipt = observation?.epoch === generation ? observation.receipt : undefined;
          const canStop =
            runtimeReady &&
            observation?.readOnly &&
            receipt?.state === 'unknown' &&
            o.state === 'unknown';
          return (
            <div className="recovery-row" key={o.id}>
              <div>
                <strong title={o.method}>{operationNames[o.method] ?? o.method}</strong>
                {o.legacy && o.draftKey && <p className="small muted">旧版恢复记录已迁入；为保留旧页面尚未确认的草稿，本记录不会自动清除草稿，请核对后在草稿页处理。</p>}
                {o.method.startsWith('workspace/') && o.resourceId && (
                  <small className="path">{o.resourceId}</small>
                )}
                <small>
                  {o.id.slice(0, 8)} · {new Date(o.createdAt).toLocaleTimeString()} ·{' '}
                  {
                    {
                      pending: '正在确认',
                      unknown: '结果未知',
                      accepted: '已受理',
                      not_sent: '确定未发送',
                    }[o.state]
                  }
                </small>
                {o.state === 'not_sent' && receipt && <p className="small error" role="status">
                  {receipt.state === 'not_sent' && typeof object(receipt.error).message === 'string'
                    ? String(object(receipt.error).message).slice(0, 2000)
                    : '暂未取得该操作的失败原因，请核对原操作页面的提示；不会自动重试。'}
                </p>}
                {['pending', 'unknown'].includes(o.state) && receipt?.state === 'not_received' && (
                  <div className="stack">
                    <p className="small">
                      服务尚无此记录。可请求永久封住这个操作
                      ID；只有服务确认未发送，才解除等待。已登记的请求不会被取消。
                    </p>
                    <button
                      className="button small"
                      disabled={Boolean(busy)}
                      onClick={() => void read(o.id, true)}
                    >
                      阻止尚未登记的请求
                    </button>
                  </div>
                )}
                {canStop && (
                  <div className="stack">
                    <p className="small">
                      {isArchivedReceipt(receipt)
                        ? '该编号所属回执已归档。原请求不会重放，请核对已导出的回执、会话历史与实际变更。停止恢复仅关闭本地提醒，不能作为未执行的证明。'
                        : '后台已就绪，但原操作结果仍未知。停止恢复只关闭本地提醒，服务端仍保留未知记录，原 ID 不会重放，草稿也会保留。再次发送可能重复执行，请先核对会话历史与实际变更。'}
                    </p>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={confirmed[o.id] === true}
                        onChange={(e) => setConfirmed((c) => ({ ...c, [o.id]: e.target.checked }))}
                      />
                      我已人工核对，并接受自行再次发送可能重复执行的风险
                    </label>
                    <button
                      className="button danger small"
                      disabled={Boolean(busy) || !confirmed[o.id]}
                      onClick={async () => {
                        try {
                          if (lifecycle.current.generation !== generation || !runtimeReady) return;
                          await stopUnknownRecovery(o.id, receipt);
                          setConfirmed((c) => ({ ...c, [o.id]: false }));
                        } catch (e) {
                          setError(message(e));
                        }
                      }}
                    >
                      停止恢复此操作
                    </button>
                  </div>
                )}
              </div>
              <div className="inline">
                {o.state === 'not_sent' && <button className="button small" disabled={Boolean(busy)} onClick={() => void read(o.id)}>
                  {busy === o.id ? '读取原因…' : '查看失败原因'}
                </button>}
                {o.projectId && o.method.startsWith('workspace/') && openWorkspace && (
                  <button
                    className="button small"
                    onClick={() =>
                      openWorkspace(
                        o.projectId!,
                        o.method === 'workspace/remove'
                          ? o.resourceId?.includes('/')
                            ? o.resourceId.slice(0, o.resourceId.lastIndexOf('/'))
                            : ''
                          : o.resourceId,
                      )
                    }
                  >
                    打开项目文件
                  </button>
                )}
                {(o.resolvedThreadId || o.threadId) && (
                  <button
                    className="button small"
                    onClick={() => openThread((o.resolvedThreadId || o.threadId)!)}
                  >
                    打开
                  </button>
                )}
                {['pending', 'unknown'].includes(o.state) ? (
                  <button
                    className="button small"
                    disabled={Boolean(busy)}
                    onClick={() => void read(o.id)}
                  >
                    {busy === o.id ? '查询中…' : '查询回执'}
                  </button>
                ) : (
                  <button
                    className="button small"
                    onClick={async () => {
                      try {
                        await acknowledgeOperation(o.id);
                      } catch (e) {
                        setError(message(e));
                      }
                    }}
                  >
                    已知悉
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}
