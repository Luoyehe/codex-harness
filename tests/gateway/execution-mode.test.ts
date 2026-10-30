import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { CallContext, JsonObject, JsonValue, RpcCall } from '../../src/core/contracts.js';
import { digest } from '../../src/core/validation.js';
import { HarnessError } from '../../src/core/errors.js';
import { Ledger } from '../../src/core/ledger.js';
import { Dispatcher } from '../../src/gateway/dispatch.js';
import type { ManagerPort } from '../../src/gateway/manager-client.js';
import { receiptResult } from '../../src/gateway/receipt-result.js';
import { requireRecoveryProtocol } from '../../src/gateway/recovery-protocol.js';

const native = { mode: 'native', effectiveUid: 991, rootAllowed: false, revision: 'a'.repeat(64), requiresRestart: true };
const root = { mode: 'root', effectiveUid: 0, rootAllowed: true, revision: 'b'.repeat(64), requiresRestart: true };
const params = (): JsonObject => ({ mode: 'root', expectedRevision: native.revision, confirmRestart: true, confirmRoot: true });
const accepted = { ...root, changed: true, transaction: 'c'.repeat(32), servicesRestored: true };
const context: CallContext = { clientId: 'owner' };
function fixture() {
  const ledger = new Ledger(':memory:');
  const worker = { connected: true, call: vi.fn(async () => ({})) };
  const manager: ManagerPort = { call: vi.fn(async (_method, _params, _id, beforeWrite) => { beforeWrite?.(); return accepted; }) };
  const dispatcher = new Dispatcher(ledger, worker, manager);
  const state = (activity: JsonObject = {}) => dispatcher.event({ type: 'state', data: { connected: true,
    activity: { activeThreads: [], pendingStarts: 0, terminals: 0, processes: 0, subscriptions: 0, unknown: false, ...activity } } });
  state();
  return { ledger, worker, manager, dispatcher, state, write: (input = params(), operationId = randomUUID(), owner = context) =>
    dispatcher.call({ method: 'system/execution-mode/write', params: input, operationId }, owner) };
}

