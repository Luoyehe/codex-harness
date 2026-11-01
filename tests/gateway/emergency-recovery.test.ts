import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { CallContext, JsonObject, JsonValue, WorkerPort } from '../../src/core/contracts.js';
import { HarnessError } from '../../src/core/errors.js';
import { Ledger } from '../../src/core/ledger.js';
import { digest } from '../../src/core/validation.js';
import { Dispatcher } from '../../src/gateway/dispatch.js';
import type { ManagerPort } from '../../src/gateway/manager-client.js';
import { receiptResult } from '../../src/gateway/receipt-result.js';
import { requireRecoveryProtocol } from '../../src/gateway/recovery-protocol.js';

const accepted = { restarted: true, release: 'a'.repeat(64) };
const owner: CallContext = { clientId: 'owner' };
const recover = () => ({ method: 'system/recover', params: { confirmStop: true }, operationId: randomUUID() });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const ledger = new Ledger(':memory:');
  const worker: WorkerPort = { connected: true, call: vi.fn(async (_method, _params, context) => { context.beforeWrite?.(); return {}; }) };
  const manager: ManagerPort = { call: vi.fn(async (_method, _params, _id, before) => { before?.(); return accepted; }) };
  const dispatcher = new Dispatcher(ledger, worker, manager);
  dispatcher.event({ type: 'state', data: { connected: true, activity: { activeThreads: [], pendingStarts: 0, terminals: 0, unknown: false } } });
  return { ledger, worker, manager, dispatcher };
}

