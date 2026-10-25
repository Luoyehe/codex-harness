import { useEffect, useRef, useState } from 'react';
import { Api, RpcError } from '../lib/api';
import { reconcileOperation } from '../lib/operations';
import { discardFileDraft, editFileDraft, fileDraftKey, fileDraftProblem, newFileDraft, persistFileDraft, readFileDraft, type FileDraft } from '../lib/file-drafts';
import { checkedSnapshot, type FileSnapshot } from '../lib/workspace';
import { message } from '../lib/types';
import { selectedLines, type DraftReference } from '../lib/input-context';

export function FileEditor({ api, projectId, path, remote, creating, loading, readError, enabled, cache, onChanged, onReference }: { api: Api; projectId: string; path: string; remote?: FileSnapshot; creating: boolean; loading: boolean; readError: string; enabled: boolean; cache: Map<string, FileDraft>; onChanged: () => void; onReference?: (reference: DraftReference) => void }) {
  const [selection, setSelection] = useState<{ start: number; end: number }>();
  const key = fileDraftKey(projectId, path), mounted = useRef(true);
  const [initial] = useState(() => { try { return { draft: cache.get(key) ?? readFileDraft(projectId, path), error: '' }; } catch (e) { return { draft: undefined, error: message(e) }; } });
  const [draft, setDraft] = useState<FileDraft | undefined>(initial.draft ?? (creating ? newFileDraft(projectId, path, null, '') : undefined));
  const current = useRef(draft); current.current = draft;
  const [observed, setObserved] = useState(remote), [busy, setBusy] = useState(false), [error, setError] = useState(initial.error), [storageError, setStorageError] = useState(''), [notice, setNotice] = useState(''), [discard, setDiscard] = useState(false), [compared, setCompared] = useState(false);
  const running = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!remote) return; setObserved(remote); setCompared(false); setSelection(undefined);
    if (typeof remote.text !== 'string' || !remote.revision || initial.error) return;
    const previous = current.current;
    if (!previous || !previous.pending && previous.baseRevision !== null && previous.text === previous.baseText) { const next = newFileDraft(projectId, path, remote.revision, remote.text); current.current = next; setDraft(next); }
  }, [remote, projectId, path, initial.error]);
  const publish = (next: FileDraft) => {
    cache.set(key, next); current.current = next; setDraft(next);
    try { persistFileDraft(next); setStorageError(''); } catch (e) { setStorageError(`文件草稿未能持久保存：${message(e)} 当前输入仍在此页面，请保留页面并复制备份。`); }
  };
  const clear = (snapshot: FileSnapshot) => {
    discardFileDraft(projectId, path); cache.delete(key);
    const next = newFileDraft(projectId, path, snapshot.revision!, snapshot.text!); current.current = next; setDraft(next); setStorageError(''); setDiscard(false);
  };
  const verifyApplied = async (operationId: string) => {
    const value = checkedSnapshot(await api.call('workspace/read', { projectId, path }), path);
    if (!mounted.current) return;
    if (value.kind !== 'file' || typeof value.text !== 'string' || !value.revision) throw new Error('保存已受理，但无法读取文本结果。草稿仍保留。');
    setObserved(value);
    const latest = cache.get(key) ?? current.current;
    if (!latest?.pending || latest.pending.operationId !== operationId) { onChanged(); return; }
    if (value.text === latest.pending.submittedText) {
      if (latest.revision === latest.pending.submittedRevision) clear(value);
      else publish({ ...latest, baseRevision: value.revision, baseText: value.text, pending: undefined });
      setNotice('保存结果已读取核对。');
    } else { publish({ ...latest, pending: undefined }); setNotice('保存已受理，但文件内容与提交时不同。你的草稿仍保留，请比较最新文件。'); }
    onChanged();
  };
  const save = async () => {
    const original = current.current;
    if (!original || running.current || !enabled || original.pending || initial.error || fileDraftProblem(original) || (observed && original.baseRevision !== observed.revision)) return;
    running.current = true; setBusy(true); setError(''); setNotice('');
    let operationId = '';
    try {
      const request = api.beginMutation('workspace/write', { projectId, path, text: original.text, expectedRevision: original.baseRevision }, id => {
        const next = { ...original, pending: { operationId: id, submittedRevision: original.revision, submittedText: original.text } };
        try { persistFileDraft(next); } catch { throw new Error('保存意图未能写入浏览器，文件尚未发送。当前输入仍保留，请先复制备份并恢复浏览器存储。'); }
        cache.set(key, next); current.current = next; setDraft(next); setStorageError('');
      }); operationId = request.operationId;
      await request.result;
      if (mounted.current) await verifyApplied(operationId);
    } catch (e) {
      if (!mounted.current) return;
      if (e instanceof RpcError && e.delivery === 'not_sent' && current.current?.pending?.operationId === operationId) publish({ ...current.current, pending: undefined });
      setError(message(e));
    } finally { running.current = false; if (mounted.current) setBusy(false); }
  };
  const recover = async () => {
    const operationId = current.current?.pending?.operationId;
    if (!operationId || running.current) return; running.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const receipt = await api.call('operation/read', { operationId });
      if (receipt.operationId !== operationId || receipt.state !== 'not_received' && receipt.method !== 'workspace/write' && !(receipt.method === 'operation/retire' && receipt.state === 'not_sent')) throw new Error('保存回执身份不匹配。');
      reconcileOperation(operationId, receipt);
      if (!mounted.current) return;
      if (receipt.state === 'accepted') await verifyApplied(operationId);
      else if (receipt.state === 'not_sent') { if (current.current?.pending?.operationId === operationId) publish({ ...current.current, pending: undefined }); setNotice('已确认原保存没有发送。草稿仍保留，可重新核对文件后保存。'); onChanged(); }
      else setNotice('原保存结果仍未确认。没有重复发送，也没有丢弃草稿。请继续核对回执与文件状态。');
    } catch (e) { if (mounted.current) setError(message(e)); }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  };
  const dirty = Boolean(draft && (draft.baseRevision === null || draft.text !== draft.baseText)), conflict = Boolean(draft && observed?.revision && observed.revision !== draft.baseRevision);
  const full = !cache.has(key) && cache.size >= 10, textError = draft ? fileDraftProblem(draft) : '';
  const range = draft && selection ? selectedLines(draft.text, selection.start, selection.end) : undefined;
  const referenceReady = !dirty && !conflict && !busy && !loading && !readError && !draft?.pending && observed?.revision === draft?.baseRevision && observed?.editable === true && range && range.endLine - range.startLine < 2000;
  return <section className="file-editor stack" aria-label={`编辑 ${path}`}>
    <div className="section-heading"><h3>{draft?.baseRevision === null ? '新建文本文件' : '文本预览与编辑'}</h3><span className="badge">{draft?.pending ? '保存待确认' : dirty ? '有未保存修改' : '已同步'}</span></div>
    {(error || storageError || readError) && <p className="error" role="alert">{error || storageError || readError}</p>}{loading && <p className="muted small" role="status">正在读取文件版本…</p>}{notice && <p className="small muted" role="status">{notice}</p>}
    {draft?.pending && <div className="workspace-warning"><p>这次保存结果待核对。你可以继续编辑草稿，但在确认原操作前不会再次写文件。</p><button className="button small" disabled={busy} onClick={() => void recover()}>查询原保存回执并核对文件</button></div>}
    {conflict && <section className="workspace-conflict stack"><h3>文件版本已变化</h3><p>保留了你的草稿和原版本。请先比较内容，手动合并需要保留的修改。</p><details><summary>原始版本</summary><pre className="raw">{draft?.baseText}</pre></details><label className="field">服务器最新内容<textarea readOnly rows={7} value={observed?.text ?? '无法读取为普通文本'}/></label><label className="check-row"><input type="checkbox" checked={compared} onChange={e => setCompared(e.target.checked)}/>我已比较并在下方草稿中保留需要的修改</label><button className="button" disabled={!compared || busy || Boolean(draft?.pending) || typeof observed?.text !== 'string' || !observed?.revision} onClick={() => { if (draft && observed?.revision && typeof observed.text === 'string') { publish({ ...draft, baseRevision: observed.revision, baseText: observed.text }); setCompared(false); setNotice('已更新比较基准。再次点击保存才会写入文件。'); } }}>以最新文件为基准继续编辑</button></section>}
    {full && <p className="error" role="alert">页面已保留 10 份文件草稿。请先保存或放弃其中一份，再编辑其他文件。</p>}
    {draft && <label className="field">文件内容<textarea onSelect={e => { const input = e.currentTarget; setSelection(input.selectionEnd > input.selectionStart ? { start: input.selectionStart, end: input.selectionEnd } : undefined); }} className="code-editor" wrap="off" spellCheck={false} rows={18} maxLength={524288} disabled={Boolean(initial.error) || full} value={draft.text} onChange={e => { setDiscard(false); setSelection(undefined); publish(editFileDraft(draft, e.target.value)); }} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); } }}/></label>}
    {onReference && <div className="inline wrap"><button className="button small" disabled={!referenceReady} onClick={() => { if (referenceReady && range && observed?.revision) onReference({ type: "file", projectId, path, revision: observed.revision, ...range, label: `${path}:${range.startLine}-${range.endLine}` }); }}>引用选中行{range ? `（${range.startLine}–${range.endLine}）` : ""}</button><span className="small muted">{dirty || conflict || draft?.pending ? "保存并核对文件后才能引用；不会发送未保存草稿。" : "在文本中选择要引用的内容，最多 2,000 行。发送时会再次核对文件版本。"}</span></div>}{textError && <p className="error" role="alert">{textError}</p>}<div className="inline wrap file-editor-actions"><span className="small muted">{draft?.pending ? "保存待确认" : dirty ? "有未保存修改" : "已同步"}</span><button className="button primary" disabled={!draft || !dirty || !enabled || busy || conflict || Boolean(draft?.pending) || Boolean(initial.error) || Boolean(textError) || full} onClick={() => void save()}>{busy ? '正在核对…' : draft?.baseRevision === null ? '创建文件' : '保存文件'}</button>{dirty && observed?.text !== undefined && <button className={`button ${discard ? 'danger' : ''}`} disabled={busy || Boolean(draft?.pending)} onClick={() => { if (!discard) { setDiscard(true); return; } try { clear(observed); setError(''); } catch (e) { setError(message(e)); } }}>{discard ? '确认放弃草稿，采用服务器版本' : '放弃我的修改'}</button>}<span className="small muted">UTF-8 文本 · 最大 512 KiB · Ctrl / ⌘ + S 保存</span></div>
  </section>;
}
