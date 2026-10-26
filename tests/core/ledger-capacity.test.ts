import { afterEach, expect, test } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { Ledger } from '../../src/core/ledger.js';
import { LIMITS, type ErrorBody, type JsonObject, type JsonValue, type ReceiptState } from '../../src/core/contracts.js';
import { digest } from '../../src/core/validation.js';

const opened: Ledger[] = [];
const lost: ErrorBody = { code: 'fixture_lost', message: 'The local acknowledgement was lost.', delivery: 'unknown' };
const encoded = (value: unknown) => JSON.stringify(value);
const bytes = (value: unknown) => Buffer.byteLength(encoded(value));
const payload = (size: number): JsonObject => ({ evidence: 'x'.repeat(size - bytes({ evidence: '' })) });
function ledger(file = ':memory:') { const value = new Ledger(file); opened.push(value); return value; }
function close(value: Ledger) { opened.splice(opened.indexOf(value), 1); value.close(); }
function reserve(value: Ledger, method = 'system/provider/write', scope = 'system') {
  const id = value.newOperationId(), params = { evidenceId: id };
  value.reserve(id, method, params, scope); return { id, method, params, scope };
}
function unknown(value: Ledger, method?: string, scope?: string) {
  const row = reserve(value, method, scope); value.dispatch(row.id); value.settle(row.id, { ok: false, error: lost }); return row;
}
function confirm(value: Ledger, row: ReturnType<typeof reserve>, result: JsonValue) {
  return row.method.startsWith('system/') ? value.confirm(row.id, result) : value.confirmWorkspace(row.id, row.method, row.scope, digest({ method: row.method, params: row.params }), result);
}
function usage(value: Ledger) { return value.usage() as JsonObject; }
function assertStoredBytes(file: string, value: Ledger) {
  const db = new DatabaseSync(file);
  try {
    let actual = 0;
    for (const row of db.prepare('SELECT result,error,bytes FROM receipts').all()) {
      const size = Buffer.byteLength(typeof row.result === 'string' ? row.result : '') + Buffer.byteLength(typeof row.error === 'string' ? row.error : '');
      expect(Number(row.bytes)).toBe(size); actual += size;
    }
    expect(usage(value).receiptBytes).toBe(actual); return actual;
  } finally { db.close(); }
}
function legacy() {
  const root = path.resolve('.work/ledger-capacity-tests'); mkdirSync(root, { recursive: true });
  const file = path.join(mkdtempSync(path.join(root, 'case-')), 'journal.sqlite'); new Ledger(file).close();
  const db = new DatabaseSync(file);
  return { file, db, add(state: ReceiptState, result?: JsonValue, error?: ErrorBody, method = 'system/provider/write', scope = 'system') {
    const id = randomUUID(), params = { evidenceId: id };
    db.prepare('INSERT INTO receipts(id,method,scope,digest,state,result,error,bytes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,0,1,1)')
      .run(id, method, scope, digest({ method, params }), state, result === undefined ? null : encoded(result), error === undefined ? null : encoded(error));
    return { id, method, params, scope };
  } };
}
function exportAndRotate(value: Ledger) {
  const preview = value.maintenancePreview() as JsonObject; expect(preview.blocked).toEqual([]);
  let offset: number | null = 0; const hash = createHash('sha256'); let exported = 0;
  while (offset !== null) {
    const chunk = value.maintenanceChunk({ digest: String(preview.digest), offset }) as JsonObject;
    const data = Buffer.from(String(chunk.base64), 'base64'); hash.update(data); exported += data.length; offset = chunk.nextOffset as number | null;
  }
  expect(exported).toBe(preview.bytes); expect(hash.digest('hex')).toBe(preview.digest);
  value.rotate({ digest: String(preview.digest), exportedDigest: String(preview.digest), nextGeneration: Number(preview.nextGeneration) });
}
afterEach(() => { for (const value of opened.splice(0)) value.close(); });

