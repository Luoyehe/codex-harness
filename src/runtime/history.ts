import { randomUUID } from 'node:crypto';
import { canonical, DeliveryError, integer, jsonBytes, LIMITS, object, onlyKeys, string, type CallContext, type JsonObject, type JsonValue } from './types.js';
import { advanceWindowVoice, fitHistoryWindow, WINDOW_CHARS } from './history-window.js';
import { validateTimelineContract } from './timeline-contract.js';
import type { Activity } from './thread-activity.js';
type State = Activity;
interface Host { native(method: string, params: JsonValue, imageDisplayChars?: number, windowTail?: boolean): Promise<JsonValue>; state(id: string): State; observe(value: JsonValue, revision: number): void; checkTurns(turns: JsonValue[]): void; closed(): boolean }
interface Traversal { threadId: string; clientId: string; channel: string | undefined; next: string | null | undefined; complete: boolean; loading: boolean; turnCursor: string | null; timelineCursor: string | null; turnsComplete: boolean; timelineComplete: boolean; turnSeen: Set<string>; timelineSeen: Set<string>; pages: number; bytes: number; items: number; referenceIndex?: HistoryReferenceIndex; completeVersion?: number; legacy: boolean; state: State; turnRevision: number; unknown: boolean }
const key = (threadId: string, context: CallContext, scope = '') => canonical([context.eventChannelId ?? null, context.clientId, threadId, scope]);
/** Charge each logical message once across independently paged streams. Reference
 * only turn bodies already delivered to this traversal; a timeline-only item keeps its body. */
