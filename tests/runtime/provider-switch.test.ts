import { afterEach, expect, test, vi } from 'vitest';
import { switchThreadProvider, type ProviderSwitchHost } from '../../src/runtime/thread-provider-switch.js';
import { DeliveryError, type JsonObject } from '../../src/runtime/types.js';
import type { ProviderSwitchPlan } from '../../src/runtime/providers.js';

const cwd = process.cwd();
const plan: ProviderSwitchPlan = { sourceProvider: 'old_provider', modelProvider: 'new_provider', model: 'new-model', config: { model_reasoning_effort: null }, options: { model: 'new-model', effort: null } };
function thread(provider = 'old_provider'): JsonObject {
  return { id: 'thread', environments: null, extra: null, sessionId: 'thread', forkedFromId: null, parentThreadId: null, preview: '', ephemeral: false, section: null, sectionEnteredAt: null, projectId: null, historyMode: 'paginated', modelProvider: provider, model: provider === 'old_provider' ? 'old-model' : 'new-model', reasoningEffort: null, createdAt: 1, updatedAt: 1, recencyAt: null, status: { type: 'idle' }, path: null, cwd, cliVersion: '0.164.0', originator: null, source: 'appServer', canAcceptDirectInput: true, threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: null, daybreakEnabled: null, turns: [] };
}
function session(provider = 'old_provider'): JsonObject {
  return { requiresResume: false, thread: thread(provider), model: provider === 'old_provider' ? 'old-model' : 'new-model', modelProvider: provider, serviceTier: null, disabledPluginIds: [], cwd, runtimeWorkspaceRoots: [], instructionSources: [], approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false }, activePermissionProfile: null, reasoningEffort: null, collaborationMode: null, multiAgentMode: 'explicitRequestOnly', initialTurnsPage: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null };
}
function setup(overrides: Record<string, JsonObject> = {}) {
  const results: Record<string, JsonObject> = { 'thread/goal/get': { goal: null }, 'thread/queue/list': { data: [], nextCursor: null }, 'thread/read': { thread: thread(), readState: null }, 'thread/unsubscribe': { status: 'unsubscribed' }, 'thread/resume': session('new_provider'), ...overrides };
  const host: ProviderSwitchHost = { call: vi.fn(async (method, _params, options) => { options.beforeWrite?.(); return results[method]!; }), check: vi.fn(), beforeWrite: vi.fn(), onDetached: vi.fn(), afterResume: vi.fn(async () => {}) };
  return { host, results };
}
afterEach(() => vi.useRealTimers());

test('switches one idle thread without submitting input, then waits for restored history ownership', async () => {
  const { host } = setup(); let finish!: () => void;
  host.afterResume = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  let settled = false; const pending = switchThreadProvider(plan, session(), host).then(result => { settled = true; return result; });
  await vi.waitFor(() => expect(host.afterResume).toHaveBeenCalledOnce()); expect(settled).toBe(false);
  finish(); await expect(pending).resolves.toMatchObject({ thread: { id: 'thread' }, modelProvider: 'new_provider' });
  expect(vi.mocked(host.call).mock.calls.map(row => row[0])).toEqual(['thread/goal/get', 'thread/queue/list', 'thread/read', 'thread/unsubscribe', 'thread/resume']);
  expect(host.beforeWrite).toHaveBeenNthCalledWith(1, 'detach'); expect(host.beforeWrite).toHaveBeenNthCalledWith(2, 'resume');
  expect(host.call).toHaveBeenLastCalledWith('thread/resume', { threadId: 'thread', excludeTurns: true, modelProvider: 'new_provider', model: 'new-model', config: { model_reasoning_effort: null } }, expect.any(Object));
});

test.each(['queue', 'active', 'active-goal', 'unknown-goal'])('does not detach with %s continuation evidence', async state => {
  const { host, results } = setup();
  if (state === 'queue') results['thread/queue/list'] = { data: [{ id: 'queued', input: [], clientUserMessageId: 'client' }], nextCursor: null };
  if (state === 'active') results['thread/read'] = { thread: { ...thread(), status: { type: 'active', activeFlags: [] } }, readState: null };
  if (state === 'active-goal') results['thread/goal/get'] = { goal: { threadId: 'thread', objective: 'fixture', status: 'active', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } };
  if (state === 'unknown-goal') results['thread/goal/get'] = {};
  await expect(switchThreadProvider(plan, session(), host)).rejects.toMatchObject({ delivery: 'not_sent' });
  expect(host.beforeWrite).not.toHaveBeenCalled(); expect(host.onDetached).not.toHaveBeenCalled();
});

