import { array, object, type Turn, type Item, type JsonObject } from './types';
import { checkedTimeline, type TimelineEntry } from './timeline';
import { appendStream, streamField, streamSnapshot } from './stream-items';
export const HISTORY_LIMIT = {
  turns: 2000,
  items: 8000,
  chars: 4_000_000,
  pages: 80,
  cursor: 4096,
};
export class HistoryCapacityError extends Error {}
const finalStatus = (status: string) => ['completed', 'failed', 'interrupted'].includes(status);
export const historySyncPending = (turns: Turn[]) =>
  turns.some((turn) => turn.items.some((item) => item.historySync));
function snapshotItem(item: Item, turn: Turn): Item {
  const field = streamField(item);
  // An active snapshot and independent delta channel have no shared watermark.
  // Keep their text separate until a complete item or completed history is authoritative.
  if (
    !field ||
    finalStatus(turn.status) ||
    item.streamComplete ||
    ['completed', 'failed', 'declined'].includes(String(item.status))
  )
    return item;
  return { ...item, historySync: { field, snapshot: streamSnapshot(item, field), deltas: '' } };
}
export function checkedPage(
  value: unknown,
  seen: Set<string>,
): {
  turns: Turn[];
  timeline: TimelineEntry[];
  nextCursor: string | null;
  complete: boolean;
  truncated: boolean;
  executionReady: boolean;
  legacy: boolean;
  historyVersion: number;
  activeRealtimeSessionAtPageStart: string | null;
} {
  const page = object(value);
  if (
    !Array.isArray(page.turns) ||
    typeof page.complete !== 'boolean' ||
    typeof page.turnsComplete !== 'boolean' ||
    typeof page.timelineComplete !== 'boolean' ||
    page.complete !== (page.turnsComplete && page.timelineComplete) ||
    !Number.isSafeInteger(page.historyVersion) ||
    Number(page.historyVersion) < 0 ||
    !(
      page.activeRealtimeSessionAtPageStart === null ||
      (typeof page.activeRealtimeSessionAtPageStart === 'string' &&
        page.activeRealtimeSessionAtPageStart.length > 0)
    )
  )
    throw new Error('完整历史必须同时包含回合、语音时间线和一致的版本信息。');
  const timeline = checkedTimeline(page.timeline);
  const truncated = page.truncated === true;
  if (truncated && (page.complete || typeof page.executionReady !== 'boolean' || page.nextCursor !== null))
    throw new Error('最近历史窗口缺少有效的执行状态。');
  const next = page.nextCursor;
  if (
    next !== null &&
    next !== undefined &&
    (typeof next !== 'string' || next.length > HISTORY_LIMIT.cursor || seen.has(next))
  )
    throw new Error('历史游标无效或循环，已停止加载。');
  if (!truncated && page.complete === false && (next === null || next === undefined))
    throw new Error('历史尚未完整，但服务未提供下一页游标。');
  if (page.complete && next !== null) throw new Error('完整历史仍带有下一页游标。');
  for (const turn of page.turns) {
    const t = object(turn);
    if (
      typeof t.id !== 'string' ||
      !Array.isArray(t.items) ||
      t.items.some((i) => typeof object(i).id !== 'string' || typeof object(i).type !== 'string')
    )
      throw new Error('历史条目缺少身份信息。');
  }
  return {
    turns: page.turns as Turn[],
    timeline,
    nextCursor: typeof next === 'string' ? next : null,
    complete: page.complete,
    truncated,
    executionReady: page.executionReady === undefined ? page.complete : page.executionReady === true,
    legacy: page.legacy === true,
    historyVersion: Number(page.historyVersion),
    activeRealtimeSessionAtPageStart: page.activeRealtimeSessionAtPageStart as string | null,
  };
}
// History rows are immutable. Cache serialized lengths by identity, so stream updates
// account for changed items without reserializing the whole archived transcript.
const lengths = new WeakMap<object, number>();
const itemCounts = new WeakMap<Turn[], number>();
const timelineCounts = new WeakMap<TimelineEntry[], number>();
function itemCount(turns: Turn[]): number {
  const previous = itemCounts.get(turns);
  if (previous !== undefined) return previous;
  const count = turns.reduce((sum, turn) => sum + turn.items.length, 0);
  itemCounts.set(turns, count);
  return count;
}
function jsonLength(value: object): number {
  let length = lengths.get(value);
  if (length === undefined) { length = JSON.stringify(value).length; lengths.set(value, length); }
  return length;
}
function arrayLength<T extends object>(values: T[], measure: (value: T) => number = jsonLength): number {
  const cached = lengths.get(values);
  if (cached !== undefined) return cached;
  let total = 2 + Math.max(0, values.length - 1);
  for (const value of values) total += measure(value);
  lengths.set(values, total);
  return total;
}
function turnLength(turn: Turn): number {
  const cached = lengths.get(turn);
  if (cached !== undefined) return cached;
  const length = JSON.stringify({ ...turn, items: [] }).length - 2 + arrayLength(turn.items);
  lengths.set(turn, length);
  return length;
}
export function boundedCombined(turns: Turn[], timeline: TimelineEntry[]): void {
  const length = arrayLength(turns, turnLength) + arrayLength(timeline) + '{"turns":,"timeline":}'.length;
  let timelineCount = timelineCounts.get(timeline);
  if (timelineCount === undefined) {
    timelineCount = timeline.reduce((sum, entry) => sum + (entry.itemReference ? 0 : 1), 0);
    timelineCounts.set(timeline, timelineCount);
  }
  if (turns.length > HISTORY_LIMIT.turns ||
      timeline.length > HISTORY_LIMIT.items * 2 || itemCount(turns) + timelineCount > HISTORY_LIMIT.items ||
      length > HISTORY_LIMIT.chars)
    throw new HistoryCapacityError('文字与语音历史达到显示窗口上限。');
}
export function bounded(turns: Turn[]): Turn[] {
  if (turns.length > HISTORY_LIMIT.turns || itemCount(turns) > HISTORY_LIMIT.items ||
      arrayLength(turns, turnLength) > HISTORY_LIMIT.chars) throw new HistoryCapacityError('当前历史窗口达到安全容量。');
  return turns;
}
export function mergeHistory(current: Turn[], incoming: Turn[], touched: Set<string>): Turn[] {
  const byId = new Map(current.map((t) => [t.id, t]));
  const older: Turn[] = [];
  for (const turn of incoming) {
    const existing = byId.get(turn.id);
    if (!existing) {
      const value = { ...turn, items: turn.items.map((item) => snapshotItem(item, turn)) };
      older.push(value);
      byId.set(turn.id, value);
      continue;
    }
    const live = new Map(existing.items.map((item) => [item.id, item]));
    const items = turn.items.map((item) => {
      const previous = live.get(item.id);
      live.delete(item.id);
      // MCP progress is transient, not a text delta with an unknown watermark.
      // A terminal snapshot supersedes it; a completed live item stays authoritative.
      if (item.type === 'mcpToolCall' && previous?.type === 'mcpToolCall' &&
        !previous.streamComplete && ['completed', 'failed'].includes(String(item.status)))
        return item;
      if (previous?.historySync)
        return finalStatus(turn.status)
          ? item
          : {
              ...item,
              historySync: {
                ...previous.historySync,
                snapshot: streamSnapshot(item, previous.historySync.field),
              },
            };
      return previous &&
        (previous.streamComplete ||
          touched.has(`${turn.id}:${item.id}`) ||
          (finalStatus(existing.status) && !finalStatus(turn.status)))
        ? previous
        : snapshotItem(item, turn);
    });
    // Snapshot items provide chronology; stream-only items happened after that prefix.
    items.push(...live.values());
    byId.set(turn.id, {
      ...existing,
      ...turn,
      status: finalStatus(existing.status) ? existing.status : turn.status,
      items,
    });
  }
  return bounded([...older, ...current.map((t) => byId.get(t.id)!)]);
}
export function applyNotification(
  turns: Turn[],
  method: string,
  p: JsonObject,
  combinedBudget = false,
): { turns: Turn[]; touched?: string; diff?: string } {
  // The conversation owner checks the complete text+voice budget immediately.
  // Standalone consumers retain the default bounded result contract.

  if (method === 'turn/diff/updated')
    return { turns, diff: typeof p.diff === 'string' ? p.diff : '' };
  const provided = object(p.turn),
    item = object(p.item);
  const turnId =
    typeof p.turnId === 'string' ? p.turnId : typeof provided.id === 'string' ? provided.id : '';
  if (!turnId || (!method.startsWith('turn/') && !method.startsWith('item/'))) return { turns };
  const next = [...turns];
  const turnIndex = turns.at(-1)?.id === turnId ? turns.length - 1 : turns.findIndex(t => t.id === turnId);
  const original = turns[turnIndex];
  const turn: Turn = original ? { ...original, items: [...original.items] } : { id: turnId, status: 'inProgress', items: [] };
  if (original) next[turnIndex] = turn;
  else next.push(turn);
  // Every notification owns one turn. Carry forward known totals for untouched
  // turns instead of walking the transcript again at each streaming update.
  const check = (changedItem?: { before: Item | undefined; after: Item }) => {
    if (original && changedItem) {
      const previousBytes = arrayLength(original.items);
      const change = jsonLength(changedItem.after) - (changedItem.before ? jsonLength(changedItem.before) : 0);
      const comma = !changedItem.before && original.items.length > 0 ? 1 : 0;
      lengths.set(turn.items, previousBytes + change + comma);
    }
    const priorLength = arrayLength(turns, turnLength);
    const comma = !original && turns.length > 0 ? 1 : 0;
    lengths.set(next, priorLength - (original ? turnLength(original) : 0) + turnLength(turn) + comma);
    itemCounts.set(next, itemCount(turns) - (original?.items.length ?? 0) + turn.items.length);
    return combinedBudget ? next : bounded(next);
  };
  if (method === 'turn/started' && !finalStatus(turn.status)) turn.status = 'inProgress';
  if (method === 'turn/completed') {
    turn.status = String(provided.status ?? 'completed');
    turn.error = provided.error;
    turn.items = turn.items.map((value) => {
      if (value.type !== 'mcpToolCall' || value.progressMessage === undefined) return value;
      const { progressMessage: _progress, ...item } = value;
      return item;
    });
  }
  if (method === 'turn/plan/updated') {
    if (finalStatus(turn.status)) return { turns };
    const plan: Item = {
      id: `plan:${turnId}`,
      type: 'plan',
      plan: p.plan,
      explanation: p.explanation,
    };
    const index = turn.items.findIndex((i) => i.id === plan.id);
    if (index < 0) turn.items.push(plan);
    else turn.items[index] = plan;
    return { turns: check({ before: original?.items[index], after: plan }), touched: `${turnId}:${plan.id}` };
  }
  const itemId =
    typeof item.id === 'string' ? item.id : typeof p.itemId === 'string' ? p.itemId : '';
  if (!itemId) return { turns: check() };
  const index = turn.items.findIndex((i) => i.id === itemId);
  const previous = turn.items[index];
  if (method !== 'item/completed' && (previous?.streamComplete || finalStatus(turn.status)))
    return { turns: check() };
  let updated: Item;
  if (method === 'item/completed')
    updated = {
      ...item,
      id: itemId,
      type: String(item.type ?? previous?.type ?? 'unknown'),
      streamComplete: true,
    };
  else if (method === 'item/started') {
    if (previous && !previous.historySync) return { turns: check() };
    updated = { ...item, id: itemId, type: String(item.type ?? previous?.type ?? 'unknown') };
    if (previous?.historySync)
      updated.historySync = {
        ...previous.historySync,
        snapshot: streamSnapshot(updated, previous.historySync.field),
      };
  } else if (method === 'item/mcpToolCall/progress') {
    // A progress message has no tool identity or lifecycle proof. Wait for its
    // item start/history rather than creating a placeholder that masks either.
    if (!previous) return { turns };
    if (previous.type !== 'mcpToolCall')
      throw new Error('工具进度条目类型发生变化，请重新核对历史。');
    if (['completed', 'failed'].includes(String(previous.status))) return { turns };
    if (typeof p.message !== 'string') throw new Error('工具进度缺少文字内容。');
    updated = { ...previous, id: itemId, type: 'mcpToolCall', progressMessage: p.message };
  } else {
    const streamed = appendStream(previous, method, p, itemId);
    if (!streamed) return { turns };
    updated = streamed;
  }
  if (index < 0) turn.items.push(updated);
  else turn.items[index] = updated;
  return { turns: check({ before: previous, after: updated }), touched: `${turnId}:${itemId}` };
}
export function textContent(item: Item): string {
  if (typeof item.text === 'string') return item.text;
  return array<unknown>(item.content)
    .map((c) => {
      const value = object(c);
      return typeof value.text === 'string'
        ? value.text
        : value.type === 'image' || value.type === 'localImage'
          ? '[图片附件]'
          : '';
    })
    .join('\n');
}
