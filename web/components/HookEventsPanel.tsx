import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Events } from '../lib/events';
import { array, object, type HarnessEvent } from '../lib/types';

export type HookRecord = {
  threadId: string;
  turnId: string;
  id: string;
  eventName: string;
  handlerType: string;
  mode: string;
  scope: string;
  source: string;
  sourcePath: string;
  status: string;
  statusMessage: string;
  startedAt: string;
  completedAt: string;
  durationMs: string;
  entries: { kind: string; text: string }[];
  truncated: boolean;
};
export type HookSnapshot = { records: HookRecord[]; discarded: number; malformed: number };
const empty: HookSnapshot = { records: [], discarded: 0, malformed: 0 };
const maxRecords = 100,
  maxBytes = 512 * 1024,
  maxText = 16 * 1024;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const text = (value: unknown, length = 256) =>
  typeof value === 'string' ? value.slice(0, length) : '';
const numberText = (value: unknown) =>
  (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'bigint'
    ? String(value).slice(0, 40)
    : '';
export function captureHook(snapshot: HookSnapshot, event: HarnessEvent): HookSnapshot {
  if (
    event.type !== 'notification' ||
    !['hook/started', 'hook/completed'].includes(String(event.data.method))
  )
    return snapshot;
  const params = object(event.data.params),
    run = object(params.run);
  if (
    typeof params.threadId !== 'string' ||
    !params.threadId ||
    params.threadId.length > 256 ||
    typeof run.id !== 'string' ||
    !run.id ||
    run.id.length > 256 ||
    !['running', 'completed', 'failed', 'blocked', 'stopped'].includes(String(run.status))
  )
    return { ...snapshot, malformed: Math.min(snapshot.malformed + 1, 1_000_000) };
  const previous = snapshot.records.find(
    (row) => row.threadId === params.threadId && row.id === run.id,
  );
  if (previous && previous.status !== 'running' && event.data.method === 'hook/started')
    return snapshot;
  let remaining = maxText,
    truncated = false;
  const bounded = (value: unknown, limit: number) => {
    const raw = typeof value === 'string' ? value : '',
      candidate = raw.slice(0, Math.min(limit, Math.floor(remaining / 4)));
    remaining -= new TextEncoder().encode(candidate).byteLength;
    if (candidate.length < raw.length) truncated = true;
    return candidate;
  };
  const rawEntries = array<unknown>(run.entries),
    entries = rawEntries.slice(0, 40).map((value) => {
      const entry = object(value);
      return { kind: text(entry.kind, 40), text: bounded(entry.text, 8192) };
    });
  if (rawEntries.length > 40) truncated = true;
  const record: HookRecord = {
    threadId: params.threadId,
    turnId: text(params.turnId),
    id: run.id,
    eventName: text(run.eventName),
    handlerType: text(run.handlerType),
    mode: text(run.executionMode),
    scope: text(run.scope),
    source: text(run.source),
    sourcePath: bounded(run.sourcePath, 4096),
    status: String(run.status),
    statusMessage: bounded(run.statusMessage, 4096),
    startedAt: numberText(run.startedAt),
    completedAt: numberText(run.completedAt),
    durationMs: numberText(run.durationMs),
    entries,
    truncated,
  };
  const records = [record, ...snapshot.records.filter((row) => row !== previous)];
  let discarded = snapshot.discarded;
  while (records.length > maxRecords || bytes(records) > maxBytes) {
    records.pop();
    discarded = Math.min(discarded + 1, 1_000_000);
  }
  return { records, discarded, malformed: snapshot.malformed };
}
type ContextValue = HookSnapshot & { connected: boolean; clear: () => void };
const HookContext = createContext<ContextValue>({ ...empty, connected: false, clear: () => {} });
export function HookEventsProvider({
  events,
  lease,
  connected,
  children,
}: {
  events: Events;
  lease: string;
  connected: boolean;
  children: ReactNode;
}) {
  const [state, setState] = useState({ lease, snapshot: empty });
  useEffect(() => {
    setState({ lease, snapshot: empty });
    if (!connected) return;
    return events.subscribe((event) =>
      setState((current) => {
        const snapshot = captureHook(current.lease === lease ? current.snapshot : empty, event);
        return current.lease === lease && snapshot === current.snapshot
          ? current
          : { lease, snapshot };
      }),
    );
  }, [events, lease, connected]);
  const snapshot = connected && state.lease === lease ? state.snapshot : empty;
  return (
    <HookContext.Provider
      value={{ ...snapshot, connected, clear: () => setState({ lease, snapshot: empty }) }}
    >
      {children}
    </HookContext.Provider>
  );
}
const statuses: Record<string, string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  blocked: '已阻止',
  stopped: '已停止',
};
export function HookEventsPanel() {
  const value = useContext(HookContext),
    [threadId, setThreadId] = useState('');
  const ids = [...new Set(value.records.map((row) => row.threadId))],
    selected = ids.includes(threadId) ? threadId : '';
  const records = value.records.filter((row) => !selected || row.threadId === selected);
  return (
    <section className="stack info-card">
      <div className="section-heading">
        <h3>本次连接的 Hook 运行记录</h3>
        <button
          className="button small"
          disabled={!value.records.length && !value.discarded && !value.malformed}
          onClick={value.clear}
        >
          清除本页运行记录
        </button>
      </div>
      <p className="small muted">
        这里只显示本工作台连接期间收到的通知，最多保留最近 100 次运行、512 KiB，每次输出最多 16
        KiB；断线或重启即清空，不是完整历史。Hook 输出仅供审阅，不构成执行授权，也不会自动执行。
      </p>
      {!value.connected && (
        <p className="connection-banner">连接已断开，旧连接的 Hook 运行记录已清除。</p>
      )}
      {value.discarded > 0 && (
        <p className="workspace-warning">已达到保留预算，较早的 {value.discarded} 条记录已移除。</p>
      )}
      {value.malformed > 0 && (
        <p className="workspace-warning">
          有 {value.malformed} 条通知缺少有效身份或状态，未作为运行结果展示。
        </p>
      )}
      <label className="field">
        运行记录的会话范围
        <select value={selected} onChange={(event) => setThreadId(event.target.value)}>
          <option value="">本次连接的所有会话</option>
          {ids.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>
      {!records.length && <p className="muted">尚未收到此范围的 Hook 运行通知。</p>}
      {records.map((row) => (
        <details className="tool-card" key={`${row.threadId}:${row.id}`}>
          <summary>
            {row.eventName || 'Hook'} · {statuses[row.status]} · {row.source || '未提供来源'}
          </summary>
          <div className="tool-body stack">
            <p className="small path">
              会话：{row.threadId} · 回合：{row.turnId || '无'} · 运行 ID：{row.id}
            </p>
            <p className="small">
              {row.handlerType} · {row.mode} · {row.scope}
              {row.durationMs && ` · 耗时 ${row.durationMs} ms`}
            </p>
            <p className="path small">来源：{row.sourcePath || '未提供'}</p>
            {row.statusMessage && <pre className="raw">{row.statusMessage}</pre>}
            {row.entries.map((entry, index) => (
              <div key={index}>
                <strong className="small">{entry.kind || '输出'}</strong>
                <pre className="raw">{entry.text}</pre>
              </div>
            ))}
            {!row.entries.length && <p className="muted small">此通知未附带输出。</p>}
            {row.truncated && (
              <p className="workspace-warning">此运行的内容已截断，不能视为完整输出。</p>
            )}
          </div>
        </details>
      ))}
    </section>
  );
}
