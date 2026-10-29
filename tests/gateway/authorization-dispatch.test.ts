import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { expect, it } from 'vitest';
import type { CallContext, JsonObject, JsonValue, RpcCall } from '../../src/core/contracts.js';
import { HarnessError } from '../../src/core/errors.js';
import { Ledger } from '../../src/core/ledger.js';
import { Authentication } from '../../src/gateway/auth.js';
import { Dispatcher } from '../../src/gateway/dispatch.js';
import type { ManagerPort } from '../../src/gateway/manager-client.js';
import { GatewayServer } from '../../src/gateway/server.js';
import type { WorkerClient } from '../../src/gateway/worker-client.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function fixture(openBrowser = true) {
  const token = randomBytes(32).toString('hex'), auth = new Authentication(token, 'http://127.0.0.1:0');
  let ledger: Ledger | undefined, server: GatewayServer | undefined, socket: WebSocket | undefined;
  const close = async () => {
    const errors: unknown[] = [];
    try { socket?.terminate(); } catch (error) { errors.push(error); }
    try { await server?.close(); } catch (error) { errors.push(error); }
    try { auth.close(); } catch (error) { errors.push(error); }
    try { ledger?.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Authorization fixture cleanup failed');
  };
  try {
    ledger = new Ledger(':memory:');
    const backend = { connected: true, clientConnected: async () => {}, clientDisconnected: async () => {},
      call: async (_method: string, _params: JsonObject, context: CallContext): Promise<JsonValue> => { context.beforeWrite?.(); return {}; },
    };
    const manager: ManagerPort = { call: async (_method, _params, _operationId, beforeWrite) => { beforeWrite?.(); return {}; } };
    const dispatcher = new Dispatcher(ledger, backend, manager);
    dispatcher.event({ type: 'state', data: { connected: true, activity: { activeThreads: [], pendingStarts: 0, terminals: 0, unknown: false } } });
    server = new GatewayServer(auth, dispatcher, backend as unknown as WorkerClient);
    const port = await server.listen(0); auth.origin.port = String(port); const origin = auth.origin.origin;
    const setup = await auth.setup({ token, username: 'admin', password: randomBytes(24).toString('base64url') }, 'local');
    const cookie = setup.cookie.split(';')[0]!, clientId = randomUUID();
    if (openBrowser) {
      socket = new WebSocket(origin.replace('http:', 'ws:') + '/api/events?clientId=' + clientId, { headers: { origin, cookie } });
      socket.on('error', () => {}); await once(socket, 'open');
    }
    const call = (rpc: RpcCall) => fetch(origin + '/api/rpc', { method: 'POST',
      headers: { origin, cookie, 'content-type': 'application/json', 'x-harness-csrf': setup.session.csrf, 'x-harness-recovery': '2', 'x-harness-client': clientId }, body: JSON.stringify(rpc),
    });
    return { auth, backend, manager, ledger, dispatcher, call, revoke: () => { auth.logout(cookie); }, close };
  } catch (error) {
    await close().catch(() => {}); throw error;
  }
}

it.each(['authorized', 'revoked before write', 'revoked after write'] as const)('settles a queued worker mutation honestly when %s', async state => {
  const f = await fixture(), entered = gate(), send = gate(), sent = gate(), acknowledge = gate();
  const operationId = randomUUID(); let writes = 0;
  f.backend.call = async (_method, _params, context) => {
    entered.release(); await send.promise; context.beforeWrite?.(); writes++; sent.release(); await acknowledge.promise; return {};
  };
  try {
    const pending = f.call({ method: 'thread/name/set', params: { threadId: 'thread', name: 'Updated' }, operationId });
    await entered.promise; expect(f.ledger.read(operationId)?.state).toBe('pending');
    if (state === 'revoked before write') f.revoke();
    send.release();
    if (state !== 'revoked before write') {
      await sent.promise; expect(f.ledger.read(operationId)?.state).toBe('dispatching');
      if (state === 'revoked after write') f.revoke();
    }
    acknowledge.release(); const response = await pending;
    if (state === 'revoked before write') {
      expect(response.status).toBe(401); expect(await response.json()).toMatchObject({ ok: false, error: { code: 'unauthorized', delivery: 'not_sent' } });
      expect(writes).toBe(0); expect(f.ledger.read(operationId)).toMatchObject({ state: 'not_sent', error: { code: 'unauthorized', delivery: 'not_sent' } });
    } else {
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, result: {} });
      expect(writes).toBe(1); expect(f.ledger.read(operationId)).toMatchObject({ state: 'accepted', result: {} });
    }
  } finally { send.release(); acknowledge.release(); await f.close(); }
});

