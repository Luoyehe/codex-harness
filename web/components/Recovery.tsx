import { isArchivedReceipt } from '../lib/operations';
import { useEffect, useRef, useState } from 'react';
import type { Api } from '../lib/api';
import {
  acknowledgeOperation,
  listOperations,
  listOperationHistory,
  newestOperationFirst,
  reconcileOperation,
  stopUnknownRecovery,
  operationStorageWarning,
  subscribeOperations,
  initializeOperations,
  type Operation,
  type OperationHistoryEntry,
} from '../lib/operations';
import { message, object } from '../lib/types';
const operationNames: Record<string, string> = {
  'project/add': '添加已有项目', 'project/create': '新建项目', 'project/rename': '重命名项目', 'project/remove': '移除项目',
  'conversation/start': '开始新会话', 'turn/start': '发送消息', 'turn/steer': '追加指令', 'turn/interrupt': '停止任务',
  'thread/resume': '加载会话', 'thread/name/set': '重命名会话', 'thread/archive': '归档会话',
  'thread/convert': '转换会话',
  'thread/unarchive': '取消会话归档', 'thread/delete': '删除会话', 'terminal/open': '打开终端',
  'system/provider/write': '保存模型供应商', 'system/models/refresh': '刷新模型目录',
  'system/restart': '重启服务', 'system/recover': '强制停止并恢复', 'system/execution-mode/write': '切换执行权限',
  'mcp/oauth': 'MCP 浏览器授权',
  'thread/fork': '复制会话分支', 'thread/compact': '压缩会话上下文', 'thread/revert': '回退会话',
  'thread/settings/update': '修改会话设置', 'turn/settings/update': '修改回合设置',
  'thread/queue/add': '添加待办消息', 'thread/queue/update': '修改待办消息',
  'thread/queue/delete': '删除待办消息', 'thread/queue/start': '执行待办消息', 'thread/queue/reorder': '调整待办顺序',
  'thread/goal/set': '设置持续目标', 'thread/goal/clear': '清除持续目标',
  'thread/unsubscribe': '停止会话订阅', 'thread/shellCommand': '执行会话命令',
  'thread/backgroundTerminals/clean': '停止会话后台进程',
  'thread/realtime/start': '启动实时会话', 'thread/realtime/stop': '结束实时会话',
  'review/start': '启动审查', 'review/startNew': '在新会话启动审查',
  'automation/create': '创建自动化', 'automation/update': '修改自动化', 'automation/remove': '删除自动化',
  'automation/run': '立即运行自动化', 'automation/pause': '暂停自动化', 'automation/resume': '启用自动化',
  'workspace/write': '保存文件', 'workspace/delete': '删除文件', 'workspace/move': '移动文件',
  'workspace/mkdir': '创建目录', 'workspace/git/commit': '提交 Git 修改',
  'attachment/upload': '上传附件', 'attachment/delete': '删除附件',
  'process/start': '启动进程', 'process/kill': '停止进程树', 'process/remove': '移除进程输出',
  'process/writeStdin': '发送进程输入', 'process/resize': '调整进程终端',
  'account/login/start': '登录模型账号', 'account/login/cancel': '取消模型账号登录', 'account/logout': '退出模型账号',
  'settings/write': '保存项目配置', 'mcp/configuration/write': '保存 MCP 配置',
  'mcp/call': '调用 MCP 工具', 'remoteControl/pairing/start': '创建远端配对',
  'plugin/install': '安装插件', 'plugin/uninstall': '卸载插件', 'marketplace/add': '添加插件市场',
  'marketplace/remove': '移除插件市场', 'marketplace/upgrade': '更新插件市场',
  'operation/maintenance/rotate': '清理服务回执', 'import/apply': '导入配置',
};
export function useOperations(withHistory = false) {
  const [operations, setOperations] = useState<Operation[]>([]),
    [history, setHistory] = useState<OperationHistoryEntry[]>([]),
    [historyWarning, setHistoryWarning] = useState(''),
    [error, setError] = useState(''), [warning, setWarning] = useState('');
  useEffect(() => {
    let revision = 0, disposed = false;
    const read = async () => {
      const current = ++revision;
      try {
        const records = withHistory ? await listOperationHistory() : { operations: await listOperations(), history: [], historyWarning: '' };
        if (disposed || current !== revision) return;
        setOperations(records.operations);
        setHistory(records.history);
        setError('');
        setHistoryWarning(records.historyWarning);
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
  }, [withHistory]);
  return { operations, history, historyWarning, error, warning };
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
  history,
}: {
  api: Api;
  operations: Operation[];
  error: string;
  warning?: string;
  openThread: (id: string) => void;
  runtimeReady: boolean;
  recoveryEpoch: string;
  openWorkspace?: (projectId: string, path?: string) => void;
  history?: OperationHistoryEntry[];
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
  const historyView = history !== undefined;
  const attention: (Operation & { closed?: OperationHistoryEntry['closed'] })[] = historyView
    ? [...operations, ...history].sort(newestOperationFirst) : operations.filter((o) => o.state !== 'accepted');
  const nearCapacity = operations.length >= 180;
  if (!attention.length && !storeError && !warning && !error && !nearCapacity) return null;
  return (
    <details className="recovery" open={historyView || Boolean(storeError) || pending.length > 0 || nearCapacity}>
      <summary>
        {historyView ? `本地操作记录 ${attention.length} 条` : pending.length
          ? `${pending.length} 笔操作等待确认`
          : attention.length ? `${attention.length} 笔操作未执行` : nearCapacity ? '本地操作记录接近上限' : '操作记录需要检查'}
      </summary>
      {pending.length > 0 && <p className="muted small">
        查询只读取结果。暂未收到记录不代表原请求不会到达；未知操作不会自动重发。
      </p>}
      {attention.some(operation => !operation.closed && operation.state === 'not_sent') && <p className="muted small">
        确定未发送的操作没有执行，不属于结果未知，也不会阻塞新的消息。
        {historyView ? '可查看尚未关闭的失败原因；关闭提醒后仍保留历史。' : '可查看失败原因，或关闭提醒。'}
      </p>}
      {nearCapacity && <p role="status" className="workspace-warning">本地保留 {operations.length}/200 条恢复记录。请在设置 → 操作记录中查询待确认结果，或打开尚未加载的已受理会话；已处理历史会自动限额保存。</p>}
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
            !o.closed &&
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
                  {o.id.slice(0, 8)} · {historyView ? new Date(o.createdAt).toLocaleString('zh-CN') : new Date(o.createdAt).toLocaleTimeString('zh-CN')} ·{' '}
                  {
                    {
                      pending: '正在确认',
                      unknown: '结果未知',
                      accepted: '已受理',
                      not_sent: '确定未发送',
                    }[o.state]
                  }
                  {o.closed === 'dismissed' && ' · 已关闭提醒'}
                  {o.closed === 'recovery_stopped' && ' · 已停止本地恢复'}
                  {o.closed === 'legacy_closed' && ' · 旧版已关闭提醒'}
                </small>
                {!o.closed && o.state === 'not_sent' && receipt && <p className="small error" role="status">
                  {receipt.state === 'not_sent' && typeof object(receipt.error).message === 'string'
                    ? String(object(receipt.error).message).slice(0, 2000)
                    : '暂未取得该操作的失败原因，请核对原操作页面的提示；不会自动重试。'}
                </p>}
                {!o.closed && receipt?.state === 'pending' && <p className="small" role="status">服务已收到请求，仍在处理。请稍后查询；不要重复提交。</p>}
                {!o.closed && ['pending', 'unknown'].includes(o.state) && receipt?.state === 'not_received' && (
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
                {!o.closed && o.state === 'not_sent' && <button className="button small" disabled={Boolean(busy)} onClick={() => void read(o.id)}>
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
                {!o.closed && ['pending', 'unknown'].includes(o.state) && (
                  <button
                    className="button small"
                    disabled={Boolean(busy)}
                    onClick={() => void read(o.id)}
                  >
                    {busy === o.id ? '查询中…' : '查询回执'}
                  </button>
                )}
                {!historyView && o.state === 'not_sent' && (
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
                    关闭提醒
                  </button>
                )}
                {historyView && !o.closed && o.state === 'accepted' && o.method !== 'system/recover' && (
                  <details><summary>无法打开目标？</summary><p className="small muted">目标已删除或无法加载时，可将已确认受理的本地交接归入历史；不会删除服务器内容或停止执行，已发送的相同草稿会清理。</p>
                  <button className="button small" title="仅关闭已确认成功的本地交接，保留历史；不会改变服务器会话或执行。"
                    onClick={async () => { try { await acknowledgeOperation(o.id); } catch (e) { setError(message(e)); } }}>
                    关闭交接并保留历史
                  </button></details>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}
