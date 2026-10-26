import { useState } from 'react';
import type { Project, Thread } from '../lib/types';
import { Icon } from './Icon';
export function Sidebar({
  projects,
  projectId,
  threads,
  snippets,
  threadId,
  archived,
  query,
  loading,
  error,
  more,
  onProject,
  onThread,
  onNew,
  onQuery,
  onArchived,
  onAddProject,
  onSettings,
  onMore,
  onRefresh,
  onOrganize,
  onAutomations,
  onLoaded,
  threadOrder = 'recency_at',
  onThreadOrder,
}: {
  onLoaded?: () => void;
  onAutomations?: () => void;
  onOrganize?: () => void;
  threadOrder?: 'recency_at' | 'section_position';
  onThreadOrder?: (order: 'recency_at' | 'section_position') => void;
  projects: Project[];
  projectId: string;
  threads: Thread[];
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
  const [searchOpen, setSearchOpen] = useState(false);
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="brand-mark small-mark">⌘</span>
        <strong>
          Codex <span>Harness</span>
        </strong>
      </div>
      <button className="new-chat" onClick={onNew}>
        <Icon name="plus" />
        新会话<span className="shortcut">开始</span>
      </button>
      <div className="nav-tools">
        <button
          className={`nav-item ${searchOpen ? 'selected' : ''}`}
          onClick={() => setSearchOpen((v) => !v)}
        >
          <Icon name="search" />
          搜索会话
        </button>
        <button className={`nav-item ${archived ? 'selected' : ''}`} onClick={onArchived}>
          <Icon name="archive" />
          已归档
        </button>
        {onLoaded && (
          <button className="nav-item" onClick={onLoaded}>
            <Icon name="play" />
            已加载会话
          </button>
        )}
        {onAutomations && (
          <button className="nav-item" onClick={onAutomations}>
            <Icon name="refresh" />
            自动化
          </button>
        )}
        {onOrganize && (
          <button className="nav-item" onClick={onOrganize}>
            <Icon name="folder" />
            会话组织
          </button>
        )}
      </div>
      {searchOpen && (
        <label className="sr-only-wrap">
          <span className="sr-only">搜索会话</span>
          <input
            className="search-input"
            autoFocus
            placeholder="标题或内容…"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
          />
        </label>
      )}
      <div className="sidebar-section">
        <span>项目</span>
        <button className="icon-button" aria-label="添加项目" onClick={onAddProject}>
          <Icon name="plus" size={16} />
        </button>
      </div>
      <div className="project-list">
        {projects.map((p) => (
          <button
            className={`nav-item project ${p.id === projectId ? 'selected' : ''}`}
            key={p.id}
            onClick={() => onProject(p.id)}
            title={p.cwd}
          >
            <Icon name="folder" />
            <span>{p.name}</span>
            <span className="project-dot" />
          </button>
        ))}
        {projects.length === 0 && (
          <p className="muted small sidebar-empty">添加本地项目，开始第一次会话。</p>
        )}
      </div>
      <div className="sidebar-section">
        <span>{archived ? '归档会话' : '最近会话'}</span>
        <button className="icon-button" aria-label="刷新会话列表" onClick={onRefresh}>
          <Icon name="refresh" size={15} />
        </button>
      </div>
      {onThreadOrder && (
        <label className="sidebar-sort">
          <span className="sr-only">会话排序</span>
          <select
            aria-label="会话排序"
            value={threadOrder}
            onChange={(event) =>
              onThreadOrder(event.target.value as 'recency_at' | 'section_position')
            }
          >
            <option value="recency_at">最近活动</option>
            <option value="section_position">原生分区顺序</option>
          </select>
        </label>
      )}
      <nav className="thread-list" aria-label="会话">
        {threads.map((t) => (
          <button
            className={`thread-link ${t.id === threadId ? 'selected' : ''}`}
            key={t.id}
            onClick={() => onThread(t.id)}
          >
            <span>
              {t.section && (
                <span className="thread-section-label">
                  {t.section.appearance?.icon} {t.section.name}
                </span>
              )}
              {t.name || t.preview || '未命名会话'}
              {snippets?.[t.id] && <span className="thread-snippet">{snippets[t.id]}</span>}
            </span>
            <small>
              {t.updatedAt
                ? new Date(t.updatedAt * (t.updatedAt < 1e12 ? 1000 : 1)).toLocaleDateString(
                    undefined,
                    { month: 'short', day: 'numeric' },
                  )
                : ''}
            </small>
          </button>
        ))}
        {loading && (
          <p className="muted small" role="status">
            正在加载会话…
          </p>
        )}
        {error && (
          <p className="error small" role="alert">
            {error}
          </p>
        )}
        {!loading && !threads.length && (
          <p className="muted small sidebar-empty">
            {query
              ? more
                ? '本页没有此项目的匹配项，请继续加载。'
                : '没有找到匹配会话'
              : '这里会记录你的工作'}
          </p>
        )}
        {more && (
          <button className="button subtle small" disabled={loading} onClick={onMore}>
            加载更多
          </button>
        )}
      </nav>
      <button className="sidebar-account" onClick={onSettings}>
        <span className="avatar">C</span>
        <span>
          <strong>我的工作台</strong>
          <small>账户与设置</small>
        </span>
        <Icon name="settings" />
      </button>
    </aside>
  );
}
