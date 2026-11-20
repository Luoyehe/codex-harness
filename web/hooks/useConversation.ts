import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { RpcError, type Api } from '../lib/api';
import { Events, useSubscription } from '../lib/events';
import {
  applyNotification,
  boundedCombined,
  checkedPage,
  HISTORY_LIMIT,
  HistoryCapacityError,
  historySyncPending,
  mergeHistory,
} from '../lib/history';
import { activeRealtime, compactTimelineEntries, mergeTimeline, timelineIdentity, type TimelineEntry } from '../lib/timeline';
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

type CompleteHistory = { turns: Turn[]; timeline: TimelineEntry[]; historyVersion: number };
const terminal = (turn: Turn) => ['completed', 'failed', 'interrupted'].includes(turn.status);

/** A tail can extend a previously complete view only where both independent
 * canonical streams overlap, and each appended turn was observed from its start. */
function extendHistory(base: CompleteHistory, updated: ReturnType<typeof checkedPage>, started: string[]): CompleteHistory | undefined {
  const last = base.turns.at(-1), boundary = base.timeline.at(-1);
  if (!last || !terminal(last) || !boundary || boundary.type !== 'turnCompleted' || boundary.turnId !== last.id ||
      !updated.executionReady || updated.historyVersion !== base.historyVersion || updated.activeRealtimeSessionAtPageStart !== null ||
      updated.timeline.some(row => row.type === 'realtime') || !started.length) return;
  const turnIndex = updated.turns.findIndex(turn => turn.id === last.id);
  const position = updated.timeline.findIndex(row => row.position === boundary.position && timelineIdentity(row) === timelineIdentity(boundary));
  if (turnIndex < 0 || position < 0) return;
  const { items: anchorItems, ...anchorFields } = updated.turns[turnIndex]!;
  const { items: originalItems, ...originalFields } = last;
  const persisted = ({ streamComplete: _stream, historySync: _sync, ...value }: Turn['items'][number]) => JSON.stringify(value);
  if (JSON.stringify(anchorFields) !== JSON.stringify(originalFields) || anchorItems.length !== originalItems.length ||
      anchorItems.some((item, index) => persisted(item) !== persisted(originalItems[index]!))) return;
  const added = updated.turns.slice(turnIndex + 1), entries = updated.timeline.slice(position + 1);
  if (started.length !== added.length || added.some((turn, index) => turn.id !== started[index] || !terminal(turn)) ||
      base.turns.some(turn => started.includes(turn.id))) return;
  const confirmed = new Set(started);
  if (entries.some((row, i) => row.type === 'realtime' || !confirmed.has(row.turnId) ||
      row.position < (i ? entries[i - 1]!.position : boundary.position))) return;
  // Incomplete native pages may cut through either a turn or its timeline.
  // Require both lifecycle fences and all authoritative item IDs for the suffix.
  for (const turn of added) {
    const own = entries.filter(row => row.type !== 'realtime' && row.turnId === turn.id);
    const finished = own.at(-1);
    if (own[0]?.type !== 'turnStarted' || finished?.type !== 'turnCompleted' || finished.status !== turn.status) return;
    const items = own.flatMap(row => row.type === 'item' ? [row.item] : []);
    if (items.length !== turn.items.length || items.some((item, i) =>
      item.id !== turn.items[i]!.id || item.type !== turn.items[i]!.type)) return;
  }
  const turns = [...base.turns, ...mergeHistory([], added, new Set())];
  const timeline = compactTimelineEntries(turns, [...base.timeline, ...entries]);
  boundedCombined(turns, timeline);
  return { turns, timeline, historyVersion: base.historyVersion };
}

