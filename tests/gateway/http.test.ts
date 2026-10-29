import { describe, it, expect } from 'vitest';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import net from 'node:net';
import type { ServerResponse } from 'node:http';
import WebSocket from 'ws';
import { Authentication } from '../../src/gateway/auth.js';
import { totp } from '../../src/gateway/auth-crypto.js';
import { GatewayServer } from '../../src/gateway/server.js';
import { Dispatcher } from '../../src/gateway/dispatch.js';
import { Ledger } from '../../src/core/ledger.js';
import type { CallContext, JsonObject, JsonValue } from '../../src/core/contracts.js';
import { LIMITS } from '../../src/core/contracts.js';
import type { WorkerClient } from '../../src/gateway/worker-client.js';

async function fixture(now: () => number = Date.now, openBrowser = true, staticDir?: string) {
  const token = randomBytes(32).toString('hex'); const auth = new Authentication(token, 'http://127.0.0.1:0', now);
  const ledger = new Ledger(':memory:'); let forwarded = 0; let disconnected = 0; const owners: string[] = [];
  const backend = {
    connected: true,
    clientConnected: async (owner: string) => { owners.push(owner); },
    call: async (_method: string, _params: JsonObject, context: CallContext): Promise<JsonValue> => { forwarded++; context.beforeWrite?.(); return { data: [] }; },
    clientDisconnected: async () => { disconnected++; },
  };
  const dispatcher = new Dispatcher(ledger, backend, { call: async () => ({}) });
  dispatcher.event({ type: 'state', data: { connected: true, epoch: 'one', activity: { activeThreads: [], pendingStarts: 0, terminals: 0, unknown: false } } });
  const server = new GatewayServer(auth, dispatcher, backend as unknown as WorkerClient, staticDir);
  const port = await server.listen(0); auth.origin.port = String(port); const origin = auth.origin.origin;
  const post = (pathname: string, data: unknown, headers: Record<string, string> = {}) => fetch(origin + pathname, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) });
  const loginResponse = await post('/api/account/setup', { token, username: 'admin', password: 'isolated-test-password' });
  const login = await loginResponse.json() as { csrf: string };
  const cookie = loginResponse.headers.get('set-cookie')!.split(';')[0]!; const clientId = randomUUID();
  const headers = { cookie, 'x-harness-csrf': login.csrf, 'x-harness-recovery': '2', 'x-harness-client': clientId };
  if (openBrowser) { const ws = new WebSocket(origin.replace('http:', 'ws:') + '/api/events?clientId=' + clientId, { headers: { origin, cookie } }); await once(ws, 'open'); }
  return { token, auth, server, backend, ledger, dispatcher, origin, post, headers, cookie, clientId, owners, get forwarded() { return forwarded; }, get disconnected() { return disconnected; }, close: async () => { await server.close(); ledger.close(); auth.close(); } };
}
describe('real HTTP and WebSocket authorization boundary', () => {
  it('advertises recovery v2 and fences legacy writes before dispatcher side effects while retaining authenticated reads', async () => {
    const f = await fixture();
    try {
      expect(await (await fetch(f.origin + '/api/session', { headers: f.headers })).json()).toMatchObject({ authenticated: true, operationRecoveryProtocol: 2 });
      const legacyHeaders = { ...f.headers }; delete (legacyHeaders as Record<string, string>)['x-harness-recovery'];
      const methods = ['turn/start', 'terminal/open', 'terminal/write', 'turn/interrupt', 'system/restart',
        'system/provider/write', 'account/login', 'automation/create', 'operation/retire', 'operation/maintenance/rotate',
        'workspace/write', 'thread/realtime/start', 'unrecognized/future-write'];
      const before = f.forwarded;
      for (const method of methods) {
        const operationId = randomUUID();
        const response = await f.post('/api/rpc', { method, params: {}, operationId }, legacyHeaders);
        expect(await response.json()).toMatchObject({ ok: false, error: { code: 'client_update_required', delivery: 'not_sent' } });
        expect(f.ledger.read(operationId)).toBeNull();
      }
      expect(f.forwarded).toBe(before);
      expect(await (await f.post('/api/rpc', { method: 'operation/read', params: { operationId: randomUUID() } }, legacyHeaders)).json()).toMatchObject({ ok: true, result: { state: 'not_received' } });
      expect(await (await f.post('/api/rpc', { method: 'system/status', params: {} }, legacyHeaders)).json()).toMatchObject({ ok: true });
      expect((await fetch(f.origin + '/api/account', { headers: legacyHeaders })).status).toBe(200);
    } finally { await f.close(); }
  });
  it('protects account settings, keeps wrong-password failures local, and revokes live sockets on password change', async () => {
    const f = await fixture(Date.now, false); let socket: WebSocket | undefined;
    try {
      expect(await (await fetch(f.origin + '/api/session')).json()).toMatchObject({ authenticated: false, initialized: true, setupRequired: false, authenticationMode: 'account' });
      expect((await fetch(f.origin + '/api/account')).status).toBe(401);
      expect((await f.post('/api/session', { token: randomBytes(32).toString('hex') })).status).toBe(401);
      const security = await (await fetch(f.origin + '/api/account', { headers: f.headers })).json() as { revision: string; sessions: { current: boolean }[] };
      expect(security.sessions).toHaveLength(1); expect(security.sessions[0]!.current).toBe(true);
      const changedPassword = randomBytes(24).toString('base64url');
      const payload = { expectedRevision: security.revision, currentPassword: 'isolated-test-password', password: changedPassword };
      expect((await f.post('/api/account/password', payload, { cookie: f.cookie })).status).toBe(403);
      const wrong = await f.post('/api/account/password', { ...payload, currentPassword: 'wrong' }, f.headers);
      expect(wrong.status).toBe(400); expect(await wrong.json()).toMatchObject({ error: { code: 'credential_invalid' } });
      expect((await f.post('/api/account/password', { ...payload, expectedRevision: randomUUID() }, f.headers)).status).toBe(400);
      socket = new WebSocket(f.origin.replace('http:', 'ws:') + '/api/events?clientId=' + f.clientId, { headers: { origin: f.origin, cookie: f.cookie } });
      await once(socket, 'open'); const closed = once(socket, 'close');
      const response = await f.post('/api/account/password', payload, f.headers);
      expect(await response.json()).toEqual({ authenticated: false }); expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
      expect((await closed)[0]).toBe(4001);
      expect((await fetch(f.origin + '/api/account', { headers: f.headers })).status).toBe(401);
      const login = await f.post('/api/session', { username: 'admin', password: changedPassword });
      expect(login.status).toBe(200); expect(await login.json()).toMatchObject({ authenticated: true, username: 'admin' });
      await expect.poll(() => f.disconnected).toBe(1); expect(f.forwarded).toBe(0);
    } finally { socket?.terminate(); await f.close(); }
  });
  it('revokes only the selected device and clears its current cookie when requested', async () => {
    const f = await fixture(Date.now, false);
    try {
      const login = await f.post('/api/session', { username: 'admin', password: 'isolated-test-password' }), secondCookie = login.headers.get('set-cookie')!.split(';')[0]!;
      const security = await (await fetch(f.origin + '/api/account', { headers: f.headers })).json() as { revision: string; sessions: { id: string; current: boolean }[] };
      const other = security.sessions.find(row => !row.current)!;
      expect(await (await f.post('/api/account/sessions/revoke', { expectedRevision: security.revision, sessionId: other.id }, f.headers)).json()).toEqual({ authenticated: true });
      expect(await (await fetch(f.origin + '/api/session', { headers: { cookie: secondCookie } })).json()).toMatchObject({ authenticated: false });
      const current = security.sessions.find(row => row.current)!;
      const response = await f.post('/api/account/sessions/revoke', { expectedRevision: security.revision, sessionId: current.id }, f.headers);
      expect(await response.json()).toEqual({ authenticated: false }); expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    } finally { await f.close(); }
  });
  it('reports an uncertain authentication mutation honestly when failure follows a committed revocation', async () => {
    const f = await fixture(Date.now, false);
    try {
      const security = await (await fetch(f.origin + '/api/account', { headers: f.headers })).json() as { revision: string; sessions: { id: string }[] };
      const revoke = f.auth.revoke.bind(f.auth);
      f.auth.revoke = (session, input) => { revoke(session, input); throw new Error('Injected post-commit failure'); };
      const response = await f.post('/api/account/sessions/revoke', { expectedRevision: security.revision, sessionId: security.sessions[0]!.id }, f.headers);
      expect(await response.json()).toMatchObject({ error: { delivery: 'unknown' } });
      expect(await (await fetch(f.origin + '/api/session', { headers: f.headers })).json()).toMatchObject({ authenticated: false });
    } finally { await f.close(); }
  });
  it('provides a public nonce-bound server proof while rejecting malformed, duplicate, and cross-origin probes', async () => {
    const f = await fixture(Date.now, false);
    try {
      const nonce = randomBytes(32).toString('hex'), result = await fetch(f.origin + '/api/account/proof?nonce=' + nonce);
      const expected = createHmac('sha256', createHash('sha256').update(f.token).digest()).update('codex-harness-account-proof-v1\0' + f.origin + '\0' + nonce).digest('hex');
      expect(result.status).toBe(200); expect(await result.json()).toEqual({ nonce, proof: expected }); expect(result.headers.get('set-cookie')).toBeNull();
      expect((await fetch(f.origin + '/api/account/proof?nonce=bad')).status).toBe(400);
      expect((await fetch(f.origin + '/api/account/proof?nonce=' + nonce + '&nonce=' + nonce)).status).toBe(400);
      expect((await fetch(f.origin + '/api/account/proof?nonce=' + nonce, { headers: { origin: 'https://attacker.example' } })).status).toBe(403);
      const next = randomBytes(32).toString('hex'), nextResult = await (await fetch(f.origin + '/api/account/proof?nonce=' + next)).json() as { proof: string };
      expect(nextResult.proof).not.toBe(expected); expect(f.forwarded).toBe(0);
    } finally { await f.close(); }
  });
  it('exposes TOTP enrollment only through authenticated CSRF-protected requests and uses login second factors', async () => {
    let now = 1_800_000; const f = await fixture(() => now, false);
    try {
      const read = async () => await (await fetch(f.origin + '/api/account', { headers: f.headers })).json() as { revision: string; mfaEnabled: boolean; recoveryCodesRemaining: number };
      const before = await read(), start = { password: 'isolated-test-password', expectedRevision: before.revision };
      expect((await f.post('/api/account/totp/start', start, { cookie: f.cookie })).status).toBe(403);
      const pending = await (await f.post('/api/account/totp/start', start, f.headers)).json() as { enrollmentId: string; secret: string; uri: string };
      expect(pending.uri).toContain('otpauth://totp/');
      const confirm = await f.post('/api/account/totp/confirm', { enrollmentId: pending.enrollmentId, code: totp(pending.secret, now / 30_000), expectedRevision: before.revision }, f.headers);
      const enabled = await confirm.json() as { mfaEnabled: boolean; recoveryCodes: string[] }; expect(enabled.mfaEnabled).toBe(true); expect(enabled.recoveryCodes).toHaveLength(10);
      const credentials = { username: 'admin', password: 'isolated-test-password' };
      const missing = await f.post('/api/session', credentials); expect(missing.status).toBe(401); expect(await missing.json()).toMatchObject({ error: { code: 'mfa_required' } });
      now += 30_000;
      const login = await f.post('/api/session', { ...credentials, otp: totp(pending.secret, now / 30_000) }); expect(login.status).toBe(200);
      const current = await read(); expect(current.mfaEnabled).toBe(true);
      const recovery = await f.post('/api/account/totp/recovery', { expectedRevision: current.revision, password: credentials.password, otp: enabled.recoveryCodes[0] }, f.headers);
      const newCodes = await recovery.json() as { recoveryCodes: string[] }; expect(newCodes.recoveryCodes).toHaveLength(10);
      const latest = await read(); const disabled = await f.post('/api/account/totp/disable', { expectedRevision: latest.revision, password: credentials.password, otp: newCodes.recoveryCodes[0] }, f.headers);
      expect(await disabled.json()).toEqual({ mfaEnabled: false }); expect((await read()).recoveryCodesRemaining).toBe(0);
    } finally { await f.close(); }
  });
  it('revalidates authorization after receiving a slow request body across revocation', async () => {
    const f = await fixture(Date.now, false); let socket: net.Socket | undefined;
    try {
      const payload = JSON.stringify({ method: 'thread/read', params: { threadId: 'slow-auth-body' } });
      socket = net.createConnection({ host: '127.0.0.1', port: Number(new URL(f.origin).port) }); await once(socket, 'connect');
      const chunks: Buffer[] = []; socket.on('data', chunk => chunks.push(chunk));
      const request = ['POST /api/rpc HTTP/1.1', `Host: ${new URL(f.origin).host}`, `Origin: ${f.origin}`, ...Object.entries(f.headers).map(([name, value]) => `${name}: ${value}`), 'Content-Type: application/json', `Content-Length: ${Buffer.byteLength(payload)}`, 'Connection: close', '', ''].join('\r\n');
      const receiving = once(f.server.server, 'request'); socket.write(request + payload.slice(0, 10));
      // Once a request event is observed its handler has already checked the initial session and is waiting for bytes.
      await receiving;
      f.auth.logout(f.cookie); const ended = once(socket, 'close'); socket.write(payload.slice(10)); await ended;
      expect(Buffer.concat(chunks).toString()).toContain('401 Unauthorized'); expect(f.forwarded).toBe(0);
    } finally { socket?.destroy(); await f.close(); }
  });
  it('permits the application document to request microphone access while denying unrelated devices', async () => {
    const f = await fixture(Date.now, false, 'web');
    try {
      const response = await fetch(f.origin + '/');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(await response.text()).toContain('id="root"');
      expect(response.headers.get('permissions-policy')).toBe('camera=(), microphone=(self), geolocation=()');
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(f.forwarded).toBe(0);
    } finally { await f.close(); }
  });
  it('closes a response that cannot finish within the write deadline', async () => {
    const f = await fixture(); let response: ServerResponse | undefined, socket: net.Socket | undefined, received = 0;
    f.backend.call = async () => ({ data: 'x'.repeat(6 * 1024 * 1024) });
    f.server.server.on('request', (req, res) => { if (req.url === '/api/rpc') { response = res; received++; } });
    try {
      socket = net.createConnection({ host: '127.0.0.1', port: Number(new URL(f.origin).port) });
      socket.on('error', () => {}); socket.pause(); await once(socket, 'connect');
      const body = JSON.stringify({ method: 'thread/read', params: { threadId: 'deadline' } });
      const request = [`POST /api/rpc HTTP/1.1`, `Host: ${new URL(f.origin).host}`, `Origin: ${f.origin}`,
        ...Object.entries(f.headers).map(([name, value]) => `${name}: ${value}`), 'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`, '', ''].join('\r\n') + body;
      for (let i = 0; i < 3; i++) { socket.write(request); await expect.poll(() => received).toBe(i + 1); }
      await expect.poll(() => Boolean(response?.writableEnded)).toBe(true);
      expect(response?.writableFinished).toBe(false);
      await expect.poll(() => response?.destroyed, { timeout: LIMITS.responseWriteTimeoutMs + 2000 }).toBe(true);
    } finally { socket?.destroy(); await f.close(); }
  }, LIMITS.responseWriteTimeoutMs + 5000);
  it('bounds retained output across slow sockets and releases capacity after they close', async () => {
    const f = await fixture(); const sockets: net.Socket[] = [], responses: ServerResponse[] = [];
    let forwarded = 0;
    f.backend.call = async () => { forwarded++; return { data: 'x'.repeat(6 * 1024 * 1024) }; };
    f.server.server.on('request', (req, res) => { if (req.url === '/api/rpc') responses.push(res); });
    const body = JSON.stringify({ method: 'thread/read', params: { threadId: 'large' } });
    const request = [`POST /api/rpc HTTP/1.1`, `Host: ${new URL(f.origin).host}`, `Origin: ${f.origin}`,
      ...Object.entries(f.headers).map(([name, value]) => `${name}: ${value}`), 'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(body)}`, 'Connection: keep-alive', '', ''].join('\r\n') + body;
    try {
      for (let i = 0; i < 8; i++) {
        const socket = net.createConnection({ host: '127.0.0.1', port: Number(new URL(f.origin).port) });
        socket.on('error', () => {}); socket.pause(); sockets.push(socket); await once(socket, 'connect');
        for (let j = 0; j < 3; j++) { socket.write(request); await expect.poll(() => forwarded).toBe(i * 3 + j + 1); }
      }
      const unfinished = responses.filter(res => !res.writableFinished && !res.destroyed);
      expect(unfinished.length).toBeGreaterThan(0);
      expect(unfinished.reduce((bytes, res) => bytes + res.writableLength, 0)).toBeLessThanOrEqual(LIMITS.retainedResponseBytes + 8192);
      expect(responses.some(res => res.statusCode === 400)).toBe(true);
      // A paused client has unread TCP data. A normal destroy may leave a FIN
      // behind that data until the server's separate write deadline expires.
      // Explicitly reset these aborted connections and observe server cleanup;
      // the preceding test independently checks the graceful write deadline.
      for (const socket of sockets) if (!socket.destroyed) socket.resetAndDestroy();
      await expect.poll(() => responses.filter(res => !res.writableFinished && !res.destroyed).length).toBe(0);
      const response = await f.post('/api/rpc', { method: 'thread/read', params: { threadId: 'after-close' } }, f.headers);
      expect(response.status).toBe(200); expect((await response.text()).length).toBeGreaterThan(6 * 1024 * 1024);
    } finally { for (const socket of sockets) socket.destroy(); await f.close(); }
  }, 15000);
  it('settles unassigned pipelined responses on transport close while retaining the first pending backend', async () => {
    const f = await fixture(); const responses: ServerResponse[] = [], completions: (() => void)[] = [];
    let first!: () => void, calls = 0, socket: net.Socket | undefined;
    const held: Promise<Response>[] = [];
    f.backend.call = async () => {
      calls++;
      if (calls === 1) return new Promise<JsonValue>(resolve => { first = () => resolve({ data: [] }); });
      return { data: [] };
    };
    f.server.server.on('request', (req, res) => { if (req.url === '/api/rpc') responses.push(res); });
    const body = JSON.stringify({ method: 'thread/read', params: { threadId: 'pipeline' } });
    const request = ['POST /api/rpc HTTP/1.1', `Host: ${new URL(f.origin).host}`, `Origin: ${f.origin}`,
      ...Object.entries(f.headers).map(([name, value]) => `${name}: ${value}`), 'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(body)}`, '', ''].join('\r\n') + body;
    try {
      socket = net.createConnection({ host: '127.0.0.1', port: Number(new URL(f.origin).port) });
      socket.on('error', () => {}); socket.pause(); await once(socket, 'connect'); socket.write(request.repeat(3));
      await expect.poll(() => calls).toBe(3);
      await expect.poll(() => responses.slice(1).every(res => res.writableEnded)).toBe(true);
      expect(responses.slice(1).every(res => res.socket === null && !res.writableFinished)).toBe(true);
      socket.resetAndDestroy();
      await expect.poll(() => responses.every(res => res.destroyed)).toBe(true);
      f.backend.call = async () => new Promise<JsonValue>(resolve => { completions.push(() => resolve({ data: [] })); });
      for (let i = 0; i < LIMITS.concurrentRequests - 1; i++) held.push(f.post('/api/rpc', { method: 'thread/read', params: { threadId: 'held' } }, f.headers));
      await expect.poll(() => completions.length).toBe(LIMITS.concurrentRequests - 1);
      expect((await fetch(f.origin + '/health')).status).toBe(400);
      first();
      await expect.poll(async () => (await fetch(f.origin + '/health')).status).toBe(200);
      completions.forEach(done => done());
      expect((await Promise.all(held)).every(response => response.status === 200)).toBe(true);
    } finally { f.backend.call = async () => ({ data: [] }); first?.(); completions.forEach(done => done()); socket?.destroy(); await Promise.allSettled(held); await f.close(); }
  });
  it('keeps backend request admission charged after clients abandon their pending reads', async () => {
    const f = await fixture(), clients: net.Socket[] = [], complete: (() => void)[] = [];
    f.backend.call = async () => new Promise<JsonValue>(resolve => { complete.push(() => resolve({ data: [] })); });
    const body = JSON.stringify({ method: 'thread/read', params: { threadId: 'pending' } });
    const request = [`POST /api/rpc HTTP/1.1`, `Host: ${new URL(f.origin).host}`, `Origin: ${f.origin}`,
      ...Object.entries(f.headers).map(([name, value]) => `${name}: ${value}`), 'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(body)}`, '', ''].join('\r\n') + body;
    try {
      for (let i = 0; i < LIMITS.concurrentRequests; i++) {
        const socket = net.createConnection({ host: '127.0.0.1', port: Number(new URL(f.origin).port) });
        socket.on('error', () => {}); clients.push(socket); await once(socket, 'connect'); socket.write(request);
      }
      await expect.poll(() => complete.length).toBe(LIMITS.concurrentRequests);
      for (const client of clients) client.destroy();
      expect(await (await fetch(f.origin + '/health')).json()).toMatchObject({ ok: false, error: { code: 'capacity' } });
      complete.forEach(done => done());
      await expect.poll(async () => (await fetch(f.origin + '/health')).status).toBe(200);
    } finally { complete.forEach(done => done()); for (const client of clients) client.destroy(); await f.close(); }
  });
  it.each(['accepted', 'not_sent', 'unknown', 'pending', 'dispatching'] as const)('replays a durable %s identity without a browser lease, keeping conflicts and new dispatch fenced', async state => {
    const f = await fixture(Date.now, false), operationId = randomUUID();
    const request = { method: 'turn/start', params: { threadId: 't', text: 'original' }, operationId };
    f.ledger.reserve(operationId, request.method, request.params, 'thread:t');
    if (state !== 'pending') f.ledger.dispatch(operationId);
    if (state === 'accepted') f.ledger.settle(operationId, { ok: true, value: { turn: { id: 'accepted-turn' } } });
    if (state === 'not_sent' || state === 'unknown') f.ledger.settle(operationId, { ok: false, error: { code: 'original_failure', message: 'original failure', delivery: state } });
    try {
      const result = await (await f.post('/api/rpc', request, f.headers)).json();
      if (state === 'accepted') expect(result).toMatchObject({ ok: true, result: { turn: { id: 'accepted-turn' } } });
      else expect(result).toMatchObject({ ok: false, error: { code: state === 'not_sent' ? 'original_failure' : state === 'unknown' ? 'operation_unknown' : 'operation_pending', delivery: state === 'not_sent' ? 'not_sent' : 'unknown' } });
      expect(await (await f.post('/api/rpc', { ...request, params: { ...request.params, text: 'changed' } }, f.headers)).json()).toMatchObject({ ok: false, error: { code: 'operation_conflict' } });
      const fresh = randomUUID();
      expect(await (await f.post('/api/rpc', { ...request, operationId: fresh }, f.headers)).json()).toMatchObject({ ok: false, error: { code: 'connection_required', delivery: 'not_sent' } });
      expect(f.ledger.read(operationId)?.state).toBe(state);
      expect(f.ledger.read(fresh)?.state).toBe('not_sent');
      expect(f.forwarded).toBe(0);
    } finally { await f.close(); }
  });
  it('registers a fresh worker owner before admitting browser RPC and rotates it after upstream loss', async () => {
    const f = await fixture(Date.now, false); let first: WebSocket | undefined, second: WebSocket | undefined;
    const registered: string[] = [], forwarded: string[] = []; let release!: () => void;
    f.backend.clientConnected = async owner => { registered.push(owner); if (registered.length === 1) await new Promise<void>(resolve => { release = resolve; }); };
    f.backend.call = async (_m, _p, context) => { forwarded.push(context.clientId); return {}; };
    const connect = () => new WebSocket(f.origin.replace('http:', 'ws:') + '/api/events?clientId=' + f.clientId, { headers: { origin: f.origin, cookie: f.cookie } });
    try {
      first = connect(); let opened = false; first.on('open', () => { opened = true; }); const ready = once(first, 'open');
      await expect.poll(() => registered.length).toBe(1);
      expect(opened).toBe(false);
      for (let i = 0; i < 2; i++) {
        const duplicate = connect();
        const outcome = await new Promise<string>(resolve => { duplicate.once('error', () => resolve('rejected')); duplicate.once('open', () => { duplicate.terminate(); resolve('opened'); }); });
        expect(outcome).toBe('rejected');
      }
      expect(registered).toHaveLength(1);
      expect(await (await f.post('/api/rpc', { method: 'thread/read', params: { threadId: 't' } }, f.headers)).json()).toMatchObject({ ok: false, error: { code: 'connection_required', delivery: 'not_sent' } });
      release(); await ready;
      await f.post('/api/rpc', { method: 'thread/read', params: { threadId: 't' } }, f.headers);
      expect(forwarded).toEqual([registered[0]]);
      let terminal: Record<string, unknown> | undefined;
      first.on('message', bytes => { const event = JSON.parse(String(bytes)); if (event.type === 'terminal') terminal = event.data; });
      f.dispatcher.event({ type: 'terminal', data: { clientId: registered[0]!, terminalId: 'terminal', type: 'output', deltaBase64: 'YQ==' } });
      await expect.poll(() => terminal).toEqual({ owned: true, terminalId: 'terminal', type: 'output', deltaBase64: 'YQ==' });
      expect(terminal).not.toHaveProperty('clientId');
      const mcp: Record<string, unknown>[] = [];
      first.on('message', bytes => { const event = JSON.parse(String(bytes)); if (event.type === 'mcp') mcp.push(event.data); });
      f.dispatcher.event({ type: 'mcp', data: { clientId: 'another-owner', subscriptionId: 'foreign', type: 'event' } });
      f.dispatcher.event({ type: 'mcp', data: null });
      f.dispatcher.event({ type: 'mcp', data: { clientId: registered[0]!, subscriptionId: 'mine', type: 'event', notification: { method: 'changed', params: {} } } });
      await expect.poll(() => mcp.length).toBe(1); expect(mcp[0]).toEqual({ owned: true, subscriptionId: 'mine', type: 'event', notification: { method: 'changed', params: {} } });
      for (const type of ['process', 'realtime', 'prediction']) {
        const privateEvents: Record<string, unknown>[] = []; first.on('message', bytes => { const event = JSON.parse(String(bytes)); if (event.type === type) privateEvents.push(event.data); });
        f.dispatcher.event({ type, data: { clientId: 'foreign-owner', private: 'foreign' } }); f.dispatcher.event({ type, data: null });
        f.dispatcher.event({ type, data: { clientId: registered[0]!, private: 'mine' } }); await expect.poll(() => privateEvents).toEqual([{ owned: true, private: 'mine' }]);
      }
      const lost = once(first, 'close'); f.dispatcher.disconnected(); await lost;
      second = connect(); await once(second, 'open');
      expect(registered[1]).not.toBe(registered[0]);
      await f.post('/api/rpc', { method: 'thread/read', params: { threadId: 't' } }, f.headers);
      expect(forwarded).toEqual(registered);
    } finally { release?.(); first?.terminate(); second?.terminate(); await f.close(); }
  });
  it('keeps small parallel reads and receipt recovery available while charging actual retained bytes', async () => {
    const f = await fixture(); const releases: (() => void)[] = []; const pending: Promise<Response>[] = [];
    f.backend.call = async () => new Promise<JsonValue>(resolve => { releases.push(() => resolve({ data: [] })); });
    try {
      for (let i = 0; i < 6; i++) pending.push(f.post('/api/rpc', { method: 'thread/read', params: { threadId: String(i) } }, f.headers));
      await expect.poll(() => releases.length, { timeout: 1000 }).toBe(6);
      const response = await f.post('/api/rpc', { method: 'operation/read', params: { operationId: randomUUID() } }, f.headers);
      expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ ok: true, result: { state: 'not_received' } });
    } finally { releases.forEach(release => release()); await Promise.all(pending); await f.close(); }
  });
  it('waits for previous disconnect cleanup before accepting a reconnect with the same owner', async () => {
    const f = await fixture(Date.now, false); let first: WebSocket | undefined; let next: WebSocket | undefined;
    let release!: () => void; let cleanupStarted = false; let opened = false;
    f.backend.clientDisconnected = async () => { cleanupStarted = true; await new Promise<void>(resolve => { release = resolve; }); };
    const connect = () => new WebSocket(f.origin.replace('http:', 'ws:') + '/api/events?clientId=' + f.clientId, { headers: { origin: f.origin, cookie: f.cookie } });
    try {
      first = connect(); await once(first, 'open'); first.terminate();
      await expect.poll(() => cleanupStarted).toBe(true);
      next = connect(); next.on('open', () => { opened = true; });
      const ready = once(next, 'open');
      const response = await f.post('/api/rpc', { method: 'terminal/write', params: { terminalId: 't', data: 'x' } }, f.headers);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'connection_required' } });
      expect(opened).toBe(false); release(); await ready;
      expect(await (await f.post('/api/rpc', { method: 'terminal/write', params: { terminalId: 't', data: 'x' } }, f.headers)).json()).toMatchObject({ ok: true });
    } finally { f.backend.clientDisconnected = async () => {}; release?.(); first?.terminate(); next?.terminate(); await f.close(); }
  });
  it('rejects missing login, cross-origin and missing CSRF before forwarding', async () => {
    const f = await fixture();
    try {
      expect((await f.post('/api/rpc', { method: 'thread/read', params: { threadId: 't' } })).status).toBe(401);
      expect((await f.post('/api/rpc', { method: 'thread/read', params: { threadId: 't' } }, { ...f.headers, origin: 'https://evil.example' })).status).toBe(403);
      expect((await f.post('/api/rpc', { method: 'thread/read', params: { threadId: 't' } }, { ...f.headers, 'x-harness-csrf': '' })).status).toBe(403);
      expect(f.forwarded).toBe(0);
      expect((await f.post('/api/rpc', { method: 'thread/read', params: { threadId: 't' } }, f.headers)).status).toBe(200);
      expect(f.forwarded).toBe(1);
    } finally { await f.close(); }
  });
  it('does not turn an unexpected error after dispatch into a safe retry', async () => {
    const f = await fixture(); const operationId = randomUUID();
    f.backend.call = async (_m, _p, context) => { context.beforeWrite?.(); throw new Error('private worker diagnostics must not escape'); };
    try {
      const response = await f.post('/api/rpc', { method: 'turn/start', params: { threadId: 't', text: 'x' }, operationId }, f.headers);
      expect(await response.json()).toMatchObject({ ok: false, error: { delivery: 'unknown', code: 'internal' } });
      expect(f.ledger.read(operationId)?.state).toBe('unknown');
    } finally { await f.close(); }
  });
  it('requires a live owned event connection for terminal use and cleans on close', async () => {
    const f = await fixture(Date.now, false); let ws: WebSocket | undefined;
    try {
      const request = { method: 'terminal/write', params: { terminalId: 't', data: 'x' } };
      expect(await (await f.post('/api/rpc', request, f.headers)).json()).toMatchObject({ ok: false, error: { code: 'connection_required' } });
      ws = new WebSocket(f.origin.replace('http:', 'ws:') + '/api/events?clientId=' + f.clientId, { headers: { origin: f.origin, cookie: f.cookie } });
      const snapshot = once(ws, 'message'); await once(ws, 'open');
      expect(JSON.parse(String((await snapshot)[0]))).toMatchObject({ type: 'state', data: { epoch: 'one', connected: true } });
      expect(await (await f.post('/api/rpc', request, f.headers)).json()).toMatchObject({ ok: true });
      const closed = once(ws, 'close'); ws.close(); await closed;
      await expect.poll(() => f.disconnected, { timeout: 1000 }).toBe(1);
    } finally { ws?.terminate(); await f.close(); }
  });
  it('closes existing browser connections after logout and rejects cookie replay', async () => {
    const f = await fixture(Date.now, false); let ws: WebSocket | undefined;
    try {
      ws = new WebSocket(f.origin.replace('http:', 'ws:') + '/api/events?clientId=' + f.clientId, { headers: { origin: f.origin, cookie: f.cookie } });
      await once(ws, 'open'); const closed = once(ws, 'close');
      const response = await fetch(f.origin + '/api/session', { method: 'DELETE', headers: { ...f.headers, cookie: 'other_service=changed; ' + f.cookie, origin: f.origin } });
      expect(response.status).toBe(200); await closed;
      expect((await f.post('/api/rpc', { method: 'runtime/status', params: {} }, f.headers)).status).toBe(401);
    } finally { ws?.terminate(); await f.close(); }
  });
  it('never delivers a new event to an expired session between heartbeat checks', async () => {
    let clock = Date.now(); const f = await fixture(() => clock, false); let ws: WebSocket | undefined;
    try {
      ws = new WebSocket(f.origin.replace('http:', 'ws:') + '/api/events?clientId=' + f.clientId, { headers: { origin: f.origin, cookie: f.cookie } });
      const first = once(ws, 'message'); await once(ws, 'open'); await first;
      const events: unknown[] = []; ws.on('message', value => events.push(value)); const closed = once(ws, 'close');
      clock += 12 * 60 * 60_000;
      f.dispatcher.event({ type: 'notification', data: { message: 'private' } });
      await closed; expect(events).toEqual([]);
    } finally { ws?.terminate(); await f.close(); }
  });
});
