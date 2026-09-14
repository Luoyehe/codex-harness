import type { TimelineItem } from "../api/protocol";

// These are browser memory budgets, not a promise that earlier history was
// deleted. Evicted threads are reloaded from the gateway when selected.
const MAX_THREADS = 8;
const MAX_ITEMS = 10_000;
const MAX_CHARS = 20 * 1024 * 1024;
const MAX_TOTAL_CHARS = 32 * 1024 * 1024;
const sizes = new WeakMap<TimelineItem, number>();
function itemSize(item: TimelineItem): number {
  let size = sizes.get(item);
  if (size === undefined) {
    try { size = JSON.stringify(item).length; } catch { size = MAX_CHARS + 1; }
    sizes.set(item, size);
  }
  return size;
}

export function budgetTimeline(items: Record<string, TimelineItem[]>, active: string | null): {
  items: Record<string, TimelineItem[]>; evicted: string[]; overflow: string[];
} {
  const result: Record<string, TimelineItem[]> = {};
  const evicted: string[] = [];
  const overflow: string[] = [];
  const entries = Object.entries(items).reverse().sort(([a], [b]) => a === active ? -1 : b === active ? 1 : 0);
  let total = 0;
  for (const [threadId, list] of entries) {
    if (Object.keys(result).length >= MAX_THREADS) { evicted.push(threadId); continue; }
    let chars = 0;
    for (const item of list) { chars += itemSize(item); if (chars > MAX_CHARS) break; }
    if (list.length > MAX_ITEMS || chars > MAX_CHARS) {
      overflow.push(threadId);
      result[threadId] = [{ type: "errorItem", id: `history-budget-${threadId}`, message: "此会话超过浏览器历史显示预算，已暂停加载以避免页面耗尽内存。服务器历史没有删除；请通过 Codex CLI 查看完整历史。", willRetry: false, historyLoadError: true }];
      continue;
    }
    if (total + chars > MAX_TOTAL_CHARS) { evicted.push(threadId); continue; }
    total += chars;
    result[threadId] = list;
  }
  return { items: result, evicted, overflow };
}
