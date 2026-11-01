import { afterEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { awaitThreadClosed, historyCompatibility, historyHelper } from '../../src/runtime/thread-history-compatibility.js';
import type { NativeRpc } from '../../src/runtime/native.js';
import type { JsonObject } from '../../src/runtime/types.js';

const child = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFile: child.execFile }));

afterEach(() => vi.useRealTimers());

test('only the selected thread closed notification proves unload; ordinary status and unsubscribe do not', async () => {
  const native = new EventEmitter(), closed = awaitThreadClosed(native as NativeRpc, 'target');
  let done = false; void closed.wait.then(() => { done = true; });
  native.emit('notification', { method: 'thread/status/changed', params: { threadId: 'target', status: { type: 'notLoaded' } } });
  native.emit('notification', { method: 'thread/closed', params: { threadId: 'other' } });
  await Promise.resolve(); expect(done).toBe(false);
  native.emit('notification', { method: 'thread/closed', params: { threadId: 'target' } });
  await closed.wait; expect(done).toBe(true); expect(native.listenerCount('notification')).toBe(0); expect(native.listenerCount('fatal')).toBe(0);
});

test('missing unload acknowledgement times out without leaking listeners or starting a repair', async () => {
  vi.useFakeTimers(); const native = new EventEmitter(), closed = awaitThreadClosed(native as NativeRpc, 'target', 100);
  const result = expect(closed.wait).rejects.toMatchObject({ code: 'history_writer_busy', delivery: 'unknown', data: { inputSent: false } });
  await vi.advanceTimersByTimeAsync(100); await result;
  expect(native.listenerCount('notification')).toBe(0); expect(native.listenerCount('fatal')).toBe(0);
});

const helperConfig = { bin: '/fixed/codex', home: '/private/codex', cwd: '/', env: {}, launcher: { path: '/fixed/native-launch', user: 'root' } };
const helperThread = { id: 'thread', path: '/private/codex/sessions/fixture.jsonl', ephemeral: false };
const inspected = { expected: { sha256: 'a'.repeat(64), device: '1', inode: '2', size: '3', mtimeNs: '4' },
  needsRepair: true, hasHistoryBase: false, hasOpaqueCompaction: false, changedItems: 1 };
function helperReplies(replies: unknown[]) {
  const requests: JsonObject[] = []; child.execFile.mockReset();
  child.execFile.mockImplementation((_bin, _args, _options, callback) => ({ stdin: { on() {}, end(body: string) {
    requests.push(JSON.parse(body)); const reply = replies.shift(); queueMicrotask(() => callback(null, typeof reply === 'string' ? reply : JSON.stringify(reply)));
  } } }));
  return requests;
}

test.each(['hasHistoryBase', 'hasOpaqueCompaction'])('foreign %s is refused by inspection before repair dispatch', async flag => {
  const requests = helperReplies([{ ...inspected, [flag]: true }]);
  await expect(historyCompatibility(helperConfig, helperThread, 'foreign')).rejects.toMatchObject({ code: 'history_conversion_unsupported', delivery: 'not_sent' });
  expect(requests.map(row => row.action)).toEqual(['inspect']);
});

test('the owned helper preserves the supplied witness and treats malformed mutation replies as unknown', async () => {
  const requests = helperReplies(['not-json']), write = vi.fn();
  const request = { action: 'repair', threadId: 'thread', path: helperThread.path, mode: 'plaintext', expected: inspected.expected };
  await expect(historyHelper(helperConfig, request, true, write)).rejects.toMatchObject({ delivery: 'unknown', data: { inputSent: false } });
  expect(requests).toEqual([request]);
  expect(write).toHaveBeenCalledOnce();
});

test('a revoked caller stops before helper repair and ordinary valid inherited history remains readable', async () => {
  const requests = helperReplies([]);
  await expect(historyHelper(helperConfig, { action: 'repair', threadId: 'thread', path: helperThread.path, mode: 'plaintext', expected: inspected.expected }, true,
    () => { throw new Error('revoked'); })).rejects.toThrow('revoked');
  expect(requests).toEqual([]);
  expect(child.execFile).not.toHaveBeenCalled();
  helperReplies([{ ...inspected, hasHistoryBase: true, needsRepair: false, hasInheritedPlaintext: false }]);
  await expect(historyCompatibility(helperConfig, helperThread, 'plaintext')).resolves.toBe(false);
});

test('uninspectable same-provider history preserves native loading without claiming a compatibility proof', async () => {
  const requests = helperReplies([{ ...inspected, expected: null, needsRepair: false, inspectionUnsupported: true }]);
  await expect(historyCompatibility(helperConfig, helperThread, 'plaintext')).resolves.toBeUndefined();
  expect(requests.map(row => row.action)).toEqual(['inspect']);
  helperReplies([{ ...inspected, expected: null, needsRepair: false, inspectionUnsupported: true }]);
  await expect(historyCompatibility(helperConfig, helperThread, 'foreign')).rejects.toMatchObject({ code: 'history_conversion_unsupported', delivery: 'not_sent' });
});
