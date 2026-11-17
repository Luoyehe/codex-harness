import { afterEach, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Ledger } from '../../src/core/ledger.js';
import { ReceiptMaintenance } from '../../src/gateway/receipt-maintenance.js';
import { Dispatcher } from '../../src/gateway/dispatch.js';
import type { JsonObject, WorkerPort } from '../../src/core/contracts.js';
const ledgers: Ledger[] = [];
afterEach(() => { for (const ledger of ledgers.splice(0)) ledger.close(); });
function fixture() {
  const ledger = new Ledger(':memory:'); ledgers.push(ledger);
  const maintenance = new ReceiptMaintenance(ledger);
  const context = { clientId: 'connection-one', requireConnection: () => {} };
  const preview = maintenance.call('operation/maintenance/preview', {}, context) as JsonObject;
  const params = { exportId: preview.exportId!, digest: preview.digest!, nextGeneration: preview.nextGeneration!, exportedDigest: preview.digest!, confirm: true };
  return { ledger, maintenance, context, preview, params };
}
test('rotation needs the complete server-tracked export from the exact live connection', () => {
  const { maintenance, context, preview, params } = fixture();
  expect(() => maintenance.validateRotation(params, context)).toThrow();
  expect(() => maintenance.call('operation/maintenance/chunk', { exportId: preview.exportId!, digest: preview.digest!, offset: 0 }, { ...context, clientId: 'connection-two' })).toThrow();
  const chunk = maintenance.call('operation/maintenance/chunk', { exportId: preview.exportId!, digest: preview.digest!, offset: 0 }, context) as JsonObject;
  expect(chunk.nextOffset).toBeNull();
  expect(maintenance.validateRotation(params, context).digest).toBe(preview.digest);
  expect(() => maintenance.validateRotation({ ...params, confirm: false }, context)).toThrow();
  maintenance.forget(context.clientId); expect(() => maintenance.validateRotation(params, context)).toThrow();
});
test('disconnect, expiry and subsequent journal writes cannot authorize stale rotation', () => {
  const { ledger, context } = fixture(); let now = 0;
  const maintenance = new ReceiptMaintenance(ledger, () => now);
  const preview = maintenance.call('operation/maintenance/preview', {}, context) as JsonObject;
  maintenance.call('operation/maintenance/chunk', { exportId: preview.exportId!, digest: preview.digest!, offset: 0 }, context);
  const params = { exportId: preview.exportId!, digest: preview.digest!, nextGeneration: preview.nextGeneration!, exportedDigest: preview.digest!, confirm: true };
  const id = randomUUID(); ledger.reserve(id, 'project/remove', {}, 'project'); ledger.settle(id, { ok: true, value: {} });
  expect(() => ledger.rotate(maintenance.validateRotation(params, context))).toThrow();
  now = 600001; expect(() => maintenance.validateRotation(params, context)).toThrow();
});
test('dispatcher locks mutation admission while worker idle proof is outstanding and publishes generation', async () => {
  const { ledger, context } = fixture(); let release!: (value: JsonObject) => void;
  const worker: WorkerPort = { connected: true, call: vi.fn(async () => new Promise<JsonObject>(resolve => { release = resolve; })) };
  const dispatcher = new Dispatcher(ledger, worker, { call: async () => ({}) });
  dispatcher.event({ type: 'state', data: { connected: true, activity: { activeThreads: [], pendingStarts: 0, terminals: 0, unknown: false } } });
  vi.spyOn(dispatcher.workspaceAcknowledgements, 'drain').mockResolvedValue();
  const preview = await dispatcher.call({ method: 'operation/maintenance/preview', params: {} }, context) as JsonObject;
  await dispatcher.call({ method: 'operation/maintenance/chunk', params: { exportId: preview.exportId!, digest: preview.digest!, offset: 0 } }, context);
  const pending = dispatcher.call({ method: 'operation/maintenance/rotate', params: { exportId: preview.exportId!, digest: preview.digest!, nextGeneration: preview.nextGeneration!, exportedDigest: preview.digest!, confirm: true } }, context);
  await Promise.resolve();
  expect(dispatcher.maintenanceActive()).toBe(true);
  // A concurrent rejected write changes the export, so even that receipt must
  // force another export rather than disappearing during this rotation.
  await expect(dispatcher.call({ method: 'project/remove', params: { id: 'missing' }, operationId: randomUUID() }, context)).rejects.toMatchObject({ code: 'maintenance' });
  release({ idle: true, workspaceWitness: { total: 0 } });
  await expect(pending).rejects.toMatchObject({ code: 'journal_changed' });
  expect(dispatcher.maintenanceActive()).toBe(false); expect(ledger.operationGeneration()).toBe(0);
});

