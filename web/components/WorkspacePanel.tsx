import { useEffect, useRef, useState } from 'react';
import { Api, RpcError } from '../lib/api';
import { useWorkspaceWatch } from '../hooks/useWorkspaceWatch';
import { useResource } from '../hooks/useResource';
import { useOperations } from './Recovery';
import { reconcileOperation } from '../lib/operations';
import { fileDraftKey, listFileDrafts, type FileDraft } from '../lib/file-drafts';
import { checkedDirectory, checkedSnapshot, joinPath, parentPath, workspacePath, type WorkspaceSnapshot } from '../lib/workspace';
import { message, type Project } from '../lib/types';
import type { DraftReference } from '../lib/input-context';
import { FileEditor } from './FileEditor';
import { WorkspaceGit } from './WorkspaceGit';
import { WorkspaceRecovery } from './WorkspaceRecovery';
import { WorkspaceWorktrees } from './WorkspaceWorktrees';
import { WorkspaceSearch } from './WorkspaceSearch';
import { WorkspaceDownload } from './WorkspaceDownload';
import { Icon } from './Icon';

type FileAction = { kind: 'copy'; target: WorkspaceSnapshot } | { kind: 'remove'; target: WorkspaceSnapshot } | { kind: 'create' } | { kind: 'mkdir' };
export function WorkspacePanel({ api, project, epoch, connected, ready, request, onReviewBase, onReference, idle = false, visible = true, onProjectsChanged = () => {}, onSelectProject = () => {} }: { visible?: boolean; idle?: boolean; onProjectsChanged?: () => void; onSelectProject?: (id: string) => void; onReference?: (reference: DraftReference) => void; api: Api; project?: Project; epoch: string; connected: boolean; ready: boolean; request?: { projectId: string; path: string; revision: number }; onReviewBase: (ref: string) => void }) {
  const [watching, setWatching] = useState(false);
  const [tab, setTab] = useState<'files' | 'git' | 'recovery' | 'worktrees'>('files'), [directory, setDirectory] = useState(''), [selected, setSelected] = useState<{ path: string; creating?: boolean }>(), [pathInput, setPathInput] = useState('');
  const [revision, setRevision] = useState(0), [action, setAction] = useState<FileAction>(), [destination, setDestination] = useState(''), [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [pendingAction, setPendingAction] = useState<{ operationId: string; method: string }>();
  const cache = useRef(new Map<string, FileDraft>()), running = useRef(false), generation = useRef(0), openGeneration = useRef(0), mounted = useRef(true), projectKey = useRef(project?.id), operations = useOperations();
  if (projectKey.current !== project?.id) { projectKey.current = project?.id; generation.current++; openGeneration.current++; }
  const key = `${project?.id}:${epoch}:${revision}`, selectedPath = selected?.path;
  const appliedRequest = useRef<number | undefined>(undefined);
  const pending = operations.operations.some(op => op.projectId === project?.id && op.method.startsWith('workspace/') && ['pending', 'unknown'].includes(op.state));
  const enabled = ready && !busy && !pending && !operations.error && !pendingAction;
  useEffect(() => { try { for (const draft of listFileDrafts()) cache.current.set(fileDraftKey(draft.projectId, draft.path), draft); } catch (e) { setError(message(e)); } }, []);
  useEffect(() => { setDirectory(''); setSelected(undefined); setPathInput(''); setAction(undefined); setPendingAction(undefined); setError(''); setNotice(''); setTab('files'); }, [project?.id]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; openGeneration.current++; }; }, []);
  const listing = useResource(`${key}:${directory}`, async signal => checkedDirectory(await api.call('workspace/list', { projectId: project!.id, path: directory }, signal), directory), connected && Boolean(project));
  const folder = useResource(`${key}:${directory}:metadata`, async signal => checkedSnapshot(await api.call('workspace/metadata', { projectId: project!.id, path: directory }, signal), directory), connected && Boolean(project));
  const file = useResource(`${key}:${selectedPath ?? ''}`, async signal => {
    const metadata = checkedSnapshot(await api.call('workspace/metadata', { projectId: project!.id, path: selectedPath! }, signal), selectedPath!);
    if (metadata.kind !== 'file' || metadata.editable === false) return metadata;
    return checkedSnapshot(await api.call('workspace/read', { projectId: project!.id, path: selectedPath! }, signal), selectedPath!);
  }, connected && Boolean(project && selectedPath) && !selected?.creating);
  const refresh = () => setRevision(value => value + 1);
  const watch = useWorkspaceWatch(api, { projectId: project?.id ?? "", epoch, directory, file: selectedPath, enabled: Boolean(project) && watching && visible && tab === "files", connected }, () => { listing.refresh(); folder.refresh(); file.refresh(); });
  const open = async (path: string) => {
    if (!project || !connected) return; const gen = generation.current, requestGeneration = ++openGeneration.current; setError('');
    try {
      workspacePath(path, true);
      const metadata = checkedSnapshot(await api.call('workspace/metadata', { projectId: project.id, path }), path);
      if (gen !== generation.current || requestGeneration !== openGeneration.current) return;
      setTab('files'); setAction(undefined); setPathInput(path);
      if (metadata.kind === 'directory') { setDirectory(path); setSelected(undefined); }
      else { setDirectory(parentPath(path)); setSelected({ path }); }
    } catch (e) { if (gen === generation.current && requestGeneration === openGeneration.current) { setError(message(e)); if (path && cache.current.has(fileDraftKey(project.id, path))) { setSelected({ path }); setTab('files'); } } }
  };
  useEffect(() => { if (connected && request && request.projectId === project?.id && appliedRequest.current !== request.revision) { appliedRequest.current = request.revision; void open(request.path); } }, [request?.revision, project?.id, connected]);
  const begin = (next: FileAction) => { openGeneration.current++; setAction(next); setDestination(next.kind === 'copy' ? next.target.path + '.copy' : directory ? directory + '/' : ''); setConfirmation(''); setError(''); setNotice(''); };
  const perform = async () => {
    if (!project || !action || !enabled || running.current) return;
    if (action.kind === 'create') { try { const path = workspacePath(destination); setSelected({ path, creating: true }); setPathInput(path); setAction(undefined); } catch (e) { setError(message(e)); } return; }
    const gen = generation.current, owner = project.id;
    let method: string, params: Record<string, unknown>;
    try {
      if (action.kind === 'mkdir') { method = 'workspace/mkdir'; params = { projectId: owner, path: workspacePath(destination) }; }
      else if (action.kind === 'copy') { method = 'workspace/copy'; params = { projectId: owner, path: action.target.path, destination: workspacePath(destination), expectedRevision: action.target.revision }; }
      else { if (confirmation !== action.target.path) return; method = 'workspace/remove'; params = { projectId: owner, path: action.target.path, expectedRevision: action.target.revision, confirm: true, recursive: false }; }
    } catch (e) { setError(message(e)); return; }
    running.current = true; setBusy(true); setError(''); setNotice('');
    try { const operation = api.beginMutation(method, params); setPendingAction({ operationId: operation.operationId, method }); await operation.result; if (generation.current === gen) { setPendingAction(undefined); setAction(undefined); setNotice('操作已受理，正在重新读取项目内容。'); refresh(); } }
    catch (e) { if (generation.current === gen) { if (e instanceof RpcError && e.delivery === 'not_sent') setPendingAction(undefined); setError(message(e)); } }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  };
  const recoverAction = async () => {
    if (!pendingAction || busy || running.current) return; const gen = generation.current, expected = pendingAction; running.current = true; setBusy(true); setError('');
    try {
      const receipt = await api.call('operation/read', { operationId: expected.operationId });
      if (receipt.operationId !== expected.operationId || receipt.state !== 'not_received' && receipt.method !== expected.method && !(receipt.method === 'operation/retire' && receipt.state === 'not_sent')) throw new Error('文件操作回执身份不匹配。');
      reconcileOperation(expected.operationId, receipt);
      if (gen !== generation.current) return;
      if (receipt.state === 'accepted' || receipt.state === 'not_sent') { setPendingAction(undefined); if (receipt.state === 'accepted') setAction(undefined); setNotice(receipt.state === 'accepted' ? '原操作已确认受理，正在重新读取项目。' : '原操作确定未发送。'); refresh(); }
      else setNotice('原文件操作仍待确认。未重复发送，请保留回执并继续核对。');
    } catch (e) { if (gen === generation.current) setError(message(e)); }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  };
  if (!project) return <section className="workspace-panel"><p className="muted">请选择一个已注册项目。</p></section>;
  const currentFile = file.data?.kind === 'file' ? file.data : undefined;
  const crumbs = directory ? directory.split('/') : [], drafts = [...cache.current.values()].filter(draft => draft.projectId === project.id);
  const canEdit = Boolean(selected && (selected.creating || cache.current.has(fileDraftKey(project.id, selected.path)) || currentFile?.editable === true || file.loading));
  return <section className="workspace-panel"><header className="workspace-heading"><div><h2>项目文件</h2><p className="small muted path">{project.name} · {project.cwd}</p></div><div className="inline wrap"><button className={`button small ${tab === 'files' ? 'selected' : ''}`} aria-pressed={tab === 'files'} onClick={() => setTab('files')}>文件</button><button className={`button small ${tab === 'git' ? 'selected' : ''}`} aria-pressed={tab === 'git'} onClick={() => setTab('git')}>Git</button><button className={`button small ${tab === 'recovery' ? 'selected' : ''}`} aria-pressed={tab === 'recovery'} onClick={() => setTab('recovery')}>恢复材料</button><button className={`button small ${tab === 'worktrees' ? 'selected' : ''}`} aria-pressed={tab === 'worktrees'} onClick={() => setTab('worktrees')}>工作树</button><button className="button small" disabled={!connected} onClick={() => void open('AGENTS.md')}>根目录 AGENTS.md</button></div></header>{(error || operations.error) && <p className="error" role="alert">{error || operations.error}</p>}{notice && <p className="small muted" role="status">{notice}</p>}{!connected && <p className="connection-banner">连接已断开。文件草稿仍保留；恢复后先核对文件版本再保存。</p>}{pendingAction && <div className="workspace-warning"><p>此文件操作等待确认，不能据此重复执行。</p><button className="button small" disabled={busy} onClick={() => void recoverAction()}>查询原文件操作回执</button></div>}{tab === 'recovery' ? <WorkspaceRecovery key={project.id} api={api} project={project} epoch={epoch} connected={connected} enabled={enabled} onChanged={refresh} onOpenFile={path => void open(path)}/> : tab === 'worktrees' ? <WorkspaceWorktrees key={project.id} api={api} project={project} epoch={epoch} connected={connected} idle={idle} onChanged={() => { refresh(); onProjectsChanged(); }} onSelectProject={onSelectProject}/> : tab === 'git' ? <WorkspaceGit enabled={enabled && idle} key={project.id} api={api} project={project} epoch={`${epoch}:${revision}`} connected={connected} onFile={path => void open(path)} onReviewBase={onReviewBase}/> : <>
    <label className="check-row small"><input type="checkbox" checked={watching} onChange={e => setWatching(e.target.checked)}/>自动检查外部修改（每轮完成后 5 秒检查当前目录与文件）</label>{watch.error && <p className="error" role="alert">外部修改检查：{watch.error}</p>}{watch.active && <p className="small muted">有界轮询，仅此文件视图可见且已连接时运行；变化后核对版本，保留未保存草稿。</p>}<WorkspaceSearch key={project.id + ":" + epoch} api={api} project={project} epoch={epoch} connected={connected} onOpenFile={path => void open(path)}/><form className="workspace-path" onSubmit={e => { e.preventDefault(); void open(pathInput); }}><label className="field"><span className="sr-only">项目内路径</span><input aria-label="项目内路径" value={pathInput} onChange={e => setPathInput(e.target.value)} placeholder="相对路径，例如 src/main.ts" maxLength={4096}/></label><button className="button small" disabled={!connected}>打开路径</button></form>
    {drafts.length > 0 && <details className="workspace-drafts"><summary>此项目保留了 {drafts.length} 份文件草稿</summary><div className="inline wrap">{drafts.map(draft => <button className="button small" key={draft.path} onClick={() => { openGeneration.current++; setAction(undefined); setSelected({ path: draft.path, creating: draft.baseRevision === null }); setPathInput(draft.path); }}>{draft.path}{draft.pending ? ' · 保存待确认' : ''}</button>)}</div></details>}
    <div className="workspace-columns"><aside className="file-explorer"><nav className="file-breadcrumb" aria-label="当前目录"><button onClick={() => { openGeneration.current++; setDirectory(''); setPathInput(''); }}>项目根目录</button>{crumbs.map((crumb, index) => <button key={index} onClick={() => { openGeneration.current++; const path = crumbs.slice(0, index + 1).join('/'); setDirectory(path); setPathInput(path); }}>{crumb} /</button>)}</nav><div className="inline wrap"><button className="button small" disabled={!enabled} onClick={() => begin({ kind: 'create' })}>新建文件</button><button className="button small" disabled={!enabled} onClick={() => begin({ kind: 'mkdir' })}>新建目录</button><button className="button small" disabled={!connected || listing.loading} onClick={refresh}>刷新文件</button>{directory && <button className="button small" disabled={!enabled || folder.data?.kind !== 'directory'} onClick={() => { if (folder.data?.kind === 'directory') begin({ kind: 'remove', target: folder.data }); }}>删除当前空目录</button>}</div>{listing.loading && <p role="status">读取目录…</p>}{listing.error && <p className="error" role="alert">{listing.error}</p>}<ul className="file-list" aria-label="项目文件列表">{listing.data?.entries.map(entry => { let path = ''; try { path = joinPath(directory, entry.name); } catch { /* Render unsupported names without creating an unsafe control. */ } return <li key={entry.name}><button className={selected?.path === path ? 'selected' : ''} disabled={!connected || !entry.accessible || !path} onClick={() => { openGeneration.current++; setAction(undefined); setPathInput(path); if (entry.kind === 'directory') { setDirectory(path); setSelected(undefined); } else setSelected({ path }); }}><Icon name={entry.kind === 'directory' ? 'folder' : 'chat'} size={16}/><span>{entry.name}</span><small>{!entry.accessible || !path ? '不可访问' : entry.kind === 'directory' ? '目录' : `${Math.ceil(entry.bytes / 1024)} KiB`}</small></button></li>; })}</ul>{listing.data?.entries.length === 0 && <p className="muted small">目录为空。</p>}{listing.data?.truncated && <p className="workspace-warning small">目录只显示最多 1,000 项。请进入子目录或输入准确的相对路径。</p>}</aside>
    <div className="file-detail">{action && <form className="info-card stack" onSubmit={e => { e.preventDefault(); void perform(); }}><h3>{action.kind === 'create' ? '准备新文件草稿' : action.kind === 'mkdir' ? '创建目录' : action.kind === 'copy' ? '复制文件' : '删除文件或空目录'}</h3><fieldset className="submission-fields stack" disabled={busy || Boolean(pendingAction)}>{action.kind === 'remove' ? <><p className="path">将删除：{action.target.path}</p><p>只支持普通文件和空目录，不会递归删除。可在“恢复材料”中按原操作编号选择备份并恢复到明确路径；请确认此次删除。</p><label className="field">输入完整相对路径以确认<input value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="off"/></label></> : <label className="field">{action.kind === 'copy' ? '复制到项目内路径（必须不存在）' : '项目内新路径'}<input value={destination} onChange={e => setDestination(e.target.value)} required maxLength={4096}/></label>}</fieldset><div className="inline"><button className={`button ${action.kind === 'remove' ? 'danger' : 'primary'}`} disabled={!enabled || action.kind === 'remove' && confirmation !== action.target.path}>{action.kind === 'create' ? '打开新文件草稿' : action.kind === 'remove' ? '确认删除' : '提交'}</button><button type="button" className="button" disabled={busy || Boolean(pendingAction)} onClick={() => setAction(undefined)}>取消</button></div></form>}
    {selected ? <><div className="section-heading file-heading"><h3 className="path">{selected.path}</h3><div className="inline wrap">{currentFile?.revision && <><WorkspaceDownload key={project.id + ":" + currentFile.path} api={api} projectId={project.id} file={currentFile} connected={connected}/><button className="button small" disabled={!enabled} onClick={() => begin({ kind: 'copy', target: currentFile })}>复制</button><button className="button danger small" disabled={!enabled} onClick={() => begin({ kind: 'remove', target: currentFile })}>删除</button></>}<button className="button small" disabled={!connected || file.loading} onClick={() => { setSelected(current => current ? { path: current.path } : current); file.refresh(); }}>读取最新版本</button></div></div>{canEdit ? <FileEditor onReference={onReference} key={fileDraftKey(project.id, selected.path)} api={api} projectId={project.id} path={selected.path} remote={currentFile} creating={Boolean(selected.creating)} loading={file.loading} readError={file.error} enabled={enabled} cache={cache.current} onChanged={() => { setSelected(current => current && current.path === selectedPath ? { path: current.path } : current); refresh(); }}/> : <>{file.error && <p className="error" role="alert">{file.error}</p>}{currentFile?.binary && <p className="muted">这是二进制或非 UTF-8 文件，未作为文本预览或编辑。</p>}{currentFile?.reason && ['file_too_large', 'preview_too_large'].includes(currentFile.reason) && <p className="muted">文件大小为 {currentFile.bytes.toLocaleString()} 字节，超过 512 KiB 文本预览与修改上限。</p>}</>}</> : !action && <div className="file-empty"><Icon name="folder" size={30}/><p>选择文件以预览、编辑或查看版本。</p><p className="small muted">所有路径限制在当前注册项目内。AGENTS.md 使用相同的预览与版本校验流程。</p></div>}</div></div>
  </>}</section>;
}
