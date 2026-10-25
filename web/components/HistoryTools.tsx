import { useEffect, useRef, useState } from 'react';
import type { Api } from '../lib/api';
import { usePaged } from '../hooks/usePaged';
import { useWorkflow } from '../hooks/useWorkflow';
import { textContent } from '../lib/history';
import { checkedExport, type ReviewTarget, type ThreadSearchOccurrence } from '../lib/workflows';
import { array, message, object, type Turn } from '../lib/types';
import { Dialog } from './Dialog';
import { Messages } from './Messages';
import { branchDraftKey, clearDraftSnapshot, draftChanged, emptyDraft, readDraft, writeDraft } from '../lib/drafts';

type Base = { api: Api; threadId: string; enabled: boolean; onClose: () => void; onChanged: () => void };
export function BranchDialog({ api, threadId, enabled, onClose, onChanged, turn, action: kind, onFork, memoryDraft, onDraft }: Base & { turn: Turn; action: 'fork' | 'edit' | 'revert'; onFork: (threadId: string, draft?: string) => boolean; memoryDraft?: string; onDraft: (text: string) => void }) {
  const [boundary, setBoundary] = useState<'before' | 'through'>(kind === 'edit' ? 'before' : 'through');
  const key = branchDraftKey(threadId, turn.id);
  const [initial] = useState(() => { const source = turn.items.filter(item => item.type === 'userMessage').map(textContent).join('\n'); try { const saved = readDraft(key); return { text: memoryDraft ?? (saved.text || source), error: '' }; } catch (e) { return { text: memoryDraft ?? source, error: `原分支草稿无法读取，未覆盖：${message(e)}` }; } });
  const [text, setText] = useState(initial.text), [handoffError, setHandoffError] = useState('');
  const [draftError, setDraftError] = useState(initial.error), [created, setCreated] = useState<string>();
  const [confirm, setConfirm] = useState(false), action = useWorkflow(api, threadId, enabled, onChanged);
  const frozen = action.busy || ['pending', 'unknown'].includes(action.operation?.state ?? '');
  const savedDraft = useRef<{ text: string; revision: string } | undefined>(undefined), running = useRef(false);
  const close = () => { if (!running.current) onClose(); };
  const recovered = action.operation?.method === 'thread/fork' && action.operation.state === 'accepted' ? action.operation.resolvedThreadId : undefined;
  useEffect(() => { if (recovered) setCreated(recovered); }, [recovered]);
  useEffect(() => { if (kind !== 'edit') return; onDraft(text); if (initial.error) return; try { const draft = { ...emptyDraft(key), text }; writeDraft(draft); savedDraft.current = { text, revision: draft.revision }; draftChanged(key); setDraftError(''); } catch (e) { setDraftError(`分支草稿尚未保存：${message(e)}`); } }, [text, key, kind, initial.error]);
  const finish = (id: string, snapshot: { text: string; revision: string } | undefined) => { if (!onFork(id, kind === 'edit' ? snapshot?.text ?? text : undefined)) { setHandoffError('新分支已经创建，但草稿暂无法保存。文字仍保留，可重试保存并打开已有分支。'); return; } if (kind === 'edit' && snapshot) { try { clearDraftSnapshot(key, snapshot.revision); } catch { /* A duplicate saved draft is safer than losing it. */ } } onClose(); };
  const submit = async () => {
    if (running.current || action.disabled || draftError || kind === 'revert' && !confirm || kind === 'edit' && !text.trim()) return;
    const snapshot = savedDraft.current;
    running.current = true;
    try {
      if (created) { finish(created, snapshot); return; }
      if (kind === 'revert') { if (await action.run('thread/revert', { threadId, beforeTurnId: turn.id }, '历史回退已受理，正在重新读取保留的会话。')) onClose(); return; }
      const result = await action.run('thread/fork', { threadId, ...(boundary === 'before' ? { beforeTurnId: turn.id } : { lastTurnId: turn.id }) }, '分支创建已受理。');
      if (!result) return;
      const id = object(result.thread).id;
      if (typeof id === 'string') { setCreated(id); finish(id, snapshot); }
    } finally { running.current = false; }
  };
  return <Dialog title={kind === 'revert' ? '回退会话历史' : kind === 'edit' ? '创建分支并编辑' : '从此处分支'} onClose={close}><form className="stack" onSubmit={e => { e.preventDefault(); void submit(); }}><p className="small muted">回合：{turn.id}</p><fieldset className="submission-fields stack" disabled={frozen}>{kind === 'revert' ? <><p>删除此回合及其之后的会话历史。文件、Git 状态和已经执行的操作不会恢复。</p><label className="check-row"><input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)}/>我确认仅回退会话历史，并已自行处理需要恢复的文件</label></> : <><p className="muted small">创建独立会话，保留原会话。继承的持续目标不会自动启动。</p>{kind === 'fork' && <fieldset className="stack"><legend>分支起点</legend><label className="check-row"><input type="radio" name="boundary" checked={boundary === 'through'} onChange={() => setBoundary('through')}/>包含此回合的结果</label><label className="check-row"><input type="radio" name="boundary" checked={boundary === 'before'} onChange={() => setBoundary('before')}/>从此回合之前继续</label></fieldset>}{kind === 'edit' && <><label className="field">新分支的消息草稿<textarea rows={7} value={text} maxLength={100000} onChange={e => setText(e.target.value)}/></label><p className="small muted">创建后会打开新分支并保存此草稿。完整历史同步后，可检查附件与设置并明确发送。</p></>}</>}</fieldset>{(action.error || draftError || handoffError) && <p className="error" role="alert">{action.error || draftError || handoffError}</p>}{created && <p className="small" role="status">分支已创建：{created}。保留草稿后打开，不会再次创建分支。</p>}{action.notice && <p className="small muted" role="status">{action.notice}</p>}<div className="inline"><button type="submit" className={`button ${kind === 'revert' ? 'danger' : 'primary'}`} disabled={action.disabled || Boolean(draftError) || kind === 'revert' && !confirm || kind === 'edit' && !text.trim()}>{action.busy ? '正在提交…' : created ? '保存草稿并打开已有分支' : kind === 'revert' ? '仅回退会话历史' : kind === 'edit' ? '创建分支并保存草稿' : '创建分支'}</button><button type="button" className="button" disabled={action.busy} onClick={close}>取消</button></div></form></Dialog>;
}
export function ReviewDialog({ api, threadId, projectId, enabled, inlineEnabled = enabled, initialTarget, initialSeparate = false, onClose, onChanged, onOpenThread }: Base & { projectId: string; inlineEnabled?: boolean; initialTarget?: ReviewTarget; initialSeparate?: boolean; onOpenThread: (id: string) => void }) {
  const [target, setTarget] = useState<ReviewTarget['type']>(initialTarget?.type ?? 'uncommittedChanges'), [branch, setBranch] = useState(initialTarget?.type === 'baseBranch' ? initialTarget.branch : ''), [commit, setCommit] = useState(initialTarget?.type === 'commit' ? initialTarget.sha : ''), [instructions, setInstructions] = useState(initialTarget?.type === 'custom' ? initialTarget.instructions : ''), [separate, setSeparate] = useState(initialSeparate || !threadId);
  const action = useWorkflow(api, threadId, separate ? enabled : inlineEnabled, onChanged);
  const frozen = action.busy || ['pending', 'unknown'].includes(action.operation?.state ?? '');
  const running = useRef(false), close = () => { if (!running.current) onClose(); };
  const recovered = action.operation?.method === 'review/startNew' && action.operation.state === 'accepted' ? action.operation.resolvedThreadId : undefined;
  const valid = target === 'uncommittedChanges' || (target === 'baseBranch' ? branch.trim() : target === 'commit' ? commit.trim() : instructions.trim());
  const submit = async () => {
    if (running.current || action.disabled || !valid || separate && !projectId) return;
    if (recovered) { onOpenThread(recovered); onClose(); return; }
    const value: ReviewTarget = target === 'baseBranch' ? { type: target, branch: branch.trim() } : target === 'commit' ? { type: target, sha: commit.trim(), title: null } : target === 'custom' ? { type: target, instructions: instructions.trim() } : { type: target };
    running.current = true;
    try {
      const result = await action.run(separate ? 'review/startNew' : 'review/start', { ...(separate ? { projectId } : { threadId, delivery: 'inline' }), target: value }, '审查任务已受理；结果会在会话中逐步显示。');
      if (result) { if (typeof result.reviewThreadId === 'string') onOpenThread(result.reviewThreadId); onClose(); }
    } finally { running.current = false; }
  };
  return <Dialog title="启动代码审查" onClose={close}><form className="stack" onSubmit={e => { e.preventDefault(); void submit(); }}><fieldset className="submission-fields stack" disabled={frozen}><label className="field">审查范围<select value={target} onChange={e => setTarget(e.target.value as ReviewTarget['type'])}><option value="uncommittedChanges">工作区尚未提交的修改</option><option value="baseBranch">与基准分支比较</option><option value="commit">指定提交</option><option value="custom">自定义审查要求</option></select></label>{target === 'baseBranch' && <label className="field">基准分支<input value={branch} onChange={e => setBranch(e.target.value)} placeholder="例如 main" required/></label>}{target === 'commit' && <label className="field">提交 SHA<input value={commit} onChange={e => setCommit(e.target.value)} placeholder="输入要审查的提交" required/></label>}{target === 'custom' && <label className="field">审查要求<textarea value={instructions} onChange={e => setInstructions(e.target.value)} maxLength={100000} rows={5} required/></label>}<label className="check-row"><input type="checkbox" checked={separate} disabled={!threadId} onChange={e => setSeparate(e.target.checked)}/>在项目的新会话中审查</label></fieldset><p className="small muted">提交会启动模型审查。操作受理后仍需等待实际审查结果。</p>{action.error && <p className="error" role="alert">{action.error}</p>}{action.notice && <p role="status" className="small muted">{action.notice}</p>}<button className="button primary" disabled={action.disabled || !valid || separate && !projectId}>{action.busy ? '正在提交…' : recovered ? '打开已受理的审查' : '开始审查'}</button></form></Dialog>;
}
export function HistoryTools({ api, threadId, epoch, turns, onClose, onLocate }: { api: Api; threadId: string; epoch: string; turns: Turn[]; onClose: () => void; onLocate: (turnId: string, itemId: string) => void }) {
  const [query, setQuery] = useState(''), [search, setSearch] = useState(''), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [windowTurns, setWindowTurns] = useState<Turn[]>(), [windowTarget, setWindowTarget] = useState<{ turnId: string; itemId: string }>();
  const mounted = useRef(true), generation = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => { const timer = setTimeout(() => { generation.current++; setSearch(query.trim()); setWindowTurns(undefined); setWindowTarget(undefined); setError(''); }, 250); return () => clearTimeout(timer); }, [query]);
  const key = `${epoch}:${threadId}:${search}`;
  const results = usePaged<ThreadSearchOccurrence>(api, 'thread/searchOccurrences', { threadId, searchTerm: search }, key, Boolean(search));
  const locate = async (hit: ThreadSearchOccurrence) => {
    if (turns.some(turn => turn.id === hit.turnId && turn.items.some(item => item.id === hit.itemId))) { onLocate(hit.turnId, hit.itemId); onClose(); return; }
    const gen = ++generation.current; setBusy('locate'); setError('');
    try {
      const value = await api.call('thread/history/window', { threadId, turnCursor: hit.turnCursor, limit: 10 });
      if (!mounted.current || generation.current !== gen) return;
      const view = array<Turn>(value.turns);
      if (value.partial !== true || value.complete !== false || !view.some(turn => turn.id === hit.turnId && turn.items.some(item => item.id === hit.itemId))) throw new Error('定位窗口未包含目标条目，请刷新搜索后重试。');
      setWindowTurns(view); setWindowTarget({ turnId: hit.turnId, itemId: hit.itemId });
    } catch (e) { if (mounted.current && generation.current === gen) setError(message(e)); }
    finally { if (mounted.current) setBusy(''); }
  };
  const download = async (format: 'json' | 'markdown') => {
    if (busy) return; setBusy(format); setError(''); setNotice('');
    try {
      const result = checkedExport(await api.call('thread/export', { threadId, format }), format);
      if (!mounted.current) return;
      const url = URL.createObjectURL(new Blob([result.content], { type: result.mimeType }));
      const link = document.createElement('a'); link.href = url; link.download = result.filename; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice('完整历史已读取并生成下载文件。');
    } catch (e) { if (mounted.current) setError(`导出未完成，未生成局部历史文件。${message(e)}`); }
    finally { if (mounted.current) setBusy(''); }
  };
  return <Dialog title="搜索与完整导出" wide onClose={onClose}><section className="stack"><div className="inline wrap"><button className="button" disabled={Boolean(busy)} onClick={() => void download('markdown')}>导出 Markdown</button><button className="button" disabled={Boolean(busy)} onClick={() => void download('json')}>导出 JSON</button></div><p className="small muted">导出由运行时读取完整、已落盘的会话，包含工具与附件信息；未完成或超出上限会明确报错。</p>{error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="muted small">{notice}</p>}{busy && <p role="status">{busy === 'locate' ? '正在读取定位窗口…' : '正在准备完整导出…'}</p>}<label className="field">搜索当前会话<input type="search" value={query} onChange={e => { generation.current++; setWindowTurns(undefined); setWindowTarget(undefined); setQuery(e.target.value); }} placeholder="用户消息或回答中的文字" maxLength={1000}/></label>{results.error && <p className="error" role="alert">{results.error}</p>}{results.loading && <p role="status">正在搜索…</p>}<ul className="search-hits">{results.items.map((hit, index) => <li key={`${hit.turnId}:${hit.itemId}:${index}`}><button className="search-hit" disabled={Boolean(busy) || results.snapshotKey !== key || query.trim() !== search} onClick={() => void locate(hit)}><span>{hit.snippet}</span><small>定位到对应回合 →</small></button></li>)}</ul>{search && !results.loading && !results.items.length && !results.error && <p className="muted">没有匹配消息。</p>}{results.hasMore && <button className="button" disabled={results.loading} onClick={() => void results.more()}>更多匹配结果</button>}{windowTurns && <section className="history-window"><p className="connection-banner">这是定位附近的只读片段，不是完整历史。完整导出仍从运行时单独读取。</p><Messages turns={windowTurns} loading={false} complete onMore={() => {}} focusTarget={windowTarget}/></section>}</section></Dialog>;
}
