import { canonical, object, type JsonObject, type JsonValue } from './types.js';

export const WINDOW_CHARS = 1_000_000;

export function advanceWindowVoice(active: JsonValue, value: JsonValue): JsonValue {
  const row = object(value);
  if (row.type !== 'realtime') return active;
  const item = object(row.item);
  if (item.type === 'realtimeSessionStarted') return item.realtimeSessionId!;
  if (item.type === 'realtimeSessionClosed' && active === item.realtimeSessionId) return null;
  return active;
}

const cost = (value: JsonValue) => JSON.stringify(value).length + 1;
const identity = (turnId: JsonValue, item: JsonObject) => canonical([turnId, item.id!, item.type!]);

function excerpt(text: string): string {
  if (text.length <= 4096) return text;
  return text.slice(0, 2048).replace(/[\uD800-\uDBFF]$/u, '') +
    '\n［最近历史窗口仅显示此条文字的开头和结尾］\n' +
    text.slice(-2048).replace(/^[\uDC00-\uDFFF]/u, '');
}

// Only shorten human-readable text. Paths, attachment URLs and other structured
// fields must keep their original meaning or be omitted with the older prefix.
function previewItem(item: JsonObject): JsonObject {
  if (['agentMessage', 'plan', 'transcriptSegment'].includes(String(item.type)) && typeof item.text === 'string')
    return { ...item, text: excerpt(item.text) };
  if (item.type === 'commandExecution' && typeof item.aggregatedOutput === 'string')
    return { ...item, aggregatedOutput: excerpt(item.aggregatedOutput) };
  if (item.type === 'userMessage' && Array.isArray(item.content)) {
    const content = item.content.map(value => {
      const part = object(value);
      return part.type === 'text' && typeof part.text === 'string' && part.text.length > 4096
        ? { ...part, text: excerpt(part.text), text_elements: [] } : part;
    });
    return { ...item, content };
  }
  return item;
}

export function previewTimelineEntry(row: JsonObject): JsonObject {
  return row.item && !row.itemReference ? { ...row, item: previewItem(object(row.item)) } : row;
}

/** Keep the newest items inside a turn. Both native streams arrive in rollout
 * order, but may end on different rows and an item reference has no body. */
export function fitHistoryWindow(page: JsonObject): JsonObject {
  if (JSON.stringify(page).length <= WINDOW_CHARS) return page;
  const turns = page.turns as JsonObject[], timeline = page.timeline as JsonObject[];
  // The opening session can change when its start row falls outside the window.
  // Its validated ID is at most 256 bytes, including control characters which JSON escapes.
  const shell = { ...page, turns: [], timeline: [], activeRealtimeSessionAtPageStart: null,
    complete: false, turnsComplete: false, timelineComplete: false, truncated: true, windowClipped: true };
  const budget = WINDOW_CHARS - cost(shell) - 6 * 256;
  const timelineBudget = Math.max(Math.floor(budget / 2), budget - cost(turns));
  let timelineCost = 0, first = timeline.length;
  const visibleTimeline: JsonObject[] = [];
  for (let i = timeline.length - 1; i >= 0; i--) {
    let row = timeline[i]!, size = cost(row);
    if (timelineCost + size > timelineBudget) {
      row = previewTimelineEntry(row);
      size = cost(row);
    }
    if (timelineCost + size > timelineBudget) {
      // An omitted tool payload has no effect on voice state. A lifecycle
      // boundary must remain in the suffix or be folded into its opening state.
      if (row.type === 'realtime' && ['realtimeSessionStarted', 'realtimeSessionClosed'].includes(String(object(row.item).type))) break;
      continue;
    }
    visibleTimeline.push(row); timelineCost += size; first = i;
  }
  const opening = timeline.slice(0, first).reduce<JsonValue>(advanceWindowVoice, page.activeRealtimeSessionAtPageStart!);
  let remaining = budget - timelineCost;
  const visibleTurns: JsonObject[] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!, size = cost(turn);
    if (size <= remaining) { visibleTurns.push(turn); remaining -= size; continue; }
    const partial = { ...turn, itemsView: 'summary', items: [] as JsonObject[] };
    if (cost(partial) > remaining) continue;
    remaining -= cost(partial);
    const items = turn.items as JsonObject[];
    for (let j = items.length - 1; j >= 0; j--) {
      let item = items[j]!, size = cost(item);
      if (size > remaining) { item = previewItem(item); size = cost(item); }
      if (size > remaining) continue;
      partial.items.push(item); remaining -= size;
    }
    if (partial.items.length) { partial.items.reverse(); visibleTurns.push(partial); }
    else remaining += cost(partial);
  }
  visibleTurns.reverse();
  const bodies = new Set(visibleTurns.flatMap(turn =>
    (turn.items as JsonObject[]).map(item => identity(turn.id!, item))));
  return { ...shell, turns: visibleTurns, activeRealtimeSessionAtPageStart: opening,
    timeline: visibleTimeline.reverse().filter(row => !row.itemReference || bodies.has(identity(row.turnId!, object(row.item)))) };
}
