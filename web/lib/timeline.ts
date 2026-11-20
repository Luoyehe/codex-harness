import type { ThreadTimelineEntry } from '../../protocol/ts/v2/ThreadTimelineEntry';
import { object, type Item, type Turn } from './types';
type OrdinaryItem = Extract<ThreadTimelineEntry, { type: 'item' }>;
type ItemReference = Omit<OrdinaryItem, 'item'> & { itemReference: true; item: Pick<OrdinaryItem['item'], 'id' | 'type'> };
export type TimelineEntry = (ThreadTimelineEntry & { itemReference?: undefined }) | ItemReference;
export type RealtimeItem = Extract<TimelineEntry, { type: 'realtime' }>['item'];
const id = (value: unknown) =>
  typeof value === 'string' && value.length > 0 && value.length <= 4096;
export function checkedTimeline(value: unknown): TimelineEntry[] {
  if (!Array.isArray(value)) throw new Error('历史响应缺少语音时间线。');
  for (const raw of value) {
    const entry = object(raw),
      item = object(entry.item);
    if (!Number.isSafeInteger(entry.position) || Number(entry.position) < 0)
      throw new Error('时间线位置无效。');
    if (Object.hasOwn(entry, 'itemReference') && (entry.itemReference !== true || entry.type !== 'item' ||
        Object.keys(item).some(key => key !== 'id' && key !== 'type'))) throw new Error('时间线消息引用格式无效。');
    if (entry.type === 'realtime') {
      if (!id(item.id) || !id(item.realtimeSessionId)) throw new Error('语音时间线缺少身份信息。');
      if (
        item.type === 'transcriptSegment' &&
        (typeof item.text !== 'string' || !['user', 'assistant'].includes(String(item.role)))
      )
        throw new Error('语音转写格式无效。');
      else if (
        item.type === 'bemItemPromoted' &&
        (!id(item.turnId) ||
          !id(item.itemId) ||
          !['wholeItem', 'inlineMarkdown', 'inlineVisualization'].includes(
            String(object(item.presentation).type),
          ))
      )
        throw new Error('语音消息引用无效。');
      else if (
        item.type === 'realtimeSessionClosed' &&
        !['ended', 'failed'].includes(String(item.outcome))
      )
        throw new Error('语音结束状态无效。');
      else if (
        ![
          'realtimeSessionStarted',
          'transcriptSegment',
          'bemItemPromoted',
          'realtimeSessionClosed',
        ].includes(String(item.type))
      )
        throw new Error('无法识别的语音时间线条目。');
    } else if (entry.type === 'item') {
      if (!id(entry.turnId) || !id(item.id) || !id(item.type))
        throw new Error('时间线消息引用无效。');
    } else if (entry.type === 'turnStarted' || entry.type === 'turnCompleted') {
      if (!id(entry.turnId)) throw new Error('时间线回合身份无效。');
    } else throw new Error('无法识别的时间线条目。');
  }
  return value as TimelineEntry[];
}
export function timelineIdentity(entry: TimelineEntry): string {
  return entry.type === 'realtime'
    ? `realtime:${entry.item.realtimeSessionId}:${entry.item.id}`
    : entry.type === 'item'
      ? `item:${entry.turnId}:${entry.item.id}`
      : `${entry.type}:${entry.turnId}`;
}
export function mergeTimeline(
  current: TimelineEntry[],
  incoming: TimelineEntry[],
): TimelineEntry[] {
  // Pages walk newest to oldest, while entries within a page are chronological.
  // Different canonical kinds may share a position; stable prepend order matters.
  const entries = new Map<string, TimelineEntry>();
  for (const entry of [...incoming, ...current])
    entries.set(`${entry.position}:${timelineIdentity(entry)}`, entry);
  return [...entries.values()].sort((a, b) => a.position - b.position);
}
export function activeRealtime(timeline: TimelineEntry[], opening: string | null): string | null {
  let active = opening;
  for (const entry of timeline)
    if (entry.type === 'realtime') {
      if (entry.item.type === 'realtimeSessionStarted') active = entry.item.realtimeSessionId;
      else if (
        entry.item.type === 'realtimeSessionClosed' &&
        active === entry.item.realtimeSessionId
      )
        active = null;
    }
  return active;
}
export type TimelineRow =
  | { type: 'item'; key: string; turnId: string; item: Item }
  | { type: 'turn'; key: string; turn: Turn }
  | { type: 'realtime'; key: string; item: RealtimeItem };
