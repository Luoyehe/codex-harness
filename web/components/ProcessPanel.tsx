import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api } from '../lib/api';
import type { Events } from '../lib/events';
import { message, type Project } from '../lib/types';
import { useResource } from '../hooks/useResource';
import { useWorkflow } from '../hooks/useWorkflow';
import { ExtensionStatus, ReadState, useExtensionAction } from './ExtensionControls';

type Process = { processHandle: string; cwd: string; tty: boolean; status: 'starting' | 'running' | 'exited'; timedOut: boolean; exitCode?: number; stdoutCapReached: boolean; stderrCapReached: boolean };
type Output = Process & { stdoutBase64: string; stderrBase64: string };
function decoded(text: string): string { if (text.length > 1_398_104) throw new Error('进程输出超过显示预算。'); return new TextDecoder().decode(Uint8Array.from(atob(text), char => char.charCodeAt(0))); }
function encoded(text: string): string { const bytes = new TextEncoder().encode(text); if (bytes.length > 65536) throw new Error('一次输入不能超过 64 KiB。'); let raw = ''; for (const byte of bytes) raw += String.fromCharCode(byte); return btoa(raw); }

// Events request a fresh bounded snapshot. Never concatenate snapshots and deltas,
// which would duplicate output or split UTF-8 characters around a read/event race.
function useOutput(api: Api, events: Events, key: string, handle: string, connected: boolean): { data?: Output; stdout?: string; stderr?: string; loading: boolean; error: string; refresh(): void } {
  const [result, setResult] = useState<{ key: string; data?: Output; stdout?: string; stderr?: string; error: string; loading: boolean }>();
  const reload = useRef<() => void>(() => {});
  useEffect(() => {
    const controller = new AbortController(); let inFlight = false, dirty = false, timer: ReturnType<typeof setTimeout> | undefined;
    setResult({ key, error: '', loading: Boolean(handle && connected) });
    if (!handle || !connected) return;
    const read = async () => {
      if (inFlight) { dirty = true; return; } inFlight = true; dirty = false;
      try { const data = await api.call<Output>('process/read', { processHandle: handle }, controller.signal); if (data.processHandle !== handle) throw new Error('进程输出身份不匹配。'); const stdout = decoded(data.stdoutBase64), stderr = decoded(data.stderrBase64); if (!controller.signal.aborted) setResult({ key, data, stdout, stderr, error: '', loading: false }); }
      catch (e) { if (!controller.signal.aborted) setResult(previous => ({ ...(previous?.key === key ? previous : {}), key, error: message(e), loading: false })); }
      finally { inFlight = false; if (dirty && !controller.signal.aborted) timer = setTimeout(() => { timer = undefined; void read(); }, 150); }
    };
    const request = () => { dirty = true; if (!inFlight && !timer) timer = setTimeout(() => { timer = undefined; void read(); }, 150); };
    reload.current = request;
    const off = events.subscribe(event => { if (event.type === 'process' && event.data.processHandle === handle) request(); });
    void read(); return () => { controller.abort(); clearTimeout(timer); off(); reload.current = () => {}; };
  }, [api, events, key, handle, connected]);
  const current = result?.key === key ? result : undefined;
  return { data: current?.data, stdout: current?.stdout, stderr: current?.stderr, loading: current?.loading ?? Boolean(handle && connected), error: current?.error ?? '', refresh: () => reload.current() };
}

