// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Api } from '../lib/api';
import { Events } from '../lib/events';
import { useConversation } from '../hooks/useConversation';
import { Messages } from '../components/Messages';
import { checkedPage } from '../lib/history';
import { mergeTimeline, timelineRows, type TimelineEntry } from '../lib/timeline';
afterEach(cleanup);
const page = (extra: Record<string, unknown> = {}) => ({ turns: [], timeline: [], turnsComplete: true, timelineComplete: true, complete: true, nextCursor: null, historyVersion: 0, activeRealtimeSessionAtPageStart: null, ...extra });
const voice = (position: number, type: 'realtimeSessionStarted' | 'realtimeSessionClosed' | 'transcriptSegment', extra: object = {}): TimelineEntry => ({ position, type: 'realtime', item: { id: String(position), realtimeSessionId: 'voice', type, ...extra } }) as TimelineEntry;
const event = (events: Events, method: string, params: object = {}) => events.publish({ type: method.startsWith('thread/realtime/') ? 'realtime' : 'notification', data: { method, params: { threadId: 'thread', ...params } } });
function harness(history: (params: Record<string, unknown>) => unknown) { const events = new Events(), call = vi.fn(async (method: string, params: Record<string, unknown>) => method === 'thread/read' ? { thread: { id: params.threadId, status: { type: 'idle' } } } : history(params)); const api = { call } as unknown as Api; return { api, events, call }; }
describe('combined canonical voice and turn history', () => {
  it('rejects turn-only completion and missing version contracts', () => {
    expect(() => checkedPage({ turns: [], complete: true, nextCursor: null }, new Set())).toThrow('语音时间线');
    expect(() => checkedPage(page({ timelineComplete: false }), new Set())).toThrow('语音时间线');
    expect(() => checkedPage(page({ historyVersion: -1 }), new Set())).toThrow();
  });
  it('continues reading empty turn pages until the timeline reaches its own end', async () => {
    let finish!: (v: unknown) => void;
    const h = harness(p => p.cursor ? new Promise(resolve => { finish = resolve; }) : page({ timeline: [voice(4, 'realtimeSessionClosed', { outcome: 'ended' })], complete: false, timelineComplete: false, nextCursor: 'opaque' }));
    const { result } = renderHook(() => useConversation(h.api, h.events, 'thread', 'epoch'));
    await waitFor(() => expect(result.current.timeline).toHaveLength(1)); expect(result.current.ready).toBe(false);
    await act(async () => finish(page({ timeline: [voice(1, 'realtimeSessionStarted'), voice(2, 'transcriptSegment', { role: 'user', text: 'spoken request' })] })));
    expect(result.current.ready).toBe(true); expect(result.current.timeline.map(item => item.position)).toEqual([1, 2, 4]);
  });
  it('preserves stable chronology for different entry kinds sharing a position across pages', () => {
    const completed: TimelineEntry = { type: 'turnCompleted', position: 9, turnId: 't', status: 'completed', error: null, startedAt: null, completedAt: null, durationMs: null };
    const started: TimelineEntry = { type: 'turnStarted', position: 9, turnId: 't', startedAt: null };
    expect(mergeTimeline([completed], [started, completed]).map(item => item.type)).toEqual(['turnStarted', 'turnCompleted']);
  });
  it('prefers streamed ordinary items and renders each ordinary item once beside voice records', () => {
    Element.prototype.scrollIntoView = vi.fn();
    const turns = [{ id: 't', status: 'completed', items: [{ id: 'a', type: 'agentMessage', text: 'final answer' }] }];
    const timeline = [voice(1, 'realtimeSessionStarted'), { type: 'item', position: 2, turnId: 't', item: { id: 'a', type: 'agentMessage', text: 'old snapshot' } }, voice(3, 'transcriptSegment', { role: 'assistant', text: '<script>plain voice transcript</script>' }), { type: 'realtime', position: 4, item: { id: 'promotion', realtimeSessionId: 'voice', type: 'bemItemPromoted', turnId: 't', itemId: 'a', presentation: { type: 'wholeItem' } } }, voice(5, 'realtimeSessionClosed', { outcome: 'ended' })] as TimelineEntry[];
    expect(timelineRows(turns, timeline).filter(row => row.type === 'item')).toHaveLength(1);
    render(<Messages turns={turns} timeline={timeline} loading={false} complete onMore={() => {}}/>);
    expect(screen.getAllByText('final answer')).toHaveLength(1); expect(screen.queryByText('old snapshot')).toBeNull();
    expect(screen.getByText('<script>plain voice transcript</script>')).toBeTruthy(); expect(document.querySelector('script')).toBeNull();
    fireEvent.click(screen.getByText('定位消息')); expect(document.activeElement?.textContent).toContain('final answer');
  });
  it('revokes readiness immediately and ignores a late pre-invalidation page', async () => {
    let finish!: (v: unknown) => void;
    const h = harness(() => new Promise(resolve => { finish = resolve; }));
    const { result } = renderHook(() => useConversation(h.api, h.events, 'thread', 'epoch'));
    act(() => event(h.events, 'thread/history/invalidated', { historyVersion: 2 }));
    await act(async () => finish(page()));
    expect(result.current.ready).toBe(false); expect(result.current.historyStale).toBe(true); expect(result.current.complete).toBe(false);
    expect(h.call.mock.calls.filter(([method]) => method === 'thread/history')).toHaveLength(1);
  });
  it('does not automatically hydrate during voice, then reads all history after close', async () => {
    let count = 0;
    const h = harness(() => page({ historyVersion: count++ === 0 ? 0 : 3, timeline: count > 1 ? [voice(1, 'realtimeSessionStarted'), voice(2, 'realtimeSessionClosed', { outcome: 'ended' })] : [] }));
    const { result } = renderHook(() => useConversation(h.api, h.events, 'thread', 'epoch'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => { event(h.events, 'thread/history/invalidated', { historyVersion: 1 }); event(h.events, 'thread/realtime/started'); });
    expect(result.current.ready).toBe(false); expect(result.current.realtimeActive).toBe(true);
    act(() => { result.current.refresh(); event(h.events, 'thread/history/invalidated', { historyVersion: 2 }); event(h.events, 'thread/realtime/outputAudio/delta'); });
    expect(count).toBe(1);
    act(() => { event(h.events, 'thread/history/invalidated', { historyVersion: 3 }); event(h.events, 'thread/realtime/closed'); });
    await waitFor(() => expect(result.current.ready).toBe(true)); expect(count).toBe(2); expect(result.current.realtimeActive).toBe(false);
  });
  it('keeps active voice from a page opening state even when the start entry is older', async () => {
    const h = harness(() => page({ timeline: [voice(2, 'transcriptSegment', { role: 'user', text: 'active' })], activeRealtimeSessionAtPageStart: 'voice' }));
    const { result } = renderHook(() => useConversation(h.api, h.events, 'thread', 'epoch'));
    await waitFor(() => expect(result.current.complete).toBe(true)); expect(result.current.ready).toBe(false); expect(result.current.realtimeActive).toBe(true);
  });
  it('rejects mixed versions and retains the completed portion without granting proof', async () => {
    const h = harness(p => p.cursor ? page({ historyVersion: 2 }) : page({ historyVersion: 1, timeline: [voice(4, 'realtimeSessionClosed', { outcome: 'ended' })], timelineComplete: false, complete: false, nextCursor: 'older' }));
    const { result } = renderHook(() => useConversation(h.api, h.events, 'thread', 'epoch'));
    await waitFor(() => expect(result.current.error).toContain('版本已变化')); expect(result.current.ready).toBe(false); expect(result.current.timeline).toHaveLength(1);
  });
  it('clears the old voice lock on navigation and ignores old-thread lifecycle events', async () => {
    const h = harness(p => p.threadId === 'thread' ? page({ timeline: [voice(1, 'realtimeSessionStarted')] }) : page());
    const { result, rerender } = renderHook(({ id }) => useConversation(h.api, h.events, id, 'epoch'), { initialProps: { id: 'thread' } });
    await waitFor(() => expect(result.current.realtimeActive).toBe(true)); rerender({ id: 'other' });
    await waitFor(() => expect(result.current.ready).toBe(true)); act(() => event(h.events, 'thread/realtime/started'));
    expect(result.current.realtimeActive).toBe(false); expect(result.current.thread?.id).toBe('other');
  });
  it('permits an explicit recheck of foreign voice state without an automatic read loop', async () => {
    let reads = 0; const h = harness(() => page({ timeline: ++reads === 1 ? [voice(1, 'realtimeSessionStarted')] : [voice(1, 'realtimeSessionStarted'), voice(3, 'realtimeSessionClosed', { outcome: 'ended' })] }));
    const { result } = renderHook(() => useConversation(h.api, h.events, 'thread', 'epoch'));
    await waitFor(() => expect(result.current.realtimeActive).toBe(true)); expect(reads).toBe(1);
    act(() => result.current.recheck()); await waitFor(() => expect(result.current.ready).toBe(true)); expect(reads).toBe(2);
  });
});
it('handles confirmed component lifecycle callbacks without relying on notifications', async () => {
  const h = harness(() => page()); const { result } = renderHook(() => useConversation(h.api, h.events, 'thread', 'epoch'));
  await waitFor(() => expect(result.current.ready).toBe(true)); act(() => result.current.voiceStarted('thread'));
  expect(result.current.ready).toBe(false); expect(result.current.realtimeActive).toBe(true);
  act(() => result.current.voiceClosed('foreign')); expect(result.current.realtimeActive).toBe(true);
  act(() => result.current.voiceClosed('thread')); await waitFor(() => expect(result.current.ready).toBe(true));
  const reads = h.call.mock.calls.length; act(() => result.current.voiceClosed('thread')); expect(h.call.mock.calls).toHaveLength(reads);
});
