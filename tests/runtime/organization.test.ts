import { afterEach, expect, test } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { RuntimeService } from '../../src/runtime/service.js';
import type { NativeRpc, NativeOptions } from '../../src/runtime/native.js';
import { DeliveryError, object, type JsonObject, type JsonValue } from '../../src/runtime/types.js';

const parent = path.resolve('.work/organization-tests'); mkdirSync(parent, { recursive: true }); const context = { clientId: 'owner', eventChannelId: 'channel', beforeWrite: () => {} };
function thread(id: string, cwd: string): JsonObject { return { id, environments: null, extra: null, sessionId: id, forkedFromId: null, parentThreadId: null, preview: '', ephemeral: false, section: null, sectionEnteredAt: null, projectId: null, historyMode: 'paginated', modelProvider: 'fixture', model: 'fixture', reasoningEffort: null, createdAt: 1, updatedAt: 1, recencyAt: null, status: { type: 'idle' }, path: null, cwd, cliVersion: '0.164.0', originator: null, source: 'appServer', canAcceptDirectInput: true, threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: null, daybreakEnabled: null, turns: [] }; }
class Native extends EventEmitter {
  connected = true; budget = {}; calls: { method: string; params: JsonObject }[] = []; threads = new Map<string, JsonObject>(); root: string; hook?: (method: string) => void; error?: DeliveryError; gate?: Promise<void>; gateMethod?: string; response?: { method: string; value: JsonValue };
  constructor(readonly cwd: string) { super(); this.root = cwd; this.threads.set('a', thread('a', cwd)); this.threads.set('b', thread('b', cwd)); }
  async call(method: string, input: JsonValue, options: NativeOptions = {}): Promise<JsonValue> {
    if (method === this.gateMethod) await this.gate; const p = object(input); this.hook?.(method); options.beforeWrite?.(); this.calls.push({ method, params: p }); if (this.error && method.startsWith('project/')) throw this.error; if (method === this.response?.method) return this.response.value;
    if (method === 'thread/start') return { thread: this.threads.get('a')!, model: 'fixture', modelProvider: 'fixture', serviceTier: null, disabledPluginIds: [], cwd: this.cwd, runtimeWorkspaceRoots: [], instructionSources: [], approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'dangerFullAccess' }, activePermissionProfile: null, reasoningEffort: null, multiAgentMode: 'explicitRequestOnly' };
    if (method === 'thread/read') return { thread: this.threads.get(String(p.threadId))! };
    if (method === 'thread/turns/list') return { data: [], nextCursor: null, backwardsCursor: null };
    if (method === 'thread/timeline/list') return { data: [], nextCursor: null, activeRealtimeSessionAtPageStart: null };
    if (method === 'thread/metadata/update') return { thread: { ...this.threads.get(String(p.threadId))!, projectId: p.projectId } };
    if (method.startsWith('project/')) return { project: { id: p.projectId ?? 'native', name: p.name ?? 'Native project', roots: p.roots ?? [{ path: this.root }], metadata: {}, position: 0, createdAt: 1, updatedAt: 1, recencyAt: null } };
    if (method === 'threadSection/create') return { section: { id: 'section', name: p.name!, appearance: null } };
    if (method === 'thread/attachmentOwner/list') return { data: [{ threadId: 'a', archived: false }, { threadId: 'b', archived: false }], nextCursor: 'more' };
    return {};
  }
  async close() { this.connected = false; }
}
const services: RuntimeService[] = [];
async function setup() { const cwd = mkdtempSync(path.join(parent, 'home-')); const native = new Native(cwd); const service = new RuntimeService({ bin: process.execPath, home: cwd, workerHome: cwd, cwd, env: {} }, native as unknown as NativeRpc); services.push(service); await service.call('thread/start', { cwd }, context); return { cwd, native, service }; }
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });

