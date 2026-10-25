import { DeliveryError, integer, jsonBytes, LIMITS, object, onlyKeys, string, type CallContext, type JsonObject, type JsonValue } from './types.js';
import { options, validateOfficial } from './validation.js';
import type { PreparedAttachments } from './attachments.js';
import type { NativeOptions } from './native.js';
import { threadSettingsKeys, turnSettingsKeys } from './workflow-methods.js';
import type { PreparedInputContext } from './input-context.js';

export interface WorkflowMutation {
  method: string; params: JsonObject; schema: string; responseSchema: string;
  threadId: string; mode: 'idle' | 'active' | 'any'; history?: boolean; expectedTurnId?: string;
  prepared?: PreparedAttachments; workResult?: 'turn' | 'goal' | 'shell'; newThread?: boolean; invalidateHistory?: boolean; directInput?: boolean;
  project?: (result: JsonValue) => JsonValue;
  preflight?: (thread: JsonObject) => Promise<void>;
  beforeWrite?: () => void;
  mediaInput?: JsonValue[];
}
export interface WorkflowHost {
  native(method: string, params: JsonValue, options?: NativeOptions): Promise<JsonValue>;
  mutate(operation: WorkflowMutation, context: CallContext): Promise<JsonValue>;
  call(method: string, params: JsonObject, context: CallContext): Promise<JsonValue>;
  prepare(ids: JsonValue | undefined, threadId: string): PreparedAttachments;
  describeInput(input: JsonValue, threadId: string): { text: string; attachmentIds: string[]; attachments: JsonObject[]; retainedInput: JsonValue[]; retainedAttachments: JsonValue[]; retainedReferences: JsonValue[]; hasOpaqueInput: boolean };
  contextInput(cwd: string, references: JsonValue | undefined, extraContext: JsonValue | undefined, context: CallContext, threadId: string): Promise<PreparedInputContext>;
  checkHistory(turns: JsonValue[]): void;
  cwd(value: JsonValue | undefined): string;
}
const response = (schema: string, value: JsonValue): JsonObject => {
  try { validateOfficial(schema, value); return object(value); }
  catch { throw new DeliveryError('invalid_native_response', `Native ${schema} was invalid`); }
};
function pageParams(params: JsonObject): JsonObject {
  const result = { ...params, limit: params.limit === undefined ? 50 : integer(params.limit, 'limit', 1, 100) };
  if (params.cursor !== undefined && params.cursor !== null) string(params.cursor, 'cursor', LIMITS.cursorBytes, true);
  return result;
}
function pageResult(schema: string, value: JsonValue, cursor?: JsonValue): JsonObject {
  const result = response(schema, value); jsonBytes(result, LIMITS.historyBytes);
  if (!Array.isArray(result.data) || result.data.length > 100) throw new DeliveryError('invalid_native_response', 'Native page exceeds record budget');
  if (result.nextCursor !== null) { string(result.nextCursor, 'nextCursor', LIMITS.cursorBytes, true); if (result.nextCursor === cursor) throw new DeliveryError('cursor_loop', 'Native cursor did not advance'); }
  return result;
}

