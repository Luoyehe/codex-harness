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
