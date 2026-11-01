// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { Api } from '../lib/api';
import {
  acknowledgeOperation, consumeThreadOperations, createOperation, initializeOperations, listOperations, listOperationHistory, operationStorageWarning,
  stopUnknownRecovery, updateOperation, reconcileOperation, type Operation,
} from '../lib/operations';
import { operationTransaction, stored } from '../lib/operation-store';
import { emptyDraft, readDraft, writeDraft } from '../lib/drafts';

const primary = 'harness.operation.v1.', ack = 'harness.acknowledged.v1.';
function legacy(state: Operation['state'] = 'unknown'): Operation {
  return { id: crypto.randomUUID(), method: 'turn/start', threadId: crypto.randomUUID(), createdAt: 10, state };
}
function freshLegacy(records: Operation[]) {
  localStorage.clear(); globalThis.indexedDB = new IDBFactory();
  for (const record of records) localStorage.setItem(primary + record.id, JSON.stringify(record));
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });

it('handles sustained completed operations with bounded display history and no per-ID tombstones', async () => {
  const identities: string[] = [];
  for (let i = 0; i < 1200; i++) {
    const operation = await createOperation('project/add', {});
    identities.push(operation.id);
    await updateOperation(operation.id, 'accepted');
    await acknowledgeOperation(operation.id);
  }
  expect(await listOperations()).toEqual([]);
  expect(Object.keys(localStorage).filter((key) => key.startsWith(ack))).toEqual([]);
  expect(await operationTransaction(async (records, metadata) => [await stored(records.count()), await stored(metadata.count())])).toEqual([0, 2]);
  const snapshot = await listOperationHistory();
  expect(snapshot.operations).toEqual([]);
  expect(snapshot.history).toHaveLength(500);
  expect(snapshot.history.every(row => row.state === 'accepted' && row.closed === 'completed')).toBe(true);
  expect(snapshot.history.some(row => row.id === identities[0])).toBe(false);
  expect(snapshot.history.some(row => row.id === identities.at(-1))).toBe(true);
});

it('archives capacity-collected failures without clearing drafts or losing unresolved and unseen receipts', async () => {
  const draft = { ...emptyDraft('failed'), text: 'retain after failure' }; writeDraft(draft);
  const failed = await createOperation('turn/start', { threadId: 'failed', draftKey: draft.key, draftRevision: draft.revision });
  await updateOperation(failed.id, 'not_sent');
  const unknown = await createOperation('turn/start', { threadId: 'unresolved' });
  await updateOperation(unknown.id, 'unknown');
  const unseen = await createOperation('conversation/start', { projectId: 'unseen' });
  await updateOperation(unseen.id, 'accepted', 'unseen-thread');
  for (let i = 0; i < 158; i++) {
    const row = await createOperation('project/add', {}); await updateOperation(row.id, 'not_sent');
  }
  const snapshot = await listOperationHistory();
  expect(snapshot.history.find(row => row.id === failed.id)).toMatchObject({ state: 'not_sent', closed: 'collected' });
  expect(snapshot.operations.some(row => row.id === failed.id)).toBe(false);
  expect(snapshot.operations.find(row => row.id === unknown.id)?.state).toBe('unknown');
  expect(snapshot.operations.find(row => row.id === unseen.id)).toMatchObject({ state: 'accepted', resolvedThreadId: 'unseen-thread' });
  expect(readDraft(draft.key)).toEqual(draft);
  expect(snapshot.operations.length + snapshot.history.length).toBe(161);
});

it.each(['quota', 'abort'] as const)('retains the recovery row and draft when history archival fails with %s', async failure => {
  const draft = { ...emptyDraft('failed'), text: 'keep' }; writeDraft(draft);
  const record = await createOperation('turn/start', { threadId: 'failed', draftKey: draft.key, draftRevision: draft.revision });
  await updateOperation(record.id, 'not_sent');
  const original = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (this.name === 'meta' && key === 'history-v1') {
      if (failure === 'quota') throw new DOMException('history full', 'QuotaExceededError');
      const request = original.call(this, value, key); this.transaction.abort(); return request;
    }
    return original.call(this, value, key);
  });
  await expect(acknowledgeOperation(record.id)).rejects.toThrow();
  vi.restoreAllMocks();
  expect((await listOperationHistory()).history).toEqual([]);
  expect(await listOperations()).toEqual([expect.objectContaining({ id: record.id, state: 'not_sent' })]);
  expect(readDraft(draft.key)).toEqual(draft);
});

