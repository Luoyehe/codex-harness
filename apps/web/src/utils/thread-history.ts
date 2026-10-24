/** Bounded, read-only hydration of the stable Codex 0.164 paginated history API. */
type HistoryMethod = "thread/read" | "thread/turns/list" | "thread/items/list";
type HistoryRequest = (method: HistoryMethod, params: Record<string, unknown>) => Promise<unknown>;

export interface HydratedHistory {
  response: unknown;
  truncated: boolean;
  warning?: string;
}

const MAX_PAGES = 64;
const MAX_TURNS = 4_096;
const MAX_ITEMS = 9_999;
const MAX_CHARS = 12 * 1024 * 1024;
const MAX_NODES = 100_000;
class HistoryBudgetExceeded extends Error {}

function oversized(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { code?: unknown }).code === "RESPONSE_TOO_LARGE";
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error(`${label}格式无效`);
  }
  return value as Record<string, unknown>;
}

function own(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) throw new Error("历史分页包含非数据属性");
  return descriptor.value;
}

function identity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 512) throw new Error(`${label}无效`);
  return value;
}

function page(value: unknown, max: number): { data: unknown[]; next: string | null } {
  const result = record(value, "历史分页");
  const data = own(result, "data");
  const next = own(result, "nextCursor");
  if (!Array.isArray(data) || data.length > max || next !== null &&
      (typeof next !== "string" || !next || next.length > 4_096)) throw new Error("历史分页或继续游标格式无效");
  return { data, next: next as string | null };
}

/** Charge data properties before retaining a response. Never stringify a large
 * payload or invoke runtime accessors just to find out that it is too large. */
function charge(value: unknown, budget: { chars: number; nodes: number }, depth = 0, ancestors = new Set<object>()): void {
  if (++budget.nodes > MAX_NODES || depth > 32) throw new HistoryBudgetExceeded();
  if (typeof value === "string") {
    budget.chars += value.length;
    if (budget.chars > MAX_CHARS) throw new HistoryBudgetExceeded();
    return;
  }
  if (value == null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || ancestors.has(value)) throw new Error("历史分页包含无效数据");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_NODES - budget.nodes) throw new HistoryBudgetExceeded();
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) throw new Error("历史分页数组格式无效");
        charge(descriptor.value, budget, depth + 1, ancestors);
      }
    } else {
      const data = record(value, "历史分页数据");
      for (const key in data) {
        if (!Object.hasOwn(data, key)) continue;
        budget.chars += key.length;
        if (budget.chars > MAX_CHARS) throw new HistoryBudgetExceeded();
        charge(own(data, key), budget, depth + 1, ancestors);
      }
    }
  } finally {
    ancestors.delete(value);
  }
}

