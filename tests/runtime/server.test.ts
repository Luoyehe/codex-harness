import { afterEach, expect, test } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { chmodSync, existsSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { temporaryWorkerSocket } from '../fixtures/worker-socket.js';
import { WebSocket } from 'ws';
import { startWorkerServer, configFromEnvironment } from '../../src/runtime/main.js';
import type { RuntimeService } from '../../src/runtime/service.js';
import { DeliveryError, LIMITS, type CallContext } from '../../src/runtime/types.js';
import { nativeCommand } from '../../src/runtime/native-launch.js';
const handles: Awaited<ReturnType<typeof startWorkerServer>>[] = [];
const endpoints: ReturnType<typeof temporaryWorkerSocket>[] = [];
afterEach(async () => {
  try { await Promise.all(handles.splice(0).map(handle => handle.close())); }
  finally { for (const endpoint of endpoints.splice(0)) endpoint.close(); }
});
function post(socketPath: string, route: string, options: { body: string; headers?: http.OutgoingHttpHeaders }): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: route, method: 'POST', headers: options.headers }, response => {
      const data: Buffer[] = []; response.on('data', chunk => data.push(Buffer.from(chunk)));
      response.on('error', reject); response.on('end', () => resolve(new Response(Buffer.concat(data), { status: response.statusCode! })));
    });
    request.on('error', reject); request.end(options.body);
  });
}
async function setup(result?: () => unknown) {
  const service = Object.assign(new EventEmitter(), { status: () => ({ epoch: 'epoch', connected: true }), calls: [] as unknown[], writes: [] as string[], disconnected: [] as string[], closedChannels: [] as string[], writeGate: undefined as Promise<void> | undefined,
    async call(method: string, params: unknown, context: CallContext) { this.calls.push({ method, params, context }); await this.writeGate; context.beforeWrite?.(); this.writes.push(method); if (method === 'bad') throw new DeliveryError('invalid_params', 'bad parameters'); return result ? result() : { method }; },
    async clientDisconnected(clientId: string) { this.disconnected.push(clientId); }, async gatewayDisconnected(eventChannelId: string) { this.closedChannels.push(eventChannelId); },
  });
  const endpoint = temporaryWorkerSocket(); endpoints.push(endpoint);
  const handle = await startWorkerServer(service as unknown as RuntimeService, { socket: endpoint.socketPath, development: true });
  handles.push(handle);
  return { service, socketPath: endpoint.socketPath };
}
async function connect(socketPath: string) {
  const ws = new WebSocket('ws://localhost/events', { createConnection: () => createConnection(socketPath) });
  const first = await new Promise<string>((resolve, reject) => { ws.once('message', data => resolve(data.toString())); ws.once('error', reject); });
  const state = JSON.parse(first) as { type: string; data: { eventChannelId: string } };
  expect(state).toMatchObject({ type: 'state', data: { epoch: 'epoch', connected: true, eventChannelId: expect.any(String) } });
  const headers = { 'x-harness-event-channel': state.data.eventChannelId }; const clientId = randomUUID();
  const registration = await post(socketPath, '/connect', { headers, body: JSON.stringify({ clientId }) }); expect(await registration.json()).toMatchObject({ ok: true });
  return { ws, eventChannelId: state.data.eventChannelId, headers, clientId };
}
test('worker binds a private socket, preserves an active listener, and removes its name on shutdown', async () => {
  const { socketPath, service } = await setup();
  expect(handles.at(-1)!.server.address()).toBe(socketPath);
  expect(lstatSync(path.dirname(socketPath)).mode & 0o777).toBe(0o700);
  expect(lstatSync(socketPath).mode & 0o777).toBe(0o600);
  const start = (socket: string, development = true) => startWorkerServer(service as unknown as RuntimeService, { socket, development });
  await expect(start(socketPath)).rejects.toThrow('active');
  await connect(socketPath);
  await handles.pop()!.close();
  expect(existsSync(socketPath)).toBe(false);
  const production = await start(socketPath, false); handles.push(production);
  expect(lstatSync(socketPath).mode & 0o777).toBe(0o660);
});

