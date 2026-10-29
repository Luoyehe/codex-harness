// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { Api } from '../lib/api';
import {
  acknowledgeOperation, createOperation, initializeOperations, listOperations, operationStorageWarning,
  stopUnknownRecovery, updateOperation, type Operation,
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

it('handles sustained completed operations with constant recovery metadata and no tombstones', async () => {
  for (let i = 0; i < 1200; i++) {
    const operation = await createOperation('project/add', {});
    await updateOperation(operation.id, 'accepted');
    await acknowledgeOperation(operation.id);
  }
  expect(await listOperations()).toEqual([]);
  expect(Object.keys(localStorage).filter((key) => key.startsWith(ack))).toEqual([]);
  expect(await operationTransaction(async (records, metadata) => [await stored(records.count()), await stored(metadata.count())])).toEqual([0, 1]);
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
  expect(Object.keys(localStorage)).toEqual([primary + 'client-update-required']);
  expect(await createOperation('project/add', {})).toMatchObject({ state: 'pending' });
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