it('keeps closed unknown history display-only under late acceptance and strips recovery-only metadata', async () => {
  const draft = { ...emptyDraft('thread'), text: 'private draft' }; writeDraft(draft);
  const record = await createOperation('turn/start', { threadId: 'thread', projectId: 'project', resourceId: 'private/path',
    draftKey: draft.key, draftRevision: draft.revision, terminalOwner: { clientId: 'private-client', connectionId: 'private-lease' } });
  await updateOperation(record.id, 'unknown', 'partial-thread');
  await Promise.all([stopUnknownRecovery(record.id, { operationId: record.id, state: 'unknown' }), updateOperation(record.id, 'accepted')]);
  await updateOperation(record.id, 'unknown');
  const snapshot = await listOperationHistory();
  expect(snapshot.operations).toEqual([]);
  expect(snapshot.history).toEqual([{ id: record.id, method: 'turn/start', threadId: 'thread', projectId: 'project',
    resolvedThreadId: 'partial-thread', createdAt: record.createdAt, state: 'unknown', closed: 'recovery_stopped' }]);
  expect(readDraft(draft.key)).toEqual(draft);
  await expect(createOperation('turn/start', { threadId: 'thread', projectId: 'project', resourceId: 'private/path' })).resolves.toBeDefined();
});

it('keeps history independently bounded while retaining old active evidence and deterministic timestamp ties', async () => {
  await operationTransaction(async (records, meta) => {
    const history = Array.from({ length: 500 }, (_, i) => ({ id: `old-${String(i).padStart(3, '0')}`, method: 'project/add',
      createdAt: i, state: 'accepted', closed: 'completed' }));
    await stored(meta.put(history, 'history-v1'));
    for (const state of ['unknown', 'pending', 'accepted'] as const)
      await stored(records.add({ id: `active-${state}`, method: 'conversation/start', createdAt: -1, state }));
  });
  const a = await createOperation('project/add', { projectId: 'a' }, 0, 'same-time-a');
  const b = await createOperation('project/add', { projectId: 'b' }, 0, 'same-time-b');
  await operationTransaction(async records => {
    for (const row of [a, b]) await stored(records.put({ ...row, createdAt: 1000, state: 'accepted' }));
  });
  await Promise.all([acknowledgeOperation(b.id), acknowledgeOperation(a.id)]);
  const snapshot = await listOperationHistory();
  expect(snapshot.history).toHaveLength(500);
  expect(snapshot.history.slice(0, 2).map(row => row.id)).toEqual([a.id, b.id]);
  expect(snapshot.history.some(row => row.id === 'old-000' || row.id === 'old-001')).toBe(false);
  expect(snapshot.operations.map(row => row.id).sort()).toEqual(['active-accepted', 'active-pending', 'active-unknown']);
});

it('does not allocate an archived ID again or resurrect it through a late receipt', async () => {
  const record = await createOperation('project/add', {});
  await updateOperation(record.id, 'not_sent'); await acknowledgeOperation(record.id);
  await expect(createOperation('project/add', {}, 0, record.id)).rejects.toThrow('已关闭');
  await updateOperation(record.id, 'accepted');
  expect(await listOperations()).toEqual([]);
  expect((await listOperationHistory()).history).toEqual([expect.objectContaining({ id: record.id, state: 'not_sent' })]);
  await expect(createOperation('project/add', {})).resolves.toBeDefined();
});

it.each(['container', 'row'] as const)('ignores corrupt history %s without blocking unknown closure or accepted archival', async failure => {
  const record = await createOperation('turn/start', { threadId: 'active' });
  await updateOperation(record.id, 'unknown');
  const valid = { id: 'valid-history', method: 'project/add', state: 'not_sent', createdAt: 1, closed: 'dismissed' };
  await operationTransaction(async (_records, meta) => { await stored(meta.put(failure === 'container' ? { damaged: true } : [valid, { damaged: true }], 'history-v1')); });
  expect(await listOperationHistory()).toMatchObject({ operations: [expect.objectContaining({ id: record.id, state: 'unknown' })],
    history: failure === 'container' ? [] : [valid], historyWarning: expect.stringContaining('活动恢复记录不受影响') });
  await stopUnknownRecovery(record.id, { operationId: record.id, state: 'unknown' });
  const accepted = await createOperation('project/add', {});
  await updateOperation(accepted.id, 'accepted'); await acknowledgeOperation(accepted.id);
  expect(await listOperations()).toEqual([]);
  const snapshot = await listOperationHistory();
  expect(snapshot.history).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: record.id, state: 'unknown', closed: 'recovery_stopped' }),
    expect.objectContaining({ id: accepted.id, state: 'accepted', closed: 'completed' }),
  ]));
  if (failure === 'row') expect(snapshot.history).toContainEqual(valid);
});

