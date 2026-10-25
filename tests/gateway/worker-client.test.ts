import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkerClient } from '../../src/gateway/worker-client.js';
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const requests: { path: string; channel: unknown; body: Record<string, unknown> }[] = [];
  let loseRegistration = false;
  const server = http.createServer((req, res) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ path: req.url!, channel: req.headers['x-harness-event-channel'], body: JSON.parse(Buffer.concat(chunks).toString()) });
    if (loseRegistration && req.url === '/connect') { res.destroy(); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result: {} }));
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