test('a stopped worker socket can be reclaimed and used by a new listener', async () => {
  const { socketPath, service } = await setup();
  await handles.pop()!.close();
  // Exiting without server.close() leaves the kernel socket name behind.
  execFileSync(process.execPath, ['-e', "require('node:net').createServer().listen(process.argv[1], () => process.exit(0))", socketPath], { timeout: 5000 });
  expect(lstatSync(socketPath).isSocket()).toBe(true);
  handles.push(await startWorkerServer(service as unknown as RuntimeService, { socket: socketPath, development: true }));
  await connect(socketPath);
});

test('unsafe socket directories and occupied non-socket paths are refused', async () => {
  const { socketPath, service } = await setup();
  const directory = path.dirname(socketPath);
  const start = (socket: string) => startWorkerServer(service as unknown as RuntimeService, { socket, development: true });
  const occupied = path.join(directory, 'file'); writeFileSync(occupied, 'fixture');
  const link = path.join(directory, 'link'); symlinkSync(occupied, link);
  for (const target of [occupied, link]) await expect(start(target)).rejects.toThrow('unsafe worker socket');
  await expect(start('relative')).rejects.toThrow('absolute normalized');
  const shared = path.join(directory, 'shared'); mkdirSync(shared); chmodSync(shared, 0o777);
  await expect(start(path.join(shared, 'worker.sock'))).rejects.toThrow('owner-only');
  const privateChild = path.join(shared, 'private'); mkdirSync(privateChild, { mode: 0o700 });
  await expect(start(path.join(privateChild, 'worker.sock'))).rejects.toThrow('unsafe ancestor');
});

