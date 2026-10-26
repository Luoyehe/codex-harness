import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Api } from '../lib/api';
import { Events, useSubscription } from '../lib/events';
import {
  applyNotification,
  boundedCombined,
  checkedPage,
  HISTORY_LIMIT,
  historySyncPending,
  mergeHistory,
} from '../lib/history';
import { activeRealtime, mergeTimeline, type TimelineEntry } from '../lib/timeline';
import { message, object, type HarnessEvent, type Thread, type Turn } from '../lib/types';

export function useConversation(api: Api, events: Events, threadId: string, resourceEpoch: string) {
  const [turns, setTurns] = useState<Turn[]>([]),
    [timeline, setTimeline] = useState<TimelineEntry[]>([]),
    [thread, setThread] = useState<Thread>();
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [diff, setDiff] = useState('');
  const [ready, setReady] = useState(false),
    [cursor, setCursor] = useState<string | null>(null),
    [complete, setComplete] = useState(false);
  const [realtimeActive, setRealtimeActive] = useState(false),
    [historyStale, setHistoryStale] = useState(false),
    [usage, setUsage] = useState<unknown>();
  const generation = useRef(0),
    current = useRef<Turn[]>([]),
    canonical = useRef<TimelineEntry[]>([]),
    touched = useRef(new Set<string>()),
    seen = useRef(new Set<string>()),
    pages = useRef(0),
    streamStatus = useRef<unknown>(undefined);
  const [revision, setRevision] = useState(0);
  const historyComplete = useRef(false),
    voice = useRef(false),
    opening = useRef<string | null>(null),
    minimumVersion = useRef(0),
    traversalVersion = useRef<number | undefined>(undefined);
  // History refreshes share a visit; navigating away and back never revives its callbacks.
  const visit = useMemo(() => ({ active: false }), [api, threadId, resourceEpoch]);
  useLayoutEffect(() => {
    visit.active = true;
    return () => {
      visit.active = false;
    };
  }, [visit]);
  const controller = useRef<AbortController | undefined>(undefined),
    selectedContext = useRef<typeof visit | undefined>(undefined);
  const publish = (value: Turn[]) => {
    current.current = value;
    setTurns(value);
  };
  const refresh = useCallback(() => {
    if (!voice.current) setRevision((v) => v + 1);
  }, []);
  const recheck = useCallback(() => setRevision((v) => v + 1), []);
  const invalidate = () => {
    generation.current++;
    controller.current?.abort();
    historyComplete.current = false;
    setLoading(false);
    setReady(false);
    setComplete(false);
    setCursor(null);
    setHistoryStale(true);
  };
  const voiceStarted = useCallback(
    (target: string) => {
      if (!visit.active || target !== threadId || voice.current) return;
      voice.current = true;
      setRealtimeActive(true);
      invalidate();
    },
    [threadId, visit],
  );
  const voiceClosed = useCallback(
    (target: string) => {
      if (!visit.active || target !== threadId || !voice.current) return;
      voice.current = false;
      setRealtimeActive(false);
      invalidate();
      refresh();
    },
    [threadId, visit, refresh],
  );
  const accept = (value: unknown) => {
    if (pages.current >= HISTORY_LIMIT.pages)
      throw new Error('历史页数达到安全上限。已保留窗口，完成同步前不能发送。');
    const page = checkedPage(value, seen.current);
    if (
      page.historyVersion < minimumVersion.current ||
      (traversalVersion.current !== undefined && traversalVersion.current !== page.historyVersion)
    )
      throw new Error('历史版本已变化，请重新读取完整会话。');
    traversalVersion.current = page.historyVersion;
    const merged = mergeHistory(current.current, page.turns, touched.current),
      entries = mergeTimeline(canonical.current, page.timeline);
    boundedCombined(merged, entries);
    if (pages.current === 0 || page.timeline.length > 0)
      opening.current = page.activeRealtimeSessionAtPageStart;
    if (page.nextCursor !== null) seen.current.add(page.nextCursor);
    pages.current++;
    canonical.current = entries;
    publish(merged);
    setTimeline(entries);
    setCursor(page.nextCursor);
    setComplete(page.complete);
    const active = activeRealtime(entries, opening.current) !== null;
    if (active) {
      voice.current = true;
      setRealtimeActive(true);
    }
    if (page.complete) {
      voice.current = active;
      setRealtimeActive(active);
      historyComplete.current = true;
      setHistoryStale(false);
      setReady(!active && !historySyncPending(merged));
    }
    return page;
  };
  useEffect(() => {
    if (selectedContext.current !== visit) {
      selectedContext.current = visit;
      setDiff('');
      setUsage(undefined);
      voice.current = false;
      setRealtimeActive(false);
      minimumVersion.current = 0;
    }
    const gen = ++generation.current,
      abort = new AbortController();
    controller.current = abort;
    historyComplete.current = false;
    traversalVersion.current = undefined;
    opening.current = null;
    canonical.current = [];
    publish([]);
    setTimeline([]);
    setThread(undefined);
    setError('');
    setReady(false);
    setCursor(null);
    setComplete(false);
    setHistoryStale(false);
    touched.current = new Set();
    seen.current = new Set();
    pages.current = 0;
    streamStatus.current = undefined;
    if (!threadId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all([
      api.call('thread/read', { threadId }, abort.signal),
      api.call('thread/history', { threadId, limit: 30 }, abort.signal),
    ])
      .then(async ([metadata, value]) => {
        if (generation.current !== gen) return;
        const t = object(metadata.thread ?? metadata) as Thread;
        if (t.id !== threadId) throw new Error('会话身份不匹配。');
        setThread({
          ...t,
          ...(streamStatus.current !== undefined ? { status: streamStatus.current } : {}),
        });
        let result = value;
        while (generation.current === gen) {
          const page = accept(result);
          if (page.complete) break;
          result = await api.call(
            'thread/history',
            { threadId, cursor: page.nextCursor, limit: 30 },
            abort.signal,
          );
        }
      })
      .catch((e) => {
        if (generation.current === gen && !abort.signal.aborted) setError(message(e));
      })
      .finally(() => {
        if (generation.current === gen) setLoading(false);
      });
    return () => {
      generation.current++;
      abort.abort();
    };
  }, [api, threadId, resourceEpoch, revision, visit]);
  const loadMore = async () => {
    if (loading || cursor === null || complete || voice.current) return;
    const gen = generation.current;
    setLoading(true);
    setError('');
    try {
      const page = await api.call(
        'thread/history',
        { threadId, cursor, limit: 30 },
        controller.current?.signal,
      );
      if (generation.current === gen) accept(page);
    } catch (e) {
      if (generation.current === gen) setError(message(e));
    } finally {
      if (generation.current === gen) setLoading(false);
    }
  };
  const handle = useCallback(
    (event: HarnessEvent) => {
      if (!visit.active || !['notification', 'realtime'].includes(event.type)) return;
      const p = object(event.data.params),
        method = String(event.data.method ?? '');
      if (p.threadId !== threadId) return;
      try {
        if (method === 'thread/history/invalidated') {
          if (Number.isSafeInteger(p.historyVersion))
            minimumVersion.current = Math.max(minimumVersion.current, Number(p.historyVersion));
          invalidate();
          return;
        }
        if (method === 'thread/realtime/started') {
          voice.current = true;
          setRealtimeActive(true);
          invalidate();
          return;
        }
        if (method === 'thread/realtime/closed') {
          voice.current = false;
          setRealtimeActive(false);
          invalidate();
          refresh();
          return;
        }
        if (event.type === 'realtime') return;
        if (method === 'error') setError(String(object(p.error).message ?? '模型回合发生错误。'));
        if (method === 'thread/tokenUsage/updated') setUsage(p.tokenUsage);
        if (method === 'thread/status/changed') {
          streamStatus.current = p.status;
          setThread((t) => (t ? { ...t, status: p.status } : t));
        }
        const result = applyNotification(current.current, method, p);
        if (result.touched) touched.current.add(result.touched);
        if (result.diff !== undefined) setDiff(result.diff);
        boundedCombined(result.turns, canonical.current);
        publish(result.turns);
        setReady(historyComplete.current && !voice.current && !historySyncPending(result.turns));
        if (method === 'turn/completed') refresh();
      } catch (e) {
        invalidate();
        setError(message(e));
      }
    },
    [threadId, visit, refresh],
  );
  useSubscription(events, handle);
  const activeTurn = turns.findLast((t) => t.status === 'inProgress');
  const active = Boolean(activeTurn) || object(thread?.status).type === 'active';
  return {
    turns,
    timeline,
    thread,
    loading,
    error,
    diff,
    usage,
    ready,
    active,
    activeTurn,
    realtimeActive,
    historyStale,
    complete,
    loadMore,
    refresh,
    recheck,
    voiceStarted,
    voiceClosed,
  };
}
