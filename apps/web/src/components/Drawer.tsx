import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { gateway } from "../api/ws";
import { useStore } from "../store";
import { DiffView } from "./Timeline";
import { TerminalSession } from "../utils/terminal-session";

/**
 * Bottom drawer hosting the aggregate turn diff and PTY terminals.
 * Terminal bytes bypass the zustand store for performance: xterm instances
 * subscribe directly to command/exec/outputDelta notifications. Terminals are
 * panel-scoped: closing this panel terminates its PTYs; the gateway also owns
 * disconnect cleanup. App-server restarts arrive through terminal/allExited.
 */
export function Drawer() {
  const drawerTab = useStore((s) => s.drawerTab);
  const setDrawerTab = useStore((s) => s.setDrawerTab);

  return (
    <div className={`drawer ${drawerTab ? "open" : ""}`}>
      <div className="drawer-tabs">
        <button className={drawerTab === "diff" ? "active" : ""} onClick={() => setDrawerTab(drawerTab === "diff" ? null : "diff")}>
          改动 Diff
        </button>
        <button className={drawerTab === "terminal" ? "active" : ""} onClick={() => setDrawerTab(drawerTab === "terminal" ? null : "terminal")}>
          终端
        </button>
        <span className="spacer" />
      </div>
      {drawerTab === "diff" && <DiffTab />}
      {drawerTab === "terminal" && <TerminalTab />}
    </div>
  );
}

function DiffTab() {
  const diff = useStore((s) => (s.activeThreadId ? s.turnDiff[s.activeThreadId] ?? "" : ""));
  if (!diff) return <div className="drawer-body dim">当前会话还没有文件改动</div>;
  return (
    <div className="drawer-body diff-body">
      <DiffView text={diff} />
    </div>
  );
}

interface TermState {
  processId: string;
  title: string;
  exited: boolean;
}

let termCounter = 0;
const MAX_TERMINALS = 8;

function TerminalTab() {
  const currentProject = useStore((s) => s.currentProject);
  const connection = useStore((s) => s.connection);
  const [terms, setTerms] = useState<TermState[]>([]);
  const [activePid, setActivePid] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  // Each terminal gets its own persistent DOM container; switching tabs just
  // shows/hides containers. xterm's open() should only be called once per
  // Terminal instance, and re-opening after replaceChildren() is fragile.
  const hostRef = useRef<HTMLDivElement>(null);
  const containerRefs = useRef(new Map<string, HTMLDivElement>());
  const terminals = useRef(new Map<string, TerminalSession>());
  const openingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    const notifications = gateway.onNotification((event) => {
      for (const entry of terminals.current.values()) entry.handleNotification(event);
    });
    const states = gateway.onStateChange((state) => {
      if (state === "closed") {
        for (const entry of terminals.current.values()) entry.markExited("连接已断开，进程已终止");
      }
    });
    return () => { notifications(); states(); };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Kill PTYs and dispose xterm instances on unmount (drawer closed,
      // page navigating). Terminals are session-scoped by design — they do
      // NOT survive closing the drawer.
      for (const entry of terminals.current.values()) entry.dispose();
      terminals.current.clear();
      containerRefs.current.clear();
    };
  }, []);

  // Show/hide terminal containers when the active tab changes.
  useEffect(() => {
    for (const [pid, container] of containerRefs.current) {
      container.style.display = pid === activePid ? "" : "none";
    }
    const entry = activePid ? terminals.current.get(activePid) : null;
    if (entry) {
      entry.fitVisible();
      entry.term.focus();
    }
  }, [activePid]);

  async function newTerminal() {
    const host = hostRef.current;
    if (
      !host ||
      openingRef.current ||
      connection !== "open" ||
      terminals.current.size >= MAX_TERMINALS
    ) return;
    openingRef.current = true;
    setOpening(true);
    setTerminalError(null);
    let term: Terminal | undefined;
    let container: HTMLDivElement | undefined;
    let entry: TerminalSession | undefined;

    try {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (!mountedRef.current) return;
      term = new Terminal({ fontSize: 14, cursorBlink: true, theme: { background: "#11151c" } });
      const fit = new FitAddon();
      term.loadAddon(fit);
      container = document.createElement("div");
      container.className = "term-container";
      host.appendChild(container);
      entry = new TerminalSession(term, fit, container, (method, params) => gateway.rpc(method, params), () => {
        const processId = entry!.processId;
        setTerms((prev) => prev.map((t) => t.processId === processId ? { ...t, exited: true } : t));
      });
      const processId = entry.processId;
      // Register before exec so even synchronous output/exit notifications
      // find their terminal. The RPC response never reinitializes this state.
      terminals.current.set(processId, entry);
      containerRefs.current.set(processId, container);
      termCounter += 1;
      setTerms((prev) => [...prev, { processId, title: `终端 ${termCounter}`, exited: false }]);
      setActivePid(processId);
      await entry.start(currentProject);
    } catch (err: any) {
      if (mountedRef.current) setTerminalError(`无法启动终端: ${err?.message ?? err}`);
      if (entry) {
        if (mountedRef.current) entry.markExited(`无法启动终端: ${err?.message ?? err}`);
        else entry.dispose();
      } else { term?.dispose(); container?.remove(); }
    } finally {
      openingRef.current = false;
      if (mountedRef.current) setOpening(false);
    }
  }

  function closeTerminal(pid: string) {
    const entry = terminals.current.get(pid);
    if (!entry) return;
    entry.dispose();
    terminals.current.delete(pid);
    containerRefs.current.delete(pid);
    setTerms((prev) => prev.filter((t) => t.processId !== pid));
    if (activePid === pid) {
      const rest = [...terminals.current.keys()];
      setActivePid(rest.length > 0 ? rest[rest.length - 1] : null);
    }
  }

  return (
    <div className="drawer-body terminal-body">
      <div className="term-tabs">
        {terms.map((t) => (
          <span key={t.processId} className={`term-tab ${t.processId === activePid ? "active" : ""}`}>
            <button className="term-tab-btn" onClick={() => setActivePid(t.processId)}>
              {t.title} {t.exited ? "（已退出）" : ""}
            </button>
            <button className="term-tab-close" onClick={() => closeTerminal(t.processId)} title="关闭">
              ×
            </button>
          </span>
        ))}
        <button
          className="btn"
          disabled={opening || connection !== "open" || terms.length >= MAX_TERMINALS}
          onClick={() => void newTerminal()}
        >
          {opening ? "正在打开…" : "＋ 新终端"}
        </button>
      </div>
      <div ref={hostRef} className="term-host" />
      {terms.length === 0 && (
        <div className="dim term-hint">点击「＋ 新终端」在服务器上打开一个 shell（关闭底部面板会结束所有终端）</div>
      )}
      {terminalError && <div className="error-text term-hint">{terminalError}</div>}
    </div>
  );
}