test.each(['system/provider/write', 'workspace/write'])('%s unknown acknowledgements keep their maximum confirmation room until a full journal can export and rotate', method => {
  const value = ledger(), rows: ReturnType<typeof reserve>[] = [], result = payload(LIMITS.receiptBytes);
  for (let index = 0; index < LIMITS.receiptStorageBytes / LIMITS.receiptBytes; index++) rows.push(unknown(value, method, method.startsWith('workspace/') ? 'project:fixture' : 'system'));
  expect(rows).toHaveLength(32); expect(() => reserve(value)).toThrow(expect.objectContaining({ code: 'journal_capacity' }));
  for (const [index, row] of rows.entries()) {
    expect(confirm(value, row, result).state).toBe('accepted');
    expect(usage(value).receiptBytes).toBe((index + 1) * LIMITS.receiptBytes + (rows.length - index - 1) * bytes(lost));
    expect(Number(usage(value).receiptBytes)).toBeLessThanOrEqual(LIMITS.receiptStorageBytes);
    expect(() => reserve(value)).toThrow(expect.objectContaining({ code: 'journal_capacity' }));
  }
  expect(value.getMeta('activityUncertain')).toBe('false');
  for (const row of rows) expect(value.reserve(row.id, row.method, row.params, row.scope).created).toBe(false);
  exportAndRotate(value); expect(usage(value).receiptBytes).toBe(0);
  for (const row of rows) expect(() => value.reserve(row.id, row.method, row.params, row.scope)).toThrow(expect.objectContaining({ code: 'operation_archived' }));
  expect(reserve(value).id).toMatch(/^00000000-0001-8/);
}, 30000);

test('unknown confirmation cannot consume the remaining concurrent pending or dispatching receipt commitments', () => {
  const value = ledger(), rows = Array.from({ length: 32 }, () => reserve(value)), result = payload(LIMITS.receiptBytes);
  for (let index = 0; index < 16; index++) {
    value.dispatch(rows[index]!.id); value.settle(rows[index]!.id, { ok: false, error: lost });
  }
  for (let index = 16; index < 24; index++) value.dispatch(rows[index]!.id);
  for (const row of rows.slice(0, 16)) expect(confirm(value, row, result).state).toBe('accepted');
  expect(() => reserve(value)).toThrow(expect.objectContaining({ code: 'journal_capacity' }));
  for (const row of rows.slice(16)) expect(value.settle(row.id, { ok: true, value: result }).state).toBe('accepted');
  expect(usage(value).receiptBytes).toBe(LIMITS.receiptStorageBytes);
});

test.each(['unknown', 'not_sent'] as const)('oversized error details remain bounded and preserve %s delivery', delivery => {
  const value = ledger(), row = reserve(value); value.dispatch(row.id);
  const saved = value.settle(row.id, { ok: false, error: { code: 'upstream', message: 'too much', delivery, data: '界'.repeat(LIMITS.receiptBytes) } });
  expect(saved).toMatchObject({ state: delivery, error: { code: 'error_capacity', delivery } });
  expect(saved.error).not.toHaveProperty('data'); expect(Number(usage(value).receiptBytes)).toBeLessThan(LIMITS.receiptBytes);
  expect(value.reserve(row.id, row.method, row.params, row.scope).created).toBe(false);
});

test('oversized positive evidence stays unknown and retains capacity for a later bounded positive confirmation', () => {
  const value = ledger(), row = reserve(value); value.dispatch(row.id);
  const saved = value.settle(row.id, { ok: true, value: payload(LIMITS.receiptBytes + 1) });
  expect(saved).toMatchObject({ state: 'unknown', error: { code: 'result_capacity', delivery: 'unknown' } });
  expect(saved).not.toHaveProperty('result'); expect(Number(usage(value).receiptBytes)).toBeLessThan(LIMITS.receiptBytes);
  expect(confirm(value, row, { confirmed: true }).state).toBe('accepted');
});

test('reopening repairs legacy UTF-8 accounting and recovery charges both kinds of interruption without losing prior receipts', () => {
  const old = legacy(), accepted = old.add('accepted', { text: '中文 😀 \u0000 retained' });
  const prior = old.add('unknown', undefined, { code: 'lost', message: '保留原错误', delivery: 'unknown' });
  const before = old.add('pending'), after = old.add('dispatching'); old.db.close();
  let value = ledger(old.file); const initial = assertStoredBytes(old.file, value); expect(initial).toBeGreaterThan(0);
  expect(value.recover()).toEqual({ unknown: 1, notSent: 1 });
  expect(value.read(before.id)).toMatchObject({ state: 'not_sent', error: { delivery: 'not_sent' } });
  expect(value.read(after.id)).toMatchObject({ state: 'unknown', error: { delivery: 'unknown' } });
  const recovered = assertStoredBytes(old.file, value); expect(recovered).toBeGreaterThan(initial);
  expect(value.read(accepted.id)?.result).toEqual({ text: '中文 😀 \u0000 retained' }); expect(value.read(prior.id)?.error?.message).toBe('保留原错误');
  close(value); value = ledger(old.file); expect(value.recover()).toEqual({ unknown: 0, notSent: 0 }); expect(assertStoredBytes(old.file, value)).toBe(recovered);
  expect(value.reserve(after.id, after.method, after.params, after.scope).created).toBe(false);
});

