import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkerClient } from '../../src/gateway/worker-client.js';
import { HarnessError } from '../../src/core/errors.js';
import { Ledger } from '../../src/core/ledger.js';
import { Dispatcher } from '../../src/gateway/dispatch.js';
import type { JsonValue } from '../../src/core/contracts.js';
afterEach(() => vi.restoreAllMocks());

it.each(['not_sent', 'unknown'])('preserves partial conversion identity and %s delivery through durable replay', async delivery => {
  const detail = { phase: 'conversion', threadId: 'converted', sourceThreadId: 'source', inputSent: false };
  const f = await fixture({ ok: false, error: { code: 'history_conversion_failed', message: 'Inspect converted conversation.', delivery,
    data: { ...detail, name: 'private title', path: '/private', secret: 'private token' } } });
  const directory = mkdtempSync(path.resolve('.work/worker-conversion-')), file = path.join(directory, 'journal.sqlite');
  let ledger = new Ledger(file);
  try {
    await f.handshake(f.socket, randomUUID());
    let dispatcher = new Dispatcher(ledger, f.worker, { call: vi.fn(async () => ({})) });
    dispatcher.event({ type: 'state', data: { connected: true, activity: { activeThreads: [], pendingStarts: 0, terminals: 0, unknown: false } } });
    const call = { method: 'thread/convert', operationId: randomUUID(), params: { threadId: 'source' } }, context = { clientId: randomUUID() };
    await expect(dispatcher.call(call, context)).rejects.toMatchObject({ delivery, data: detail });
    expect(ledger.read(call.operationId)).toMatchObject({ state: delivery, error: { data: detail } });
    expect(JSON.stringify(ledger.read(call.operationId))).not.toContain('private');
    ledger.close(); ledger = new Ledger(file);
    dispatcher = new Dispatcher(ledger, f.worker, { call: vi.fn(async () => ({})) });
    await expect(dispatcher.call(call, context)).rejects.toMatchObject({ delivery, data: detail });
    expect(f.requests).toHaveLength(1);
  } finally { ledger.close(); await f.close(); rmSync(directory, { recursive: true, force: true }); }
});
it.each([
  { method: 'thread/read', source: 'source', threadId: 'converted', inputSent: false },
  { method: 'thread/convert', source: 'other', threadId: 'converted', inputSent: false },
  { method: 'thread/convert', source: 'source', threadId: 'converted', inputSent: true },
  { method: 'thread/convert', source: 'source', threadId: 'source', inputSent: false },
  { method: 'thread/convert', source: 'source', threadId: 'x'.repeat(257), inputSent: false },
])('drops unrelated or malformed conversion identities: %j', async ({ method, source, threadId, inputSent }) => {
  const f = await fixture({ ok: false, error: { code: 'failure', message: 'Failure', delivery: 'unknown',
    data: { phase: 'conversion', inputSent, threadId, sourceThreadId: source } } });
  try {
    await f.handshake(f.socket, randomUUID());
    const failure = await f.worker.call(method, { threadId: 'source' }, { clientId: randomUUID() }).catch(error => error as HarnessError);
    expect((failure as HarnessError).data).toBeUndefined();
  } finally { await f.close(); }
});

