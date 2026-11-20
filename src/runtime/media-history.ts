import { fitHistoryImages } from './native-media-event.js';
import { DeliveryError, integer, jsonBytes, LIMITS, object, string, type JsonValue } from './types.js';
import type { NativeOptions } from './native.js';
import type { GeneratedMedia } from './generated-media.js';
type NativeCall = (method: string, params: JsonValue, options?: NativeOptions) => Promise<JsonValue>;
/** Adapt history pages to the native frame budget, projecting before accumulation.
 * Turn metadata and native cursors are preserved; source history is untouched. */
export async function readMediaHistory(native: NativeCall, media: GeneratedMedia, method: string, params: JsonValue, options?: NativeOptions): Promise<JsonValue> {
  const request = object(params), threadId = typeof request.threadId === 'string' ? request.threadId : undefined;
  const projected = (value: JsonValue) => media.project(value, threadId, typeof request.turnId === 'string' ? request.turnId : undefined);
  const batch = async (name: string, body: Record<string, JsonValue>, count: number): Promise<JsonValue> => {
    for (;;) {
      try {
        const page = await native(name, { ...body, limit: count }, options);
        return options?.historyImageDisplayChars ? fitHistoryImages(page, name === 'thread/timeline/list' ? 'timeline' : 'items', options.historyImageDisplayChars) : page;
      }
      catch (error) {
        if (!(error instanceof DeliveryError) || error.code !== 'history_frame_capacity') throw error;
        if (count <= 1) throw new DeliveryError('capacity', '单条历史记录超过传输容量。');
        count = Math.max(1, Math.floor(count / 2));
      }
    }
  };
  if (method === 'thread/turns/list' && request.itemsView === 'full') {
    const page = object(await native(method, { ...request, itemsView: 'notLoaded' }, options));
    if (!Array.isArray(page.data) || page.data.length > integer(request.limit ?? 25, 'limit', 1, 100)) throw new DeliveryError('invalid_native_response', 'Invalid turn page');
    const turns: JsonValue[] = []; let itemCount = 0, retainedBytes = Buffer.byteLength(jsonBytes({ ...page, data: [] }, LIMITS.historyBytes));
    const charge = (value: JsonValue): void => { retainedBytes += Buffer.byteLength(jsonBytes(value, LIMITS.historyBytes)) + 1; if (retainedBytes > LIMITS.historyBytes) throw new DeliveryError('capacity', 'History aggregate exceeds its byte budget'); };
    for (const value of page.data) {
      const turn = object(value);
      if (turn.itemsView === 'full') { const value = projected(turn); charge(value); const items = object(value).items; if (!Array.isArray(items) || (itemCount += items.length) > LIMITS.historyItems) throw new DeliveryError('capacity', 'History item traversal exceeded its budget'); turns.push(value); continue; }
      if (turn.itemsView !== 'notLoaded' || !Array.isArray(turn.items) || turn.items.length) throw new DeliveryError('invalid_native_response', 'Native turn metadata included unexpected items');
      charge({ ...turn, itemsView: 'full' });
      const turnId = string(turn.id, 'turn id'), items: JsonValue[] = [], seen = new Set<string>(), ids = new Set<string>(); let cursor: JsonValue = null;
      do {
        if (itemCount >= LIMITS.historyItems || seen.size >= LIMITS.historyItems) throw new DeliveryError('capacity', 'History item traversal exceeded its budget');
        const result = object(projected(await batch('thread/items/list', { threadId: threadId!, turnId, sortDirection: 'asc', deferOutput: { commandExecution: true, mcpToolCall: true }, ...(cursor !== null ? { cursor } : {}) }, Math.min(24, LIMITS.historyItems - itemCount))));
        if (!Array.isArray(result.data) || result.data.length > Math.min(24, LIMITS.historyItems - itemCount)) throw new DeliveryError('invalid_native_response', 'Invalid native item page');
        itemCount += result.data.length;
        for (const row of result.data) {
          let entry = object(row); let item = object(entry.item); const id = string(item.id, 'item id');
          if (entry.turnId !== turnId || ids.has(id)) throw new DeliveryError('invalid_native_response', 'History item identity changed during traversal');
          if (entry.outputDeferred === true) {
            let detail: JsonValue;
            try { detail = await native('thread/items/read', { threadId: threadId!, turnId, itemIds: [id] }, options); }
            catch (error) {
              if (error instanceof DeliveryError && error.code === 'history_frame_capacity') throw new DeliveryError('capacity', '单条历史记录超过传输容量。');
              throw error;
            }
            const full = object(projected(detail));
            if (!Array.isArray(full.data) || full.data.length !== 1) throw new DeliveryError('invalid_native_response', 'Deferred history output is missing');
            entry = object(full.data[0]); item = object(entry.item);
            if (entry.turnId !== turnId || item.id !== id || entry.outputDeferred === true) throw new DeliveryError('invalid_native_response', 'Deferred history identity or completeness changed');
          }
          charge(item); ids.add(id); items.push(item);
        }
        cursor = result.nextCursor!;
        if (cursor !== null) { const next = string(cursor, 'nextCursor', LIMITS.cursorBytes, true); if (seen.has(next)) throw new DeliveryError('cursor_loop', 'Native item cursor repeated'); seen.add(next); }
      } while (cursor !== null);
      turns.push({ ...turn, items, itemsView: 'full' });
    }
    const result = { ...page, data: turns }; jsonBytes(result, LIMITS.historyBytes); return result;
  }
  if (method === 'thread/timeline/list') {
    const limit = integer(request.limit ?? 25, 'limit', 1, 100), data: JsonValue[] = [], seen = new Set<string>(); let cursor = request.cursor ?? null, active: JsonValue = null, retainedBytes = 128;
    let batchLimit = Math.min(24, limit);
    for (let scans = 0; data.length < limit && scans < limit;) {
      const count = Math.min(batchLimit, limit - data.length);
      const page = object(projected(await batch(method, { ...request, ...(cursor !== null ? { cursor } : {}) }, count)));
      if (!Array.isArray(page.data) || page.data.length > count) throw new DeliveryError('invalid_native_response', 'Invalid native timeline page');
      const payload = Buffer.byteLength(jsonBytes(page.data, LIMITS.frameBytes));
      if (retainedBytes + payload > LIMITS.historyBytes) {
        // The current cursor points to the first unconsumed native page.
        // Return only previously accepted pages, with their own opening voice state.
        if (data.length) break;
        if (count === 1) throw new DeliveryError('capacity', '单条时间线记录超过读取容量。');
        batchLimit = Math.max(1, Math.floor(count / 2));
        continue;
      }
      retainedBytes += payload;
      scans++;
      // Native pages traverse backwards but each page is in rollout order.
      active = page.activeRealtimeSessionAtPageStart!;
      data.unshift(...page.data); const next = page.nextCursor;
      if (next === null) { cursor = null; break; }
      const continuation = string(next, 'nextCursor', LIMITS.cursorBytes, true);
      if (next === cursor || seen.has(continuation)) throw new DeliveryError('cursor_loop', 'Native timeline cursor repeated');
      seen.add(continuation); cursor = continuation;
    }
    const result = { data, nextCursor: cursor, activeRealtimeSessionAtPageStart: active }; jsonBytes(result, LIMITS.historyBytes); return result;
  }
  if (method === 'thread/read' && request.includeTurns === true) {
    let value: JsonValue;
    try { value = await native(method, params, options); }
    catch (error) {
      if (error instanceof DeliveryError && error.code === 'history_frame_capacity')
        throw new DeliveryError('capacity', '完整旧会话超过传输容量，可使用最近的历史窗口。');
      throw error;
    }
    return projected(options?.historyImageDisplayChars ? fitHistoryImages(value, 'thread', options.historyImageDisplayChars) : value);
  }
  return projected(await native(method, params, options));
}
