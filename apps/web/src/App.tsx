import { useEffect, useRef, useState } from "react";
import { useStore } from "./store";
import { Sidebar } from "./components/Sidebar";
import { Timeline } from "./components/Timeline";
import { Composer } from "./components/Composer";
import { Drawer } from "./components/Drawer";
import { LoginModal } from "./components/LoginModal";
import { SettingsModal } from "./components/SettingsModal";
import { Icon } from "./components/Icon";
import { pathBasename } from "./utils/time";
import { isComposingKey } from "./utils/keyboard";

export function App() {
  const bootstrap = useStore((s) => s.bootstrap);
  const connection = useStore((s) => s.connection);
  const connectionError = useStore((s) => s.connectionError);
  const appStatusLoad = useStore((s) => s.appStatusLoad);
  const refresh = useStore((s) => s.refresh);
  const codexState = useStore((s) => s.codexState);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const globalWarnings = useStore((s) => s.globalWarnings);
  const dismissGlobalWarning = useStore((s) => s.dismissGlobalWarning);
  const currentProject = useStore((s) => s.currentProject);
  const activeThreadId = useStore((s) => s.activeThreadId);
  const title = useStore((s) => s.sessions?.find((session) => session.threadId === s.activeThreadId)?.title);
  const turnActive = useStore((s) => s.activeThreadId ? s.turnActive[s.activeThreadId] : false);
  const setDrawerTab = useStore((s) => s.setDrawerTab);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [suggestion, setSuggestion] = useState<{ text: string; sequence: number }>();
  const mobileMenu = useRef<HTMLButtonElement>(null);
  const navigation = useRef<HTMLDivElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const collapseButton = useRef<HTMLButtonElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const collapseChanged = useRef(false);

  useEffect(() => { bootstrap(); }, [bootstrap]);
  useEffect(() => {
    if (collapseChanged.current) (collapsed ? expandButton : collapseButton).current?.focus();
  }, [collapsed]);
  useEffect(() => {
    const nav = navigation.current;
    const content = workspace.current;
    if (!sidebarOpen || !nav || !content) return;
    const mobile = window.matchMedia("(max-width: 768px)");
    const candidates = () => Array.from(nav.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [href], [tabindex="0"]'))
      .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
    const sync = () => {
      content.inert = mobile.matches;
      if (mobile.matches && !document.querySelector('[role="dialog"]') && !nav.contains(document.activeElement)) candidates()[0]?.focus();
    };
    sync(); mobile.addEventListener("change", sync);
    const escape = (event: KeyboardEvent) => {
      if (!mobile.matches || document.querySelector('[role="dialog"]') || isComposingKey(event)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setSidebarOpen(false); mobileMenu.current?.focus();
      }
      if (event.key === "Tab") {
        const elements = candidates(); const first = elements[0]; const last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last || !nav.contains(document.activeElement)) {
          event.preventDefault(); (event.shiftKey ? last : first)?.focus();
        }
      }
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("keydown", escape); mobile.removeEventListener("change", sync);
      content.inert = false;
      if (mobile.matches) mobileMenu.current?.focus();
    };
  }, [sidebarOpen, setSidebarOpen]);

  const status = connection !== "open" ? connection === "connecting" ? "连接中" : "连接已断开"
    : appStatusLoad.state === "loading" ? "读取服务状态" : appStatusLoad.state === "error" ? "服务状态未知"
      : codexState !== "ready" ? "Codex · " + codexState : "已连接";
  const ready = connection === "open" && appStatusLoad.state === "loaded" && codexState === "ready";

  return <div className={"app" + (collapsed ? " nav-collapsed" : "")}>
    <a className="skip-link" href="#message-input">跳到消息输入</a>
    <div ref={navigation} className={"sidebar-wrap " + (sidebarOpen ? "open" : "")} id="workspace-navigation">
      <div className="sidebar-brand">
        <span className="brand-mark"><Icon name="code" /></span>
        <div className="brand">Codex <span>Harness</span></div>
        <button ref={collapseButton} className="icon-btn sidebar-collapse" aria-label="收起侧边栏" onClick={() => { collapseChanged.current = true; setCollapsed(true); }}><Icon name="panel" /></button>
        <button className="icon-btn sidebar-mobile-close" aria-label="关闭导航" onClick={() => { setSidebarOpen(false); mobileMenu.current?.focus(); }}><Icon name="close" /></button>
      </div>
      <Sidebar />
      <div className="sidebar-footer">
        <LoginModal />
        <button className="icon-btn" aria-label="设置" title="设置" onClick={() => setSettingsOpen(true)}><Icon name="settings" /></button>
      </div>
    </div>
    {sidebarOpen && <button className="sidebar-backdrop" aria-label="关闭导航遮罩" onClick={() => setSidebarOpen(false)} />}
    {collapsed && <nav className="collapsed-rail" aria-label="快捷导航">
      <span className="brand-mark"><Icon name="code" /></span>
      <button ref={expandButton} className="icon-btn" title="展开侧边栏" aria-label="展开侧边栏" onClick={() => { collapseChanged.current = true; setCollapsed(false); }}><Icon name="panel" /></button>
      <button className="icon-btn" aria-label="打开改动面板" onClick={() => setDrawerTab("diff")}><Icon name="changes" /></button>
      <button className="icon-btn" aria-label="打开终端面板" onClick={() => setDrawerTab("terminal")}><Icon name="terminal" /></button>
      <span className="spacer" />
      <button className="icon-btn" aria-label="设置" onClick={() => setSettingsOpen(true)}><Icon name="settings" /></button>
    </nav>}
    <div ref={workspace} className="workspace">
      <header className="workspace-header">
        <button ref={mobileMenu} className="icon-btn hamburger" aria-label="打开导航" aria-expanded={sidebarOpen} aria-controls="workspace-navigation" onClick={() => setSidebarOpen(!sidebarOpen)}><Icon name="panel" /></button>
        <div className="workspace-heading">
          <div className="workspace-breadcrumb" title={currentProject || "尚未选择项目"}><Icon name="folder" /><span>{currentProject ? pathBasename(currentProject) : "选择一个项目"}</span><Icon name="chevron" /><span>工作台</span></div>
          <h1>{activeThreadId ? title || "当前对话" : "新对话"}</h1>
        </div>
        <div className="workspace-actions">
          <span className={"connection-indicator " + (ready ? "ready" : "pending")} role="status"><i />{status}</span>
          <button className="icon-btn" title="查看文件改动" aria-label="查看文件改动" onClick={() => setDrawerTab("diff")}><Icon name="changes" /></button>
          <button className="icon-btn" title="打开终端" aria-label="打开终端" onClick={() => setDrawerTab("terminal")}><Icon name="terminal" /></button>
          <button className="icon-btn header-settings" aria-label="设置" onClick={() => setSettingsOpen(true)}><Icon name="settings" /></button>
        </div>
      </header>
      <div className="workspace-alerts">
        {connectionError && <div className="error-text" role="alert">{connectionError} <button className="btn" onClick={() => location.reload()}>重新认证 / 刷新</button></div>}
        {connection === "open" && appStatusLoad.state === "error" && <div className="error-text" role="alert">{appStatusLoad.error ?? "应用状态读取失败，当前状态未知。"} <button className="btn" onClick={() => void refresh()}>重试读取</button></div>}
        {globalWarnings.map((warning) => <div className="error-text" role="alert" key={warning.id}>{warning.message} <button className="btn" aria-label="关闭警告" onClick={() => dismissGlobalWarning(warning.id)}>关闭</button></div>)}
      </div>
      <main className="main" aria-label="对话工作区">
        <Timeline onSuggestion={(text) => setSuggestion((previous) => ({ text, sequence: (previous?.sequence ?? 0) + 1 }))} />
        {turnActive && <div className="run-indicator" role="status"><span />Codex 正在处理任务<span className="dim">你可以查看过程，或在输入区停止</span></div>}
        <Composer suggestion={suggestion} />
      </main>
      <Drawer />
    </div>
    <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
  </div>;
}
