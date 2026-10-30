// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Api, RpcError } from '../lib/api';
import { Events } from '../lib/events';
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
      { threadId: 'new', limit: 30 }, { threadId: 'new', limit: 30 },
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
