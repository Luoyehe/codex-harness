import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { RpcError, type Api, type TerminalOperation } from '../lib/api';
import { acknowledgeOperation, listOperations, type TerminalResult } from '../lib/operations';
import { Events, useSubscription } from '../lib/events';
import { message, type HarnessEvent } from '../lib/types';

function fitTerminal(terminal: Terminal, addon: FitAddon) {
  const proposed = addon.proposeDimensions();
  const bound = (value: number | undefined, fallback: number) => Number.isFinite(value) && value! >= 1 ? Math.min(500, Math.floor(value!)) : fallback;
  const rows = bound(proposed?.rows, bound(terminal.rows, 24));
  const cols = bound(proposed?.cols, bound(terminal.cols, 80));
  if (rows !== terminal.rows || cols !== terminal.cols) terminal.resize(cols, rows);
  return { rows, cols };
}
type OpenAttempt = { operation: TerminalOperation; events: HarnessEvent[]; bytes: number; overflow: boolean; closeOnly: boolean; resolved: boolean };

export function TerminalPanel({ api, events, projectId, connected, epoch, program = 'shell', enabled = true, runtimeEpoch = epoch, onServiceSettings, onShell }: { api: Api; events: Events; projectId: string; connected: boolean; epoch: string; program?: 'shell' | 'codex' | 'codex-cloud'; enabled?: boolean; runtimeEpoch?: string; onServiceSettings?: () => void; onShell?: () => void }) {
  const [restartRequired, setRestartRequired] = useState(false);
  const lastRuntime = useRef(runtimeEpoch);
  useEffect(() => { if (lastRuntime.current !== runtimeEpoch) { lastRuntime.current = runtimeEpoch; setRestartRequired(false); } }, [runtimeEpoch]);
  const container = useRef<HTMLDivElement>(null), term = useRef<Terminal | undefined>(undefined), fit = useRef<FitAddon | undefined>(undefined), terminalId = useRef(''), writeQueue = useRef(Promise.resolve());
  const [id, setId] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [ended, setEnded] = useState(false), [pending, setPending] = useState(false);
  const blocked = useRef(false), closeOnly = useRef(false), queuedBytes = useRef(0), opening = useRef<OpenAttempt | undefined>(undefined);
  const scope = useRef({ projectId, connected, epoch, program }); scope.current = { projectId, connected, epoch, program };
  const mounted = useRef(true), activeOperation = useRef<TerminalOperation | undefined>(undefined);
  const acknowledge = (operation: TerminalOperation) => { try { if (listOperations().some(o => o.id === operation.operationId)) acknowledgeOperation(operation.operationId); } catch (e) { if (mounted.current) setError(`终端状态已确认，但本地回执尚未关闭：${message(e)}`); } };
  const closeTerminal = async (target: string, owner: TerminalOperation) => {
    if (!scope.current.connected || scope.current.epoch !== owner.connectionId || owner.clientId !== api.clientId) return;
    blocked.current = true;
    try {
      try { await api.call('terminal/close', { terminalId: target }); }
      catch (e) { if (!(e instanceof RpcError && e.code === 'not_found')) throw e; }
      acknowledge(owner);
      if (mounted.current && owner.program !== undefined && owner.program !== 'shell' && scope.current.epoch === owner.connectionId) setRestartRequired(true);
      if (mounted.current && terminalId.current === target) { terminalId.current = ''; activeOperation.current = undefined; setId(''); setEnded(true); }
    } catch (e) { if (mounted.current && terminalId.current === target) setError(`${message(e)} 输入已暂停，请重试关闭。`); }
  };
  useEffect(() => {
    mounted.current = true;
    const terminal = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'Cascadia Code, Consolas, monospace', scrollback: 2000, theme: { background: '#161a1a', foreground: '#e1e7e2', cursor: '#9fd0c2' } });
    const addon = new FitAddon(); terminal.loadAddon(addon); terminal.open(container.current!); term.current = terminal; fit.current = addon;
    let resizeTimer: ReturnType<typeof setTimeout>;
    const input = terminal.onData(text => {
      const target = terminalId.current;
      if (!target || blocked.current) return;
      const bytes = new TextEncoder().encode(text).length;
      if (bytes + queuedBytes.current > 65536) { blocked.current = true; setError('待发送终端输入超过 64 KiB。输入已暂停，请关闭后重新打开终端。'); return; }
      queuedBytes.current += bytes;
      writeQueue.current = writeQueue.current.then(async () => { try { if (blocked.current || target !== terminalId.current) return; await api.call('terminal/write', { terminalId: target, text }); } catch (e) { if (target === terminalId.current) { blocked.current = true; setError(`${message(e)} 输入结果可能未知，已暂停输入。请关闭此终端。`); } } finally { queuedBytes.current -= bytes; } });
    });
    const observer = new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { try { const size = fitTerminal(terminal, addon), target = terminalId.current; if (target && !closeOnly.current) void api.call('terminal/resize', { terminalId: target, ...size }).catch(e => { if (terminalId.current === target) setError(message(e)); }); } catch { /* Hidden panels have no fit dimensions. */ } }, 150); });
    observer.observe(container.current!);
    return () => { mounted.current = false; clearTimeout(resizeTimer); observer.disconnect(); input.dispose(); terminal.dispose(); const target = terminalId.current, owner = activeOperation.current; if (target && owner) void closeTerminal(target, owner); };
  }, [api]);
  const previousScope = useRef({ projectId, epoch, program, runtimeEpoch });
  useEffect(() => {
    const changedLease = previousScope.current.epoch !== epoch;
    const changedProject = previousScope.current.projectId !== projectId || previousScope.current.program !== program;
    const changedRuntime = previousScope.current.runtimeEpoch !== runtimeEpoch;
    previousScope.current = { projectId, epoch, program, runtimeEpoch };
    if (!connected || changedLease) {
      if (!changedRuntime && (Boolean(activeOperation.current?.program && activeOperation.current.program !== 'shell') || Boolean(opening.current?.operation.program && opening.current.operation.program !== 'shell'))) setRestartRequired(true);
      opening.current = undefined; setPending(false); setBusy(false); blocked.current = true;
      if (terminalId.current) { terminalId.current = ''; activeOperation.current = undefined; setId(''); setEnded(true); setError('连接已断开，此终端由服务器结束。重新连接后可手动打开新终端。'); }
      term.current?.clear();
    } else if (changedProject) {
      term.current?.clear(); blocked.current = true; closeOnly.current = true;
      if (opening.current) { opening.current.closeOnly = true; setError('先前项目或程序的终端启动仍待确认；请查询并关闭原终端后再打开新终端。'); }
      const target = terminalId.current, owner = activeOperation.current;
      if (target && owner) void closeTerminal(target, owner);
    }
  }, [api, projectId, epoch, connected, program, runtimeEpoch]);
  const applyEvent = useCallback((event: HarnessEvent) => {
    if (!terminalId.current || event.data.terminalId !== terminalId.current) return;
    const d = event.data;
    if (d.type === 'output' && !closeOnly.current && typeof d.deltaBase64 === 'string') { try { term.current?.write(Uint8Array.from(atob(d.deltaBase64), c => c.charCodeAt(0))); } catch { setError('终端输出编码无效。'); } if (d.capReached) setError('终端输出已达到服务器容量上限。'); }
    if (d.type === 'exit') { if (Boolean(activeOperation.current?.program && activeOperation.current.program !== 'shell')) setRestartRequired(true); setEnded(true); terminalId.current = ''; activeOperation.current = undefined; setId(''); blocked.current = true; if (!closeOnly.current) term.current?.writeln(`\r\n[进程已退出：${d.exitCode ?? '未知'}]`); }
    if (d.type === 'error') { setError(String(d.error ?? '终端错误')); blocked.current = true; }
  }, []);
  const handle = useCallback((event: HarnessEvent) => {
    if (event.type !== 'terminal' || event.data.owned !== true || typeof event.data.terminalId !== 'string') return;
    if (event.data.terminalId === terminalId.current) { applyEvent(event); return; }
    const attempt = opening.current;
    if (!attempt || attempt.operation.connectionId !== scope.current.epoch || attempt.overflow) return;
    const bytes = new TextEncoder().encode(JSON.stringify(event.data)).length;
    if (attempt.events.length >= 128 || attempt.bytes + bytes > 262144) { attempt.overflow = true; attempt.events = []; setError('终端启动期间的输出超过 256 KiB 或 128 条上限。取得回执后将关闭此终端。'); return; }
    attempt.bytes += bytes; attempt.events.push(event);
  }, [applyEvent]);
  useSubscription(events, handle);
  const accept = async (attempt: OpenAttempt, result: TerminalResult) => {
    if (attempt.resolved) return;
    attempt.resolved = true;
    const current = scope.current;
    // Replaced worker leases own their own cleanup; never send a saved terminal ID through a new lease.
    if (!current.connected || current.epoch !== attempt.operation.connectionId || attempt.operation.clientId !== api.clientId) return;
    if (!mounted.current) { await closeTerminal(result.terminalId, attempt.operation); return; }
    if (opening.current !== attempt) return;
    opening.current = undefined; setPending(false); setBusy(false);
    terminalId.current = result.terminalId; activeOperation.current = attempt.operation; setId(result.terminalId); setEnded(false);
    closeOnly.current = attempt.closeOnly || attempt.overflow || current.projectId !== attempt.operation.projectId || current.program !== (attempt.operation.program ?? 'shell');
    blocked.current = closeOnly.current;
    if (closeOnly.current) { await closeTerminal(result.terminalId, attempt.operation); return; }
    setError('');
    for (const event of attempt.events) if (event.data.terminalId === result.terminalId) applyEvent(event);
    acknowledge(attempt.operation);
    if (terminalId.current) term.current?.focus();
  };
  const open = async () => {
    if (opening.current || terminalId.current || !connected || !projectId || !enabled || program !== 'shell' && restartRequired) return;
    setBusy(true); setError(''); blocked.current = true;
    let attempt: OpenAttempt | undefined;
    try {
      const size = term.current && fit.current ? fitTerminal(term.current, fit.current) : { rows: 24, cols: 80 };
      const request = api.openTerminal({ projectId, ...size, ...(program !== 'shell' ? { program } : {}) }, epoch);
      attempt = { operation: request.operation, events: [], bytes: 0, overflow: false, closeOnly: false, resolved: false };
      opening.current = attempt; setPending(true);
      await accept(attempt, await request.result);
    } catch (e) {
      if (!mounted.current || attempt && opening.current !== attempt) return;
      if (attempt) {
        // A WebSocket receipt may already prove success even when only the HTTP response was lost.
        let saved;
        try { saved = listOperations().find(o => o.id === attempt!.operation.operationId); } catch { /* Explicit read-only recovery remains available. */ }
        if (saved?.state === 'accepted' && saved.terminalResult) { await accept(attempt, saved.terminalResult); return; }
        if (e instanceof RpcError && e.delivery === 'not_sent') { opening.current = undefined; setPending(false); }
      }
      setError(message(e));
    } finally { if (mounted.current && (!attempt || opening.current === attempt)) setBusy(false); }
  };
  const recover = async (close: boolean) => {
    const attempt = opening.current; if (!attempt || busy || !connected) return;
    if (close) attempt.closeOnly = true;
    setBusy(true); setError('');
    try {
      const receipt = await api.recoverTerminal(attempt.operation, scope.current.epoch);
      if (opening.current !== attempt || !mounted.current) return;
      if (receipt.state === 'accepted') await accept(attempt, receipt.result);
      else if (receipt.state === 'not_sent') { opening.current = undefined; setPending(false); setError('已确认原终端请求未发送，可以重新打开终端。'); acknowledge(attempt.operation); }
      else setError('原终端操作仍待确认。查询不会重发创建请求，请稍后再次查询。');
    } catch (e) { if (mounted.current && opening.current === attempt) setError(message(e)); }
    finally { if (mounted.current && (!opening.current || opening.current === attempt)) setBusy(false); }
  };
  return <section className="terminal-panel"><div className="terminal-heading"><div><h2>{program === 'codex-cloud' ? '官方云任务 CLI' : program === 'codex' ? '原生 CLI · Hooks 管理' : '项目终端'}</h2><p className="muted small">{program === 'codex-cloud' ? '启动官方 codex cloud 交互界面，按账号实际可用能力查看、创建、检查云任务或应用更改。创建任务可能消耗额度，应用 diff 会修改当前项目，均由你在官方界面明确操作。网页不会自动提交云任务或应用补丁；退出后须明确重启原生服务。' : program === 'codex' ? '启动官方交互式 CLI。请自行键入 /hooks，审阅当前哈希后选择信任或停用。终端存活时暂停其他执行与配置写入；退出后必须到服务管理明确重启以同步原生配置。网页不会替你输入、信任或自动重启。' : '使用 worker 的 shell 权限，独立于当前回合的 sandbox 设置。断线后结束。'}</p></div>{id ? <button className="button" onClick={() => { const owner = activeOperation.current; if (owner) void closeTerminal(terminalId.current, owner); }}>关闭终端</button> : pending ? <div className="inline">{opening.current?.operation.projectId === projectId && (opening.current.operation.program ?? 'shell') === program && !opening.current.closeOnly && <button className="button" disabled={busy || !connected} onClick={() => void recover(false)}>查询并恢复终端</button>}<button className="button" disabled={busy || !connected} onClick={() => void recover(true)}>查询并关闭终端</button></div> : <button className="button primary" disabled={busy || !connected || !projectId || !enabled || program !== 'shell' && restartRequired} onClick={() => void open()}>{busy ? '正在启动…' : program === 'codex-cloud' ? '打开官方云任务界面' : program === 'codex' ? '启动原生 CLI' : ended ? '打开新终端' : '打开终端'}</button>}</div>{program !== 'shell' && onShell && <button className="button small" disabled={Boolean(id) || pending || busy || restartRequired} onClick={onShell}>切换到项目 shell</button>}{program !== 'shell' && !enabled && !id && <p className="muted small">原生 CLI 启动需要全局空闲且没有待确认操作。</p>}{restartRequired && <div className="workspace-warning" role="status"><p>原生 CLI 会话需要重新同步。请先在服务管理中明确重启原生服务，同步可能改变的配置或账户，再继续执行。这里不代表配置已获信任或云任务已完成。</p>{onServiceSettings && <button className="button small" onClick={onServiceSettings}>前往服务管理</button>}</div>}{pending && <p role="status" className="muted small">{busy ? '正在确认终端启动…' : '保留了原操作编号。可以查询并恢复或关闭，不会再次创建终端。'}</p>}{id && closeOnly.current && <p role="status" className="muted small">此终端只等待关闭，输入已暂停。</p>}{error && <p role="alert" className="error">{error}</p>}<div className="terminal-surface"><div ref={container} className="terminal-mount" aria-label="交互终端"/></div></section>;
}
