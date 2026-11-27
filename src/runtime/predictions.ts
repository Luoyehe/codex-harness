import { EpochIdentities } from './epoch-identities.js';
import { randomUUID } from 'node:crypto';
import { canonical, DeliveryError, jsonBytes, object, onlyKeys, string, type CallContext, type JsonObject, type JsonValue } from './types.js';
import { validateOfficial } from './validation.js';
import type { WorkflowMutation } from './workflows.js';
interface Host {
  native(method: string, params: JsonValue): Promise<JsonValue>;
  mutate(operation: WorkflowMutation, context: CallContext): Promise<JsonValue>;
  revision(threadId: string): number;
  emit(data: JsonObject, channel: string): void;
  changed(): void;
}
interface Entry {
  predictionId: string; threadId: string; sourceTurnId: string; owner: CallContext; createdAt: number;
  state: 'pending' | 'completed' | 'failed' | 'stale' | 'unknown'; pending: boolean; sent: boolean; revoked: boolean;
  invalidated?: boolean; revision: number; result?: JsonObject; timer?: NodeJS.Timeout;
}
export const predictionMethods = new Set(['thread/prediction/request', 'thread/prediction/read']);
/** Native results contain no request ID: never reassign a dispatched source to another request or owner. */
export class Predictions {
  private entries = new Map<string, Entry>(); private records = new EpochIdentities(); private sources = new Set<string>();
  constructor(private host: Host) {}
  activeThreads(): string[] { return [...new Set([...this.entries.values()].filter(entry => entry.pending || entry.state === 'unknown').map(entry => entry.threadId))]; }
  isUncertain(threadId: string): boolean { return [...this.entries.values()].some(entry => entry.threadId === threadId && entry.state === 'unknown'); }
  uncertainThreads(): string[] { return [...this.entries.values()].filter(entry => entry.state === 'unknown').map(entry => entry.threadId); }
  get pendingCount(): number { return [...this.entries.values()].filter(entry => entry.pending).length; }
  budget(): JsonObject { return { sourcesUsed: this.sources.size, sourceLimit: 2048, pending: this.pendingCount, retained: this.entries.size }; }
  private identity(entry: Entry): JsonObject { return { predictionId: entry.predictionId, threadId: entry.threadId, sourceTurnId: entry.sourceTurnId }; }
  private view(entry: Entry): JsonObject { return { ...this.identity(entry), state: entry.state, ...(entry.state === 'completed' && entry.result ? { result: entry.result } : {}) }; }
  private publish(entry: Entry): void { if (!entry.revoked) this.host.emit({ ...this.view(entry), clientId: entry.owner.clientId }, entry.owner.eventChannelId!); }
  private stale(entry: Entry, settled = false): void {
    entry.invalidated = true;
    if (entry.state === 'stale' || (entry.state === 'unknown' && !settled)) return;
    this.finish(entry); entry.state = 'stale'; delete entry.result;
    this.host.changed(); this.publish(entry);
  }
  invalidate(threadId?: string): void { for (const entry of this.entries.values()) if (threadId === undefined || entry.threadId === threadId) this.stale(entry); }
  private prune(): void { for (const [id, entry] of this.entries) if (!entry.pending && entry.state !== 'unknown' && (entry.revoked || Date.now() - entry.createdAt > 600000)) {
    this.sources.delete(canonical([entry.threadId, entry.sourceTurnId])); this.entries.delete(id);
  } }
  private finish(entry: Entry): void { entry.pending = false; clearTimeout(entry.timer); delete entry.timer; }
  private uncertain(entry: Entry): void {
    this.finish(entry); entry.state = 'unknown'; delete entry.result;
    this.host.changed(); this.publish(entry);
  }
  async call(method: string, params: JsonObject, context: CallContext): Promise<JsonValue> {
    this.prune(); const threadId = string(params.threadId, 'threadId', 256);
    if (method === 'thread/prediction/read') {
      onlyKeys(params, ['threadId', 'predictionId']); const entry = this.entries.get(string(params.predictionId, 'predictionId', 36));
      if (!entry || entry.revoked || entry.threadId !== threadId || entry.owner.clientId !== context.clientId || entry.owner.eventChannelId !== context.eventChannelId) throw new DeliveryError('not_found', 'Prediction expired or belongs to another connection');
      if (entry.state !== 'unknown' && entry.revision !== this.host.revision(threadId)) this.stale(entry);
      return this.view(entry);
    }
    onlyKeys(params, ['threadId', 'sourceTurnId']); if (!context.beforeWrite || !context.eventChannelId) throw new DeliveryError('operation_required', 'Predictions require a live owner and durable operation');
    const sourceTurnId = string(params.sourceTurnId, 'sourceTurnId', 256), key = canonical([threadId, sourceTurnId]);
    if (this.sources.has(key) || this.records.read(threadId, sourceTurnId)) throw new DeliveryError('prediction_already_requested', 'This source already has a prediction request; read its original receipt');
    if (this.entries.size >= 64 || this.pendingCount >= 8) throw new DeliveryError('capacity', '预测正在处理或结果暂存已满，请等待当前预测结束后重试。');
    if (this.isUncertain(threadId)) throw new DeliveryError('activity_unknown', 'Thread outcome is unknown');
    if (this.activeThreads().includes(threadId)) throw new DeliveryError('prediction_busy', 'A prediction is still pending for this thread');
    const entry: Entry = { predictionId: randomUUID(), threadId, sourceTurnId, owner: { ...context }, createdAt: Date.now(), state: 'pending', pending: true, sent: false, revoked: false, revision: this.host.revision(threadId) };
    this.sources.add(key); this.entries.set(entry.predictionId, entry); this.host.changed();
    const current = (): void => { if (entry.revoked) throw new DeliveryError('client_disconnected', 'Prediction owner disconnected'); if (entry.state === 'stale' || entry.revision !== this.host.revision(threadId)) throw new DeliveryError('prediction_stale', 'The source context changed before prediction dispatch'); };
    try {
      await this.host.mutate({ method, params: { threadId, sourceTurnId }, schema: 'ThreadPredictionRequestParams', responseSchema: 'ThreadPredictionRequestResponse', threadId, mode: 'idle', history: true, directInput: true,
        preflight: async thread => {
          if (object(thread.status).type !== 'idle') throw new DeliveryError('session_not_loaded', 'Load an idle thread before requesting a prediction');
          current(); const page = object(await this.host.native('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'summary' })); jsonBytes(page, 262144); validateOfficial('ThreadTurnsListResponse', page);
          if (!Array.isArray(page.data) || page.data.length !== 1 || object(page.data[0]).id !== sourceTurnId || object(page.data[0]).status !== 'completed') throw new DeliveryError('prediction_stale', 'Choose the latest completed turn as the prediction source'); current();
        }, beforeWrite: () => {
          current(); this.records.add(threadId, sourceTurnId, 'sent'); entry.sent = true;
          entry.timer = setTimeout(() => { if (entry.pending) this.uncertain(entry); }, 60000); entry.timer.unref();
        } }, context);
      return { ...this.identity(entry), requested: true };
    } catch (error) {
      if (!entry.sent || (error instanceof DeliveryError && error.delivery === 'not_sent')) { this.finish(entry); if (this.entries.delete(entry.predictionId) && !entry.sent) this.sources.delete(key); this.host.changed(); }
      else if (entry.pending) this.uncertain(entry);
      throw error;
    }
  }
  notification(method: string, params: JsonObject): boolean {
    if (method !== 'thread/prediction/updated') {
      if (method === 'thread/deleted' && typeof params.threadId === 'string') this.records.forgetThread(params.threadId);
      if (typeof params.threadId === 'string' && ['turn/started', 'thread/reverted', 'thread/closed', 'thread/deleted', 'thread/archived', 'thread/settings/updated', 'thread/realtime/started', 'thread/realtime/item/completed'].includes(method)) {
        const closed = method === 'thread/closed' || method === 'thread/deleted';
        for (const entry of this.entries.values()) if (entry.threadId === params.threadId) this.stale(entry, closed);
      }
      return false;
    }
    // Always consume even unsolicited or malformed native predictions; no public text broadcast.
    const entry = [...this.entries.values()].find(item => item.threadId === params.threadId && item.sourceTurnId === params.sourceTurnId && item.sent && (item.pending || item.state === 'unknown'));
    if (!entry) return true;
    try { onlyKeys(params, ['threadId', 'sourceTurnId', 'result']); jsonBytes(params, 32768); validateOfficial('ThreadPredictionUpdatedNotification', params); const result = object(params.result); onlyKeys(result, result.type === 'completed' ? ['type', 'text'] : ['type']); if (result.type === 'completed' && result.text !== null) string(result.text, 'prediction text', 16384, true);
      this.finish(entry); if (!entry.invalidated && !entry.revoked && entry.revision === this.host.revision(entry.threadId)) { entry.state = result.type === 'completed' ? 'completed' : 'failed'; entry.result = structuredClone(result); } else { this.stale(entry, true); return true; }
    } catch { this.uncertain(entry); return true; }
    this.host.changed(); this.publish(entry); return true;
  }
  disconnect(clientId?: string, channel?: string): void { for (const entry of this.entries.values()) if ((clientId === undefined || entry.owner.clientId === clientId) && (channel === undefined || entry.owner.eventChannelId === channel)) { entry.revoked = true; this.stale(entry); } this.prune(); }
  reset(): void { for (const entry of this.entries.values()) clearTimeout(entry.timer); this.entries.clear(); this.sources.clear(); this.records.clear(); }
}
