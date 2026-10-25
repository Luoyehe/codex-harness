import { useCallback, useEffect, useState } from 'react';
import type { GuardianApprovalReviewAction } from '../../protocol/ts/v2/GuardianApprovalReviewAction';
import type { GuardianApprovalReview } from '../../protocol/ts/v2/GuardianApprovalReview';
import type { Api } from '../lib/api';
import type { Events } from '../lib/events';
import { object } from '../lib/types';
import { useResource } from '../hooks/useResource';
import { Dialog } from './Dialog';
import { ExtensionStatus, ReadState, useExtensionAction } from './ExtensionControls';

type Denial = { approvalId: string; threadId: string; turnId: string; reviewId: string; targetItemId: string; review: GuardianApprovalReview; action: GuardianApprovalReviewAction; createdAt: number; expiresAt: number; state: 'available' | 'pending' | 'registered' | 'unknown' };
function checked(value: Record<string, unknown>, threadId: string): { data: Denial[]; captureExhausted: boolean } {
  if (!Array.isArray(value.data) || value.data.length > 10 || typeof value.captureExhausted !== 'boolean') throw new Error('Guardian 审查目录无效。');
  const seen = new Set<string>();
  for (const valueRow of value.data) {
    const row = object(valueRow), review = object(row.review), action = object(row.action);
    if (row.threadId !== threadId || ['approvalId', 'turnId', 'reviewId', 'targetItemId'].some(field => typeof row[field] !== 'string' || !row[field]) || seen.has(String(row.approvalId)) || review.status !== 'denied' || review.riskLevel !== null && !['low', 'medium', 'high', 'critical'].includes(String(review.riskLevel)) || review.userAuthorization !== null && !['unknown', 'low', 'medium', 'high'].includes(String(review.userAuthorization)) || review.rationale !== null && typeof review.rationale !== 'string' || !['available', 'pending', 'registered', 'unknown'].includes(String(row.state)) || !Number.isSafeInteger(row.createdAt) || !Number.isSafeInteger(row.expiresAt) || Number(row.expiresAt) <= Number(row.createdAt) || JSON.stringify(row).length > 100000) throw new Error('Guardian 拒绝记录身份或状态无效。');
    const fields: Record<string, string[]> = { command: ['command', 'cwd', 'source'], execve: ['program', 'cwd', 'source'], writeStdin: ['approvalId', 'processId', 'stdin', 'cwd'], applyPatch: ['cwd'], networkAccess: ['target', 'host', 'protocol'], mcpToolCall: ['server', 'toolName'], requestPermissions: [] };
    if (!Object.hasOwn(fields, String(action.type)) || fields[String(action.type)]!.some(field => typeof action[field] !== 'string') || action.type === 'execve' && (!Array.isArray(action.argv) || action.argv.some(v => typeof v !== 'string')) || action.type === 'applyPatch' && (!Array.isArray(action.files) || action.files.some(v => typeof v !== 'string')) || action.type === 'networkAccess' && !Number.isSafeInteger(action.port) || action.type === 'mcpToolCall' && ['connectorId', 'connectorName', 'toolTitle'].some(field => action[field] !== null && typeof action[field] !== 'string') || action.type === 'requestPermissions' && action.reason !== null && typeof action.reason !== 'string' || action.type === 'requestPermissions' && (!action.permissions || typeof action.permissions !== 'object' || Array.isArray(action.permissions))) throw new Error('Guardian 操作类型或内容无效，不能批准。');
    seen.add(String(row.approvalId));
  }
  return value as { data: Denial[]; captureExhausted: boolean };
}
function ActionDetails({ action }: { action: GuardianApprovalReviewAction }) {
  switch (action.type) {
    case 'command': return <><p className="small path">工作目录：{action.cwd} · 来源：{action.source}</p><pre className="raw">{action.command}</pre></>;
    case 'execve': return <><p className="small path">工作目录：{action.cwd} · 来源：{action.source}</p><p>程序：<code>{action.program}</code></p><p className="small muted">参数按原始顺序展示，不拼接成 shell 命令：</p><ol>{action.argv.map((arg, index) => <li key={index}><code className="path">{JSON.stringify(arg)}</code></li>)}</ol></>;
    case 'writeStdin': return <><p className="small path">进程：{action.processId} · 原审批：{action.approvalId}<br/>工作目录：{action.cwd}</p><p>将写入的输入：</p><pre className="raw">{action.stdin}</pre></>;
    case 'applyPatch': return <><p className="small path">工作目录：{action.cwd}</p><p>受影响的文件：</p><ul>{action.files.map((file, index) => <li className="path" key={index}>{file}</li>)}</ul><p className="small muted">原生审查记录只提供路径；补丁正文请在关联历史条目中核对。</p></>;
    case 'networkAccess': return <dl className="execution-snapshot"><dt>目标</dt><dd>{action.target}</dd><dt>主机 / 端口</dt><dd>{action.host}:{action.port}</dd><dt>协议</dt><dd>{action.protocol}</dd></dl>;
    case 'mcpToolCall': return <><p>{action.toolTitle ?? action.toolName}</p><dl className="execution-snapshot"><dt>服务器 / 工具</dt><dd>{action.server} / {action.toolName}</dd><dt>连接器</dt><dd>{action.connectorName ?? '未提供'} / {action.connectorId ?? '未提供'}</dd></dl><p className="small muted">这份原生审查记录未包含工具参数；请同时核对关联历史条目。</p></>;
    case 'requestPermissions': return <><p>{action.reason ?? '未提供额外权限理由'}</p><p>请求的网络与文件权限：</p><pre className="raw">{JSON.stringify(action.permissions, null, 2)}</pre></>;
  }
}
const actionNames: Record<GuardianApprovalReviewAction['type'], string> = { command: '命令', execve: '启动程序', writeStdin: '写入进程输入', applyPatch: '应用补丁', networkAccess: '网络访问', mcpToolCall: 'MCP 工具调用', requestPermissions: '额外权限' };
function DenialCard({ row, disabled, now, onApprove, onLocate }: { row: Denial; disabled: boolean; now: number; onApprove: () => void; onLocate: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const available = row.state === 'available' && row.expiresAt > now;
  return <article className="info-card stack"><div className="section-heading"><h3>{actionNames[row.action.type]}</h3><span className="badge">Guardian 已拒绝</span></div><p className="small">风险等级：{row.review.riskLevel ?? '未提供'} · 已有用户授权：{row.review.userAuthorization ?? '未提供'}</p><p className="queue-text">{row.review.rationale ?? '原生审查未提供拒绝理由。'}</p><ActionDetails action={row.action}/><button className="button small" onClick={onLocate}>查看关联历史条目</button><details><summary>原始操作记录与审查标识</summary><p className="small path">回合：{row.turnId}<br/>条目：{row.targetItemId}<br/>审查：{row.reviewId}<br/>授权记录：{row.approvalId}</p><pre className="raw">{JSON.stringify(row.action, null, 2)}</pre></details><p className="small muted">{row.expiresAt <= now ? '授权记录已过期，请重新读取。' : `有效至 ${new Date(row.expiresAt).toLocaleString()}`} · 状态：{({ available: '可申请一次重试', pending: '正在登记', registered: '已登记一次重试', unknown: '登记结果待确认' })[row.state]}</p>{row.state === 'unknown' && <p className="workspace-warning">请查询原操作回执，不能重新登记；记录状态不等于操作执行结果。</p>}<label className="checkbox"><input type="checkbox" disabled={disabled || !available} checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>我已核对以上具体操作，批准它的一次重试；仍由原生服务审查</label><button className="button" disabled={disabled || !available || !confirmed} onClick={() => { setConfirmed(false); onApprove(); }}>批准此操作的一次重试</button></article>;
}
export function GuardianReviewPanel({ api, events, epoch, threadId, enabled, idle, onChanged, onLocate, onClose }: { api: Api; events: Events; epoch: string; threadId: string; enabled: boolean; idle: boolean; onChanged: () => void; onLocate: (turnId: string, itemId: string) => void; onClose: () => void }) {
  const [revision, setRevision] = useState(0), [now, setNow] = useState(Date.now), [notice, setNotice] = useState('');
  const refresh = useCallback(() => setRevision(v => v + 1), []);
  const changed = useCallback(() => { refresh(); onChanged(); }, [refresh, onChanged]);
  const action = useExtensionAction(api, enabled && idle, changed);
  const resource = useResource(`${epoch}:${threadId}:${revision}`, async signal => checked(await api.call('thread/guardian/list', { threadId }, signal), threadId));
  useEffect(() => events.subscribe(event => {
    if (event.type === 'notification' && object(event.data.params).threadId === threadId && ['item/autoApprovalReview/completed', 'turn/started', 'thread/settings/updated', 'thread/reverted', 'thread/closed', 'thread/archived'].includes(String(event.data.method))) refresh();
  }), [events, threadId, refresh]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => { const at = Date.now(); setNow(at); const next = Math.min(...(resource.data?.data ?? []).map(row => row.expiresAt).filter(expiry => expiry > at)); if (Number.isFinite(next)) timer = setTimeout(tick, Math.min(600001, Math.max(1, next - at + 1))); };
    tick(); return () => clearTimeout(timer);
  }, [resource.data]);
  const approve = async (row: Denial) => {
    if (row.expiresAt <= Date.now() || row.state !== 'available' || resource.loading || resource.error || !resource.data?.data.includes(row)) return;
    setNotice(''); const result = await action.run('thread/approveGuardianDeniedAction', { threadId, approvalId: row.approvalId, confirm: true }, '一次重试授权已受理。正在重新读取完整历史；尚未执行该操作。');
    if (result !== undefined) setNotice('已受理一次重试授权，不会自动启动任务。请核对更新后的完整历史，再明确发送继续指令。');
  };
  return <Dialog title="Guardian 拒绝与一次重试" wide onClose={onClose}><div className="stack"><p>这里只显示本次原生服务捕获的拒绝记录。授权将精确操作标记加入当前会话，不启动回合，也不保证重试成功。新回合、上下文变更、过期或服务重启会使记录失效。</p>{(!enabled || !idle) && <p className="connection-banner">登记授权需要会话已加载、完整历史已读取且当前会话空闲。你仍可查看审查详情。</p>}<button className="button small" disabled={resource.loading} onClick={refresh}>重新读取拒绝记录</button><ReadState {...resource}/><ExtensionStatus api={api} action={action} recoveryLabel="查询原一次重试授权回执"/>{notice && <p role="status">{notice}</p>}{resource.data?.captureExhausted && <p className="workspace-warning">本次服务的拒绝捕获已达到上限或遇到不一致，可能没有展示全部记录；不能据此认定没有被拒绝的操作。</p>}{resource.data?.data.map(row => <DenialCard key={JSON.stringify(row)} row={row} now={now} disabled={action.disabled || resource.loading || Boolean(resource.error)} onApprove={() => void approve(row)} onLocate={() => onLocate(row.turnId, row.targetItemId)}/>)}{resource.data && !resource.data.data.length && <p className="muted">当前没有可展示的捕获记录。已有历史中的拒绝不一定仍可授权重试。</p>}</div></Dialog>;
}
