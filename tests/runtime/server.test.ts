import { afterEach, expect, test } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { startWorkerServer, configFromEnvironment } from '../../src/runtime/main.js';
import type { RuntimeService } from '../../src/runtime/service.js';
import { DeliveryError, LIMITS, type CallContext } from '../../src/runtime/types.js';
import { nativeCommand } from '../../src/runtime/native-launch.js';
const handles: Awaited<ReturnType<typeof startWorkerServer>>[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map(handle => handle.close())); });
async function setup(result?: () => unknown) {
  const service = Object.assign(new EventEmitter(), { status: () => ({ epoch: 'epoch', connected: true }), calls: [] as unknown[], writes: [] as string[], disconnected: [] as string[], closedChannels: [] as string[], writeGate: undefined as Promise<void> | undefined,
    async call(method: string, params: unknown, context: CallContext) { this.calls.push({ method, params, context }); await this.writeGate; context.beforeWrite?.(); this.writes.push(method); if (method === 'bad') throw new DeliveryError('invalid_params', 'bad parameters'); return result ? result() : { method }; },
    async clientDisconnected(clientId: string) { this.disconnected.push(clientId); }, async gatewayDisconnected(eventChannelId: string) { this.closedChannels.push(eventChannelId); },
  });
  const token = `${randomUUID()}${randomUUID()}`; const handle = await startWorkerServer(service as unknown as RuntimeService, { devPort: 0, token }); handles.push(handle); const port = (handle.server.address() as AddressInfo).port;
  return { service, token, base: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/events` };
}
async function connect(url: string, token: string) {
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
  const first = await new Promise<string>((resolve, reject) => { ws.once('message', data => resolve(data.toString())); ws.once('error', reject); });
  const state = JSON.parse(first) as { type: string; data: { eventChannelId: string } };
  expect(state).toMatchObject({ type: 'state', data: { epoch: 'epoch', connected: true, eventChannelId: expect.any(String) } });
  const headers = { authorization: `Bearer ${token}`, 'x-harness-event-channel': state.data.eventChannelId }; const clientId = randomUUID();
  const registration = await fetch(url.replace('ws:', 'http:').replace('/events', '/connect'), { method: 'POST', headers, body: JSON.stringify({ clientId }) }); expect(await registration.json()).toMatchObject({ ok: true });
  return { ws, eventChannelId: state.data.eventChannelId, headers, clientId };
}
test('worker HTTP authenticates all private routes and preserves delivery classification', async () => {
  const { token, base, service, ws } = await setup(); const channel = await connect(ws, token); const request = { method: 'good', params: {}, context: { clientId: channel.clientId, operationId: randomUUID() } };
  const unauthorized = await fetch(`${base}/rpc`, { method: 'POST', body: JSON.stringify(request) }); expect(unauthorized.status).toBe(401); expect(service.calls).toHaveLength(0);
  const missingChannel = await fetch(`${base}/rpc`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(request) }); expect(await missingChannel.json()).toMatchObject({ ok: false, error: { code: 'gateway_disconnected', delivery: 'not_sent' } }); expect(service.calls).toHaveLength(0);
  const accepted = await fetch(`${base}/rpc`, { method: 'POST', headers: channel.headers, body: JSON.stringify(request) }); expect(await accepted.json()).toEqual({ ok: true, result: { method: 'good' } }); expect(service.calls).toHaveLength(1);
  const denied = await fetch(`${base}/rpc`, { method: 'POST', headers: channel.headers, body: JSON.stringify({ ...request, method: 'bad' }) }); expect(await denied.json()).toMatchObject({ ok: false, error: { code: 'invalid_params', delivery: 'not_sent' } });
  await fetch(`${base}/disconnect`, { method: 'POST', headers: channel.headers, body: JSON.stringify({ clientId: channel.clientId }) }); expect(service.disconnected).toEqual([channel.clientId]);
});

// Controlled service outputs exercise the HTTP boundary; they do not establish
// that the real RuntimeService or pinned native CLI produces these invalid values.
test.each([
  { name: 'valid JSON', result: () => ({ value: 'accepted' }), expected: { ok: true, result: { value: 'accepted' } } },
  { name: 'byte capacity', result: () => ({ value: 'x'.repeat(LIMITS.frameBytes) }), expected: { ok: false, error: { code: 'capacity', message: 'JSON exceeds byte budget', delivery: 'unknown' } } },
  { name: 'invalid JSON value', result: () => ({ value: undefined }), expected: { ok: false, error: { code: 'invalid_json', message: 'Value is not JSON', delivery: 'unknown' } } },
  { name: 'explicit unknown error', result: () => ({ get value() { throw new DeliveryError('fixture_serialization', 'Fixture output is uncertain', 'unknown', { fixture: true }); } }), expected: { ok: false, error: { code: 'fixture_serialization', message: 'Fixture output is uncertain', delivery: 'unknown', data: { fixture: true } } } },
])('worker HTTP preserves completed-call delivery and the original error for $name', async ({ result, expected }) => {
  let completed = 0;
  const { token, base, service, ws } = await setup(() => { const value = result(); completed++; return value; });
  const owner = await connect(ws, token);
  const response = await fetch(`${base}/rpc`, { method: 'POST', headers: owner.headers, body: JSON.stringify({ method: 'fixture/mutate', params: {}, context: { clientId: owner.clientId, operationId: randomUUID() } }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(expected);
  expect(completed).toBe(1); expect(service.calls).toHaveLength(1); expect(service.writes).toEqual(['fixture/mutate']);
});

test('worker HTTP keeps a rejection before service.call as not_sent', async () => {
  let completed = 0;
  const { token, base, service, ws } = await setup(() => { completed++; return { value: 'must not run' }; });
  const owner = await connect(ws, token);
  const response = await fetch(`${base}/rpc`, { method: 'POST', headers: owner.headers, body: JSON.stringify({ method: 'fixture/mutate', params: [], context: { clientId: owner.clientId, operationId: randomUUID() } }) });
  expect(await response.json()).toEqual({ ok: false, error: { code: 'invalid_params', message: 'params must be an object', delivery: 'not_sent' } });
  expect(completed).toBe(0); expect(service.calls).toHaveLength(0); expect(service.writes).toEqual([]);
});

test('automatic CLI refresh waits for an in-flight RPC to finish before recycling the worker', async () => {
  const { token, base, service, ws } = await setup(); const owner = await connect(ws, token);
  let finish!: () => void; service.writeGate = new Promise(resolve => { finish = resolve; });
  let restarts = 0; service.on('restart-ready', () => { restarts++; });
  const pending = fetch(`${base}/rpc`, { method: 'POST', headers: owner.headers, body: JSON.stringify({ method: 'terminal/open', params: {}, context: { clientId: owner.clientId } }) });
  await expect.poll(() => service.calls.length).toBe(1);
  service.emit('restart-required'); expect(restarts).toBe(0);
  finish(); expect(await (await pending).json()).toMatchObject({ ok: true, result: { method: 'terminal/open' } });
  await expect.poll(() => restarts).toBe(1);
});
test('worker events start with state, are receive-only, and clean terminal owners on loss of the event channel', async () => {
  const { token, ws: url, service } = await setup(); const { ws, eventChannelId } = await connect(url, token);
  const closed = new Promise<number>(resolve => ws.once('close', code => resolve(code))); ws.send('{}'); expect(await closed).toBe(1008); await expect.poll(() => service.closedChannels).toContain(eventChannelId);
});

test('event-channel cleanup failure requests worker shutdown without an unhandled rejection', async () => {
  const { token, ws: url, service } = await setup(); const { ws } = await connect(url, token);
  service.gatewayDisconnected = async () => { throw new Error('Native cleanup was not confirmed'); };
  const fatal = new Promise<void>(resolve => service.once('fatal', resolve));
  ws.terminate(); await fatal;
});

test('a request body arriving after its channel closes stays revoked across reconnect and another live channel', async () => {
  const { token, base, ws: url, service } = await setup(); const old = await connect(url, token); const other = await connect(url, token);
  const body = JSON.stringify({ method: 'terminal/open', params: {}, context: { clientId: old.clientId } });
  let request!: http.ClientRequest;
  const response = new Promise<unknown>((resolve, reject) => { request = http.request(`${base}/rpc`, { method: 'POST', headers: { ...old.headers, 'content-length': Buffer.byteLength(body) } }, res => { let data = ''; res.on('data', chunk => { data += String(chunk); }); res.on('end', () => resolve(JSON.parse(data))); }); request.on('error', reject); });
  const admitted = new Promise<void>(resolve => handles.at(-1)!.server.once('request', () => resolve()));
  request.write(body.slice(0, 20)); await admitted;
  old.ws.terminate(); await expect.poll(() => service.closedChannels).toContain(old.eventChannelId);
  const replacement = await connect(url, token); expect(replacement.eventChannelId).not.toBe(old.eventChannelId); expect(other.ws.readyState).toBe(WebSocket.OPEN);
  request.end(body.slice(20)); expect(await response).toMatchObject({ ok: false, error: { code: 'gateway_disconnected', delivery: 'not_sent' } }); expect(service.calls).toHaveLength(0);
  const stale = await fetch(`${base}/rpc`, { method: 'POST', headers: old.headers, body }); expect(await stale.json()).toMatchObject({ ok: false, error: { code: 'gateway_disconnected' } });
  const fresh = await fetch(`${base}/rpc`, { method: 'POST', headers: replacement.headers, body: JSON.stringify({ method: 'terminal/open', params: {}, context: { clientId: replacement.clientId } }) }); expect(await fresh.json()).toMatchObject({ ok: true }); expect(service.writes).toEqual(['terminal/open']);
});

test('a channel closing after HTTP dispatch also fences the final native write while other sockets remain', async () => {
  const { token, base, ws: url, service } = await setup(); const owner = await connect(url, token); await connect(url, token);
  let resume!: () => void; service.writeGate = new Promise(resolve => { resume = resolve; });
  const pending = fetch(`${base}/rpc`, { method: 'POST', headers: owner.headers, body: JSON.stringify({ method: 'terminal/open', params: {}, context: { clientId: owner.clientId } }) });
  await expect.poll(() => service.calls.length).toBe(1); owner.ws.terminate(); await expect.poll(() => service.closedChannels).toContain(owner.eventChannelId); resume();
  expect(await (await pending).json()).toMatchObject({ ok: false, error: { code: 'gateway_disconnected', delivery: 'not_sent' } }); expect(service.writes).toEqual([]);
});

test.each(['body', 'native'])('browser lease revocation fences a late terminal %s without closing its gateway channel', async phase => {
  const { token, base, ws: url, service } = await setup(); const owner = await connect(url, token);
  const body = JSON.stringify({ method: 'terminal/open', params: {}, context: { clientId: owner.clientId } });
  let continueRequest!: () => void; let response: Promise<unknown>;
  if (phase === 'body') {
    let request!: http.ClientRequest;
    response = new Promise((resolve, reject) => { request = http.request(`${base}/rpc`, { method: 'POST', headers: { ...owner.headers, 'content-length': Buffer.byteLength(body) } }, res => { let data = ''; res.on('data', chunk => { data += String(chunk); }); res.on('end', () => resolve(JSON.parse(data))); }); request.on('error', reject); });
    const admitted = new Promise<void>(resolve => handles.at(-1)!.server.once('request', () => resolve())); request.write(body.slice(0, 20)); await admitted;
    continueRequest = () => request.end(body.slice(20));
  } else {
    service.writeGate = new Promise(resolve => { continueRequest = resolve; });
    response = fetch(`${base}/rpc`, { method: 'POST', headers: owner.headers, body }).then(result => result.json());
    await expect.poll(() => service.calls.length).toBe(1);
  }
  const disconnected = await fetch(`${base}/disconnect`, { method: 'POST', headers: owner.headers, body: JSON.stringify({ clientId: owner.clientId }) }); expect(await disconnected.json()).toMatchObject({ ok: true });
  continueRequest(); expect(await response).toMatchObject({ ok: false, error: { code: 'client_disconnected', delivery: 'not_sent' } }); expect(service.writes).toEqual([]); expect(owner.ws.readyState).toBe(WebSocket.OPEN);
  const replacement = randomUUID(); await fetch(`${base}/connect`, { method: 'POST', headers: owner.headers, body: JSON.stringify({ clientId: replacement }) });
  const stale = await fetch(`${base}/rpc`, { method: 'POST', headers: owner.headers, body }); expect(await stale.json()).toMatchObject({ ok: false, error: { code: 'client_disconnected' } });
  const fresh = await fetch(`${base}/rpc`, { method: 'POST', headers: owner.headers, body: JSON.stringify({ method: 'terminal/open', params: {}, context: { clientId: replacement } }) }); expect(await fresh.json()).toMatchObject({ ok: true });
});

test('only registered owners can issue RPCs and disconnect reclaims bounded lease capacity', async () => {
  const { token, base, ws: url } = await setup(); const owner = await connect(url, token);
  const unknown = await fetch(`${base}/rpc`, { method: 'POST', headers: owner.headers, body: JSON.stringify({ method: 'thread/read', params: {}, context: { clientId: randomUUID() } }) }); expect(await unknown.json()).toMatchObject({ ok: false, error: { code: 'client_disconnected' } });
  const register = (clientId: string) => fetch(`${base}/connect`, { method: 'POST', headers: owner.headers, body: JSON.stringify({ clientId }) }).then(result => result.json());
  for (let index = 0; index < 63; index++) expect(await register(randomUUID())).toMatchObject({ ok: true });
  const next = randomUUID(); expect(await register(next)).toMatchObject({ ok: false, error: { code: 'capacity', delivery: 'not_sent' } });
  await fetch(`${base}/disconnect`, { method: 'POST', headers: owner.headers, body: JSON.stringify({ clientId: owner.clientId }) }); expect(await register(next)).toMatchObject({ ok: true });
});

test('terminal output is routed only to its channel and transport identity is not relayed in events', async () => {
  const { token, ws: url, service } = await setup(); const owner = await connect(url, token), other = await connect(url, token);
  const next = (ws: WebSocket) => new Promise<unknown>(resolve => ws.once('message', data => resolve(JSON.parse(data.toString()))));
  const owned = next(owner.ws), unrelated = next(other.ws);
  service.emit('event', { type: 'terminal', data: { clientId: 'owner', type: 'output', deltaBase64: 'YQ==' }, eventChannelId: owner.eventChannelId });
  service.emit('event', { type: 'state', data: { epoch: 'epoch', connected: true } });
  expect(await owned).toEqual({ type: 'terminal', data: { clientId: 'owner', type: 'output', deltaBase64: 'YQ==' } });
  expect(await unrelated).toEqual({ type: 'state', data: { epoch: 'epoch', connected: true } });
});
test('child environment does not inherit administrator or management credentials', () => {
  const config = configFromEnvironment({ HARNESS_DEV: '1', HARNESS_CODEX_BIN: process.execPath, HARNESS_CODEX_HOME: process.cwd(), HARNESS_WORKER_HOME: process.cwd(), HARNESS_WORKER_TOKEN: `${randomUUID()}${randomUUID()}`, HARNESS_ADMIN_TOKEN: 'not-a-secret-fixture', HARNESS_PROVIDER_API_KEY: 'fixture', AWS_BEARER_TOKEN_BEDROCK: 'fixture-bedrock', AWS_REGION: 'us-west-2', ARBITRARY_GATEWAY_ENV: 'must-not-inherit' });
  expect(config.runtime.env.HARNESS_PROVIDER_API_KEY).toBe('fixture'); expect(config.runtime.env.HARNESS_ADMIN_TOKEN).toBeUndefined(); expect(config.runtime.env.HARNESS_WORKER_TOKEN).toBeUndefined(); expect(config.runtime.env.ARBITRARY_GATEWAY_ENV).toBeUndefined();
  expect(config.runtime.env.AWS_BEARER_TOKEN_BEDROCK).toBe('fixture-bedrock'); expect(config.runtime.env.AWS_REGION).toBe('us-west-2');
});
test('native home is a separate normalized trusted path and never a child environment override', () => {
  const base = { HARNESS_DEV: '1', HARNESS_CODEX_BIN: process.execPath, HARNESS_CODEX_HOME: process.cwd(), HARNESS_WORKER_HOME: process.cwd(), HARNESS_WORKER_TOKEN: `${randomUUID()}${randomUUID()}` };
  const nativeHome = path.resolve('.work/native-home'); const config = configFromEnvironment({ ...base, HARNESS_NATIVE_HOME: nativeHome });
  expect(config.runtime.nativeHome).toBe(nativeHome); expect(config.runtime.env.HOME).toBe(base.HARNESS_WORKER_HOME); expect(config.runtime.env.HARNESS_NATIVE_HOME).toBeUndefined();
  expect(() => configFromEnvironment({ ...base, HARNESS_NATIVE_HOME: 'relative' })).toThrow('absolute normalized');
  expect(() => configFromEnvironment({ ...base, HARNESS_DEV: '0' })).toThrow('HARNESS_NATIVE_HOME');
});
test('production native launch uses only fixed modes and does not enter a native-only project as supervisor', () => {
  const config = { bin: '/not-executed/codex', cwd: '/native-only-project', env: { HARNESS_PROVIDER_API_KEY: 'redactor-only', HARNESS_WORKER_TOKEN: 'must-not-pass' }, args: ['untrusted-arguments'], launcher: { path: '/usr/lib/codex-harness/test/native-launch', user: 'ch-test-worker' } };
  for (const mode of ['version', 'app-server', 'resolve-project'] as const) expect(nativeCommand(config, mode)).toEqual({ bin: '/usr/bin/sudo', args: ['-n', '-u', 'ch-test-worker', '--', '/usr/lib/codex-harness/test/native-launch', mode], cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
});