it('reserves one recovery slot at capacity and durably captures only prior unresolved operations', async () => {
  const before = [];
  for (let i = 0; i < 200; i++) before.push(await createOperation('turn/start', { threadId: `blocked-${i}` }));
  await expect(createOperation('project/add', {})).rejects.toThrow('200');
  const recovery = await createOperation('system/recover', {});
  expect(new Set(recovery.recoveryOperations)).toEqual(new Set(before.map(({ id, method }) => ({ id, method }))));
  expect((await listOperations()).find(row => row.id === recovery.id)?.recoveryOperations).toEqual(recovery.recoveryOperations);
  await expect(createOperation('system/recover', {})).rejects.toThrow();
  expect(await listOperations()).toHaveLength(201);
});

it('keeps more than 200 real API chat submissions usable while preserving unseen creates and unknown results', async () => {
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    return { ok: true, status: 200, json: async () => ({ ok: true, result: body.method === 'conversation/start'
      ? { thread: { id: 'unseen-thread' } } : { turn: { id: body.operationId } } }) };
  });
  vi.stubGlobal('fetch', fetch);
  const api = new Api();
  await api.mutate('conversation/start', { projectId: 'other-project', text: 'unseen accepted creation' });
  const unseen = (await listOperations()).find(row => row.method === 'conversation/start')!;
  const unresolved = await createOperation('turn/start', { threadId: 'unknown-thread' });
  await updateOperation(unresolved.id, 'unknown');
  for (let index = 0; index < 240; index++) {
    const draft = { ...emptyDraft('current-thread'), text: `message ${index}` };
    writeDraft(draft);
    const submission = api.beginMutation('turn/start', { threadId: 'current-thread', text: draft.text });
    await submission.result;
    expect(readDraft('current-thread').text).toBe('');
    // This is the view's later successful thread/session load acknowledgement,
    // not transport acceptance. The receipt remains available until capacity GC.
    await consumeThreadOperations('current-thread', [submission.operationId]);
  }
  const records = await listOperations();
  expect(fetch).toHaveBeenCalledTimes(241);
  expect(records.length).toBeLessThanOrEqual(160);
  expect(records.find(row => row.id === unseen.id)).toMatchObject({ state: 'accepted', resolvedThreadId: 'unseen-thread' });
  expect(records.find(row => row.id === unseen.id)?.consumed).toBeUndefined();
  expect(records.find(row => row.id === unresolved.id)?.state).toBe('unknown');
  expect(records.filter(row => row.method === 'turn/start' && row.threadId === 'current-thread').every(row => row.consumed)).toBe(true);
  const history = (await listOperationHistory()).history;
  expect(history.length).toBeGreaterThan(0);
  expect(history.every(row => row.state === 'accepted' && row.closed === 'collected' && row.threadId === 'current-thread')).toBe(true);
});

it('consumption matches the destination, retains fresh receipts and never clears a newer draft', async () => {
  const source = await createOperation('thread/fork', { threadId: 'parent' });
  await updateOperation(source.id, 'accepted', 'child');
  await consumeThreadOperations('parent', [source.id]);
  expect((await listOperations())[0]?.consumed).toBeUndefined();
  await consumeThreadOperations('child', [source.id]);
  expect((await listOperations())[0]).toMatchObject({ id: source.id, consumed: true });
  const oldDraft = { ...emptyDraft('child'), text: 'first input' };
  writeDraft(oldDraft);
  const input = await createOperation('turn/start', { threadId: 'child', draftKey: 'child', draftRevision: oldDraft.revision });
  await updateOperation(input.id, 'accepted');
  const newer = { ...emptyDraft('child'), text: 'still composing' };
  writeDraft(newer);
  await consumeThreadOperations('child', [input.id]);
  expect(readDraft('child').text).toBe('still composing');
  expect((await listOperations()).find(row => row.id === input.id)).toMatchObject({ consumed: true, state: 'accepted' });
});

