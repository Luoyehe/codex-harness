import { afterEach, expect, test } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { RuntimeService } from '../../src/runtime/service.js';
import type { NativeRpc, NativeOptions } from '../../src/runtime/native.js';
import { DeliveryError, object, type JsonObject, type JsonValue } from '../../src/runtime/types.js';

const roots = path.resolve('.work/workflow-tests'); mkdirSync(roots, { recursive: true });
const turn = (id = 'u', status = 'completed'): JsonObject => ({ id, rootTurnId: null, items: [], itemsView: 'full', status, error: null, startedAt: null, completedAt: null, durationMs: null });
function thread(id: string, cwd: string, active = false): JsonObject {
  return { id, environments: null, extra: null, sessionId: id, forkedFromId: null, parentThreadId: null, preview: '', ephemeral: false, section: null, sectionEnteredAt: null, projectId: null, historyMode: 'paginated', modelProvider: 'fixture', model: 'fixture', reasoningEffort: null, createdAt: 1, updatedAt: 1, recencyAt: null, status: active ? { type: 'active', activeFlags: [] } : { type: 'idle' }, path: null, cwd, cliVersion: '0.164.0', originator: null, source: 'appServer', canAcceptDirectInput: true, threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: null, daybreakEnabled: null, turns: [] };
}
class Native extends EventEmitter {
  connected = true; budget = { pending: 0, retainedBytes: 0 }; calls: { method: string; params: JsonObject }[] = []; queue: JsonObject[] = []; active = false; directInput = true;
  gate?: Promise<void>; hook?: (method: string) => void; error?: DeliveryError; responseOverride?: { method: string; value: JsonValue }; history = [turn()];
  afterWrite?: (method: string) => void | Promise<void>;
  constructor(readonly cwd: string) { super(); }
  async call(method: string, input: JsonValue, options: NativeOptions = {}): Promise<JsonValue> {
    const p = object(input ?? {}); if (method === 'thread/read') await this.gate; this.hook?.(method); options.beforeWrite?.(); this.calls.push({ method, params: p });
    if (this.afterWrite) await this.afterWrite(method);
    if (this.error && method !== 'thread/read') throw this.error;
    if (this.responseOverride?.method === method) return this.responseOverride.value;
    if (method === 'thread/read') return { thread: { ...thread(String(p.threadId), this.cwd, this.active), canAcceptDirectInput: this.directInput }, readState: null };
    if (method === 'thread/start') return { thread: thread('new', this.cwd) };
    if (method === 'thread/turns/list') return { data: this.history, nextCursor: null, backwardsCursor: null };
    if (method === 'thread/timeline/list') return { data: [], nextCursor: null, activeRealtimeSessionAtPageStart: null };
    if (method === 'model/list') return { data: [{ id: 'fixture', model: 'fixture', inputModalities: ['text', 'image', 'audio'] }], nextCursor: null };
    if (method === 'account/read') return { account: null, requiresOpenaiAuth: false };
    if (method === 'turn/steer') return { turnId: p.expectedTurnId! };
    if (method === 'turn/start' || method === 'thread/queue/start') return { turn: turn('new-turn', 'inProgress') };
    if (method === 'review/start') return { turn: turn('review', 'inProgress'), reviewThreadId: p.threadId! };
    if (method === 'thread/queue/list') return { data: this.queue, nextCursor: null };
    if (method === 'thread/queue/add') { const queued = { id: `q${this.queue.length}`, input: p.input!, clientUserMessageId: p.clientUserMessageId! }; this.queue.push(queued); return { queuedSubmission: queued }; }
    if (method === 'thread/queue/update') { const queued = this.queue.find(item => item.id === p.queuedSubmissionId)!; queued.input = p.input!; return { queuedSubmission: queued }; }
    if (method === 'thread/queue/delete') { this.queue = this.queue.filter(item => item.id !== p.queuedSubmissionId); return { deleted: true }; }
    if (method === 'thread/goal/set') return { goal: { threadId: p.threadId!, objective: p.objective ?? 'existing', status: p.status ?? 'active', tokenBudget: p.tokenBudget ?? null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } };
    if (method === 'thread/goal/get') return { goal: null };
    if (method === 'thread/goal/clear') return { cleared: true };
    if (method === 'thread/revert') return { thread: thread(String(p.threadId), this.cwd), turnsBackwardsCursor: null, itemsBackwardsCursor: null };
    if (method === 'thread/fork') return { thread: { ...thread('fork', this.cwd), forkedFromId: p.threadId! }, model: 'fixture', modelProvider: 'fixture', serviceTier: null, disabledPluginIds: [], cwd: this.cwd, runtimeWorkspaceRoots: [], instructionSources: [], approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'dangerFullAccess' }, activePermissionProfile: null, reasoningEffort: null, multiAgentMode: 'explicitRequestOnly' };
    if (method === 'turn/settings/update') return { status: 'applied' };
    if (method === 'thread/unsubscribe') return { status: 'unsubscribed' };
    return {};
  }
  async close() { this.connected = false; }
}
const services: RuntimeService[] = []; const context = { clientId: 'a', eventChannelId: 'one' };
function setup() {
  const cwd = mkdtempSync(path.join(roots, 'home-')); const native = new Native(cwd); const service = new RuntimeService({ bin: process.execPath, home: cwd, workerHome: cwd, cwd, env: {} }, native as unknown as NativeRpc); services.push(service); return { cwd, native, service };
}
afterEach(async () => { await Promise.all(services.splice(0).map(item => item.close())); });
const hydrate = (service: RuntimeService, threadId = 't') => service.call('thread/history', { threadId }, context);
const goal = (status = 'active'): JsonObject => ({ threadId: 't', objective: 'keep working', status, tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 2 });
const activeThreads = (service: RuntimeService): JsonValue => object(object(service.status()).activity).activeThreads!;