describe('execution privilege management', () => {
  it('reads only bounded policy fields and preserves an unavailable old-backend status', async () => {
    const f = fixture();
    try {
      f.manager.call = vi.fn(async () => ({ ...native, token: 'private', path: '/private' }));
      expect(await f.dispatcher.call({ method: 'system/execution-mode/read', params: {} }, context)).toEqual(native);
      f.manager.call = vi.fn(async () => ({ healthy: true, executionMode: { ...native, token: 'private' } }));
      expect(await f.dispatcher.call({ method: 'system/status', params: {} }, context)).toMatchObject({ executionMode: native });
      f.manager.call = vi.fn(async () => ({ healthy: true }));
      expect(await f.dispatcher.call({ method: 'system/status', params: {} }, context)).not.toHaveProperty('executionMode');
    } finally { f.ledger.close(); }
  });

  it.each([
    { ...root, rootAllowed: false }, { ...root, effectiveUid: 991 }, { ...native, effectiveUid: 0 },
    { ...native, effectiveUid: -1 }, { ...native, revision: 'old' }, { ...native, rootAllowed: undefined },
  ])('refuses contradictory or incomplete policy state %#', async value => {
    const f = fixture();
    try {
      f.manager.call = vi.fn(async () => value as unknown as JsonValue);
      await expect(f.dispatcher.call({ method: 'system/execution-mode/read', params: {} }, context)).rejects.toMatchObject({ code: 'execution_mode_unconfirmed' });
    } finally { f.ledger.close(); }
  });

  it.each([
    { rootAllowed: true }, { uid: 0 }, { path: '/root' }, { confirmRoot: false }, { confirmRestart: false },
    { expectedRevision: 'old' }, { mode: 'sudo' }, { mode: ['root'] }, { confirmRoot: 'true' },
  ])('rejects invalid write or host-authorization fields before dispatch %#', async change => {
    const f = fixture(), id = randomUUID();
    try {
      await expect(f.write({ ...params(), ...change }, id)).rejects.toMatchObject({ code: 'invalid', delivery: 'not_sent' });
      expect(f.manager.call).not.toHaveBeenCalled(); expect(f.ledger.read(id)).toBeNull();
    } finally { f.ledger.close(); }
  });

  it('does not expose a server authorization RPC and rejects read parameters', async () => {
    const f = fixture();
    try {
      for (const method of ['system/root-access', 'system/root-access/write', 'system/execution-mode/authorize'])
        await expect(f.dispatcher.call({ method, params: { rootAllowed: true }, operationId: randomUUID() }, context)).rejects.toMatchObject({ code: 'method_not_found' });
      await expect(f.dispatcher.call({ method: 'system/execution-mode/read', params: { mode: 'root' } }, context)).rejects.toMatchObject({ code: 'invalid' });
      expect(f.manager.call).not.toHaveBeenCalled();
    } finally { f.ledger.close(); }
  });

  it('records the original result once and replays it without another mode transition', async () => {
    const f = fixture(), id = randomUUID();
    try {
      expect(await f.write(params(), id)).toEqual(accepted);
      f.worker.connected = false; f.dispatcher.disconnected();
      expect(await f.write(params(), id)).toEqual(accepted);
      expect(f.manager.call).toHaveBeenCalledTimes(1);
      expect(f.ledger.read(id)).toMatchObject({ method: 'system/execution-mode/write', state: 'accepted', result: accepted });
    } finally { f.ledger.close(); }
  });

  it.each([
    { activeThreads: ['active'] }, { pendingStarts: 1 }, { terminals: 1 }, { subscriptions: 1 }, { processes: 1 }, { unknown: true },
  ])('never treats switch confirmation as permission to stop active or unknown work %#', async activity => {
    const f = fixture();
    try {
      f.state(activity);
      await expect(f.write()).rejects.toMatchObject({ delivery: 'not_sent' }); expect(f.manager.call).not.toHaveBeenCalled();
    } finally { f.ledger.close(); }
  });

  it('rechecks activity and authorization at the queued management send boundary', async () => {
    for (const revoked of [false, true]) {
      const f = fixture(), id = randomUUID(); let authorized = true, release!: () => void, entered!: () => void, writes = 0;
      const ready = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
      f.manager.call = vi.fn(async (_m, _p, _id, beforeWrite) => { entered(); await wait; beforeWrite?.(); writes++; return accepted; });
      const owner = { clientId: 'owner', requireAuthorization() { if (!authorized) throw new HarnessError('unauthorized', 'Session expired'); } };
      try {
        const pending = f.write(params(), id, owner); await ready;
        if (revoked) authorized = false; else f.state({ processes: 1 }); release();
        await expect(pending).rejects.toMatchObject({ code: revoked ? 'unauthorized' : 'activity_busy', delivery: 'not_sent' });
        expect(writes).toBe(0); expect(f.ledger.read(id)?.state).toBe('not_sent');
      } finally { release(); f.ledger.close(); }
    }
  });

  it('retains unknown outcomes and confirms only an exact original root-manager receipt', async () => {
    const f = fixture(), id = randomUUID(), input = params(); let writes = 0;
    let proof: JsonObject = { operationId: id, method: 'execution-mode/write', gatewayRequestDigest: 'd'.repeat(64), state: 'completed', result: accepted };
    f.manager.call = vi.fn(async (method, _p, _id, beforeWrite) => {
      if (method === 'operation/read') return proof;
      beforeWrite?.(); writes++; throw new HarnessError('manager_timeout', 'Response lost', 'unknown');
    });
    try {
      await expect(f.write(input, id)).rejects.toMatchObject({ delivery: 'unknown' });
      await expect(f.write(input, id)).rejects.toMatchObject({ delivery: 'unknown' }); expect(writes).toBe(1);
      const read: RpcCall = { method: 'operation/read', params: { operationId: id } };
      expect(await f.dispatcher.call(read, context)).toMatchObject({ state: 'unknown' });
      proof = { ...proof, gatewayRequestDigest: digest({ method: 'system/execution-mode/write', params: input }) };
      expect(await f.dispatcher.call(read, context)).toMatchObject({ state: 'accepted', result: accepted }); expect(writes).toBe(1);
    } finally { f.ledger.close(); }
  });

  it('requires confirmed service restoration and strips unrelated receipt data', () => {
    expect(receiptResult('system/execution-mode/write', { ...accepted, privatePath: '/private' })).toEqual(accepted);
    expect(receiptResult('system/execution-mode/write', { ...native, changed: false, servicesRestored: true })).toEqual({ ...native, changed: false, servicesRestored: true });
    for (const change of [{ servicesRestored: false }, { changed: 'true' }, { transaction: 'bad' }, { rootAllowed: false }, { effectiveUid: 1 }])
      expect(() => receiptResult('system/execution-mode/write', { ...accepted, ...change })).toThrow(expect.objectContaining({ code: 'receipt_contract', delivery: 'unknown' }));
    expect(() => receiptResult('system/execution-mode/write', { ...native, changed: false, servicesRestored: true, transaction: 'c'.repeat(32) })).toThrow();
  });

  it('allows policy reads from old clients but requires current recovery protocol for switches', () => {
    expect(() => requireRecoveryProtocol('system/execution-mode/read', undefined)).not.toThrow();
    expect(() => requireRecoveryProtocol('system/execution-mode/write', undefined)).toThrow(expect.objectContaining({ code: 'client_update_required' }));
    expect(() => requireRecoveryProtocol('system/execution-mode/write', '2')).not.toThrow();
  });
});
