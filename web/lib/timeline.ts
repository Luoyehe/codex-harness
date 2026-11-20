import type { ThreadTimelineEntry } from '../../protocol/ts/v2/ThreadTimelineEntry';
import { array, object, type Item, type Turn } from './types';
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
  for (const entry of [...incoming, ...current]) {
    const key = `${entry.position}:${timelineIdentity(entry)}`;
    const prior = entries.get(key);
    if (entry.itemReference && prior?.type === 'item' && !prior.itemReference && prior.item.type === entry.item.type) continue;
    entries.set(key, entry);
  }
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
  | { type: 'turn'; key: string; turn: Turn; timelineOnly?: true }
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
const terminalStatuses = new Set(['completed', 'failed', 'interrupted']);
export function publicAnswerText(item: Item): string {
  if (typeof item.text === 'string') return item.text;
  return array<unknown>(item.content).map(object)
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text).join('\n');
}

/** Canonical entries locate messages; the turn stream remains authoritative for live item text. */
export function timelineView(turns: Turn[], timeline: TimelineEntry[]) {
  const byId = new Map(turns.map((turn) => [turn.id, turn])),
    rows: TimelineRow[] = [],
    itemPositions = new Map<string, number>(),
    commandTurns = new Map<string, string | null>(),
    reasoningFinished = new Set<string>(),
    visibleItems = new Map<string, Item[]>(),
    finished = new Set<string>();
  const add = (turnId: string, item: Item) => {
    const key = JSON.stringify([turnId, item.id]);
    if (!itemPositions.has(key)) {
      itemPositions.set(key, rows.length);
      if (item.type === 'commandExecution') {
        const previous = commandTurns.get(item.id);
        commandTurns.set(item.id, previous === undefined || previous === turnId ? turnId : null);
      }
      const visible = visibleItems.get(turnId);
      if (visible) visible.push(item); else visibleItems.set(turnId, [item]);
      if (item.type === 'agentMessage' && item.phase === 'final_answer' && publicAnswerText(item).trim())
        reasoningFinished.add(turnId);
      rows.push({ type: 'item', key, turnId, item });
    }
  };
  const finish = (turn: Turn, timelineOnly = false) => {
    turn.items.forEach((item) => add(turn.id, item));
    if (!finished.has(turn.id)) {
      finished.add(turn.id);
      if (terminalStatuses.has(turn.status)) reasoningFinished.add(turn.id);
      const items = visibleItems.get(turn.id) ?? [];
      // An independent timeline page can supply a public body absent from an
      // otherwise known turn. Copy only what this view actually contains.
      const visible = items.length > turn.items.length ? { ...turn, items, itemsView: 'summary' } : turn;
      rows.push({ type: 'turn', key: `turn:${turn.id}`, turn: visible, ...(timelineOnly ? { timelineOnly: true } : {}) });
    }
  };
  // Turn and timeline pages can begin at different positions. Before a
  // canonical anchor, emit only earlier bodies without their own position.
  const positions = new Set<string>(), turnAnchors = new Set<string>();
  const lastBoundary = new Map<string, Extract<TimelineEntry, { type: 'turnStarted' | 'turnCompleted' }>>();
  const lastTurnEntry = new Map<string, TimelineEntry>();
  for (const entry of timeline) {
    if (entry.type === 'realtime') continue;
    turnAnchors.add(entry.turnId);
    if (entry.type !== 'item' || !entry.itemReference) lastTurnEntry.set(entry.turnId, entry);
    if (entry.type === 'item') positions.add(JSON.stringify([entry.turnId, entry.item.id]));
    else lastBoundary.set(entry.turnId, entry);
  }
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
      if (turn && body && body.item.type === entry.item.type) { beforeAnchor(turn, body.index); add(entry.turnId, body.item); }
      else if (!body && !entry.itemReference) add(entry.turnId, entry.item as Item);
    }
    else if (entry.type === 'turnCompleted') {
      const turn = byId.get(entry.turnId);
      if (turn) finish(turn);
    }
    if (entry.type !== 'realtime' && !byId.has(entry.turnId) && lastTurnEntry.get(entry.turnId) === entry) {
      const marker = lastBoundary.get(entry.turnId);
      if (marker?.type === 'turnCompleted' && terminalStatuses.has(marker.status)) {
        // The marker proves the outcome even when only independent public bodies fit.
        finish({ id: marker.turnId, status: marker.status, error: marker.error, itemsView: 'summary', items: [] }, true);
      }
    }
  }
  // Live items without canonical positions stay visible, once, until the final history arrives.
  turns.forEach(turn => finish(turn));
  const getItem = (turnId: string, itemId: string) => {
    const index = itemPositions.get(JSON.stringify([turnId, itemId]));
    const row = index === undefined ? undefined : rows[index];
    return row?.type === 'item' ? row.item : undefined;
  };
  return { rows, itemPositions, commandTurns, getItem, reasoningFinished };
}
export type TimelineView = ReturnType<typeof timelineView>;
export function timelineRows(turns: Turn[], timeline: TimelineEntry[]): TimelineRow[] {
  return timelineView(turns, timeline).rows;
}
