import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Api, RpcError } from '../lib/api';
import { acknowledgeOperation, listOperations, reconcileOperation } from '../lib/operations';
import { closeEmergencyOperations } from '../lib/emergency-recovery';
import { message, object } from '../lib/types';
import { Dialog } from './Dialog';

/** Recovery is independent of the native runtime's activity gate. Never replay it. */
export function EmergencyRecovery({ api, onClose }: { api: Api; onClose: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [operationId, setOperationId] = useState(''), [completed, setCompleted] = useState(false);
  const [locallyNotSent, setLocallyNotSent] = useState(false);
  const mounted = useRef(true), running = useRef(false), selectedId = useRef('');
  const closure = useRef<AbortController | undefined>(undefined);
  const owner = useRef(api); owner.current = api;
  const expectedCsrf = api.csrf;
  const current = () => mounted.current && owner.current === api && Boolean(expectedCsrf) && api.csrf === expectedCsrf && !api.externalAuthenticationRequired;
  const select = (id: string, notSent = false) => { selectedId.current = id; setOperationId(id); setLocallyNotSent(notSent); };
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; closure.current?.abort(); };
  }, [api]);
  useEffect(() => {
    let disposed = false;
    void listOperations().then(rows => {
      if (!disposed && current() && !running.current && !selectedId.current) {
        const prior = rows.find(row => row.method === 'system/recover');
        select(prior?.id ?? '', prior?.state === 'not_sent');
      }
    }).catch(e => { if (!disposed && current()) setError(message(e)); });
    return () => { disposed = true; };
  }, [api]);
  const accepted = async (id: string, value: unknown) => {
    const result = object(value);
    if (Object.keys(result).length !== 2 || result.restarted !== true || typeof result.release !== 'string' || !/^[a-f0-9]{64}$/.test(result.release))
      throw new Error('恢复结果尚未完整确认，请查询原恢复回执；不会自动重新提交。');
    const record = (await listOperations()).find(row => row.id === id && row.method === 'system/recover');
    if (!current()) return;
    setNotice('后台已确认停止并重新启动。正在核对旧操作记录，不会自动重发。');
    let retained = record?.recoveryOperations === undefined;
    if (record?.recoveryOperations) {
      const controller = new AbortController(); closure.current = controller;
      const closed = await closeEmergencyOperations(api, record.recoveryOperations, id,
        { operationId: id, method: 'system/recover', state: 'accepted', result }, controller.signal);
      if (!current()) return;
      retained = closed.retainedIds.length > 0;
    }
    if (!current()) return;
    await acknowledgeOperation(id);
    if (!current()) return;
    setCompleted(true);
    setNotice(retained
      ? '后台已确认停止并重新启动。部分旧操作仍需在操作记录中核对；草稿保留，不会自动重发。'
      : '后台已确认停止并重新启动，旧执行阻塞已解除。草稿和服务器回执保留，不会自动重发。');
  };
  const start = async () => {
    if (!current() || running.current || selectedId.current || completed) return;
    running.current = true; setBusy(true); setError('');
    try {
      const prior = (await listOperations()).find(row => row.method === 'system/recover');
      if (!current()) return;
      if (prior) { select(prior.id, prior.state === 'not_sent'); setNotice('已有恢复记录，请先核对并关闭原记录。'); return; }
      const request = api.beginMutation('system/recover', { confirmStop: true }, () => {
        if (!current()) throw new Error('恢复确认窗口已关闭或登录已变化，尚未发送请求。');
      });
      select(request.operationId);
      const result = await request.result;
      if (current()) await accepted(request.operationId, result);
    } catch (e) {
      if (current()) {
        setError(message(e));
        if (e instanceof RpcError && e.delivery === 'not_sent') {
          try {
            if (selectedId.current) await acknowledgeOperation(selectedId.current);
            if (current()) select('');
          } catch (storageError) {
            if (current()) setError(`请求确认未发送，但本地记录尚未关闭：${message(storageError)}。请查询原恢复回执。`);
          }
        } else
          setNotice('连接可能因恢复操作断开。请查询原恢复回执，不要重复提交；未收到回复不代表操作未执行。');
      }
    } finally { running.current = false; if (mounted.current) setBusy(false); }
  };
  const check = async () => {
    if (!current() || running.current || !operationId) return;
    running.current = true; setBusy(true); setError('');
    try {
      const local = (await listOperations()).find(row => row.id === operationId && row.method === 'system/recover');
      if (!current()) return;
      // A failed pre-dispatch admission is a known not-sent fact even when the
      // server correctly has no receipt. Close that local fact without sending.
      if (local?.state === 'not_sent') {
        await acknowledgeOperation(operationId);
        if (current()) { select(''); setNotice('原恢复请求确认未发送，已关闭本地记录；可重新确认强制停止。'); }
        return;
      }
      const receipt = await api.call('operation/read', { operationId });
      if (!current()) return;
      if (receipt.operationId !== operationId || receipt.state !== 'not_received' && receipt.method !== 'system/recover')
        throw new Error('恢复回执身份不匹配，请在操作记录中核对。');
      await reconcileOperation(operationId, receipt);
      if (!current()) return;
      if (receipt.state === 'accepted') await accepted(operationId, receipt.result);
      else if (receipt.state === 'not_sent') {
        await acknowledgeOperation(operationId);
        if (current()) { select(''); setNotice('原恢复请求确认未发送。检查提示后，可重新确认强制停止。'); }
      }
      else setNotice('恢复结果尚未确认。请检查服务状态并查询原回执；不会自动重发请求。');
    } catch (e) { if (current()) setError(message(e)); }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  };
  return <Dialog title="强制停止并恢复" onClose={onClose}>
    <div className="stack">
      <p>终止本实例所有正在运行或状态未知的 Agent 任务、终端和 MCP 操作，然后重新启动后台，解除旧执行状态造成的阻塞。</p>
      <p>已写入的文件和外部服务中的操作不会撤销；草稿、项目和未知回执会保留。不会重新发送消息或重复授权。正在进行的服务器配置事务仍需先完成或通过运维脚本恢复。</p>
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="inline wrap">
        <button className="button" onClick={onClose}>{completed ? '关闭' : '取消'}</button>
        {operationId && !completed
          ? <button className="button" disabled={busy || !current()} onClick={() => void check()}>{locallyNotSent ? '关闭未发送记录' : '查询原恢复回执'}</button>
          : !completed && <button className="button danger" disabled={busy || !current()} onClick={() => void start()}>{busy ? '正在提交恢复…' : '确认强制停止并恢复'}</button>}
      </div>
    </div>
  </Dialog>;
}