test('worker RPC requires its live event channel and preserves delivery classification', async () => {
  const { socketPath, service } = await setup(); const channel = await connect(socketPath); const request = { method: 'good', params: {}, context: { clientId: channel.clientId, operationId: randomUUID() } };
  const missingChannel = await post(socketPath, '/rpc', { body: JSON.stringify(request) }); expect(await missingChannel.json()).toMatchObject({ ok: false, error: { code: 'gateway_disconnected', delivery: 'not_sent' } }); expect(service.calls).toHaveLength(0);
  const accepted = await post(socketPath, '/rpc', { headers: channel.headers, body: JSON.stringify(request) }); expect(await accepted.json()).toEqual({ ok: true, result: { method: 'good' } }); expect(service.calls).toHaveLength(1);
  const denied = await post(socketPath, '/rpc', { headers: channel.headers, body: JSON.stringify({ ...request, method: 'bad' }) }); expect(await denied.json()).toMatchObject({ ok: false, error: { code: 'invalid_params', delivery: 'not_sent' } });
  await post(socketPath, '/disconnect', { headers: channel.headers, body: JSON.stringify({ clientId: channel.clientId }) }); expect(service.disconnected).toEqual([channel.clientId]);
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
  const { socketPath, service } = await setup(() => { const value = result(); completed++; return value; });
  const owner = await connect(socketPath);
  const response = await post(socketPath, '/rpc', { headers: owner.headers, body: JSON.stringify({ method: 'fixture/mutate', params: {}, context: { clientId: owner.clientId, operationId: randomUUID() } }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(expected);
  expect(completed).toBe(1); expect(service.calls).toHaveLength(1); expect(service.writes).toEqual(['fixture/mutate']);
});

test('worker HTTP keeps a rejection before service.call as not_sent', async () => {
  let completed = 0;
  const { socketPath, service } = await setup(() => { completed++; return { value: 'must not run' }; });
  const owner = await connect(socketPath);
  const response = await post(socketPath, '/rpc', { headers: owner.headers, body: JSON.stringify({ method: 'fixture/mutate', params: [], context: { clientId: owner.clientId, operationId: randomUUID() } }) });
  expect(await response.json()).toEqual({ ok: false, error: { code: 'invalid_params', message: 'params must be an object', delivery: 'not_sent' } });
  expect(completed).toBe(0); expect(service.calls).toHaveLength(0); expect(service.writes).toEqual([]);
});

test('automatic CLI refresh waits for an in-flight RPC to finish before recycling the worker', async () => {
  const { socketPath, service } = await setup(); const owner = await connect(socketPath);
  let finish!: () => void; service.writeGate = new Promise(resolve => { finish = resolve; });
  let restarts = 0; service.on('restart-ready', () => { restarts++; });
  const pending = post(socketPath, '/rpc', { headers: owner.headers, body: JSON.stringify({ method: 'terminal/open', params: {}, context: { clientId: owner.clientId } }) });
  await expect.poll(() => service.calls.length).toBe(1);
  service.emit('restart-required'); expect(restarts).toBe(0);
  finish(); expect(await (await pending).json()).toMatchObject({ ok: true, result: { method: 'terminal/open' } });
  await expect.poll(() => restarts).toBe(1);
});
test('worker events start with state, are receive-only, and clean terminal owners on loss of the event channel', async () => {
  const { socketPath, service } = await setup(); const { ws, eventChannelId } = await connect(socketPath);
  const closed = new Promise<number>(resolve => ws.once('close', code => resolve(code))); ws.send('{}'); expect(await closed).toBe(1008); await expect.poll(() => service.closedChannels).toContain(eventChannelId);
});

test('event-channel cleanup failure requests worker shutdown without an unhandled rejection', async () => {
  const { socketPath, service } = await setup(); const { ws } = await connect(socketPath);
  service.gatewayDisconnected = async () => { throw new Error('Native cleanup was not confirmed'); };
  const fatal = new Promise<void>(resolve => service.once('fatal', resolve));
  ws.terminate(); await fatal;
});

test('a request body arriving after its channel closes stays revoked across reconnect and another live channel', async () => {
  const { socketPath, service } = await setup(); const old = await connect(socketPath); const other = await connect(socketPath);
  const body = JSON.stringify({ method: 'terminal/open', params: {}, context: { clientId: old.clientId } });
  let request!: http.ClientRequest;
  const response = new Promise<unknown>((resolve, reject) => { request = http.request({ socketPath, path: '/rpc', method: 'POST', headers: { ...old.headers, 'content-length': Buffer.byteLength(body) } }, res => { let data = ''; res.on('data', chunk => { data += String(chunk); }); res.on('end', () => resolve(JSON.parse(data))); }); request.on('error', reject); });
  const admitted = new Promise<void>(resolve => handles.at(-1)!.server.once('request', () => resolve()));
  request.write(body.slice(0, 20)); await admitted;
  old.ws.terminate(); await expect.poll(() => service.closedChannels).toContain(old.eventChannelId);
  const replacement = await connect(socketPath); expect(replacement.eventChannelId).not.toBe(old.eventChannelId); expect(other.ws.readyState).toBe(WebSocket.OPEN);
  request.end(body.slice(20)); expect(await response).toMatchObject({ ok: false, error: { code: 'gateway_disconnected', delivery: 'not_sent' } }); expect(service.calls).toHaveLength(0);
  const stale = await post(socketPath, '/rpc', { headers: old.headers, body }); expect(await stale.json()).toMatchObject({ ok: false, error: { code: 'gateway_disconnected' } });
  const fresh = await post(socketPath, '/rpc', { headers: replacement.headers, body: JSON.stringify({ method: 'terminal/open', params: {}, context: { clientId: replacement.clientId } }) }); expect(await fresh.json()).toMatchObject({ ok: true }); expect(service.writes).toEqual(['terminal/open']);
});

test('a channel closing after HTTP dispatch also fences the final native write while other sockets remain', async () => {
  const { socketPath, service } = await setup(); const owner = await connect(socketPath); await connect(socketPath);
  let resume!: () => void; service.writeGate = new Promise(resolve => { resume = resolve; });
  const pending = post(socketPath, '/rpc', { headers: owner.headers, body: JSON.stringify({ method: 'terminal/open', params: {}, context: { clientId: owner.clientId } }) });
  await expect.poll(() => service.calls.length).toBe(1); owner.ws.terminate(); await expect.poll(() => service.closedChannels).toContain(owner.eventChannelId); resume();
  expect(await (await pending).json()).toMatchObject({ ok: false, error: { code: 'gateway_disconnected', delivery: 'not_sent' } }); expect(service.writes).toEqual([]);
});

test.each(['body', 'native'])('browser lease revocation fences a late terminal %s without closing its gateway channel', async phase => {
  const { socketPath, service } = await setup(); const owner = await connect(socketPath);
  const body = JSON.stringify({ method: 'terminal/open', params: {}, context: { clientId: owner.clientId } });
  let continueRequest!: () => void; let response: Promise<unknown>;
  if (phase === 'body') {
    let request!: http.ClientRequest;
    response = new Promise((resolve, reject) => { request = http.request({ socketPath, path: '/rpc', method: 'POST', headers: { ...owner.headers, 'content-length': Buffer.byteLength(body) } }, res => { let data = ''; res.on('data', chunk => { data += String(chunk); }); res.on('end', () => resolve(JSON.parse(data))); }); request.on('error', reject); });
    const admitted = new Promise<void>(resolve => handles.at(-1)!.server.once('request', () => resolve())); request.write(body.slice(0, 20)); await admitted;
    continueRequest = () => request.end(body.slice(20));
  } else {
    service.writeGate = new Promise(resolve => { continueRequest = resolve; });
    response = post(socketPath, '/rpc', { headers: owner.headers, body }).then(result => result.json());
    await expect.poll(() => service.calls.length).toBe(1);
  }
  const disconnected = await post(socketPath, '/disconnect', { headers: owner.headers, body: JSON.stringify({ clientId: owner.clientId }) }); expect(await disconnected.json()).toMatchObject({ ok: true });
  continueRequest(); expect(await response).toMatchObject({ ok: false, error: { code: 'client_disconnected', delivery: 'not_sent' } }); expect(service.writes).toEqual([]); expect(owner.ws.readyState).toBe(WebSocket.OPEN);
  const replacement = randomUUID(); await post(socketPath, '/connect', { headers: owner.headers, body: JSON.stringify({ clientId: replacement }) });
  const stale = await post(socketPath, '/rpc', { headers: owner.headers, body }); expect(await stale.json()).toMatchObject({ ok: false, error: { code: 'client_disconnected' } });
  const fresh = await post(socketPath, '/rpc', { headers: owner.headers, body: JSON.stringify({ method: 'terminal/open', params: {}, context: { clientId: replacement } }) }); expect(await fresh.json()).toMatchObject({ ok: true });
});

test('only registered owners can issue RPCs and disconnect reclaims bounded lease capacity', async () => {
  const { socketPath } = await setup(); const owner = await connect(socketPath);
  const unknown = await post(socketPath, '/rpc', { headers: owner.headers, body: JSON.stringify({ method: 'thread/read', params: {}, context: { clientId: randomUUID() } }) }); expect(await unknown.json()).toMatchObject({ ok: false, error: { code: 'client_disconnected' } });
  const register = (clientId: string) => post(socketPath, '/connect', { headers: owner.headers, body: JSON.stringify({ clientId }) }).then(result => result.json());
  for (let index = 0; index < 63; index++) expect(await register(randomUUID())).toMatchObject({ ok: true });
  const next = randomUUID(); expect(await register(next)).toMatchObject({ ok: false, error: { code: 'capacity', delivery: 'not_sent' } });
  await post(socketPath, '/disconnect', { headers: owner.headers, body: JSON.stringify({ clientId: owner.clientId }) }); expect(await register(next)).toMatchObject({ ok: true });
});

test('terminal output is routed only to its channel and transport identity is not relayed in events', async () => {
  const { socketPath, service } = await setup(); const owner = await connect(socketPath), other = await connect(socketPath);
  const next = (ws: WebSocket) => new Promise<unknown>(resolve => ws.once('message', data => resolve(JSON.parse(data.toString()))));
  const owned = next(owner.ws), unrelated = next(other.ws);
  service.emit('event', { type: 'terminal', data: { clientId: 'owner', type: 'output', deltaBase64: 'YQ==' }, eventChannelId: owner.eventChannelId });
  service.emit('event', { type: 'state', data: { epoch: 'epoch', connected: true } });
  expect(await owned).toEqual({ type: 'terminal', data: { clientId: 'owner', type: 'output', deltaBase64: 'YQ==' } });
  expect(await unrelated).toEqual({ type: 'state', data: { epoch: 'epoch', connected: true } });
});
test('child environment does not inherit administrator or management credentials', () => {
  const config = configFromEnvironment({ HARNESS_DEV: '1', HARNESS_CODEX_BIN: process.execPath, HARNESS_CODEX_HOME: process.cwd(), HARNESS_WORKER_HOME: process.cwd(), HARNESS_WORKER_SOCKET: path.join(process.cwd(), 'worker.sock'), HARNESS_ADMIN_TOKEN: 'not-a-secret-fixture', HARNESS_PROVIDER_API_KEY: 'fixture', AWS_BEARER_TOKEN_BEDROCK: 'fixture-bedrock', AWS_REGION: 'us-west-2', ARBITRARY_GATEWAY_ENV: 'must-not-inherit' });
  expect(config.runtime.env.HARNESS_PROVIDER_API_KEY).toBe('fixture'); expect(config.runtime.env.HARNESS_ADMIN_TOKEN).toBeUndefined(); expect(config.runtime.env.HARNESS_WORKER_SOCKET).toBeUndefined(); expect(config.runtime.env.ARBITRARY_GATEWAY_ENV).toBeUndefined();
  expect(config.runtime.env.AWS_BEARER_TOKEN_BEDROCK).toBe('fixture-bedrock'); expect(config.runtime.env.AWS_REGION).toBe('us-west-2');
});
test('native home is a separate normalized trusted path and never a child environment override', () => {
  const base = { HARNESS_DEV: '1', HARNESS_CODEX_BIN: process.execPath, HARNESS_CODEX_HOME: process.cwd(), HARNESS_WORKER_HOME: process.cwd(), HARNESS_WORKER_SOCKET: path.join(process.cwd(), 'worker.sock') };
  const nativeHome = path.resolve('.work/native-home'); const config = configFromEnvironment({ ...base, HARNESS_NATIVE_HOME: nativeHome });
  expect(config.runtime.nativeHome).toBe(nativeHome); expect(config.runtime.env.HOME).toBe(base.HARNESS_WORKER_HOME); expect(config.runtime.env.HARNESS_NATIVE_HOME).toBeUndefined();
  expect(() => configFromEnvironment({ ...base, HARNESS_NATIVE_HOME: 'relative' })).toThrow('absolute normalized');
  expect(() => configFromEnvironment({ ...base, HARNESS_DEV: '0' })).toThrow('HARNESS_NATIVE_HOME');
});
test('production native launch uses only fixed modes and does not enter a native-only project as supervisor', () => {
  const config = { bin: '/not-executed/codex', cwd: '/native-only-project', env: { HARNESS_PROVIDER_API_KEY: 'redactor-only', HARNESS_TOKEN_FILE: 'must-not-pass' }, args: ['untrusted-arguments'], launcher: { path: '/usr/lib/codex-harness/test/native-launch', user: 'ch-test-worker' } };
  for (const mode of ['version', 'app-server', 'resolve-project'] as const) expect(nativeCommand(config, mode)).toEqual({ bin: '/usr/bin/sudo', args: ['-n', '-u', 'ch-test-worker', '--', '/usr/lib/codex-harness/test/native-launch', mode], cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
});
