import http from 'node:http';
import net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { expect, it } from 'vitest';
import { Authentication } from '../../src/gateway/auth.js';
import { Dispatcher } from '../../src/gateway/dispatch.js';
import { GatewayServer } from '../../src/gateway/server.js';
import { Ledger } from '../../src/core/ledger.js';
import { LIMITS, type JsonValue } from '../../src/core/contracts.js';
import type { WorkerClient } from '../../src/gateway/worker-client.js';

async function fixture() {
  const token = randomBytes(32).toString('hex'), auth = new Authentication(token, 'http://127.0.0.1:0');
  const ledger = new Ledger(':memory:'), completions: ((value: JsonValue) => void)[] = [];
  let managerCalls = 0, finishManager: (() => void) | undefined, holdManager = false;
  const worker = { connected: true, clientConnected: async () => {}, clientDisconnected: async () => {},
    call: async () => new Promise<JsonValue>(resolve => completions.push(resolve)) };
  const dispatcher = new Dispatcher(ledger, worker, { call: async (_method, _params, _id, beforeWrite) => {
    beforeWrite?.(); managerCalls++;
    if (holdManager) await new Promise<void>(resolve => { finishManager = resolve; });
    return { restarted: true, release: 'a'.repeat(64) };
  } });
  dispatcher.event({ type: 'state', data: { connected: true, activity: { activeThreads: [], pendingStarts: 0, terminals: 0, unknown: false } } });
  const gateway = new GatewayServer(auth, dispatcher, worker as unknown as WorkerClient);
  auth.origin.port = String(await gateway.listen(0)); const origin = auth.origin.origin;
  const login = await auth.setup({ token, username: 'audit', password: randomBytes(24).toString('hex') }, 'local');
  const cookie = login.cookie.split(';')[0]!, clientId = randomUUID();
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/api/events?clientId=' + clientId, { headers: { origin, cookie } });
  await once(socket, 'open');
  const headers = { origin, cookie, 'content-type': 'application/json', 'x-harness-csrf': login.session.csrf, 'x-harness-recovery': '2', 'x-harness-client': clientId };
  const post = (pathname: string, body: unknown, overrides: Record<string, string> = {}) => fetch(origin + pathname, { method: 'POST', headers: { ...headers, ...overrides }, body: JSON.stringify(body) });
  const request = () => ({ method: 'system/recover', params: { confirmStop: true }, operationId: randomUUID() });
  return { auth, gateway, ledger, dispatcher, completions, post, request, get managerCalls() { return managerCalls; },
    hold() { holdManager = true; }, release() { finishManager?.(); },
    async close() { completions.forEach(done => done({ data: [] })); finishManager?.(); socket.terminate(); await gateway.close(); ledger.close(); auth.close(); } };
}

it('reaches force recovery through its reserved HTTP slot when ordinary worker requests are saturated', async () => {
  const f = await fixture(), pending: Promise<Response>[] = [];
  try {
    for (let index = 0; index < LIMITS.concurrentRequests; index++) pending.push(f.post('/api/rpc', { method: 'thread/read', params: { threadId: 'held' } }));
    await expect.poll(() => f.completions.length).toBe(LIMITS.concurrentRequests);
    expect(await (await f.post('/api/rpc', f.request())).json()).toMatchObject({ ok: false, error: { code: 'capacity', delivery: 'not_sent' } });
    const request = f.request();
    expect(await (await f.post('/api/recover', request)).json()).toMatchObject({ ok: true, result: { restarted: true } });
    expect(f.ledger.read(request.operationId)?.state).toBe('accepted'); expect(f.managerCalls).toBe(1);
    expect(await (await f.post('/api/recover', request)).json()).toMatchObject({ ok: true, result: { restarted: true } });
    expect(f.managerCalls).toBe(1);
  } finally { f.completions.forEach(done => done({ data: [] })); await Promise.allSettled(pending); await f.close(); }
});

it('retains its one recovery slot until the admitted backend settles and does not admit a second helper', async () => {
  const f = await fixture(); f.hold(); const first = f.request(), next = f.request();
  const pending = f.post('/api/recover', first);
  try {
    await expect.poll(() => f.managerCalls).toBe(1);
    expect(await (await f.post('/api/recover', next)).json()).toMatchObject({ ok: false, error: { code: 'capacity', delivery: 'not_sent' } });
    expect(f.ledger.read(next.operationId)).toBeNull(); expect(f.ledger.read(first.operationId)?.state).toBe('dispatching');
    f.release(); expect(await (await pending).json()).toMatchObject({ ok: true });
    expect(await (await f.post('/api/recover', first)).json()).toMatchObject({ ok: true }); expect(f.managerCalls).toBe(1);
  } finally { f.release(); await pending; await f.close(); }
});

it('retains a bounded recovery response independently of a completely occupied ordinary output budget', async () => {
  const f = await fixture(), transport = new net.Socket();
  const response = new http.ServerResponse(new http.IncomingMessage(transport));
  // Retain the full normal output allowance without allocating its contents or
  // relying on OS-dependent socket buffering. The recovery request uses real HTTP.
  const writer = f.gateway as unknown as { retainResponse(response: http.ServerResponse, bytes: number): () => void };
  const release = writer.retainResponse(response, LIMITS.retainedResponseBytes);
  try {
    expect(await (await f.post('/api/recover', f.request())).json()).toMatchObject({ ok: true, result: { restarted: true } });
    expect(f.managerCalls).toBe(1);
  } finally { release(); transport.destroy(); await f.close(); }
});

it.each([
  ['session', { cookie: '' }, undefined, 'unauthorized'],
  ['origin', { origin: 'https://foreign.invalid' }, undefined, 'origin'],
  ['csrf', { 'x-harness-csrf': '' }, undefined, 'csrf'],
  ['old-protocol', { 'x-harness-recovery': '' }, undefined, 'client_update_required'],
  ['other-method', {}, { method: 'thread/read', params: { threadId: 'x' } }, 'invalid'],
  ['missing-confirmation', {}, { params: {} }, 'invalid'],
  ['extra-parameter', {}, { params: { confirmStop: true, command: 'other' } }, 'invalid'],
  ['oversized-body', {}, { params: { confirmStop: true, extra: 'x'.repeat(8192) } }, 'capacity'],
] as const)('keeps emergency %s validation ahead of privileged execution', async (_label, headers, changes, code) => {
  const f = await fixture();
  try {
    const request = { ...f.request(), ...changes };
    expect(await (await f.post('/api/recover', request, headers)).json()).toMatchObject({ ok: false, error: { code, delivery: 'not_sent' } });
    expect(f.managerCalls).toBe(0); expect(f.completions).toHaveLength(0);
  } finally { await f.close(); }
});