test('queue text edits preserve durable attachments across runtime recreation and explicit [] clears input', async () => {
  const { service, native, cwd } = setup(); const upload = object(await service.call('attachment/upload', { name: 'picture.png', mimeType: 'image/png', base64: 'YQ==' }, context));
  await hydrate(service);
  const first = object(object(await service.call('thread/queue/add', { threadId: 't', text: 'original', attachmentIds: [upload.attachmentId!], clientUserMessageId: 'client-id' }, context)).queuedSubmission);
  expect(first).toMatchObject({ id: 'q0', text: 'original', attachmentIds: [upload.attachmentId], hasOpaqueInput: false });
  await service.close(); const replacement = new RuntimeService({ bin: process.execPath, home: cwd, workerHome: cwd, cwd, env: {} }, Object.assign(native, { connected: true }) as unknown as NativeRpc); services.push(replacement);
  await hydrate(replacement);
  const updated = object(object(await replacement.call('thread/queue/update', { threadId: 't', queuedSubmissionId: 'q0', text: 'edited' }, context)).queuedSubmission);
  expect(updated).toMatchObject({ text: 'edited', attachmentIds: [upload.attachmentId] }); expect(updated.input).toHaveLength(2);
  const cleared = object(object(await replacement.call('thread/queue/update', { threadId: 't', queuedSubmissionId: 'q0', text: 'text only', attachmentIds: [] }, context)).queuedSubmission);
  expect(cleared.input).toHaveLength(1); await replacement.call('thread/queue/delete', { threadId: 't', queuedSubmissionId: 'q0' }, context);
  await expect(replacement.call('attachment/remove', { attachmentId: upload.attachmentId! }, context)).rejects.toMatchObject({ code: 'attachment_in_use' });
});
test('context-only conversations send untrusted context and output schema only to the actual turn', async () => {
  const { service, native, cwd } = setup(); const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false };
  await service.call('conversation/start', { cwd, extraContext: [{ label: 'Selected evidence', text: 'Untrusted body.' }], options: { outputSchema: schema } }, context);
  expect(native.calls.find(call => call.method === 'thread/start')!.params).not.toHaveProperty('outputSchema'); const sent = native.calls.find(call => call.method === 'turn/start')!.params;
  expect(sent.outputSchema).toEqual(schema); expect(Object.values(object(sent.additionalContext))).toEqual([expect.objectContaining({ kind: 'untrusted', value: expect.stringContaining('Untrusted body.') })]);
});
test('queue text and attachment edits preserve opaque context until references are explicitly cleared', async () => {
  const { service, native } = setup(); await hydrate(service); const uploaded = object(await service.call('attachment/upload', { name: 'note.txt', base64: 'YQ==' }, context));
  const added = object(object(await service.call('thread/queue/add', { threadId: 't', text: 'Main message', attachmentIds: [uploaded.attachmentId!], extraContext: [{ label: 'Evidence', text: 'Opaque retained context' }], clientUserMessageId: 'context-id' }, context)).queuedSubmission);
  expect(added.text).toBe('Main message'); expect(added.hasOpaqueInput).toBe(true); expect(added.input).toHaveLength(3);
  const edited = object(object(await service.call('thread/queue/update', { threadId: 't', queuedSubmissionId: added.id!, text: 'Edited', attachmentIds: [] }, context)).queuedSubmission);
  expect(edited.text).toBe('Edited'); expect(edited.input).toHaveLength(2); expect(JSON.stringify(edited.input)).toContain('Opaque retained context');
  const cleared = object(object(await service.call('thread/queue/update', { threadId: 't', queuedSubmissionId: added.id!, text: 'Final', references: [] }, context)).queuedSubmission); expect(cleared.input).toHaveLength(1); expect(cleared.hasOpaqueInput).toBe(false);
  native.active = true; native.emit('notification', { method: 'turn/started', params: { threadId: 't', turn: turn('active', 'inProgress') } });
  await service.call('turn/steer', { threadId: 't', expectedTurnId: 'active', extraContext: [{ label: 'Steer evidence', text: 'Context-only steering' }] }, context);
  expect(JSON.stringify(native.calls.find(call => call.method === 'turn/steer')!.params.input)).toContain('harness-context:');
});
test('queue work requires complete owner history and rejects an active event at final write', async () => {
  const { service, native } = setup(); await expect(service.call('thread/queue/start', { threadId: 't' }, context)).rejects.toMatchObject({ code: 'history_incomplete' });
  await hydrate(service); await expect(service.call('thread/queue/start', { threadId: 't' }, { ...context, clientId: 'b' })).rejects.toMatchObject({ code: 'history_incomplete' });
  native.queue = [{ id: 'head', clientUserMessageId: 'head', input: [{ type: 'text', text: 'queued', text_elements: [] }] }];
  native.hook = method => { if (method === 'thread/queue/start') native.emit('notification', { method: 'turn/started', params: { threadId: 't', turn: turn('racing', 'inProgress') } }); };
  await expect(service.call('thread/queue/start', { threadId: 't' }, context)).rejects.toMatchObject({ code: 'thread_busy', delivery: 'not_sent' }); expect(native.calls.some(item => item.method === 'thread/queue/start')).toBe(false);
});

