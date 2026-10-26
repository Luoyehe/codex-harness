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
  const next = page.nextCursor;
  if (
    next !== null &&
    next !== undefined &&
    (typeof next !== 'string' || next.length > HISTORY_LIMIT.cursor || seen.has(next))
  )
    throw new Error('历史游标无效或循环，已停止加载。');
  if (page.complete === false && (next === null || next === undefined))
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
    legacy: page.legacy === true,
    historyVersion: Number(page.historyVersion),
    activeRealtimeSessionAtPageStart: page.activeRealtimeSessionAtPageStart as string | null,
  };
}
export function boundedCombined(turns: Turn[], timeline: TimelineEntry[]): void {
  bounded(turns);
  if (
    turns.reduce((sum, turn) => sum + turn.items.length, 0) + timeline.length >
      HISTORY_LIMIT.items ||
    JSON.stringify({ turns, timeline }).length > HISTORY_LIMIT.chars
  )
    throw new Error('文字与语音历史达到安全容量，完成同步前不能发送。');
}
export function bounded(turns: Turn[]): Turn[] {
  if (
    turns.length > HISTORY_LIMIT.turns ||
    turns.reduce((sum, t) => sum + t.items.length, 0) > HISTORY_LIMIT.items ||
    JSON.stringify(turns).length > HISTORY_LIMIT.chars
  )
    throw new Error('当前历史窗口达到安全容量。请重新打开会话，缩小读取范围。');
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
): { turns: Turn[]; touched?: string; diff?: string } {
  if (method === 'turn/diff/updated')
    return { turns, diff: typeof p.diff === 'string' ? p.diff : '' };
  const provided = object(p.turn),
    item = object(p.item);
  const turnId =
    typeof p.turnId === 'string' ? p.turnId : typeof provided.id === 'string' ? provided.id : '';
  if (!turnId || (!method.startsWith('turn/') && !method.startsWith('item/'))) return { turns };
  const next = turns.map((t) => ({ ...t, items: [...t.items] }));
  let turn = next.find((t) => t.id === turnId);
  if (!turn) {
    turn = { id: turnId, status: 'inProgress', items: [] };
    next.push(turn);
  }
  if (method === 'turn/started' && !finalStatus(turn.status)) turn.status = 'inProgress';
  if (method === 'turn/completed') {
    turn.status = String(provided.status ?? 'completed');
    turn.error = provided.error;
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
    return { turns: bounded(next), touched: `${turnId}:${plan.id}` };
  }
  const itemId =
    typeof item.id === 'string' ? item.id : typeof p.itemId === 'string' ? p.itemId : '';
  if (!itemId) return { turns: bounded(next) };
  const index = turn.items.findIndex((i) => i.id === itemId);
  const previous = turn.items[index];
  if (method !== 'item/completed' && (previous?.streamComplete || finalStatus(turn.status)))
    return { turns: bounded(next) };
  let updated: Item;
  if (method === 'item/completed')
    updated = {
      ...item,
      id: itemId,
      type: String(item.type ?? previous?.type ?? 'unknown'),
      streamComplete: true,
    };
  else if (method === 'item/started') {
    if (previous && !previous.historySync) return { turns: bounded(next) };
    updated = { ...item, id: itemId, type: String(item.type ?? previous?.type ?? 'unknown') };
    if (previous?.historySync)
      updated.historySync = {
        ...previous.historySync,
        snapshot: streamSnapshot(updated, previous.historySync.field),
      };
  } else {
    const streamed = appendStream(previous, method, p, itemId);
    if (!streamed) return { turns };
    updated = streamed;
  }
  if (index < 0) turn.items.push(updated);
  else turn.items[index] = updated;
  return { turns: bounded(next), touched: `${turnId}:${itemId}` };
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
