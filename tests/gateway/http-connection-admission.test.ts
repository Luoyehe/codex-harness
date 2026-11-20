import { expect, test, vi } from 'vitest';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request, type ClientRequest } from 'node:http';
import WebSocket from 'ws';
import { Authentication } from '../../src/gateway/auth.js';
import { GatewayServer } from '../../src/gateway/server.js';
import { Dispatcher } from '../../src/gateway/dispatch.js';
import { Ledger } from '../../src/core/ledger.js';
import type { CallContext, JsonObject } from '../../src/core/contracts.js';
import type { WorkerClient } from '../../src/gateway/worker-client.js';

test.each(['replaced', 'missing', 'unchanged', 'accepted-replay'] as const)('slow HTTP bodies retain their admission-time WebSocket owner: %s', async scenario => {
  const token = randomBytes(32).toString('hex'), auth = new Authentication(token, 'http://127.0.0.1:0'), ledger = new Ledger(':memory:');
  const owners: string[] = [], forwarded: string[] = [], sockets: WebSocket[] = [];
  const backend = { connected: true, async clientConnected(owner: string) { owners.push(owner); }, async clientDisconnected() {},
    async call(_method: string, _params: JsonObject, context: CallContext) { context.beforeWrite?.(); forwarded.push(context.clientId); return { turn: { id: 'fixture-turn' } }; } };
  const dispatcher = new Dispatcher(ledger, backend, { call: async () => ({}) });
  dispatcher.event({ type: 'state', data: { connected: true, activity: { activeThreads: [], pendingStarts: 0, terminals: 0, unknown: false } } });
  const gateway = new GatewayServer(auth, dispatcher, backend as unknown as WorkerClient); auth.origin.port = String(await gateway.listen(0));
  const origin = auth.origin.origin, login = await auth.setup({ token, username: 'fixture', password: randomBytes(24).toString('hex') }, 'local'), cookie = login.cookie.split(';')[0]!;
  const clientId = randomUUID(), operationId = randomUUID(), call = { method: 'turn/start', params: { threadId: 'fixture', text: 'admitted request' }, operationId };
  const headers = { origin, cookie, 'content-type': 'application/json', 'x-harness-csrf': login.session.csrf, 'x-harness-client': clientId, 'x-harness-recovery': '2' };
  const connect = async () => {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/api/events?clientId=' + clientId, { headers: { origin, cookie } }); sockets.push(ws);
    const initial = once(ws, 'message'); await once(ws, 'open'); await initial;
  };
  let pending: ClientRequest | undefined;
  try {
    if (scenario !== 'missing') await connect();
    if (scenario === 'accepted-replay') {
      expect((await fetch(origin + '/api/rpc', { method: 'POST', headers, body: JSON.stringify(call) })).status).toBe(200);
      expect(forwarded).toHaveLength(1);
    }
    const originalOwner = owners[0], body = JSON.stringify(call);
    const received = once(gateway.server, 'request');
    const completed = new Promise<{ ok: boolean; error?: { code: string; delivery: string } }>((resolve, reject) => {
      pending = request(origin + '/api/rpc', { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body), Connection: 'close' } }, response => {
        const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
        response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (error) { reject(error); } });
      }); pending.on('error', reject); pending.write(body.slice(0, 12));
    });
    void completed.catch(() => {});
    await received;
    if (scenario !== 'unchanged') await connect();
    pending!.end(body.slice(12)); const response = await completed;
    if (scenario === 'replaced' || scenario === 'missing') {
      expect(response).toMatchObject({ ok: false, error: { code: 'connection_required', delivery: 'not_sent' } }); expect(forwarded).toEqual([]);
      expect(ledger.read(operationId)?.state).not.toBe('accepted');
    } else {
      expect(response.ok).toBe(true); expect(forwarded).toEqual([originalOwner]); expect(ledger.read(operationId)?.state).toBe('accepted');
    }
    // Fresh requests may use the replacement lease after the stale body failed.
    if (scenario !== 'accepted-replay') {
      const fresh = await fetch(origin + '/api/rpc', { method: 'POST', headers, body: JSON.stringify({ ...call, operationId: randomUUID() }) });
      expect(fresh.status).toBe(200); expect(forwarded.at(-1)).toBe(owners.at(-1));
    }
  } finally { pending?.destroy(); for (const ws of sockets) ws.terminate(); await gateway.close(); auth.close(); ledger.close(); }
});

test('the signed loopback health probe has reserved admission and still reports a genuinely unready backend', async () => {
  const { Budget } = await import('../../src/core/budget.js');
  const { HarnessError } = await import('../../src/core/errors.js');
  const token = randomBytes(32).toString('hex'), auth = new Authentication(token, 'http://127.0.0.1:0'), ledger = new Ledger(':memory:');
  const backend = { connected: true, call: async () => ({}) };
  const dispatcher = new Dispatcher(ledger, backend, { call: async () => ({}) });
  const gateway = new GatewayServer(auth, dispatcher, backend as unknown as WorkerClient);
  auth.origin.port = String(await gateway.listen(0));
  const reserve = Budget.prototype.reserve;
  const busy = vi.spyOn(Budget.prototype, 'reserve').mockImplementation(function (this: InstanceType<typeof Budget>) {
    if (this.maxCount === 8 && this.maxBytes === 0) throw new HarnessError('capacity', 'fixture: public pool busy');
    return reserve.call(this);
  });
  const signature = (route: string) => createHmac('sha256', createHash('sha256').update(token).digest()).update('harness-local-probe-v1\n' + route).digest('hex');
  const read = (route: string, signed: boolean) => fetch(auth.origin.origin + route, { headers: signed ? { 'x-harness-local-probe': signature(route.split('?')[0]!) } : {} });
  try {
    dispatcher.event({ type: 'state', data: { connected: true, activity: { activeThreads: [], pendingStarts: 0, terminals: 0, unknown: false } } });
    const ordinary = await read('/health', false);
    expect((await ordinary.json()).error.code).toBe('capacity');
    expect(await (await read('/health', true)).json()).toEqual({ ok: true });
    const nonce = randomBytes(32).toString('hex');
    expect(await (await read('/api/account/proof?nonce=' + nonce, true)).json()).toEqual(auth.proof(nonce));
    dispatcher.event({ type: 'state', data: { connected: true, activity: { unknown: true } } });
    const unready = await read('/health', true);
    expect(unready.status).toBe(503); expect(await unready.json()).toEqual({ ok: false });
  } finally { busy.mockRestore(); await gateway.close(); auth.close(); ledger.close(); }
});