export async function hydrateThreadHistory(
  threadId: string,
  request: HistoryRequest,
  isCurrent: () => boolean,
  resumeHistoryMode?: unknown,
): Promise<HydratedHistory> {
  let pages = 0;
  const call = async (method: HistoryMethod, params: Record<string, unknown>) => {
    if (!isCurrent()) throw new Error("历史读取已被新的导航替代");
    const response = await request(method, params);
    if (!isCurrent()) throw new Error("历史读取已被新的导航替代");
    return response;
  };
  // Keep the cheap supported legacy path, but an explicit size refusal is not
  // evidence that none of its bounded turn pages can be read.
  let legacyOversized = false;
  let response: unknown;
  try {
    response = await call("thread/read", { threadId, includeTurns: resumeHistoryMode === "legacy" });
  } catch (error) {
    if (resumeHistoryMode !== "legacy" || !oversized(error)) throw error;
    legacyOversized = true;
    response = await call("thread/read", { threadId, includeTurns: false });
  }
  const outer = record(response, "会话响应");
  const thread = record(own(outer, "thread"), "会话");
  if (own(thread, "id") !== threadId) throw new Error("历史分页返回了错误的会话身份");
  const mode = own(thread, "historyMode");
  if (mode !== undefined && mode !== "legacy" && mode !== "paginated") throw new Error("服务器返回了无法识别的历史模式");
  if (mode !== "paginated") {
    // Older servers may ignore includeTurns=false and already return history.
    const turns = own(thread, "turns");
    if (!legacyOversized && (resumeHistoryMode === "legacy" || Array.isArray(turns) && turns.length > 0)) return { response, truncated: false };
    if (!legacyOversized) {
      try { return { response: await call("thread/read", { threadId, includeTurns: true }), truncated: false }; }
      catch (error) {
        if (mode !== "legacy" || !oversized(error)) throw error;
      }
    }
    if (mode !== "legacy") throw new Error("旧版历史超过读取上限，且服务器未确认分页能力；请通过 Codex CLI 核对。");
  }

  // Each refusal consumes the same total request budget as a successful page.
  // Only an explicit size code permits retrying; timeouts/BUSY/unknown errors
  // must not trigger another read under different parameters.
  const readPage = async (method: "thread/turns/list" | "thread/items/list", params: Record<string, unknown>, initialLimit: number) => {
    let limit = initialLimit;
    let view: "full" | "summary" | "notLoaded" = "full";
    for (;;) {
      if (pages >= MAX_PAGES) throw new HistoryBudgetExceeded();
      pages += 1;
      try {
        const result = page(await call(method, { ...params, limit,
          ...(method === "thread/turns/list" ? { itemsView: view } : {}),
        }), limit);
        return { ...result, limit };
      } catch (error) {
        if (!oversized(error)) throw error;
        if (limit > 1) { limit = Math.max(1, Math.floor(limit / 2)); continue; }
        if (method === "thread/turns/list" && view !== "notLoaded") {
          view = view === "full" ? "summary" : "notLoaded";
          continue;
        }
        throw new HistoryBudgetExceeded("单条历史内容仍超过服务器响应上限；仅保留已读取部分，历史未完整核对，发送已暂停。请通过 Codex CLI 查看。");
      }
    }
  };

  const budget = { chars: 0, nodes: 0 };
  const turns: Record<string, unknown>[] = [];
  const turnIds = new Set<string>();
  const turnCursors = new Set<string>();
  let turnCursor: string | undefined;
  let itemCount = 0;
  let truncated = false;
  let warning: string | undefined;
  let turnLimit = 20;
  outerLoop: do {
    if (pages >= MAX_PAGES || turns.length >= MAX_TURNS) { truncated = true; break; }
    let result: Awaited<ReturnType<typeof readPage>>;
    try {
      result = await readPage("thread/turns/list", {
        threadId, sortDirection: "desc", ...(turnCursor ? { cursor: turnCursor } : {}),
      }, turnLimit);
      turnLimit = result.limit;
    } catch (error) {
      if (!(error instanceof HistoryBudgetExceeded)) throw error;
      truncated = true;
      warning = error.message || undefined;
      break;
    }
    for (const rawTurn of result.data) {
      const candidate = record(rawTurn, "历史回合");
      const id = identity(own(candidate, "id"), "历史回合标识");
      if (turnIds.has(id)) throw new Error("历史分页重复返回了同一回合，请重新加载");
      if (turns.length >= MAX_TURNS) { truncated = true; break outerLoop; }
      const view = own(candidate, "itemsView");
      if (view !== "full" && view !== "summary" && view !== "notLoaded") throw new Error("历史回合条目状态无效");
      const rawItems = own(candidate, "items");
      if (!Array.isArray(rawItems)) throw new Error("历史回合条目格式无效");
      let items: unknown[];
      try {
        // Do not retain an unbounded turn while fetching its detailed items.
        charge(candidate, budget);
        if (view === "full") {
          items = rawItems;
        } else if (mode === "legacy") {
          // Native 0.164 supports turn pages for legacy sessions, but rejects
          // thread/items/list for them. Show the bounded summary honestly.
          items = rawItems;
          truncated = true;
          warning = "旧版会话的单回合超过完整读取上限，且不支持逐项读取；仅显示已读取部分，发送已暂停。请通过 Codex CLI 核对。";
        } else {
          const descending: unknown[] = [];
          const itemIds = new Set<string>();
          const itemCursors = new Set<string>();
          let itemCursor: string | undefined;
          let itemLimit = 100;
          let itemsComplete = false;
          do {
            if (pages >= MAX_PAGES || itemCount + descending.length >= MAX_ITEMS) { truncated = true; break; }
            let itemPage: Awaited<ReturnType<typeof readPage>>;
            try {
              itemPage = await readPage("thread/items/list", {
                threadId, turnId: id, sortDirection: "desc", ...(itemCursor ? { cursor: itemCursor } : {}),
              }, itemLimit);
              itemLimit = itemPage.limit;
            } catch (error) {
              if (!(error instanceof HistoryBudgetExceeded)) throw error;
              warning = error.message || undefined;
              truncated = true;
              break;
            }
            for (const rawEntry of itemPage.data) {
              if (itemCount + descending.length >= MAX_ITEMS) { truncated = true; break; }
              const entry = record(rawEntry, "历史条目");
              if (own(entry, "turnId") !== id) throw new Error("历史条目属于错误的回合");
              const item = record(own(entry, "item"), "历史条目内容");
              const itemId = identity(own(item, "id"), "历史条目标识");
              if (itemIds.has(itemId)) throw new Error("历史分页重复返回了同一条目，请重新加载");
              charge(item, budget);
              itemIds.add(itemId);
              descending.push(item);
            }
            if (truncated) break;
            if (itemPage.next === null) { itemsComplete = true; break; }
            if (itemCursors.has(itemPage.next)) throw new Error("历史条目继续游标重复，请重新加载");
            itemCursors.add(itemPage.next);
            itemCursor = itemPage.next;
          } while (true);
          items = descending.reverse();
          if (!itemsComplete) truncated = true;
        }
      } catch (error) {
        if (!(error instanceof HistoryBudgetExceeded)) throw error;
        truncated = true;
        break outerLoop;
      }
      if (itemCount + items.length > MAX_ITEMS) { truncated = true; break outerLoop; }
      itemCount += items.length;
      turnIds.add(id);
      turns.push({ ...candidate, items, itemsView: truncated ? "summary" : "full" });
      if (truncated) break outerLoop;
    }
    if (result.next === null) break;
    if (turnCursors.has(result.next)) throw new Error("历史回合继续游标重复，请重新加载");
    turnCursors.add(result.next);
    turnCursor = result.next;
  } while (true);

  return { response: { thread: {
    id: threadId, cwd: own(thread, "cwd"), status: own(thread, "status"), turns: turns.reverse(),
  } }, truncated, ...(warning ? { warning } : {}) };
}
