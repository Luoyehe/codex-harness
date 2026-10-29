import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Api } from '../lib/api';
import { timelineRows, type RealtimeItem, type TimelineEntry } from '../lib/timeline';
import { object, type Turn, type Project } from '../lib/types';
import { MessageItem } from './MessageItem';
import { PlainText } from './SafeMarkdown';
export { Diff } from './SafeMarkdown';

const WINDOW_ROWS = 150;
function VoiceItem({
  item,
  onLocate,
}: {
  item: RealtimeItem;
  onLocate: (turnId: string, itemId: string) => void;
}) {
  if (item.type === 'realtimeSessionStarted')
    return (
      <div className="timeline-marker" role="note">
        ◉ 语音会话开始
      </div>
    );
  if (item.type === 'realtimeSessionClosed')
    return (
      <div className="timeline-marker" role="note">
        {item.outcome === 'failed' ? '语音会话异常结束' : '语音会话已结束'}
      </div>
    );
  if (item.type === 'bemItemPromoted')
    return (
      <div className="timeline-marker">
        <span>语音会话引用了任务结果</span>
        <button className="button small" onClick={() => onLocate(item.turnId, item.itemId)}>
          定位消息
        </button>
      </div>
    );
  return (
    <article
      className={item.role === 'user' ? 'message user-message' : 'message assistant-message'}
    >
      <div className="message-author">
        {item.role === 'user' ? '你 · 语音转写' : 'Codex · 语音转写'}
      </div>
      <PlainText text={item.text} />
    </article>
  );
}

