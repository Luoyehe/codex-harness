import { expect, test } from 'vitest';
import { UnifiedHistory } from '../../src/runtime/history.js';
import { object, type JsonObject } from '../../src/runtime/types.js';
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
