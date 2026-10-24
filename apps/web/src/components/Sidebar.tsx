import { useEffect, useRef, useState } from "react";
import { useStore, type ProjectEntry, type ThreadCreateOperation } from "../store";
import { gateway } from "../api/ws";
import { relativeTime, pathBasename } from "../utils/time";
import { isComposingKey } from "../utils/keyboard";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";

function rowActionError(error: unknown, fallback: string): string {
  try {
    return (error instanceof Error ? error.message : String(error)).slice(0, 1_000) || fallback;
  } catch {
    return fallback;
  }
}

/** Project and conversation navigation; mutation controls remain separate from selection. */
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
  const threadCreateOperations = useStore((s) => s.threadCreateOperationRecords);
  const threadCreateOverflow = useStore((s) => s.threadCreateOperationOverflow);
  const threadCreateStorageError = useStore((s) => s.threadCreateStorageError);
  const threadCreateInFlight = useStore((s) => s.threadCreateInFlight);
  const refreshThreadCreateOperations = useStore((s) => s.refreshThreadCreateOperations);

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
    <aside className="sb" aria-label="项目与会话">
      <button
        type="button"
        className="sb-new"
        disabled={creatingThread || !!threadCreateInFlight || threadCreateOverflow || !!threadCreateStorageError || Object.values(threadCreateOperations).some((operation) => operation.state === "unknown") || !currentProject}
        onClick={startNewThread}
      >
        <Icon name="plus" /><span>{creatingThread ? "新建中…" : "新对话"}</span>
      </button>
      {createThreadError && <div className="error-text sb-create-error" role="alert">{createThreadError}</div>}
      {(Object.keys(threadCreateOperations).length > 0 || threadCreateOverflow || threadCreateStorageError) && (
        <section className="sb-create-recovery" aria-label="会话创建记录" tabIndex={0}>
          <h2 className="sb-label">会话创建记录（{Object.keys(threadCreateOperations).length}）</h2>
          {threadCreateStorageError && <p className="error-text" role="alert">{threadCreateStorageError}</p>}
          {threadCreateOverflow && <p className="error-text" role="alert">创建记录超过读取容量；已暂停新建，原记录未删除。请逐项处理，处理后会继续读取剩余记录。</p>}
          {(threadCreateStorageError || threadCreateOverflow) && <button type="button" className="btn" onClick={() => refreshThreadCreateOperations(true)}>重试读取创建记录</button>}
          {Object.values(threadCreateOperations).map((operation) => <ThreadCreateRecoveryRow key={operation.clientOperationId} operation={operation} inFlight={threadCreateInFlight === operation.clientOperationId} />)}
        </section>
      )}

      <div className="sb-label-row">
        <h2 className="sb-label">工作区</h2>
        <button type="button" className="sb-add" title="添加项目" aria-label="添加项目" onClick={() => setPickerOpen(true)}>
          <Icon name="plus" />
        </button>
      </div>
      <div className="sb-projects" aria-label="项目列表">
        {projectsLoad.state === "loading" && projects.length === 0 && <div className="sb-empty" role="status">项目加载中…</div>}
        {projectsLoad.state === "error" && (
          <div className="error-text sb-load-error" role="alert">
            <span>{projectsLoad.error ?? "项目列表读取失败。"}</span>
            <button type="button" className="btn" onClick={() => void refreshProjects()}>重试</button>
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

      <div className="sb-session-controls">
        <div className="sb-label-row"><h2 className="sb-label">会话</h2></div>
        <label className="sb-search-field">
        <Icon name="search" />
        <input
          className="sb-search"
          type="search"
          aria-label="搜索会话标题"
          placeholder="搜索会话标题…"
          value={sessionSearch}
          onChange={(e) => setSessionSearch(e.target.value)}
          maxLength={200}
        />
        </label>
        <div className="sb-arch-tabs" role="group" aria-label="会话范围">
          <button
            type="button"
            className={`sb-arch-tab ${!sessionArchived ? "active" : ""}`}
            aria-pressed={!sessionArchived}
            onClick={() => setSessionArchived(false)}
          >
            当前
          </button>
          <button
            type="button"
            className={`sb-arch-tab ${sessionArchived ? "active" : ""}`}
            aria-pressed={sessionArchived}
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
            <button type="button" className="btn" onClick={() => void (activeThreadId ? refreshSessions() : refresh())}>重试</button>
          </div>
        )}
        {sessionLoading && sessions.length === 0 && <div className="sb-empty" role="status">加载中…</div>}
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
            {sessionSearch ? `没有匹配「${sessionSearch}」的${sessionArchived ? "归档" : ""}会话` : sessionArchived ? "还没有归档会话" : "当前项目还没有会话"}
          </div>
        )}
        {sessionCursor && (
          <button type="button" className="sb-load-more" onClick={() => void loadMoreSessions()} disabled={sessionLoadingMore}>
            {sessionLoadingMore ? "加载中…" : "加载更多"}
          </button>
        )}
      </div>

      {pickerOpen && <ProjectPicker onClose={() => setPickerOpen(false)} />}
    </aside>
  );
}

