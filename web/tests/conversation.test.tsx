// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Api } from '../lib/api';
import { Events } from '../lib/events';
import { useConversation } from '../hooks/useConversation';
import { Messages } from '../components/Messages';
import { StrictMode } from 'react';
afterEach(cleanup);
describe('conversation synchronization', () => {
  it('labels historical text and unpositioned live fragments as separate sources instead of concatenating them', () => {
    Element.prototype.scrollIntoView = vi.fn();
    render(<Messages turns={[{ id: 't', status: 'inProgress', items: [{ id: 'a', type: 'agentMessage', text: 'snapshot repeated', historySync: { field: 'text', snapshot: 'snapshot repeated', deltas: 'repeated' } }] }]} loading={false} complete onMore={() => {}}/>);
    expect(screen.getByText('已读取的历史快照')).toBeTruthy();
    expect(screen.getByText('同步期间收到的实时片段（可能与快照重叠）')).toBeTruthy();
    expect(screen.getByText('snapshot repeated')).toBeTruthy();
    expect(screen.getByText('repeated')).toBeTruthy();
    expect(screen.queryByText('snapshot repeatedrepeated')).toBeNull();
  });
  it.each([false, true])('reads final history after turn completion without item completion (observed start=%s)', async observedStart => {
    let finish!: (value: unknown) => void, histories = 0;
    const events = new Events();
    const final = { turns: [{ id: 'u', status: 'completed', items: [{ id: 'q', type: 'userMessage', content: [] }, { id: 'a', type: 'agentMessage', text: 'authoritative final' }] }], timeline: [], turnsComplete: true, timelineComplete: true, historyVersion: 0, activeRealtimeSessionAtPageStart: null, complete: true, nextCursor: null };
    const call = vi.fn(async (method: string) => method === 'thread/read' ? { thread: { id: 't', status: { type: 'idle' } } } : ++histories === 1 ? new Promise(resolve => { finish = resolve; }) : final);
    const api = { call } as unknown as Api;
    const { result } = renderHook(() => useConversation(api, events, 't', 'one'));
    if (observedStart) act(() => events.publish({ type: 'notification', data: { method: 'item/started', params: { threadId: 't', turnId: 'u', item: { id: 'a', type: 'agentMessage', text: 'live base ' } } } }));
    act(() => events.publish({ type: 'notification', data: { method: 'item/agentMessage/delta', params: { threadId: 't', turnId: 'u', itemId: 'a', delta: 'live suffix' } } }));
    await act(async () => finish({ turns: [{ id: 'u', status: 'inProgress', items: [{ id: 'q', type: 'userMessage', content: [] }, { id: 'a', type: 'agentMessage', text: 'historical prefix' }] }], timeline: [], turnsComplete: true, timelineComplete: true, historyVersion: 0, activeRealtimeSessionAtPageStart: null, complete: true, nextCursor: null }));
    expect(result.current.ready).toBe(observedStart);
    expect(result.current.turns[0]?.items.map(i => i.id)).toEqual(['q', 'a']);
    if (!observedStart) expect(result.current.turns[0]?.items[1]?.historySync).toMatchObject({ snapshot: 'historical prefix', deltas: 'live suffix' });
    else expect(result.current.turns[0]?.items[1]?.text).toBe('live base live suffix');
    act(() => {
      events.publish({ type: 'notification', data: { method: 'turn/diff/updated', params: { threadId: 't', turnId: 'u', diff: '-before\n+after' } } });
      events.publish({ type: 'notification', data: { method: 'thread/tokenUsage/updated', params: { threadId: 't', tokenUsage: { total: 42 } } } });
    });
    act(() => events.publish({ type: 'notification', data: { method: 'turn/completed', params: { threadId: 't', turn: { id: 'u', status: 'completed' } } } }));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(histories).toBe(2);
    expect(result.current.turns[0]?.items[1]).toEqual({ id: 'a', type: 'agentMessage', text: 'authoritative final' });
    expect(result.current.diff).toBe('-before\n+after'); expect(result.current.usage).toEqual({ total: 42 });
    expect(call.mock.calls.every(([method]) => ['thread/read', 'thread/history'].includes(method))).toBe(true);
  });
  it('keeps sending disabled until all bounded pages complete and preserves live items', async () => {
    let resolvePage!: (v: unknown) => void;
    const later = new Promise(resolve => { resolvePage = resolve; }), events = new Events(), cursor = 'opaque'.repeat(170);
    const api = { call: vi.fn(async (method: string, p: Record<string, unknown>) => {
      if (method === 'thread/read') return { thread: { id: 'a', status: { type: 'active' } } };
      if (!Object.hasOwn(p, 'cursor')) return { turns: [{ id: 'new', status: 'inProgress', items: [] }], nextCursor: cursor, timeline: [], turnsComplete: false, timelineComplete: false, historyVersion: 0, activeRealtimeSessionAtPageStart: null, complete: false };
      return later;
    }) } as unknown as Api;
    const { result } = renderHook(() => useConversation(api, events, 'a', 'epoch'));
    await waitFor(() => expect(result.current.turns.length).toBe(1)); expect(result.current.ready).toBe(false);
    act(() => events.publish({ type: 'notification', data: { method: 'item/completed', params: { threadId: 'a', turnId: 'new', item: { id: 'live', type: 'agentMessage', text: 'kept' } } } }));
    await act(async () => resolvePage({ turns: [{ id: 'old', status: 'completed', items: [] }, { id: 'new', status: 'inProgress', items: [{ id: 'live', type: 'agentMessage', text: 'stale' }] }], nextCursor: null, timeline: [], turnsComplete: true, timelineComplete: true, historyVersion: 0, activeRealtimeSessionAtPageStart: null, complete: true }));
    await waitFor(() => expect(result.current.ready).toBe(true)); expect(result.current.turns[1]?.items[0]?.text).toBe('kept');
    expect(api.call).toHaveBeenCalledWith('thread/history', { threadId: 'a', cursor, limit: 30 }, expect.anything());
  });
  it('ignores the old thread history after explicit navigation', async () => {
    let finishOld!: (v: unknown) => void;
    const old = new Promise(resolve => { finishOld = resolve; }), events = new Events();
    const api = { call: vi.fn(async (method: string, p: Record<string, unknown>) => method === 'thread/read' ? { thread: { id: p.threadId } } : p.threadId === 'a' ? old : { turns: [{ id: 'b-turn', status: 'completed', items: [] }], timeline: [], turnsComplete: true, timelineComplete: true, historyVersion: 0, activeRealtimeSessionAtPageStart: null, complete: true, nextCursor: null }) } as unknown as Api;
    const { result, rerender } = renderHook(({ id }) => useConversation(api, events, id, 'epoch'), { initialProps: { id: 'a' } });
    rerender({ id: 'b' }); await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => finishOld({ turns: [{ id: 'old-a', items: [] }], timeline: [], turnsComplete: true, timelineComplete: true, historyVersion: 0, activeRealtimeSessionAtPageStart: null, complete: true, nextCursor: null }));
    expect(result.current.turns.map(t => t.id)).toEqual(['b-turn']); expect(result.current.thread?.id).toBe('b');
  });
});

