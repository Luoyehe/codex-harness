import { afterEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { convertThread, type ConversionHost } from '../../src/runtime/thread-conversion.js';
import * as history from '../../src/runtime/thread-history-compatibility.js';
import type { NativeRpc, NativeOptions } from '../../src/runtime/native.js';
import { ThreadActivity } from '../../src/runtime/thread-activity.js';
import { DeliveryError, jsonBytes, object, type JsonObject } from '../../src/runtime/types.js';
import { nativeThread } from './fixture-values.js';

afterEach(() => vi.restoreAllMocks());
const config = { bin: '/fixture/codex', home: '/fixture/home', cwd: '/project', env: {} };
function fixture(sourceOverrides: JsonObject = {}, targetOverrides: JsonObject = {}) {
  const thread = nativeThread({ id: 'source', path: '/fixture/source.jsonl', modelProvider: 'a', ...sourceOverrides });
  const target = nativeThread({ id: 'target', path: '/fixture/target.jsonl', modelProvider: 'a', ...targetOverrides });
  const snapshot: JsonObject = { model: 'model', modelProvider: 'a', cwd: '/project', serviceTier: null, disabledPluginIds: [],
    runtimeWorkspaceRoots: [], instructionSources: [], approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'dangerFullAccess' },
    activePermissionProfile: null, reasoningEffort: null, multiAgentMode: 'explicitRequestOnly', collaborationMode: { mode: 'default', settings: { model: 'model', reasoning_effort: null, developer_instructions: null } } };
  vi.spyOn(history, 'historyCompatibility').mockResolvedValue(true);
  const helper = vi.spyOn(history, 'historyHelper').mockResolvedValue({ expected: { sha256: 'a'.repeat(64) }, sourceMetadata: { serviceTier: null } });
  const native = new EventEmitter() as NativeRpc, calls: string[] = [];
  native.call = vi.fn(async (method: string, _params: JsonObject, _options?: NativeOptions) => {
    calls.push(method);
    // Simulate an adapter that returns a positive ACK without calling beforeWrite.
    if (method === 'thread/unsubscribe') { native.emit('notification', { method: 'thread/closed', params: { threadId: 'source' } }); return { status: 'unsubscribed' }; }
    if (method === 'thread/start') return { ...snapshot, thread: target };
    throw new Error('Unexpected dispatch after failed creation bookkeeping');
  }) as NativeRpc['call'];
  const release = vi.fn(), host: ConversionHost = { reserve: () => release, capture: vi.fn(), closed: vi.fn(), publish: vi.fn(), uncertain: vi.fn() };
  const run = () => convertThread(config, native, thread, snapshot, { modelProvider: 'b', model: 'model' }, 'foreign', {}, 'Target', host, () => {});
  return { run, host, calls, helper, release, native, thread, target, snapshot };
}

test('conversion verifies the new history without aggregating two individually supported images into a native frame', async () => {
  const f = fixture(), expected = { sha256: 'a'.repeat(64) }, reads: JsonObject[] = [];
  const image = Buffer.alloc(8 * 1024 * 1024, 17); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image);
  const items = ['first', 'second'].map(id => ({ type: 'imageGeneration', id, status: 'completed', result: image.toString('base64'), revisedPrompt: null, failure: null }));
  // These are public-protocol transport fixtures, not a claim of actual model generation.
  for (const item of items) expect(() => jsonBytes({ item })).not.toThrow();
  expect(() => jsonBytes({ items })).toThrow('JSON exceeds byte budget');
  f.helper.mockImplementation(async (_config, request) => request.action === 'recovery-copy'
    ? { copied: true, sourcePreserved: true, expected, target: { threadId: 'target', expected } }
    : request.action === 'repair' ? { needsRepair: false } : { expected, sourceMetadata: { serviceTier: null } });
  f.native.call = vi.fn(async (method: string, params: JsonObject) => {
    if (method === 'thread/unsubscribe') { f.native.emit('notification', { method: 'thread/closed', params: { threadId: params.threadId } }); return { status: 'unsubscribed' }; }
    if (method === 'thread/start') return { ...f.snapshot, thread: f.target };
    if (method === 'thread/name/set') return {};
    if (method === 'thread/read') return { thread: f.target };
    if (method === 'thread/resume') return { ...f.snapshot, modelProvider: 'b', thread: { ...f.target, modelProvider: 'b' } };
    if (method === 'thread/settings/update') {
      f.native.emit('notification', { method: 'thread/settings/updated', params: { threadId: 'target', threadSettings: { ...f.snapshot, modelProvider: 'b', sandboxPolicy: f.snapshot.sandbox!, effort: null, summary: null, personality: null } } }); return {};
    }
    if (method === 'thread/turns/list') {
      reads.push(params); const page = { data: [{ id: 'turn', rootTurnId: null, itemsView: params.itemsView!, items: params.itemsView === 'notLoaded' ? [] : items, status: 'completed', error: null, startedAt: null, completedAt: null, durationMs: null }], nextCursor: null, backwardsCursor: null };
      jsonBytes(page); return page;
    }
    throw new Error('Unexpected conversion call ' + method);
  }) as NativeRpc['call'];
  const source = JSON.stringify(f.thread), result = object(await f.run());
  expect(reads).toEqual([{ threadId: 'target', limit: 1, itemsView: 'notLoaded' }]);
  expect(result.sourceThreadId).toBe('source'); expect(object(result.thread).id).toBe('target'); expect(JSON.stringify(f.thread)).toBe(source);
  expect(f.host.publish).toHaveBeenCalledOnce(); expect(f.host.uncertain).not.toHaveBeenCalled();
});