it.each(['system/restart', 'system/status', 'system/logs', 'system/provider/read'])('allows %s without a browser connection but rejects a revoked queued send', async method => {
  for (const revoke of [false, true]) {
    const f = await fixture(false), entered = gate(), send = gate(); let writes = 0;
    const operationId = randomUUID(), result = method === 'system/restart' ? { restarted: true, release: 'a'.repeat(64) } : { healthy: true };
    f.manager.call = async (_method, _params, _operationId, beforeWrite) => { entered.release(); await send.promise; beforeWrite?.(); writes++; return result; };
    try {
      const pending = f.call({ method, params: {}, ...(method === 'system/restart' ? { operationId } : {}) });
      await entered.promise; if (revoke) f.revoke(); send.release(); const response = await pending;
      if (revoke) {
        expect(response.status).toBe(401); expect(await response.json()).toMatchObject({ ok: false, error: { code: 'unauthorized', delivery: 'not_sent' } });
        expect(writes).toBe(0);
        if (method === 'system/restart') expect(f.ledger.read(operationId)).toMatchObject({ state: 'not_sent', error: { delivery: 'not_sent' } });
      } else {
        expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ ok: true, result }); expect(writes).toBe(1);
        if (method === 'system/restart') expect(f.ledger.read(operationId)?.state).toBe('accepted');
      }
    } finally { send.release(); await f.close(); }
  }
});

it('persists a management acknowledgement arriving after session revocation', async () => {
  const f = await fixture(false), sent = gate(), acknowledge = gate(), operationId = randomUUID();
  const result = { restarted: true, release: 'b'.repeat(64) };
  f.manager.call = async (_method, _params, _operationId, beforeWrite) => { beforeWrite?.(); sent.release(); await acknowledge.promise; return result; };
  try {
    const pending = f.call({ method: 'system/restart', params: {}, operationId });
    await sent.promise; expect(f.ledger.read(operationId)?.state).toBe('dispatching'); f.revoke(); acknowledge.release();
    expect(await (await pending).json()).toEqual({ ok: true, result });
    expect(f.ledger.read(operationId)).toMatchObject({ state: 'accepted', result });
  } finally { acknowledge.release(); await f.close(); }
});

it('retains positive backend evidence after revocation even when an adapter omitted the boundary callback', async () => {
  const f = await fixture(), entered = gate(), acknowledge = gate(), operationId = randomUUID();
  f.backend.call = async () => { entered.release(); await acknowledge.promise; return {}; };
  try {
    const pending = f.call({ method: 'thread/name/set', params: { threadId: 'thread', name: 'Updated' }, operationId });
    await entered.promise; f.revoke(); acknowledge.release();
    expect(await (await pending).json()).toEqual({ ok: true, result: {} });
    expect(f.ledger.read(operationId)?.state).toBe('accepted');
  } finally { acknowledge.release(); await f.close(); }
});

it.each(['project/add', 'automation/create'])('rechecks authorization before committing %s after read-only validation', async method => {
  const ledger = new Ledger(':memory:'), entered = gate(), validate = gate(); let authorized = true;
  const backend = { connected: true, call: async () => { entered.release(); await validate.promise; return { path: '/resolved', name: 'Resolved' }; } };
  const dispatcher = new Dispatcher(ledger, backend, { call: async () => ({}) });
  const project = ledger.addProject('/registered', 'Registered'), operationId = randomUUID();
  const params: JsonObject = method === 'project/add' ? { path: '/requested', name: 'New' } : { spec: {
    name: 'Check', projectId: project.id, text: 'Check the workspace', options: {}, maxRunMinutes: 10,
    schedule: { kind: 'interval', hours: 1, anchor: Date.now() + 60_000, timeZone: 'UTC' },
  } };
  const context: CallContext = { clientId: 'owner', requireAuthorization() { if (!authorized) throw new HarnessError('unauthorized', 'Session revoked'); } };
  try {
    const pending = dispatcher.call({ method, params, operationId }, context);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'unauthorized', delivery: 'not_sent' });
    await entered.promise; authorized = false; validate.release(); await rejected;
    expect(ledger.read(operationId)).toMatchObject({ state: 'not_sent', error: { delivery: 'not_sent' } });
    expect(ledger.projects()).toEqual([project]); expect(ledger.automations.read('automation/list', {})).toEqual({ data: [] });
  } finally { validate.release(); ledger.close(); }
});

it('authorizes local retirement and project removal without requiring a browser connection', async () => {
  const f = await fixture(false), project = f.ledger.addProject('/registered', 'Registered');
  try {
    const removeId = randomUUID(), retiredId = randomUUID();
    expect(await (await f.call({ method: 'project/remove', params: { id: project.id }, operationId: removeId })).json()).toEqual({ ok: true, result: {} });
    expect(await (await f.call({ method: 'operation/retire', params: { operationId: retiredId } })).json()).toMatchObject({ ok: true, result: { state: 'not_sent' } });
    f.revoke(); const rejectedId = randomUUID();
    expect((await f.call({ method: 'operation/retire', params: { operationId: rejectedId } })).status).toBe(401);
    expect(f.ledger.projects()).toEqual([]); expect(f.ledger.read(removeId)?.state).toBe('accepted'); expect(f.ledger.read(rejectedId)).toBeNull();
  } finally { await f.close(); }
});