class HistoryReferenceIndex {
  private turnItems = new Set<string>();
  private charged = new Set<string>();
  project(turns: JsonValue[], timeline: JsonValue[]): { entries: JsonValue[]; added: number } {
    let added = 0;
    const charge = (key: string) => { if (!this.charged.has(key)) { this.charged.add(key); added++; } };
    for (const value of turns) {
      const turn = object(value);
      for (const raw of turn.items as JsonValue[]) {
        const item = object(raw), key = canonical([turn.id!, item.id!, item.type!]);
        this.turnItems.add(key); charge(key);
      }
    }
    const entries = timeline.map(value => {
      const entry = object(value);
      if (entry.type !== 'item') { added++; return value; }
      const item = object(entry.item), key = canonical([entry.turnId!, item.id!, item.type!]);
      charge(key);
      return this.turnItems.has(key) ? { ...entry, itemReference: true, item: { id: item.id!, type: item.type! } } : value;
    });
    return { entries, added };
  }
  clear(): void { this.turnItems.clear(); this.charged.clear(); }
}
/** Tracks complete transcripts and separate, revision-bound permission to act on a bounded window. */
export class UnifiedHistory {
  // A window attests current execution state independently of transcript completeness.
  private windows = new Map<string, { threadId: string; context: CallContext; state: State; revision: number; history: number }>();
  private traversals = new Map<string, Traversal>();
  private loadingWindows = new Map<string, { threadId: string; context: CallContext }>();
  constructor(private host: Host) {}
  complete(threadId: string, context: CallContext): boolean { return this.traversals.get(key(threadId, context))?.complete === true; }
  windowReady(threadId: string, context: CallContext): boolean {
    const proof = this.windows.get(key(threadId, context)), state = this.host.state(threadId);
    return !!proof && proof.state === state && !state.unknown && state.turnId === null && state.status !== 'active' &&
      proof.revision === (state.turnRevision ?? 0) && proof.history === (state.historyRevision ?? 0);
  }
  invalidate(threadId: string): boolean { let removed = false; for (const [id, token] of this.loadingWindows) if (token.threadId === threadId) this.loadingWindows.delete(id); for (const [id, proof] of this.windows) if (proof.threadId === threadId) { this.windows.delete(id); removed = true; } for (const [id, entry] of this.traversals) if (entry.threadId === threadId) { this.traversals.delete(id); removed = true; } return removed; }
  disconnect(clientId?: string, channel?: string): void {
    for (const [id, token] of this.loadingWindows) if ((clientId === undefined || token.context.clientId === clientId) && (channel === undefined || token.context.eventChannelId === channel)) this.loadingWindows.delete(id);
    for (const [id, proof] of this.windows) if ((clientId === undefined || proof.context.clientId === clientId) && (channel === undefined || proof.context.eventChannelId === channel)) this.windows.delete(id);
    for (const [id, entry] of this.traversals) if ((clientId === undefined || entry.clientId === clientId) && (channel === undefined || entry.channel === channel)) this.traversals.delete(id); }
  clear(): void { this.traversals.clear(); this.windows.clear(); this.loadingWindows.clear(); }
  isolated(context: CallContext, imageDisplayChars = 0): { read(params: JsonObject): Promise<JsonValue>; close(): void } {
    const scope = randomUUID(); const owned = new Set<string>(); let closed = false;
    return { read: params => {
      if (closed) throw new DeliveryError('history_stale', 'History reader is closed');
      owned.add(key(string(params.threadId, 'threadId'), context, scope));
      return this.read(params, context, scope, imageDisplayChars);
    }, close: () => { closed = true; for (const id of owned) this.traversals.delete(id); owned.clear(); } };
  }
  private cursor(page: JsonObject, prior: string | null, seen: Set<string>): string | null {
    const next = page.nextCursor; if (next === null) return null; const cursor = string(next, 'nextCursor', LIMITS.cursorBytes, true);
    if (cursor === prior || seen.has(cursor)) throw new DeliveryError('cursor_loop', 'Native history cursor repeated'); seen.add(cursor); return cursor;
  }
  async window(threadId: string, context: CallContext, limit: number, references = false): Promise<JsonObject> {
    const id = key(threadId, context), token = { threadId, context };
    if (!this.loadingWindows.has(id) && this.loadingWindows.size >= 128) throw new DeliveryError('capacity', '历史窗口读取已满。');
    this.loadingWindows.set(id, token);
    try { return await this.loadWindow(threadId, context, limit, references, () => this.loadingWindows.get(id) === token); }
    finally { if (this.loadingWindows.get(id) === token) this.loadingWindows.delete(id); }
  }
  private async loadWindow(threadId: string, context: CallContext, limit: number, references: boolean, owns: () => boolean): Promise<JsonObject> {
    const id = key(threadId, context), state = this.host.state(threadId);
    this.windows.delete(id);
    const revision = state.revision, history = state.historyRevision ?? 0;
    const meta = object(await this.host.native('thread/read', { threadId, includeTurns: false }));
    if (object(meta.thread).id !== threadId) throw new DeliveryError('invalid_native_response', 'History thread identity mismatch');
    this.host.observe(meta, revision);
    const turnRevision = state.turnRevision ?? 0;
    const reader = this.isolated(context, references ? WINDOW_CHARS : 0);
    let page: JsonObject;
    let size = limit;
    try {
      for (;;) {
        try { page = object(await reader.read({ threadId, limit: size, ...(references ? { timelineFormat: 'references' } : {}) })); break; }
        catch (error) {
          if (!(error instanceof DeliveryError) || error.code !== 'capacity') throw error;
          if (size > 1) { size = Math.max(1, Math.floor(size / 2)); continue; }
          // A lone turn can exceed the native aggregate budget. Its newest
          // timeline row may be a turnCompleted marker just after the answer.
          let count = Math.max(limit, 20);
          for (;;) {
            try {
              const tail = object(await this.host.native('thread/timeline/list', { threadId, limit: count }, references ? WINDOW_CHARS : 0, true));
              validateTimelineContract('ThreadTimelineListResponse', tail);
              if (!Array.isArray(tail.data) || tail.data.length > count) throw new DeliveryError('invalid_native_response', 'Invalid tail page');
              page = { turns: [], timeline: tail.data, complete: false, activeRealtimeSessionAtPageStart: tail.activeRealtimeSessionAtPageStart! };
              break;
            } catch (error) {
              if (!(error instanceof DeliveryError) || error.code !== 'capacity' || count === 1) throw error;
              count = Math.max(1, Math.floor(count / 2));
            }
          }
          break;
        }
      }
    } finally { reader.close(); }
    const active = (page.timeline as JsonValue[]).reduce<JsonValue>(advanceWindowVoice, page.activeRealtimeSessionAtPageStart!);
    if (!owns() || this.host.closed() || this.host.state(threadId) !== state || (state.historyRevision ?? 0) !== history ||
        (state.turnRevision ?? 0) !== turnRevision) throw new DeliveryError('history_stale', 'History changed during the window read');
    if (active === null && !state.unknown && !state.pending && state.turnId === null && state.status !== 'active') {
      if (this.windows.size >= 256) this.windows.delete(this.windows.keys().next().value!);
      this.windows.set(id, { threadId, context, state, revision: turnRevision, history });
    }
    const complete = page.complete === true;
    return fitHistoryWindow({ ...page, nextCursor: null, backwardsCursor: null, legacy: page.legacy === true,
      turnsComplete: complete, timelineComplete: complete, complete, truncated: !complete,
      executionReady: this.windowReady(threadId, context), historyVersion: history });
  }
  async read(params: JsonObject, context: CallContext, scope = '', imageDisplayChars = 4_000_000): Promise<JsonValue> {
    if (params.timelineFormat !== undefined && params.timelineFormat !== 'references') throw new DeliveryError('invalid_params', '未知的历史时间线格式。');
    const references = params.timelineFormat === 'references';
    if (scope === '' && params.intent === 'window') {
      onlyKeys(params, ['intent', 'threadId', 'limit', 'timelineFormat', 'baseHistoryVersion']);
      const threadId = string(params.threadId, 'threadId'), limit = integer(params.limit ?? 15, 'limit', 1, 30);
      if (params.baseHistoryVersion === undefined) return this.window(threadId, context, limit, references);
      if (!references) throw new DeliveryError('invalid_params', '增量核对需要引用时间线。');
      const version = integer(params.baseHistoryVersion, 'baseHistoryVersion', 0, Number.MAX_SAFE_INTEGER);
      const id = key(threadId, context), base = this.traversals.get(id);
      const valid = () => !!base?.complete && !!base.referenceIndex && base.completeVersion === version && this.traversals.get(id) === base &&
        base.state === this.host.state(threadId) && (base.state.historyRevision ?? 0) === version;
      const matchedAtStart = valid();
      const result = await this.window(threadId, context, limit, references);
      return { ...result, baseHistoryVerified: result.windowClipped !== true && matchedAtStart && valid() && result.historyVersion === version };
    }
    onlyKeys(params, ['threadId', 'cursor', 'limit', 'timelineFormat']); const threadId = string(params.threadId, 'threadId'), limit = params.limit === undefined ? 25 : integer(params.limit, 'limit', 1, 100), id = key(threadId, context, scope);
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
      const state = this.host.state(threadId);
      entry = { threadId, clientId: context.clientId, channel: context.eventChannelId, next: undefined, complete: false, loading: false, turnCursor: null, timelineCursor: null, turnsComplete: false, timelineComplete: false, turnSeen: new Set(), timelineSeen: new Set(), pages: 0, bytes: 0, items: 0, ...(references ? { referenceIndex: new HistoryReferenceIndex() } : {}), legacy: false, state, turnRevision: state.turnRevision ?? 0, unknown: state.unknown }; this.traversals.set(id, entry);
    } else if (!entry || entry.complete || !!entry.referenceIndex !== references || entry.next !== params.cursor) throw new DeliveryError('invalid_cursor', 'History cursor does not continue this connection\'s combined traversal');
    if (entry.loading) throw new DeliveryError('history_busy', 'History page is still loading'); const current = entry; current.loading = true;
    const assertCurrent = (): void => {
      const state = this.host.state(threadId);
      if (this.host.closed() || this.traversals.get(id) !== current || state !== current.state || (state.turnRevision ?? 0) !== current.turnRevision || state.unknown !== current.unknown) throw new DeliveryError('history_stale', 'History or its live turn changed during loading; read it again');
    };
    const publish = (turns: JsonValue[], timeline: JsonValue[], active: JsonValue): JsonObject => {
      assertCurrent();
      // Native history and agent status are read separately. A synthesized
      // interrupted row must not override an exact live/terminal notification.
      // Keep native items and pagination: this cache is not history completeness.
      turns = turns.map(value => {
        const turn = object(value), state = current.state, terminal = state.lastTerminalTurn;
        const status = terminal && terminal.id === turn.id ? terminal.status
          : !state.unknown && state.turnId !== null && state.turnId === turn.id ? 'inProgress' : turn.status;
        return status === turn.status ? value : { ...turn, status: status! };
      });
      if (current.referenceIndex) {
        const compact = current.referenceIndex.project(turns, timeline);
        timeline = compact.entries; current.items += compact.added;
      } else {
        current.items += timeline.length + turns.reduce<number>((count, value) => count + (object(value).items as JsonValue[]).length, 0);
      }
      current.bytes += Buffer.byteLength(jsonBytes({ turns, timeline }, LIMITS.historyBytes));
      if (current.bytes > LIMITS.historyBytes || current.items > LIMITS.historyItems) { this.traversals.delete(id); throw new DeliveryError('capacity', 'Combined turn and voice history exceeded its traversal budget; context remains incomplete'); }
      current.complete = current.turnsComplete && current.timelineComplete; current.next = current.complete ? null : randomUUID();
      if (current.complete) { current.referenceIndex?.clear(); current.completeVersion = current.state.historyRevision ?? 0; }
      return { turns, timeline, nextCursor: current.next, backwardsCursor: null, complete: current.complete, turnsComplete: current.turnsComplete, timelineComplete: current.timelineComplete, activeRealtimeSessionAtPageStart: active, legacy: current.legacy, historyVersion: this.host.state(threadId).historyRevision ?? 0 };
    };
    try {
      assertCurrent();
      const state = this.host.state(threadId);
      if (state.fresh && state.status !== 'active' && !state.pending && !state.unknown) { current.turnsComplete = current.timelineComplete = true; return publish([], [], null); }
      if (!state.historyMode) {
        const revision = state.revision, metadata = await this.host.native('thread/read', { threadId });
        if (object(object(metadata).thread).id !== threadId) throw new DeliveryError('invalid_native_response', 'Thread identity mismatch');
        assertCurrent(); this.host.observe(metadata, revision);
        // Initial metadata may establish an already running turn. All following
        // pages remain fenced to that lifecycle, including between requests.
        current.turnRevision = state.turnRevision ?? 0;
      }
      const requested = Number(!current.turnsComplete) + Number(!current.timelineComplete); if (current.pages + requested > 128) throw new DeliveryError('capacity', 'Combined native history exceeded 128 pages; context remains incomplete'); current.pages += requested;
      let turns: JsonValue[] = [], timeline: JsonValue[] = [], active: JsonValue = null;
      const imagePreview = references ? imageDisplayChars : 0;
      if (!current.turnsComplete) {
        const legacy = async (): Promise<void> => {
          if (current.turnCursor !== null) throw new DeliveryError('unsupported_cursor', 'Legacy turn history cannot continue a native turn cursor');
          const result = object(await this.host.native('thread/read', { threadId, includeTurns: true }, imagePreview)), thread = object(result.thread);
          if (thread.id !== threadId || !Array.isArray(thread.turns)) throw new DeliveryError('invalid_native_response', 'Legacy thread identity mismatch'); turns = thread.turns; this.host.checkTurns(turns); current.legacy = true; current.turnsComplete = true;
        };
        if (state.historyMode === 'legacy') await legacy();
        else {
          let page: JsonObject | undefined;
          try { page = object(await this.host.native('thread/turns/list', { threadId, limit, sortDirection: 'desc', itemsView: 'full', ...(current.turnCursor !== null ? { cursor: current.turnCursor } : {}) }, imagePreview)); }
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
        const result = await this.host.native('thread/timeline/list', { threadId, limit, ...(current.timelineCursor !== null ? { cursor: current.timelineCursor } : {}) }, imagePreview); validateTimelineContract('ThreadTimelineListResponse', result); jsonBytes(result, LIMITS.historyBytes); const page = object(result);
        if (!Array.isArray(page.data) || page.data.length > limit) throw new DeliveryError('invalid_native_response', 'Invalid canonical timeline page'); timeline = page.data;
        current.timelineCursor = this.cursor(page, current.timelineCursor, current.timelineSeen); current.timelineComplete = current.timelineCursor === null; active = page.activeRealtimeSessionAtPageStart!;
      }
      return publish(turns, timeline, active);
    } catch (error) { if (this.traversals.get(id) === current) this.traversals.delete(id); throw error; }
    finally { current.loading = false; }
  }
}