export function useConversation(api: Api, events: Events, threadId: string, resourceEpoch: string) {
  const [turns, setTurns] = useState<Turn[]>([]),
    [timeline, setTimeline] = useState<TimelineEntry[]>([]),
    [thread, setThread] = useState<Thread>();
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [diff, setDiff] = useState('');
  const [truncated, setTruncated] = useState(false);
  const windowVisit = useRef<object | undefined>(undefined);
  const [ready, setReady] = useState(false),
    [cursor, setCursor] = useState<string | null>(null),
    [complete, setComplete] = useState(false);
  const [realtimeActive, setRealtimeActive] = useState(false),
    [historyStale, setHistoryStale] = useState(false),
    [usage, setUsage] = useState<unknown>();
  const baseHistory = useRef<CompleteHistory | undefined>(undefined), appendedTurns = useRef<string[]>([]),
    requestTail = useRef(false), streamRevision = useRef(0);
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
  const diffTurn = useRef('');
  const holdDisplay = useRef(false);
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
    if (!holdDisplay.current) setTurns(value);
  };
  const refresh = useCallback(() => {
    if (!voice.current) setRevision((v) => v + 1);
  }, []);
  const recheck = useCallback(() => setRevision((v) => v + 1), []);
  const invalidate = () => {
    baseHistory.current = undefined; appendedTurns.current = []; requestTail.current = false;
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
      throw new HistoryCapacityError('历史页数达到显示窗口上限。');
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
      entries = compactTimelineEntries(merged, mergeTimeline(canonical.current, page.timeline));
    boundedCombined(merged, entries);
    restartFromStream.current = false;
    if (pages.current === 0 || page.timeline.length > 0)
      opening.current = page.activeRealtimeSessionAtPageStart;
    if (page.nextCursor !== null) seen.current.add(page.nextCursor);
    pages.current++;
    canonical.current = entries;
    if (page.complete || page.truncated) holdDisplay.current = false;
    publish(merged);
    if (!holdDisplay.current) setTimeline(entries);
    setCursor(page.nextCursor);
    setComplete(page.complete);
    setTruncated(page.truncated);
    const active = activeRealtime(entries, opening.current) !== null;
    if (active) {
      voice.current = true;
      setRealtimeActive(true);
    }
    if (page.complete || page.truncated) {
      if (page.complete && diffTurn.current && !merged.some(t => t.id === diffTurn.current)) {
        diffTurn.current = '';
        setDiff('');
      }
      voice.current = active;
      setRealtimeActive(active);
      historyComplete.current = page.executionReady;
      baseHistory.current = page.complete && page.executionReady && !active && !historySyncPending(merged)
        ? { turns: merged, timeline: entries, historyVersion: page.historyVersion } : undefined;
      appendedTurns.current = []; requestTail.current = false;
      setHistoryStale(false);
      setReady(page.executionReady && !active && !historySyncPending(merged));
    }
    return page;
  };
  useEffect(() => {
    const sameVisit = selectedContext.current === visit;
    const incremental = sameVisit && requestTail.current && baseHistory.current ?
      { base: baseHistory.current, started: [...appendedTurns.current], revision: streamRevision.current } : undefined;
    requestTail.current = false;
    baseHistory.current = undefined; appendedTurns.current = [];
    const previousTurns = sameVisit ? current.current : [];
    const previousTimeline = sameVisit ? canonical.current : [];
    holdDisplay.current = sameVisit;
    setTruncated(false);
    if (!sameVisit) {
      selectedContext.current = visit;
      setDiff('');
      diffTurn.current = '';
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
    current.current = [];
    if (!sameVisit) { setTurns([]); setTimeline([]); setThread(undefined); }
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
      if (firstCursor === null && incremental && windowVisit.current !== visit) {
        try {
          const value = await api.call('thread/history', { threadId, intent: 'window', limit: 30,
            timelineFormat: 'references', baseHistoryVersion: incremental.base.historyVersion }, abort.signal);
          if (!isCurrent()) return;
          const next = object(value).baseHistoryVerified === true && streamRevision.current === incremental.revision &&
            extendHistory(incremental.base, checkedPage(value, new Set()), incremental.started);
          if (next) {
            const meta = await api.call('thread/read', { threadId }, abort.signal);
            if (!isCurrent()) return;
            const subject = object(meta.thread ?? meta) as Thread;
            if (subject.id === threadId && object(subject.status).type === 'idle' && streamRevision.current === incremental.revision) {
              holdDisplay.current = false;
              publish(next.turns); canonical.current = next.timeline; setTimeline(next.timeline);
              setThread({ ...subject, ...(streamStatus.current !== undefined ? { status: streamStatus.current } : {}) });
              traversalVersion.current = next.historyVersion; historyComplete.current = true; baseHistory.current = next;
              setCursor(null); setComplete(true); setReady(true); setHistoryStale(false); setTruncated(false);
              return;
            }
          }
        } catch {
          if (!isCurrent()) return;
          // A stale/unverifiable tail or an exceeded display limit takes the
          // ordinary complete, version-fenced traversal below.
        }
      }
      let startCursor = firstCursor;
      let windowLimit = windowVisit.current === visit ? 20 : 0;
      let staleAttempts = 0;
      while (isCurrent()) {
        try {
          const [metadata, value] = await Promise.all([
            api.call('thread/read', { threadId }, abort.signal),
            api.call('thread/history', {
              threadId, timelineFormat: 'references', ...(windowLimit ? { intent: 'window', limit: windowLimit } : { limit: 30 }), ...(startCursor !== null ? { cursor: startCursor } : {}),
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
            if (windowLimit || page.truncated) windowVisit.current = visit;
            if (page.complete || page.truncated) return;
            result = await api.call(
              'thread/history',
              { threadId, cursor: page.nextCursor, limit: 30, timelineFormat: 'references' },
              abort.signal,
            );
          }
          return;
        } catch (e) {
          if (!isCurrent()) return;
          const capacity = e instanceof HistoryCapacityError || (e instanceof RpcError && e.code === 'capacity');
          if (capacity && windowLimit !== 1) {
            windowLimit = windowLimit ? 1 : 20;
            startCursor = null;
            restartTraversal();
            continue;
          }
          if (!(e instanceof RpcError) || e.code !== 'history_stale') throw e;
          // A live lifecycle changed across native pages. Revoke the old cursor
          // and proof, then rebuild only from a new traversal plus retained live
          // events; snapshots from the rejected traversal must not become proof.
          historyComplete.current = false;
          setReady(false);
          setComplete(false);
          setCursor(null);
          setHistoryStale(true);
          const delay = HISTORY_RETRY_DELAYS[staleAttempts++];
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
        if (isCurrent()) {
          if (holdDisplay.current) {
            holdDisplay.current = false;
            try { publish(mergeHistory(streamed.current, previousTurns, touched.current)); }
            catch (mergeError) {
              if (!(mergeError instanceof HistoryCapacityError)) throw mergeError;
              publish(previousTurns);
              windowVisit.current = visit;
              recheck();
            }
            canonical.current = previousTimeline;
            setTimeline(previousTimeline);
          }
          setError(message(e));
        }
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
  const loadMore = useCallback(async () => {
    if (!visit.active || loading || complete || truncated || voice.current) return;
    const continuation = continueHistory.current;
    if (continuation?.generation !== generation.current) {
      recheck();
      return;
    }
    await continuation.read(cursor);
  }, [visit, loading, complete, truncated, cursor, recheck]);
  const handle = useCallback(
    (event: HarnessEvent) => {
      if (!visit.active) return;
      if (event.type === 'resync') { invalidate(); recheck(); return; }
      if (!['notification', 'realtime'].includes(event.type)) return;
      const p = object(event.data.params),
        method = String(event.data.method ?? '');
      if (p.threadId !== threadId) return;
      if (method.startsWith('turn/') || method.startsWith('item/') || method.startsWith('thread/realtime/') ||
          ['thread/status/changed', 'thread/closed', 'thread/deleted'].includes(method)) streamRevision.current++;
      const changedTurn = method === 'turn/completed' ? object(p.turn).id : method.startsWith('item/') ? p.turnId : undefined;
      if ((typeof changedTurn === 'string' && !appendedTurns.current.includes(changedTurn)) ||
          method === 'thread/closed' || method === 'thread/deleted') {
        baseHistory.current = undefined; requestTail.current = false;
      }
      try {
        if (method === 'thread/reverted') { invalidate(); recheck(); return; }
        if (method === 'thread/history/invalidated') {
          if (Number.isSafeInteger(p.historyVersion))
            minimumVersion.current = Math.max(minimumVersion.current, Number(p.historyVersion));
          invalidate();
          if (p.previewOmitted === true) recheck();
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
        if (method === 'turn/started') {
          const id = object(p.turn).id ?? p.turnId;
          if (baseHistory.current && typeof id === 'string' && !appendedTurns.current.includes(id)) {
            if (appendedTurns.current.length < 30) appendedTurns.current.push(id);
            else { baseHistory.current = undefined; appendedTurns.current = []; }
          }
          // Tail-window authority includes the exact turn revision. A live turn
          // revokes it; renew only this bounded window once the turn settles.
          if (windowVisit.current === visit) historyComplete.current = false;
          diffTurn.current = String(object(p.turn).id ?? p.turnId ?? '');
          setDiff('');
        }
        if (method === 'turn/diff/updated' && typeof p.turnId === 'string') {
          const latestTurn = diffTurn.current || current.current.at(-1)?.id;
          if (latestTurn && p.turnId !== latestTurn) return;
          diffTurn.current = p.turnId;
        }
        if (method === 'thread/status/changed') {
          streamStatus.current = p.status;
          setThread((t) => (t ? { ...t, status: p.status } : t));
        }
        const live = applyNotification(streamed.current, method, p);
        const result = applyNotification(current.current, method, p, true);
        if (result.touched) touched.current.add(result.touched);
        if (result.diff !== undefined) setDiff(result.diff);
        boundedCombined(result.turns, canonical.current);
        streamed.current = live.turns;
        publish(result.turns);
        setReady(historyComplete.current && !voice.current && !historySyncPending(result.turns));
        if (method === 'turn/completed') {
          const liveError = object(object(p.turn).error).message;
          if (typeof liveError === 'string' && liveError) setError(liveError);
          const turn = result.turns.find(row => row.id === object(p.turn).id);
          // A lost completion or an uncertain snapshot needs an authoritative reread.
          if (windowVisit.current === visit || !historyComplete.current || !turn?.items.length || turn.items.some(item => !item.streamComplete)) {
            const boundary = baseHistory.current?.timeline.at(-1);
            requestTail.current = !!boundary && boundary.type === 'turnCompleted' && boundary.turnId === baseHistory.current?.turns.at(-1)?.id &&
              !voice.current && typeof turn?.id === 'string' && appendedTurns.current.at(-1) === turn.id;
            refresh();
          }
        }
      } catch (e) {
        invalidate();
        if (e instanceof HistoryCapacityError) {
          windowVisit.current = visit;
          recheck();
        } else setError(message(e));
      }
    },
    [threadId, visit, refresh, recheck],
  );
  useSubscription(events, handle);
  const owned = selectedContext.current === visit;
  const activeTurn = owned ? turns.findLast((t) => t.status === 'inProgress') : undefined;
  const active = Boolean(activeTurn) || object(thread?.status).type === 'active';
  return {
    turns: owned ? turns : [],
    timeline: owned ? timeline : [],
    thread: owned ? thread : undefined,
    loadedThreadId: owned && thread?.id === threadId ? threadId : '',
    truncated: owned && truncated,
    loading: owned ? loading : Boolean(threadId),
    error: owned ? error : '',
    diff: owned ? diff : '',
    usage: owned ? usage : undefined,
    ready: owned && ready,
    active: owned && active,
    activeTurn,
    realtimeActive,
    historyStale,
    complete: owned && complete,
    loadMore,
    refresh,
    recheck,
    voiceStarted,
    voiceClosed,
  };
}