test.each(['modelProvider', 'model', 'cwd', 'sandbox', 'environments'])('never sends input when resumed %s differs', async key => {
  const { host, results } = setup(); const next = results['thread/resume']!;
  if (key === 'environments') next.thread = { ...thread('new_provider'), environments: [{ environmentId: 'foreign', cwd }] };
  else next[key] = key === 'sandbox' ? { type: 'dangerFullAccess' } : 'unexpected';
  await expect(switchThreadProvider(plan, session(), host)).rejects.toMatchObject({ delivery: 'unknown', data: { inputSent: false } });
  expect(host.afterResume).not.toHaveBeenCalled(); expect(vi.mocked(host.call).mock.calls.some(row => row[0] === 'turn/start')).toBe(false);
});

test('another native subscriber retaining the old provider is an unconfirmed switch, not success', async () => {
  const { host } = setup({ 'thread/resume': session() });
  await expect(switchThreadProvider(plan, session(), host)).rejects.toMatchObject({ code: 'provider_switch_unconfirmed', delivery: 'unknown' });
  expect(host.onDetached).toHaveBeenCalledOnce(); expect(host.afterResume).not.toHaveBeenCalled();
});

test('late recovery fencing prevents detach; a fence after detach preserves the partial outcome', async () => {
  const first = setup(); first.host.beforeWrite = vi.fn(() => { throw new DeliveryError('maintenance', 'recovery'); });
  await expect(switchThreadProvider(plan, session(), first.host)).rejects.toMatchObject({ code: 'maintenance', delivery: 'not_sent' });
  const second = setup(); second.host.beforeWrite = vi.fn(phase => { if (phase === 'resume') throw new DeliveryError('maintenance', 'recovery'); });
  await expect(switchThreadProvider(plan, session(), second.host)).rejects.toMatchObject({ code: 'maintenance', delivery: 'unknown', data: { inputSent: false } });
});

test('history hydration failure after a positive resume stays unknown and is never retried', async () => {
  const { host } = setup(); host.afterResume = vi.fn(async () => { throw new DeliveryError('history_stale', 'changed'); });
  await expect(switchThreadProvider(plan, session(), host)).rejects.toMatchObject({ code: 'history_stale', delivery: 'unknown' });
  expect(vi.mocked(host.call).mock.calls.filter(row => row[0] === 'thread/resume')).toHaveLength(1);
});

test('all reads and writes share a total deadline', async () => {
  vi.useFakeTimers(); const { host } = setup();
  host.check = vi.fn(() => { if (vi.mocked(host.call).mock.calls.length === 1) vi.setSystemTime(Date.now() + 30001); });
  await expect(switchThreadProvider(plan, session(), host)).rejects.toMatchObject({ code: 'provider_switch_timeout', delivery: 'not_sent' });
  expect(host.beforeWrite).not.toHaveBeenCalled();
});

test('history repair waits for real unload and completes before the same thread resumes', async () => {
  const { host } = setup(); let release!: () => void;
  host.history = { beforeDetach: vi.fn(), afterDetach: vi.fn(() => new Promise<void>(resolve => { release = resolve; })), cancel: vi.fn() };
  const pending = switchThreadProvider(plan, session(), host);
  await vi.waitFor(() => expect(host.history!.afterDetach).toHaveBeenCalledOnce());
  expect(vi.mocked(host.call).mock.calls.some(row => row[0] === 'thread/resume')).toBe(false);
  release(); await pending;
  expect(host.history.beforeDetach).toHaveBeenCalledOnce(); expect(host.history.cancel).toHaveBeenCalledOnce();
});

test('uncertain compatibility publication never resumes or sends input', async () => {
  const { host } = setup(); host.history = { beforeDetach: vi.fn(), afterDetach: vi.fn(async () => { throw new DeliveryError('thread_history_unknown', 'publication uncertain', 'unknown'); }), cancel: vi.fn() };
  await expect(switchThreadProvider(plan, session(), host)).rejects.toMatchObject({ code: 'thread_history_unknown', delivery: 'unknown', data: { inputSent: false } });
  expect(vi.mocked(host.call).mock.calls.some(row => ['thread/resume', 'turn/start'].includes(row[0]))).toBe(false);
  expect(host.history.cancel).toHaveBeenCalledOnce();
});
