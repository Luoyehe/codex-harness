import net from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { afterEach, expect, it } from 'vitest';

type Fixture = { url: string; close: () => Promise<void> };
const signalsBeforeImport = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
// A URL import exercises the actual standalone Node module without a transpiled copy.
const { startPreviewServer } = await import(new URL('./preview-server.mjs', import.meta.url).href) as {
  startPreviewServer: (options?: { port?: number; lifetimeMs?: number }) => Promise<Fixture>;
};
const signalsAfterImport = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()));
  expect(results.filter(result => result.status === 'rejected')).toEqual([]);
});
async function fixture(lifetimeMs?: number) {
  const value = await startPreviewServer({ port: 0, ...(lifetimeMs ? { lifetimeMs } : {}) });
  cleanup.push(value.close);
  return value;
}
const rpc = (server: Fixture, method: string, params = {}) => fetch(server.url + '/api/rpc', {
  method: 'POST', body: JSON.stringify({ method, params }),
});
async function ready(server: Fixture) {
  const response = await fetch(server.url + '/api/session');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ authenticated: true, operationRecoveryProtocol: 2, csrf: 'visual-fixture-only' });
}
async function socket(server: Fixture) {
  const client = net.createConnection({ host: '127.0.0.1', port: Number(new URL(server.url).port) });
  cleanup.push(() => client.destroy());
  client.on('error', () => {});
  await once(client, 'connect');
  return client;
}

it('imports without process handlers and supplies the current loaded-thread and catalog read contracts', async () => {
  expect(signalsAfterImport).toEqual(signalsBeforeImport);
  const server = await fixture();
  expect(new URL(server.url).hostname).toBe('127.0.0.1');
  await ready(server);
  const session = await (await rpc(server, 'thread/session', { threadId: 'visual-thread' })).json();
  expect(session).toMatchObject({ ok: true, result: {
    requiresResume: false, thread: { id: 'visual-thread', status: { type: 'idle' } },
    model: 'visual-model', reasoningEffort: 'medium',
  } });
  const modes = await (await rpc(server, 'collaborationMode/list')).json();
  expect(modes.result.data).toEqual([
    { name: '执行', mode: 'default', model: 'visual-model', reasoning_effort: 'medium' },
    { name: '计划', mode: 'plan', model: 'visual-model', reasoning_effort: 'medium' },
  ]);
  expect(await (await rpc(server, 'environment/list')).json()).toEqual({ ok: true, result: { data: [] } });
  expect(await (await rpc(server, 'thread/history', { threadId: 'visual-thread' })).json()).toMatchObject({
    ok: true, result: { complete: true, turnsComplete: true, timelineComplete: true, historyVersion: 0, nextCursor: null },
  });
});

it('rejects all non-allowlisted methods including resume and inherited object properties', async () => {
  const server = await fixture();
  for (const method of ['thread/resume', 'turn/start', 'conversation/start', 'workspace/write', 'terminal/open', 'toString', '__proto__']) {
    expect(await (await rpc(server, method)).json()).toMatchObject({ ok: false, error: { code: 'fixture_readonly', delivery: 'not_sent' } });
  }
  expect((await fetch(server.url + '/api/session', { method: 'DELETE' })).status).toBe(405);
  await ready(server);
});

it.each(['', '{', 'null', '[]', 'true', '{}', '{"method":1}', '{"method":""}'])(
  'returns a bounded 400 for invalid body %j and remains usable', async body => {
    const server = await fixture();
    const response = await fetch(server.url + '/api/rpc', { method: 'POST', body });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'fixture_invalid_request', delivery: 'not_sent' } });
    await ready(server);
  },
);

it('rejects a request beyond its byte budget without losing the server', async () => {
  const server = await fixture();
  const response = await fetch(server.url + '/api/rpc', { method: 'POST', body: JSON.stringify({ method: 'thread/read', text: '界'.repeat(34000) }) });
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ ok: false, error: { code: 'fixture_limit' } });
  await ready(server);
});

it('contains an interrupted body after accepting its headers and remains usable', async () => {
  const server = await fixture(), client = await socket(server);
  const accepted = once(client, 'data');
  client.write('POST /api/rpc HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\nExpect: 100-continue\r\n\r\n');
  expect(String((await accepted)[0])).toContain('100 Continue');
  await new Promise<void>((resolve, reject) => client.write('{"method":', error => error ? reject(error) : resolve()));
  const ended = once(client, 'close');
  client.destroy();
  await ended;
  await ready(server);
  expect(await (await rpc(server, 'environment/list')).json()).toEqual({ ok: true, result: { data: [] } });
});

it('closes its own incomplete HTTP body and active WebSocket, idempotently', async () => {
  const server = await fixture(), client = await socket(server);
  client.write('POST /api/rpc HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\n{');
  const websocket = new WebSocket(server.url.replace('http:', 'ws:') + '/api/events');
  cleanup.push(() => websocket.terminate());
  websocket.on('error', () => {});
  const state = JSON.parse(String((await once(websocket, 'message'))[0]));
  expect(state).toMatchObject({ type: 'state', data: { connected: true, activity: { unknown: false } } });
  const httpClosed = once(client, 'close'), wsClosed = once(websocket, 'close');
  await Promise.all([server.close(), server.close(), httpClosed, wsClosed]);
  expect(websocket.readyState).toBe(WebSocket.CLOSED);
  await expect(fetch(server.url + '/api/session')).rejects.toThrow();
});

it('enforces its lifetime even with an incomplete request', async () => {
  const server = await fixture(250), client = await socket(server);
  client.write('POST /api/rpc HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\n{');
  await once(client, 'close');
  await expect(fetch(server.url + '/api/session')).rejects.toThrow();
});

it('rejects a failed listen while leaving the original fixture usable', async () => {
  const server = await fixture();
  await expect(startPreviewServer({ port: Number(new URL(server.url).port) })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  await ready(server);
});
