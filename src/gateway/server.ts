import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { Authentication } from './auth.js';
import { Dispatcher } from './dispatch.js';
import { WorkerClient } from './worker-client.js';
import type { HarnessEvent, JsonValue } from '../core/contracts.js';
import { LIMITS } from '../core/contracts.js';
import { HarnessError, errorBody } from '../core/errors.js';
import { Budget } from '../core/budget.js';
import { object, rpcCall, safeJson } from '../core/validation.js';

const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
interface BrowserConnection { socket: WebSocket; clientId: string; workerClientId: string; cookie: string; alive: boolean }
function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]; return typeof value === 'string' ? value : undefined;
}
function security(res: ServerResponse): void {
  res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY'); res.setHeader('cache-control', 'no-store');
  // Voice still requires an explicit browser permission grant. Permit this
  // document to request it while keeping unrelated device access disabled.
  res.setHeader('permissions-policy', 'camera=(), microphone=(self), geolocation=()');
  res.setHeader('content-security-policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}
async function body(req: IncomingMessage, max = LIMITS.requestBytes, charge?: (bytes: number) => void): Promise<JsonValue> {
  if (header(req, 'content-type')?.split(';')[0]?.trim() !== 'application/json') throw new HarnessError('content_type', '请求必须使用 application/json。');
  const declared = header(req, 'content-length');
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > max)) throw new HarnessError('capacity', '请求内容过大。');
  let size = 0; const chunks: Buffer[] = [];
  const timer = setTimeout(() => req.destroy(), 15000);
  try {
    for await (const raw of req) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string); size += chunk.length;
      if (size > max) throw new HarnessError('capacity', '请求内容过大。'); charge?.(chunk.length); chunks.push(chunk);
    }
    return safeJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)), max);
  } finally { clearTimeout(timer); }
}

