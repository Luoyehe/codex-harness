// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { captureEmergencyOperations, closeEmergencyOperations } from '../lib/emergency-recovery';
import { createOperation, listOperations, updateOperation, type Operation } from '../lib/operations';
import { emptyDraft, readDraft, writeDraft } from '../lib/drafts';

const proof = (id: string = crypto.randomUUID()) => ({ operationId: id, method: 'system/recover', state: 'accepted',
  result: { restarted: true, release: 'a'.repeat(64) } });
const response = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('closes only captured proven unknown reminders, keeping drafts, server facts, and later operations', async () => {
  const api = new Api(), draft = { ...emptyDraft('thread'), text: 'retained draft' }; writeDraft(draft);
  const old = await createOperation('turn/start', { threadId: 'thread', draftKey: 'thread', draftRevision: draft.revision });
  await updateOperation(old.id, 'unknown');
  const recovery = await createOperation('system/recover', {});
  const captured = captureEmergencyOperations(await listOperations());
  const later = await createOperation('mcp/oauth', {});
  const server = { operationId: old.id, method: old.method, state: 'unknown', error: { code: 'unknown' } };
  const original = structuredClone(server);
  const fetch = vi.fn(async (_url, init) => {
    expect(JSON.parse(init.body)).toEqual({ method: 'operation/read', params: { operationId: old.id } });
    return response(server);
  }); vi.stubGlobal('fetch', fetch);
  const done = await closeEmergencyOperations(api, captured, recovery.id, proof(recovery.id));
  expect(done).toEqual({ closedIds: [old.id], retainedIds: [], errors: [], interrupted: false });
  expect(fetch).toHaveBeenCalledTimes(1); expect(server).toEqual(original);
  expect(readDraft('thread')).toEqual(draft);
  expect(new Set((await listOperations()).map(row => row.id))).toEqual(new Set([recovery.id, later.id]));
});

it('does not reconcile accepted or not-sent receipts, nor close missing, pending, dispatched or mismatched identities', async () => {
  const api = new Api(), rows: Operation[] = [];
  for (let i = 0; i < 7; i++) {
    const row = await createOperation('turn/start', { threadId: String(i) }); await updateOperation(row.id, 'unknown'); rows.push(row);
  }
  const replies = [
    { state: 'accepted', result: {} }, { state: 'not_sent' }, { state: 'not_received' }, { state: 'pending' },
    { state: 'dispatching' }, { state: 'unknown', method: 'other' }, { state: 'unknown', operationId: crypto.randomUUID() },
  ];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const id = JSON.parse(init.body).params.operationId, index = rows.findIndex(row => row.id === id), row = rows[index]!;
    return response({ operationId: row.id, method: row.method, ...replies[index] });
  }));
  const accepted = proof(); const done = await closeEmergencyOperations(api, captureEmergencyOperations(await listOperations()), accepted.operationId, accepted);
  expect(done.closedIds).toEqual([]); expect(done.retainedIds).toHaveLength(7);
  expect((await listOperations()).every(row => row.state === 'unknown')).toBe(true);
});

it('rejects unrelated or incomplete recovery proof before any reads and never guesses a missing snapshot', async () => {
  const api = new Api(), row = await createOperation('mcp/oauth', {}), captured = captureEmergencyOperations([row]);
  const accepted = proof(), fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  for (const invalid of [{ ...accepted, operationId: crypto.randomUUID() }, { ...accepted, method: 'system/restart' },
    { ...accepted, state: 'unknown' }, { ...accepted, result: { restarted: true } },
    { ...accepted, result: { restarted: false, release: 'a'.repeat(64) } },
    { ...accepted, result: { restarted: true, release: 'bad' } },
    { ...accepted, result: { ...accepted.result, extra: true } }])
    await expect(closeEmergencyOperations(api, captured, accepted.operationId, invalid)).rejects.toThrow('成功证明');
  expect(await closeEmergencyOperations(api, [], accepted.operationId, accepted)).toMatchObject({ closedIds: [], retainedIds: [] });
  expect(fetch).not.toHaveBeenCalled(); expect(await listOperations()).toHaveLength(1);
});

it('uses no more than four readers and a single deadline, without retrying or reading remaining work after abort', async () => {
  const api = new Api(), rows: Operation[] = [];
  for (let i = 0; i < 9; i++) rows.push(await createOperation('turn/start', { threadId: String(i) }));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let active = 0, peak = 0;
  const fetch = vi.fn((_url, init) => new Promise((_resolve, reject) => {
    active++; peak = Math.max(active, peak);
    init.signal.addEventListener('abort', () => { active--; reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  })); vi.stubGlobal('fetch', fetch);
  const accepted = proof(), pending = closeEmergencyOperations(api, captureEmergencyOperations(rows), accepted.operationId, accepted);
  expect(fetch).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(12_000);
  const done = await pending;
  expect(peak).toBe(4); expect(active).toBe(0); expect(fetch).toHaveBeenCalledTimes(4);
  expect(done.closedIds).toEqual([]); expect(done.retainedIds).toHaveLength(9); expect(done.interrupted).toBe(true);
});

it('keeps partial read errors and a concurrent accepted local fact while closing other proven unknowns', async () => {
  const api = new Api(), rows: Operation[] = [];
  for (let i = 0; i < 3; i++) rows.push(await createOperation('turn/start', { threadId: String(i) }));
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const id = JSON.parse(init.body).params.operationId;
    if (id === rows[0]!.id) throw new Error('offline');
    if (id === rows[1]!.id) await updateOperation(id, 'accepted');
    return response({ operationId: id, method: 'turn/start', state: 'unknown' });
  }));
  const accepted = proof(), done = await closeEmergencyOperations(api, captureEmergencyOperations(rows), accepted.operationId, accepted);
  expect(done.closedIds).toEqual([rows[2]!.id]); expect(done.retainedIds).toEqual([rows[0]!.id, rows[1]!.id]);
  expect(done.errors).toHaveLength(2);
  expect((await listOperations()).find(row => row.id === rows[1]!.id)?.state).toBe('accepted');
});

it('copies and bounds the explicit snapshot, and leaves every record on prior cancellation or changed login', async () => {
  const api = new Api(), row = await createOperation('mcp/oauth', {}), rows = [row], captured = captureEmergencyOperations(rows);
  rows.length = 0; expect(captured).toEqual([{ id: row.id, method: row.method }]);
  expect(Object.isFrozen(captured)).toBe(true);
  expect(() => captureEmergencyOperations(Array(201).fill(row))).toThrow('预算');
  const accepted = proof(), controller = new AbortController(); controller.abort();
  const fetch = vi.fn(async () => { api.csrf = 'new-login'; return response({ operationId: row.id, method: row.method, state: 'unknown' }); });
  vi.stubGlobal('fetch', fetch);
  expect(await closeEmergencyOperations(api, captured, accepted.operationId, accepted, controller.signal)).toMatchObject({ closedIds: [], interrupted: true });
  expect(fetch).not.toHaveBeenCalled();
  expect(await closeEmergencyOperations(api, captured, accepted.operationId, accepted)).toMatchObject({ closedIds: [], retainedIds: [row.id], interrupted: true });
  expect((await listOperations())[0]?.state).toBe('pending');
});