function ThreadCreateRecoveryRow({ operation, inFlight }: { operation: ThreadCreateOperation; inFlight: boolean }) {
  const check = useStore((s) => s.checkThreadCreateOperation);
  const open = useStore((s) => s.openCreatedThread);
  const acknowledge = useStore((s) => s.acknowledgeUnknownThreadCreate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function run(action: () => Promise<unknown> | boolean): void {
    if (busyRef.current || inFlight) return;
    busyRef.current = true; setBusy(true); setError(null);
    void Promise.resolve().then(action).then((result) => {
      if (result === false && mounted.current) setError("此记录尚未处理成功；请检查存储状态或会话所属项目后重试。");
    }).catch((reason) => { if (mounted.current) setError(rowActionError(reason, "创建记录处理失败")); }).finally(() => {
      busyRef.current = false; if (mounted.current) setBusy(false);
    });
  }
  return <article className="sb-create-record" aria-label={"创建记录：" + operation.clientOperationId} aria-busy={busy || inFlight}>
    <div className="dim">项目：{operation.cwd}</div>
    <code>{operation.clientOperationId}</code>
    <p>{inFlight ? "本页正在创建，请等待请求结束。" : operation.state === "unknown" ? operation.error ?? "创建结果未知；不会自动重试。"
      : operation.state === "accepted" ? "已确认创建成功：" + operation.threadId : operation.state === "acknowledged_unknown" ? "已确认放弃此条未知记录。" : operation.error ?? "网关确认此创建未执行。"}</p>
    {!inFlight && operation.state === "unknown" && <>
      <button type="button" className="btn" disabled={busy} onClick={() => run(() => check(operation.clientOperationId))}>核对创建状态</button>
      <button type="button" className="btn" disabled={busy} onClick={() => {
        if (confirm("请先核对项目的会话列表。放弃这条未知记录并不表示创建失败，继续新建可能产生重复会话。确认放弃？")) run(() => acknowledge(operation.clientOperationId));
      }}>已核对，放弃此条记录</button>
    </>}
    {!inFlight && operation.state === "accepted" && <button type="button" className="btn" disabled={busy} onClick={() => run(() => open(operation.clientOperationId))}>打开已创建会话</button>}
    {!inFlight && operation.state !== "unknown" && operation.state !== "accepted" && <button type="button" className="btn" disabled={busy} onClick={() => run(() => acknowledge(operation.clientOperationId))}>移除此条记录</button>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </article>;
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
    void Promise.resolve().then(action).catch((reason) => {
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
      >
        <button
          type="button"
          className="sb-row-main"
          aria-current={current ? "true" : undefined}
          aria-label={`切换项目：${project.path}${project.available === false ? "（不可用）" : ""}`}
          disabled={busy || project.available === false}
          onClick={() => {
            if (project.available !== false) run(() => selectProject(project.path), "项目切换失败");
          }}
          title={project.available === false ? `${project.path}（目录不存在或无权访问，可移除注册）` : project.path}
        >
          <Icon name="folder" />
          <span className="sb-project-name">{pathBasename(project.path)}{project.available === false ? "（不可用）" : ""}</span>
          <span className="sb-time">{relativeTime(Math.floor(project.lastUsedAt / 1000))}</span>
        </button>
        {showRemove && (
          <button
            type="button"
            className="sb-x"
            title="移除注册（不删除文件）"
            aria-label={`移除项目注册（不删除文件）：${project.path}`}
            disabled={busy}
            onClick={() => {
              if (busyRef.current) return;
              if (confirm(`从列表移除项目？\n${project.path}\n（仅移除注册，不会删除任何文件或会话）`)) {
                run(() => removeProject(project.path), "移除项目失败");
              }
            }}
          >
            <Icon name="close" />
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
          aria-label="会话名称"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={200}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (isComposingKey(e)) return;
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
    <div className={`sb-session ${active ? "current" : ""}`}>
      <button type="button" className="sb-row-main" disabled={actionBusy}
        aria-current={active ? "page" : undefined} aria-label={`打开会话：${session.title}`}
        title={session.title} onClick={() => runAction(() => onOpen(session.threadId))}>
        <Icon name="chat" />
        <span className="sb-session-title">{session.title}</span>
        <span className="sb-time">{relativeTime(session.updatedAt)}</span>
      </button>
      <span className="sb-actions">
        {!archived && (
          <button type="button" className="sb-x" title="重命名" aria-label={`重命名会话：${session.title}`} disabled={actionBusy} onClick={() => { if (actionBusyRef.current) return; cancelRenameRef.current = false; setDraft(session.title); setEditing(true); }}>
            <Icon name="edit" />
          </button>
        )}
        {archived ? (
          <>
            <button type="button" className="sb-x" title="恢复到当前会话" aria-label={`恢复会话：${session.title}`} disabled={actionBusy} onClick={() => runAction(() => unarchiveThread(session.threadId))}>
              <Icon name="restore" />
            </button>
            <button
              className="sb-x sb-x-danger"
              type="button"
              title="永久删除"
              aria-label={`永久删除会话：${session.title}`}
              disabled={actionBusy}
              onClick={() => {
                if (actionBusyRef.current) return;
                if (confirm(`永久删除归档会话「${session.title}」？此操作不可恢复。`)) runAction(() => deleteThread(session.threadId));
              }}
            >
              <Icon name="trash" />
            </button>
          </>
        ) : (
          <>
            <button type="button" className="sb-x" title="归档" aria-label={`归档会话：${session.title}`} disabled={actionBusy} onClick={() => runAction(() => archiveThread(session.threadId))}>
              <Icon name="archive" />
            </button>
            <button
              className="sb-x sb-x-danger"
              type="button"
              title="删除"
              aria-label={`删除会话：${session.title}`}
              disabled={actionBusy}
              onClick={() => {
                if (actionBusyRef.current) return;
                if (confirm(`删除会话「${session.title}」？此操作不可恢复。`)) runAction(() => deleteThread(session.threadId));
              }}
            >
              <Icon name="trash" />
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
  const [listingLimited, setListingLimited] = useState(false);
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
      let index = 0;
      for (; index < inspected && list.length < 5_000; index++) {
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
      setListingLimited(index < res.entries.length);
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
    <Dialog label="添加项目" onClose={onClose} busy={busy}>
        <h3>添加项目</h3>
        <p className="dim">选择运行 Harness 的服务器上的目录。新会话将以此目录为工作区；这里不会上传你电脑上的文件。</p>
        <label className="field">
        <span>服务器项目路径</span>
        <input
          className="text-input"
          aria-label="服务器项目绝对路径"
          placeholder="/home/user/my-project"
          value={path}
          disabled={busy}
          onChange={(e) => { browseRequest.current += 1; setBrowsing(false); setPath(e.target.value); }}
          maxLength={4096}
        />
        <span className="dim">输入绝对路径，或使用下方的目录浏览。</span>
        </label>
        <label className="check-line">
          <input type="checkbox" checked={create} disabled={busy} onChange={(e) => setCreate(e.target.checked)} />
          目录不存在时自动创建
        </label>
        {error && <div className="error-text" role="alert">{error}</div>}
        {browsing && <div className="dim" role="status">正在读取服务器目录…</div>}
        {browseDir !== null && (
          <div className="dir-browser" aria-busy={browsing}>
            <div className="dir-browser-head">
              <button type="button" className="btn" aria-label="浏览上级目录" disabled={browsing || busy} onClick={() => void browse(parentOf(browseDir))}>
                <Icon name="arrow" /><span>上级</span>
              </button>
              <code className="dir-browser-path">{browseDir}</code>
            </div>
            <div className="dir-browser-list">
              {!browsing && entries.length === 0 && <div className="dim">此目录没有可显示的子目录，可直接添加当前路径。</div>}
              {entries.map((e) => (
                <button type="button" key={e.fileName} className="dir-entry" aria-label={`浏览目录：${e.fileName}`} disabled={browsing || busy} onClick={() => void browse(joinDir(browseDir, e.fileName))}>
                  <Icon name="folder" /><span>{e.fileName}</span><Icon name="chevron" />
                </button>
              ))}
            </div>
            {listingLimited && <p className="dim" role="status">目录条目过多，仅显示部分结果。可以在上方直接输入完整路径。</p>}
          </div>
        )}
        <div className="approval-actions">
          <button type="button" className="btn" disabled={browsing || busy} onClick={() => void browse(path.trim() || browseDir || guessRoot(workspaceRoot))}>
            {browsing ? "浏览中…" : "浏览目录"}
          </button>
          <span className="spacer" />
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn-primary" disabled={!path.trim() || busy || browsing} onClick={() => void submit()}>
            添加
          </button>
        </div>
    </Dialog>
  );
}

export function parentOf(dir: string): string {
  // A leading slash denotes a POSIX path, even when the filename contains
  // a literal backslash. Do not reinterpret a Linux filename as Windows.
  if (dir.startsWith("/")) {
    const norm = dir.replace(/\/+$/, "");
    return norm.slice(0, norm.lastIndexOf("/")) || "/";
  }
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

export function joinDir(dir: string, name: string): string {
  if (dir.startsWith("/")) return dir.replace(/\/+$/, "") + "/" + name;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
}

function guessRoot(workspaceRoot: string): string {
  if (!workspaceRoot) return "/";
  return parentOf(workspaceRoot);
}
