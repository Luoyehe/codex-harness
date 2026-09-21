import { useEffect, useState } from "react";
import { useStore } from "./store";
import { Sidebar } from "./components/Sidebar";
import { Timeline } from "./components/Timeline";
import { Composer } from "./components/Composer";
import { Drawer } from "./components/Drawer";
import { LoginModal } from "./components/LoginModal";
import { SettingsModal } from "./components/SettingsModal";

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
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand-row">
          <button className="icon-btn hamburger" title="菜单" onClick={() => setSidebarOpen(!sidebarOpen)}>
            ☰
          </button>
          <div className="brand">
            Codex <span className="brand-dim">Harness</span>
          </div>
        </div>
        <div className="topbar-status">
          {connection !== "open" && (
            <span className="badge badge-warn">网关{connection === "connecting" ? "连接中" : "已断开"}</span>
          )}
          {connection === "open" && appStatusLoad.state === "loading" && <span className="badge badge-warn">服务状态读取中</span>}
          {connection === "open" && appStatusLoad.state === "error" && <span className="badge badge-warn">服务状态未知</span>}
          {connection === "open" && appStatusLoad.state === "loaded" && codexState !== "ready" && <span className="badge badge-warn">Codex: {codexState}</span>}
          <LoginModal />
          <button className="icon-btn icon-btn-lg" title="设置" onClick={() => setSettingsOpen(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </div>
      </header>
      {connectionError && <div className="error-text" role="alert">{connectionError} <button className="btn" onClick={() => location.reload()}>重新认证 / 刷新</button></div>}
      {connection === "open" && appStatusLoad.state === "error" && (
        <div className="error-text" role="alert">
          {appStatusLoad.error ?? "应用状态读取失败，当前状态未知。"}{" "}
          <button className="btn" onClick={() => void refresh()}>重试读取</button>
        </div>
      )}
      {globalWarnings.map((warning) => (
        <div className="error-text" role="alert" key={warning.id}>
          {warning.message}{" "}
          <button className="btn" aria-label="关闭警告" onClick={() => dismissGlobalWarning(warning.id)}>关闭</button>
        </div>
      ))}
      <div className="body">
        <div className={`sidebar-wrap ${sidebarOpen ? "open" : ""}`}>
          <Sidebar />
        </div>
        {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}
        <main className="main">
          <Timeline />
          <Composer />
        </main>
      </div>
      <Drawer />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
