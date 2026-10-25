import { useEffect, useState } from 'react';
import type { Api } from '../lib/api';
import { object } from '../lib/types';
import { useResource } from '../hooks/useResource';
import { ExtensionStatus, ReadState, useExtensionAction } from './ExtensionControls';
const unchanged = () => {};
const notice = (status: unknown) => status === 'sent' ? '原生服务已确认向当前工作区所有者发送邮件。' : status === 'cooldown_active' ? '处于发送冷却期，本次没有再次发送邮件。' : '回执结果无法识别，请核对原操作记录。';
export function CreditNudge({ api, enabled, connected, epoch }: { api: Api; enabled: boolean; connected: boolean; epoch: string }) {
  const action = useExtensionAction(api, enabled && connected, unchanged);
  const preview = useResource(`${epoch}:${action.revision}:${connected}`, signal => api.call<{ previewHash: string; accountId: string | null }>('account/resetCredit/preview', {}, signal), connected);
  const [creditType, setCreditType] = useState('credits'), [confirmedHash, setConfirmedHash] = useState(''), [result, setResult] = useState('');
  const accepted = action.operation?.state === 'accepted' && action.operation.method === 'account/sendAddCreditsNudgeEmail' ? action.operation.id : '';
  useEffect(() => { setConfirmedHash(''); }, [epoch, connected]);
  useEffect(() => {
    if (!accepted || !connected) return; const controller = new AbortController();
    void api.call('operation/read', { operationId: accepted }, controller.signal).then(receipt => {
      if (!controller.signal.aborted && receipt.operationId === accepted && receipt.method === 'account/sendAddCreditsNudgeEmail' && receipt.state === 'accepted') setResult(notice(object(receipt.result).status));
    }, () => {}); return () => controller.abort();
  }, [accepted, api, connected]);
  return <details className="info-card"><summary>通知工作区所有者补充额度</summary><div className="stack"><p>这会由账号服务向当前工作区所有者发送一封邮件。收件人由账号服务确定；不会购买额度，也不会自动发送或重试。个人账号和不支持的工作区可能拒绝此请求。</p><ReadState {...preview}/>
    <label className="field">通知原因<select value={creditType} onChange={event => { setCreditType(event.target.value); setConfirmedHash(''); }}><option value="credits">需要补充额度</option><option value="usage_limit">需要提高使用上限</option></select></label>
    <label className="check-row"><input type="checkbox" checked={Boolean(confirmedHash && confirmedHash === preview.data?.previewHash)} onChange={event => setConfirmedHash(event.target.checked ? preview.data?.previewHash ?? '' : '')}/>确认向当前工作区所有者发送一次此通知邮件</label>
    <button className="button" disabled={action.disabled || !preview.data?.accountId || !confirmedHash || confirmedHash !== preview.data.previewHash} onClick={async () => { setConfirmedHash(''); setResult(''); const value = await action.run('account/sendAddCreditsNudgeEmail', { previewHash: preview.data!.previewHash, creditType, confirm: true }, '已收到通知邮件操作回执。'); if (value) setResult(notice(value.status)); }}>发送通知邮件</button><ExtensionStatus api={api} action={action} recoveryLabel="查询原通知邮件回执"/>{result && <p role="status">{result}</p>}
  </div></details>;
}
