// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Api, RpcError } from '../lib/api';
import { Events } from '../lib/events';
import { longConversationData } from '../../tests/runtime/history-window-fixture';
import { fitHistoryWindow } from '../../src/runtime/history-window';
import { object as runtimeObject } from '../../src/runtime/types';
import { timelineRows } from '../lib/timeline';
import { useConversation } from '../hooks/useConversation';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const page = (turns: unknown[] = [], extra = {}) => ({ turns, timeline: [], turnsComplete: true,
  timelineComplete: true, historyVersion: 0, activeRealtimeSessionAtPageStart: null,
  complete: true, nextCursor: null, ...extra });
const stale = () => new RpcError('History or its live turn changed during loading; read it again', 'history_stale');
function deferred() {
  let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function event(events: Events, method: string, params: Record<string, unknown>) {
  events.publish({ type: 'notification', data: { method, params: { threadId: 'new', ...params } } });
}
function harness(history: (params: Record<string, unknown>) => unknown) {
  const events = new Events();
  const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'thread/read') return { thread: { id: params.threadId, status: { type: 'active' } } };
    if (method === 'thread/history') return history(params);
    throw new Error('History recovery must not resume or send input');
  });
  return { events, call, api: { call } as unknown as Api };
}

describe('read-only history lifecycle recovery', () => {
  it('restarts the first page after the new turn starts and retains every live item through recovery', async () => {
    const first = deferred(), retry = deferred(); let attempts = 0;
    const h = harness(() => ++attempts === 1 ? first.promise : retry.promise);
    const hook = renderHook(() => useConversation(h.api, h.events, 'new', 'epoch'));
    act(() => {
      event(h.events, 'turn/started', { turn: { id: 'live', status: 'inProgress' } });
      event(h.events, 'item/started', { turnId: 'live', item: { id: 'answer', type: 'agentMessage', text: 'live ' } });
      event(h.events, 'item/agentMessage/delta', { turnId: 'live', itemId: 'answer', delta: 'before ' });
      first.reject(stale());
    });
    await waitFor(() => expect(attempts).toBe(2));
    expect(hook.result.current.loading).toBe(true);
    expect(hook.result.current.ready).toBe(false);
    expect(hook.result.current.turns[0]?.items[0]?.text).toBe('live before ');
    act(() => event(h.events, 'item/agentMessage/delta', { turnId: 'live', itemId: 'answer', delta: 'during' }));
    await act(async () => retry.resolve(page([{ id: 'live', status: 'inProgress', items: [
      { id: 'question', type: 'userMessage', content: [] },
      { id: 'answer', type: 'agentMessage', text: 'older snapshot' },
    ] }])));
    await waitFor(() => expect(hook.result.current.complete).toBe(true));
    expect(hook.result.current.error).toBe('');
    expect(hook.result.current.historyStale).toBe(false);
    expect(hook.result.current.active).toBe(true);
    expect(hook.result.current.turns[0]?.items.map(item => item.id)).toEqual(['question', 'answer']);
    expect(hook.result.current.turns[0]?.items[1]?.text).toBe('live before during');
    expect(h.call.mock.calls.filter(([method]) => method === 'thread/history').map(([, params]) => params)).toEqual([
      { threadId: 'new', limit: 30, timelineFormat: 'references' }, { threadId: 'new', limit: 30, timelineFormat: 'references' },
    ]);
  });

  it('discards a rejected traversal cursor and snapshot rows, while keeping live events without inventing delta offsets', async () => {
    const older = deferred(); let starts = 0;
    const h = harness(params => {
      if (params.cursor) return older.promise;
      return ++starts === 1 ? page([{ id: 'obsolete', status: 'completed', items: [] }], {
        complete: false, turnsComplete: false, nextCursor: 'old-cursor',
      }) : page([{ id: 'live', status: 'inProgress', items: [{ id: 'answer', type: 'agentMessage', text: 'snapshot' }] }]);
    });
    const hook = renderHook(() => useConversation(h.api, h.events, 'new', 'epoch'));
    await waitFor(() => expect(hook.result.current.turns[0]?.id).toBe('obsolete'));
    act(() => {
      event(h.events, 'item/agentMessage/delta', { turnId: 'live', itemId: 'answer', delta: 'unpositioned' });
      older.reject(stale());
    });
    await waitFor(() => expect(hook.result.current.complete).toBe(true));
    expect(starts).toBe(2);
    expect(hook.result.current.turns.map(turn => turn.id)).toEqual(['live']);
    expect(hook.result.current.turns[0]?.items[0]?.historySync).toMatchObject({ snapshot: 'snapshot', deltas: 'unpositioned' });
    expect(hook.result.current.ready).toBe(false);
    expect(h.call.mock.calls.filter(([method]) => method === 'thread/history').map(([, params]) => params.cursor ?? null)).toEqual([null, 'old-cursor', null]);
  });

  it('stops a persistent race after bounded retries and permits a manual full read without an old cursor', async () => {
    let stable = false, attempts = 0;
    const h = harness(() => { attempts++; if (!stable) throw stale(); return page(); });
    const hook = renderHook(() => useConversation(h.api, h.events, 'new', 'epoch'));
    await waitFor(() => expect(hook.result.current.error).toContain('live turn changed'));
    expect(attempts).toBe(3);
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.ready).toBe(false);
    expect(hook.result.current.historyStale).toBe(true);
    stable = true;
    await act(async () => hook.result.current.loadMore());
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    expect(attempts).toBe(4);
  });

  it('uses the same full-traversal recovery when a manual continuation becomes stale after a transport failure', async () => {
    let starts = 0, continuations = 0;
    const h = harness(params => {
      if (params.cursor) {
        if (++continuations === 1) throw new RpcError('temporary transport failure', 'disconnected');
        throw stale();
      }
      return ++starts === 1 ? page([{ id: 'obsolete', status: 'completed', items: [] }], {
        complete: false, turnsComplete: false, nextCursor: 'old-cursor',
      }) : page([{ id: 'live', status: 'inProgress', items: [{ id: 'answer', type: 'agentMessage', text: 'stale snapshot' }] }]);
    });
    const hook = renderHook(() => useConversation(h.api, h.events, 'new', 'epoch'));
    await waitFor(() => expect(hook.result.current.error).toBe('temporary transport failure'));
    act(() => event(h.events, 'item/started', { turnId: 'live', item: { id: 'answer', type: 'agentMessage', text: 'retained live' } }));
    await act(async () => hook.result.current.loadMore());
    await waitFor(() => expect(hook.result.current.complete).toBe(true));
    expect(hook.result.current.error).toBe('');
    expect(hook.result.current.turns.map(turn => turn.id)).toEqual(['live']);
    expect(hook.result.current.turns[0]?.items[0]?.text).toBe('retained live');
    expect(h.call.mock.calls.filter(([method]) => method === 'thread/history').map(([, params]) => params.cursor ?? null)).toEqual([null, 'old-cursor', 'old-cursor', null]);
  });

  it('rereads the authoritative thread when an oversized live preview could not preserve its contents', async () => {
    let version = 0;
    const h = harness(() => page([{ id: 'turn', status: 'completed', items: [
      { id: 'answer', type: 'agentMessage', text: version ? 'authoritative answer' : 'before preview gap' }
    ] }], { historyVersion: version }));
    const hook = renderHook(() => useConversation(h.api, h.events, 'new', 'epoch'));
    await waitFor(() => expect(hook.result.current.complete).toBe(true));
    act(() => { version++; event(h.events, 'thread/history/invalidated', { historyVersion: version, previewOmitted: true }); });
    await waitFor(() => expect(hook.result.current.turns[0]?.items[0]?.text).toBe('authoritative answer'));
  });

  it('allows an explicit full read after an invalidation has revoked the old read generation', async () => {
    let version = 0;
    const h = harness(() => page([], { historyVersion: version }));
    const hook = renderHook(() => useConversation(h.api, h.events, 'new', 'epoch'));
    await waitFor(() => expect(hook.result.current.complete).toBe(true));
    act(() => { version = 1; event(h.events, 'thread/history/invalidated', { historyVersion: version }); });
    expect(hook.result.current.ready).toBe(false);
    await act(async () => hook.result.current.loadMore());
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    expect(hook.result.current.historyStale).toBe(false);
  });

  it.each(['thread', 'epoch', 'unmount'] as const)('cancels scheduled recovery on %s change', async change => {
    vi.useFakeTimers();
    const h = harness(params => { if (params.threadId === 'new') throw stale(); return page(); });
    const hook = renderHook(({ id, epoch }) => useConversation(h.api, h.events, id, epoch), { initialProps: { id: 'new', epoch: 'one' } });
    await act(async () => {});
    if (change === 'unmount') hook.unmount();
    else hook.rerender({ id: change === 'thread' ? 'other' : 'new', epoch: 'two' });
    await act(async () => {});
    const oldSignal = h.call.mock.calls[0] && vi.mocked(h.api.call).mock.calls[0]?.[2];
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    const original = vi.mocked(h.api.call).mock.calls.filter(([method, , signal]) => method === 'thread/history' && signal === oldSignal);
    expect(original).toHaveLength(1);
  });

  it('does not turn transport or invalid-history failures into an automatic retry loop', async () => {
    const h = harness(() => { throw new RpcError('read failed', 'disconnected'); });
    const hook = renderHook(() => useConversation(h.api, h.events, 'new', 'epoch'));
    await waitFor(() => expect(hook.result.current.error).toBe('read failed'));
    expect(h.call.mock.calls.filter(([method]) => method === 'thread/history')).toHaveLength(1);
    expect(hook.result.current.ready).toBe(false);
  });

  it('cancels a waiting retry when voice starts and reads again only after its close', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const h = harness(() => { if (++attempts === 1) throw stale(); return page(); });
    const hook = renderHook(() => useConversation(h.api, h.events, 'new', 'epoch'));
    await act(async () => {});
    act(() => event(h.events, 'thread/realtime/started', {}));
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(attempts).toBe(1);
    expect(hook.result.current.realtimeActive).toBe(true);
    expect(hook.result.current.ready).toBe(false);
    await act(async () => event(h.events, 'thread/realtime/closed', {}));
    expect(attempts).toBe(2);
    expect(hook.result.current.ready).toBe(true);
  });

  it('completion supersedes a waiting retry and restores the final authoritative item', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const h = harness(() => {
      if (++attempts === 1) throw stale();
      return page([{ id: 'live', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: 'final' }] }]);
    });
    const hook = renderHook(() => useConversation(h.api, h.events, 'new', 'epoch'));
    await act(async () => {});
    await act(async () => {
      event(h.events, 'item/agentMessage/delta', { turnId: 'live', itemId: 'answer', delta: 'fragment' });
      event(h.events, 'turn/completed', { turn: { id: 'live', status: 'completed' } });
    });
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(attempts).toBe(2);
    expect(hook.result.current.ready).toBe(true);
    expect(hook.result.current.turns[0]?.items[0]?.text).toBe('final');
    expect(hook.result.current.turns[0]?.items[0]?.historySync).toBeUndefined();
  });
});