export class GatewayServer {
  readonly server: http.Server;
  readonly #wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  readonly #browsers = new Map<string, BrowserConnection>();
  readonly #connecting = new Set<string>();
  readonly #disconnecting = new Map<string, Promise<void>>();
  readonly #budget = new Budget(LIMITS.concurrentRequests, LIMITS.retainedRequestBytes);
  readonly #responses = new Budget(LIMITS.httpConnections, LIMITS.retainedResponseBytes);
  readonly #transportWaiters = new Map<Socket, { callbacks: Set<() => void>; close: () => void }>();
  readonly #responseRelease = new WeakMap<ServerResponse, () => void>();
  readonly #heartbeat: NodeJS.Timeout;
  readonly #revoke = () => {
    for (const connection of this.#browsers.values()) if (!this.auth.session(connection.cookie)) connection.socket.close(4001, 'session revoked');
  };
  #closing = false;
  constructor(readonly auth: Authentication, readonly dispatcher: Dispatcher, readonly worker: WorkerClient, readonly staticDir?: string) {
    auth.on('revoked', this.#revoke);
    this.server = http.createServer({ maxHeaderSize: 16384, requestTimeout: 20000, headersTimeout: 10000, keepAliveTimeout: 5000 }, (req, res) => { void this.handle(req, res); });
    this.server.maxRequestsPerSocket = 500;
    this.server.maxConnections = LIMITS.httpConnections;
    this.server.on('upgrade', (req, socket, head) => {
      void (async () => {
        let clientId: string | undefined, workerClientId: string | undefined, attached = false, ownsConnectingSlot = false;
        try {
          if (this.#closing || !req.url || req.url.length > 2048) throw new Error();
          this.auth.checkHost(header(req, 'host')); this.auth.checkOrigin(header(req, 'origin'));
          const url = new URL(req.url, this.auth.origin);
          if (url.pathname !== '/api/events' || this.#wss.clients.size + this.#connecting.size + this.#disconnecting.size >= LIMITS.sockets) throw new Error();
          const cookie = header(req, 'cookie') ?? ''; const session = this.auth.require(cookie);
          clientId = this.auth.client(session, url.searchParams.get('clientId'));
          if (this.#connecting.has(clientId)) throw new Error(); this.#connecting.add(clientId); ownsConnectingSlot = true;
          const old = this.#browsers.get(clientId);
          if (old) {
            this.#browsers.delete(clientId); old.socket.close(4000, 'replaced');
            await this.disconnect(clientId, old.workerClientId);
          }
          else await this.#disconnecting.get(clientId);
          if (this.#closing || socket.destroyed || !this.auth.session(cookie)) throw new Error();
          const owner = clientId;
          workerClientId = randomUUID();
          await this.worker.clientConnected(workerClientId);
          if (this.#closing || socket.destroyed || !this.auth.session(cookie) || !this.worker.connected) throw new Error();
          const lease = workerClientId;
          this.#wss.handleUpgrade(req, socket, head, ws => { this.attach(ws, owner, lease, cookie); attached = true; });
        } catch { if (!socket.destroyed) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); } }
        finally {
          if (!attached && workerClientId) await this.worker.clientDisconnected(workerClientId).catch(() => {});
          if (ownsConnectingSlot && clientId) this.#connecting.delete(clientId);
        }
      })();
    });
    dispatcher.on('event', (event: HarnessEvent) => {
      this.broadcast(event);
      if (event.type === 'state' && event.data && typeof event.data === 'object' && !Array.isArray(event.data) && event.data.connected === false)
        for (const connection of this.#browsers.values()) connection.socket.close(1012, 'Reconnect to renew worker lease');
    });
    this.#heartbeat = setInterval(() => {
      for (const connection of this.#browsers.values()) {
        if (!connection.alive || !this.auth.session(connection.cookie)) { connection.socket.terminate(); continue; }
        connection.alive = false; connection.socket.ping();
      }
    }, 15000);
    this.#heartbeat.unref();
  }
  private attach(socket: WebSocket, clientId: string, workerClientId: string, cookie: string): void {
    const connection: BrowserConnection = { socket, clientId, workerClientId, cookie, alive: true };
    this.#browsers.set(clientId, connection);
    socket.on('pong', () => { connection.alive = true; });
    socket.on('message', () => socket.close(1008, 'Use authenticated RPC'));
    socket.on('error', () => { /* close owns cleanup */ });
    socket.on('close', () => {
      if (this.#browsers.get(clientId) !== connection) return;
      this.#browsers.delete(clientId);
      void this.disconnect(clientId, workerClientId).catch(() => {});
    });
    this.send(connection, { type: 'state', data: this.dispatcher.status() });
  }
  private disconnect(clientId: string, workerClientId: string): Promise<void> {
    this.dispatcher.receiptMaintenance.forget(workerClientId);
    const previous = this.#disconnecting.get(clientId); if (previous) return previous;
    const pending = this.worker.clientDisconnected(workerClientId).finally(() => {
      if (this.#disconnecting.get(clientId) === pending) this.#disconnecting.delete(clientId);
    });
    this.#disconnecting.set(clientId, pending); return pending;
  }
  private send(connection: BrowserConnection, event: HarnessEvent): void {
    if (connection.socket.readyState !== WebSocket.OPEN) return;
    if (!this.auth.session(connection.cookie)) { connection.socket.close(4001, 'session expired'); return; }
    const payload = JSON.stringify(event);
    if (Buffer.byteLength(payload) > LIMITS.responseBytes || connection.socket.bufferedAmount + Buffer.byteLength(payload) > LIMITS.socketBufferedBytes) {
      connection.socket.close(1013, 'Resynchronization required'); return;
    }
    connection.socket.send(payload, error => { if (error) connection.socket.terminate(); });
  }
  private broadcast(event: HarnessEvent): void {
    let target: string | null = null;
    if (event.type === 'terminal' || event.type === 'mcp' || event.type === 'process' || event.type === 'realtime' || event.type === 'prediction') {
      if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return;
      if (typeof event.data.clientId !== 'string') return; target = event.data.clientId;
      const data = { ...event.data }; delete data.clientId;
      event = { type: event.type, data: { ...data, owned: true } };
    }
    for (const connection of this.#browsers.values()) if (target === null || target === connection.workerClientId) this.send(connection, event);
  }
  private onTransportClose(socket: Socket, callback: () => void): () => void {
    if (socket.destroyed) { callback(); return () => {}; }
    let entry = this.#transportWaiters.get(socket);
    if (!entry) {
      const callbacks = new Set<() => void>();
      const close = () => {
        this.#transportWaiters.delete(socket);
        for (const settle of [...callbacks]) settle();
        callbacks.clear();
      };
      entry = { callbacks, close }; this.#transportWaiters.set(socket, entry);
      socket.once('close', close);
    }
    const current = entry; current.callbacks.add(callback);
    return () => {
      current.callbacks.delete(callback);
      if (!current.callbacks.size && this.#transportWaiters.get(socket) === current) {
        socket.off('close', current.close); this.#transportWaiters.delete(socket);
      }
    };
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    security(res); let release: (() => void) | undefined;
    let authenticationMutationStarted = false, authenticationMutationCompleted = false;
    let backendSettled = false, responseSettled = false;
    let unwatch = () => {};
    const releaseWhenSettled = () => { if (backendSettled && responseSettled) release?.(); };
    const responseDone = () => {
      if (!responseSettled) {
        responseSettled = true; res.off('finish', responseDone); res.off('close', responseDone); unwatch();
        this.#responseRelease.get(res)?.();
      }
      releaseWhenSettled();
    };
    res.once('finish', responseDone); res.once('close', responseDone);
    // A pipelined response may never receive a socket, finish or close event.
    // Own its transport explicitly, while keeping pending backend work charged.
    unwatch = this.onTransportClose(req.socket, () => { res.destroy(); responseDone(); });
    try {
      const reservation = this.#budget.reserve(); release = reservation.release;
      this.auth.checkHost(header(req, 'host'));
      if (!req.url || req.url.length > 2048 || this.#closing) throw new HarnessError('unavailable', '服务暂不可用。');
      const url = new URL(req.url, this.auth.origin);
      if (url.pathname === '/health' && req.method === 'GET') {
        const state = this.dispatcher.status(); object(state); object(state.activity);
        const ready = state.connected === true && state.activity.unknown === false;
        this.json(res, { ok: ready }, ready ? 200 : 503); return;
      }
      if (url.pathname === '/api/account/proof' && req.method === 'GET') {
        if (header(req, 'origin') !== undefined) this.auth.checkOrigin(header(req, 'origin'));
        if (url.searchParams.size !== 1 || url.searchParams.getAll('nonce').length !== 1) throw new HarnessError('invalid_input', '认证探测需要单个随机挑战。');
        this.json(res, this.auth.proof(url.searchParams.get('nonce'))); return;
      }
      if (url.pathname === '/api/session') {
        if (req.method === 'GET') {
          const status = this.auth.status(header(req, 'cookie'));
          this.json(res, { ...status, ...(status.authenticated ? { operationGeneration: this.dispatcher.ledger.operationGeneration() } : {}) } as JsonValue); return;
        }
        this.auth.checkOrigin(header(req, 'origin'));
        if (req.method === 'POST') {
          const value = await body(req, 8192, reservation.add); object(value);
          authenticationMutationStarted = true;
          const login = await this.auth.login(value, req.socket.remoteAddress ?? 'unknown', header(req, 'user-agent'));
          authenticationMutationCompleted = true;
          res.setHeader('set-cookie', login.cookie); this.json(res, { ...this.auth.status(login.cookie), operationGeneration: this.dispatcher.ledger.operationGeneration() } as JsonValue); return;
        }
        if (req.method === 'DELETE') {
          const session = this.auth.require(header(req, 'cookie'), header(req, 'x-harness-csrf') ?? '');
          // Cookies for other services can change or reorder after WS upgrade.
          // Bind revocation to the authenticated session, not the header bytes.
          for (const connection of this.#browsers.values()) if (this.auth.session(connection.cookie)?.id === session.id) connection.socket.close(4001, 'logged out');
          authenticationMutationStarted = true;
          res.setHeader('set-cookie', this.auth.logout(header(req, 'cookie'))); authenticationMutationCompleted = true;
          this.json(res, { authenticated: false }); return;
        }
        throw new HarnessError('method_not_allowed', '不支持此请求方法。');
      }
      if (url.pathname === '/api/account/setup' && req.method === 'POST') {
        this.auth.checkOrigin(header(req, 'origin'));
        const value = await body(req, 8192, reservation.add); object(value);
        authenticationMutationStarted = true;
        const login = await this.auth.setup(value, req.socket.remoteAddress ?? 'unknown', header(req, 'user-agent'));
        authenticationMutationCompleted = true;
        res.setHeader('set-cookie', login.cookie);
        this.json(res, { ...this.auth.status(login.cookie), operationGeneration: this.dispatcher.ledger.operationGeneration() } as JsonValue); return;
      }
      if (url.pathname === '/api/account' || url.pathname.startsWith('/api/account/')) {
        const cookie = header(req, 'cookie');
        if (url.pathname === '/api/account' && req.method === 'GET') {
          this.json(res, this.auth.security(this.auth.require(cookie)) as JsonValue); return;
        }
        if (req.method !== 'POST') throw new HarnessError('method_not_allowed', '不支持此请求方法。');
        this.auth.checkOrigin(header(req, 'origin'));
        const session = this.auth.require(cookie, header(req, 'x-harness-csrf') ?? '');
        const value = await body(req, 8192, reservation.add); object(value);
        const peer = req.socket.remoteAddress ?? 'unknown';
        authenticationMutationStarted = true;
        if (url.pathname === '/api/account/password') {
          await this.auth.changePassword(session, value, peer); authenticationMutationCompleted = true; res.setHeader('set-cookie', this.auth.logout(cookie)); this.json(res, { authenticated: false }); return;
        }
        if (url.pathname === '/api/account/sessions/revoke') {
          const authenticated = this.auth.revoke(session, value); authenticationMutationCompleted = true; if (!authenticated) res.setHeader('set-cookie', this.auth.logout(cookie));
          this.json(res, { authenticated }); return;
        }
        if (url.pathname === '/api/account/totp/start') { const result = await this.auth.startTotp(session, value, peer); authenticationMutationCompleted = true; this.json(res, result as JsonValue); return; }
        if (url.pathname === '/api/account/totp/confirm') { const recoveryCodes = this.auth.confirmTotp(session, value, peer); authenticationMutationCompleted = true; this.json(res, { mfaEnabled: true, recoveryCodes }); return; }
        if (url.pathname === '/api/account/totp/disable') { await this.auth.disableTotp(session, value, peer); authenticationMutationCompleted = true; this.json(res, { mfaEnabled: false }); return; }
        if (url.pathname === '/api/account/totp/recovery') { const recoveryCodes = await this.auth.replaceRecovery(session, value, peer); authenticationMutationCompleted = true; this.json(res, { recoveryCodes }); return; }
        throw new HarnessError('not_found', '接口不存在。');
      }
      if (url.pathname === '/api/rpc' && req.method === 'POST') {
        this.auth.checkOrigin(header(req, 'origin'));
        const session = this.auth.require(header(req, 'cookie'), header(req, 'x-harness-csrf') ?? '');
        const clientId = this.auth.client(session, header(req, 'x-harness-client'));
        // Keep admission until both backend work and the HTTP response settle.
        const call = rpcCall(await body(req, LIMITS.requestBytes, reservation.add));
        this.auth.require(header(req, 'cookie'), header(req, 'x-harness-csrf') ?? '');
        const connection = this.#browsers.get(clientId);
        const requireConnection = () => {
          this.auth.require(header(req, 'cookie'), header(req, 'x-harness-csrf') ?? '');
          if (!connection || this.#browsers.get(clientId) !== connection || connection.socket.readyState !== WebSocket.OPEN || this.#connecting.has(clientId) || this.#disconnecting.has(clientId))
            throw new HarnessError('connection_required', '此操作需要已就绪的实时连接，请稍后重试。');
        };
        const result = await this.dispatcher.call(call, { clientId: connection?.workerClientId ?? clientId, requireConnection }); this.json(res, { ok: true, result }); return;
      }
      if (url.pathname.startsWith('/api/')) throw new HarnessError('not_found', '接口不存在。');
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HarnessError('method_not_allowed', '不支持此请求方法。');
      await this.serveStatic(url.pathname, req, res);
    } catch (error) {
      const failure = errorBody(error, authenticationMutationStarted ? 'unknown' : 'not_sent');
      if (authenticationMutationCompleted) failure.delivery = 'unknown';
      const status = ['unauthorized', 'mfa_required'].includes(failure.code) ? 401 : ['csrf', 'host', 'origin'].includes(failure.code) ? 403 : failure.code === 'not_found' ? 404 : failure.code === 'rate_limited' ? 429 : 400;
      try { if (!res.headersSent) this.json(res, { ok: false, error: { ...failure } }, status); else { res.destroy(); req.socket.destroy(); } }
      catch { res.destroy(); req.socket.destroy(); } // An exhausted output budget cannot allocate an unbounded error response.
      req.resume();
    } finally { backendSettled = true; if (res.destroyed || res.writableFinished || req.socket.destroyed) responseDone(); else releaseWhenSettled(); }
  }
  private retainResponse(res: ServerResponse, bytes: number, reserved?: () => void): () => void {
    const release = reserved ?? this.#responses.acquire(bytes);
    const transport = res.req.socket;
    const timer = setTimeout(() => { res.destroy(); transport.destroy(); done(); }, LIMITS.responseWriteTimeoutMs); timer.unref();
    let settled = false;
    const done = () => {
      if (settled) return; settled = true; clearTimeout(timer);
      res.off('finish', done); res.off('close', done); this.#responseRelease.delete(res); release();
    };
    this.#responseRelease.set(res, done);
    res.once('finish', done); res.once('close', done);
    if (res.destroyed || res.writableFinished || transport.destroyed) done();
    return done;
  }
  private json(res: ServerResponse, value: JsonValue, status = 200): void {
    if (res.destroyed || res.writableEnded) return;
    const encoded = JSON.stringify(value), bytes = Buffer.byteLength(encoded);
    if (bytes > LIMITS.responseBytes) throw new HarnessError('capacity', '结果超出容量，请缩小请求范围。');
    const release = this.retainResponse(res, bytes);
    try { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(encoded); }
    catch (error) { release(); throw error; }
  }
  private async serveStatic(pathname: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.staticDir) throw new HarnessError('not_found', '网页构建尚未安装。');
    const root = await realpath(this.staticDir); let decoded: string;
    try { decoded = decodeURIComponent(pathname); } catch { throw new HarnessError('not_found', '资源不存在。'); }
    if (decoded.includes('\0') || decoded.includes('\\')) throw new HarnessError('not_found', '资源不存在。');
    const candidate = path.resolve(root, '.' + decoded);
    if (candidate !== root && !candidate.startsWith(root + path.sep)) throw new HarnessError('not_found', '资源不存在。');
    let file = candidate;
    try { if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html'); }
    catch { if (!path.extname(decoded)) file = path.join(root, 'index.html'); else throw new HarnessError('not_found', '资源不存在。'); }
    try {
      file = await realpath(file);
      if (!file.startsWith(root + path.sep)) throw new Error();
      const info = await stat(file); if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error();
      // Reserve before reading a static asset; concurrent reads must also fit the output budget.
      let release = this.#responses.acquire(req.method === 'HEAD' ? 0 : info.size);
      try {
        const data = req.method === 'HEAD' ? undefined : await readFile(file);
        if (data && data.length !== info.size) throw new HarnessError('unavailable', '资源正在变化，请稍后重试。');
        if (res.destroyed) { release(); return; }
        release = this.retainResponse(res, 0, release);
        res.writeHead(200, { 'content-type': contentTypes[path.extname(file)] ?? 'application/octet-stream', 'content-length': info.size });
        res.end(data);
      } catch (error) { release(); throw error; }
    } catch (error) { if (error instanceof HarnessError) throw error; throw new HarnessError('not_found', '资源不存在。'); }
  }
  async listen(port: number): Promise<number> {
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(port, '127.0.0.1', () => { this.server.off('error', reject); resolve(); }); });
    const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('No HTTP port'); return address.port;
  }
  async close(): Promise<void> {
    this.#closing = true; clearInterval(this.#heartbeat);
    this.auth.off('revoked', this.#revoke);
    for (const connection of this.#browsers.values()) connection.socket.terminate();
    this.#wss.close();
    await new Promise<void>(resolve => { this.server.close(() => resolve()); this.server.closeIdleConnections(); });
  }
}
