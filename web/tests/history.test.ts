import { describe, expect, it } from 'vitest';
import { applyNotification, checkedPage, mergeHistory } from '../lib/history';
import type { Turn } from '../lib/types';
describe('bounded history and streaming reconciliation', () => {
  it('preserves opaque cursors without truncation and rejects a loop before publishing', () => {
    const cursor = 'c'.repeat(1007);
    expect(checkedPage({ turns: [], timeline: [], turnsComplete: false, timelineComplete: false, historyVersion: 0, activeRealtimeSessionAtPageStart: null, complete: false, nextCursor: cursor }, new Set()).nextCursor).toBe(cursor);
    expect(() => checkedPage({ turns: [], timeline: [], turnsComplete: false, timelineComplete: false, historyVersion: 0, activeRealtimeSessionAtPageStart: null, complete: false, nextCursor: cursor }, new Set([cursor]))).toThrow('循环');
    expect(() => checkedPage({ turns: [], timeline: [], turnsComplete: false, timelineComplete: false, historyVersion: 0, activeRealtimeSessionAtPageStart: null, complete: false, nextCursor: 'x'.repeat(4097) }, new Set())).toThrow();
  });
  it('distinguishes an empty opaque cursor from an absent cursor', () => { expect(checkedPage({ turns: [], timeline: [], turnsComplete: false, timelineComplete: false, historyVersion: 0, activeRealtimeSessionAtPageStart: null, complete: false, nextCursor: '' }, new Set()).nextCursor).toBe(''); expect(() => checkedPage({ turns: [], timeline: [], turnsComplete: false, timelineComplete: false, historyVersion: 0, activeRealtimeSessionAtPageStart: null, complete: false, nextCursor: null }, new Set())).toThrow('尚未完整'); });
  it('keeps newer completed streamed content when an older history page arrives', () => {
    const current: Turn[] = [{ id: 't', status: 'completed', items: [{ id: 'a', type: 'agentMessage', text: 'complete live output' }] }];
    const result = mergeHistory(current, [{ id: 'old', status: 'completed', items: [] }, { id: 't', status: 'inProgress', items: [{ id: 'a', type: 'agentMessage', text: 'stale snapshot' }] }], new Set(['t:a']));
    expect(result.map(t => t.id)).toEqual(['old', 't']); expect(result[1]?.status).toBe('completed'); expect(result[1]?.items[0]?.text).toBe('complete live output');
  });
  it('uses the final item as authoritative and does not revive a completed turn', () => {
    let result = applyNotification([], 'item/agentMessage/delta', { threadId: 'x', turnId: 't', itemId: 'a', delta: 'partial' });
    result = applyNotification(result.turns, 'item/completed', { threadId: 'x', turnId: 't', item: { id: 'a', type: 'agentMessage', text: 'final' } });
    result = applyNotification(result.turns, 'turn/completed', { threadId: 'x', turn: { id: 't', status: 'completed' } });
    result = applyNotification(result.turns, 'turn/started', { threadId: 'x', turn: { id: 't' } });
    expect(result.turns[0]?.status).toBe('completed'); expect(result.turns[0]?.items[0]?.text).toBe('final');
  });
  it('uses snapshot chronology while keeping unbased deltas separate from overlapping history', () => {
    const live = applyNotification([], 'item/agentMessage/delta', { turnId: 't', itemId: 'a', delta: 'same' });
    const merged = mergeHistory(live.turns, [{ id: 't', status: 'inProgress', items: [{ id: 'q', type: 'userMessage', content: [] }, { id: 'a', type: 'agentMessage', text: 'prefix same' }] }], new Set([live.touched!]));
    expect(merged[0]?.items.map(i => i.id)).toEqual(['q', 'a']);
    expect(merged[0]?.items[1]?.historySync).toEqual({ field: 'text', snapshot: 'prefix same', deltas: 'same' });
    const next = applyNotification(merged, 'item/agentMessage/delta', { turnId: 't', itemId: 'a', delta: 'same' });
    expect(next.turns[0]?.items[1]?.historySync).toMatchObject({ snapshot: 'prefix same', deltas: 'samesame' });
    const done = applyNotification(next.turns, 'item/completed', { turnId: 't', item: { id: 'a', type: 'agentMessage', text: 'prefix samesame' } });
    expect(done.turns[0]?.items.map(i => i.id)).toEqual(['q', 'a']);
    expect(done.turns[0]?.items[1]).toEqual({ id: 'a', type: 'agentMessage', text: 'prefix samesame' });
  });
  it('keeps a stream with its own start baseline authoritative and clears uncertainty with completed history', () => {
    const start = applyNotification([], 'item/started', { turnId: 't', item: { id: 'a', type: 'agentMessage', text: 'prefix ' } });
    const delta = applyNotification(start.turns, 'item/agentMessage/delta', { turnId: 't', itemId: 'a', delta: 'new' });
    const active: Turn = { id: 't', status: 'inProgress', items: [{ id: 'q', type: 'userMessage', content: [] }, { id: 'a', type: 'agentMessage', text: 'prefix' }] };
    expect(mergeHistory(delta.turns, [active], new Set([delta.touched!]))[0]?.items[1]).toEqual({ id: 'a', type: 'agentMessage', text: 'prefix new' });
    const snapshot = mergeHistory([], [active], new Set());
    expect(snapshot[0]?.items[1]?.historySync).toMatchObject({ snapshot: 'prefix', deltas: '' });
    const completed = mergeHistory(snapshot, [{ ...active, status: 'completed', items: [{ id: 'a', type: 'agentMessage', text: 'final' }] }], new Set(['t:a']));
    expect(completed[0]?.items.find(i => i.id === 'a')).toEqual({ id: 'a', type: 'agentMessage', text: 'final' });
  });
});