test('two gateway connections independently export sequential snapshots and only the current complete export rotates', async () => {
  const ledger = new Ledger(':memory:'); ledgers.push(ledger);
  const worker: WorkerPort = { connected: true, call: async () => ({ idle: true, workspaceWitness: { total: 0 } }) };
  const dispatcher = new Dispatcher(ledger, worker, { call: async () => ({}) });
  dispatcher.event({ type: 'state', data: { connected: true, activity: { activeThreads: [], pendingStarts: 0, terminals: 0, unknown: false } } });
  vi.spyOn(dispatcher.workspaceAcknowledgements, 'drain').mockResolvedValue();
  const first = { clientId: 'tab-a', requireConnection: () => {} }, second = { ...first, clientId: 'tab-b' };
  const call = (method: string, params: JsonObject, context = first) => dispatcher.call({ method: 'operation/maintenance/' + method, params }, context);
  const a = await call('preview', {}) as JsonObject;
  const chunkA = await call('chunk', { exportId: a.exportId!, digest: a.digest!, offset: 0, limit: 16 }) as JsonObject;
  const id = randomUUID(); ledger.reserve(id, 'project/remove', {}, 'project'); ledger.settle(id, { ok: true, value: {} });
  const b = await call('preview', {}, second) as JsonObject;
  expect(a.digest).not.toBe(b.digest);
  await expect(call('chunk', { exportId: a.exportId!, digest: a.digest!, offset: chunkA.nextOffset! }, second)).rejects.toMatchObject({ code: 'archive_expired' });
  await expect(call('chunk', { exportId: a.exportId!, digest: a.digest!, offset: 0 })).rejects.toMatchObject({ code: 'invalid' });
  await expect(call('rotate', { exportId: b.exportId!, digest: b.digest!, nextGeneration: b.nextGeneration!, exportedDigest: b.digest!, confirm: true }, second)).rejects.toMatchObject({ code: 'archive_required' });
  const tailA = await call('chunk', { exportId: a.exportId!, digest: a.digest!, offset: chunkA.nextOffset! }) as JsonObject;
  expect(tailA.nextOffset).toBeNull();
  expect(JSON.parse(Buffer.concat([Buffer.from(String(chunkA.base64), 'base64'), Buffer.from(String(tailA.base64), 'base64')]).toString()).receipts).toEqual([]);
  await expect(call('rotate', { exportId: a.exportId!, digest: a.digest!, nextGeneration: a.nextGeneration!, exportedDigest: a.digest!, confirm: true })).rejects.toMatchObject({ code: 'journal_changed' });
  const fullB = await call('chunk', { exportId: b.exportId!, digest: b.digest!, offset: 0 }, second) as JsonObject;
  expect(JSON.parse(Buffer.from(String(fullB.base64), 'base64').toString()).receipts).toHaveLength(1);
  await expect(call('rotate', { exportId: b.exportId!, digest: b.digest!, nextGeneration: b.nextGeneration!, exportedDigest: b.digest!, confirm: true }, second)).resolves.toMatchObject({ rotated: true, generation: 1 });
  await expect(call('chunk', { exportId: a.exportId!, digest: a.digest!, offset: tailA.totalBytes! })).rejects.toMatchObject({ code: 'archive_expired' });
});

test('capacity, own-preview replacement and disconnect preserve the other gateway export', () => {
  const { ledger, maintenance, context: a } = fixture();
  const b = { ...a, clientId: 'tab-b' }, c = { ...a, clientId: 'tab-c' };
  const preview = (context: typeof a) => maintenance.call('operation/maintenance/preview', {}, context) as JsonObject;
  const change = () => { const id = randomUUID(); ledger.reserve(id, 'project/remove', {}, 'project'); ledger.settle(id, { ok: true, value: {} }); };
  change(); const retainedB = preview(b); preview(a); // Both owners now share one snapshot.
  expect(() => preview(c)).toThrow('两个页面');
  change(); preview(a); change(); preview(a); // Replacing A must not evict B's older snapshot.
  maintenance.forget(a.clientId); const admittedC = preview(c);
  const chunkB = maintenance.call('operation/maintenance/chunk', { exportId: retainedB.exportId!, digest: retainedB.digest!, offset: 0 }, b) as JsonObject;
  expect(JSON.parse(Buffer.from(String(chunkB.base64), 'base64').toString()).receipts).toHaveLength(1);
  maintenance.forget(c.clientId);
  expect(() => maintenance.validateRotation({ exportId: retainedB.exportId!, digest: retainedB.digest!, nextGeneration: retainedB.nextGeneration!, exportedDigest: retainedB.digest!, confirm: true }, b)).not.toThrow();
  expect(() => maintenance.call('operation/maintenance/chunk', { exportId: admittedC.exportId!, digest: admittedC.digest!, offset: 0 }, c)).toThrow('归档已过期');
});

test('one expiring connection releases only its lease even when both exports share bytes', () => {
  let now = 0; const ledger = new Ledger(':memory:', () => now); ledgers.push(ledger);
  const maintenance = new ReceiptMaintenance(ledger, () => now);
  const a = { clientId: 'a' }, b = { clientId: 'b' }, c = { clientId: 'c' };
  const first = maintenance.call('operation/maintenance/preview', {}, a) as JsonObject;
  now = 1000; const second = maintenance.call('operation/maintenance/preview', {}, b) as JsonObject;
  expect(first.digest).toBe(second.digest);
  now = 600000; maintenance.call('operation/maintenance/preview', {}, c);
  expect(() => maintenance.call('operation/maintenance/chunk', { exportId: first.exportId!, digest: first.digest!, offset: 0 }, a)).toThrow('归档已过期');
  expect(maintenance.call('operation/maintenance/chunk', { exportId: second.exportId!, digest: second.digest!, offset: 0 }, b)).toMatchObject({ nextOffset: null });
});
