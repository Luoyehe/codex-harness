import type { ThreadTimelineEntry } from '../../protocol/ts/v2/ThreadTimelineEntry';
import { object, type Item, type Turn } from './types';
export type TimelineEntry = ThreadTimelineEntry;
export type RealtimeItem = Extract<TimelineEntry, { type: 'realtime' }>['item'];
const id = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 4096;
export function checkedTimeline(value: unknown): TimelineEntry[] {
  if (!Array.isArray(value)) throw new Error('历史响应缺少语音时间线。');
  for (const raw of value) {
    const entry = object(raw), item = object(entry.item);
    if (!Number.isSafeInteger(entry.position) || Number(entry.position) < 0) throw new Error('时间线位置无效。');
    if (entry.type === 'realtime') {
      if (!id(item.id) || !id(item.realtimeSessionId)) throw new Error('语音时间线缺少身份信息。');
      if (item.type === 'transcriptSegment' && (typeof item.text !== 'string' || !['user', 'assistant'].includes(String(item.role)))) throw new Error('语音转写格式无效。');
      else if (item.type === 'bemItemPromoted' && (!id(item.turnId) || !id(item.itemId) || !['wholeItem', 'inlineMarkdown', 'inlineVisualization'].includes(String(object(item.presentation).type)))) throw new Error('语音消息引用无效。');
      else if (item.type === 'realtimeSessionClosed' && !['ended', 'failed'].includes(String(item.outcome))) throw new Error('语音结束状态无效。');
      else if (!['realtimeSessionStarted', 'transcriptSegment', 'bemItemPromoted', 'realtimeSessionClosed'].includes(String(item.type))) throw new Error('无法识别的语音时间线条目。');
    } else if (entry.type === 'item') {
      if (!id(entry.turnId) || !id(item.id) || !id(item.type)) throw new Error('时间线消息引用无效。');
    } else if (entry.type === 'turnStarted' || entry.type === 'turnCompleted') {
      if (!id(entry.turnId)) throw new Error('时间线回合身份无效。');
    } else throw new Error('无法识别的时间线条目。');
  }
  return value as TimelineEntry[];
}
export function timelineIdentity(entry: TimelineEntry): string {
  return entry.type === 'realtime' ? `realtime:${entry.item.realtimeSessionId}:${entry.item.id}` : entry.type === 'item' ? `item:${entry.turnId}:${entry.item.id}` : `${entry.type}:${entry.turnId}`;
}
export function mergeTimeline(current: TimelineEntry[], incoming: TimelineEntry[]): TimelineEntry[] {
  // Pages walk newest to oldest, while entries within a page are chronological.
  // Different canonical kinds may share a position; stable prepend order matters.
  const entries = new Map<string, TimelineEntry>();
  for (const entry of [...incoming, ...current]) entries.set(`${entry.position}:${timelineIdentity(entry)}`, entry);
  return [...entries.values()].sort((a, b) => a.position - b.position);
}
export function activeRealtime(timeline: TimelineEntry[], opening: string | null): string | null {
  let active = opening;
  for (const entry of timeline) if (entry.type === 'realtime') {
    if (entry.item.type === 'realtimeSessionStarted') active = entry.item.realtimeSessionId;
    else if (entry.item.type === 'realtimeSessionClosed' && active === entry.item.realtimeSessionId) active = null;
  }
  return active;
}
export type TimelineRow = { type: 'item'; key: string; turnId: string; item: Item } | { type: 'turn'; key: string; turn: Turn } | { type: 'realtime'; key: string; item: RealtimeItem };
/** Canonical entries locate messages; the turn stream remains authoritative for live item text. */
export function timelineRows(turns: Turn[], timeline: TimelineEntry[]): TimelineRow[] {
  const byId = new Map(turns.map(turn => [turn.id, turn])), rows: TimelineRow[] = [], shown = new Set<string>(), finished = new Set<string>();
  const add = (turnId: string, item: Item) => { const key = JSON.stringify([turnId, item.id]); if (!shown.has(key)) { shown.add(key); rows.push({ type: 'item', key, turnId, item }); } };
  const finish = (turn: Turn) => { turn.items.forEach(item => add(turn.id, item)); if (!finished.has(turn.id)) { finished.add(turn.id); rows.push({ type: 'turn', key: `turn:${turn.id}`, turn }); } };
  for (const entry of timeline) {
    if (entry.type === 'realtime') rows.push({ type: 'realtime', key: timelineIdentity(entry), item: entry.item });
    else if (entry.type === 'item') add(entry.turnId, byId.get(entry.turnId)?.items.find(item => item.id === entry.item.id) ?? entry.item as Item);
    else if (entry.type === 'turnCompleted') { const turn = byId.get(entry.turnId); if (turn) finish(turn); }
  }
  // Live items without canonical positions stay visible, once, until the final history arrives.
  turns.forEach(finish);
  return rows;
}
