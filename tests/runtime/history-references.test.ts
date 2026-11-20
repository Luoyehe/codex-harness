import { expect, test } from 'vitest';
import { longConversationData } from './history-window-fixture.js';
import { UnifiedHistory } from '../../src/runtime/history.js';
import { GeneratedMedia } from '../../src/runtime/generated-media.js';
import { readMediaHistory } from '../../src/runtime/media-history.js';
import { DeliveryError, object, type JsonObject, type JsonValue } from '../../src/runtime/types.js';
import type { Activity } from '../../src/runtime/thread-activity.js';
import { boundedCombined, checkedPage } from '../../web/lib/history.js';
import { compactTimelineEntries, mergeTimeline, timelineRows } from '../../web/lib/timeline.js';

const owner = { clientId: 'owner', eventChannelId: 'tab' };
const message = (id: string, text: string) => ({ id, type: 'agentMessage', text, phase: 'final_answer', memoryCitation: null });
const timelineItem = (turnId: string, item: ReturnType<typeof message>, position: number) => ({ type: 'item', position, turnId, item });
const turn = (id: string, items: ReturnType<typeof message>[]) => ({ id, items, itemsView: 'full', status: 'completed' });
function fixture(turnPages: JsonObject[][], timelinePages: JsonObject[][]) {
  const state: Activity = { status: 'idle', turnId: null, pending: false, unknown: false, revision: 1, historyMode: 'paginated', historyRevision: 4 };
  return new UnifiedHistory({ state: () => state, closed: () => false, observe() {}, checkTurns() {}, native: async (method, params) => {
    if (method === 'thread/read') return { thread: { id: 'thread' } };
    const timeline = method === 'thread/timeline/list', pages = timeline ? timelinePages : turnPages;
    const index = Number(object(params).cursor ?? 0);
    return { data: pages[index] ?? [], nextCursor: index + 1 < pages.length ? String(index + 1) : null,
      ...(timeline ? { activeRealtimeSessionAtPageStart: null } : {}) };
  } });
}

test('five large turns send their prose once and retain voice and timeline-only content', async () => {
  const items = Array.from({ length: 5 }, (_, i) => message('m'+i, String(i).repeat(430000)));
  const turns = items.map((item, i) => turn('t'+i, [item]));
  const independent = message('only', 'timeline-only content');
  const timeline = [...items.map((item, i) => timelineItem('t'+i, item, i)), timelineItem('other', independent, 5),
    { type: 'realtime', position: 6, item: { type: 'transcriptSegment', id: 'voice', realtimeSessionId: 'call', role: 'user', text: 'spoken text' } }];
  const history = fixture([turns], [timeline]);
  const legacy = checkedPage(await history.read({ threadId: 'thread' }, owner), new Set());
  expect(() => boundedCombined(legacy.turns, legacy.timeline)).toThrow();
  const raw = await history.read({ threadId: 'thread', timelineFormat: 'references' }, owner);
  const compact = checkedPage(raw, new Set());
  expect(compact.timeline.filter(row => row.itemReference)).toHaveLength(5);
  expect(JSON.stringify(raw).length).toBeLessThan(2200000);
  expect(() => boundedCombined(compact.turns, compact.timeline)).not.toThrow();
  const visible = timelineRows(compact.turns, compact.timeline);
  expect(visible.filter(row => row.type === 'item').map(row => row.item.text)).toEqual([...items, independent].map(item => item.text));
  expect(visible.some(row => row.type === 'realtime' && row.item.type === 'transcriptSegment' && row.item.text === 'spoken text')).toBe(true);
});

test('references are scoped to a traversal; a previous complete version is required for a tail update', async () => {
  const earlier = message('sameId', 'older turn'), later = message('sameId', 'newer turn');
  const history = fixture([[turn('new', [later])], [turn('old', [earlier])]],
    [[timelineItem('old', earlier, 2)], [timelineItem('new', later, 3)]]);
  const base = { threadId: 'thread', limit: 2, timelineFormat: 'references' };
  const first = object(await history.read(base, owner));
  expect(first.timeline).toEqual([timelineItem('old', earlier, 2)]);
  await expect(history.read({ threadId: 'thread', cursor: first.nextCursor! }, owner)).rejects.toMatchObject({ code: 'invalid_cursor' });
  const last = object(await history.read({ ...base, cursor: first.nextCursor! }, owner));
  expect(last.timeline).toEqual([{ ...timelineItem('new', later, 3), itemReference: true, item: { id: later.id, type: later.type } }]);
  const firstPage = checkedPage(first, new Set()), lastPage = checkedPage(last, new Set());
  const turns = [...lastPage.turns, ...firstPage.turns];
  const compacted = compactTimelineEntries(turns, mergeTimeline(firstPage.timeline, lastPage.timeline));
  expect(compacted.map(entry => entry.itemReference)).toEqual([true, true]);
  expect(timelineRows(turns, compacted).filter(row => row.type === 'item').map(row => row.item.text)).toEqual(['older turn', 'newer turn']);
  const request = { ...base, intent: 'window', baseHistoryVersion: 4 };
  expect(await history.read(request, owner)).toMatchObject({ baseHistoryVerified: true });
  expect(await history.read(request, { ...owner, eventChannelId: 'other-tab' })).toMatchObject({ baseHistoryVerified: false });
  expect(await history.read({ ...request, baseHistoryVersion: 3 }, owner)).toMatchObject({ baseHistoryVerified: false });
  history.invalidate('thread');
  expect(await history.read(request, owner)).toMatchObject({ baseHistoryVerified: false });
});

