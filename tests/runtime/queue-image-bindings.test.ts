import { expect, test } from 'vitest';
import { QueueImageBindings, type QueueImageSubmission } from '../../src/runtime/queue-image-bindings.js';
const first: QueueImageSubmission = { operationId: 'operation', method: 'add', threadId: 'thread-1', clientUserMessageId: 'client-1',
  slots: [{ ordinal: 1, attachmentId: 'source-first' }, { ordinal: 4, attachmentId: 'source-second' }] };
const img = (ordinal: number, digest = 'a') => ({ ordinal, sha256: digest.repeat(64), mimeType: 'image/png', bytes: 125 });
const receipt = { threadId: 'thread-1', queuedSubmissionId: 'queue-1', clientUserMessageId: 'client-1', images: [img(1), img(4, 'b')] };
test('lost, unrelated and incomplete native replies retain the original files but do not grant a new owner', () => {
  const start = new QueueImageBindings(); start.begin(first);
  const restored = new QueueImageBindings(start.json());
  for (const bad of [{ threadId: 'different' }, { clientUserMessageId: 'different' }, { images: [img(1)] }, { images: [img(1), img(1)] }])
    expect(() => restored.confirm('operation', { ...receipt, ...bad })).toThrow();
  expect(restored.pendingAttachments('thread-1')).toEqual(['source-first', 'source-second']);
  expect(restored.pendingAttachments('other')).toEqual([]); expect(restored.aliases()).toEqual([]);
  expect(() => restored.begin({ ...first, operationId: 'parallel' })).toThrow();
  expect(restored.pendingThread('operation')).toBe('thread-1');
  restored.confirm('operation', receipt);
  const confirmed = new QueueImageBindings(restored.json());
  const read = (thread: string, queue: string, ordinal: number, hash: string, mime = 'image/png', bytes = 125) =>
    confirmed.lookup(thread, queue, ordinal, hash.repeat(64), mime, bytes);
  expect(read('thread-1', 'queue-1', 1, 'a')).toBe('source-first');
  for (const result of [read('other', 'queue-1', 1, 'a'), read('thread-1', 'another', 1, 'a'),
    read('thread-1', 'queue-1', 4, 'a'), read('thread-1', 'queue-1', 1, 'a', 'image/jpeg'), read('thread-1', 'queue-1', 1, 'a', 'image/png', 124)]) expect(result).toBeUndefined();
  expect(confirmed.pendingAttachments()).toEqual([]);
  confirmed.pruneConfirmed(row => row.ordinal === 4);
  expect(confirmed.aliases().map(row => row.attachmentId)).toEqual(['source-second']);
});
test('a positively confirmed update replaces its own slots, a known unsent update preserves old bindings, and deletion retires them', () => {
  const store = new QueueImageBindings(); store.begin(first); store.confirm('operation', receipt);
  const update: QueueImageSubmission = { operationId: 'update', threadId: 'thread-1', method: 'update', queuedSubmissionId: 'queue-1', slots: [] };
  store.begin(update); expect(store.hasPendingFor('thread-1', 'queue-1')).toBe(true);
  expect(() => store.confirm('update', { ...receipt, queuedSubmissionId: 'other' })).toThrow();
  store.notSent('update'); expect(store.aliases()).toHaveLength(2);
  store.begin(update); store.confirm('update', { ...receipt, images: [] }); expect(store.aliases()).toEqual([]);
  store.begin(first); store.confirm('operation', receipt);
  store.remove('other', 'queue-1'); expect(store.aliases()).toHaveLength(2);
  store.remove('thread-1', 'queue-1'); expect(store.aliases()).toEqual([]);
  store.begin(first); store.releaseThread('thread-1'); expect(store.pendingAttachments()).toEqual([]);
});
test('pending and confirmed capacity is reserved before sending any native mutation', () => {
  const store = new QueueImageBindings();
  for (let i = 0; i < 8; i++) store.begin({ ...first, operationId: 'op'+i, clientUserMessageId: 'client'+i,
    slots: Array.from({ length: 128 }, (_, ordinal) => ({ ordinal, attachmentId: 'asset'+ordinal })) });
  expect(() => store.begin(first)).toThrow(); store.notSent('op7'); store.begin(first);
  expect(() => new QueueImageBindings({ version: 99, pending: [], confirmed: [] })).toThrow();
});

test('an ambiguous legacy image protects only its first candidates, survives ordinary queue deletion and can never authorize a file read', () => {
  const state = new QueueImageBindings(), proof = img(0);
  expect(state.observeCandidates('old-thread', [proof, proof], ['first', 'second'])).toBe(true);
  state.observeCandidates('old-thread', [proof], ['new-unrelated']);
  state.remove('old-thread', 'queue-1');
  const loaded = new QueueImageBindings(state.json());
  expect(loaded.candidateOrigins()).toEqual([{ threadId: 'old-thread', mimeType: proof.mimeType, sha256: proof.sha256, attachmentIds: ['first','second'] }]);
  expect(loaded.lookup('old-thread', 'queue-1', 0, proof.sha256, proof.mimeType, proof.bytes)).toBeUndefined();
  expect(loaded.aliases()).toEqual([]);
  for (let n = 1; n < 128; n++) expect(loaded.observeCandidates('t'+n, [proof], ['same'])).toBe(true);
  expect(loaded.observeCandidates('full', [proof], ['maybe'])).toBe(false);
  loaded.pruneCandidates(row => row.threadId !== 't1');
  expect(loaded.observeCandidates('retry', [proof], ['maybe'])).toBe(true);
  loaded.releaseThread('old-thread'); expect(loaded.candidateOrigins().some(row => row.threadId === 'old-thread')).toBe(false);
});
