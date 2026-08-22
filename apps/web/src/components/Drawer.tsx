import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { gateway } from "../api/ws";
import { useStore } from "../store";
import { DiffView } from "./Timeline";

/**
 * Bottom drawer hosting the aggregate turn diff and PTY terminals.
 * Terminal bytes bypass the zustand store for performance: xterm instances
 * subscribe directly to command/exec/outputDelta notifications. Terminals are
 * session-scoped: closing this panel terminates all PTY processes (no orphan
 * shells accumulate). App-server restarts are handled via terminal/allExited.
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
  const activeThreadId = useStore((s) => s.activeThreadId);
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

function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

let termCounter = 0;

function TerminalTab() {
  const [terms, setTerms] = useState<TermState[]>([]);
  const [activePid, setActivePid] = useState<string | null>(null);
  // Each terminal gets its own persistent DOM container; switching tabs just
  // shows/hides containers. xterm's open() should only be called once per
  // Terminal instance, and re-opening after replaceChildren() is fragile.
  const hostRef = useRef<HTMLDivElement>(null);
  const containerRefs = useRef(new Map<string, HTMLDivElement>());
  const terminals = useRef(new Map<string, { term: Terminal; fit: FitAddon }>());

  useEffect(() => {
    return gateway.onNotification((method, params: any) => {
      const pid = params?.processId;
      if (method === "terminal/allExited") {
        // App-server restarted — all connection-scoped PTYs died without
        // per-process notifications. Mark every terminal as exited.
        for (const [id, entry] of terminals.current) {
          entry.term.writeln("\r\n\x1b[90m[服务器重启，进程已终止]\x1b[0m");
        }
        setTerms((prev) => prev.map((t) => ({ ...t, exited: true })));
        return;
      }
      if (typeof pid !== "string") return;
      const entry = terminals.current.get(pid);
      if (!entry) return;
      if (method === "command/exec/outputDelta" && typeof params.deltaBase64 === "string") {
        try {
          entry.term.write(base64ToBytes(params.deltaBase64));
        } catch {
          /* partial base64 chunk; dropped */
        }
      } else if (method === "terminal/exited") {
        entry.term.writeln(`\r\n\x1b[90m[进程已退出${params.exitCode != null ? `，exit ${params.exitCode}` : ""}]\x1b[0m`);
        setTerms((prev) => prev.map((t) => (t.processId === pid ? { ...t, exited: true } : t)));
      }
    });
  }, []);

  useEffect(() => {
    return () => {
      // Kill PTYs and dispose xterm instances on unmount (drawer closed,
      // page navigating). Terminals are session-scoped by design — they do
      // NOT survive closing the drawer.
      for (const pid of terminals.current.keys()) {
        void gateway.rpc("terminal/terminate", { processId: pid }).catch(() => {});
      }
      for (const { term } of terminals.current.values()) term.dispose();
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
      entry.fit.fit();
      entry.term.focus();
    }
  }, [activePid]);

  async function newTerminal() {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontSize: 14,
      cursorBlink: true,
      theme: { background: "#11151c" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    try {
      const res = await gateway.rpc<{ processId: string }>("terminal/exec", { cols: term.cols, rows: term.rows });
      const processId = res?.processId;
      if (typeof processId !== "string") throw new Error("gateway returned no processId");

      // Create a dedicated container, open xterm into it once, keep it.
      const container = document.createElement("div");
      container.className = "term-container";
      host.appendChild(container);
      containerRefs.current.set(processId, container);
      term.open(container);
      fit.fit();

      terminals.current.set(processId, { term, fit });
      termCounter += 1;
      setTerms((prev) => [...prev, { processId, title: `终端 ${termCounter}`, exited: false }]);
      setActivePid(processId);

      term.onData((data) => {
        void gateway.rpc("terminal/write", { processId, base64: utf8ToBase64(data) }).catch(() => {});
      });
      term.onResize(({ cols, rows }) => {
        void gateway.rpc("terminal/resize", { processId, cols, rows }).catch(() => {});
      });
      term.focus();
    } catch (err: any) {
      term.writeln(`无法启动终端: ${err.message}`);
      term.dispose();
    }
  }

  function closeTerminal(pid: string) {
    const entry = terminals.current.get(pid);
    if (!entry) return;
    void gateway.rpc("terminal/terminate", { processId: pid }).catch(() => {});
    entry.term.dispose();
    terminals.current.delete(pid);
    const container = containerRefs.current.get(pid);
    if (container) {
      container.remove();
      containerRefs.current.delete(pid);
    }
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
        <button className="btn" onClick={() => void newTerminal()}>
          ＋ 新终端
        </button>
      </div>
      <div ref={hostRef} className="term-host" />
      {terms.length === 0 && (
        <div className="dim term-hint">点击「＋ 新终端」在服务器上打开一个 shell（关闭底部面板会结束所有终端）</div>
      )}
    </div>
  );
}
