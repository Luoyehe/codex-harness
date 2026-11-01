import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { Ledger } from '../../src/core/ledger.js';
import { LIMITS, type JsonObject } from '../../src/core/contracts.js';

const params = { confirmStop: true }, result = { restarted: true, release: 'a'.repeat(64) };
const ordinary = (ledger: Ledger) => { const id = ledger.newOperationId(); ledger.reserve(id, 'workspace/write', {}, 'project:fixture'); return id; };
const recovery = (ledger: Ledger) => { const id = ledger.newOperationId(); return { id, reserved: ledger.reserve(id, 'system/recover', params, 'system') }; };

it('keeps exactly one small emergency receipt beyond ordinary count capacity, surviving restart and retaining original evidence', () => {
  const parent = path.resolve('.work/emergency-ledger'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'count-')), file = path.join(directory, 'journal.sqlite');
  let ledger = new Ledger(file);
  try {
    ledger.close();
    const db = new DatabaseSync(file);
    try {
      db.exec('BEGIN'); const insert = db.prepare("INSERT INTO receipts(id,method,scope,digest,state,result,bytes,created_at,updated_at) VALUES(?,'project/remove','p','fixture','accepted','{}',2,1,1)");
      for (let index = 0; index < LIMITS.receiptCount; index++) insert.run(randomUUID()); db.exec('COMMIT');
    } finally { db.close(); }
    ledger = new Ledger(file);
    expect(() => ordinary(ledger)).toThrow(expect.objectContaining({ code: 'journal_capacity' }));
    const emergency = recovery(ledger); ledger.dispatch(emergency.id); ledger.settle(emergency.id, { ok: true, value: result });
    expect((ledger.usage() as JsonObject).receipts).toBe(LIMITS.receiptCount + 1);
    ledger.close(); ledger = new Ledger(file);
    expect(ledger.reserve(emergency.id, 'system/recover', params, 'system')).toMatchObject({ created: false, receipt: { state: 'accepted', result } });
    expect(() => recovery(ledger)).toThrow(expect.objectContaining({ code: 'journal_capacity' }));
    expect(() => ordinary(ledger)).toThrow(expect.objectContaining({ code: 'journal_capacity' }));
    const preview = ledger.maintenancePreview() as JsonObject;
    ledger.rotate({ digest: String(preview.digest), exportedDigest: String(preview.digest), nextGeneration: Number(preview.nextGeneration) });
    expect(ledger.read(emergency.id)).toMatchObject({ state: 'unknown', error: { code: 'operation_archived' } });
    expect(recovery(ledger).reserved.created).toBe(true);
  } finally { ledger.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('preserves every ordinary pending byte commitment while admitting one bounded emergency acknowledgement', () => {
  const ledger = new Ledger(':memory:');
  try {
    const ordinaryIds = Array.from({ length: LIMITS.receiptStorageBytes / LIMITS.receiptBytes }, () => ordinary(ledger));
    expect(() => ordinary(ledger)).toThrow(expect.objectContaining({ code: 'journal_capacity' }));
    const emergency = recovery(ledger); ledger.dispatch(emergency.id);
    ledger.settle(emergency.id, { ok: true, value: result });
    expect(() => recovery(ledger)).toThrow(expect.objectContaining({ code: 'journal_capacity' }));
    const payload = 'x'.repeat(LIMITS.receiptBytes - 2);
    for (const id of ordinaryIds) expect(ledger.settle(id, { ok: true, value: payload }).state).toBe('accepted');
    expect((ledger.usage() as JsonObject).receiptBytes).toBe(LIMITS.receiptStorageBytes + Buffer.byteLength(JSON.stringify(result)));
    expect(() => ordinary(ledger)).toThrow(expect.objectContaining({ code: 'journal_capacity' }));
  } finally { ledger.close(); }
});

it.each(['result', 'error'] as const)('bounds oversized emergency %s and retains its single reserved identity until archival', kind => {
  const ledger = new Ledger(':memory:');
  try {
    Array.from({ length: LIMITS.receiptStorageBytes / LIMITS.receiptBytes }, () => ordinary(ledger));
    const emergency = recovery(ledger); ledger.dispatch(emergency.id);
    const saved = ledger.settle(emergency.id, kind === 'result' ? { ok: true, value: 'x'.repeat(LIMITS.recoveryReceiptBytes) }
      : { ok: false, error: { code: 'lost', message: 'unknown', delivery: 'unknown', data: 'x'.repeat(LIMITS.recoveryReceiptBytes) } });
    expect(saved).toMatchObject({ state: 'unknown', error: { code: kind === 'result' ? 'result_capacity' : 'error_capacity' } });
    expect(() => recovery(ledger)).toThrow(expect.objectContaining({ code: 'journal_capacity' }));
    expect(() => ledger.confirm(emergency.id, 'x'.repeat(LIMITS.recoveryReceiptBytes))).toThrow();
    expect(ledger.confirm(emergency.id, result)).toMatchObject({ state: 'accepted', result });
    expect(() => recovery(ledger)).toThrow(expect.objectContaining({ code: 'journal_capacity' }));
  } finally { ledger.close(); }
});
