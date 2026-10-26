import { afterEach, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Ledger } from '../../src/core/ledger.js';
import { digest, object } from '../../src/core/validation.js';
import { HarnessError } from '../../src/core/errors.js';
import type { CallContext, JsonObject, JsonValue, WorkerPort } from '../../src/core/contracts.js';
import { WorkspaceAcknowledgements } from '../../src/gateway/workspace-ack.js';
import { Dispatcher } from '../../src/gateway/dispatch.js';

const ledgers: Ledger[] = [];
afterEach(() => { ledgers.splice(0).forEach(ledger => ledger.close()); vi.restoreAllMocks(); });
function setup() {
  const ledger = new Ledger(':memory:'); ledgers.push(ledger);
  const proofs = new Map<string, JsonObject>(), calls: string[] = [];
  let failAck = false, outstanding = 0, maxOutstanding = 0;
  const worker: WorkerPort = { connected: true, async call(method, params, context) {
    calls.push(method); context.beforeWrite?.();
    if (method === 'runtime/maintenance/check') return { idle: true, workspaceWitness: { total: proofs.size, unresolved: 0, limit: 2000 } };
    if (method === 'workspace/witness/pending') {
      const items = [...proofs.values()].filter(proof => proof.state === 'completed' && String(proof.operationId) > String(params.after ?? '')).sort((a, b) => String(a.operationId).localeCompare(String(b.operationId)));
      const rows = items.slice(0, Number(params.limit));
      return { data: rows, nextCursor: items.length > rows.length ? rows.at(-1)!.operationId! : null };
    }
    const id = String(params.operationId), proof = proofs.get(id);
    if (method === 'workspace/witness/read') return proof ?? { operationId: id, state: 'not_received' };
    if (method === 'workspace/witness/ack') {
      expect(ledger.read(id)?.state).toBe('accepted');
      outstanding++; maxOutstanding = Math.max(maxOutstanding, outstanding); await Promise.resolve(); outstanding--;
      if (failAck) throw new HarnessError('helper_unavailable', 'retry cleanup');
      if (proof && ['method', 'projectId', 'gatewayRequestDigest', 'resultDigest'].some(key => proof[key] !== params[key])) throw new HarnessError('operation_conflict', 'proof mismatch');
      proofs.delete(id); return { acknowledged: true, operationId: id, removed: !!proof };
    }
    throw new Error('Unexpected ' + method);
  } };
  const ack = new WorkspaceAcknowledgements(ledger, worker), context: CallContext = { clientId: 'browser', requireConnection() {} };
  function record(state: 'accepted' | 'unknown' = 'accepted') {
    const operationId = randomUUID(), projectId = randomUUID(), method = 'workspace/mkdir', params = { projectId, path: 'folder' }, result = { path: 'folder', created: true };
    ledger.reserve(operationId, method, params, 'project:' + projectId); ledger.dispatch(operationId);
    const receipt = ledger.settle(operationId, state === 'accepted' ? { ok: true, value: result } : { ok: false, error: { code: 'lost', message: 'lost', delivery: 'unknown' } });
    const proof = { operationId, method, projectId, gatewayRequestDigest: digest({ method, params }), resultDigest: digest(result), result, state: 'completed' };
    proofs.set(operationId, proof); return { receipt, proof };
  }
  return { ledger, worker, proofs, calls, ack, context, record, fail() { failAck = true; }, recover() { failAck = false; }, maxOutstanding: () => maxOutstanding };
}

test('gateway durable acceptance is required before cleanup and acknowledgement failures preserve it', async () => {
  const f = setup(), { receipt, proof } = f.record(); f.fail();
  await f.ack.accepted(receipt, f.context, proof.gatewayRequestDigest);
  expect(f.ledger.read(receipt.operationId)?.state).toBe('accepted'); expect(f.proofs.size).toBe(1);
  f.recover(); await f.ack.accepted(receipt, f.context);
  expect(f.proofs.size).toBe(0); expect(f.ledger.read(receipt.operationId)?.state).toBe('accepted');
});

test.each(['method', 'projectId', 'gatewayRequestDigest', 'resultDigest'])('sweep keeps witnesses with mismatched %s', async field => {
  const f = setup(), { proof } = f.record(); f.proofs.set(proof.operationId, { ...proof, [field]: field === 'projectId' ? randomUUID() : 'mismatch' });
  await expect(f.ack.drain(f.context)).rejects.toMatchObject({ code: 'journal_busy' });
  expect(f.proofs.size).toBe(1); expect(f.calls).not.toContain('workspace/witness/ack');
});

test('unknown receipts and orphan witnesses prevent maintenance instead of silently dropping proof', async () => {
  const f = setup(); f.record('unknown');
  await expect(f.ack.drain(f.context)).rejects.toMatchObject({ code: 'journal_busy' });
  expect(f.proofs.size).toBe(1); expect(f.calls).not.toContain('workspace/witness/ack');
});

test('drain walks every bounded page with at most four concurrent helper cleanups', async () => {
  const f = setup(); for (let index = 0; index < 130; index++) f.record();
  await f.ack.drain(f.context);
  expect(f.proofs.size).toBe(0); expect(f.maxOutstanding()).toBeLessThanOrEqual(4);
  expect(f.calls.filter(method => method === 'workspace/witness/pending')).toHaveLength(3);
});

test('opportunistic cleanup is bounded, throttled and resumes beyond unmatched first page', async () => {
  const f = setup(); for (let index = 0; index < 12; index++) f.record();
  const sorted = [...f.proofs.keys()].sort();
  for (const id of sorted.slice(0, 8)) f.proofs.get(id)!.gatewayRequestDigest = 'wrong';
  let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  f.ack.opportunistic(f.context); await vi.waitFor(() => expect(f.calls.filter(method => method === 'workspace/witness/pending')).toHaveLength(1));
  await new Promise(resolve => setImmediate(resolve));
  f.ack.opportunistic(f.context); expect(f.calls.filter(method => method === 'workspace/witness/pending')).toHaveLength(1);
  now += 30_001; f.ack.opportunistic(f.context);
  await vi.waitFor(() => expect(f.proofs.size).toBe(8));
});

test('dispatcher acknowledges only after settle and positive unknown-operation confirmation', async () => {
  const f = setup(), dispatcher = new Dispatcher(f.ledger, f.worker, { async call() { return {}; } });
  dispatcher.event({ type: 'state', data: { connected: true, activity: { activeThreads: [], pendingStarts: 0, terminals: 0, unknown: false } } });
  const project = f.ledger.addProject('/registered', 'test'), original = f.worker.call.bind(f.worker);
  f.worker.call = async (method, params, context) => {
    if (method !== 'workspace/mkdir') return original(method, params, context);
    context.beforeWrite?.(); const result = { path: params.path!, created: true };
    f.proofs.set(context.operationId!, { operationId: context.operationId!, method, projectId: project.id, gatewayRequestDigest: context.gatewayRequestDigest!, resultDigest: digest(result), result, state: 'completed' });
    return result;
  };
  const operationId = randomUUID();
  await dispatcher.call({ method: 'workspace/mkdir', operationId, params: { projectId: project.id, path: 'created' } }, { clientId: 'browser' });
  expect(f.proofs.size).toBe(0); expect(f.ledger.read(operationId)?.state).toBe('accepted');
  const unknown = f.record('unknown');
  const result = await dispatcher.call({ method: 'operation/read', params: { operationId: unknown.receipt.operationId } }, { clientId: 'browser' }); object(result);
  expect(result.state).toBe('accepted'); expect(f.proofs.size).toBe(0);
});