const turnItemIndexes = new WeakMap<Turn, Map<string, { item: Item; index: number }>>();
function timelineItem(turn: Turn | undefined, id: string): { item: Item; index: number } | undefined {
  if (!turn) return undefined;
  let index = turnItemIndexes.get(turn);
  if (!index) {
    index = new Map(turn.items.map((item, index) => [item.id, { item, index }]));
    turnItemIndexes.set(turn, index);
  }
  return index.get(id);
}
/** Release timeline bodies that arrived before their corresponding turn page. */
export function compactTimelineEntries(turns: Turn[], entries: TimelineEntry[]): TimelineEntry[] {
  if (!entries.some(entry => entry.type === 'item' && !entry.itemReference)) return entries;
  const byId = new Map(turns.map(turn => [turn.id, turn]));
  return entries.map(entry => {
    if (entry.type !== 'item' || entry.itemReference) return entry;
    const { id, type } = entry.item;
    if (timelineItem(byId.get(entry.turnId), id)?.item.type !== type) return entry;
    return { ...entry, itemReference: true, item: { id, type } };
  });
}
/** Canonical entries locate messages; the turn stream remains authoritative for live item text. */
export function timelineRows(turns: Turn[], timeline: TimelineEntry[]): TimelineRow[] {
  const byId = new Map(turns.map((turn) => [turn.id, turn])),
    rows: TimelineRow[] = [],
    shown = new Set<string>(),
    finished = new Set<string>();
  const add = (turnId: string, item: Item) => {
    const key = JSON.stringify([turnId, item.id]);
    if (!shown.has(key)) {
      shown.add(key);
      rows.push({ type: 'item', key, turnId, item });
    }
  };
  const finish = (turn: Turn) => {
    turn.items.forEach((item) => add(turn.id, item));
    if (!finished.has(turn.id)) {
      finished.add(turn.id);
      rows.push({ type: 'turn', key: `turn:${turn.id}`, turn });
    }
  };
  // Turn and timeline pages can begin at different positions. Before a
  // canonical anchor, emit only earlier bodies without their own position.
  const positions = new Set(timeline.flatMap(entry => entry.type === 'item'
    ? [JSON.stringify([entry.turnId, entry.item.id])] : []));
  const turnAnchors = new Set(timeline.flatMap(entry => entry.type !== 'realtime' ? [entry.turnId] : []));
  const turnOrder = new Map(turns.map((turn, index) => [turn.id, index]));
  const nextItem = new Map<string, number>();
  let nextTurn = 0;
  const beforeAnchor = (turn: Turn, anchor: number) => {
    const next = nextItem.get(turn.id) ?? 0;
    for (let i = next; i < anchor; i++) {
      const item = turn.items[i]!;
      if (!positions.has(JSON.stringify([turn.id, item.id]))) add(turn.id, item);
    }
    nextItem.set(turn.id, Math.max(next, anchor + 1));
  };
  for (const entry of timeline) {
    if (entry.type !== 'realtime') {
      const index = turnOrder.get(entry.turnId);
      while (index !== undefined && nextTurn < index) {
        const preceding = turns[nextTurn++]!;
        if (!turnAnchors.has(preceding.id)) finish(preceding);
      }
    }
    if (entry.type === 'realtime')
      rows.push({ type: 'realtime', key: timelineIdentity(entry), item: entry.item });
    else if (entry.type === 'item') {
      const turn = byId.get(entry.turnId), body = timelineItem(turn, entry.item.id);
      if (turn && body) { beforeAnchor(turn, body.index); add(entry.turnId, body.item); }
      else if (!entry.itemReference) add(entry.turnId, entry.item as Item);
    }
    else if (entry.type === 'turnCompleted') {
      const turn = byId.get(entry.turnId);
      if (turn) finish(turn);
    }
  }
  // Live items without canonical positions stay visible, once, until the final history arrives.
  turns.forEach(finish);
  return rows;
}