describe('bounded long conversations', () => {
  const recent = [{ id: 'tail', status: 'completed', items: [] }];
  const windowPage = (executionReady: boolean) => page(recent, { complete: false,
    turnsComplete: false, timelineComplete: false, truncated: true, executionReady });
  it('retains a bounded stale retry after both capacity fallbacks when a late revert changes the window', async () => {
    let windowReads = 0;
    const h = harness(params => {
      if (params.limit !== 1) throw new RpcError('capacity', 'capacity');
      if (++windowReads <= 2) throw stale();
      return windowPage(true);
    });
    const view = renderHook(() => useConversation(h.api, h.events, 'new', 'epoch'));
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    expect(h.call.mock.calls.filter(([m]) => m === 'thread/history').map(([, p]) => p.limit)).toEqual([30, 20, 1, 1, 1]);
    expect(view.result.current.complete).toBe(false);
    expect(view.result.current.truncated).toBe(true);
  });
  it.each(['server', 'browser'])('recovers the %s capacity boundary, keeps proof separate from display completeness and reopens only the window', async source => {
    const h = harness(params => {
      if (params.intent === 'window') return windowPage(true);
      if (source === 'server') throw new RpcError('Combined turn and voice history exceeded its traversal budget', 'capacity');
      return page([{ id: 'huge', status: 'completed', items: [{ id: 'log', type: 'commandExecution', aggregatedOutput: 'a'.repeat(4_000_001) }] }]);
    });
    const view = renderHook(() => useConversation(h.api, h.events, 'new', 'epoch'));
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    expect(view.result.current.complete).toBe(false);
    expect(view.result.current.truncated).toBe(true);
    expect(view.result.current.turns).toEqual(recent);
    act(() => view.result.current.recheck());
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    expect(h.call.mock.calls.filter(([m]) => m === 'thread/history').map(([, p]) => [p.intent, p.limit])).toEqual([
      [undefined, 30], ['window', 20], ['window', 20],
    ]);
  });
  it.each([20, 1])('shows the final answer after the real history crosses the browser budget at window limit %i', async limit => {
    const { turns, timeline } = longConversationData();
    const h = harness(params => {
      if (limit === 1 && params.intent === 'window' && params.limit === 20) throw new RpcError('capacity', 'capacity');
      const count = Number(params.limit), complete = count >= turns.length && count >= timeline.length;
      const response = { turns: turns.slice(0, count).reverse(), timeline: timeline.slice(-count).map(row => {
        const item = runtimeObject(row.item);
        return { ...row, itemReference: true, item: { id: item.id!, type: item.type! } };
      }), turnsComplete: complete, timelineComplete: complete, complete, truncated: !complete, executionReady: true,
        historyVersion: 4, nextCursor: null, activeRealtimeSessionAtPageStart: null };
      return params.intent === 'window' ? fitHistoryWindow(response) : response;
    });
    const view = renderHook(() => useConversation(h.api, h.events, 'new', 'epoch'));
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    const conversation = view.result.current;
    expect(conversation.truncated).toBe(true); expect(conversation.complete).toBe(false);
    const latest = timelineRows(conversation.turns, conversation.timeline).filter(row => row.type === 'item' && row.turnId === 'latest');
    expect(latest.map(row => row.type === 'item' && row.item.id)).toEqual(['prompt-latest', 'progress', 'answer-latest']);
    expect(latest.at(-1)).toMatchObject({ item: { text: 'completed and visible final' } });
    expect(h.call.mock.calls.filter(([method]) => method === 'thread/history').map(([, params]) => params.limit))
      .toEqual(limit === 20 ? [30, 20] : [30, 20, 1]);
  });
  it('does not authorize the displayed window with an unresolved activity or after resync until the new proof arrives', async () => {
    const later = deferred(); let seen = 0;
    const h = harness(params => {
      if (!params.intent) throw new RpcError('capacity', 'capacity');
      return ++seen === 1 ? windowPage(false) : later.promise;
    });
    const view = renderHook(() => useConversation(h.api, h.events, 'new', 'epoch'));
    await waitFor(() => expect(view.result.current.truncated).toBe(true));
    expect(view.result.current.ready).toBe(false);
    act(() => h.events.publish({ type: 'resync', data: {} }));
    expect(view.result.current.ready).toBe(false);
    await act(async () => later.resolve(windowPage(true)));
    await waitFor(() => expect(view.result.current.ready).toBe(true));
  });
  it('restores previous rows and live arrivals when the second page of a background refresh fails', async () => {
    const tail = deferred(); let pass = 0;
    const h = harness(params => params.cursor ? tail.promise : ++pass === 1 ? page(recent) :
      page([{ id: 'partial', status: 'completed', items: [] }], { complete: false, turnsComplete: false, nextCursor: 'older' }));
    const view = renderHook(() => useConversation(h.api, h.events, 'new', 'epoch'));
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    act(() => view.result.current.recheck());
    await waitFor(() => expect(h.call.mock.calls.some(([, p]) => p.cursor === 'older')).toBe(true));
    act(() => {
      event(h.events, 'item/started', { turnId: 'stream', item: { id: 'answer', type: 'agentMessage', text: 'live' } });
      tail.reject(new Error('read interrupted'));
    });
    await waitFor(() => expect(view.result.current.error).toBe('read interrupted'));
    act(() => event(h.events, 'item/agentMessage/delta', { turnId: 'stream', itemId: 'answer', delta: ' after' }));
    expect(view.result.current.turns.map(row => row.id)).toEqual(['tail', 'stream']);
    expect(view.result.current.turns.at(-1)?.items[0]?.text).toBe('live after');
    expect(view.result.current.ready).toBe(false);
  });
  it('keeps a confirmed live completion interactive without requesting the same history again', async () => {
    const h = harness(() => page(recent));
    const view = renderHook(() => useConversation(h.api, h.events, 'new', 'epoch'));
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    act(() => {
      event(h.events, 'turn/started', { turn: { id: 't' } });
      event(h.events, 'item/completed', { turnId: 't', item: { id: 'i', type: 'agentMessage', text: 'done' } });
      event(h.events, 'turn/completed', { turn: { id: 't', status: 'completed' } });
    });
    expect(view.result.current.ready).toBe(true);
    expect(h.call.mock.calls.filter(([m]) => m === 'thread/history')).toHaveLength(1);
  });
});
it('renews the bounded execution proof for the next turn even when all live item completions arrived', async () => {
  let reads=0;
  const h=harness(params=>{
    if (!params.intent) throw new RpcError('capacity','capacity');
    reads++; return page([], {complete:false,turnsComplete:false,truncated:true,executionReady:true});
  });
  const v=renderHook(()=>useConversation(h.api,h.events,'new','epoch'));
  await waitFor(()=>expect(v.result.current.ready).toBe(true));
  act(()=>event(h.events,'turn/started',{turn:{id:'t'}}));
  expect(v.result.current.ready).toBe(false);
  act(()=>{
    event(h.events,'item/completed',{turnId:'t',item:{id:'i',type:'agentMessage',text:'done'}});
    event(h.events,'turn/completed',{turn:{id:'t',status:'completed'}});
  });
  await waitFor(()=>expect(v.result.current.ready).toBe(true));
  expect(reads).toBe(2);
  expect(h.call.mock.calls.filter(([m,p])=>m==='thread/history' && !p.intent)).toHaveLength(1);
});

