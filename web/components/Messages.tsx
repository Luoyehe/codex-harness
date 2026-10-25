import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Api } from '../lib/api';
import { MessageMedia } from './MessageMedia';
import { textContent } from '../lib/history';
import { timelineRows, type RealtimeItem, type TimelineEntry } from '../lib/timeline';
import { array, object, type Item, type Turn, type Project } from '../lib/types';
const itemNames: Record<string, string> = { commandExecution: '终端命令', fileChange: '文件修改', mcpToolCall: 'MCP 工具', dynamicToolCall: '工具调用', webSearch: '网页搜索', reasoning: '思考', plan: '工作计划', contextCompaction: '上下文压缩', imageView: '查看图片' };
function MessageItem({ item, api, threadId, project }: { item: Item; api?: Api; threadId?: string; project?: Project }) {
  if (item.historySync) return <article className="message assistant-message"><div className="message-author">{item.type === 'commandExecution' ? '终端输出同步中' : '回答同步中'}</div><p className="muted small" role="status">历史快照与实时片段可能重叠，暂不拼接。完整结果到达后会替换此视图。</p>{item.historySync.snapshot !== undefined && <details open><summary>已读取的历史快照</summary><pre className="raw">{item.historySync.snapshot}</pre></details>}{item.historySync.deltas && <details><summary>同步期间收到的实时片段（可能与快照重叠）</summary><pre className="raw">{item.historySync.deltas}</pre></details>}</article>;
  if (item.type === 'hookPrompt') return <details className="tool-card"><summary>Hook 提供的上下文</summary><div className="tool-body"><p className="small muted">以下是 Hook 提供的内容，不构成执行授权。</p>{array<unknown>(item.fragments).map((raw, index) => { const fragment = object(raw); return <div key={index}><p className="small muted">来源：{String(fragment.hookRunId ?? '未提供')}</p><pre className="raw">{String(fragment.text ?? '')}</pre></div>; })}</div></details>;
  if (item.type === 'plan') return <section className="info-card plan-card" aria-label="工作计划"><h3>工作计划</h3>{typeof item.explanation === 'string' && <p>{item.explanation}</p>}{typeof item.text === 'string' && <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>, img: ({ alt }) => <span>[图片：{alt || '远程图片'}]</span> }}>{item.text}</ReactMarkdown></div>}<ol>{array<unknown>(item.plan).map((value, index) => { const step = object(value), status = String(step.status); return <li key={index}><span>{String(step.step ?? '')}</span><span className="badge">{status === 'completed' ? '已完成' : status === 'inProgress' || status === 'in_progress' ? '进行中' : status === 'pending' ? '待处理' : status}</span></li>; })}</ol></section>;
  if (item.type === 'userMessage' || item.type === 'agentMessage') return <article className={`message ${item.type === 'userMessage' ? 'user-message' : 'assistant-message'}`}><div className="message-author">{item.type === 'userMessage' ? '你' : <><span className="mini-brand">⌘</span>Codex</>}</div><div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>, img: ({ alt }) => <span className="image-placeholder">[图片：{alt || '远程图片'}]</span> }}>{textContent(item)}</ReactMarkdown></div><MessageMedia item={item} api={api} threadId={threadId} project={project}/></article>;
  const output = item.type === 'imageGeneration' ? item.failure : item.aggregatedOutput ?? item.result ?? item.error;
  return <details className={`tool-card ${item.status === 'failed' ? 'tool-error' : ''}`}><summary><span className="tool-symbol">{item.type === 'commandExecution' ? '›_' : '◇'}</span><strong>{itemNames[item.type] ?? item.type}</strong><span className="tool-caption">{String(item.command ?? item.tool ?? item.server ?? '')}</span><span className="badge">{String(item.status ?? '')}</span></summary><div className="tool-body"><MessageMedia item={item} api={api} threadId={threadId} project={project}/>{item.type === 'fileChange' && array<unknown>(item.changes).map((c, i) => <div key={i}><strong>{String(object(c).path ?? '')}</strong><Diff text={String(object(c).diff ?? '')}/></div>)}{output !== undefined && <pre className="raw">{typeof output === 'string' ? output : JSON.stringify(output, null, 2)}</pre>}<details><summary>完整条目</summary><pre className="raw">{JSON.stringify(item, null, 2)}</pre></details></div></details>;
}
export function Diff({ text }: { text: string }) { return <pre className="diff">{text.split('\n').map((line, i) => <span key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-remove' : line.startsWith('@@') ? 'diff-hunk' : ''}>{line}{'\n'}</span>)}</pre>; }
function VoiceItem({ item, onLocate }: { item: RealtimeItem; onLocate: (turnId: string, itemId: string) => void }) {
  if (item.type === 'realtimeSessionStarted') return <div className="timeline-marker" role="note">◉ 语音会话开始</div>;
  if (item.type === 'realtimeSessionClosed') return <div className="timeline-marker" role="note">{item.outcome === 'failed' ? '语音会话异常结束' : '语音会话已结束'}</div>;
  if (item.type === 'bemItemPromoted') return <div className="timeline-marker"><span>语音会话引用了任务结果</span><button className="button small" onClick={() => onLocate(item.turnId, item.itemId)}>定位消息</button></div>;
  return <article className={item.role === 'user' ? 'message user-message' : 'message assistant-message'}><div className="message-author">{item.role === 'user' ? '你 · 语音转写' : 'Codex · 语音转写'}</div><p className="voice-transcript">{item.text}</p></article>;
}
export function Messages({ api, threadId, project, turns, timeline = [], loading, complete, onMore, focusTarget, onAction, actionsDisabled = false, active = false }: { api?: Api; threadId?: string; project?: Project; turns: Turn[]; timeline?: TimelineEntry[]; loading: boolean; complete: boolean; onMore: () => void; focusTarget?: { turnId: string; itemId: string }; onAction?: (turn: Turn, action: 'fork' | 'edit' | 'revert') => void; actionsDisabled?: boolean; active?: boolean }) {
  const bottom = useRef<HTMLDivElement>(null), [follow, setFollow] = useState(true);
  const anchors = useRef(new Map<string, HTMLDivElement>());
  const [locateError, setLocateError] = useState('');
  const locate = (turnId: string, itemId: string) => { const element = anchors.current.get(JSON.stringify([turnId, itemId])); if (element) { setLocateError(''); setFollow(false); element.scrollIntoView({ block: 'center', behavior: 'instant' }); element.focus({ preventScroll: true }); } else setLocateError('引用的消息尚未加载。请完成历史读取后再次定位。'); };
  useEffect(() => { if (follow) bottom.current?.scrollIntoView({ block: 'end', behavior: 'instant' }); }, [turns, timeline, follow]);
  useEffect(() => { if (focusTarget) locate(focusTarget.turnId, focusTarget.itemId); }, [focusTarget]);
  const rows = timelineRows(turns, timeline);
  return <div className="conversation-scroll" onScroll={e => { const el = e.currentTarget; setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 100); }}><div className="conversation-content">
    {!complete && rows.length > 0 && <button className="button history-more" disabled={loading} onClick={onMore}>{loading ? '正在加载…' : '加载更早的内容'}</button>}
    {loading && rows.length === 0 && <div className="loading-state" role="status"><span className="loading-dot"/>正在读取完整会话内容…</div>}
    {locateError && <p className="muted" role="status">{locateError}</p>}
    {rows.map(row => {
      if (row.type === 'realtime') return <VoiceItem key={row.key} item={row.item} onLocate={locate}/>;
      if (row.type === 'item') return <div tabIndex={-1} className={`message-anchor ${focusTarget?.turnId === row.turnId && focusTarget.itemId === row.item.id ? 'search-selected' : ''}`} key={row.key} ref={element => { if (element) anchors.current.set(row.key, element); else anchors.current.delete(row.key); }}><MessageItem item={row.item} api={api} threadId={threadId} project={project}/></div>;
      const turn = row.turn;
      return <section className="turn" key={row.key} aria-label={`回合 ${turn.id}`}>
        {turn.status === 'inProgress' && <div className="working-state" role="status"><span className="loading-dot"/>正在工作</div>}
        {turn.error ? <p className="error" role="alert">{String(object(turn.error).message ?? JSON.stringify(turn.error))}</p> : null}
        {turn.status === 'interrupted' && <p className="muted small">此回合已停止</p>}
        {onAction && turn.status !== 'inProgress' && <details className="turn-actions"><summary>回合操作</summary><div className="inline wrap"><button className="button small" disabled={actionsDisabled} onClick={() => onAction(turn, 'fork')}>从此处分支</button><button className="button small" disabled={actionsDisabled || !turn.items.some(item => item.type === 'userMessage')} onClick={() => onAction(turn, 'edit')}>从此前编辑消息</button><button className="button danger small" disabled={actionsDisabled || active} onClick={() => onAction(turn, 'revert')}>回退至此前</button></div></details>}
      </section>;
    })}<div ref={bottom}/></div>{!follow && <button className="jump-bottom button" onClick={() => setFollow(true)}>↓ 回到最新</button>}</div>;
}