async function fixture(response: JsonValue | ((request: http.IncomingMessage) => JsonValue | Promise<JsonValue>) = { ok: true, result: {} }) {
  const requests: { path: string; channel: unknown; body: Record<string, unknown> }[] = [];
  let loseRegistration = false;
  const server = http.createServer((req, res) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ path: req.url!, channel: req.headers['x-harness-event-channel'], body: JSON.parse(Buffer.concat(chunks).toString()) });
    if (loseRegistration && req.url === '/connect') { res.destroy(); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(typeof response === 'function' ? await response(req) : response));
  })().catch(() => res.destroy()); });
  const wss = new WebSocketServer({ server, path: '/events' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const worker = new WorkerClient({ port }); const events: unknown[] = [];
  worker.on('event', event => events.push(event));
  const connect = async () => { const ready = once(wss, 'connection'); worker.connect(); return (await ready)[0] as WebSocket; };
  const handshake = async (socket: WebSocket, id: string) => { socket.send(JSON.stringify({ type: 'state', data: { eventChannelId: id, epoch: 'same-worker', connected: true, activity: { unknown: false } } })); await expect.poll(() => worker.connected).toBe(true); };
  const socket = await connect();
  return { worker, socket, requests, events, connect, handshake, loseRegistration: () => { loseRegistration = true; }, close: async () => { worker.close(); for (const socket of wss.clients) socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
it.each(['/connect', '/disconnect'])('ignores a retired channel’s delayed %s result when releasing a replacement owner', async delayed => {
  const old = randomUUID(), fresh = randomUUID(), owner = randomUUID();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async req => {
    if (req.headers['x-harness-event-channel'] === old && req.url === delayed) {
      await gate;
      if (delayed === '/connect') return { ok: false, error: { code: 'capacity', message: 'Not registered', delivery: 'not_sent' } };
    }
    return { ok: true, result: {} };
  });
  try {
    await f.handshake(f.socket, old);
    if (delayed === '/disconnect') await f.worker.clientConnected(owner);
    const earlier = delayed === '/disconnect' ? f.worker.clientDisconnected(owner)
      : expect(f.worker.clientConnected(owner)).rejects.toMatchObject({ delivery: 'not_sent' });
    await vi.waitFor(() => expect(f.requests.at(-1)?.path).toBe(delayed));
    const offline = once(f.worker, 'disconnect'); f.socket.terminate(); await offline;
    await f.handshake(await f.connect(), fresh); await f.worker.clientConnected(owner);
    release(); await earlier; await f.worker.clientDisconnected(owner);
    expect(f.requests.filter(row => row.channel === fresh).map(row => row.path)).toEqual(['/connect', '/disconnect']);
  } finally { release(); await f.close(); }
});

it('orders release and subsequent registrations of a reused owner on one event channel', async () => {
  const owner = randomUUID();
  let resume!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const f = await fixture(async req => {
    if (req.url === '/disconnect') await gate;
    return { ok: true, result: {} };
  });
  try {
    await f.handshake(f.socket, randomUUID());
    await Promise.all([f.worker.clientConnected(owner), f.worker.clientConnected(owner)]);
    const firstRelease = f.worker.clientDisconnected(owner);
    await vi.waitFor(() => expect(f.requests.at(-1)?.path).toBe('/disconnect'));
    const reconnect = f.worker.clientConnected(owner), again = f.worker.clientConnected(owner);
    const finalRelease = f.worker.clientDisconnected(owner);
    resume(); await Promise.all([firstRelease, reconnect, again, finalRelease]);
    expect(f.requests.map(row => row.path)).toEqual(['/connect', '/disconnect', '/connect', '/disconnect']);
  } finally { resume(); await f.close(); }
});

it('uses the longest supported duty only for explicit manual MCP calls', async () => {
  const f = await fixture();
  try {
    await f.handshake(f.socket, randomUUID());
    const timer = vi.spyOn(globalThis, 'setTimeout');
    for (const [method, expected] of [['mcp/tool/call', 1_940_000], ['plugin/install', 350_000], ['thread/read', 350_000], ['turn/start', 350_000]] as const) {
      timer.mockClear();
      await f.worker.call(method, {}, { clientId: randomUUID() });
      expect(timer.mock.calls.some(([, delay]) => delay === expected)).toBe(true);
      if (method !== 'mcp/tool/call') expect(timer.mock.calls.some(([, delay]) => delay === 1_940_000)).toBe(false);
    }
  } finally { await f.close(); }
});
it('a definite registration refusal does not disconnect other owners on the shared worker channel', async () => {
  const f = await fixture({ ok: false, error: { code: 'capacity', message: 'Registration capacity', delivery: 'not_sent' } });
  try {
    await f.handshake(f.socket, randomUUID()); const owner = randomUUID();
    await expect(f.worker.clientConnected(owner)).rejects.toMatchObject({ code: 'capacity', delivery: 'not_sent' });
    expect(f.worker.connected).toBe(true); await f.worker.clientDisconnected(owner);
    expect(f.requests.map(row => row.path)).toEqual(['/connect']);
  } finally { await f.close(); }
});
it('requires a channel handshake, binds registration/RPC/revocation headers and hides the credential', async () => {
  const f = await fixture(), channel = randomUUID(), owner = randomUUID();
  try {
    expect(f.worker.connected).toBe(false);
    await expect(f.worker.call('thread/read', {}, { clientId: owner })).rejects.toMatchObject({ code: 'worker_unavailable', delivery: 'not_sent' });
    expect(f.requests).toEqual([]);
    await f.handshake(f.socket, channel);
    expect(JSON.stringify(f.events)).not.toContain(channel);
    await f.worker.clientConnected(owner);
    await f.worker.call('thread/read', {}, { clientId: owner });
    await f.worker.clientDisconnected(owner);
    expect(f.requests.map(r => r.path)).toEqual(['/connect', '/rpc', '/disconnect']);
    expect(f.requests.every(r => r.channel === channel)).toBe(true);
  } finally { await f.close(); }
});
it('does not dispatch a queued HTTP write through a replacement event channel', async () => {
  const f = await fixture(), first = randomUUID(), second = randomUUID();
  try {
    await f.handshake(f.socket, first);
    const request = Object.assign(new EventEmitter(), { destroyed: false, end: vi.fn(), destroy() { this.destroyed = true; } });
    vi.spyOn(http, 'request').mockReturnValueOnce(request as unknown as http.ClientRequest);
    const beforeWrite = vi.fn(), pending = f.worker.call('turn/start', {}, { clientId: randomUUID(), beforeWrite });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'worker_unavailable', delivery: 'not_sent' });
    const transport = Object.assign(new EventEmitter(), { connecting: true }); request.emit('socket', transport);
    const disconnected = once(f.worker, 'disconnect'); f.socket.terminate(); await disconnected;
    const replacement = await f.connect(); await f.handshake(replacement, second);
    transport.emit('connect'); await rejected;
    expect(beforeWrite).not.toHaveBeenCalled(); expect(request.end).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
it.each(['thread/read', 'thread/realtime/appendText', 'thread/name/set'])('rechecks authorization and the exact browser owner before queued %s bytes leave', async method => {
  const f = await fixture();
  try {
    await f.handshake(f.socket, randomUUID());
    for (const cause of ['authorization', 'connection'] as const) {
      let authorized = true, live = true;
      const request = Object.assign(new EventEmitter(), { destroyed: false, end: vi.fn(), destroy() { this.destroyed = true; } });
      vi.spyOn(http, 'request').mockReturnValueOnce(request as unknown as http.ClientRequest);
      const beforeWrite = vi.fn(), pending = f.worker.call(method, {}, { clientId: randomUUID(), beforeWrite,
        requireAuthorization() { if (!authorized) throw new HarnessError('unauthorized', 'Session revoked'); },
        requireConnection() { if (!live) throw new HarnessError('connection_required', 'Owner replaced'); },
      });
      const code = cause === 'authorization' ? 'unauthorized' : 'connection_required';
      const rejected = expect(pending).rejects.toMatchObject({ code, delivery: 'not_sent' });
      const transport = Object.assign(new EventEmitter(), { connecting: true }); request.emit('socket', transport);
      if (cause === 'authorization') authorized = false; else live = false;
      transport.emit('connect'); await rejected;
      expect(beforeWrite).not.toHaveBeenCalled(); expect(request.end).not.toHaveBeenCalled(); expect(request.destroyed).toBe(true);
    }
    expect(f.requests).toEqual([]);
  } finally { await f.close(); }
});
it('checks valid request guards at the send boundary and excludes them from the worker envelope', async () => {
  const f = await fixture(), calls: string[] = [];
  try {
    await f.handshake(f.socket, randomUUID());
    await f.worker.call('thread/read', {}, { clientId: 'owner',
      requireAuthorization: () => { calls.push('authorization'); }, requireConnection: () => { calls.push('connection'); },
      beforeWrite: () => { calls.push('dispatch'); },
    });
    expect(calls).toEqual(['authorization', 'connection', 'dispatch']);
    expect(f.requests).toHaveLength(1); expect(f.requests[0]!.body.context).toEqual({ clientId: 'owner' });
  } finally { await f.close(); }
});
it('fences unknown lease registration by closing its channel and ignores cleanup from retired channels', async () => {
  const f = await fixture(), owner = randomUUID();
  try {
    await f.handshake(f.socket, randomUUID()); f.loseRegistration();
    const disconnected = once(f.worker, 'disconnect');
    await expect(f.worker.clientConnected(owner)).rejects.toMatchObject({ delivery: 'unknown' }); await disconnected;
    expect(f.worker.connected).toBe(false);
    const replacement = await f.connect(); await f.handshake(replacement, randomUUID());
    const count = f.requests.length; await f.worker.clientDisconnected(owner);
    expect(f.requests).toHaveLength(count); expect(f.worker.connected).toBe(true);
  } finally { await f.close(); }
});

it.each([
  ['review/startNew', 'review_start_incomplete', 'review'],
  ['conversation/start', 'conversation_start_incomplete', 'first_turn'],
])('retains only bounded partial identity for %s through HTTP, durable receipts and replay', async (method, code, phase) => {
  const data = { phase, threadId: 'partial-thread', causeCode: 'client_disconnected' };
  const f = await fixture({ ok: false, error: { code, message: 'Thread created; inspect before retrying.', delivery: 'unknown', data: { ...data, causeDelivery: 'not_sent', token: 'private-token', nested: { content: 'private-content' } } } });
  const directory = mkdtempSync(path.join(tmpdir(), 'worker-partial-receipt-')), file = path.join(directory, 'ledger.sqlite');
  let ledger = new Ledger(file);
  try {
    await f.handshake(f.socket, randomUUID());
    const manager = { call: vi.fn(async () => ({})) };
    const dispatcher = new Dispatcher(ledger, f.worker, manager);
    dispatcher.event({ type: 'state', data: { connected: true, activity: { activeThreads: [], pendingStarts: 0, terminals: 0, unknown: false } } });
    const project = ledger.addProject(directory, 'Partial review');
    const call = { method, operationId: randomUUID(), params: { projectId: project.id } }, context = { clientId: randomUUID() };
    const failure = await dispatcher.call(call, context).then(() => { throw new Error('Expected partial failure'); }, (error: unknown) => error as HarnessError);
    expect(failure).toBeInstanceOf(HarnessError);
    expect(failure).toMatchObject({ code, delivery: 'unknown' }); expect(failure.data).toEqual(data);
    expect(ledger.read(call.operationId)).toMatchObject({ state: 'unknown', error: { code, delivery: 'unknown', data } });
    ledger.close(); ledger = new Ledger(file);
    const restored = new Dispatcher(ledger, f.worker, manager);
    const receipt = await restored.call({ method: 'operation/read', params: { operationId: call.operationId } }, context);
    expect(receipt).toMatchObject({ state: 'unknown', error: { code, delivery: 'unknown', data } });
    expect(ledger.read(call.operationId)?.error?.data).toEqual(data);
    const replay = await restored.call(call, context).then(() => { throw new Error('Expected uncertain replay'); }, (error: unknown) => error as HarnessError);
    expect(replay).toMatchObject({ code: 'operation_unknown', delivery: 'unknown' }); expect(replay.data).toEqual(data);
    expect(f.requests).toHaveLength(1); expect(manager.call).not.toHaveBeenCalled();
  } finally { ledger.close(); await f.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('bounds partial identities and discards malformed or unrelated worker error data', async () => {
  const valid = { phase: 'review', threadId: 't'.repeat(256), causeCode: 'c'.repeat(128) };
  const cases: { input: JsonValue; expected?: JsonValue }[] = [
    { input: { ...valid, secret: 'must-not-leak' }, expected: valid },
    { input: null }, { input: [] }, { input: 'must-not-leak' }, { input: { secret: 'must-not-leak' } },
    { input: { ...valid, phase: 'unrecognized' } }, { input: { ...valid, phase: {} } },
    { input: { ...valid, threadId: '' } }, { input: { ...valid, threadId: 't'.repeat(257) } }, { input: { ...valid, threadId: {} } },
    { input: { ...valid, causeCode: '' } }, { input: { ...valid, causeCode: 'c'.repeat(129) } }, { input: { ...valid, causeCode: [] } },
  ];
  for (const { input, expected } of cases) {
    const f = await fixture({ ok: false, error: { code: 'review_start_incomplete', message: 'Inspect partial thread.', delivery: 'unknown', data: input } });
    try {
      await f.handshake(f.socket, randomUUID());
      const failure = await f.worker.call('review/startNew', {}, { clientId: randomUUID() }).then(() => { throw new Error('Expected worker failure'); }, (error: unknown) => error as HarnessError);
      expect(failure).toBeInstanceOf(HarnessError); expect(failure.delivery).toBe('unknown'); expect(failure.data).toEqual(expected);
    } finally { await f.close(); }
  }
});

it('keeps the created thread and definitive unsent first turn without blocking the next project', async () => {
  const detail = { phase: 'first_turn', threadId: 'empty-thread', causeCode: 'model_capability', threadCreated: true, inputSent: false };
  let createAllowed = false;
  const f = await fixture((): JsonValue => createAllowed ? { ok: true, result: { thread: { id: 'next' }, turn: { id: 'next-turn' } } } :
    { ok: false, error: { code: 'conversation_start_incomplete', message: 'First input was not sent', delivery: 'not_sent', data: detail } });
  const ledger = new Ledger(':memory:');
  try {
    await f.handshake(f.socket, randomUUID());
    const dispatcher = new Dispatcher(ledger, f.worker, { call: async () => ({}) });
    dispatcher.event({ type: 'state', data: { connected: true, activity: { activeThreads: [], pendingStarts: 0, terminals: 0, unknown: false } } });
    const a = ledger.addProject('/a', 'A'), b = ledger.addProject('/b', 'B'), owner = { clientId: randomUUID() };
    const call = { method: 'conversation/start', operationId: randomUUID(), params: { projectId: a.id, text: 'A' } };
    await expect(dispatcher.call(call, owner)).rejects.toMatchObject({ delivery: 'not_sent', data: detail });
    await expect(dispatcher.call(call, owner)).rejects.toMatchObject({ delivery: 'not_sent', data: detail });
    expect(ledger.read(call.operationId)).toMatchObject({ state: 'not_sent', error: { data: detail } });
    expect(ledger.getMeta('activityUncertain')).not.toBe('true');
    createAllowed = true;
    await expect(dispatcher.call({ ...call, operationId: randomUUID(), params: { projectId: b.id, text: 'B' } }, owner)).resolves.toMatchObject({ thread: { id: 'next' } });
    expect(f.requests).toHaveLength(2);
  } finally { ledger.close(); await f.close(); }
});