test('organization metadata does not invalidate settings and thread assignment never changes cwd', async () => {
  const { cwd, service, native } = await setup(); await service.call('threadSection/create', { name: 'Notes' }, context); expect(await service.call('thread/session', { threadId: 'a' }, context)).toMatchObject({ requiresResume: false, cwd });
  await service.call('thread/project/set', { threadId: 'a', nativeProjectId: 'native' }, context); expect(native.calls.at(-1)).toEqual({ method: 'thread/metadata/update', params: { threadId: 'a', projectId: 'native' } });
  native.root = path.join(cwd, 'foreign'); await expect(service.call('thread/project/set', { threadId: 'a', nativeProjectId: 'foreign' }, context)).rejects.toMatchObject({ code: 'project_mismatch' });
});
test('atomic import requires every source history and rejects active work at its last native boundary', async () => {
  const { cwd, native, service } = await setup(); const params = { name: 'Import', roots: [{ path: cwd }], threadIds: ['a', 'b'], idempotencyKey: 'key' };
  await expect(service.call('nativeProject/import', params, context)).rejects.toMatchObject({ code: 'history_incomplete' }); await service.call('thread/history', { threadId: 'b' }, context);
  native.hook = method => { if (method === 'project/import') native.emit('notification', { method: 'turn/started', params: { threadId: 'b', turn: { id: 'raced', status: 'inProgress' } } }); };
  await expect(service.call('nativeProject/import', params, context)).rejects.toMatchObject({ code: 'thread_busy' }); expect(native.calls.some(call => call.method === 'project/import')).toBe(false);
});
test('import holds admission through validation and rechecks connection before the atomic write', async () => {
  const { cwd, native, service } = await setup(); let release!: () => void; native.gateMethod = 'thread/read'; native.gate = new Promise(resolve => { release = resolve; });
  const pending = service.call('nativeProject/import', { name: 'Import', roots: [{ path: cwd }], threadIds: ['a'], idempotencyKey: 'key' }, { ...context, beforeWrite: () => { throw new DeliveryError('client_disconnected', 'revoked'); } }); const rejected = expect(pending).rejects.toMatchObject({ code: 'client_disconnected' });
  await expect(service.call('turn/start', { threadId: 'a', text: 'racing' }, context)).rejects.toMatchObject({ code: 'configuration_busy' }); release(); await rejected;
  expect(object(object(service.status()).activity).pendingStarts).toBe(0); expect(native.calls.some(call => call.method === 'project/import')).toBe(false);
});
test('thread owner lookup and section ordering enforce the original project directory', async () => {
  const { cwd, native, service } = await setup(); native.threads.get('b')!.cwd = path.join(cwd, 'other');
  expect(await service.call('thread/attachmentOwner/list', { cwd, attachmentType: 'link', identityKey: 'reference' }, context)).toEqual({ data: [{ threadId: 'a', archived: false }], nextCursor: 'more' });
  await expect(service.call('thread/section/move', { threadId: 'a', sectionId: 'section', beforeThreadId: 'b' }, context)).rejects.toMatchObject({ code: 'project_mismatch' });
});
test('malformed accepted metadata becomes unknown and blocks subsequent writes', async () => {
  const { native, service } = await setup(); native.response = { method: 'threadSection/create', value: {} };
  await expect(service.call('threadSection/create', { name: 'Notes' }, context)).rejects.toMatchObject({ delivery: 'unknown' });
  await expect(service.call('threadSection/create', { name: 'Again' }, context)).rejects.toMatchObject({ code: 'activity_unknown' });
});
test('metadata payloads are bounded and memory mode needs history without enabling memory globally', async () => {
  const { service, native } = await setup();
  await expect(service.call('thread/attachment/add', { threadId: 'a', attachmentType: 'link', identityKey: 'ref', payload: { text: 'x'.repeat(65536) } }, context)).rejects.toMatchObject({ code: 'capacity' });
  await expect(service.call('thread/memoryMode/set', { threadId: 'b', mode: 'disabled' }, context)).rejects.toMatchObject({ code: 'history_incomplete' }); await service.call('thread/history', { threadId: 'b' }, context); await service.call('thread/memoryMode/set', { threadId: 'b', mode: 'disabled' }, context);
  expect(native.calls.at(-1)).toEqual({ method: 'thread/memoryMode/set', params: { threadId: 'b', mode: 'disabled' } });
});
test('automation preflight validates both fixed native schemas without calling native or changing state', async () => {
  const { cwd, native, service } = await setup(); const before = service.status(), calls = native.calls.length;
  expect(await service.call('automation/validate', { cwd, options: { collaborationMode: { mode: 'plan', settings: { model: 'fixture', reasoning_effort: 'high', developer_instructions: null } } } }, context)).toEqual({});
  await expect(service.call('automation/validate', { cwd, options: { permissions: 'profile', sandboxPolicy: { type: 'dangerFullAccess' } } }, context)).rejects.toMatchObject({ code: 'invalid_params' }); expect(native.calls).toHaveLength(calls); expect(service.status()).toEqual(before);
});
