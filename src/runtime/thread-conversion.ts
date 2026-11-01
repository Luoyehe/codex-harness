import type { NativeConfig, NativeRpc } from './native.js';
import { awaitThreadClosed, historyCompatibility, historyHelper, type ReasoningCompatibility } from './thread-history-compatibility.js';
import { canonical, DeliveryError, object, string, type JsonObject, type JsonValue } from './types.js';
import { validateOfficial } from './validation.js';

export interface ConversionHost {
  reserve(): () => void;
  capture(result: JsonObject): void;
  closed(threadId: string): void;
  publish(result: JsonObject, name: string): void;
  uncertain(threadId?: string): void;
}

/** Native creates the independent ID. Only that new thread is ever converted. */
export async function convertThread(config: NativeConfig, native: NativeRpc, thread: JsonObject, snapshot: JsonObject,
  selection: JsonObject, mode: ReasoningCompatibility, sourceConfig: JsonObject, targetName: string, host: ConversionHost, beforeWrite: () => void): Promise<JsonObject> {
  const sourceThreadId = string(thread.id, 'threadId', 128), sourceProvider = string(snapshot.modelProvider, 'source provider', 128), targetProvider = string(selection.modelProvider, 'target provider', 128);
  if (snapshot.requiresResume === true || thread.cwd !== snapshot.cwd) throw new DeliveryError('session_not_loaded', '请等待原会话加载完成，再创建转换会话。');
  if (thread.ephemeral === true || !thread.path) throw new DeliveryError('history_conversion_unsupported', '此会话没有可独立复制的持久历史。');
  const needsRepair = await historyCompatibility(config, thread, mode);
  if (mode === 'plaintext' && !needsRepair) throw new DeliveryError('provider_unchanged', '同一供应商请直接在模型菜单中选择模型；无需转换会话。');
  const input: JsonObject = { threadId: sourceThreadId, path: thread.path, mode };
  // Reject unsupported source formats before even unloading the original.
  await historyHelper(config, { ...input, action: 'copy-inspect' });
  const release = host.reserve(), deadline = Date.now() + 240000;
  let wrote = false, targetId: string | undefined;
  const check = (): void => { beforeWrite(); if (Date.now() >= deadline) throw new DeliveryError('history_conversion_timeout', '转换超过时间上限，请查询原操作状态。'); };
  const write = async (method: string, params: JsonObject, schema: string): Promise<JsonObject> => {
    const value = await native.call(method, params, { timeoutMs: Math.max(1, deadline - Date.now()), beforeWrite: () => { check(); wrote = true; } });
    wrote = true; const result = object(value);
    validateOfficial(schema, result); return result;
  };
  const close = async (id: string): Promise<void> => {
    const closed = awaitThreadClosed(native, id);
    try { await write('thread/unsubscribe', { threadId: id }, 'ThreadUnsubscribeResponse'); await closed.wait; host.closed(id); }
    finally { closed.cancel(); }
  };
  try {
    await close(sourceThreadId);
    // Native close can flush metadata. This witness is never rebound later.
    const inspected = await historyHelper(config, { ...input, action: 'copy-inspect' }), expected = object(inspected.expected), metadata = object(inspected.sourceMetadata);
    const title = Array.from(typeof thread.name === 'string' && thread.name || typeof thread.preview === 'string' && thread.preview || '会话').slice(0, 48).join('');
    const note = `转换至 ${Array.from(targetName).slice(0, 32).join('')} · ${new Date().toISOString()}`;
    const start: JsonObject = { historyMode: 'paginated', ephemeral: false, modelProvider: sourceProvider, model: snapshot.model!, cwd: snapshot.cwd!,
      approvalPolicy: snapshot.approvalPolicy!, approvalsReviewer: snapshot.approvalsReviewer!, runtimeWorkspaceRoots: snapshot.runtimeWorkspaceRoots!,
      config: { ...sourceConfig, ...(snapshot.reasoningEffort != null ? { model_reasoning_effort: snapshot.reasoningEffort } : {}) },
      ...(thread.projectId != null ? { projectId: thread.projectId } : {}), ...(thread.environments != null ? { environments: thread.environments } : {}), ...metadata };
    delete start.summary;
    if (snapshot.activePermissionProfile != null) start.permissions = object(snapshot.activePermissionProfile).id!;
    else {
      const sandbox = ({ readOnly: 'read-only', workspaceWrite: 'workspace-write', dangerFullAccess: 'danger-full-access' } as Record<string, string>)[String(object(snapshot.sandbox).type)];
      if (!sandbox) throw new DeliveryError('history_conversion_unsupported', '此执行权限不能安全复制为独立会话。'); start.sandbox = sandbox;
    }
    validateOfficial('ThreadStartParams', start);
    const created = await write('thread/start', start, 'ThreadStartResponse'), target = object(created.thread);
    const candidateId = string(target.id, 'new threadId', 128);
    if (candidateId === sourceThreadId) throw new Error('Native conversion reused source identity');
    targetId = candidateId;
    const sameLocation = (value: JsonObject): boolean => value.cwd === snapshot.cwd && canonical(value.projectId ?? null) === canonical(thread.projectId ?? null) && canonical(value.environments ?? null) === canonical(thread.environments ?? null);
    if (!sameLocation(target) || created.modelProvider !== sourceProvider || target.historyMode !== 'paginated') throw new Error('Native conversion target identity mismatch');
    host.capture(created);
    await write('thread/name/set', { threadId: targetId, name: `转换未完成 · ${title} · ${note}` }, 'ThreadSetNameResponse');
    const empty = object(await native.call('thread/read', { threadId: targetId, includeTurns: true })); validateOfficial('ThreadReadResponse', empty);
    if (object(empty.thread).id !== targetId || !Array.isArray(object(empty.thread).turns) || (object(empty.thread).turns as JsonValue[]).length) throw new Error('Conversion target is not empty');
    await close(targetId);
    const targetInput: JsonObject = { threadId: targetId, path: string(target.path, 'new rollout path'), mode };
    const emptyWitness = await historyHelper(config, { ...targetInput, action: 'inspect' });
    const copied = await historyHelper(config, { ...input, action: 'recovery-copy', expected, sourceProvider, cwd: snapshot.cwd!,
      target: { threadId: targetId, path: targetInput.path!, expected: emptyWitness.expected! } }, true, check);
    if (copied.copied !== true || copied.sourcePreserved !== true || canonical(object(copied.expected)) !== canonical(expected) || object(copied.target).threadId !== targetId) throw new Error('Unconfirmed independent copy');
    const repaired = await historyHelper(config, { ...targetInput, action: 'repair', expected: object(copied.target).expected! }, true, check);
    if (repaired.needsRepair !== false) throw new Error('New thread conversion was not confirmed');
    const resumed = await write('thread/resume', { threadId: targetId, excludeTurns: true, ...selection }, 'ThreadResumeResponse'); host.capture(resumed);
    if (resumed.modelProvider !== targetProvider || resumed.model !== selection.model || object(resumed.thread).id !== targetId || resumed.cwd !== snapshot.cwd || !sameLocation(object(resumed.thread))) throw new Error('Converted provider, model or environment mismatch');
    const effort = resumed.reasoningEffort ?? null;
    const collaboration = object(snapshot.collaborationMode), oldMode = object(collaboration.settings);
    const desired: JsonObject = { threadId: targetId, model: selection.model!, cwd: snapshot.cwd!, approvalPolicy: snapshot.approvalPolicy!, approvalsReviewer: snapshot.approvalsReviewer!,
      serviceTier: Object.hasOwn(metadata, 'serviceTier') ? metadata.serviceTier! : snapshot.serviceTier ?? null, effort,
      summary: Object.hasOwn(snapshot, 'summary') ? snapshot.summary! : metadata.summary ?? null,
      collaborationMode: { ...collaboration, settings: { ...oldMode, model: selection.model!, reasoning_effort: effort } }, disabledPluginIds: snapshot.disabledPluginIds! };
    const update = { ...desired };
    if (update.serviceTier === null && resumed.serviceTier == null) delete update.serviceTier;
    if (update.summary === null) delete update.summary;
    const currentMode = object(resumed.collaborationMode), wantedMode = object(desired.collaborationMode);
    if (currentMode.mode === wantedMode.mode && object(currentMode.settings).model === object(wantedMode.settings).model && canonical(object(currentMode.settings).developer_instructions ?? null) === canonical(object(wantedMode.settings).developer_instructions ?? null)) delete update.collaborationMode;
    if (snapshot.activePermissionProfile != null) update.permissions = object(snapshot.activePermissionProfile).id!; else update.sandboxPolicy = snapshot.sandbox!;
    validateOfficial('ThreadSettingsUpdateParams', update);
    let resolveSettings!: (settings: JsonObject) => void; let timer: NodeJS.Timeout | undefined;
    const settings = new Promise<JsonObject>((resolve, reject) => { resolveSettings = resolve; timer = setTimeout(() => reject(new Error('Converted settings notification timed out')), Math.min(15000, Math.max(1, deadline - Date.now()))); }); void settings.catch(() => {});
    const listener = (event: JsonObject): void => {
      if (event.method !== 'thread/settings/updated' || object(event.params).threadId !== targetId) return;
      const value = object(object(event.params).threadSettings);
      if (Object.keys(desired).filter(key => key !== 'threadId').every(key => canonical(value[key] ?? null) === canonical(desired[key] ?? null))) resolveSettings(value);
    };
    native.on('notification', listener);
    try {
      await write('thread/settings/update', update, 'ThreadSettingsUpdateResponse'); const observed = await settings; validateOfficial('ThreadSettings', observed);
      if (observed.modelProvider !== targetProvider || canonical(observed.sandboxPolicy!) !== canonical(snapshot.sandbox!) || canonical(observed.activePermissionProfile!) !== canonical(snapshot.activePermissionProfile ?? null)) throw new Error('Converted permissions mismatch');
    } finally { if (timer) clearTimeout(timer); native.off('notification', listener); }
    await close(targetId);
    const saved = await historyHelper(config, { ...targetInput, action: 'copy-inspect' });
    for (const key of ['serviceTier', 'summary']) if (canonical(object(saved.sourceMetadata)[key] ?? null) !== canonical(desired[key] ?? null)) throw new Error('Converted saved settings mismatch');
    const verified = await write('thread/resume', { threadId: targetId, excludeTurns: true }, 'ThreadResumeResponse');
    if (object(verified.thread).id !== targetId || !sameLocation(object(verified.thread))) throw new Error('Converted persisted identity mismatch');
    const expectedSettings: JsonObject = { ...snapshot, modelProvider: targetProvider, model: selection.model!, reasoningEffort: effort, collaborationMode: desired.collaborationMode! };
    for (const key of ['model', 'modelProvider', 'cwd', 'approvalPolicy', 'approvalsReviewer', 'sandbox', 'activePermissionProfile', 'collaborationMode', 'disabledPluginIds', 'reasoningEffort', 'runtimeWorkspaceRoots']) if (canonical(verified[key] ?? null) !== canonical(expectedSettings[key] ?? null)) throw new Error('Converted persisted settings mismatch: ' + key);
    // The independent copy and its bytes were already verified above. Check
    // native indexing without collecting a multi-image turn into one frame.
    const page = object(await native.call('thread/turns/list', { threadId: targetId, limit: 1, itemsView: 'notLoaded' })); validateOfficial('ThreadTurnsListResponse', page);
    if ((page.data as JsonValue[]).length > 1 || (page.data as JsonValue[]).some(value => object(value).itemsView !== 'notLoaded' || (object(value).items as JsonValue[]).length !== 0)) throw new Error('Converted history metadata view mismatch');
    const name = `[已转换至 ${Array.from(targetName).slice(0, 32).join('')}] ${title} · ${new Date().toISOString()}`;
    await write('thread/name/set', { threadId: targetId, name }, 'ThreadSetNameResponse');
    const result = { ...verified, thread: { ...object(verified.thread), name } }; host.publish(result, name);
    return { thread: result.thread, sourceThreadId, sourceProvider, targetProvider };
  } catch (error) {
    if (!wrote && error instanceof DeliveryError && error.delivery === 'not_sent') throw error;
    // Local bookkeeping must never erase a positive native acknowledgement.
    try { host.uncertain(targetId); } catch { /* The original outcome remains unknown. */ }
    const failure = new DeliveryError(error instanceof DeliveryError ? error.code : 'history_conversion_unconfirmed', '转换新会话尚未完整确认；原会话未转换，也没有发送消息。请查询原操作状态。', 'unknown',
      { inputSent: false, ...(targetId ? { phase: 'conversion', threadId: targetId, sourceThreadId } : {}) }); failure.cause = error; throw failure;
  } finally { release(); }
}
