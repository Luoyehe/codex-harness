import { DeliveryError, integer, jsonBytes, LIMITS, object, string, type JsonValue } from './types.js';
import type { NativeOptions } from './native.js';
import type { GeneratedMedia } from './generated-media.js';
type NativeCall = (method: string, params: JsonValue, options?: NativeOptions) => Promise<JsonValue>;
/** Load binary-bearing history one item at a time, projecting before accumulation.
 * Turn metadata and native cursors are preserved; source history is untouched. */
export async function readMediaHistory(native: NativeCall, media: GeneratedMedia, method: string, params: JsonValue, options?: NativeOptions): Promise<JsonValue> {
  const request = object(params), threadId = typeof request.threadId === 'string' ? request.threadId : undefined;
  const projected = (value: JsonValue) => media.project(value, threadId, typeof request.turnId === 'string' ? request.turnId : undefined);
  if (method === 'thread/turns/list' && request.itemsView === 'full') {
    const page = object(await native(method, { ...request, itemsView: 'notLoaded' }, options));
    if (!Array.isArray(page.data) || page.data.length > integer(request.limit ?? 25, 'limit', 1, 100)) throw new DeliveryError('invalid_native_response', 'Invalid turn page');
    const turns: JsonValue[] = []; let itemCount = 0;
    for (const value of page.data) {
      const turn = object(value);
      if (turn.itemsView === 'full') { turns.push(projected(turn)); continue; }
      if (turn.itemsView !== 'notLoaded' || !Array.isArray(turn.items) || turn.items.length) throw new DeliveryError('invalid_native_response', 'Native turn metadata included unexpected items');
      const turnId = string(turn.id, 'turn id'), items: JsonValue[] = [], seen = new Set<string>(), ids = new Set<string>(); let cursor: JsonValue = null;
      do {
        if (++itemCount > LIMITS.historyItems) throw new DeliveryError('capacity', 'History item traversal exceeded its budget');
        const result = object(projected(await native('thread/items/list', { threadId: threadId!, turnId, limit: 1, sortDirection: 'asc', ...(cursor !== null ? { cursor } : {}) }, options)));
        if (!Array.isArray(result.data) || result.data.length > 1) throw new DeliveryError('invalid_native_response', 'Invalid native item page');
        for (const row of result.data) {
          const entry = object(row), item = object(entry.item), id = string(item.id, 'item id');
          if (entry.turnId !== turnId || ids.has(id)) throw new DeliveryError('invalid_native_response', 'History item identity changed during traversal');
          ids.add(id); items.push(item);
        }
        cursor = result.nextCursor!;
        if (cursor !== null) { const next = string(cursor, 'nextCursor', LIMITS.cursorBytes, true); if (seen.has(next)) throw new DeliveryError('cursor_loop', 'Native item cursor repeated'); seen.add(next); }
      } while (cursor !== null);
      turns.push({ ...turn, items, itemsView: 'full' });
    }
    const result = { ...page, data: turns }; jsonBytes(result, LIMITS.historyBytes); return result;
  }
  if (method === 'thread/timeline/list') {
    const limit = integer(request.limit ?? 25, 'limit', 1, 100), data: JsonValue[] = [], seen = new Set<string>(); let cursor = request.cursor ?? null, active: JsonValue = null;
    for (let index = 0; index < limit; index++) {
      const page = object(projected(await native(method, { ...request, limit: 1, ...(cursor !== null ? { cursor } : {}) }, options)));
      if (!Array.isArray(page.data) || page.data.length > 1) throw new DeliveryError('invalid_native_response', 'Invalid native timeline page');
      // Native pages traverse backwards but each page is in rollout order.
      // The oldest subpage defines the opening voice state of the joined page.
      active = page.activeRealtimeSessionAtPageStart!;
      data.unshift(...page.data); const next = page.nextCursor;
      if (next === null) { cursor = null; break; }
      const continuation = string(next, 'nextCursor', LIMITS.cursorBytes, true);
      if (next === cursor || seen.has(continuation)) throw new DeliveryError('cursor_loop', 'Native timeline cursor repeated');
      seen.add(continuation); cursor = continuation;
    }
    const result = { data, nextCursor: cursor, activeRealtimeSessionAtPageStart: active }; jsonBytes(result, LIMITS.historyBytes); return result;
  }
  return projected(await native(method, params, options));
}
