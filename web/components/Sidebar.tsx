import { useEffect, useId, useRef, useState } from 'react';
import { composing, type Project, type Thread } from '../lib/types';
import { Icon } from './Icon';

type RowAction = { label: string; run: () => void; destructive?: boolean };
function RowActions({ label, open, setOpen, actions }: {
  label: string; open: boolean; setOpen: (open: boolean) => void; actions: RowAction[];
}) {
  const container = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLDivElement>(null), id = useId();
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector('button')?.focus();
    const outside = (event: Event) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    // Mobile navigation lives in Dialog, whose document capture listener also owns
    // Escape. Close this inner disclosure first, without dismissing that dialog.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229 ||
        !(event.target instanceof Node) || !container.current?.contains(event.target)) return;
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    window.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      window.removeEventListener('keydown', escape, true);
    };
  }, [open]);
  return <div className="sidebar-actions" ref={container} onKeyDown={event => {
    if (composing(event)) return;
    if (event.key === 'Escape' && open) {
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
      return;
    }
    if (event.target === trigger.current && event.key === 'ArrowDown') {
      event.preventDefault(); setOpen(true); return;
    }
    if (!open || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0 || !buttons.length) return;
    event.preventDefault();
    buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
      (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus();
  }}>
    <button type="button" ref={trigger} className="icon-button sidebar-more"
      aria-label={label} aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(!open)}><span aria-hidden="true">⋯</span></button>
    {open && <div className="sidebar-row-menu" ref={panel} id={id} role="group" aria-label={label}>
      {actions.map(action => <button type="button" key={action.label}
        className={action.destructive ? 'sidebar-row-action danger' : 'sidebar-row-action'}
        onClick={() => { setOpen(false); trigger.current?.focus(); action.run(); }}>{action.label}</button>)}
    </div>}
  </div>;
}