test.each([20, 1])('retains the newest final and its position when the latest turn exceeds the display window at limit %i', async limit => {
  const { turns, timeline } = longConversationData();
  const store = fixture([turns.slice(0, limit)], [timeline.slice(-limit)]);
  const full = fixture([turns], [timeline]);
  const input = { threadId: 'thread', timelineFormat: 'references' };
  const baseline = JSON.stringify(await full.read({ ...input, limit: 30 }, owner));
  expect(baseline.length).toBeGreaterThan(4_000_000);
  await store.read({ ...input, limit: 30 }, owner);
  const raw = await store.read({ ...input, intent: 'window', baseHistoryVersion: 4, limit }, owner);
  expect(JSON.stringify(raw).length).toBeLessThanOrEqual(1_000_000);
  expect(raw).toMatchObject({ baseHistoryVerified: false, truncated: true, complete: false, executionReady: true });
  const page = checkedPage(raw, new Set());
  const visible = timelineRows(page.turns, page.timeline).filter(row => row.type === 'item' && row.turnId === 'latest');
  expect(visible.map(row => row.type === 'item' && row.item.id)).toEqual(['prompt-latest', 'progress', 'answer-latest']);
  expect(visible.at(-1)).toMatchObject({ item: { text: 'completed and visible final' } });
  for (const row of page.timeline) if (row.type === 'item' && row.itemReference)
    expect(page.turns.find(turn => turn.id === row.turnId)?.items.some(item => item.id === row.item.id && item.type === row.item.type)).toBe(true);
  expect(JSON.stringify(await full.read({ ...input, limit: 30 }, owner))).toBe(baseline);
});

test.each(['opaque', 'long answer'])('recovers the timeline-only %s behind the final turnCompleted marker', async kind => {
  const state: Activity = { status: 'idle', turnId: null, pending: false, unknown: false, revision: 1, historyMode: 'paginated' };
  const huge = '💬'.repeat(2_200_000);
  const text = kind === 'opaque' ? 'previous short final' : 'answer begins' + huge + 'answer ends';
  const entries: JsonObject[] = [
    { type: 'realtime', position: 0, item: { type: 'realtimeSessionStarted', id: 'start', realtimeSessionId: 'voice' } },
    timelineItem('t', message('answer', text), 1),
    ...(kind === 'opaque' ? [{ type: 'item', turnId: 't', position: 2, item: { type: 'mcpToolCall', id: 'opaque',
      server: 'example', tool: 'read', status: 'completed', arguments: { data: huge }, result: null, error: null, durationMs: 1 } }] : []),
    { type: 'turnCompleted', position: 3, turnId: 't', status: 'completed', error: null, startedAt: null, completedAt: null, durationMs: null },
  ];
  const native = async (method: string, params: JsonValue): Promise<JsonValue> => {
    const request = object(params);
    if (method === 'thread/read') return { thread: { id: 'thread' } };
    if (method === 'thread/turns/list') throw new DeliveryError('capacity', 'turn too large');
    expect(method).toBe('thread/timeline/list');
    const start = Number(request.cursor ?? 0), end = start + (start === 0 ? 1 : Number(request.limit));
    return { data: entries.toReversed().slice(start, end).reverse(),
      nextCursor: end >= entries.length ? null : String(end), activeRealtimeSessionAtPageStart: end >= entries.length ? null : 'voice' };
  };
  const media = new GeneratedMedia({ native, closed: () => false, revision: () => 0 });
  const history = new UnifiedHistory({ state: () => state, closed: () => false, observe() {}, checkTurns() {},
    native: (method, params, _preview, tail) => readMediaHistory(native, media, method, params, tail ? { historyWindowTail: true } : {}) });
  const raw = await history.read({ threadId: 'thread', intent: 'window', limit: 1, timelineFormat: 'references' }, owner);
  expect(JSON.stringify(raw).length).toBeLessThanOrEqual(1_000_000);
  const page = checkedPage(raw, new Set());
  expect(page).toMatchObject({ turns: [], truncated: true, complete: false, executionReady: false });
  expect(page.timeline.at(-1)?.type).toBe('turnCompleted');
  const answer = timelineRows(page.turns, page.timeline).find(row => row.type === 'item' && row.item.id === 'answer');
  if (kind === 'opaque') expect(answer).toMatchObject({ item: { text } });
  else {
    expect(answer).toMatchObject({ item: { text: expect.stringMatching(/^answer begins[\s\S]*最近历史窗口[\s\S]*answer ends$/) } });
    expect(JSON.stringify(answer).isWellFormed()).toBe(true);
  }
});
