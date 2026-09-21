import { useEffect, useRef, useState } from "react";
import { useStore, type ProjectEntry } from "../store";
import { gateway } from "../api/ws";
import { relativeTime, pathBasename } from "../utils/time";

function rowActionError(error: unknown, fallback: string): string {
  try {
    return (error instanceof Error ? error.message : String(error)).slice(0, 1_000) || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Clean sidebar: a flat project list on top, a "new conversation" button and
 * the current project's sessions below. No indentation, no guide lines —
 * grouping is conveyed purely by spacing and a section label.
 */
export function Sidebar() {
  const projects = useStore((s) => s.projects);
  const projectsLoad = useStore((s) => s.projectsLoad);
  const currentProject = useStore((s) => s.currentProject);
  const sessions = useStore((s) => s.sessions);
  const activeThreadId = useStore((s) => s.activeThreadId);
  const sessionCursor = useStore((s) => s.sessionCursor);
  const sessionLoading = useStore((s) => s.sessionLoading);
  const sessionLoadingMore = useStore((s) => s.sessionLoadingMore);
  const sessionLoad = useStore((s) => s.sessionLoad);
  const sessionSearch = useStore((s) => s.sessionSearch);
  const sessionArchived = useStore((s) => s.sessionArchived);
  const selectProject = useStore((s) => s.selectProject);
  const openThread = useStore((s) => s.openThread);
  const newThread = useStore((s) => s.newThread);
  const removeProject = useStore((s) => s.removeProject);
  const loadMoreSessions = useStore((s) => s.loadMoreSessions);
  const setSessionSearch = useStore((s) => s.setSessionSearch);
  const setSessionArchived = useStore((s) => s.setSessionArchived);
  const refresh = useStore((s) => s.refresh);
  const refreshProjects = useStore((s) => s.refreshProjects);
  const refreshSessions = useStore((s) => s.refreshSessions);
  const threadCreateOperation = useStore((s) => s.threadCreateOperation);
  const checkThreadCreateOperation = useStore((s) => s.checkThreadCreateOperation);
  const acknowledgeUnknownThreadCreate = useStore((s) => s.acknowledgeUnknownThreadCreate);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [creatingThread, setCreatingThread] = useState(false);
  const [createThreadError, setCreateThreadError] = useState<string | null>(null);
  const creatingThreadRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    // React StrictMode replays effect setup/cleanup while preserving refs.
    // Re-arm the guard on the second setup or async completion would be
    // mistaken for an update after unmount and leave the button locked.
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  function startNewThread(): void {
    if (creatingThreadRef.current) return;
    creatingThreadRef.current = true;
    setCreatingThread(true);
    setCreateThreadError(null);
    void (async () => {
      try {
        await newThread();
      } catch (error) {
        if (mounted.current) setCreateThreadError((error instanceof Error ? error.message : String(error)).slice(0, 1_000) || "新建会话失败");
      } finally {
        creatingThreadRef.current = false;
        if (mounted.current) setCreatingThread(false);
      }
    })();
  }

  return (
    <aside className="sb">
      <div className="sb-label-row">
        <span className="sb-label">项目</span>
        <button className="sb-add" title="添加项目" onClick={() => setPickerOpen(true)}>
          ＋
        </button>
      </div>
      <div className="sb-projects">
        {projectsLoad.state === "loading" && projects.length === 0 && <div className="sb-empty">项目加载中…</div>}
        {projectsLoad.state === "error" && (
          <div className="error-text sb-load-error" role="alert">
            <span>{projectsLoad.error ?? "项目列表读取失败。"}</span>
            <button className="btn" onClick={() => void refreshProjects()}>重试</button>
          </div>
        )}
        {projects.map((project) => (
          <ProjectRow
            key={project.path}
            project={project}
            current={project.path === currentProject}
            showRemove={projects.length > 1 || project.available === false}
            selectProject={selectProject}
            removeProject={removeProject}
          />
        ))}
        {projectsLoad.state === "loaded" && projects.length === 0 && <div className="sb-empty">尚未添加项目</div>}
      </div>

      <button
        className="sb-new"
        disabled={creatingThread || threadCreateOperation?.state === "unknown" || !currentProject}
        onClick={startNewThread}
      >
        {creatingThread ? "新建中…" : "＋ 新对话"}
      </button>
      {createThreadError && <div className="error-text sb-create-error" role="alert">{createThreadError}</div>}
      {threadCreateOperation?.state === "unknown" && (
        <div className="error-text sb-create-error" role="alert">
          <span>{threadCreateOperation.error ?? "上一次会话创建结果未知；为避免重复创建，未自动重试。"}</span>
          <button className="btn" onClick={() => void checkThreadCreateOperation()}>核对创建状态</button>
          <button
            className="btn"
            onClick={() => acknowledgeUnknownThreadCreate(threadCreateOperation.clientOperationId)}
          >
            已核对列表，允许重试
          </button>
        </div>
      )}
      {threadCreateOperation?.state === "accepted" && (
        <div className="dim sb-create-error" role="status">
          已确认会话创建成功{threadCreateOperation.threadId ? `：${threadCreateOperation.threadId}` : ""}
        </div>
      )}
      {(threadCreateOperation?.state === "rejected" || threadCreateOperation?.state === "not_received") && (
        <div className="error-text sb-create-error" role="alert">
          {threadCreateOperation.error ?? "会话创建未执行，可以安全重试。"}
        </div>
      )}

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
        {sessionLoad.state === "error" && (
          <div className="error-text sb-load-error" role="alert">
            <span>{sessionLoad.error ?? "会话列表读取失败。"}</span>
            <button className="btn" onClick={() => void (activeThreadId ? refreshSessions() : refresh())}>重试</button>
          </div>
        )}
        {sessionLoading && sessions.length === 0 && <div className="sb-empty">加载中…</div>}
        {sessionLoading && sessions.length > 0 && <div className="dim sb-refreshing" role="status">正在刷新会话列表…</div>}
        {sessions.map((s) => (
          <SessionRow
            key={s.threadId}
            session={s}
            active={s.threadId === activeThreadId}
            archived={sessionArchived}
            onOpen={openThread}
          />
        ))}
        {sessionLoad.state === "loaded" && !sessionLoading && sessions.length === 0 && (
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

function ProjectRow({
  project, current, showRemove, selectProject, removeProject,
}: {
  project: ProjectEntry;
  current: boolean;
  showRemove: boolean;
  selectProject: (path: string) => Promise<void>;
  removeProject: (path: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  function run(action: () => Promise<void>, fallback: string): void {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    void action().catch((reason) => {
      if (mounted.current) setError(rowActionError(reason, fallback));
    }).finally(() => {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    });
  }

  return (
    <div className="sb-row-block">
      <div
        className={`sb-project ${current ? "current" : ""}`}
        onClick={() => {
          if (!busyRef.current && project.available !== false) run(() => selectProject(project.path), "项目切换失败");
        }}
        title={project.available === false ? `${project.path}（目录不存在或无权访问，可移除注册）` : project.path}
      >
        <span className="sb-project-dot" aria-hidden />
        <span className="sb-project-name">{pathBasename(project.path)}{project.available === false ? "（不可用）" : ""}</span>
        <span className="sb-time">{relativeTime(Math.floor(project.lastUsedAt / 1000))}</span>
        {showRemove && (
          <button
            className="sb-x"
            title="移除注册（不删除文件）"
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              if (busyRef.current) return;
              if (confirm(`从列表移除项目？\n${project.path}\n（仅移除注册，不会删除任何文件或会话）`)) {
                run(() => removeProject(project.path), "移除项目失败");
              }
            }}
          >
            {busy ? "…" : "×"}
          </button>
        )}
      </div>
      {error && <div className="error-text sb-row-error" role="alert">{error}</div>}
    </div>
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
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const actionBusyRef = useRef(false);
  const cancelRenameRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  function runAction(action: () => Promise<void>): void {
    if (actionBusyRef.current) return;
    actionBusyRef.current = true;
    setActionBusy(true);
    setActionError(null);
    void (async () => {
      try {
        await action();
      } catch (error) {
        if (mounted.current) setActionError(rowActionError(error, "会话操作失败"));
      } finally {
        actionBusyRef.current = false;
        if (mounted.current) setActionBusy(false);
      }
    })();
  }

  function commitRename() {
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false;
      return;
    }
    setEditing(false);
    const name = draft.trim();
    if (name && name !== session.title) runAction(() => renameThread(session.threadId, name));
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
            if (e.key === "Escape") {
              cancelRenameRef.current = true;
              setDraft(session.title);
              setEditing(false);
            }
          }}
        />
      </div>
    );
  }

  return <>
    <div className={`sb-session ${active ? "current" : ""}`} onClick={() => { if (!actionBusyRef.current) void onOpen(session.threadId); }}>
      <span className="sb-session-title">{session.title}</span>
      <span className="sb-time">{relativeTime(session.updatedAt)}</span>
      <span className="sb-actions" onClick={(e) => e.stopPropagation()}>
        {!archived && (
          <button className="sb-x" title="重命名" disabled={actionBusy} onClick={() => { cancelRenameRef.current = false; setDraft(session.title); setEditing(true); }}>
            ✎
          </button>
        )}
        {archived ? (
          <>
            <button className="sb-x" title="恢复到当前会话" disabled={actionBusy} onClick={() => runAction(() => unarchiveThread(session.threadId))}>
              ↩
            </button>
            <button
              className="sb-x sb-x-danger"
              title="永久删除"
              disabled={actionBusy}
              onClick={() => {
                if (confirm(`永久删除归档会话「${session.title}」？此操作不可恢复。`)) runAction(() => deleteThread(session.threadId));
              }}
            >
              🗑
            </button>
          </>
        ) : (
          <>
            <button className="sb-x" title="归档" disabled={actionBusy} onClick={() => runAction(() => archiveThread(session.threadId))}>
              ⬇
            </button>
            <button
              className="sb-x sb-x-danger"
              title="删除"
              disabled={actionBusy}
              onClick={() => {
                if (confirm(`删除会话「${session.title}」？此操作不可恢复。`)) runAction(() => deleteThread(session.threadId));
              }}
            >
              🗑
            </button>
          </>
        )}
      </span>
    </div>
    {actionError && <div className="error-text sb-row-error" role="alert">{actionError}</div>}
  </>;
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
  const [browsing, setBrowsing] = useState(false);
  const browseRequest = useRef(0);
  const submitActive = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      browseRequest.current += 1;
    };
  }, []);

  async function browse(dir: string) {
    const request = ++browseRequest.current;
    setError("");
    setBrowsing(true);
    try {
      const res = await gateway.rpc<any>("fs/readDirectory", { path: dir });
      if (!mounted.current || request !== browseRequest.current) return;
      if (!Array.isArray(res?.entries)) throw new Error("服务器返回的目录列表格式无效");
      const list: Array<{ fileName: string; isDirectory: true }> = [];
      const inspected = Math.min(res.entries.length, 20_000);
      for (let index = 0; index < inspected && list.length < 5_000; index++) {
        const entry: unknown = res.entries[index];
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const record = entry as { fileName?: unknown; isDirectory?: unknown };
        if (record.isDirectory !== true || typeof record.fileName !== "string") continue;
        list.push({ fileName: record.fileName.slice(0, 255), isDirectory: true });
      }
      list.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return String(a.fileName).localeCompare(String(b.fileName));
      });
      setEntries(list);
      setBrowseDir(dir);
      setPath(dir);
    } catch (err: any) {
      if (mounted.current && request === browseRequest.current) setError(String(err?.message ?? err).slice(0, 2_000));
    } finally {
      if (mounted.current && request === browseRequest.current) setBrowsing(false);
    }
  }

  async function submit() {
    if (submitActive.current) return;
    submitActive.current = true;
    browseRequest.current += 1;
    setBusy(true);
    setBrowsing(false);
    setError("");
    try {
      const target = path.trim().slice(0, 4096);
      const registeredPath = await addProject(target, create);
      await selectProject(registeredPath);
      if (mounted.current) onClose();
    } catch (err: any) {
      if (mounted.current) setError(String(err?.message ?? err).slice(0, 2_000));
    } finally {
      submitActive.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>添加项目</h3>
        <p className="dim">输入服务器上的绝对路径，或浏览目录选择。新会话将以此目录为工作区。</p>
        <input
          className="text-input"
          placeholder="/home/user/my-project"
          value={path}
          disabled={busy}
          onChange={(e) => { browseRequest.current += 1; setBrowsing(false); setPath(e.target.value); }}
          maxLength={4096}
        />
        <label className="check-line">
          <input type="checkbox" checked={create} disabled={busy} onChange={(e) => setCreate(e.target.checked)} />
          目录不存在时自动创建
        </label>
        {error && <div className="error-text">{error}</div>}
        {browseDir !== null && (
          <div className="dir-browser">
            <div className="dir-browser-head">
              <button className="btn" disabled={browsing || busy} onClick={() => void browse(parentOf(browseDir))}>
                ↑ 上级
              </button>
              <code className="dir-browser-path">{browseDir}</code>
            </div>
            <div className="dir-browser-list">
              {entries.length === 0 && <div className="dim">（无子目录）</div>}
              {entries.map((e) => (
                <button key={e.fileName} className="dir-entry" disabled={browsing || busy} onClick={() => void browse(joinDir(browseDir, e.fileName))}>
                  📁 {e.fileName}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="approval-actions">
          <button className="btn" disabled={browsing || busy} onClick={() => void browse(browseDir ?? guessRoot(workspaceRoot))}>
            {browsing ? "浏览中…" : "浏览目录"}
          </button>
          <span className="spacer" />
          <button className="btn" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="btn-primary" disabled={!path.trim() || busy || browsing} onClick={() => void submit()}>
            添加
          </button>
        </div>
      </div>
    </div>
  );
}

export function parentOf(dir: string): string {
  if (/^[\\/]+$/.test(dir)) return dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  const norm = dir.replace(/[\\/]+$/, "");
  if (/^[A-Za-z]:$/.test(norm)) return `${norm}${dir.includes("/") && !dir.includes("\\") ? "/" : "\\"}`;
  // A UNC share is a filesystem root. Navigating to \\server is not a
  // meaningful directory and can produce confusing provider-specific errors.
  if (/^\\\\[^\\]+\\[^\\]+$/.test(norm)) return norm;
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