export function Sidebar({
  projects, projectId, threads, threadsProjectId, snippets, threadId, archived, query,
  loading, error, more, onProject, onThread, onNew, onQuery, onArchived, onAddProject,
  onSettings, onMore, onRefresh, onOrganize, onAutomations, onLoaded,
  threadOrder = 'recency_at', onThreadOrder, onProjectAction, onThreadAction,
}: {
  onLoaded?: () => void;
  onAutomations?: () => void;
  onOrganize?: () => void;
  threadOrder?: 'recency_at' | 'section_position';
  onThreadOrder?: (order: 'recency_at' | 'section_position') => void;
  onProjectAction?: (project: Project, action: 'rename' | 'remove') => void;
  onThreadAction?: (thread: Thread, action: 'rename' | 'archive' | 'unarchive' | 'delete') => void;
  projects: Project[];
  projectId: string;
  threads: Thread[];
  /** Owner of the current list/search snapshot; empty means a new snapshot is not ready. */
  threadsProjectId?: string;
  threadId: string;
  archived: boolean;
  query: string;
  loading: boolean;
  error: string;
  more: boolean;
  snippets?: Record<string, string>;
  onProject: (id: string) => void;
  onThread: (id: string) => void;
  onNew: () => void;
  onQuery: (q: string) => void;
  onArchived: () => void;
  onAddProject: () => void;
  onSettings: () => void;
  onMore: () => void;
  onRefresh: () => void;
}) {
  const [searchOpen, setSearchOpen] = useState(false), [menu, setMenu] = useState('');
  const currentProject = projects.find(project => project.id === projectId);
  useEffect(() => setMenu(''), [projectId, threadsProjectId, archived, query]);
  // Snapshot ownership wins over the selected row. For legacy callers without it,
  // a native cwd is the only reliable relationship; native projectId is a different namespace.
  const ownedThreads = currentProject ? threads.filter(thread =>
    threadsProjectId !== undefined ? threadsProjectId === currentProject.id && (!thread.cwd || thread.cwd === currentProject.cwd) :
      Boolean(currentProject.cwd) && thread.cwd === currentProject.cwd) : [];
  const unassignedThreads = !currentProject ? threads : threadsProjectId === undefined
    ? threads.filter(thread => !thread.cwd || !projects.some(project => project.cwd === thread.cwd))
    : threadsProjectId === currentProject.id ? threads.filter(thread => thread.cwd && thread.cwd !== currentProject.cwd) : [];
  const awaitingSnapshot = Boolean(currentProject && threadsProjectId !== undefined && threadsProjectId !== currentProject.id);
  const threadRows = (rows: Thread[]) => rows.map(thread => {
    const name = thread.name || thread.preview || '未命名会话';
    const rowArchived = thread.archived ?? archived;
    const key = 'thread:' + thread.id;
    return <div className="sidebar-row thread-row" key={thread.id}>
      <button type="button" className={'thread-link ' + (thread.id === threadId ? 'selected' : '')}
        onClick={() => onThread(thread.id)} aria-current={thread.id === threadId ? 'page' : undefined}>
        <span>{thread.section && <span className="thread-section-label">
          {thread.section.appearance?.icon} {thread.section.name}
        </span>}{name}{snippets?.[thread.id] && <span className="thread-snippet">{snippets[thread.id]}</span>}</span>
        <small>{thread.updatedAt ? new Date(thread.updatedAt * (thread.updatedAt < 1e12 ? 1000 : 1))
          .toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''}</small>
      </button>
      {onThreadAction && <RowActions label={'管理会话：' + name} open={menu === key}
        setOpen={open => setMenu(open ? key : '')} actions={[
          { label: '重命名会话', run: () => onThreadAction(thread, 'rename') },
          { label: rowArchived ? '取消归档' : '归档会话', run: () => onThreadAction(thread, rowArchived ? 'unarchive' : 'archive') },
          { label: '删除会话', destructive: true, run: () => onThreadAction(thread, 'delete') },
        ]} />}
    </div>;
  });
  const list = <div className="project-conversations">
    <div className="sidebar-section">
      <span>{query ? '搜索结果' : archived ? '归档会话' : '最近会话'}</span>
      <button type="button" className="icon-button" aria-label="刷新会话列表" onClick={onRefresh}>
        <Icon name="refresh" size={15} />
      </button>
    </div>
    {onThreadOrder && <label className="sidebar-sort"><span className="sr-only">会话排序</span>
      <select aria-label="会话排序" value={threadOrder}
        onChange={event => onThreadOrder(event.target.value as 'recency_at' | 'section_position')}>
        <option value="recency_at">最近活动</option><option value="section_position">按分组排序</option>
      </select>
    </label>}
    <nav className="thread-list" aria-label={currentProject ? currentProject.name + '的会话' : '未归属项目的会话'}>
      {threadRows(ownedThreads)}
      {(loading || awaitingSnapshot && !error) && <p className="muted small" role="status">正在加载会话…</p>}
      {error && <p className="error small" role="alert">{error}</p>}
      {!loading && !awaitingSnapshot && !ownedThreads.length && currentProject && <p className="muted small sidebar-empty">
        {query ? more ? '本页没有此项目的匹配项，请继续加载。' : '没有找到匹配会话' : '暂无会话'}
      </p>}
      {more && currentProject && <button type="button" className="button subtle small" disabled={loading || awaitingSnapshot} onClick={onMore}>加载更多</button>}
    </nav>
  </div>;
  return <aside className="sidebar">
    <div className="sidebar-brand"><span className="brand-mark small-mark">⌘</span><strong>Codex <span>Harness</span></strong></div>
    <button type="button" className="new-chat" onClick={onNew}><Icon name="plus" />新会话</button>
    <div className="nav-tools">
      <button type="button" className={'nav-item ' + (searchOpen ? 'selected' : '')} aria-expanded={searchOpen}
        onClick={() => setSearchOpen(value => !value)}><Icon name="search" />搜索会话</button>
      <button type="button" className={'nav-item ' + (archived ? 'selected' : '')} onClick={onArchived}><Icon name="archive" />已归档</button>
      {onLoaded && <button type="button" className="nav-item" onClick={onLoaded}><Icon name="play" />已加载会话</button>}
      {onAutomations && <button type="button" className="nav-item" onClick={onAutomations}><Icon name="refresh" />自动化</button>}
      {onOrganize && <button type="button" className="nav-item" onClick={onOrganize}><Icon name="folder" />会话分组</button>}
    </div>
    {searchOpen && <label className="sr-only-wrap"><span className="sr-only">搜索会话</span>
      <input className="search-input" autoFocus placeholder="当前项目的标题或内容…" value={query}
        onChange={event => onQuery(event.target.value)} />
    </label>}
    <div className="sidebar-section"><span>项目</span>
      <button type="button" className="icon-button" aria-label="添加项目" onClick={onAddProject}><Icon name="plus" size={16} /></button>
    </div>
    <div className="project-tree">
      {projects.map(project => {
        const selected = project.id === projectId, key = 'project:' + project.id;
        return <section className="project-node" key={project.id} aria-label={'项目：' + project.name}>
          <div className="sidebar-row project-row">
            <button type="button" className={'nav-item project ' + (selected ? 'selected' : '')}
              onClick={() => onProject(project.id)} title={project.cwd} aria-expanded={selected}>
              <Icon name="folder" /><span className="project-name">{project.name}</span>
              <span className="project-chevron" aria-hidden="true">{selected ? '▾' : '▸'}</span>
            </button>
            {onProjectAction && <RowActions label={'管理项目：' + project.name} open={menu === key}
              setOpen={open => setMenu(open ? key : '')} actions={[
                { label: '重命名项目', run: () => onProjectAction(project, 'rename') },
                { label: '移除项目（保留目录）', destructive: true, run: () => onProjectAction(project, 'remove') },
              ]} />}
          </div>
          {selected && list}
        </section>;
      })}
      {!projects.length && <p className="muted small sidebar-empty">添加本地项目，开始第一次会话。</p>}
      {!currentProject && <section className="unassigned-conversations" aria-label="未选择项目">
        <p className="muted small sidebar-empty">尚未选择有效项目。请选择项目查看对应会话。</p>
        {list}
      </section>}
      {unassignedThreads.length > 0 && <section className="unassigned-conversations" aria-label="未确认归属的会话">
        <p className="muted small sidebar-empty">以下会话尚未确认所属项目。</p>
        <nav className="thread-list" aria-label="未确认归属的会话">{threadRows(unassignedThreads)}</nav>
      </section>}
    </div>
    <div className="sidebar-account">
      <span className="avatar">C</span><span><strong>我的工作台</strong><small>账户与设置</small></span>
      <button type="button" className="icon-button sidebar-settings" aria-label="打开设置" title="设置" onClick={onSettings}><Icon name="settings" /></button>
    </div>
  </aside>;
}