/** Fixed workflows over the pinned protocol; ownership and activity remain with RuntimeService. */
export class Workflows {
  constructor(private host: WorkflowHost) {}
  private input(params: JsonObject, threadId: string): { input: JsonValue[]; prepared: PreparedAttachments } {
    const text = string(params.text ?? '', 'text', 1024 * 1024, true); const prepared = this.host.prepare(params.attachmentIds, threadId);
    return { input: [{ type: 'text', text, text_elements: [] }, ...prepared.input], prepared };
  }
  private inputPreflight(input: JsonValue[], params: JsonObject, context: CallContext, threadId: string): (thread: JsonObject) => Promise<void> {
    return async thread => {
      if (params.references !== undefined || params.extraContext !== undefined) input.push(...(await this.host.contextInput(this.host.cwd(thread.cwd), params.references, params.extraContext, context, threadId)).queuedInput);
      if (!input.some(item => { const value = object(item); return value.type !== 'text' || (typeof value.text === 'string' && value.text.length > 0); })) throw new DeliveryError('invalid_params', 'Message requires text, attachments or context references');
    };
  }
  async call(method: string, params: JsonObject, context: CallContext): Promise<JsonValue> {
    if (method === 'collaborationMode/list') {
      onlyKeys(params, []); const result = response('CollaborationModeListResponse', await this.host.native(method, {})); jsonBytes(result, 256 * 1024); return result;
    }
    if (method === 'review/startNew') return this.newReview(params, context);
    if (method === 'modelProvider/capabilities/read') { onlyKeys(params, []); return response('ModelProviderCapabilitiesReadResponse', await this.host.native(method, {})); }
    if (method === 'thread/loaded/list') { onlyKeys(params, ['cursor', 'limit']); const p = pageParams(params); validateOfficial('ThreadLoadedListParams', p); return pageResult('ThreadLoadedListResponse', await this.host.native(method, p), params.cursor); }
    if (method === 'permissionProfile/list') { onlyKeys(params, ['cwd', 'cursor', 'limit']); const p = pageParams({ ...params, cwd: this.host.cwd(params.cwd) }); validateOfficial('PermissionProfileListParams', p); return pageResult('PermissionProfileListResponse', await this.host.native(method, p), params.cursor); }
    if (method === 'thread/search') {
      onlyKeys(params, ['projectId', 'cwd', 'archived', 'searchTerm', 'cursor', 'limit']); const cwd = this.host.cwd(params.cwd); string(params.searchTerm, 'searchTerm', 4096);
      const p = pageParams({ searchTerm: params.searchTerm!, ...(params.archived !== undefined ? { archived: params.archived } : {}), ...(params.cursor !== undefined ? { cursor: params.cursor } : {}), ...(params.limit !== undefined ? { limit: params.limit } : {}) });
      validateOfficial('ThreadSearchParams', p); const result = pageResult('ThreadSearchResponse', await this.host.native(method, p), params.cursor);
      return { ...result, data: (result.data as JsonValue[]).filter(entry => object(object(entry).thread).cwd === cwd) };
    }
    const threadId = string(params.threadId, 'threadId');
    const mutate = (schema: string, responseSchema: string, mode: WorkflowMutation['mode'], p = params, extra: Partial<WorkflowMutation> = {}): Promise<JsonValue> => {
      validateOfficial(schema, p); return this.host.mutate({ method, params: p, schema, responseSchema, threadId, mode, ...extra }, context);
    };
    switch (method) {
      case 'turn/steer': {
        onlyKeys(params, ['threadId', 'expectedTurnId', 'text', 'attachmentIds', 'clientUserMessageId', 'references', 'extraContext']); const expectedTurnId = string(params.expectedTurnId, 'expectedTurnId'); const { input, prepared } = this.input(params, threadId);
        const p: JsonObject = { threadId, expectedTurnId, input }; if (params.clientUserMessageId !== undefined) p.clientUserMessageId = string(params.clientUserMessageId, 'clientUserMessageId', 256);
        return mutate('TurnSteerParams', 'TurnSteerResponse', 'active', p, { expectedTurnId, prepared, directInput: true, preflight: this.inputPreflight(input, params, context, threadId) });
      }
      case 'turn/settings/update': {
        onlyKeys(params, turnSettingsKeys); const expectedTurnId = string(params.turnId, 'turnId');
        return mutate('TurnSettingsUpdateParams', 'TurnSettingsUpdateResponse', 'active', params, { expectedTurnId });
      }
      case 'thread/queue/add': case 'thread/queue/update': {
        const adding = method === 'thread/queue/add'; onlyKeys(params, ['threadId', 'text', 'attachmentIds', 'references', 'extraContext', adding ? 'clientUserMessageId' : 'queuedSubmissionId']);
        const field = adding ? 'clientUserMessageId' : 'queuedSubmissionId'; const id = string(params[field], field, 256);
        let input: JsonValue[], prepared: PreparedAttachments;
        ({ input, prepared } = this.input(params, threadId));
        if (!adding && (params.attachmentIds === undefined || params.references === undefined)) {
          const original = await this.findQueued(threadId, id); const retained = this.host.describeInput(original.input!, threadId);
          if (params.attachmentIds === undefined) input.push(...retained.retainedAttachments);
          if (params.references === undefined) input.push(...retained.retainedReferences);
        }
        const p = { threadId, input, [field]: id };
        return mutate(adding ? 'ThreadQueueAddParams' : 'ThreadQueueUpdateParams', adding ? 'ThreadQueueAddResponse' : 'ThreadQueueUpdateResponse', 'any', p, { prepared, directInput: true, history: true, preflight: this.inputPreflight(input, params, context, threadId), project: result => ({ queuedSubmission: this.queued(object(object(result).queuedSubmission), threadId) }) });
      }
      case 'thread/queue/list': {
        onlyKeys(params, ['threadId', 'cursor', 'limit']); const p = pageParams(params); validateOfficial('ThreadQueueListParams', p);
        const result = pageResult('ThreadQueueListResponse', await this.host.native(method, p), params.cursor); return { ...result, data: (result.data as JsonValue[]).map(item => this.queued(object(item), threadId)) };
      }
      case 'thread/queue/delete': onlyKeys(params, ['threadId', 'queuedSubmissionId']); return mutate('ThreadQueueDeleteParams', 'ThreadQueueDeleteResponse', 'any');
      case 'thread/queue/reorder': {
        onlyKeys(params, ['threadId', 'queuedSubmissionIds']); if (!Array.isArray(params.queuedSubmissionIds) || params.queuedSubmissionIds.length > 100 || new Set(params.queuedSubmissionIds).size !== params.queuedSubmissionIds.length) throw new DeliveryError('invalid_params', 'Queue order requires at most 100 distinct identifiers');
        return mutate('ThreadQueueReorderParams', 'ThreadQueueReorderResponse', 'any');
      }
      case 'thread/queue/start': {
        onlyKeys(params, ['threadId', 'queuedSubmissionId']); const mediaInput: JsonValue[] = [];
        return mutate('ThreadQueueStartParams', 'ThreadQueueStartResponse', 'idle', params, { history: true, workResult: 'turn', directInput: true, mediaInput, preflight: async () => { mediaInput.push(...(await this.findQueued(threadId, params.queuedSubmissionId == null ? undefined : string(params.queuedSubmissionId, 'queuedSubmissionId'))).input as JsonValue[]); } });
      }
      case 'thread/goal/get': onlyKeys(params, ['threadId']); return response('ThreadGoalGetResponse', await this.host.native(method, { threadId }));
      case 'thread/goal/set': case 'thread/goal/clear': {
        const setting = method === 'thread/goal/set'; onlyKeys(params, setting ? ['threadId', 'origin', 'objective', 'status', 'tokenBudget'] : ['threadId', 'origin']);
        if (params.origin !== undefined && params.origin !== 'user') throw new DeliveryError('invalid_params', 'Goal changes require explicit user provenance');
        if (params.objective !== undefined && params.objective !== null) string(params.objective, 'objective', 65536);
        if (params.tokenBudget !== undefined && params.tokenBudget !== null) integer(params.tokenBudget, 'tokenBudget', 1, Number.MAX_SAFE_INTEGER);
        const p = { ...params, origin: 'user' }; const mayStart = setting && (params.status == null || params.status === 'active' || typeof params.objective === 'string');
        return mutate(setting ? 'ThreadGoalSetParams' : 'ThreadGoalClearParams', setting ? 'ThreadGoalSetResponse' : 'ThreadGoalClearResponse', 'any', p, { history: mayStart, ...(mayStart ? { workResult: 'goal' as const, directInput: true } : {}) });
      }
      case 'thread/fork': {
        onlyKeys(params, ['threadId', 'beforeTurnId', 'lastTurnId', 'options']); if (params.beforeTurnId !== undefined && params.lastTurnId !== undefined) throw new DeliveryError('invalid_params', 'Choose one fork anchor');
        const p: JsonObject = { threadId, ...options(params.options, false), excludeTurns: true, deferGoalContinuation: true };
        if (params.beforeTurnId !== undefined) p.beforeTurnId = string(params.beforeTurnId, 'beforeTurnId'); if (params.lastTurnId !== undefined) p.lastTurnId = string(params.lastTurnId, 'lastTurnId');
        return mutate('ThreadForkParams', 'ThreadForkResponse', 'idle', p, { history: true, newThread: true });
      }
      case 'thread/revert': onlyKeys(params, ['threadId', 'beforeTurnId']); return mutate('ThreadRevertParams', 'ThreadRevertResponse', 'idle', params, { history: true, invalidateHistory: true });
      case 'review/start': {
        onlyKeys(params, ['threadId', 'target', 'delivery']); if (params.delivery !== undefined && params.delivery !== 'inline') throw new DeliveryError('invalid_params', 'Use review/startNew for a separate review');
        return mutate('ReviewStartParams', 'ReviewStartResponse', 'idle', { threadId, target: params.target!, delivery: 'inline' }, { history: true, workResult: 'turn', directInput: true });
      }
      case 'thread/settings/update': {
        onlyKeys(params, threadSettingsKeys); if (params.permissions != null && params.sandboxPolicy != null) throw new DeliveryError('invalid_params', 'Choose a named permission profile or a sandbox policy, not both');
        if (params.disabledPluginIds != null && (!Array.isArray(params.disabledPluginIds) || params.disabledPluginIds.length > 128 || new Set(params.disabledPluginIds).size !== params.disabledPluginIds.length)) throw new DeliveryError('invalid_params', 'At most 128 distinct disabled plugin identifiers are allowed');
        const mediaInput: JsonValue[] = [];
        return mutate('ThreadSettingsUpdateParams', 'ThreadSettingsUpdateResponse', 'any', params, { mediaInput, ...(typeof params.model === 'string' || params.collaborationMode != null ? { preflight: async () => { mediaInput.push(...await this.queuedInputs(threadId)); } } : {}) });
      }
      case 'thread/metadata/update': onlyKeys(params, ['threadId', 'gitInfo', 'daybreakEnabled']); return mutate('ThreadMetadataUpdateParams', 'ThreadMetadataUpdateResponse', 'any');
      case 'thread/delete': onlyKeys(params, ['threadId']); return mutate('ThreadDeleteParams', 'ThreadDeleteResponse', 'idle', params, { history: true, invalidateHistory: true });
      case 'thread/unsubscribe': onlyKeys(params, ['threadId']); return mutate('ThreadUnsubscribeParams', 'ThreadUnsubscribeResponse', 'idle');
      case 'thread/readState/update': onlyKeys(params, ['threadId', 'operation', 'expectedRevision']); return mutate('ThreadReadStateUpdateParams', 'ThreadReadStateUpdateResponse', 'any');
      case 'thread/agents/list': {
        onlyKeys(params, ['threadId', 'cursor', 'limit']); const parent = object(object(await this.host.call('thread/read', { threadId }, context)).thread); const cwd = this.host.cwd(parent.cwd);
        const p = pageParams({ ...(params.cursor !== undefined ? { cursor: params.cursor } : {}), ...(params.limit !== undefined ? { limit: params.limit } : {}), cwd, ancestorThreadId: threadId, sourceKinds: ['subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther'] });
        validateOfficial('ThreadListParams', p); const result = pageResult('ThreadListResponse', await this.host.native('thread/list', p), params.cursor);
        for (const child of result.data as JsonValue[]) { const thread = object(child); if (thread.cwd !== cwd || thread.id === threadId || thread.parentThreadId === null) throw new DeliveryError('invalid_native_response', 'Native agent result escaped its project or ancestor scope'); }
        return result;
      }
      case 'thread/searchOccurrences': {
        onlyKeys(params, ['threadId', 'searchTerm', 'cursor', 'limit']); string(params.searchTerm, 'searchTerm', 4096); const p = pageParams(params); validateOfficial('ThreadSearchOccurrencesParams', p);
        return pageResult('ThreadSearchOccurrencesResponse', await this.host.native(method, p), params.cursor);
      }
      case 'thread/history/window': {
        onlyKeys(params, ['threadId', 'turnCursor', 'limit']); const cursor = string(params.turnCursor, 'turnCursor', LIMITS.cursorBytes, true); const p = pageParams({ threadId, cursor, ...(params.limit !== undefined ? { limit: params.limit } : {}), sortDirection: 'desc', itemsView: 'full' });
        const result = pageResult('ThreadTurnsListResponse', await this.host.native('thread/turns/list', p), cursor); this.host.checkHistory(result.data as JsonValue[]);
        return { turns: [...result.data as JsonValue[]].reverse(), nextCursor: result.nextCursor!, backwardsCursor: result.backwardsCursor ?? null, complete: false, partial: true };
      }
      case 'thread/export': return this.export(params, context);
      default: throw new DeliveryError('method_not_found', 'Unsupported task workflow');
    }
  }
  private queued(item: JsonObject, threadId: string): JsonObject {
    const { retainedInput: _retained, retainedAttachments: _attachments, retainedReferences: _references, ...display } = this.host.describeInput(item.input!, threadId); return { ...item, ...display };
  }
  private async findQueued(threadId: string, id?: string): Promise<JsonObject> {
    let cursor: JsonValue = null, bytes = 0; const seen = new Set<string>();
    for (let count = 0; count < 128; count++) {
      const result = pageResult('ThreadQueueListResponse', await this.host.native('thread/queue/list', { threadId, cursor, limit: 100 }), cursor); bytes += Buffer.byteLength(jsonBytes(result));
      if (bytes > LIMITS.historyBytes) throw new DeliveryError('capacity', 'Queue traversal exceeds byte budget');
      const match = (result.data as JsonValue[]).map(item => object(item)).find(item => id === undefined || item.id === id); if (match) return match;
      if (result.nextCursor === null) throw new DeliveryError('not_found', 'Queued submission no longer exists');
      const next = string(result.nextCursor, 'nextCursor', LIMITS.cursorBytes, true); if (seen.has(next)) throw new DeliveryError('cursor_loop', 'Queue cursor returned to a previous page'); seen.add(next); cursor = next;
    }
    throw new DeliveryError('capacity', 'Queue traversal exceeds page budget');
  }
  private async queuedInputs(threadId: string): Promise<JsonValue[]> {
    let cursor: JsonValue = null, bytes = 0; const seen = new Set<string>(), input: JsonValue[] = [];
    for (let page = 0; page < 32; page++) {
      const result = pageResult('ThreadQueueListResponse', await this.host.native('thread/queue/list', { threadId, cursor, limit: 100 }), cursor); bytes += Buffer.byteLength(jsonBytes(result));
      if (bytes > LIMITS.historyBytes) throw new DeliveryError('capacity', 'Queued media validation exceeds its byte budget');
      for (const entry of result.data as JsonValue[]) input.push(...object(entry).input as JsonValue[]);
      if (result.nextCursor === null) return input;
      const next = string(result.nextCursor, 'nextCursor', LIMITS.cursorBytes); if (seen.has(next)) throw new DeliveryError('cursor_loop', 'Queue cursor repeated'); seen.add(next); cursor = next;
    }
    throw new DeliveryError('capacity', 'Queued media validation exceeds its page budget');
  }
  private async newReview(params: JsonObject, context: CallContext): Promise<JsonValue> {
    onlyKeys(params, ['projectId', 'cwd', 'target', 'options']); const cwd = this.host.cwd(params.cwd); validateOfficial('ReviewTarget', params.target!); options(params.options, false);
    const creation = object(await this.host.call('thread/start', { cwd, ...(params.options !== undefined ? { options: params.options } : {}) }, context)); const thread = object(creation.thread); const threadId = string(thread.id, 'created thread id');
    try { return { thread, ...object(await this.call('review/start', { threadId, target: params.target! }, context)) }; }
    catch (error) { throw new DeliveryError('review_start_incomplete', 'Review thread was created; inspect it before retrying the review.', 'unknown', { phase: 'review', threadId, causeCode: error instanceof DeliveryError ? error.code : 'internal_error', causeDelivery: error instanceof DeliveryError ? error.delivery : 'unknown' }); }
  }
  private async export(params: JsonObject, context: CallContext): Promise<JsonValue> {
    onlyKeys(params, ['threadId', 'format']); const threadId = string(params.threadId, 'threadId'); if (params.format !== 'json' && params.format !== 'markdown') throw new DeliveryError('invalid_params', 'Choose json or markdown export');
    const thread = object(object(await this.host.call('thread/read', { threadId }, context)).thread); let cursor: JsonValue = null; const turns: JsonValue[] = []; const timeline: JsonValue[] = []; let size = 0;
    for (let page = 0; ; page++) {
      if (page >= 128) throw new DeliveryError('capacity', 'Export exceeds 128 pages');
      const result = object(await this.host.call('thread/history', { threadId, cursor, limit: 100 }, context)); const batch = result.turns as JsonValue[];
      const canonical = result.timeline as JsonValue[]; size += Buffer.byteLength(jsonBytes({ turns: batch, timeline: canonical })); if (size > LIMITS.historyBytes) throw new DeliveryError('capacity', 'Complete export exceeds 8 MiB'); turns.unshift(...batch); timeline.unshift(...canonical);
      if (result.complete === true) break; cursor = result.nextCursor!;
    }
    // Markdown retains every structured item as JSON, including tool results and
    // approval records; exporting only assistant prose would lose the transcript.
    timeline.sort((a, b) => Number(object(a).position) - Number(object(b).position));
    const content = params.format === 'json' ? JSON.stringify({ thread: { ...thread, turns }, timeline }, null, 2) : `# ${typeof thread.name === 'string' ? thread.name : 'Conversation'}\n\n` + turns.map(turn => `## Turn ${string(object(turn).id, 'turn id')}\n\n\`\`\`json\n${JSON.stringify(turn, null, 2)}\n\`\`\`\n`).join('\n') + `\n## Canonical timeline (including voice)\n\n\`\`\`json\n${JSON.stringify(timeline, null, 2)}\n\`\`\`\n`;
    jsonBytes(content, LIMITS.historyBytes);
    return { filename: `conversation-${threadId.replace(/[^a-zA-Z0-9_-]/g, '_')}.${params.format === 'json' ? 'json' : 'md'}`, mimeType: params.format === 'json' ? 'application/json' : 'text/markdown', content };
  }
}
