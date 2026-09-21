import type { TimelineItem } from "../api/protocol";

// These are browser memory budgets, not a promise that earlier history was
// deleted. Evicted threads are reloaded from the gateway when selected.
const MAX_THREADS = 8;
const MAX_ITEMS = 10_000;
const MAX_CHARS = 20 * 1024 * 1024;
const MAX_TOTAL_CHARS = 32 * 1024 * 1024;
const MAX_THREAD_RECORD_INSPECTION = 4_096;
const sizes = new WeakMap<TimelineItem, number>();
const listSizes = new WeakMap<TimelineItem[], { chars: number; overflow: boolean }>();
function itemSize(item: TimelineItem): number {
  let size = sizes.get(item);
  if (size === undefined) {
    // Runtime timeline values are untrusted. JSON.stringify would first
    // materialize an attacker-sized string, defeating the memory budget it is
    // meant to enforce. Walk data properties with a strict node/character cut.
    let chars = 0;
    let nodes = 0;
    const stack: unknown[] = [item];
    const seen = new WeakSet<object>();
    try {
      while (stack.length > 0 && chars <= MAX_CHARS && nodes <= 100_000) {
        const value = stack.pop();
        nodes += 1;
        if (typeof value === "string") { chars += value.length + 2; continue; }
        if (value === null || typeof value !== "object") { chars += 16; continue; }
        if (seen.has(value)) { chars += 16; continue; }
        seen.add(value);
        if (Array.isArray(value)) {
          chars += 2 + value.length;
          if (value.length > 100_000 - nodes) { chars = MAX_CHARS + 1; break; }
          for (let index = 0; index < value.length; index++) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            if (!descriptor || !("value" in descriptor)) { chars = MAX_CHARS + 1; break; }
            stack.push(descriptor.value);
          }
          continue;
        }
        let own = 0;
        for (const key in value as Record<string, unknown>) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
          if (++own + nodes > 100_000) { chars = MAX_CHARS + 1; break; }
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor || !("value" in descriptor)) { chars = MAX_CHARS + 1; break; }
          chars += key.length + 3;
          stack.push(descriptor.value);
        }
      }
      size = chars > MAX_CHARS || nodes > 100_000 ? MAX_CHARS + 1 : chars;
    } catch { size = MAX_CHARS + 1; }
    sizes.set(item, size);
  }
  return size;
}

function measureList(list: TimelineItem[]): { chars: number; overflow: boolean } {
  const cached = listSizes.get(list);
  if (cached) return cached;
  let chars = 0;
  let overflow = list.length > MAX_ITEMS;
  if (!overflow) {
    for (const item of list) {
      chars += itemSize(item);
      if (chars > MAX_CHARS) { overflow = true; break; }
    }
  }
  const measured = { chars, overflow };
  listSizes.set(list, measured);
  return measured;
}

/** Seed the budget cache for a list produced by replacing a bounded set of
 * indexes. Streaming can then charge only the changed items instead of
 * rescanning a 10k-item conversation on every flush. */
export function deriveTimelineListBudget(previous: TimelineItem[], next: TimelineItem[], changedIndexes: Iterable<number>): void {
  const prior = measureList(previous);
  if (prior.overflow || next.length !== previous.length) {
    measureList(next);
    return;
  }
  let chars = prior.chars;
  for (const index of changedIndexes) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= next.length) {
      listSizes.set(next, { chars: MAX_CHARS + 1, overflow: true });
      return;
    }
    chars += itemSize(next[index]) - itemSize(previous[index]);
    if (chars > MAX_CHARS) break;
  }
  listSizes.set(next, { chars, overflow: chars > MAX_CHARS });
}

export function budgetTimeline(items: Record<string, TimelineItem[]>, active: string | null): {
  items: Record<string, TimelineItem[]>; evicted: string[]; overflow: string[];
} {
  const result: Record<string, TimelineItem[]> = {};
  const evicted: string[] = [];
  const overflow: string[] = [];
  // Keep only a bounded tail of keys while enumerating. Do not materialize the
  // full dictionary merely to retain eight thread timelines.
  const ids: string[] = [];
  let inspected = 0;
  for (const threadId in items) {
    if (!Object.prototype.hasOwnProperty.call(items, threadId) || threadId === active) continue;
    inspected += 1;
    if (inspected > MAX_THREAD_RECORD_INSPECTION) break;
    if (ids.length === MAX_THREADS - (active && Object.prototype.hasOwnProperty.call(items, active) ? 1 : 0)) ids.shift();
    ids.push(threadId);
  }
  ids.reverse();
  if (active && Object.prototype.hasOwnProperty.call(items, active)) ids.unshift(active);
  let total = 0;
  for (const threadId of ids) {
    const list = items[threadId];
    const measured = measureList(list);
    if (measured.overflow) {
      overflow.push(threadId);
      result[threadId] = [{ type: "errorItem", id: `history-budget-${threadId}`, message: "此会话超过浏览器历史显示预算，已暂停加载以避免页面耗尽内存。服务器历史没有删除；请通过 Codex CLI 查看完整历史。", willRetry: false, historyLoadError: true }];
      continue;
    }
    if (total + measured.chars > MAX_TOTAL_CHARS) { evicted.push(threadId); continue; }
    total += measured.chars;
    result[threadId] = list;
  }
  // IDs not retained are evicted. Enumeration remains allocation-bounded.
  const retained = new Set(ids);
  if (inspected + (active && Object.prototype.hasOwnProperty.call(items, active) ? 1 : 0) > ids.length) {
    let evictedInspected = 0;
    for (const threadId in items) {
      if (!Object.prototype.hasOwnProperty.call(items, threadId) || retained.has(threadId)) continue;
      if (++evictedInspected > MAX_THREAD_RECORD_INSPECTION) break;
      evicted.push(threadId);
    }
  }
  return { items: result, evicted, overflow };
}