describe('explicit stop-confirmed recovery admission', () => {
  it('requires exact confirmation and the current mutation protocol before any dispatch', async () => {
    const f = fixture();
    try {
      for (const params of [{}, { confirmStop: false }, { confirmStop: 1 }, { confirmStop: true, command: 'other' }]) {
        const call = { ...recover(), params };
        await expect(f.dispatcher.call(call, owner)).rejects.toMatchObject({ code: 'invalid', delivery: 'not_sent' });
        expect(f.ledger.read(call.operationId)).toBeNull();
      }
      expect(f.manager.call).not.toHaveBeenCalled();
      expect(() => requireRecoveryProtocol('system/recover', undefined)).toThrow(expect.objectContaining({ code: 'client_update_required' }));
      expect(() => requireRecoveryProtocol('system/recover', '2')).not.toThrow();
    } finally { f.ledger.close(); }
  });

  it('reaches the manager with disconnected/unknown activity, preserving prior unknown OAuth evidence', async () => {
    const f = fixture(), old = randomUUID(), call = recover();
    try {
      f.ledger.reserve(old, 'mcp/oauth', { name: 'fixture' }, 'mcp/oauth'); f.ledger.dispatch(old);
      f.ledger.settle(old, { ok: false, error: { code: 'login_outcome_unknown', message: 'Unknown', delivery: 'unknown' } });
      const original = f.ledger.read(old);
      f.worker.connected = false; f.dispatcher.disconnected();
      const context = { ...owner, requireConnection() { throw new Error('No live browser'); } };
      expect(await f.dispatcher.call(call, context)).toEqual(accepted);
      expect(await f.dispatcher.call(call, context)).toEqual(accepted);
      expect(f.manager.call).toHaveBeenCalledTimes(1);
      expect(f.manager.call).toHaveBeenCalledWith('recover', { confirmStop: true }, call.operationId, expect.any(Function));
      expect(f.ledger.read(old)).toEqual(original);
      // A gateway acknowledgement is not proof of a cleared activity barrier.
      // Only the stopped-manager path writes that barrier in the real journal.
      expect(f.ledger.getMeta('activityUncertain')).toBe('true');
    } finally { f.ledger.close(); }
  });

  it('can stop an in-flight submission without resending it or converting its unknown outcome', async () => {
    const f = fixture(), finish = deferred<JsonValue>(), stop = deferred<JsonValue>(), old = randomUUID();
    f.worker.call = vi.fn(async (_method, _params, context) => { context.beforeWrite?.(); return finish.promise; });
    f.manager.call = vi.fn(async (_method, _params, _id, before) => { before?.(); return stop.promise; });
    const work = f.dispatcher.call({ method: 'turn/start', params: { threadId: 'thread', text: 'fixture' }, operationId: old }, owner);
    try {
      const recovery = f.dispatcher.call(recover(), owner);
      expect(f.dispatcher.maintenanceActive()).toBe(true);
      expect(f.ledger.read(old)?.state).toBe('dispatching');
      await expect(f.dispatcher.call({ method: 'turn/start', params: { threadId: 'other', text: 'fixture' }, operationId: randomUUID() }, owner))
        .rejects.toMatchObject({ code: 'maintenance', delivery: 'not_sent' });
      stop.resolve(accepted); expect(await recovery).toEqual(accepted);
      // A malformed/lost post-stop result remains unknown; it is never replayed.
      finish.resolve(null);
      await expect(work).rejects.toMatchObject({ delivery: 'unknown' });
      expect(f.ledger.read(old)?.state).toBe('unknown');
      expect(f.worker.call).toHaveBeenCalledTimes(1);
      expect(f.manager.call).toHaveBeenCalledTimes(1);
    } finally { stop.resolve(accepted); finish.resolve(null); await work.catch(() => {}); f.ledger.close(); }
  });

  it('fences an old awaited write even after recovery completes and maintenance clears', async () => {
    const f = fixture(), gate = deferred<void>(), old = randomUUID(); let sends = 0;
    f.worker.call = vi.fn(async (_method, _params, context) => { await gate.promise; context.beforeWrite?.(); sends++; return { turn: { id: 'unexpected' } }; });
    const work = f.dispatcher.call({ method: 'turn/start', params: { threadId: 'thread', text: 'fixture' }, operationId: old }, owner);
    const rejected = expect(work).rejects.toMatchObject({ code: 'recovery_started', delivery: 'not_sent' });
    try {
      expect(f.ledger.read(old)?.state).toBe('pending');
      await f.dispatcher.call(recover(), owner);
      expect(f.dispatcher.maintenanceActive()).toBe(false);
      await f.dispatcher.call(recover(), owner);
      gate.resolve(); await rejected;
      expect(sends).toBe(0); expect(f.ledger.read(old)?.state).toBe('not_sent');
      expect(f.manager.call).toHaveBeenCalledTimes(2);
    } finally { gate.resolve(); await work.catch(() => {}); f.ledger.close(); }
  });

  it('does not bypass an existing configuration transaction', async () => {
    const f = fixture(), finish = deferred<JsonValue>();
    f.manager.call = vi.fn(async (_method, _params, _id, before) => { before?.(); return finish.promise; });
    const pending = f.dispatcher.call({ method: 'system/restart', params: {}, operationId: randomUUID() }, owner);
    try {
      await expect(f.dispatcher.call(recover(), owner)).rejects.toMatchObject({ code: 'maintenance', delivery: 'not_sent' });
      expect(f.manager.call).toHaveBeenCalledTimes(1);
    } finally { finish.resolve(accepted); await pending; f.ledger.close(); }
  });

  it.each(['mcp/reload', 'mcp/config/write', 'plugin/install', 'workspace/git/commit'])('preempts hung worker configuration %s without letting its old finally unlock recovery', async method => {
    const f = fixture(), finish = deferred<void>(), stop = deferred<JsonValue>(), old = randomUUID();
    const project = f.ledger.addProject('/fixture/project', 'Fixture');
    f.worker.call = vi.fn(async (_method, _params, context) => {
      context.beforeWrite?.(); await finish.promise; throw new HarnessError('worker_closed', 'Worker stopped', 'unknown');
    });
    f.manager.call = vi.fn(async (_method, _params, _id, before) => { before?.(); return stop.promise; });
    const work = f.dispatcher.call({ method, params: method === 'mcp/reload' ? {} : { projectId: project.id }, operationId: old }, owner);
    const ended = expect(work).rejects.toMatchObject({ code: 'worker_closed', delivery: 'unknown' });
    let recovery: Promise<JsonValue> | undefined;
    try {
      expect(f.ledger.read(old)?.state).toBe('dispatching'); expect(f.dispatcher.maintenanceActive()).toBe(true);
      recovery = f.dispatcher.call(recover(), owner);
      expect(f.manager.call).toHaveBeenCalledTimes(1);
      finish.resolve(); await ended;
      expect(f.ledger.read(old)?.state).toBe('unknown');
      expect(f.dispatcher.maintenanceActive()).toBe(true);
      expect(f.dispatcher.status()).toMatchObject({ maintenance: true });
      await expect(f.dispatcher.call({ method: 'turn/start', params: { threadId: 'other', text: 'fixture' }, operationId: randomUUID() }, owner))
        .rejects.toMatchObject({ code: 'maintenance', delivery: 'not_sent' });
      await expect(f.dispatcher.call(recover(), owner)).rejects.toMatchObject({ code: 'maintenance', delivery: 'not_sent' });
      stop.resolve(accepted); expect(await recovery).toEqual(accepted);
      expect(f.dispatcher.maintenanceActive()).toBe(false);
      expect(f.worker.call).toHaveBeenCalledTimes(1);
    } finally { finish.resolve(); stop.resolve(accepted); await work.catch(() => {}); await recovery?.catch(() => {}); f.ledger.close(); }
  });

  it('fences a preempted worker configuration that resumes before its actual dispatch after recovery ended', async () => {
    const f = fixture(), resume = deferred<void>(), old = randomUUID(); let sends = 0;
    f.worker.call = vi.fn(async (_method, _params, context) => { await resume.promise; context.beforeWrite?.(); sends++; return {}; });
    const work = f.dispatcher.call({ method: 'mcp/reload', params: {}, operationId: old }, owner);
    const rejected = expect(work).rejects.toMatchObject({ code: 'recovery_started', delivery: 'not_sent' });
    try {
      expect(f.dispatcher.maintenanceActive()).toBe(true); expect(f.ledger.read(old)?.state).toBe('pending');
      await f.dispatcher.call(recover(), owner);
      expect(f.dispatcher.maintenanceActive()).toBe(false);
      resume.resolve(); await rejected;
      expect(sends).toBe(0); expect(f.ledger.read(old)?.state).toBe('not_sent');
      expect(f.dispatcher.maintenanceActive()).toBe(false);
    } finally { resume.resolve(); await work.catch(() => {}); f.ledger.close(); }
  });

  it('cannot preempt receipt rotation waiting for an idle proof', async () => {
    const f = fixture(), entered = deferred<void>(), finish = deferred<JsonValue>();
    vi.spyOn(f.dispatcher.workspaceAcknowledgements, 'drain').mockResolvedValue();
    f.worker.call = vi.fn(async () => { entered.resolve(); return finish.promise; });
    const preview = await f.dispatcher.call({ method: 'operation/maintenance/preview', params: {} }, owner) as JsonObject;
    await f.dispatcher.call({ method: 'operation/maintenance/chunk', params: { exportId: preview.exportId!, digest: preview.digest!, offset: 0 } }, owner);
    const rotate = f.dispatcher.call({ method: 'operation/maintenance/rotate', params: { exportId: preview.exportId!, digest: preview.digest!,
      nextGeneration: preview.nextGeneration!, exportedDigest: preview.digest!, confirm: true } }, owner);
    const rejected = expect(rotate).rejects.toMatchObject({ code: 'journal_changed' });
    try {
      await entered.promise;
      await expect(f.dispatcher.call(recover(), owner)).rejects.toMatchObject({ code: 'maintenance', delivery: 'not_sent' });
      expect(f.manager.call).not.toHaveBeenCalled(); expect(f.dispatcher.maintenanceActive()).toBe(true);
      finish.resolve({ idle: true, workspaceWitness: { total: 0 } }); await rejected;
      expect(f.dispatcher.maintenanceActive()).toBe(false); expect(f.ledger.operationGeneration()).toBe(0);
    } finally { finish.resolve({ idle: true, workspaceWitness: { total: 0 } }); await rotate.catch(() => {}); f.ledger.close(); }
  });

  it('keeps a failed stop unknown, never retries it, and only accepts a matching durable manager proof', async () => {
    const f = fixture(), call = recover();
    const proof = { operationId: call.operationId, method: 'recover', gatewayRequestDigest: digest({ method: call.method, params: call.params }), state: 'completed', result: accepted };
    let mutations = 0, validProof = false;
    f.manager.call = vi.fn(async (method, _params, _id, before) => {
      before?.();
      if (method === 'operation/read') return { ...proof, gatewayRequestDigest: validProof ? proof.gatewayRequestDigest : 'b'.repeat(64) };
      mutations++; throw new HarnessError('stop_unknown', 'Cgroup not confirmed stopped', 'unknown');
    });
    try {
      await expect(f.dispatcher.call(call, owner)).rejects.toMatchObject({ code: 'stop_unknown', delivery: 'unknown' });
      await expect(f.dispatcher.call(call, owner)).rejects.toMatchObject({ code: 'operation_unknown' });
      expect(f.ledger.getMeta('activityUncertain')).toBe('true');
      expect(await f.dispatcher.call({ method: 'operation/read', params: { operationId: call.operationId } }, owner)).toMatchObject({ state: 'unknown' });
      validProof = true;
      expect(await f.dispatcher.call({ method: 'operation/read', params: { operationId: call.operationId } }, owner)).toMatchObject({ state: 'accepted', result: accepted });
      expect(mutations).toBe(1);
    } finally { f.ledger.close(); }
  });

  it('requires a confirmed release receipt and never stores manager-private fields', () => {
    expect(receiptResult('system/recover', { ...accepted, privatePath: '/fixture/private' })).toEqual(accepted);
    for (const result of [{ restarted: false, release: accepted.release }, { restarted: true }, { restarted: true, release: 'bad' }])
      expect(() => receiptResult('system/recover', result)).toThrow(expect.objectContaining({ code: 'receipt_contract', delivery: 'unknown' }));
  });
});