export function ProcessPanel({ api, events, epoch, connectionId, connected, enabled, project, onChanged }: { api: Api; events: Events; epoch: string; connectionId: string; connected: boolean; enabled: boolean; project?: Project; onChanged: () => void }) {
  return <ProcessSession key={`${epoch}:${connectionId}`} {...{ api, events, epoch, connectionId, connected, enabled, project, onChanged }}/>;
}
function ProcessSession({ api, events, epoch, connected, enabled, project, onChanged }: { api: Api; events: Events; epoch: string; connectionId: string; connected: boolean; enabled: boolean; project?: Project; onChanged: () => void }) {
  const spawn = useExtensionAction(api, enabled && connected, onChanged), [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState({ processHandle: '', revision: 0, text: '', notice: '' }), selected = draft.processHandle;
  const selectProcess = useCallback((processHandle: string) => setDraft(current => ({ processHandle, revision: current.revision + 1, text: '', notice: '' })), []);
  const editInput = (text: string) => setDraft(current => ({ ...current, revision: current.revision + 1, text }));
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const control = useWorkflow(api, 'owned-process-control', connected, refresh), controlAction = { ...control, revision, refresh };
  const list = useResource(`${epoch}:${revision}:${spawn.revision}`, signal => api.call<{ data: Process[] }>('process/list', {}, signal), connected);
  const output = useOutput(api, events, `${epoch}:${selected}:${connected}`, selected, connected);
  const [command, setCommand] = useState(''), [tty, setTty] = useState(false), [stdin, setStdin] = useState(true), [minutes, setMinutes] = useState('60'), [confirmed, setConfirmed] = useState(false), [newline, setNewline] = useState(true), [rows, setRows] = useState('24'), [cols, setCols] = useState('100'), [error, setError] = useState('');
  const selectedProcess = output.data ?? list.data?.data.find(item => item.processHandle === selected), running = selectedProcess?.status === 'running';
  useEffect(() => { setConfirmed(false); }, [project?.id, command, tty, stdin, minutes]);
  useEffect(() => { if (!connected) { selectProcess(''); setConfirmed(false); } }, [connected, selectProcess]);
  useEffect(() => events.subscribe(event => { if (event.type === 'process' && event.data.type === 'exit') refresh(); }), [events, refresh]);
  const send = async (kind: 'input' | 'interrupt' | 'close') => {
    setError('');
    const submitted = kind === 'input' ? draft : undefined;
    const text = submitted ? submitted.text + (newline ? '\n' : '') : kind === 'interrupt' ? '\x03' : '';
    try {
      if (await control.run('process/writeStdin', { processHandle: selected, ...(text ? { deltaBase64: encoded(text) } : {}), ...(kind === 'close' ? { closeStdin: true } : {}) }, kind === 'close' ? '进程输入流已关闭。' : '输入已确认发送。')) {
        // Controls never consume a draft; accepted text consumes only its original owner and revision.
        if (submitted) setDraft(current => current.processHandle === submitted.processHandle && current.revision === submitted.revision ? { ...current, revision: current.revision + 1, text: '' } : current);
        output.refresh();
      }
    } catch (e) { setError(message(e)); }
  };
  return <section className="stack"><div className="section-heading"><h3>直接执行命令</h3><button className="button small" disabled={!connected} onClick={() => { refresh(); output.refresh(); }}>刷新进程与输出</button></div>
    <p className="small muted">这些是你主动运行的命令，以执行账号权限运行，不经过模型审批或模型沙箱。关闭本面板不会停止命令；网页连接结束时会清理所属进程树。每路输出默认保留 256 KiB，退出结果保留 10 分钟。Agent 自己启动的后台任务在会话工具中管理。</p>
    {!connected && <p className="workspace-warning">连接已断开。原连接的进程不能在新连接中接管。</p>}
    <ExtensionStatus api={api} action={spawn} recoveryLabel="查询原启动回执"/><ExtensionStatus api={api} action={controlAction} recoveryLabel="查询原进程控制回执"/>
    <details className="info-card"><summary>启动命令</summary><div className="stack"><p className="small path">工作目录：{project?.cwd ?? '先选择已注册项目'}</p>
      <label className="field">命令参数（每行一个，第一行是可执行文件）<textarea value={command} rows={4} maxLength={32768} placeholder={'python3\n--version'} onChange={e => setCommand(e.target.value)}/></label>
      <p className="small muted">不会替你拼接 shell 字符串或展开通配符。需要 shell 时，请明确填写 shell 可执行文件及其参数。空行代表空参数。</p>
      <label className="check-row"><input type="checkbox" checked={tty} onChange={e => setTty(e.target.checked)}/>分配 PTY（下方显示原始终端文本）</label><label className="check-row"><input type="checkbox" checked={stdin} disabled={tty} onChange={e => setStdin(e.target.checked)}/>保留标准输入</label>
      <label className="field">最长运行分钟数（1–1440）<input type="number" min={1} max={1440} value={minutes} onChange={e => setMinutes(e.target.value)}/></label>
      <label className="check-row"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>确认以执行账号权限在此项目运行上述命令</label>
      <button className="button primary" disabled={spawn.disabled || !confirmed || !project || !command.split('\n')[0]?.trim() || !Number.isInteger(Number(minutes)) || Number(minutes) < 1 || Number(minutes) > 1440} onClick={async () => { const before = draft; const result = await spawn.run('process/spawn', { projectId: project!.id, command: command.replace(/\r\n/g, '\n').split('\n'), tty, streamStdin: stdin || tty, timeoutMs: Number(minutes) * 60000, ...(tty ? { size: { rows: 24, cols: 100 } } : {}) }, '命令已启动，请查看进程状态和输出。'); if (result && typeof result.processHandle === 'string') { const processHandle = result.processHandle; setDraft(current => current.processHandle === before.processHandle && current.revision === before.revision && !current.text ? { processHandle, revision: current.revision + 1, text: '', notice: '' } : { ...current, notice: `进程 ${processHandle.slice(0, 8)} 已启动。为保留当前选择或输入，未自动切换；可在进程列表中选择查看。` }); setConfirmed(false); refresh(); } }}>启动一次命令</button>
    </div></details>
    <ReadState {...list}/><label className="field">当前连接的进程<select value={selected} disabled={!connected} onChange={e => { selectProcess(e.target.value); setError(''); }}><option value="">选择进程</option>{list.data?.data.map(item => <option key={item.processHandle} value={item.processHandle}>{item.processHandle.slice(0, 8)} · {item.status} · {item.cwd}</option>)}</select></label>
    {draft.notice && <p role="status" className="small muted">{draft.notice}</p>}
    {selected && <div className="stack"><ReadState {...output}/>{selectedProcess && <><p role="status">状态：{selectedProcess.status}{selectedProcess.exitCode !== undefined ? ` · 退出码 ${selectedProcess.exitCode}` : ''}{selectedProcess.timedOut ? ' · 达到时限后停止' : ''}</p><p className="small path">{selectedProcess.cwd}</p>{(selectedProcess.stdoutCapReached || selectedProcess.stderrCapReached) && <p className="workspace-warning">输出已达到保留上限，以下内容可能不完整。</p>}
      <label className="field">标准输出<pre className="code" style={{ maxHeight: '20rem', overflow: 'auto', whiteSpace: 'pre-wrap' }}>{output.stdout ?? ''}</pre></label><label className="field">标准错误<pre className="code" style={{ maxHeight: '12rem', overflow: 'auto', whiteSpace: 'pre-wrap' }}>{output.stderr ?? ''}</pre></label>
      {running && <><label className="field">发送给进程的输入<textarea value={draft.text} maxLength={32768} onChange={e => editInput(e.target.value)}/></label><label className="check-row"><input type="checkbox" checked={newline} onChange={e => setNewline(e.target.checked)}/>末尾添加换行</label><div className="toolbar"><button className="button" disabled={control.disabled || !draft.text} onClick={() => void send('input')}>发送输入</button><button className="button" disabled={control.disabled} onClick={() => void send('close')}>关闭输入流</button>{selectedProcess.tty && <button className="button" disabled={control.disabled} onClick={() => void send('interrupt')}>发送 Ctrl+C</button>}</div>
        {selectedProcess.tty && <div className="toolbar"><label className="field">终端行数<input type="number" value={rows} min={1} max={500} onChange={e => setRows(e.target.value)}/></label><label className="field">终端列数<input type="number" value={cols} min={1} max={500} onChange={e => setCols(e.target.value)}/></label><button className="button" disabled={control.disabled || ![rows, cols].every(value => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 500)} onClick={() => void control.run('process/resizePty', { processHandle: selected, size: { rows: Number(rows), cols: Number(cols) } })}>更新 PTY 尺寸</button></div>}</>}
      <button className={`button ${selectedProcess.status !== 'exited' ? 'danger' : ''}`} disabled={control.disabled} onClick={async () => { const method = selectedProcess.status === 'exited' ? 'process/remove' : 'process/kill'; if (await control.run(method, { processHandle: selected }, method.endsWith('kill') ? '所属进程树停止已确认。' : '已移除此进程的输出记录。')) { if (method.endsWith('remove')) setDraft(current => current.processHandle === selected && current.revision === draft.revision ? { processHandle: '', revision: current.revision + 1, text: '', notice: '' } : current); else output.refresh(); } }}>{selectedProcess.status === 'exited' ? '移除已退出进程的输出' : '停止此进程树'}</button>
    </>}</div>}{error && <p role="alert" className="error">{error}</p>}
  </section>;
}