type Props = {
  api?: Api;
  threadId?: string;
  project?: Project;
  turns: Turn[];
  timeline?: TimelineEntry[];
  loading: boolean;
  complete: boolean;
  onMore: () => void;
  focusTarget?: { turnId: string; itemId: string };
  onAction?: (turn: Turn, action: 'fork' | 'edit' | 'revert') => void;
  actionsDisabled?: boolean;
  active?: boolean;
};
export function Messages({
  api,
  threadId,
  project,
  turns,
  timeline = [],
  loading,
  complete,
  onMore,
  focusTarget,
  onAction,
  actionsDisabled = false,
  active = false,
}: Props) {
  const bottom = useRef<HTMLDivElement>(null),
    anchors = useRef(new Map<string, HTMLDivElement>());
  const [follow, setFollow] = useState(true),
    [endKey, setEndKey] = useState<string | null>(null);
  const [locateError, setLocateError] = useState(''),
    [locating, setLocating] = useState<string | null>(null);
  const rows = useMemo(() => timelineRows(turns, timeline), [turns, timeline]);
  const savedEnd = endKey === null ? -1 : rows.findIndex((row) => row.key === endKey);
  const end = savedEnd < 0 ? rows.length : savedEnd + 1,
    start = Math.max(0, end - WINDOW_ROWS);
  const locate = (turnId: string, itemId: string) => {
    const key = JSON.stringify([turnId, itemId]),
      index = rows.findIndex((row) => row.key === key);
    if (index < 0) {
      setLocateError('引用的消息尚未加载。请完成历史读取后再次定位。');
      return;
    }
    setLocateError('');
    setFollow(false);
    const element = anchors.current.get(key);
    if (element) {
      element.scrollIntoView({ block: 'center', behavior: 'instant' });
      element.focus({ preventScroll: true });
      setLocating(null);
    } else {
      if (index < start || index >= end)
        setEndKey(rows[Math.min(rows.length - 1, index + Math.floor(WINDOW_ROWS / 2))]!.key);
      setLocating(key);
    }
  };
  useLayoutEffect(() => {
    setEndKey(null);
    setFollow(true);
    setLocating(null);
    setLocateError('');
  }, [threadId]);
  useLayoutEffect(() => {
    if (follow && endKey === null)
      bottom.current?.scrollIntoView({ block: 'end', behavior: 'instant' });
  }, [turns, timeline, follow, endKey]);
  // Navigation focus is part of committing the visible result. A passive effect
  // leaves a published search window temporarily focused on the previous control.
  useLayoutEffect(() => {
    if (focusTarget) locate(focusTarget.turnId, focusTarget.itemId);
  }, [focusTarget, threadId]);
  useLayoutEffect(() => {
    if (!locating) return;
    const element = anchors.current.get(locating);
    if (element) {
      element.scrollIntoView({ block: 'center', behavior: 'instant' });
      element.focus({ preventScroll: true });
      setLocating(null);
    }
  }, [locating, start, end]);
  const page = (nextEnd: number) => {
    setFollow(false);
    setEndKey(rows[Math.max(0, Math.min(rows.length - 1, nextEnd - 1))]!.key);
  };
  return (
    <div
      className="conversation-scroll"
      onScroll={(event) => {
        const el = event.currentTarget;
        const following =
          end === rows.length && el.scrollHeight - el.scrollTop - el.clientHeight < 100;
        setFollow(following);
        if (following) setEndKey(null);
        else if (endKey === null && rows.length) setEndKey(rows[end - 1]!.key);
      }}
    >
      <div className="conversation-content">
        {!complete && rows.length > 0 && (
          <button className="button history-more" disabled={loading} onClick={onMore}>
            {loading ? '正在加载…' : '加载更早的内容'}
          </button>
        )}
        {rows.length > WINDOW_ROWS && (
          <div className="inline wrap">
            <span className="small muted">
              已读取 {rows.length} 条，显示第 {start + 1}–{end} 条；其余内容仍保留。
            </span>
            <button
              className="button small"
              disabled={start === 0}
              onClick={() => page(Math.max(WINDOW_ROWS, start))}
            >
              显示较早内容
            </button>
            <button
              className="button small"
              disabled={end === rows.length}
              onClick={() => page(end + WINDOW_ROWS)}
            >
              显示较新内容
            </button>
          </div>
        )}
        {loading && rows.length === 0 && (
          <div className="loading-state" role="status">
            <span className="loading-dot" />
            正在读取完整会话内容…
          </div>
        )}
        {locateError && (
          <p className="muted" role="status">
            {locateError}
          </p>
        )}
        {rows.slice(start, end).map((row) => {
          if (row.type === 'realtime')
            return <VoiceItem key={row.key} item={row.item} onLocate={locate} />;
          if (row.type === 'item')
            return (
              <div
                tabIndex={-1}
                className={`message-anchor ${focusTarget?.turnId === row.turnId && focusTarget.itemId === row.item.id ? 'search-selected' : ''}`}
                key={row.key}
                ref={(element) => {
                  if (element) anchors.current.set(row.key, element);
                  else anchors.current.delete(row.key);
                }}
              >
                <MessageItem item={row.item} api={api} threadId={threadId} project={project} />
              </div>
            );
          const turn = row.turn;
          return (
            <section className="turn" key={row.key} aria-label={`回合 ${turn.id}`}>
              {turn.status === 'inProgress' && (
                <div className="working-state" role="status">
                  <span className="loading-dot" />
                  正在工作
                </div>
              )}
              {turn.error ? (
                <p className="error" role="alert">
                  {String(object(turn.error).message ?? JSON.stringify(turn.error))}
                </p>
              ) : null}
              {turn.status === 'interrupted' && <p className="muted small">此回合已停止</p>}
              {onAction && turn.status !== 'inProgress' && (
                <details className="turn-actions">
                  <summary>回合操作</summary>
                  <div className="inline wrap">
                    <button
                      className="button small"
                      disabled={actionsDisabled}
                      onClick={() => onAction(turn, 'fork')}
                    >
                      从此处分支
                    </button>
                    <button
                      className="button small"
                      disabled={
                        actionsDisabled || !turn.items.some((item) => item.type === 'userMessage')
                      }
                      onClick={() => onAction(turn, 'edit')}
                    >
                      从此前编辑消息
                    </button>
                    <button
                      className="button danger small"
                      disabled={actionsDisabled || active}
                      onClick={() => onAction(turn, 'revert')}
                    >
                      回退至此前
                    </button>
                  </div>
                </details>
              )}
            </section>
          );
        })}
        <div ref={bottom} />
      </div>
      {(!follow || end < rows.length) && (
        <button
          className="jump-bottom button"
          onClick={() => {
            setEndKey(null);
            setFollow(true);
          }}
        >
          ↓ 回到最新
        </button>
      )}
    </div>
  );
}