test.each(['system/provider/write', 'workspace/write'])('legacy %s unknown overcommitment permits fitting confirmations one by one without admitting more promises', method => {
  const old = legacy(), rows = Array.from({ length: 40 }, () => old.add('unknown', undefined, lost, method, 'project:legacy')); old.db.close();
  const value = ledger(old.file); expect(() => reserve(value)).toThrow(expect.objectContaining({ code: 'journal_capacity' }));
  for (const [index, row] of rows.entries()) {
    expect(confirm(value, row, { confirmed: row.id }).state).toBe('accepted');
    if (index < 8) expect(() => reserve(value)).toThrow(expect.objectContaining({ code: 'journal_capacity' }));
  }
  expect(assertStoredBytes(old.file, value)).toBeLessThan(LIMITS.receiptStorageBytes);
  expect(value.getMeta('activityUncertain')).toBe('false'); exportAndRotate(value); expect(reserve(value).id).toMatch(/^00000000-0001-8/);
});

test('legacy manager confirmation includes other live promises and never trusts stale byte counters', () => {
  const old = legacy(), result = payload(LIMITS.receiptBytes);
  for (let index = 0; index < 31; index++) old.add('accepted', result);
  const row = old.add('unknown', undefined, lost), pending = old.add('pending'); old.db.close();
  const value = ledger(old.file);
  expect(() => value.confirm(row.id, { confirmed: true })).toThrow(expect.objectContaining({ code: 'journal_capacity', delivery: 'unknown' }));
  expect(value.read(row.id)?.state).toBe('unknown');
  value.settle(pending.id, { ok: false, error: { code: 'cancelled', message: 'not dispatched', delivery: 'not_sent' } });
  expect(value.confirm(row.id, { confirmed: true }).state).toBe('accepted'); expect(assertStoredBytes(old.file, value)).toBeLessThan(LIMITS.receiptStorageBytes);
});

test('workspace confirmation checks identity and capacity before any worktree mutation, then commits both together when room exists', () => {
  const old = legacy(), originId = randomUUID(); old.db.prepare('INSERT INTO projects(id,path,name) VALUES(?,?,?)').run(originId, '/project', 'fixture');
  for (let index = 0; index < 31; index++) old.add('accepted', payload(LIMITS.receiptBytes));
  const row = old.add('unknown', undefined, lost, 'workspace/worktree/create', 'project:' + originId), pending = old.add('dispatching'); old.db.close();
  const value = ledger(old.file), result = { worktreeId: row.id, worktreeVersion: 1, phase: 'active', path: `/native/worktrees/${row.id}`, head: 'a'.repeat(40), revision: 'b'.repeat(64), created: true };
  expect(value.confirmWorkspace(row.id, row.method, row.scope, '0'.repeat(64), result).state).toBe('unknown');
  expect(value.worktrees.list(originId)).toEqual({ data: [] }); expect(value.projects()).toHaveLength(1);
  expect(() => confirm(value, row, result)).toThrow(expect.objectContaining({ code: 'journal_capacity' }));
  expect(value.read(row.id)?.state).toBe('unknown'); expect(value.worktrees.list(originId)).toEqual({ data: [] }); expect(value.projects()).toHaveLength(1);
  value.settle(pending.id, { ok: false, error: { code: 'cancelled', message: 'known rejection', delivery: 'not_sent' } });
  expect(confirm(value, row, result).state).toBe('accepted'); expect(value.projects().some(project => project.id === row.id)).toBe(true);
  expect(value.worktrees.list(originId)).toMatchObject({ data: [{ worktreeId: row.id, worktreeVersion: 1 }] }); expect(assertStoredBytes(old.file, value)).toBeLessThan(LIMITS.receiptStorageBytes);
});

test('already oversized legacy journals remain readable and recovery changes only state when no diagnostic can fit', () => {
  const old = legacy(), result = payload(LIMITS.receiptBytes), accepted = Array.from({ length: 33 }, () => old.add('accepted', result));
  const row = old.add('unknown', undefined, lost), pending = old.add('pending');
  const staleError: ErrorBody = { code: 'old_not_sent', message: 'retained bytes', delivery: 'not_sent' };
  const dispatched = old.add('dispatching', { unconfirmed: 'preserve original evidence' }, staleError); old.db.close();
  const value = ledger(old.file), original = assertStoredBytes(old.file, value); expect(original).toBeGreaterThan(LIMITS.receiptStorageBytes);
  expect(() => reserve(value)).toThrow(expect.objectContaining({ code: 'journal_capacity' })); expect(() => confirm(value, row, payload(bytes(lost)))).toThrow(expect.objectContaining({ code: 'journal_capacity' }));
  expect(value.recover()).toEqual({ unknown: 1, notSent: 1 }); expect(assertStoredBytes(old.file, value)).toBe(original);
  expect(value.read(pending.id)).toMatchObject({ state: 'not_sent' });
  expect(value.read(dispatched.id)).toMatchObject({ state: 'unknown', error: { code: 'old_not_sent', delivery: 'unknown' } }); expect(value.read(dispatched.id)).not.toHaveProperty('result');
  expect(value.read(accepted[0]!.id)?.result).toEqual(result); expect(value.reserve(dispatched.id, dispatched.method, dispatched.params, dispatched.scope).created).toBe(false);
  const db = new DatabaseSync(old.file);
  try { expect(db.prepare('SELECT result,error FROM receipts WHERE id=?').get(dispatched.id)).toEqual({ result: encoded({ unconfirmed: 'preserve original evidence' }), error: encoded(staleError) }); } finally { db.close(); }
});