const emptyHistory = { turns: [], timeline: [], turnsComplete: true, timelineComplete: true, historyVersion: 0, activeRealtimeSessionAtPageStart: null, complete: true, nextCursor: null };
function conversationApi() {
  return { call: vi.fn(async (method: string, params: Record<string, unknown>) => method === 'thread/read' ? { thread: { id: params.threadId, status: { type: 'idle' } } } : emptyHistory) } as unknown as Api;
}
describe('conversation voice callback ownership', () => {
  it.each(['thread', 'epoch', 'api', 'thread ABA', 'api ABA'] as const)('keeps current voice active when a previous visit closes after %s changes', change => {
    const api = { call: vi.fn(() => new Promise(() => {})) } as unknown as Api, events = new Events(), initial = { api, id: 'a', epoch: 'one' };
    const hook = renderHook(({ api, id, epoch }) => useConversation(api, events, id, epoch), { initialProps: initial });
    const oldClose = hook.result.current.voiceClosed;
    const next = { ...initial, ...(change.startsWith('thread') ? { id: 'b' } : change === 'epoch' ? { epoch: 'two' } : { api: { call: vi.fn(() => new Promise(() => {})) } as unknown as Api }) };
    hook.rerender(next); if (change.endsWith('ABA')) hook.rerender(initial);
    act(() => hook.result.current.voiceStarted(change.endsWith('ABA') ? 'a' : next.id)); expect(hook.result.current.realtimeActive).toBe(true);
    act(() => oldClose('a')); expect(hook.result.current.realtimeActive).toBe(true);
  });
  it.each(['thread', 'epoch', 'api', 'thread ABA', 'api ABA'] as const)('rejects both callbacks from the prior visit after %s changes', async change => {
    const api = conversationApi(), events = new Events(), initial = { api, id: 'a', epoch: 'one' };
    const hook = renderHook(({ api, id, epoch }) => useConversation(api, events, id, epoch), { initialProps: initial });
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    const old = hook.result.current;
    const next = { ...initial, ...(change.startsWith('thread') ? { id: 'b' } : change === 'epoch' ? { epoch: 'two' } : { api: conversationApi() }) };
    hook.rerender(next);
    if (change.endsWith('ABA')) hook.rerender(initial);
    const id = change.endsWith('ABA') ? 'a' : next.id;
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    const current = hook.result.current;
    act(() => old.voiceStarted('a'));
    expect(hook.result.current.realtimeActive).toBe(false); expect(hook.result.current.ready).toBe(true); expect(hook.result.current.historyStale).toBe(false);
    act(() => current.voiceStarted(id));
    expect(hook.result.current.realtimeActive).toBe(true); expect(hook.result.current.ready).toBe(false);
    act(() => old.voiceClosed('a'));
    expect(hook.result.current.realtimeActive).toBe(true);
    act(() => current.voiceClosed(id));
    await waitFor(() => expect(hook.result.current.ready).toBe(true)); expect(hook.result.current.realtimeActive).toBe(false);
  });
  it('clears API-owned voice and metadata even when replacement history fails', async () => {
    const events = new Events(), api = conversationApi(), replacement = { call: vi.fn(async () => { throw new Error('replacement history unavailable'); }) } as unknown as Api;
    const hook = renderHook(({ api }) => useConversation(api, events, 'a', 'one'), { initialProps: { api } });
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    act(() => {
      events.publish({ type: 'notification', data: { method: 'turn/diff/updated', params: { threadId: 'a', diff: 'old diff' } } });
      events.publish({ type: 'notification', data: { method: 'thread/tokenUsage/updated', params: { threadId: 'a', tokenUsage: { total: 42 } } } });
      hook.result.current.voiceStarted('a');
    });
    expect(hook.result.current.realtimeActive).toBe(true);
    hook.rerender({ api: replacement }); await waitFor(() => expect(hook.result.current.error).toBe('replacement history unavailable'));
    expect(hook.result.current.realtimeActive).toBe(false); expect(hook.result.current.diff).toBe(''); expect(hook.result.current.usage).toBeUndefined();
  });
  it('resets the history version floor for a replacement API', async () => {
    const events = new Events(), api = conversationApi();
    const hook = renderHook(({ api }) => useConversation(api, events, 'a', 'one'), { initialProps: { api } });
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    act(() => events.publish({ type: 'notification', data: { method: 'thread/history/invalidated', params: { threadId: 'a', historyVersion: 99 } } }));
    hook.rerender({ api: conversationApi() }); await waitFor(() => expect(hook.result.current.ready).toBe(true)); expect(hook.result.current.error).toBe('');
  });
  it('keeps current callbacks valid across history refresh and StrictMode setup replay', async () => {
    const api = conversationApi(), events = new Events();
    const hook = renderHook(() => useConversation(api, events, 'a', 'one'), { wrapper: StrictMode });
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    const current = hook.result.current, reads = vi.mocked(api.call).mock.calls.length;
    act(() => current.recheck()); await waitFor(() => expect(hook.result.current.ready).toBe(true));
    expect(vi.mocked(api.call).mock.calls.length).toBeGreaterThan(reads);
    act(() => current.voiceStarted('foreign')); expect(hook.result.current.realtimeActive).toBe(false);
    act(() => current.voiceStarted('a')); expect(hook.result.current.realtimeActive).toBe(true);
    act(() => current.voiceClosed('a')); await waitFor(() => expect(hook.result.current.ready).toBe(true));
    hook.unmount(); const completedReads = vi.mocked(api.call).mock.calls.length;
    act(() => { current.voiceStarted('a'); current.voiceClosed('a'); }); expect(vi.mocked(api.call).mock.calls.length).toBe(completedReads);
  });
});
