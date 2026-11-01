import type { Api } from '../lib/api';
import { operationHistoryLimit } from '../lib/operations';
import { Recovery, useOperations } from './Recovery';

/** Explicit management surface; routine accepted receipts stay out of chat. */
export function OperationHistory({ api, runtimeReady, recoveryEpoch, openThread, openWorkspace }: {
  api: Api;
  runtimeReady: boolean;
  recoveryEpoch: string;
  openThread: (id: string) => void;
  openWorkspace?: (projectId: string, path?: string) => void;
}) {
  const operations = useOperations(true);
  return <section className="stack">
    <h3>操作记录</h3>
    <p className="small muted">按创建时间显示，最新在前。当前浏览器自动保留最近 {operationHistoryLimit} 条已处理记录，待确认操作不会被清理。</p>
    {operations.historyWarning && <p className="small muted" role="status">{operations.historyWarning}</p>}
    {operations.operations.length === 0 && operations.history.length === 0 && !operations.error && !operations.warning && <p className="muted">暂无本地操作记录。</p>}
    <Recovery api={api} operations={operations.operations} error={operations.error} warning={operations.warning}
      runtimeReady={runtimeReady} recoveryEpoch={recoveryEpoch} openThread={openThread} openWorkspace={openWorkspace} history={operations.history} />
  </section>;
}