it('releases a timeline body received one page before its authoritative turn without losing the message', async () => {
  const large = { type: 'agentMessage', id: 'long-item', text: 'a'.repeat(2_100_000) };
  const continuation = deferred();
  const h = harness(params => params.cursor ? continuation.promise : page([], {
    turnsComplete: false, complete: false, nextCursor: 'older-turn-page',
    timeline: [{ type: 'item', position: 2, turnId: 'long-turn', item: large }],
  }));
  const v = renderHook(() => useConversation(h.api, h.events, 'new', 'epoch'));
  await waitFor(() => expect(v.result.current.timeline).toHaveLength(1));
  expect(v.result.current.timeline[0]).toMatchObject({ item: { text: large.text } });
  await act(async () => continuation.resolve(page([{ id: 'long-turn', status: 'completed', items: [large] }])));
  await waitFor(() => expect(v.result.current.ready).toBe(true));
  expect(v.result.current.turns[0]?.items[0]?.text).toBe(large.text);
  expect(v.result.current.timeline[0]).toEqual({
    type: 'item', position: 2, turnId: 'long-turn', itemReference: true,
    item: { id: 'long-item', type: 'agentMessage' },
  });
  expect(h.call.mock.calls.filter(([method]) => method === 'thread/history')).toHaveLength(2);
});