it('never consumes unknown or terminal ownership while loaded legacy receipts retain their draft', async () => {
  const unknown = await createOperation('turn/start', { threadId: 'pending-thread' });
  await updateOperation(unknown.id, 'unknown');
  const terminal = await createOperation('terminal/open', { projectId: 'project', threadId: 'pending-thread' });
  await updateOperation(terminal.id, 'accepted', undefined, { terminalId: 'owned-terminal' });
  const legacyDraft = { ...emptyDraft('legacy-thread'), text: 'legacy unsent draft' }; writeDraft(legacyDraft);
  const migrated = await createOperation('turn/start', { threadId: 'legacy-thread', draftKey: legacyDraft.key, draftRevision: legacyDraft.revision });
  // The imported receipt, unlike a fresh HTTP acceptance, must not clear an old page's draft.
  await operationTransaction(async records => {
    const record = await stored(records.get(migrated.id)) as Operation;
    await stored(records.put({ ...record, legacy: true }));
  });
  await updateOperation(migrated.id, 'accepted');
  await consumeThreadOperations('pending-thread', [unknown.id, terminal.id]);
  await consumeThreadOperations('legacy-thread', [migrated.id]);
  const records = await listOperations();
  expect(records.find(row => row.id === unknown.id)?.consumed).toBeUndefined();
  expect(records.find(row => row.id === terminal.id)?.consumed).toBeUndefined();
  expect(records.find(row => row.id === migrated.id)?.consumed).toBe(true);
  expect(readDraft(legacyDraft.key)).toEqual(legacyDraft);
});

it.each(['queried', 'legacy'] as const)('automatically archives 200-plus ordinary accepted %s receipts without immediate proof loss', async source => {
  const identities: string[] = [];
  if (source === 'legacy') {
    const originals = Array.from({ length: 200 }, () => ({ ...legacy('accepted'), method: 'system/provider/write' }));
    freshLegacy(originals); await initializeOperations(2); identities.push(...originals.map(row => row.id));
  }
  for (let i = 0; i < (source === 'legacy' ? 40 : 240); i++) {
    const record = await createOperation('system/provider/write', {}); identities.push(record.id);
    await updateOperation(record.id, 'unknown');
    await reconcileOperation(record.id, { operationId: record.id, state: 'accepted', result: {} });
    expect((await listOperations()).find(row => row.id === record.id)?.state).toBe('accepted');
  }
  const snapshot = await listOperationHistory();
  expect(snapshot.operations.length).toBeLessThanOrEqual(160);
  expect(snapshot.history.length).toBeGreaterThan(0);
  expect(new Set([...snapshot.operations, ...snapshot.history].map(row => row.id))).toEqual(new Set(identities));
  expect(snapshot.history.every(row => row.state === 'accepted' && row.closed === 'collected')).toBe(true);
});

it('collects a migrated target receipt only after that destination loads, preserving its old draft and history', async () => {
  const draft = { ...emptyDraft('parent'), text: 'old-page draft' };
  const record = { ...legacy('accepted'), method: 'thread/fork', threadId: 'parent', resolvedThreadId: 'child',
    draftKey: draft.key, draftRevision: draft.revision };
  freshLegacy([record]); writeDraft(draft); await initializeOperations(2);
  await consumeThreadOperations('parent', [record.id]);
  expect((await listOperations())[0]?.consumed).toBeUndefined();
  await consumeThreadOperations('child', [record.id]);
  for (let i = 0; i < 160; i++) await createOperation('turn/start', { threadId: `active-${i}` });
  expect((await listOperations()).some(row => row.id === record.id)).toBe(false);
  expect((await listOperationHistory()).history).toContainEqual(expect.objectContaining({ id: record.id,
    state: 'accepted', resolvedThreadId: 'child', closed: 'collected' }));
  expect(readDraft(draft.key)).toEqual(draft);
});

