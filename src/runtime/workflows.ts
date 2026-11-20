import { DeliveryError, integer, jsonBytes, LIMITS, object, onlyKeys, string, type CallContext, type JsonObject, type JsonValue } from './types.js';
import { mediaModalities } from './input-modalities.js';
import { options, validateOfficial } from './validation.js';
import type { Attachments, PreparedAttachments } from './attachments.js';
import type { NativeOptions } from './native.js';
import { threadSettingsKeys, turnSettingsKeys } from './workflow-methods.js';
import type { PreparedInputContext } from './input-context.js';

export interface WorkflowMutation {
  method: string; params: JsonObject; schema: string; responseSchema: string;
  threadId: string; mode: 'idle' | 'active' | 'any'; history?: boolean; expectedTurnId?: string;
  prepared?: PreparedAttachments; workResult?: 'turn' | 'goal' | 'shell'; newThread?: boolean; invalidateHistory?: boolean; directInput?: boolean;
  project?: (result: JsonValue) => JsonValue;
  preflight?: (thread: JsonObject) => Promise<void | { timeoutMs: number }>;
  beforeWrite?: () => void;
  mediaInput?: JsonValue[];
}
export interface WorkflowHost {
  native(method: string, params: JsonValue, options?: NativeOptions): Promise<JsonValue>;
  mutate(operation: WorkflowMutation, context: CallContext): Promise<JsonValue>;
  call(method: string, params: JsonObject, context: CallContext): Promise<JsonValue>;
  historyTraversal(context: CallContext): { read(params: JsonObject): Promise<JsonValue>; close(): void };
  prepare(ids: JsonValue | undefined, threadId: string): PreparedAttachments;
  queueCapacity(threadId: string): Promise<JsonObject | undefined>;
  queueItem(threadId: string, id: string): Promise<JsonObject>;
  queueImage(threadId: string, id: string, ordinal: number, marker: JsonObject): Promise<JsonObject>;
  queueHandoffs: Pick<Attachments, 'listQueueHandoffs' | 'movedQueueHandoffSources' | 'queueHandoffCandidates' | 'saveQueueHandoff' | 'queueHandoffMatches' | 'markQueueHandoffRemoved' | 'queueHandoffRestoreInput' | 'queueHandoffMetadata' | 'beginQueueHandoffRestore' | 'settleQueueHandoffRestore' | 'discardQueueHandoff' | 'rerouteQueueInput' | 'queueMediaEvidence' | 'compactQueuedInput'>;
  describeInput(input: JsonValue, threadId: string, queuedId?: string): ReturnType<Attachments['describeInput']>;
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
      onlyKeys(params, ['projectId', 'cwd', 'archived', 'searchTerm', 'cursor', 'limit', 'sortKey', 'sortDirection']);
      const { cwd: requestedCwd, projectId: _projectId, ...searchParams } = params;
      const cwd = this.host.cwd(requestedCwd);
      string(searchParams.searchTerm, 'searchTerm', 4096);
      const p = pageParams(searchParams);
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
        const { input, prepared } = this.input(params, threadId);
        const checkInput = this.inputPreflight(input, params, context, threadId);
        const preflight = async (thread: JsonObject) => {
          if (!adding && (params.text === undefined || params.attachmentIds === undefined || params.references === undefined || params.extraContext === undefined)) {
            const writable = () => context.beforeWrite?.();
            const original = await this.findQueued(threadId, id, writable);
            const routed = params.attachmentIds === undefined ? this.host.queueHandoffs.rerouteQueueInput(original.input as JsonValue[], threadId, id, writable) : original.input as JsonValue[];
            if (Object.keys(params).every(key => key === 'threadId' || key === 'queuedSubmissionId')) {
              input.splice(0, input.length, ...routed);
            } else {
              const retained = this.host.describeInput(routed, threadId, id);
              if (params.text === undefined) input[0] = { type: 'text', text: retained.text, text_elements: [] };
              if (params.attachmentIds === undefined) input.push(...retained.retainedAttachments);
              if (params.references === undefined) input.push(...retained.retainedReferences);
              if (params.extraContext === undefined) input.push(...retained.retainedExtras);
              if (retained.retainedLegacyContext.length) {
                if (params.references === undefined && params.extraContext === undefined) input.push(...retained.retainedLegacyContext);
                else if (params.references === undefined || params.extraContext === undefined) throw new DeliveryError('legacy_context_ambiguous', '旧版排队内容无法区分文件引用与说明；请同时提供 references 和 extraContext 进行整体替换，或保留这两项。');
              }
            }
          }
          await checkInput(thread);
        };
        const p = { threadId, input, [field]: id };
        return mutate(adding ? 'ThreadQueueAddParams' : 'ThreadQueueUpdateParams', adding ? 'ThreadQueueAddResponse' : 'ThreadQueueUpdateResponse', 'any', p, { prepared, directInput: true, history: true, preflight, project: result => ({ queuedSubmission: this.queued(object(object(result).queuedSubmission), threadId) }) });
      }
      case 'thread/queue/list': {
        onlyKeys(params, ['threadId', 'cursor', 'limit', 'queuedSubmissionId', 'view']);
        if (params.view !== undefined && params.view !== 'summary') throw new DeliveryError('invalid_params', '未知待办显示方式。');
        if (params.queuedSubmissionId !== undefined) {
          if (params.cursor != null) throw new DeliveryError('invalid_params', '单项读取不使用分页游标。');
          const item = await this.findQueued(threadId, string(params.queuedSubmissionId, 'queuedSubmissionId'));
          return { data: [this.queued(item, threadId, params.view === 'summary')], nextCursor: null };
        }
        const page = pageParams(params);
        return this.queuePage(threadId, Number(page.limit), page.cursor, params.view === 'summary');
      }
      case 'thread/queue/handoff/list': {
        onlyKeys(params, ['threadId']);
        const movedSources = this.host.queueHandoffs.movedQueueHandoffSources(threadId);
        return { data: this.host.queueHandoffs.listQueueHandoffs(threadId), ...(movedSources.length ? { movedSources } : {}) };
      }
      case 'thread/queue/handoff/candidates':
        onlyKeys(params, ['threadId', 'handoffId', 'attachmentId']);
        return this.host.queueHandoffs.queueHandoffCandidates(threadId, string(params.handoffId, 'handoffId', 36),
          params.attachmentId !== undefined ? string(params.attachmentId, 'attachmentId', 36) : undefined);
      case 'thread/queue/handoff/save': {
        onlyKeys(params, ['threadId', 'queuedSubmissionId']);
        const id = string(params.queuedSubmissionId, 'queuedSubmissionId');
        const original = await this.findQueued(threadId, id, () => context.beforeWrite?.());
        const metadata = original.responsesapiClientMetadata;
        let provider: string | undefined;
        if (metadata != null && Object.keys(object(metadata)).length) {
          const thread = object(object(await this.host.native('thread/read', { threadId })).thread);
          if (thread.id !== threadId) throw new DeliveryError('thread_changed', '待办所属会话已变化。');
          provider = string(thread.modelProvider, 'modelProvider');
        }
        context.beforeWrite?.();
        return this.host.queueHandoffs.saveQueueHandoff(threadId, id, original.input as JsonValue[], metadata, provider);
      }
      case 'thread/queue/handoff/discard': {
        onlyKeys(params, ['threadId', 'handoffId']);
        const id = string(params.handoffId, 'handoffId');
        context.beforeWrite?.(); this.host.queueHandoffs.discardQueueHandoff(threadId, id);
        return { discarded: true };
      }
      case 'thread/queue/handoff/restore': {
        onlyKeys(params, ['threadId', 'handoffId']);
        const store = this.host.queueHandoffs, id = string(params.handoffId, 'handoffId');
        const operationId = string(context.operationId, 'operationId');
        const input = store.rerouteQueueInput(store.queueHandoffRestoreInput(threadId, id), threadId);
        const p: JsonObject = { threadId, clientUserMessageId: id, input };
        let claimed = false;
        try {
          return await this.host.mutate({
            method: 'thread/queue/add', params: p, schema: 'ThreadQueueAddParams', responseSchema: 'ThreadQueueAddResponse',
            threadId, mode: 'any', history: true, directInput: true,
            preflight: async thread => {
              const metadata = store.queueHandoffMetadata(threadId, id, typeof thread.modelProvider === 'string' ? thread.modelProvider : '');
              if (metadata) p.responsesapiClientMetadata = metadata;
            },
            beforeWrite: () => { store.beginQueueHandoffRestore(threadId, id, operationId); claimed = true; },
            project: result => {
              const queued = object(object(result).queuedSubmission);
              store.settleQueueHandoffRestore(threadId, id, operationId, 'accepted');
              return { queuedSubmission: { id: queued.id!, clientUserMessageId: id } };
            },
          }, context);
        } catch (error) {
          if (claimed && error instanceof DeliveryError && error.delivery === 'not_sent') store.settleQueueHandoffRestore(threadId, id, operationId, 'not_sent');
          throw error;
        }
      }
      case 'thread/queue/delete': {
        onlyKeys(params, ['threadId', 'queuedSubmissionId']);
        const id = string(params.queuedSubmissionId, 'queuedSubmissionId');
        let original: JsonValue[] | undefined, metadata: JsonValue | undefined;
        const store = this.host.queueHandoffs;
        return mutate('ThreadQueueDeleteParams', 'ThreadQueueDeleteResponse', 'any', params, {
          preflight: async () => {
            if (!store.listQueueHandoffs(threadId).some(row => row.queuedSubmissionId === id && row.state === 'saved')) return;
            const row = await this.findQueued(threadId, id); original = row.input as JsonValue[]; metadata = row.responsesapiClientMetadata;
            if (!store.queueHandoffMatches(threadId, id, original, metadata)) throw new DeliveryError('handoff_changed', '待办已修改，请先重存副本或放弃旧副本，再删除当前待办。');
          },
          project: result => {
            if (object(result).deleted === true && original) store.markQueueHandoffRemoved(threadId, id, original, metadata);
            return result;
          },
        });
      }
      case 'thread/queue/reorder': {
        onlyKeys(params, ['threadId', 'queuedSubmissionIds']); if (!Array.isArray(params.queuedSubmissionIds) || params.queuedSubmissionIds.length > 100 || new Set(params.queuedSubmissionIds).size !== params.queuedSubmissionIds.length) throw new DeliveryError('invalid_params', 'Queue order requires at most 100 distinct identifiers');
        return mutate('ThreadQueueReorderParams', 'ThreadQueueReorderResponse', 'any');
      }
      case 'thread/queue/start': {
        onlyKeys(params, ['threadId', 'queuedSubmissionId']); const mediaInput: JsonValue[] = [];
        return mutate('ThreadQueueStartParams', 'ThreadQueueStartResponse', 'idle', params, { history: true, workResult: 'turn', directInput: true, mediaInput, preflight: async () => { const id = params.queuedSubmissionId == null ? undefined : string(params.queuedSubmissionId, 'queuedSubmissionId');
          const summary = await this.largeQueue(threadId);
          if (summary) {
            const row = id ? summary.find(row => row.id === id) : summary[0];
            if (!row) throw new DeliveryError('not_found', '待办已不存在。');
            mediaInput.push(...this.summaryMedia(row, threadId));
          } else mediaInput.push(...(await this.findQueued(threadId, id)).input as JsonValue[]); } });
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
      case 'thread/delete': onlyKeys(params, ['threadId']); return mutate('ThreadDeleteParams', 'ThreadDeleteResponse', 'idle', params, { invalidateHistory: true });
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
        onlyKeys(params, ['threadId', 'turnCursor', 'limit']);
        const cursor = string(params.turnCursor, 'turnCursor', LIMITS.cursorBytes, true);
        const request = pageParams({ threadId, cursor, sortDirection: 'desc', itemsView: 'full',
          ...(params.limit !== undefined ? { limit: params.limit } : {}) });
        const readWindow = async (p: JsonObject) => {
          const page = await this.host.native('thread/turns/list', p, { historyImageDisplayChars: 1_000_000 });
          const result = pageResult('ThreadTurnsListResponse', page, cursor);
          const turns = result.data as JsonValue[];
          this.host.checkHistory(turns);
          return { turns: [...turns].reverse(), nextCursor: result.nextCursor!, backwardsCursor: result.backwardsCursor ?? null, complete: false, partial: true };
        };
        try { return await readWindow(request); }
        catch (error) {
          // The native occurrence cursor is inclusive. Neighbours may exhaust a
          // page budget even when the matched turn can be read on its own.
          if (request.limit === 1 || !(error instanceof DeliveryError) || !['capacity', 'history_frame_capacity'].includes(error.code)) throw error;
          return readWindow({ ...request, limit: 1 });
        }
      }
      case 'thread/export': return this.export(params, context);
      default: throw new DeliveryError('method_not_found', 'Unsupported task workflow');
    }
  }
  private queued(item: JsonObject, threadId: string, summary = false): JsonObject {
    const { retainedInput: _retained, retainedAttachments: _attachments, retainedReferences: _references, retainedExtras: _extras, retainedLegacyContext: _legacy, ...display } = this.host.describeInput(item.input!, threadId, typeof item.id === 'string' ? item.id : undefined);
    const { responsesapiClientMetadata: _private, ...publicItem } = item;
    if (!summary || !Array.isArray(item.input)) return { ...publicItem, ...display };
    // The editor submits text and the original ID. Keep the actual bytes and
    // opaque context at the native owner, including after an edit or refresh.
    const summaryInput = item.input.map(value => {
      const part = object(value);
      if (part.type === 'text') return { type: 'text', text: '', text_elements: [] };
      if (part.type === 'image' || part.type === 'audio') return { type: part.type };
      return part;
    });
    return { ...publicItem, ...display, input: summaryInput };
  }
  private async largeQueue(threadId: string): Promise<JsonObject[] | undefined> {
    const result = await this.host.queueCapacity(threadId);
    if (!result) return;
    if (result.complete !== true || !Array.isArray(result.data) || typeof result.large !== 'boolean') throw new DeliveryError('queue_unverified', '待办的存储状态尚未核实，请重新读取。');
    return result.large ? result.data.map(row => object(row)) : undefined;
  }
  private summaryMedia(row: JsonObject, threadId: string): JsonValue[] {
    if (row.metadataIncomplete === true)
      throw new DeliveryError('queue_reply_capacity', `待办 ${String(row.id)} 超过可安全执行或核对的原生容量。可在消息队列中按编号明确删除此项，再继续会话。`);
    if (!Array.isArray(row.media)) throw new DeliveryError('queue_unverified', '无法核对待办媒体。');
    return this.host.queueHandoffs.queueMediaEvidence(row.media, threadId);
  }
  private async queuePage(threadId: string, limit: number, cursor?: JsonValue, summary = false): Promise<JsonObject> {
    let large = await this.largeQueue(threadId);
    if (!large) {
      if (typeof cursor === 'string' && cursor.startsWith('harness-queue:')) throw new DeliveryError('queue_changed', '队列已变化，请刷新。');
      try {
        const p = { threadId, limit, ...(cursor == null ? {} : { cursor }) };
        validateOfficial('ThreadQueueListParams', p);
        const page = pageResult('ThreadQueueListResponse', await this.host.native('thread/queue/list', p), cursor);
        return { ...page, data: (page.data as JsonValue[]).map(row => this.queued(object(row), threadId, summary)) };
      } catch (error) {
        if (!(error instanceof DeliveryError) || !['queue_frame_capacity', 'capacity'].includes(error.code)) throw error;
        large = await this.largeQueue(threadId);
        if (!large) throw error;
      }
    }
    const found = typeof cursor === 'string' && cursor.startsWith('harness-queue:') ? large.findIndex(row => row.id === cursor.slice(14)) : -1;
    if (cursor != null && found < 0) throw new DeliveryError('queue_changed', '队列分页已变化，请刷新后继续。');
    const offset = found + 1, selected = large.slice(offset, offset + limit);
    return { data: selected.map(row => ({ id: row.id!, clientUserMessageId: row.clientUserMessageId ?? null, text: row.preview ?? '', input: [], metadataOnly: true,
      incomplete: row.metadataIncomplete === true, bytes: row.bytes!, oversized: row.oversized === true, containsMedia: Array.isArray(row.media) && row.media.length > 0 })),
      nextCursor: offset + selected.length < large.length ? 'harness-queue:' + selected.at(-1)!.id : null };
  }
  async hasQueued(threadId: string): Promise<boolean> {
    try {
      const page = pageResult('ThreadQueueListResponse', await this.host.native('thread/queue/list', { threadId, limit: 1 }));
      if ((page.data as JsonValue[]).length > 1) throw new DeliveryError('invalid_native_response', '原生队列分页超过请求条数。');
      return (page.data as JsonValue[]).length > 0 || page.nextCursor != null;
    } catch (error) {
      if (!(error instanceof DeliveryError) || !['queue_frame_capacity', 'capacity'].includes(error.code)) throw error;
      const rows = await this.largeQueue(threadId);
      if (!rows) throw error;
      return rows.length > 0;
    }
  }
  private async findQueued(threadId: string, id?: string, beforeMaterialize?: () => void): Promise<JsonObject> {
    const large = await this.largeQueue(threadId);
    if (large) {
      const row = id ? large.find(row => row.id === id) : large[0];
      if (!row) throw new DeliveryError('not_found', '待办已不存在。');
      const key = string(row.id, 'queuedSubmissionId');
      const result = await this.host.queueItem(threadId, key);
      if (result.queuedSubmission === null) throw new DeliveryError('not_found', '待办已不存在。');
      const item = object(result.queuedSubmission);
      if (item.id !== key || !Array.isArray(item.input)) throw new DeliveryError('queue_changed', '待办已变化，请刷新。');
      const input = await this.host.queueHandoffs.compactQueuedInput(item.input, threadId, key, (slot, marker) => this.host.queueImage(threadId, key, slot, marker), beforeMaterialize);
      return { ...item, input };
    }
    let cursor: JsonValue = null; const seen = new Set<string>();
    for (let count = 0; count < 128; count++) {
      const result = pageResult('ThreadQueueListResponse', await this.host.native('thread/queue/list', { threadId, cursor, limit: 100 }), cursor);
      const match = (result.data as JsonValue[]).map(item => object(item)).find(item => id === undefined || item.id === id); if (match) return match;
      if (result.nextCursor === null) throw new DeliveryError('not_found', '待办已不存在。');
      const next = string(result.nextCursor, 'nextCursor', LIMITS.cursorBytes, true); if (seen.has(next)) throw new DeliveryError('cursor_loop', 'Queue cursor returned to a previous page'); seen.add(next); cursor = next;
    }
    throw new DeliveryError('capacity', 'Queue traversal exceeds page budget');
  }
  async queuedInputs(threadId: string): Promise<JsonValue[]> {
    const types = new Set<string>();
    const remember = (input: JsonValue[]) => {
      for (const item of input) if (mediaModalities([item]).length) types.add(String(object(item).type));
    };
    const large = await this.largeQueue(threadId);
    if (large) {
      for (const row of large) remember(this.summaryMedia(row, threadId));
    } else {
      let cursor: JsonValue = null; const seen = new Set<string>();
      for (let page = 0; ; page++) {
        if (page >= 128) throw new DeliveryError('capacity', 'Queued media validation exceeds its page budget');
        const result = pageResult('ThreadQueueListResponse', await this.host.native('thread/queue/list', { threadId, cursor, limit: 100 }), cursor);
        for (const entry of result.data as JsonValue[]) remember(this.host.queueHandoffs.queueMediaEvidence(object(entry).input as JsonValue[], threadId));
        if (result.nextCursor === null) break;
        const next = string(result.nextCursor, 'nextCursor', LIMITS.cursorBytes); if (seen.has(next)) throw new DeliveryError('cursor_loop', 'Queue cursor repeated'); seen.add(next); cursor = next;
      }
    }
    return [...types].map(type => ({ type }));
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
    const traversal = this.host.historyTraversal(context);
    try { for (let page = 0; ; page++) {
      if (page >= 128) throw new DeliveryError('capacity', 'Export exceeds 128 pages');
      const result = object(await traversal.read({ threadId, cursor, limit: 100, timelineFormat: 'references' })); const batch = result.turns as JsonValue[];
      const canonical = result.timeline as JsonValue[]; size += Buffer.byteLength(jsonBytes({ turns: batch, timeline: canonical })); if (size > LIMITS.historyBytes) throw new DeliveryError('capacity', 'Complete export exceeds 8 MiB'); turns.unshift(...batch); timeline.unshift(...canonical);
      if (result.complete === true) break; cursor = result.nextCursor!;
    } } finally { traversal.close(); }
    // Markdown retains every structured item as JSON, including tool results and
    // approval records; exporting only assistant prose would lose the transcript.
    timeline.sort((a, b) => Number(object(a).position) - Number(object(b).position));
    // Keep the exported document compatible with the native timeline schema.
    // References avoid charging the same stored message twice during traversal.
    const byTurn = new Map(turns.map(value => {
      const turn = object(value);
      return [turn.id, new Map((turn.items as JsonValue[]).map(item => [object(item).id, item]))] as const;
    }));
    for (const [index, value] of timeline.entries()) {
      const entry = object(value);
      if (entry.itemReference !== true) continue;
      const reference = object(entry.item), item = byTurn.get(entry.turnId)?.get(reference.id);
      if (!item || object(item).type !== reference.type) throw new DeliveryError('history_stale', '导出所需的历史消息不完整。');
      const { itemReference: _reference, ...nativeEntry } = entry;
      timeline[index] = { ...nativeEntry, item };
    }
    const generated = (value: JsonValue): boolean => { const item = object(value); return item.type === 'imageGeneration' && (item.generatedMedia !== undefined || item.generatedMediaError !== undefined); };
    const hasGenerated = turns.some(turn => (object(turn).items as JsonValue[]).some(generated)) || timeline.some(value => { const entry = object(value); return entry.type === 'item' && generated(entry.item!); });
    const note = '生成图片以当前会话中的引用保留，导出文件不包含图片字节；需要保留图片时，请在会话中单独下载。';
    const content = params.format === 'json' ? JSON.stringify({ thread: { ...thread, turns }, timeline, ...(hasGenerated ? { media: { generatedImages: 'references-only', note } } : {}) }, null, 2) : `# ${typeof thread.name === 'string' ? thread.name : 'Conversation'}\n\n` + (hasGenerated ? `${note}\n\n` : '') + turns.map(turn => `## Turn ${string(object(turn).id, 'turn id')}\n\n\`\`\`json\n${JSON.stringify(turn, null, 2)}\n\`\`\`\n`).join('\n') + `\n## Canonical timeline (including voice)\n\n\`\`\`json\n${JSON.stringify(timeline, null, 2)}\n\`\`\`\n`;
    jsonBytes(content, LIMITS.historyBytes);
    return { filename: `conversation-${threadId.replace(/[^a-zA-Z0-9_-]/g, '_')}.${params.format === 'json' ? 'json' : 'md'}`, mimeType: params.format === 'json' ? 'application/json' : 'text/markdown', content, ...(hasGenerated ? { warnings: [note] } : {}) };
  }
}