test('audio queue edits preserve native media and reject unknown or unsupported model evidence before dispatch', async () => {
  const { service, native } = setup(); await hydrate(service); const attachmentId = object(await service.call('attachment/upload', { name: 'clip.wav', mimeType: 'audio/wav', base64: 'YQ==' }, context)).attachmentId!;
  const row = object(object(await service.call('thread/queue/add', { threadId: 't', attachmentIds: [attachmentId], clientUserMessageId: 'media' }, context)).queuedSubmission); expect(object((row.input as JsonValue[])[1]).type).toBe('localAudio');
  native.responseOverride = { method: 'model/list', value: { data: [{ id: 'fixture', model: 'fixture', inputModalities: ['text'] }], nextCursor: null } };
  await expect(service.call('thread/queue/update', { threadId: 't', queuedSubmissionId: row.id!, text: 'keep audio' }, context)).rejects.toMatchObject({ code: 'model_modality_unsupported' });
  await expect(service.call('thread/settings/update', { threadId: 't', model: 'fixture' }, context)).rejects.toMatchObject({ code: 'model_modality_unsupported' });
  expect(native.calls.some(call => call.method === 'thread/queue/update' || call.method === 'thread/settings/update')).toBe(false);
  await expect(service.call('thread/queue/start', { threadId: 't' }, context)).rejects.toMatchObject({ code: 'model_modality_unsupported' });
  native.responseOverride = undefined; const edited = object(object(await service.call('thread/queue/update', { threadId: 't', queuedSubmissionId: row.id!, text: 'keep audio' }, context)).queuedSubmission); expect(edited.attachmentIds).toEqual([attachmentId]); expect(edited.hasOpaqueInput).toBe(false);
});

