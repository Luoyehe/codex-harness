import { expect, test } from 'vitest';
import path from 'node:path';
import { LiveThreadList } from '../../src/runtime/live-thread-list.js';
import { object, type JsonValue } from '../../src/runtime/types.js';

const cwd = path.resolve('.work/live-thread-list-project');
const thread = (id: string) => ({ id, cwd, source: 'vscode', ephemeral: false, parentThreadId: null, name: null, preview: '', createdAt: 1, updatedAt: 1, modelProvider: 'custom', status: { type: 'idle' } });
const page = (data: JsonValue[] = []) => ({ data, nextCursor: 'native-opaque', backwardsCursor: null });
const live = (value: JsonValue) => (object(value).liveData as JsonValue[]).map(row => object(row));

test('acknowledged summaries survive turn lifecycle until native persistence, without changing native pagination', () => {
  const cache = new LiveThreadList(); const release = cache.reserve(); cache.capture(thread('one'), cwd); release();
  cache.preview('one', 'First input');
  cache.notification('turn/started', { threadId: 'one', turn: { id: 'turn' } });
  expect(live(cache.page({ cwd }, page()))).toMatchObject([{ id: 'one', preview: 'First input', status: { type: 'active' } }]);
  cache.notification('turn/completed', { threadId: 'one', turn: { id: 'turn' } });
  expect(live(cache.page({ cwd }, page()))).toHaveLength(1);
  const persisted = page([{ ...thread('one'), name: 'Native authoritative title' }]);
  expect(cache.page({ cwd }, persisted)).toEqual({ ...persisted, liveData: [], liveDataTruncated: false });
  expect(live(cache.page({ cwd }, page()))).toEqual([]);
});

test('project, search and archived views do not leak a different live scope and later pages remain native-only', () => {
  const cache = new LiveThreadList(); cache.capture(thread('one'), cwd); cache.preview('one', 'Original text');
  cache.notification('thread/name/updated', { threadId: 'one', threadName: 'Renamed title' });
  expect(live(cache.page({ cwd, searchTerm: 'RENAMED' }, page()))).toHaveLength(1);
  expect(live(cache.page({ cwd, searchTerm: 'Original text' }, page()))).toEqual([]);
  expect(live(cache.page({ cwd: path.join(cwd, 'different') }, page()))).toEqual([]);
  expect(cache.page({ cwd, archived: true }, page())).toEqual(page());
  expect(cache.page({ cwd, cursor: 'native-previous' }, page())).toEqual(page());
  expect(live(cache.page({ cwd }, page()))).toHaveLength(1);
});

test.each(['thread/closed', 'thread/deleted', 'thread/archived'])('%s removes an unindexed summary without resurrecting it', method => {
  const cache = new LiveThreadList(); cache.capture(thread('one'), cwd);
  cache.notification(method, { threadId: 'one' }); cache.notification('turn/completed', { threadId: 'one' });
  expect(live(cache.page({ cwd }, page()))).toEqual([]);
});

test('capacity includes in-flight creation reservations and never evicts an unindexed active row', () => {
  const cache = new LiveThreadList(2), first = cache.reserve(), second = cache.reserve();
  expect(() => cache.reserve()).toThrowError(/Refresh the project list/);
  cache.capture(thread('one'), cwd); first(); first(); second();
  cache.notification('turn/started', { threadId: 'one' });
  const third = cache.reserve(); cache.capture(thread('two'), cwd); third();
  expect(() => cache.reserve()).toThrowError(/Refresh the project list/);
  expect(live(cache.page({ cwd }, page()))).toHaveLength(2);
  cache.page({ cwd }, page([thread('two')]));
  expect(() => cache.reserve()()).not.toThrow();
  cache.clear(); expect(live(cache.page({ cwd }, page()))).toEqual([]);
});

test('the bounded first-page view reports truncation while retaining all summaries and safe Unicode previews', () => {
  const cache = new LiveThreadList();
  for (let i = 0; i < 101; i++) { const release = cache.reserve(); cache.capture(thread(String(i)), cwd); cache.preview(String(i), '😀'.repeat(400)); release(); }
  const value = cache.page({ cwd }, page()); expect(live(value)).toHaveLength(100); expect(value.liveDataTruncated).toBe(true);
  expect(Array.from(String(live(value)[0]!.preview))).toHaveLength(256); expect(String(live(value)[0]!.preview).isWellFormed()).toBe(true);
  cache.notification('thread/name/updated', { threadId: '0', threadName: 'Find retained row' });
  expect(live(cache.page({ cwd, searchTerm: 'Find retained' }, page()))).toMatchObject([{ id: '0' }]);
});

test('ephemeral and child-agent creations never become project sidebar summaries', () => {
  const cache = new LiveThreadList(); cache.capture({ ...thread('probe'), ephemeral: true }, cwd); cache.capture({ ...thread('child'), parentThreadId: 'parent' }, cwd);
  expect(live(cache.page({ cwd }, page()))).toEqual([]);
});
