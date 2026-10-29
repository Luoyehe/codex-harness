import { useEffect, useRef, useState } from 'react';
import { Api, RpcError } from '../lib/api';
import { Events } from '../lib/events';
import { acknowledgeOperation, isArchivedReceipt, reconcileOperation } from '../lib/operations';
import { changedMcpSession, currentMcpSession, type McpOauthAttempt, type McpSession } from '../lib/mcp-session';
import { message, object, safeUrl } from '../lib/types';
import { useOperations } from './Recovery';

/** Only identities live in the session cache. URLs belong to this mounted owner. */
export function McpAuthorization({ api, events, session, epoch, name, threadId, connected, visible = true }: {
  api: Api; events: Events; session: McpSession; epoch: string; name: string; threadId: string | null; connected: boolean; visible?: boolean;
}) {
  const [, render] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [link, setLink] = useState<{ url: string; expiresAt: number }>();
  const mounted = useRef(true), online = useRef(connected), running = useRef(false), revision = useRef(0);
  const shown = useRef(visible);
  if (shown.current !== visible) { shown.current = visible; revision.current++; }
  const completions = useRef(new Map<string, { success: boolean; restartRequired: boolean }>());
  online.current = connected;
  const operations = useOperations(), record = session.oauth.find(item => item.name === name && item.threadId === threadId);
  const current = () => mounted.current && online.current && currentMcpSession(api, session) && !api.externalAuthenticationRequired;
  const clear = () => { revision.current++; setLink(undefined); };
  const changed = () => changedMcpSession(session);
  const complete = (attempt: McpOauthAttempt, success: boolean) => {
    clear(); attempt.status = success ? 'completed' : 'failed'; changed();
    setNotice(success ? '原生服务已确认授权完成，请刷新服务状态。' : '原生服务报告授权失败，请核对服务状态。');
  };
  const read = async (attempt: McpOauthAttempt) => {
    if (!current() || !shown.current || !attempt.identity) return;
    clear(); const version = revision.current, identity = attempt.identity;
    try {
      const result = await api.call('mcp/oauth/handoff', { handoffId: identity.handoffId, epoch: identity.epoch });
      if (!current() || !shown.current || version !== revision.current || attempt.identity !== identity) return;
      if (result.handoffId !== identity.handoffId || result.epoch !== epoch || result.name !== name || result.threadId !== threadId || !['pending', 'completed', 'failed'].includes(String(result.status)))
        throw new Error('MCP 授权交接身份或状态不匹配。');
      attempt.restartRequired = result.restartRequired === true;
      if (result.status !== 'pending') { complete(attempt, result.status === 'completed'); return; }
      attempt.status = 'pending'; changed();
      if (result.unavailable === true) {
        setNotice('原授权交接已撤销或过期。先核对服务状态；仍未确认时请明确重启服务，不能重复发起授权。'); return;
      }
      const url = safeUrl(result.authorizationUrl);
      if (!url || new URL(url).username || new URL(url).password || url.length > 8192 || !Number.isSafeInteger(result.expiresAt) || Number(result.expiresAt) <= Date.now())
        throw new Error('MCP 授权网址无效或已过期，请核对原授权状态。');
      setLink({ url, expiresAt: Number(result.expiresAt) }); setNotice('等待原生服务确认授权结果。');
    } catch (e) {
      if (!current() || version !== revision.current) return;
      clear(); attempt.restartRequired = true; changed();
      setError(e instanceof RpcError && e.code === 'not_found' ? '此连接的授权交接不可用。请核对原授权回执与服务状态，必要时明确重启服务。' : message(e));
    }
  };
  const accept = async (attempt: McpOauthAttempt, value: Record<string, unknown>, readHandoff: boolean) => {
    attempt.state = 'accepted'; changed();
    if (typeof value.handoffId !== 'string' || !value.handoffId || value.handoffId.length > 256 || value.epoch !== epoch || value.name !== name || value.threadId !== threadId) {
      attempt.restartRequired = true; changed();
      setError('原授权已受理，但交接身份不可恢复（可能是旧回执）。请核对服务状态，必要时明确重启服务；不会重新提交授权。'); return;
    }
    attempt.identity = { handoffId: value.handoffId, epoch, name, threadId };
    const completed = completions.current.get(value.handoffId);
    if (completed !== undefined) { attempt.restartRequired = completed.restartRequired; complete(attempt, completed.success); }
    else if (readHandoff) await read(attempt);
  };
  const start = async () => {
    if (!current() || !shown.current || running.current || operations.error || operations.operations.some(item => ['pending', 'unknown'].includes(item.state)) || record && (['pending', 'unknown'].includes(record.state) || record.restartRequired || record.state === 'accepted' && (!record.status || record.status === 'pending'))) return;
    if (!record && session.oauth.length >= 32) {
      const index = session.oauth.findIndex(item => item.state === 'not_sent' || item.state === 'accepted' && item.status && item.status !== 'pending' && !item.restartRequired);
      if (index < 0) { setError('当前连接已保留 32 笔授权身份，请完成原授权或明确重启服务。'); return; }
      session.oauth.splice(index, 1);
    }
    running.current = true; setBusy(true); clear(); setError(''); setNotice('');
    const visit = revision.current;
    let attempt: McpOauthAttempt | undefined;
    try {
      const request = api.beginMutation('mcp/oauth', { name, ...(threadId ? { threadId } : {}) });
      attempt = { name, threadId, operationId: request.operationId, state: 'pending' };
      if (record) session.oauth.splice(session.oauth.indexOf(record), 1, attempt); else session.oauth.push(attempt);
      changed(); const result = await request.result;
      if (current()) await accept(attempt, result, shown.current && visit === revision.current);
    } catch (e) {
      if (attempt && current()) { attempt.state = e instanceof RpcError && e.delivery === 'not_sent' ? 'not_sent' : 'unknown'; changed(); }
      if (current()) setError(message(e));
    } finally { running.current = false; if (current()) setBusy(false); }
  };
  const recover = async () => {
    if (!record?.operationId || !current() || !shown.current || running.current) return;
    running.current = true; setBusy(true); setError('');
    const visit = revision.current;
    try {
      const receipt = await api.call('operation/read', { operationId: record.operationId });
      if (!current()) return;
      if (receipt.operationId !== record.operationId || (receipt.state !== 'not_received' && receipt.method !== 'mcp/oauth' && !(receipt.method === 'operation/retire' && receipt.state === 'not_sent') && !isArchivedReceipt(receipt))) throw new Error('MCP 授权回执身份不匹配。');
      await reconcileOperation(record.operationId, receipt);
      if (!current()) return;
      if (receipt.state === 'accepted') { await accept(record, object(receipt.result), shown.current && visit === revision.current); await acknowledgeOperation(record.operationId); }
      else if (receipt.state === 'not_sent') { record.state = 'not_sent'; changed(); setNotice('原授权确认未发送，重新授权需要你再次操作。'); }
      else setNotice('原授权结果仍待确认。请继续查询或明确重启服务；不会重复发起授权。');
    } catch (e) { if (current()) setError(message(e)); }
    finally { running.current = false; if (current()) setBusy(false); }
  };
  useEffect(() => {
    mounted.current = true; const notify = () => render(value => value + 1); session.listeners.add(notify);
    return () => { mounted.current = false; revision.current++; session.listeners.delete(notify); };
  }, [session]);
  useEffect(() => { if (!connected) { clear(); setBusy(false); } }, [connected]);
  useEffect(() => { if (!visible) clear(); }, [visible]);
  useEffect(() => api.onAuthenticationLost(() => clear()), [api]);
  useEffect(() => events.subscribe(event => {
    if (!current() || event.type !== 'mcp' || event.data.type !== 'oauth-completed' || event.data.owned !== true) return;
    const params = event.data;
    if (params.epoch !== epoch || params.name !== name || params.threadId !== threadId || typeof params.handoffId !== 'string' || typeof params.success !== 'boolean') return;
    if (completions.current.size < 32) completions.current.set(params.handoffId, { success: params.success, restartRequired: params.restartRequired === true });
    const attempt = session.oauth.find(item => item.name === name && item.threadId === threadId);
    if (attempt?.identity?.handoffId === params.handoffId) { attempt.restartRequired = params.restartRequired === true; complete(attempt, params.success); }
  }), [api, events, session, epoch, name, threadId]);
  useEffect(() => {
    if (!link) return;
    const timer = setTimeout(() => { clear(); setNotice('原授权交接已过期。请读取原交接并核对服务状态，不能自动重新授权。'); }, Math.max(0, link.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [link]);
  const blocked = Boolean(record && (['pending', 'unknown'].includes(record.state) || record.restartRequired || record.state === 'accepted' && (!record.status || record.status === 'pending')));
  return <>
    <button className="button small" disabled={!visible || !connected || busy || blocked || Boolean(operations.error) || operations.operations.some(item => ['pending', 'unknown'].includes(item.state))} onClick={() => void start()}>请求此服务授权</button>
    {record?.operationId && <button className="button small" disabled={!visible || !connected || busy} onClick={() => void recover()}>查询原 MCP 授权回执</button>}
    {record?.identity && <button className="button small" disabled={!visible || !connected || busy} onClick={() => void read(record)}>读取原授权交接</button>}
    {visible && connected && link && <a className="button" href={link.url} target="_blank" rel="noreferrer">打开 MCP 授权页面 ↗</a>}
    {notice && <p role="status" className="muted">{notice}</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </>;
}