test('steer media requires a known current-turn model and honors applied live model overrides', async () => {
  const { service, native } = setup(); await hydrate(service); const attachmentId = object(await service.call('attachment/upload', { name: 'clip.wav', mimeType: 'audio/wav', base64: 'YQ==' }, context)).attachmentId!;
  native.active = true; native.emit('notification', { method: 'turn/started', params: { threadId: 't', turn: turn('active', 'inProgress') } });
  await expect(service.call('turn/steer', { threadId: 't', expectedTurnId: 'active', attachmentIds: [attachmentId] }, context)).rejects.toMatchObject({ code: 'model_capability_unknown' });
  await service.call('turn/settings/update', { threadId: 't', turnId: 'active', model: 'fixture' }, context); await service.call('turn/steer', { threadId: 't', expectedTurnId: 'active', attachmentIds: [attachmentId] }, context);
  await service.call('turn/settings/update', { threadId: 't', turnId: 'active', model: 'unknown-model' }, context);
  await expect(service.call('turn/steer', { threadId: 't', expectedTurnId: 'active', attachmentIds: [attachmentId] }, context)).rejects.toMatchObject({ code: 'model_capability_unknown' });
  expect(native.calls.filter(call => call.method === 'turn/steer')).toHaveLength(1);
});

test.each(['before', 'after'] as const)('live model updates respect reroutes received %s the write boundary', async when => {
  const { service, native } = setup(); await hydrate(service);
  const attachmentId = object(await service.call('attachment/upload', { name: 'clip.wav', mimeType: 'audio/wav', base64: 'YQ==' }, context)).attachmentId!;
  native.active = true; native.emit('notification', { method: 'turn/started', params: { threadId: 't', turn: turn('active', 'inProgress') } });
  native.responseOverride = { method: 'model/list', value: { data: [{ id: 'fixture', model: 'fixture', inputModalities: ['text', 'audio'] }, { id: 'text-only', model: 'text-only', inputModalities: ['text'] }], nextCursor: null } };
  const reroute = (method: string): void => { if (method === 'turn/settings/update') native.emit('notification', { method: 'model/rerouted', params: { threadId: 't', turnId: 'active', fromModel: 'fixture', toModel: 'text-only', reason: 'highRiskCyberActivity' } }); };
  if (when === 'before') native.hook = reroute; else native.afterWrite = reroute;
  await service.call('turn/settings/update', { threadId: 't', turnId: 'active', model: 'fixture' }, context);
  const steer = () => service.call('turn/steer', { threadId: 't', expectedTurnId: 'active', attachmentIds: [attachmentId] }, context);
  if (when === 'before') await expect(steer()).resolves.toEqual({ turnId: 'active' });
  else { await expect(steer()).rejects.toMatchObject({ code: 'model_modality_unsupported' }); expect(native.calls.some(call => call.method === 'turn/steer')).toBe(false); }
  native.hook = undefined; native.afterWrite = undefined;
  await service.call('turn/settings/update', { threadId: 't', turnId: 'active', model: 'fixture' }, context);
  await expect(steer()).resolves.toEqual({ turnId: 'active' });
});

test('a live settings response cannot restore the model of a completed or replaced turn', async () => {
  const { service, native } = setup(); await hydrate(service);
  const attachmentId = object(await service.call('attachment/upload', { name: 'clip.wav', mimeType: 'audio/wav', base64: 'YQ==' }, context)).attachmentId!;
  native.active = true; native.emit('notification', { method: 'turn/started', params: { threadId: 't', turn: turn('active', 'inProgress') } });
  native.afterWrite = method => { if (method === 'turn/settings/update') {
    native.emit('notification', { method: 'turn/completed', params: { threadId: 't', turn: turn('active') } });
    native.emit('notification', { method: 'turn/started', params: { threadId: 't', turn: turn('replacement', 'inProgress') } });
  } };
  await service.call('turn/settings/update', { threadId: 't', turnId: 'active', model: 'fixture' }, context);
  await expect(service.call('turn/steer', { threadId: 't', expectedTurnId: 'replacement', attachmentIds: [attachmentId] }, context)).rejects.toMatchObject({ code: 'model_capability_unknown' });
  expect(native.calls.some(call => call.method === 'turn/steer')).toBe(false);
});

test('ordinary output notifications do not discard applied live model settings', async () => {
  const { service, native } = setup(); await hydrate(service);
  const attachmentId = object(await service.call('attachment/upload', { name: 'clip.wav', mimeType: 'audio/wav', base64: 'YQ==' }, context)).attachmentId!;
  native.active = true; native.emit('notification', { method: 'turn/started', params: { threadId: 't', turn: turn('active', 'inProgress') } });
  native.afterWrite = method => { if (method === 'turn/settings/update') native.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 't', turnId: 'active', itemId: 'message', delta: 'output' } }); };
  await service.call('turn/settings/update', { threadId: 't', turnId: 'active', model: 'fixture' }, context);
  await expect(service.call('turn/steer', { threadId: 't', expectedTurnId: 'active', attachmentIds: [attachmentId] }, context)).resolves.toEqual({ turnId: 'active' });
});

