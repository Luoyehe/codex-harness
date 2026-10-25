import { useCallback, useRef, useState } from 'react';
import type { Api } from '../lib/api';
import { useWorkflow } from '../hooks/useWorkflow';
import { reconcileOperation } from '../lib/operations';
import { message } from '../lib/types';
import { useOperations } from './Recovery';
export function useExtensionAction(api: Api, enabled: boolean, changed: () => void, scopeKey = '') {
  const [revision, setRevision] = useState(0), operations = useOperations();
  const refresh = useCallback(() => { setRevision(v => v + 1); changed(); }, [changed]);
  const unresolved = operations.operations.some(op => ['pending', 'unknown'].includes(op.state));
  const flow = useWorkflow(api, '', enabled && !unresolved, refresh, scopeKey);
  return { ...flow, notice: unresolved ? '有操作结果待确认。请查询原回执；其他操作可关闭设置后在页面上方核对。' : flow.notice, revision, refresh };
}
export function ExtensionStatus({ api, action, recoveryLabel = '查询原扩展操作回执' }: { api: Api; action: ReturnType<typeof useExtensionAction>; recoveryLabel?: string }) {
  const operation = action.operation;
  const owner = useRef({ scope: action.scope, operationId: operation?.id }); owner.current = { scope: action.scope, operationId: operation?.id };
  const current = () => action.isCurrent() && owner.current.scope === action.scope && owner.current.operationId === operation?.id;
  const initial = { scope: action.scope, operationId: operation?.id, busy: false, error: '' }, [status, setStatus] = useState(initial);
  const { busy, error } = status.scope === action.scope && status.operationId === operation?.id ? status : initial;
  const update = (patch: Partial<typeof initial>) => { if (current()) setStatus(previous => ({ ...(previous.scope === action.scope && previous.operationId === operation?.id ? previous : initial), ...patch })); };
  return <>{(action.error || error) && <p className="error" role="alert">{action.error || error}</p>}{action.notice && <p role="status" className="small muted">{action.notice}</p>}{operation && ['pending', 'unknown'].includes(operation.state) && <div className="workspace-warning"><p>原请求结果待确认。查询只读取原回执，不会重复执行。</p><button className="button small" disabled={busy} onClick={async () => { update({ busy: true, error: '' }); try { const receipt = await api.call('operation/read', { operationId: operation.id }); if (receipt.operationId !== operation.id || receipt.state !== 'not_received' && receipt.method !== operation.method && !(receipt.method === 'operation/retire' && receipt.state === 'not_sent')) throw new Error('操作回执身份不匹配。'); reconcileOperation(operation.id, receipt); if (current() && ['accepted', 'not_sent'].includes(String(receipt.state))) action.refresh(); } catch (e) { update({ error: message(e) }); } finally { update({ busy: false }); } }}>{recoveryLabel}</button></div>}</>;
}
export function ReadState({ loading, error }: { loading: boolean; error: string }) { return <>{loading && <p className="muted" role="status">正在读取…</p>}{error && <p className="error" role="alert">{error}</p>}</>; }
