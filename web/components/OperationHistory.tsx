import { useState } from 'react';
import type { Api } from '../lib/api';
import { acknowledgeOperation } from '../lib/operations';
import { message } from '../lib/types';
import { Recovery, useOperations } from './Recovery';

/** Explicit management surface; routine accepted receipts stay out of chat. */
export function OperationHistory({ api, runtimeReady, recoveryEpoch, openThread, openWorkspace }: {
  api: Api;
  runtimeReady: boolean;
  recoveryEpoch: string;
  openThread: (id: string) => void;
  openWorkspace?: (projectId: string, path?: string) => void;
}) {
  const operations = useOperations();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirmed, setConfirmed] = useState('');
  const completed = operations.operations.filter(row => row.state === 'accepted' || row.state === 'not_sent');
  const completedKey = completed.map(row => row.id + ':' + row.state).join(',');
  return <section className="stack">
    <h3>操作记录</h3>
    <p className="small muted">记录保存在当前浏览器。普通成功操作不会在对话中提醒；已加载会话的成功记录会在需要时自动清理。清理本地记录不会删除会话、项目或服务器回执。</p>
    {completed.length > 0 && <details className="info-card">
      <summary>清理已完成记录（{completed.length} 条）</summary>
      <p className="small">先打开并核对尚未查看的新会话或分支。只清理已受理和确定未发送的记录；等待确认、结果未知的记录会保留，草稿不会因此重发。</p>
      <label className="check-row"><input type="checkbox" checked={confirmed === completedKey} disabled={busy} onChange={event => setConfirmed(event.target.checked ? completedKey : '')} />我已核对这些操作的结果</label>
      <button className="button" disabled={confirmed !== completedKey || busy} onClick={async () => {
        setBusy(true); setError('');
        try {
          for (const row of completed) await acknowledgeOperation(row.id);
          setConfirmed('');
        } catch (error) { setError(message(error)); }
        finally { setBusy(false); }
      }}>{busy ? '正在清理…' : '清理已完成记录'}</button>
    </details>}
    {error && <p role="alert" className="error">{error}</p>}
    {operations.operations.length === 0 && !operations.error && !operations.warning && <p className="muted">暂无需要保留的本地记录。</p>}
    <Recovery api={api} operations={operations.operations} error={operations.error} warning={operations.warning}
      runtimeReady={runtimeReady} recoveryEpoch={recoveryEpoch} openThread={openThread} openWorkspace={openWorkspace} showCompleted />
  </section>;
}