test.each(['turn/start', 'thread/queue/add'])('%s rejects a model-change notification between media discovery and final write', async method => {
  const { service, native, cwd } = setup(); await hydrate(service); const attachmentId = object(await service.call('attachment/upload', { name: 'clip.wav', mimeType: 'audio/wav', base64: 'YQ==' }, context)).attachmentId!;
  native.hook = name => { if (name === 'model/list') native.emit('notification', { method: 'thread/settings/updated', params: { threadId: 't', threadSettings: { disabledPluginIds: [], cwd, approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' }, activePermissionProfile: null, model: 'changed', modelProvider: 'fixture', serviceTier: null, effort: null, summary: null, collaborationMode: { mode: 'default', settings: { model: 'changed', reasoning_effort: null, developer_instructions: null } }, multiAgentMode: 'explicitRequestOnly', personality: null } } }); };
  await expect(service.call(method, { threadId: 't', attachmentIds: [attachmentId], ...(method === 'thread/queue/add' ? { clientUserMessageId: 'race' } : {}) }, context)).rejects.toMatchObject({ code: 'model_changed', delivery: 'not_sent' });
  expect(native.calls.some(call => call.method === method)).toBe(false); await expect(service.call('attachment/remove', { attachmentId }, context)).resolves.toEqual({});
});
test('steer matches an active turn and rechecks owner; unknown output retains attachment references', async () => {
  const { service, native } = setup(); native.active = true; native.emit('notification', { method: 'turn/started', params: { threadId: 't', turn: turn('active', 'inProgress') } });
  const upload = object(await service.call('attachment/upload', { name: 'steer.txt', base64: 'YQ==' }, context));
  await expect(service.call('turn/steer', { threadId: 't', expectedTurnId: 'stale', text: 'no' }, context)).rejects.toMatchObject({ code: 'turn_changed' });
  await expect(service.call('turn/steer', { threadId: 't', expectedTurnId: 'active', text: 'no', attachmentIds: [upload.attachmentId!] }, { ...context, beforeWrite: () => { throw new DeliveryError('client_disconnected', 'revoked'); } })).rejects.toMatchObject({ code: 'client_disconnected' });
  native.responseOverride = { method: 'turn/steer', value: { turnId: 'wrong' } };
  await expect(service.call('turn/steer', { threadId: 't', expectedTurnId: 'active', text: 'yes', attachmentIds: [upload.attachmentId!] }, context)).rejects.toMatchObject({ delivery: 'unknown' });
  await expect(service.call('attachment/remove', { attachmentId: upload.attachmentId! }, context)).rejects.toMatchObject({ code: 'attachment_in_use' }); expect(object(object(service.status()).activity).unknown).toBe(true);
});
test('goals require user provenance, preserve null versus omission, and pause active work without replay', async () => {
  const { service, native } = setup(); native.active = true;
  await expect(service.call('thread/goal/set', { threadId: 't', objective: 'new goal', origin: 'automatic' }, context)).rejects.toMatchObject({ delivery: 'not_sent' });
  await expect(service.call('thread/goal/set', { threadId: 't', objective: 'new goal' }, context)).rejects.toMatchObject({ code: 'history_incomplete' });
  await service.call('thread/goal/set', { threadId: 't', status: 'paused', tokenBudget: null }, context); expect(native.calls.at(-1)!.params).toEqual({ threadId: 't', status: 'paused', tokenBudget: null, origin: 'user' });
  await service.call('thread/goal/clear', { threadId: 't' }, context); expect(native.calls.at(-1)!.params).toEqual({ threadId: 't', origin: 'user' });
});

test.each(['complete', 'paused', 'cleared', 'closed'] as const)('late active goal responses preserve newer %s evidence', async status => {
  const { service, native } = setup(); await hydrate(service);
  native.afterWrite = method => { if (method === 'thread/goal/set') native.emit('notification', status === 'closed'
    ? { method: 'thread/closed', params: { threadId: 't' } }
    : status === 'cleared' ? { method: 'thread/goal/cleared', params: { threadId: 't' } }
    : { method: 'thread/goal/updated', params: { threadId: 't', turnId: null, goal: goal(status) } }); };
  await service.call('thread/goal/set', { threadId: 't', objective: 'keep working' }, context);
  expect(activeThreads(service)).not.toContain('t');
  native.responseOverride = { method: 'remoteControl/status/read', value: { status: 'disabled', serverName: 'fixture', installationId: 'fixture', environmentId: null } };
  await expect(service.call('runtime/maintenance/check', {}, context)).resolves.toMatchObject({ idle: true });
});

test.each(['thread/goal/set', 'thread/goal/clear'])('late %s responses cannot hide a newly active goal', async method => {
  const { service, native } = setup(); await hydrate(service);
  native.afterWrite = sent => { if (sent === method) native.emit('notification', { method: 'thread/goal/updated', params: { threadId: 't', turnId: null, goal: goal() } }); };
  await service.call(method, { threadId: 't', ...(method === 'thread/goal/set' ? { status: 'paused' } : {}) }, context);
  expect(activeThreads(service)).toContain('t');
  await expect(service.call('runtime/maintenance/check', {}, context)).rejects.toMatchObject({ code: 'activity_busy' });
});

test('goal write versions preserve ordinary replies and reject simultaneous mutations', async () => {
  const { service, native } = setup(); await hydrate(service);
  const written = Promise.withResolvers<void>(), reply = Promise.withResolvers<void>();
  native.afterWrite = async method => { if (method === 'thread/goal/set') {
    native.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 't', turnId: 'active', itemId: 'message', delta: 'output' } });
    written.resolve(); await reply.promise;
  } };
  const setting = service.call('thread/goal/set', { threadId: 't', objective: 'keep working' }, context); await written.promise;
  await expect(service.call('thread/goal/clear', { threadId: 't' }, context)).rejects.toMatchObject({ code: 'thread_busy' });
  reply.resolve(); await setting;
  expect(activeThreads(service)).toContain('t');
  await expect(service.call('runtime/maintenance/check', {}, context)).rejects.toMatchObject({ code: 'activity_busy' });
  await service.call('thread/goal/clear', { threadId: 't' }, context); expect(activeThreads(service)).not.toContain('t');
});

test.each(['before', 'during'] as const)('continuation reads begun %s a goal write cannot overwrite its accepted result', async when => {
  const { service, native } = setup(); await hydrate(service);
  const readStarted = Promise.withResolvers<void>(), readReply = Promise.withResolvers<void>();
  const writeStarted = Promise.withResolvers<void>(), writeReply = Promise.withResolvers<void>();
  let firstRead = true;
  native.afterWrite = async method => {
    if (method === 'thread/queue/list' && firstRead) { firstRead = false; readStarted.resolve(); if (when === 'before') await readReply.promise; }
    if (method === 'thread/goal/set' && when === 'during') { writeStarted.resolve(); await writeReply.promise; }
  };
  if (when === 'before') {
    native.emit('notification', { method: 'thread/queue/changed', params: { threadId: 't' } }); await readStarted.promise;
    await service.call('thread/goal/set', { threadId: 't', objective: 'keep working' }, context);
    native.responseOverride = { method: 'thread/goal/get', value: { goal: goal() } }; readReply.resolve();
    await expect.poll(() => native.calls.filter(call => call.method === 'thread/goal/get').length).toBe(2);
  } else {
    const setting = service.call('thread/goal/set', { threadId: 't', objective: 'keep working' }, context); await writeStarted.promise;
    native.emit('notification', { method: 'thread/queue/changed', params: { threadId: 't' } }); await readStarted.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    writeReply.resolve(); await setting;
  }
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(activeThreads(service)).toContain('t');
  await expect(service.call('runtime/maintenance/check', {}, context)).rejects.toMatchObject({ code: 'activity_busy' });
  await service.call('thread/goal/clear', { threadId: 't' }, context); expect(activeThreads(service)).not.toContain('t');
});
test('fork retains source project and goal deferral; child and reverted history need new complete proofs', async () => {
  const { service, native } = setup(); await hydrate(service); const forked = object(await service.call('thread/fork', { threadId: 't', beforeTurnId: 'u' }, context)); expect(object(forked.thread).id).toBe('fork');
  expect(native.calls.find(item => item.method === 'thread/fork')!.params).toEqual({ threadId: 't', beforeTurnId: 'u', excludeTurns: true, deferGoalContinuation: true, model: 'fixture', modelProvider: 'fixture' });
  await expect(service.call('turn/start', { threadId: 'fork', text: 'edit' }, context)).rejects.toMatchObject({ code: 'history_incomplete' });
  await service.call('thread/revert', { threadId: 't', beforeTurnId: 'u' }, context);
  await expect(service.call('turn/start', { threadId: 't', text: 'new' }, context)).rejects.toMatchObject({ code: 'history_incomplete' });
  await hydrate(service); await service.call('turn/start', { threadId: 't', text: 'new' }, context);
});
test('review new thread exposes partial identity on owner loss and rejects deprecated detached mode', async () => {
  const { service, native, cwd } = setup(); const target = { type: 'uncommittedChanges' }; let count = 0;
  await expect(service.call('review/start', { threadId: 't', target, delivery: 'detached' }, context)).rejects.toMatchObject({ delivery: 'not_sent' });
  await expect(service.call('review/startNew', { cwd, target }, { ...context, beforeWrite: () => { if (++count === 2) throw new DeliveryError('client_disconnected', 'revoked'); } })).rejects.toMatchObject({ code: 'review_start_incomplete', delivery: 'unknown', data: { threadId: 'new', causeDelivery: 'not_sent' } });
  expect(native.calls.some(item => item.method === 'review/start')).toBe(false);
});
test('search windows never create full-history proof; exports preserve every structured item', async () => {
  const { service, native } = setup();
  expect(await service.call('thread/history/window', { threadId: 't', turnCursor: 'opaque' }, context)).toMatchObject({ complete: false, partial: true });
  await expect(service.call('thread/queue/start', { threadId: 't' }, context)).rejects.toMatchObject({ code: 'history_incomplete' });
  native.history = [{ ...turn(), items: [{ type: 'fixtureToolRecord', sensitiveOutput: 'retained' }] }];
  const exported = object(await service.call('thread/export', { threadId: 't', format: 'json' }, context)); expect(String(exported.content)).toContain('fixtureToolRecord'); expect(String(exported.content)).toContain('retained');
});
test('agent listing and global search exclude other projects and preserve continuation cursors', async () => {
  const { service, native, cwd } = setup(); native.responseOverride = { method: 'thread/list', value: { data: [{ ...thread('agent', cwd), parentThreadId: 't' }], nextCursor: null, backwardsCursor: null } };
  expect(object(await service.call('thread/agents/list', { threadId: 't' }, context)).data).toHaveLength(1);
  expect(native.calls.at(-1)!.params).toMatchObject({ ancestorThreadId: 't', cwd });
  native.responseOverride = { method: 'thread/search', value: { data: [{ thread: thread('foreign', path.join(cwd, 'other')), snippet: 'private' }], nextCursor: 'next', backwardsCursor: null } };
  expect(await service.call('thread/search', { cwd, searchTerm: 'needle' }, context)).toMatchObject({ data: [], nextCursor: 'next' });
});
test('subagents refusing direct input cannot receive turns or queued input', async () => {
  const { service, native } = setup(); native.directInput = false; await hydrate(service);
  await expect(service.call('turn/start', { threadId: 't', text: 'no' }, context)).rejects.toMatchObject({ code: 'direct_input_unavailable' });
  await expect(service.call('thread/queue/add', { threadId: 't', text: 'no', clientUserMessageId: 'id' }, context)).rejects.toMatchObject({ code: 'direct_input_unavailable' });
});
test('plan mode reaches the real turn protocol while initial thread config uses its chosen model and effort', async () => {
  const { service, native, cwd } = setup(); const mode = { mode: 'plan', settings: { model: 'planning-model', reasoning_effort: 'high', developer_instructions: null } };
  await service.call('conversation/start', { cwd, text: 'plan first', options: { collaborationMode: mode, summary: 'detailed' } }, context);
  expect(native.calls.find(item => item.method === 'thread/start')!.params).toMatchObject({ model: 'planning-model', config: { model_reasoning_effort: 'high', model_reasoning_summary: 'detailed' } });
  expect(native.calls.find(item => item.method === 'turn/start')!.params).toMatchObject({ collaborationMode: mode, summary: 'detailed' });
});
test('session reads never resume or start inference, and fork captures reliable native settings', async () => {
  const { service, native } = setup(); expect(await service.call('thread/session', { threadId: 'stored' }, context)).toEqual({ requiresResume: true }); expect(native.calls).toHaveLength(0);
  await expect(service.call('thread/resume', { threadId: 'stored' }, context)).rejects.toMatchObject({ code: 'history_incomplete' });
  await hydrate(service); await service.call('thread/fork', { threadId: 't' }, context); const before = native.calls.length;
  expect(await service.call('thread/session', { threadId: 'fork' }, context)).toMatchObject({ requiresResume: false, model: 'fixture', cwd: native.cwd }); expect(native.calls).toHaveLength(before);
  await service.call('thread/settings/update', { threadId: 'fork', model: 'new-model' }, context);
  expect(await service.call('thread/session', { threadId: 'fork' }, context)).toEqual({ requiresResume: true });
});
test('active goals and queued continuations remain busy between model turns', async () => {
  const { service, native } = setup(); await hydrate(service); await service.call('thread/goal/set', { threadId: 't', objective: 'keep working', status: 'active' }, context);
  native.emit('notification', { method: 'turn/started', params: { threadId: 't', turn: turn('done', 'inProgress') } }); native.emit('notification', { method: 'turn/completed', params: { threadId: 't', turn: turn('done') } });
  expect(object(object(service.status()).activity).activeThreads).toContain('t');
  await service.call('thread/goal/clear', { threadId: 't' }, context); expect(object(object(service.status()).activity).activeThreads).not.toContain('t');
  native.queue.push({ id: 'waiting', input: [], clientUserMessageId: 'id' }); native.emit('notification', { method: 'thread/queue/changed', params: { threadId: 't' } });
  expect(object(object(service.status()).activity).activeThreads).toContain('t'); await expect.poll(() => native.calls.filter(item => item.method === 'thread/queue/list').length).toBeGreaterThan(0); expect(object(object(service.status()).activity).activeThreads).toContain('t');
});
test('malformed continuation readback keeps global maintenance blocked', async () => {
  const { service, native } = setup(); native.responseOverride = { method: 'thread/goal/get', value: {} }; native.emit('notification', { method: 'thread/queue/changed', params: { threadId: 't' } });
  await expect.poll(() => object(object(service.status()).activity).unknown).toBe(true);
  expect(object(object(service.status()).activity).activeThreads).toContain('t');
});
test('known unsubscribe prevents work without implicit resubscription and delete requires history', async () => {
  const { service, native } = setup(); await hydrate(service); await service.call('thread/unsubscribe', { threadId: 't' }, context);
  await expect(service.call('turn/start', { threadId: 't', text: 'cannot lose events' }, context)).rejects.toMatchObject({ code: 'session_not_loaded' });
  await expect(service.call('thread/queue/add', { threadId: 't', text: 'not yet', clientUserMessageId: 'id' }, context)).rejects.toMatchObject({ code: 'session_not_loaded' });
  expect(native.calls.some(item => item.method === 'thread/resume')).toBe(false);
  await expect(service.call('thread/delete', { threadId: 'unseen' }, context)).rejects.toMatchObject({ code: 'history_incomplete' });
});
test('task settings reject conflicting permission profiles, deprecated flags and stale live-turn targets before native writes', async () => {
  const { service, native } = setup();
  await expect(service.call('thread/settings/update', { threadId: 't', permissions: 'profile', sandboxPolicy: { type: 'dangerFullAccess' } }, context)).rejects.toMatchObject({ code: 'invalid_params' });
  await expect(service.call('thread/settings/update', { threadId: 't', multiAgentMode: 'proactive' }, context)).rejects.toMatchObject({ code: 'invalid_params' });
  await expect(service.call('thread/settings/update', { threadId: 't', disabledPluginIds: ['same', 'same'] }, context)).rejects.toMatchObject({ code: 'invalid_params' });
  native.active = true; native.emit('notification', { method: 'turn/started', params: { threadId: 't', turn: turn('active', 'inProgress') } });
  await expect(service.call('turn/settings/update', { threadId: 't', turnId: 'stale', serviceTier: null }, context)).rejects.toMatchObject({ code: 'turn_changed' });
  expect(native.calls.filter(item => item.method.endsWith('settings/update'))).toHaveLength(0);
  expect(await service.call('turn/settings/update', { threadId: 't', turnId: 'active', serviceTier: null }, context)).toEqual({ status: 'applied' });
});
