import { useEffect, useMemo, useState } from 'react';
import type { Api } from '../lib/api';
import { object, type Thread } from '../lib/types';
import { usePaged } from '../hooks/usePaged';
import { useResource } from '../hooks/useResource';
import { Dialog } from './Dialog';
import { ExtensionStatus, ReadState, useExtensionAction } from './ExtensionControls';
export function LoadedThreadsPanel({
  api,
  epoch,
  connected,
  enabled,
  onOpenThread,
  onChanged,
  onClose,
  knownThreads = [],
  navigationError = '',
}: {
  api: Api;
  epoch: string;
  connected: boolean;
  enabled: boolean;
  onOpenThread: (id: string) => void;
  onChanged: () => void;
  onClose: () => void;
  knownThreads?: Thread[];
  navigationError?: string;
}) {
  const [selected, setSelected] = useState(''),
    [confirm, setConfirm] = useState(false),
    [notice, setNotice] = useState('');
  const action = useExtensionAction(api, enabled && connected, onChanged),
    key = `${epoch}:${action.revision}`;
  const list = usePaged<unknown>(api, 'thread/loaded/list', {}, key, connected);
  const invalid = list.items.some((id) => typeof id !== 'string' || !id || id.length > 256),
    ids = invalid ? [] : [...new Set(list.items as string[])];
  // Resolve labels only for the visible group. Never hydrate the whole history or
  // issue reads for every loaded session in an unbounded directory.
  const labels = useMemo(() => new Map<string, string>(), [api, epoch, connected, action.revision]);
  const [offset, setOffset] = useState(0);
  const [, publishLabels] = useState(0);
  const start = Math.min(offset, Math.max(0, Math.floor((ids.length - 1) / 50) * 50));
  const visibleIds = ids.slice(start, start + 50);
  const known = new Map(knownThreads.map(row => [row.id, row.name || row.preview]));
  const missingKey = JSON.stringify(visibleIds.filter(id => !known.get(id)));
  useEffect(() => {
    if (!connected || list.snapshotKey !== key) return;
    const abort = new AbortController();
    const missing = (JSON.parse(missingKey) as string[]).filter(id => !labels.has(id));
    let index = 0;
    const worker = async () => {
      while (!abort.signal.aborted && index < missing.length) {
        const id = missing[index++]!;
        let name = '';
        try {
          const result = await api.call<{ thread: Thread }>('thread/read', { threadId: id }, abort.signal);
          if (result.thread?.id === id) name = result.thread.name || result.thread.preview || '';
        } catch { /* Deleted, hidden or temporarily unavailable: keep the id. */ }
        if (!abort.signal.aborted) { labels.set(id, name); publishLabels(v => v + 1); }
      }
    };
    for (let n = 0; n < Math.min(3, missing.length); n++) void worker();
    return () => abort.abort();
  }, [api, connected, key, labels, list.snapshotKey, missingKey]);
  const current = connected && list.snapshotKey === key && ids.includes(selected) ? selected : '';
  const detail = useResource(
    `${key}:${current}`,
    (signal) => api.call<{ thread: Thread }>('thread/read', { threadId: current }, signal),
    Boolean(current),
  );
  const thread = detail.data?.thread?.id === current ? detail.data.thread : undefined,
    idle = object(thread?.status).type === 'idle';
  return (
    <Dialog title="已加载会话" onClose={onClose} wide>
      <section className="stack">
        {navigationError && <p className="error" role="alert">{navigationError}</p>}
        <div className="section-heading">
          <h3>原生运行时中的已加载会话</h3>
          <button
            className="button small"
            disabled={!connected || list.loading}
            onClick={() => {
              setConfirm(false);
              labels.clear(); setOffset(0); list.refresh();
            }}
          >
            刷新已加载会话
          </button>
        </div>
        <p className="small muted">
          列表来自当前运行时，分批读取。打开只查看会话，不会自动继续待发任务。停止订阅保留历史；原生返回“停止订阅”不表示已证明进程卸载，列表刷新后仍可能显示该会话。
        </p>
        {!connected && <p className="connection-banner">连接已断开，重新连接后才能读取。</p>}
        <ReadState {...list} />
        {invalid && (
          <p className="error" role="alert">
            已加载目录包含无效会话身份，请重新读取。
          </p>
        )}
        <ExtensionStatus api={api} action={action} recoveryLabel="查询原停止订阅回执" />
        {notice && <p role="status">{notice}</p>}
        <div className="inline wrap">
          {visibleIds.map((id) => (
            <button
              className={`button small ${current === id ? 'selected' : ''}`}
              key={id}
              aria-pressed={current === id}
              disabled={list.loading || action.busy}
              onClick={() => {
                setSelected(id);
                setConfirm(false);
                setNotice('');
              }}
            >
              {known.get(id) || (thread?.id === id ? thread.name : '') || labels.get(id) || id}
            </button>
          ))}
        </div>
        {ids.length > 50 && <div className="inline">
          <button className="button small" disabled={!start} onClick={() => setOffset(start - 50)}>上一组会话</button>
          <span>{start + 1}–{Math.min(start + 50, ids.length)} / {ids.length}</span>
          <button className="button small" disabled={start + 50 >= ids.length} onClick={() => setOffset(start + 50)}>下一组会话</button>
        </div>}
        {!list.loading && !ids.length && !invalid && (
          <p className="muted">此页未返回已加载会话。</p>
        )}
        {list.hasMore && (
          <button
            className="button"
            disabled={list.loading || !connected}
            onClick={() => void list.more()}
          >
            加载更多已加载会话
          </button>
        )}
        {current && (
          <article className="info-card stack">
            <ReadState {...detail} />
            {thread && (
              <>
                <h4>{thread.name || thread.preview || current}</h4>
                <p className="path small">{thread.cwd}</p>
                <p className="small">原生状态：{String(object(thread.status).type ?? '未提供')}</p>
                <button className="button primary" onClick={() => onOpenThread(current)}>
                  打开此会话
                </button>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={confirm}
                    onChange={(event) => setConfirm(event.target.checked)}
                  />
                  确认停止订阅此空闲会话，保留历史
                </label>
                <button
                  className="button"
                  disabled={action.disabled || !idle || !confirm || detail.loading || list.loading}
                  onClick={async () => {
                    const id = current;
                    setConfirm(false);
                    const result = await action.run('thread/unsubscribe', { threadId: id });
                    if (result) {
                      const status = result.status;
                      setNotice(
                        status === 'notLoaded'
                          ? '原生服务报告此会话未加载；历史仍保留。'
                          : status === 'notSubscribed'
                            ? '此连接原本未订阅该会话；历史仍保留。'
                            : status === 'unsubscribed'
                              ? '已停止此连接的订阅；不保证原生进程已卸载，正在刷新列表。'
                              : '原请求已受理，正在重新读取当前状态。',
                      );
                    }
                  }}
                >
                  停止订阅所选会话
                </button>
                {!idle && (
                  <p className="small muted">
                    只能停止订阅原生状态明确空闲的会话。运行中的任务请先进入会话处理。
                  </p>
                )}
              </>
            )}
          </article>
        )}
      </section>
    </Dialog>
  );
}
