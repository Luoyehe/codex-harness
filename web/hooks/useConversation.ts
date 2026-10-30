import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { RpcError, type Api } from '../lib/api';
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

const HISTORY_RETRY_DELAYS = [100, 250];
function waitForHistoryRetry(signal: AbortSignal, delay: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, delay);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

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
    streamed = useRef<Turn[]>([]),
    restartFromStream = useRef(false),
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
    continueHistory = useRef<{
      generation: number;
      read(cursor: string | null): Promise<void>;
    } | undefined>(undefined),
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
    const merged = mergeHistory(
      restartFromStream.current ? streamed.current : current.current,
      page.turns,
      touched.current,
    ),
      entries = mergeTimeline(canonical.current, page.timeline);
    boundedCombined(merged, entries);
    restartFromStream.current = false;
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
    streamed.current = [];
    restartFromStream.current = false;
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
    const isCurrent = () => visit.active && generation.current === gen && !abort.signal.aborted;
    const restartTraversal = () => {
      traversalVersion.current = undefined;
      opening.current = null;
      canonical.current = [];
      seen.current = new Set();
      pages.current = 0;
      restartFromStream.current = true;
    };
    const read = async (firstCursor: string | null) => {
      let startCursor = firstCursor;
      for (let attempt = 0; isCurrent(); attempt++) {
        try {
          const [metadata, value] = await Promise.all([
            api.call('thread/read', { threadId }, abort.signal),
            api.call('thread/history', {
              threadId, limit: 30, ...(startCursor !== null ? { cursor: startCursor } : {}),
            }, abort.signal),
          ]);
          if (!isCurrent()) return;
          const t = object(metadata.thread ?? metadata) as Thread;
          if (t.id !== threadId) throw new Error('会话身份不匹配。');
          setThread({
            ...t,
            ...(streamStatus.current !== undefined ? { status: streamStatus.current } : {}),
          });
          let result = value;
          while (isCurrent()) {
            const page = accept(result);
            if (page.complete) return;
            result = await api.call(
              'thread/history',
              { threadId, cursor: page.nextCursor, limit: 30 },
              abort.signal,
            );
          }
          return;
        } catch (e) {
          if (!isCurrent()) return;
          if (!(e instanceof RpcError) || e.code !== 'history_stale') throw e;
          // A live lifecycle changed across native pages. Revoke the old cursor
          // and proof, then rebuild only from a new traversal plus retained live
          // events; snapshots from the rejected traversal must not become proof.
          historyComplete.current = false;
          setReady(false);
          setComplete(false);
          setCursor(null);
          setHistoryStale(true);
          const delay = HISTORY_RETRY_DELAYS[attempt];
          if (delay === undefined || voice.current) throw e;
          await waitForHistoryRetry(abort.signal, delay);
          if (!isCurrent() || voice.current) return;
          restartTraversal();
          startCursor = null;
        }
      }
    };
    let reading = false;
    const run = async (startCursor: string | null) => {
      if (!isCurrent() || reading) return;
      reading = true;
      setLoading(true);
      setError('');
      if (startCursor === null) restartTraversal();
      try {
        await read(startCursor);
      } catch (e) {
        if (generation.current === gen && !abort.signal.aborted) setError(message(e));
      } finally {
        reading = false;
        if (generation.current === gen) setLoading(false);
      }
    };
    const continuation = { generation: gen, read: run };
    continueHistory.current = continuation;
    void run(null);
    return () => {
      generation.current++;
      abort.abort();
      if (continueHistory.current === continuation) continueHistory.current = undefined;
    };
  }, [api, threadId, resourceEpoch, revision, visit]);
  const loadMore = async () => {
    if (!visit.active || loading || complete || voice.current) return;
    const continuation = continueHistory.current;
    if (continuation?.generation !== generation.current) {
      recheck();
      return;
    }
    await continuation.read(cursor);
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
        const live = applyNotification(streamed.current, method, p);
        const result = applyNotification(current.current, method, p);
        if (result.touched) touched.current.add(result.touched);
        if (result.diff !== undefined) setDiff(result.diff);
        boundedCombined(result.turns, canonical.current);
        streamed.current = live.turns;
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