it('keeps accepted terminal and emergency owner proofs during ordinary receipt collection', async () => {
  const unresolved = await createOperation('turn/start', { threadId: 'unknown' });
  await updateOperation(unresolved.id, 'unknown');
  const owner = { clientId: 'owner', connectionId: 'lease' };
  const terminal = await createOperation('terminal/open', { projectId: 'project', terminalOwner: owner });
  await updateOperation(terminal.id, 'accepted', undefined, { terminalId: 'terminal' });
  const recovery = await createOperation('system/recover', {}); await updateOperation(recovery.id, 'accepted');
  for (let i = 0; i < 158; i++) {
    const row = await createOperation('project/add', {}); await updateOperation(row.id, 'accepted');
  }
  const records = await listOperations();
  expect(records.find(row => row.id === terminal.id)).toMatchObject({ state: 'accepted', terminalOwner: owner, terminalResult: { terminalId: 'terminal' } });
  expect(records.find(row => row.id === recovery.id)).toMatchObject({ state: 'accepted', recoveryOperations: [{ id: unresolved.id, method: unresolved.method }] });
  expect(records.find(row => row.id === unresolved.id)?.state).toBe('unknown');
  expect((await listOperationHistory()).history.every(row => row.method === 'project/add')).toBe(true);
});

it('capacity protection retains all unconsumed creations and gives an actionable settings path', async () => {
  for (let index = 0; index < 200; index++) {
    const record = await createOperation('conversation/start', { projectId: `project-${index}` });
    await updateOperation(record.id, 'accepted', `unseen-${index}`);
  }
  await expect(createOperation('turn/start', { threadId: 'another' })).rejects.toThrow('设置 → 操作记录');
  expect(await listOperations()).toHaveLength(200);
});
it('migrates a full localStorage without allocating there before the durable copy, preserving unknown identities', async () => {
  const pending = legacy('pending'), unknown = legacy(), completed = legacy('accepted');
  freshLegacy([pending, unknown, completed]);
  localStorage.setItem(ack + completed.id, '1');
  for (let i = 0; i < 600; i++) localStorage.setItem(ack + crypto.randomUUID(), '1');
  const original = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (this === localStorage && Object.keys(this).some((item) => item.startsWith(ack)))
      throw new DOMException('full localStorage', 'QuotaExceededError');
    original.call(this, key, value);
  });
  await initializeOperations(2);
  expect((await listOperations()).map((record) => record.id).sort()).toEqual([pending.id, unknown.id].sort());
  expect((await listOperations()).every((record) => record.legacy)).toBe(true);
  expect((await listOperationHistory()).history).toEqual([expect.objectContaining({ id: completed.id, state: 'accepted', closed: 'legacy_closed' })]);
  expect(Object.keys(localStorage)).toEqual([primary + 'client-update-required']);
  expect(await createOperation('project/add', {})).toMatchObject({ state: 'pending' });
});
it.each(['record', 'proof', 'mismatched-proof'] as const)('does not block migration for an already closed legacy %s that cannot be saved as history', async failure => {
  const closed = legacy('accepted'), active = legacy(); freshLegacy([closed, active]);
  localStorage.setItem(ack + closed.id, '1');
  if (failure === 'record') localStorage.setItem(primary + closed.id, '{');
  else localStorage.setItem('harness.accepted.v1.' + closed.id, failure === 'proof' ? '{' : JSON.stringify({ ...closed, threadId: 'different' }));
  await initializeOperations(2);
  expect(await listOperations()).toEqual([{ ...active, legacy: true }]);
  expect(await listOperationHistory()).toMatchObject({ history: [], historyWarning: expect.stringContaining('历史损坏') });
  await expect(createOperation('project/add', {})).resolves.toBeDefined();
});
it('does not migrate or dispatch until the authenticated server capability confirms the legacy fence', async () => {
  const record = legacy(); freshLegacy([record]);
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(initializeOperations(undefined)).rejects.toThrow('服务尚未确认');
  await expect(new Api().mutate('project/add')).rejects.toMatchObject({ delivery: 'not_sent' });
  expect(localStorage.getItem(primary + record.id)).toBe(JSON.stringify(record));
  expect(fetch).not.toHaveBeenCalled();
});
it.each(['quota', 'abort'] as const)('keeps every legacy identity and marker if migration encounters %s before commit', async (failure) => {
  const record = legacy(), closed = legacy('accepted'); freshLegacy([record, closed]);
  localStorage.setItem(ack + closed.id, '1');
  const before = { ...localStorage }, original = IDBObjectStore.prototype.add;
  vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (failure === 'quota') throw new DOMException('full database', 'QuotaExceededError');
    const request = original.call(this, value, key); this.transaction.abort(); return request;
  });
  await expect(initializeOperations(2)).rejects.toThrow();
  expect({ ...localStorage }).toEqual(before);
  vi.restoreAllMocks();
  await initializeOperations(2);
  expect(await listOperations()).toEqual([{ ...record, legacy: true }]);
});
it('recovers from a crash after migration commit without reimporting a subsequently acknowledged record', async () => {
  const record = legacy('accepted'); freshLegacy([record]);
  const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('crash before cleanup'); });
  await initializeOperations(2);
  expect(operationStorageWarning()).toContain('crash before cleanup');
  expect(await operationTransaction(async (records, meta) => [await stored(records.count()), await stored(meta.get('legacy-sealed'))])).toEqual([1, true]);
  remove.mockRestore(); await initializeOperations(2, true);
  await acknowledgeOperation(record.id);
  localStorage.setItem(primary + record.id, JSON.stringify({ ...record, state: 'unknown' }));
  await initializeOperations(2, true);
  expect(await listOperations()).toEqual([]);
});
it('consumes a legacy acknowledgement arriving inside migration and never revives its late primary', async () => {
  const record = legacy('accepted'); freshLegacy([record]);
  const original = IDBObjectStore.prototype.add;
  vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value, key) {
    const request = original.call(this, value, key);
    localStorage.setItem(ack + record.id, '1'); localStorage.removeItem(primary + record.id);
    return request;
  });
  await initializeOperations(2);
  expect(await listOperations()).toEqual([]);
  localStorage.setItem(primary + record.id, JSON.stringify(record));
  await initializeOperations(2, true);
  expect(await listOperations()).toEqual([]);
});
it('consumes legacy closure after seal before updating and conservatively retains imported drafts', async () => {
  const draft = { ...emptyDraft('legacy'), text: 'keep' }; writeDraft(draft);
  const record = { ...legacy(), draftKey: draft.key, draftRevision: draft.revision }; freshLegacy([record]);
  await initializeOperations(2);
  await updateOperation(record.id, 'accepted');
  expect(readDraft(draft.key)).toEqual(draft);
  localStorage.setItem(ack + record.id, '1');
  await updateOperation(record.id, 'unknown');
  expect(await listOperations()).toEqual([]);
  expect(localStorage.getItem(ack + record.id)).toBeNull();
  expect((await listOperationHistory()).history).toEqual([expect.objectContaining({ id: record.id, state: 'accepted', closed: 'legacy_closed' })]);
});
it('keeps an acknowledged v1 key disappearing during the snapshot from aborting unrelated migration', async () => {
  const closed = legacy('accepted'), unknown = legacy(); freshLegacy([closed, unknown]);
  const original = Storage.prototype.getItem;
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
    if (key === primary + closed.id) {
      this.setItem(ack + closed.id, '1'); this.removeItem(key); return null;
    }
    return original.call(this, key);
  });
  await initializeOperations(2);
  expect(await listOperations()).toEqual([{ ...unknown, legacy: true }]);
});
it('serializes two tabs creating the same unresolved intent', async () => {
  const attempts = await Promise.allSettled([
    createOperation('turn/start', { threadId: 'same' }), createOperation('turn/start', { threadId: 'same' }),
  ]);
  expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(await listOperations()).toHaveLength(1);
});
it('serializes unknown closure before late acceptance without clearing the draft or recreating the row', async () => {
  const draft = { ...emptyDraft('race'), text: 'retain' }; writeDraft(draft);
  const record = await createOperation('turn/start', { threadId: 'race', draftKey: draft.key, draftRevision: draft.revision });
  await updateOperation(record.id, 'unknown');
  await Promise.all([stopUnknownRecovery(record.id, { operationId: record.id, state: 'unknown' }), updateOperation(record.id, 'accepted')]);
  expect(await listOperations()).toEqual([]); expect(readDraft(draft.key)).toEqual(draft);
});
it('does not downgrade an accepted fact when update, stale failure and acknowledgement race', async () => {
  const record = await createOperation('project/add', {});
  await updateOperation(record.id, 'accepted');
  await Promise.all([acknowledgeOperation(record.id), updateOperation(record.id, 'unknown'), updateOperation(record.id, 'accepted')]);
  expect(await listOperations()).toEqual([]);
});
it.each(['proof', 'cleanup'] as const)('returns actual HTTP acceptance when local %s fails and leaves recovery visible', async (failure) => {
  const fetch = vi.fn().mockImplementation(async () => {
    if (failure === 'proof') vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    else vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(() => { throw new Error('cleanup failed'); });
    return { status: 200, ok: true, json: async () => ({ ok: true, result: { accepted: true } }) };
  });
  vi.stubGlobal('fetch', fetch);
  await expect(new Api().mutate('project/add')).resolves.toEqual({ accepted: true });
  expect(operationStorageWarning()).toContain('存储需要检查');
  vi.restoreAllMocks();
  expect(await listOperations()).toHaveLength(1);
  expect((await listOperations())[0]?.state).toBe(failure === 'proof' ? 'pending' : 'accepted');
});
it('commits before prepare or dispatch and refuses a connection replaced during that wait', async () => {
  const api = new Api(), prepare = vi.fn(), fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const intent = api.beginMutation('project/add', {}, prepare);
  expect(prepare).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  api.connectionChanged();
  await expect(intent.result).rejects.toMatchObject({ delivery: 'not_sent' });
  expect(prepare).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  expect((await listOperations())[0]).toMatchObject({ id: intent.operationId, state: 'not_sent' });
});
it.each(['threadId', 'projectId', 'resourceId', 'draftKey', 'draftRevision', 'resolvedThreadId'] as const)(
  'fails closed on a damaged legacy %s without deleting its identity', async (field) => {
    const record = legacy(); freshLegacy([record]);
    const raw = JSON.stringify({ ...record, [field]: { wrong: true } });
    localStorage.setItem(primary + record.id, raw);
    await expect(initializeOperations(2)).rejects.toThrow('损坏');
    expect(localStorage.getItem(primary + record.id)).toBe(raw);
  },
);
it.each(['method', 'threadId', 'projectId', 'resourceId', 'draftKey', 'draftRevision', 'createdAt', 'terminalOwner'] as const)(
  'rejects a legacy accepted proof with different immutable %s', async (field) => {
    const record = legacy(); freshLegacy([record]);
    localStorage.setItem('harness.accepted.v1.' + record.id, JSON.stringify({ ...record, state: 'accepted',
      [field]: field === 'createdAt' ? 99 : field === 'terminalOwner' ? { clientId: 'other', connectionId: 'other' } : 'different' }));
    await expect(initializeOperations(2)).rejects.toThrow('身份不一致');
    expect(localStorage.getItem(primary + record.id)).toBe(JSON.stringify(record));
  },
);
it('allows durable IDB operations when unrelated localStorage data prevents the optional old-page sentinel', async () => {
  freshLegacy([]); localStorage.setItem('unrelated', 'retained');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
  await initializeOperations(2);
  expect(operationStorageWarning()).toContain('quota');
  const record = await createOperation('project/add', {});
  await updateOperation(record.id, 'accepted'); await acknowledgeOperation(record.id);
  expect(await listOperations()).toEqual([]);
  expect(localStorage.getItem('unrelated')).toBe('retained');
});
it('snapshots nested JSON params before persistence and never clears a newer draft revision', async () => {
  const original = { ...emptyDraft('new:project'), text: 'original' }; writeDraft(original);
  const params = { projectId: 'project', text: 'original', options: { model: 'old' } };
  const fetch = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ ok: true, result: {} }) });
  vi.stubGlobal('fetch', fetch);
  const intent = new Api().beginMutation('conversation/start', params);
  params.text = 'changed'; params.options.model = 'new';
  const newer = { ...emptyDraft(original.key), text: 'changed' }; writeDraft(newer);
  await intent.result;
  expect((await listOperations())[0]).toMatchObject({ id: intent.operationId, draftKey: original.key, draftRevision: original.revision });
  expect(readDraft(original.key)).toEqual(newer);
  expect(JSON.parse(fetch.mock.calls[0]![1].body).params).toEqual({ projectId: 'project', text: 'original', options: { model: 'old' } });
});
it('rejects non-JSON input before durable identity creation or dispatch', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  expect(() => new Api().beginMutation('project/add', cyclic)).toThrow('尚未发送');
  expect(await listOperations()).toEqual([]); expect(fetch).not.toHaveBeenCalled();
});