test('positive creation ACK remains unknown when activity capacity and uncertainty bookkeeping both fail', async () => {
  const f = fixture(), activity = new ThreadActivity(() => true, () => {}, 1);
  activity.track('source').pending = true;
  f.host.capture = () => { activity.track('target'); };
  f.host.uncertain = vi.fn(() => { activity.track('target'); });
  await expect(f.run()).rejects.toMatchObject({ code: 'activity_capacity', delivery: 'unknown', data: { phase: 'conversion', threadId: 'target', sourceThreadId: 'source', inputSent: false } });
  expect(f.calls).toEqual(['thread/unsubscribe', 'thread/start']);
  expect(f.host.uncertain).toHaveBeenCalledExactlyOnceWith('target'); expect(f.release).toHaveBeenCalledOnce();
  expect(f.helper.mock.calls.every(([, request]) => request.action === 'copy-inspect')).toBe(true);
});

test('pre-dispatch rejection stays not_sent and reserves no target', async () => {
  const f = fixture(); f.host.reserve = () => { throw new DeliveryError('thread_list_capacity', 'No slot'); };
  await expect(f.run()).rejects.toMatchObject({ code: 'thread_list_capacity', delivery: 'not_sent' });
  expect(f.calls).toEqual([]); expect(f.host.uncertain).not.toHaveBeenCalled();
});

test('same-provider aliases with compatible history do not create a duplicate chat', async () => {
  const f = fixture({ modelProvider: 'openai' });
  vi.mocked(history.historyCompatibility).mockResolvedValue(false);
  await expect(convertThread(config, f.native, nativeThread({ id: 'source', modelProvider: 'openai', cwd: '/project', path: '/source.jsonl' }),
    { modelProvider: 'openai', cwd: '/project' }, { modelProvider: 'harness_chatgpt' }, 'plaintext', {}, 'ChatGPT', f.host, () => {}))
    .rejects.toMatchObject({ code: 'provider_unchanged', delivery: 'not_sent' });
  expect(f.calls).toEqual([]); expect(f.helper).not.toHaveBeenCalled();
});

test.each([
  ['empty to local', { environments: [] }, { environments: [{ environmentId: 'local', cwd: '/project', runtimeWorkspaceRoots: [] }] }],
  ['local to empty', { environments: [{ environmentId: 'local', cwd: '/project', runtimeWorkspaceRoots: [] }] }, { environments: [] }],
  ['project mismatch', { projectId: 'source-project' }, { projectId: 'other-project' }],
])('a schema-valid %s change after creation cannot publish success', async (_label, source, target) => {
  const f = fixture(source, target);
  await expect(f.run()).rejects.toMatchObject({ delivery: 'unknown', data: { phase: 'conversion', threadId: 'target', sourceThreadId: 'source' } });
  expect(f.host.capture).not.toHaveBeenCalled(); expect(f.host.publish).not.toHaveBeenCalled();
  expect(f.calls).toEqual(['thread/unsubscribe', 'thread/start']);
});

test('a reused source ID is never captured or reported as a new partial target', async () => {
  const f = fixture({}, { id: 'source' });
  await expect(f.run()).rejects.toMatchObject({ delivery: 'unknown', data: { inputSent: false } });
  expect(f.host.capture).not.toHaveBeenCalled(); expect(f.host.uncertain).toHaveBeenCalledExactlyOnceWith(undefined);
});
