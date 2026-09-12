import { useState } from "react";
import { useStore } from "../store";
import { gateway } from "../api/ws";
import { relativeTime, pathBasename } from "../utils/time";

/**
 * Clean sidebar: a flat project list on top, a "new conversation" button and
 * the current project's sessions below. No indentation, no guide lines —
 * grouping is conveyed purely by spacing and a section label.
 */
export function Sidebar() {
  const projects = useStore((s) => s.projects);
  const currentProject = useStore((s) => s.currentProject);
  const sessions = useStore((s) => s.sessions);
  const activeThreadId = useStore((s) => s.activeThreadId);
  const sessionCursor = useStore((s) => s.sessionCursor);
  const sessionLoading = useStore((s) => s.sessionLoading);
  const sessionLoadingMore = useStore((s) => s.sessionLoadingMore);
  const sessionSearch = useStore((s) => s.sessionSearch);
  const sessionArchived = useStore((s) => s.sessionArchived);
  const selectProject = useStore((s) => s.selectProject);
  const openThread = useStore((s) => s.openThread);
  const newThread = useStore((s) => s.newThread);
  const removeProject = useStore((s) => s.removeProject);
  const loadMoreSessions = useStore((s) => s.loadMoreSessions);
  const setSessionSearch = useStore((s) => s.setSessionSearch);
  const setSessionArchived = useStore((s) => s.setSessionArchived);

  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <aside className="sb">
      <div className="sb-label-row">
        <span className="sb-label">项目</span>
        <button className="sb-add" title="添加项目" onClick={() => setPickerOpen(true)}>
          ＋
        </button>
      </div>
      <div className="sb-projects">
        {projects.map((p) => (
          <div
            key={p.path}
            className={`sb-project ${p.path === currentProject ? "current" : ""}`}
            onClick={() => void selectProject(p.path)}
            title={p.path}
          >
            <span className="sb-project-dot" aria-hidden />
            <span className="sb-project-name">{pathBasename(p.path)}</span>
            <span className="sb-time">{relativeTime(Math.floor(p.lastUsedAt / 1000))}</span>
            {projects.length > 1 && (
              <button
                className="sb-x"
                title="移除注册（不删除文件）"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`从列表移除项目？\n${p.path}\n（仅移除注册，不会删除任何文件或会话）`)) {
                    void removeProject(p.path);
                  }
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>

      <button className="sb-new" onClick={() => void newThread()}>
        ＋ 新对话
      </button>

      <div className="sb-session-controls">
        <input
          className="sb-search"
          type="search"
          placeholder="搜索会话标题…"
          value={sessionSearch}
          onChange={(e) => setSessionSearch(e.target.value)}
          maxLength={200}
        />
        <div className="sb-arch-tabs">
          <button
            className={`sb-arch-tab ${!sessionArchived ? "active" : ""}`}
            onClick={() => setSessionArchived(false)}
          >
            当前
          </button>
          <button
            className={`sb-arch-tab ${sessionArchived ? "active" : ""}`}
            onClick={() => setSessionArchived(true)}
          >
            归档
          </button>
        </div>
      </div>

      <div className="sb-sessions">
        {sessionLoading && sessions.length === 0 && <div className="sb-empty">加载中…</div>}
        {sessions.map((s) => (
          <SessionRow
            key={s.threadId}
            session={s}
            active={s.threadId === activeThreadId}
            archived={sessionArchived}
            onOpen={openThread}
          />
        ))}
        {!sessionLoading && sessions.length === 0 && (
          <div className="sb-empty">
            {sessionArchived ? "还没有归档会话" : sessionSearch ? `没有匹配「${sessionSearch}」的会话` : "当前项目还没有会话"}
          </div>
        )}
        {sessionCursor && (
          <button className="sb-load-more" onClick={() => void loadMoreSessions()} disabled={sessionLoadingMore}>
            {sessionLoadingMore ? "加载中…" : "加载更多"}
          </button>
        )}
      </div>

      {pickerOpen && <ProjectPicker onClose={() => setPickerOpen(false)} />}
    </aside>
  );
}

function SessionRow({
  session,
  active,
  archived,
  onOpen,
}: {
  session: { threadId: string; title: string; updatedAt: number };
  active: boolean;
  archived: boolean;
  onOpen: (id: string) => Promise<void>;
}) {
  const renameThread = useStore((s) => s.renameThread);
  const archiveThread = useStore((s) => s.archiveThread);
  const deleteThread = useStore((s) => s.deleteThread);
  const unarchiveThread = useStore((s) => s.unarchiveThread);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);

  function commitRename() {
    setEditing(false);
    const name = draft.trim();
    if (name && name !== session.title) void renameThread(session.threadId, name);
  }

  if (editing) {
    return (
      <div className="sb-session current">
        <input
          autoFocus
          className="sb-rename"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={200}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      </div>
    );
  }

  return (
    <div className={`sb-session ${active ? "current" : ""}`} onClick={() => void onOpen(session.threadId)}>
      <span className="sb-session-title">{session.title}</span>
      <span className="sb-time">{relativeTime(session.updatedAt)}</span>
      <span className="sb-actions" onClick={(e) => e.stopPropagation()}>
        {!archived && (
          <button className="sb-x" title="重命名" onClick={() => { setDraft(session.title); setEditing(true); }}>
            ✎
          </button>
        )}
        {archived ? (
          <>
            <button className="sb-x" title="恢复到当前会话" onClick={() => void unarchiveThread(session.threadId)}>
              ↩
            </button>
            <button
              className="sb-x sb-x-danger"
              title="永久删除"
              onClick={() => {
                if (confirm(`永久删除归档会话「${session.title}」？此操作不可恢复。`)) void deleteThread(session.threadId);
              }}
            >
              🗑
            </button>
          </>
        ) : (
          <>
            <button className="sb-x" title="归档" onClick={() => void archiveThread(session.threadId)}>
              ⬇
            </button>
            <button
              className="sb-x sb-x-danger"
              title="删除"
              onClick={() => {
                if (confirm(`删除会话「${session.title}」？此操作不可恢复。`)) void deleteThread(session.threadId);
              }}
            >
              🗑
            </button>
          </>
        )}
      </span>
    </div>
  );
}

/** Add a project: manual absolute path, or browse the server filesystem. */
function ProjectPicker({ onClose }: { onClose: () => void }) {
  const addProject = useStore((s) => s.addProject);
  const selectProject = useStore((s) => s.selectProject);
  const workspaceRoot = useStore((s) => s.workspaceRoot);
  const [path, setPath] = useState("");
  const [create, setCreate] = useState(false);
  const [browseDir, setBrowseDir] = useState<string | null>(null);
  const [entries, setEntries] = useState<Array<{ fileName: string; isDirectory: boolean }>>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function browse(dir: string) {
    setError("");
    try {
      const res = await gateway.rpc<any>("fs/readDirectory", { path: dir });
      const list: any[] = (Array.isArray(res?.entries) ? res.entries : [])
        .filter((entry: any) => entry?.isDirectory === true && typeof entry?.fileName === "string")
        .slice(0, 5_000);
      list.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return String(a.fileName).localeCompare(String(b.fileName));
      });
      setEntries(list.map((entry) => ({ ...entry, fileName: entry.fileName.slice(0, 255) })));
      setBrowseDir(dir);
      setPath(dir);
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const target = path.trim().slice(0, 4096);
      await addProject(target, create);
      await selectProject(target);
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>添加项目</h3>
        <p className="dim">输入服务器上的绝对路径，或浏览目录选择。新会话将以此目录为工作区。</p>
        <input
          className="text-input"
          placeholder="/home/user/my-project"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          maxLength={4096}
        />
        <label className="check-line">
          <input type="checkbox" checked={create} onChange={(e) => setCreate(e.target.checked)} />
          目录不存在时自动创建
        </label>
        {error && <div className="error-text">{error}</div>}
        {browseDir !== null && (
          <div className="dir-browser">
            <div className="dir-browser-head">
              <button className="btn" onClick={() => void browse(parentOf(browseDir))}>
                ↑ 上级
              </button>
              <code className="dir-browser-path">{browseDir}</code>
            </div>
            <div className="dir-browser-list">
              {entries.length === 0 && <div className="dim">（无子目录）</div>}
              {entries.map((e) => (
                <button key={e.fileName} className="dir-entry" onClick={() => void browse(joinDir(browseDir, e.fileName))}>
                  📁 {e.fileName}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="approval-actions">
          <button className="btn" onClick={() => browse(browseDir ?? guessRoot(workspaceRoot))}>
            浏览目录
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn-primary" disabled={!path.trim() || busy} onClick={() => void submit()}>
            添加
          </button>
        </div>
      </div>
    </div>
  );
}

function parentOf(dir: string): string {
  const norm = dir.replace(/[\\/]+$/, "");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  if (idx < 0) return norm;
  let parent = norm.slice(0, idx);
  if (/^[A-Za-z]:$/.test(parent)) parent += "\\"; // drive root: "D:\"
  if (!parent) parent = "/";
  return parent;
}

function joinDir(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
}

function guessRoot(workspaceRoot: string): string {
  if (!workspaceRoot) return "/";
  return parentOf(workspaceRoot);
}