test('a positive legacy proof that reduces actual excess below the limit can still complete', () => {
  const old = legacy(); for (let index = 0; index < 31; index++) old.add('accepted', payload(LIMITS.receiptBytes));
  const row = old.add('unknown', undefined, { ...lost, data: 'x'.repeat(3 * 1024 * 1024) }); old.db.close();
  const value = ledger(old.file); expect(assertStoredBytes(old.file, value)).toBeGreaterThan(LIMITS.receiptStorageBytes);
  expect(confirm(value, row, { confirmed: true }).state).toBe('accepted'); expect(assertStoredBytes(old.file, value)).toBeLessThan(LIMITS.receiptStorageBytes);
});

test('a physically full legacy journal cannot grow on successful or failed settlement and cannot fabricate acceptance', () => {
  const old = legacy(); for (let index = 0; index < 32; index++) old.add('accepted', payload(LIMITS.receiptBytes));
  const succeeded = old.add('dispatching'), failed = old.add('dispatching'), unsent = old.add('pending'); old.db.close();
  const value = ledger(old.file);
  expect(value.settle(succeeded.id, { ok: true, value: { completed: true } })).toMatchObject({ state: 'unknown' });
  expect(value.read(succeeded.id)).not.toHaveProperty('result');
  expect(value.settle(failed.id, { ok: false, error: lost })).toMatchObject({ state: 'unknown' });
  expect(value.settle(unsent.id, { ok: false, error: { code: 'cancelled', message: 'Never sent', delivery: 'not_sent' } })).toMatchObject({ state: 'not_sent' });
  expect(assertStoredBytes(old.file, value)).toBe(LIMITS.receiptStorageBytes);
  for (const row of [succeeded, failed, unsent]) expect(value.reserve(row.id, row.method, row.params, row.scope).created).toBe(false);
});

test.each(['system/provider/write', 'workspace/write'])('legacy %s excess converges through strictly smaller proofs while equal or growing proofs stay unknown', method => {
  const old = legacy(), exactError: ErrorBody = { ...lost, data: '' };
  exactError.data = 'x'.repeat(LIMITS.receiptBytes - bytes(exactError));
  const rows = Array.from({ length: 34 }, () => old.add('unknown', undefined, exactError, method, 'project:legacy'));
  const smaller = old.add('unknown', undefined, lost, method, 'project:legacy'), pending = old.add('dispatching'); old.db.close();
  const value = ledger(old.file), initial = assertStoredBytes(old.file, value);
  expect(() => confirm(value, rows[0]!, payload(LIMITS.receiptBytes))).toThrow(expect.objectContaining({ code: 'journal_capacity' }));
  expect(() => confirm(value, smaller, payload(LIMITS.receiptBytes))).toThrow(expect.objectContaining({ code: 'journal_capacity' }));
  expect(assertStoredBytes(old.file, value)).toBe(initial);
  expect(confirm(value, rows[0]!, payload(LIMITS.receiptBytes / 2)).state).toBe('accepted');
  const first = assertStoredBytes(old.file, value); expect(first).toBe(initial - LIMITS.receiptBytes / 2); expect(first).toBeGreaterThan(LIMITS.receiptStorageBytes);
  expect(value.read(rows[1]!.id)?.state).toBe('unknown'); expect(value.read(pending.id)?.state).toBe('dispatching');
  // Recovery releases only the old in-flight promise; its uncertainty remains.
  value.recover();
  for (const row of rows.slice(1)) expect(confirm(value, row, payload(LIMITS.receiptBytes / 2)).state).toBe('accepted');
  expect(confirm(value, smaller, { confirmed: true }).state).toBe('accepted');
  expect(confirm(value, pending, { confirmed: true }).state).toBe('accepted');
  expect(assertStoredBytes(old.file, value)).toBeLessThan(LIMITS.receiptStorageBytes); exportAndRotate(value);
}, 30000);
