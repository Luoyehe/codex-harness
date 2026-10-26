import { randomUUID } from 'node:crypto';
import { canonical, DeliveryError, integer, jsonBytes, LIMITS, object, onlyKeys, string, type CallContext, type JsonObject, type JsonValue } from './types.js';
import { validateTimelineContract } from './timeline-contract.js';
interface State { fresh?: boolean; historyMode?: string; status: string; pending: boolean; unknown: boolean; revision: number; historyRevision?: number }
interface Host { native(method: string, params: JsonValue): Promise<JsonValue>; state(id: string): State; observe(value: JsonValue, revision: number): void; checkTurns(turns: JsonValue[]): void; closed(): boolean }
interface Traversal { threadId: string; clientId: string; channel: string | undefined; next: string | null | undefined; complete: boolean; loading: boolean; turnCursor: string | null; timelineCursor: string | null; turnsComplete: boolean; timelineComplete: boolean; turnSeen: Set<string>; timelineSeen: Set<string>; pages: number; bytes: number; items: number; legacy: boolean }
const key = (threadId: string, context: CallContext) => canonical([context.eventChannelId ?? null, context.clientId, threadId]);
/** Both native history streams must finish before a connection may use the thread context. */
export class UnifiedHistory {
  private traversals = new Map<string, Traversal>();
  constructor(private host: Host) {}
  complete(threadId: string, context: CallContext): boolean { return this.traversals.get(key(threadId, context))?.complete === true; }
  invalidate(threadId: string): boolean { let removed = false; for (const [id, entry] of this.traversals) if (entry.threadId === threadId) { this.traversals.delete(id); removed = true; } return removed; }
  disconnect(clientId?: string, channel?: string): void { for (const [id, entry] of this.traversals) if ((clientId === undefined || entry.clientId === clientId) && (channel === undefined || entry.channel === channel)) this.traversals.delete(id); }
  clear(): void { this.traversals.clear(); }
  private cursor(page: JsonObject, prior: string | null, seen: Set<string>): string | null {
    const next = page.nextCursor; if (next === null) return null; const cursor = string(next, 'nextCursor', LIMITS.cursorBytes, true);
    if (cursor === prior || seen.has(cursor)) throw new DeliveryError('cursor_loop', 'Native history cursor repeated'); seen.add(cursor); return cursor;
  }
  async read(params: JsonObject, context: CallContext): Promise<JsonValue> {
    onlyKeys(params, ['threadId', 'cursor', 'limit']); const threadId = string(params.threadId, 'threadId'), limit = params.limit === undefined ? 25 : integer(params.limit, 'limit', 1, 100), id = key(threadId, context);
    if (params.cursor != null) string(params.cursor, 'cursor', LIMITS.cursorBytes, true);
    let entry = this.traversals.get(id);
    if (params.cursor == null) {
      if (!entry && this.traversals.size >= 256) {
        // A finished traversal is a cache of permission to reuse already read
        // context, not live work. Eviction revokes that permission; a later
        // mutation must read history again. In-flight/incomplete pages survive.
        for (const [candidate, traversal] of this.traversals) {
          if (!traversal.complete || traversal.loading) continue;
          this.traversals.delete(candidate);
          break;
        }
      }
      if (!entry && this.traversals.size >= 256) throw new DeliveryError('capacity', 'History traversal capacity exhausted');
      entry = { threadId, clientId: context.clientId, channel: context.eventChannelId, next: undefined, complete: false, loading: false, turnCursor: null, timelineCursor: null, turnsComplete: false, timelineComplete: false, turnSeen: new Set(), timelineSeen: new Set(), pages: 0, bytes: 0, items: 0, legacy: false }; this.traversals.set(id, entry);
    } else if (!entry || entry.complete || entry.next !== params.cursor) throw new DeliveryError('invalid_cursor', 'History cursor does not continue this connection\'s combined traversal');
    if (entry.loading) throw new DeliveryError('history_busy', 'History page is still loading'); const current = entry; current.loading = true;
    const publish = (turns: JsonValue[], timeline: JsonValue[], active: JsonValue): JsonObject => {
      if (this.host.closed() || this.traversals.get(id) !== current) throw new DeliveryError('history_stale', 'History changed or its owner disconnected during loading');
      const bytes = Buffer.byteLength(jsonBytes({ turns, timeline }, LIMITS.historyBytes)); current.bytes += bytes;
      current.items += timeline.length + turns.reduce<number>((count, value) => count + (object(value).items as JsonValue[]).length, 0);
      if (current.bytes > LIMITS.historyBytes || current.items > LIMITS.historyItems) { this.traversals.delete(id); throw new DeliveryError('capacity', 'Combined turn and voice history exceeded its traversal budget; context remains incomplete'); }
      current.complete = current.turnsComplete && current.timelineComplete; current.next = current.complete ? null : randomUUID();
      return { turns, timeline, nextCursor: current.next, backwardsCursor: null, complete: current.complete, turnsComplete: current.turnsComplete, timelineComplete: current.timelineComplete, activeRealtimeSessionAtPageStart: active, legacy: current.legacy, historyVersion: this.host.state(threadId).historyRevision ?? 0 };
    };
    try {
      const state = this.host.state(threadId);
      if (state.fresh && state.status !== 'active' && !state.pending && !state.unknown) { current.turnsComplete = current.timelineComplete = true; return publish([], [], null); }
      if (!state.historyMode) { const revision = state.revision, metadata = await this.host.native('thread/read', { threadId }); if (object(object(metadata).thread).id !== threadId) throw new DeliveryError('invalid_native_response', 'Thread identity mismatch'); this.host.observe(metadata, revision); }
      const requested = Number(!current.turnsComplete) + Number(!current.timelineComplete); if (current.pages + requested > 128) throw new DeliveryError('capacity', 'Combined native history exceeded 128 pages; context remains incomplete'); current.pages += requested;
      let turns: JsonValue[] = [], timeline: JsonValue[] = [], active: JsonValue = null;
      if (!current.turnsComplete) {
        const legacy = async (): Promise<void> => {
          if (current.turnCursor !== null) throw new DeliveryError('unsupported_cursor', 'Legacy turn history cannot continue a native turn cursor');
          const result = object(await this.host.native('thread/read', { threadId, includeTurns: true })), thread = object(result.thread);
          if (thread.id !== threadId || !Array.isArray(thread.turns)) throw new DeliveryError('invalid_native_response', 'Legacy thread identity mismatch'); turns = thread.turns; this.host.checkTurns(turns); current.legacy = true; current.turnsComplete = true;
        };
        if (state.historyMode === 'legacy') await legacy();
        else {
          let page: JsonObject | undefined;
          try { page = object(await this.host.native('thread/turns/list', { threadId, limit, sortDirection: 'desc', itemsView: 'full', ...(current.turnCursor !== null ? { cursor: current.turnCursor } : {}) })); }
          catch (error) { const unsupported = error instanceof DeliveryError && error.code === 'native_error' && error.data && typeof error.data === 'object' && !Array.isArray(error.data) && (error.data.code === -32601 || error.data.code === 'unsupported'); if (!unsupported) throw error; await legacy(); }
          if (page) {
            if (!Array.isArray(page.data) || page.data.length > limit) throw new DeliveryError('invalid_native_response', 'Invalid turn page'); this.host.checkTurns(page.data);
            if (page.backwardsCursor != null) string(page.backwardsCursor, 'backwardsCursor', LIMITS.cursorBytes, true);
            current.turnCursor = this.cursor(page, current.turnCursor, current.turnSeen); current.turnsComplete = current.turnCursor === null;
            turns = [...new Map(page.data.map(value => [string(object(value).id, 'turn id'), value])).values()].reverse();
          }
        }
      }
      if (!current.timelineComplete) {
        const result = await this.host.native('thread/timeline/list', { threadId, limit, ...(current.timelineCursor !== null ? { cursor: current.timelineCursor } : {}) }); validateTimelineContract('ThreadTimelineListResponse', result); jsonBytes(result, LIMITS.historyBytes); const page = object(result);
        if (!Array.isArray(page.data) || page.data.length > limit) throw new DeliveryError('invalid_native_response', 'Invalid canonical timeline page'); timeline = page.data;
        current.timelineCursor = this.cursor(page, current.timelineCursor, current.timelineSeen); current.timelineComplete = current.timelineCursor === null; active = page.activeRealtimeSessionAtPageStart!;
      }
      return publish(turns, timeline, active);
    } catch (error) { if (this.traversals.get(id) === current) this.traversals.delete(id); throw error; }
    finally { current.loading = false; }
  }
}