describe('anchored incremental history repair', () => {
  const turn = (id: string) => ({ id, status: 'completed', items: [
    { type: 'agentMessage', id: id + '-item', text: 'canonical ' + id },
  ] });
  const sequence = (id: string, at: number) => [
    { type: 'turnStarted', turnId: id, position: at }, { type: 'item', itemReference: true, turnId: id, position: at + 1, item: { id: id + '-item', type: 'agentMessage' } },
    { type: 'turnCompleted', status: 'completed', turnId: id, position: at + 2 },
  ];
  function stage(mode: string) {
    const events = new Events(), base = [turn('old'), turn('anchor')], first = [...sequence('old', 0), ...sequence('anchor', 3)];
    let rawReads = 0;
    const waiting = deferred();
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'thread/read') return { thread: { id: 'new', status: { type: mode === 'inactive connection' ? 'notLoaded' : 'idle' } } };
      expect(params.timelineFormat).toBe('references');
      if (params.baseHistoryVersion !== undefined) {
        const timeline = [...sequence('anchor', 3), ...sequence('next', 6)];
        if (mode === 'missing item') timeline.splice(4, 1);
        if (mode === 'wrong timeline anchor') timeline[2] = { ...timeline[2]!, position: 70 };
        const turns = [turn('anchor'), turn('next')];
        if (mode === 'different anchor body') turns[0]!.items[0]!.text = 'edited old body';
        if (mode === 'pending') return waiting.promise;
        return page(turns, { timeline, truncated: true, complete: false, turnsComplete: false, timelineComplete: false,
          executionReady: true, activeRealtimeSessionAtPageStart: mode === 'voice session' ? 'voice' : null,
          historyVersion: mode === 'different version' ? 9 : 8, baseHistoryVerified: mode !== 'lost authorization' });
      }
      rawReads++;
      return rawReads === 1 ? page(base, { timeline: first, historyVersion: 8 }) :
        page([...base, turn('next')], { timeline: [...first, ...sequence('next', 6)], historyVersion: 9 });
    });
    const api = { call } as unknown as Api, view = renderHook(() => useConversation(api, events, 'new', 'epoch'));
    return { view, call, events, reads: () => rawReads, waiting };
  }
  it('preserves the verified prefix and repairs a missing terminal payload with one bounded read', async () => {
    const h = stage('valid');
    await waitFor(() => expect(h.view.result.current.ready).toBe(true));
    const original = h.view.result.current.turns[0];
    act(() => {
      event(h.events, 'turn/started', { turn: { id: 'next' } });
      event(h.events, 'turn/completed', { turn: { id: 'next', status: 'completed' } });
    });
    await waitFor(() => expect(h.view.result.current.turns.at(-1)?.items[0]?.text).toBe('canonical next'));
    expect(h.view.result.current.turns[0]).toBe(original);
    expect(h.view.result.current.complete).toBe(true); expect(h.view.result.current.ready).toBe(true);
    expect(h.reads()).toBe(1);
    expect(h.call.mock.calls.filter(([m,p]) => m === 'thread/history' && p.baseHistoryVersion === 8)).toHaveLength(1);
  });
  it('cannot use a tail for a turn whose beginning was never observed', async () => {
    const h = stage('valid'); await waitFor(() => expect(h.view.result.current.ready).toBe(true));
    act(() => event(h.events, 'turn/completed', { turn: { id: 'next', status: 'completed' } }));
    await waitFor(() => expect(h.reads()).toBe(2));
    expect(h.call.mock.calls.some(([m,p]) => m === 'thread/history' && p.baseHistoryVersion !== undefined)).toBe(false);
  });
  it('rereads the prefix when an earlier completed turn received another item', async () => {
    const h = stage('valid'); await waitFor(() => expect(h.view.result.current.ready).toBe(true));
    act(() => {
      event(h.events, 'item/completed', { turnId: 'old', item: { id: 'late-old', type: 'agentMessage', text: 'late' } });
      event(h.events, 'turn/started', { turn: { id: 'next' } });
      event(h.events, 'turn/completed', { turn: { id: 'next', status: 'completed' } });
    });
    await waitFor(() => expect(h.reads()).toBe(2));
    expect(h.call.mock.calls.some(([m,p]) => m === 'thread/history' && p.baseHistoryVersion !== undefined)).toBe(false);
  });
  it.each(['disconnect', 'revert'])('discards a late incremental reply after %s', async kind => {
    const h = stage('pending'); await waitFor(() => expect(h.view.result.current.ready).toBe(true));
    act(() => {
      event(h.events, 'turn/started', { turn: { id: 'next' } });
      event(h.events, 'turn/completed', { turn: { id: 'next', status: 'completed' } });
    });
    await waitFor(() => expect(h.call.mock.calls.some(([m,p]) => m === 'thread/history' && p.baseHistoryVersion === 8)).toBe(true));
    act(() => kind === 'disconnect' ? h.events.publish({ type: 'resync', data: {} }) : event(h.events, 'thread/reverted', {}));
    await waitFor(() => expect(h.reads()).toBe(2));
    await act(async () => h.waiting.resolve(page([turn('wrong')], { historyVersion: 8, baseHistoryVerified: true })));
    expect(h.view.result.current.turns.map(row => row.id)).toEqual(['old', 'anchor', 'next']);
    expect(h.view.result.current.ready).toBe(true);
  });
  it.each(['missing item', 'wrong timeline anchor', 'different anchor body', 'different version', 'lost authorization', 'voice session', 'inactive connection'])(
    'rereads the complete history when the suffix has %s', async mode => {
      const h = stage(mode); await waitFor(() => expect(h.view.result.current.ready).toBe(true));
      act(() => {
        event(h.events, 'turn/started', { turn: { id: 'next' } });
        event(h.events, 'turn/completed', { turn: { id: 'next', status: 'completed' } });
      });
      await waitFor(() => expect(h.reads()).toBe(2));
      expect(h.view.result.current.turns.map(t => t.id)).toEqual(['old', 'anchor', 'next']);
    });
});
