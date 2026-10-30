import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { RuntimeService, type RuntimeConfig } from './service.js';
import { DeliveryError, jsonBytes, object, onlyKeys, string, type JsonValue, type RuntimeEvent } from './types.js';
import { CODEX_VERSION } from './metadata.js';
import { runNativeHelper, validateLauncher, type ExecutionPolicy } from './native-launch.js';

export interface WorkerServerConfig { socket?: string; devPort?: number; token?: string }
export async function startWorkerServer(service: RuntimeService, config: WorkerServerConfig): Promise<{ server: Server; close: () => Promise<void> }> {
  let calls = 0; let retained = 0; let closing = false;
  let restartPending = false;
  const restartWhenIdle = (): void => { if (restartPending && calls === 0 && !closing) { restartPending = false; service.emit('restart-ready'); } };
  const requestRestart = (): void => { restartPending = true; restartWhenIdle(); };
  service.on('restart-required', requestRestart);
  const sockets = new Set<WebSocket>(); const alive = new WeakMap<WebSocket, boolean>();
  const channels = new Map<string, WebSocket>(); const channelIds = new WeakMap<WebSocket, string>();
  const leases = new Map<string, Map<string, object>>();
  const clientIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const authorize = (req: IncomingMessage): boolean => {
    if (!config.token) return !!config.socket;
    const header = req.headers.authorization; const expected = Buffer.from(`Bearer ${config.token}`); const actual = Buffer.from(typeof header === 'string' ? header : '');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  };
  const reply = (res: ServerResponse, status: number, data: JsonValue): void => { if (!res.destroyed) { const text = jsonBytes(data); res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(text); } };
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000, keepAliveTimeout: 5000 }, (req, res) => {
    void (async () => {
      if (!authorize(req)) { reply(res, 401, { ok: false, error: { code: 'unauthorized', message: 'Worker authentication failed', delivery: 'not_sent' } }); req.resume(); return; }
      if (req.method === 'GET' && req.url === '/status') { reply(res, 200, { ok: true, result: service.status() }); return; }
      if (req.method !== 'POST' || !['/rpc', '/connect', '/disconnect'].includes(req.url ?? '')) { reply(res, 404, { ok: false, error: { code: 'not_found', message: 'Worker route not found', delivery: 'not_sent' } }); req.resume(); return; }
      if (closing || calls >= 48) { reply(res, 503, { ok: false, error: { code: 'capacity', message: 'Worker request capacity exhausted', delivery: 'not_sent' } }); req.resume(); return; }
      const header = req.headers['x-harness-event-channel'];
      const eventChannelId = typeof header === 'string' && clientIdPattern.test(header) ? header : undefined;
      const eventSocket = eventChannelId ? channels.get(eventChannelId) : undefined;
      const requireChannel = (): void => {
        if (closing || !eventChannelId || !eventSocket || eventSocket.readyState !== WebSocket.OPEN || channels.get(eventChannelId) !== eventSocket) throw new DeliveryError('gateway_disconnected', 'The request event channel is no longer connected');
      };
      // Bind at HTTP admission, not after the body arrives: reconnecting cannot
      // give an in-flight request authority from a different event connection.
      try { if (req.url !== '/disconnect') requireChannel(); else if (!eventChannelId) throw new DeliveryError('gateway_disconnected', 'An event channel identity is required'); }
      catch (error) { const fault = error as DeliveryError; reply(res, 200, { ok: false, error: { code: fault.code, message: fault.message, delivery: fault.delivery } }); req.resume(); return; }
      calls++; let bytes = 0; let callResolved = false; const chunks: Buffer[] = [];
      try {
        for await (const raw of req) {
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
          if (bytes + chunk.length > (req.url === '/rpc' ? 8 * 1024 * 1024 : 4096) || retained + chunk.length > 24 * 1024 * 1024) throw new DeliveryError('capacity', 'Worker body budget exhausted');
          bytes += chunk.length; retained += chunk.length; chunks.push(chunk);
        }
        let parsed: unknown; try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw new DeliveryError('invalid_json', 'Invalid JSON body'); }
        chunks.length = 0; const envelope = object(parsed);
        if (req.url === '/disconnect' || req.url === '/connect') {
          onlyKeys(envelope, ['clientId']); const clientId = string(envelope.clientId, 'clientId', 36);
          if (!clientIdPattern.test(clientId)) throw new DeliveryError('invalid_params', 'Client registration requires a fresh owner UUID');
          if (req.url === '/disconnect') {
            // Revoke before awaiting cleanup, including when no terminal exists yet.
            leases.get(eventChannelId!)?.delete(clientId);
            await service.clientDisconnected(clientId, eventChannelId); reply(res, 200, { ok: true, result: {} }); return;
          }
          requireChannel(); const active = leases.get(eventChannelId!)!;
          if (!active.has(clientId)) { if (active.size >= 64) throw new DeliveryError('capacity', 'Event channel client capacity exhausted'); active.set(clientId, {}); }
          reply(res, 200, { ok: true, result: {} }); return;
        }
        requireChannel();
        const method = string(envelope.method, 'method', 128); const context = object(envelope.context, 'context'); const clientId = string(context.clientId, 'clientId', 256);
        const operationId = context.operationId === undefined ? undefined : string(context.operationId, 'operationId', 64);
        const lease = leases.get(eventChannelId!)?.get(clientId);
        const requireOwner = (): void => { requireChannel(); if (!lease || leases.get(eventChannelId!)?.get(clientId) !== lease) throw new DeliveryError('client_disconnected', 'The browser owner is no longer connected'); };
        requireOwner();
        const gatewayRequestDigest = context.gatewayRequestDigest === undefined ? undefined : string(context.gatewayRequestDigest, 'gatewayRequestDigest', 64);
        const projectId = context.projectId === undefined ? undefined : string(context.projectId, 'projectId', 36);
        const result = await service.call(method, object(envelope.params ?? {}), { clientId, eventChannelId: eventChannelId!, beforeWrite: requireOwner, ...(operationId ? { operationId } : {}), ...(gatewayRequestDigest ? { gatewayRequestDigest } : {}), ...(projectId ? { projectId } : {}) });
        callResolved = true;
        reply(res, 200, { ok: true, result });
      } catch (error) {
        const fault = error instanceof DeliveryError ? error : new DeliveryError('internal_error', 'Worker request failed', 'unknown');
        // Serializing a completed call cannot establish that its work was unsent.
        const delivery = callResolved ? 'unknown' : fault.delivery;
        reply(res, 200, { ok: false, error: { code: fault.code, message: fault.message, delivery, ...(fault.data !== undefined ? { data: fault.data } : {}) } });
      } finally {
        // A fast CLI exit can race its open/close RPC. Flush the definitive
        // response before recycling the worker, so an accepted open stays known.
        if (restartPending && !res.writableFinished && !res.destroyed) await new Promise<void>(resolve => {
          const done = () => { res.off('finish', done); res.off('close', done); resolve(); };
          res.once('finish', done); res.once('close', done);
        });
        calls--; retained -= bytes; restartWhenIdle();
      }
    })().catch(() => res.destroy());
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    if (!authorize(req) || req.url !== '/events' || closing || sockets.size >= 4) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      const eventChannelId = randomUUID(); sockets.add(ws); channels.set(eventChannelId, ws); leases.set(eventChannelId, new Map()); channelIds.set(ws, eventChannelId); alive.set(ws, true);
      ws.on('pong', () => alive.set(ws, true)); ws.on('message', () => ws.close(1008, 'Receive-only event channel')); ws.on('error', () => ws.terminate());
      ws.on('close', () => { sockets.delete(ws); channels.delete(eventChannelId); leases.delete(eventChannelId); if (!closing) void service.gatewayDisconnected(eventChannelId).catch(() => service.emit('fatal')); });
      ws.send(JSON.stringify({ type: 'state', data: { ...object(service.status()), eventChannelId } }));
    });
  });
  const events = (event: RuntimeEvent): void => { const text = jsonBytes({ type: event.type, data: event.data }); const bytes = Buffer.byteLength(text); for (const ws of sockets) { if (ws.readyState !== WebSocket.OPEN || (event.eventChannelId && event.eventChannelId !== channelIds.get(ws))) continue; if (ws.bufferedAmount + bytes > 16 * 1024 * 1024) { ws.close(1013, 'Event backlog: resynchronize state and history'); setTimeout(() => ws.terminate(), 1000).unref(); } else ws.send(text, error => { if (error) ws.terminate(); }); } };
  service.on('event', events);
  const heartbeat = setInterval(() => { for (const ws of sockets) { if (!alive.get(ws)) ws.terminate(); else { alive.set(ws, false); ws.ping(); } } }, 15000); heartbeat.unref();
  if (config.socket) {
    if (process.platform === 'win32' || !path.isAbsolute(config.socket)) throw new Error('Production worker requires an absolute Unix socket path');
    try {
      const stat = lstatSync(config.socket); if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error('Refusing to replace worker socket');
      const active = await new Promise<boolean>(resolve => { const probe = createConnection(config.socket!); probe.once('connect', () => { probe.destroy(); resolve(true); }); probe.once('error', (error: NodeJS.ErrnoException) => resolve(error.code !== 'ECONNREFUSED')); probe.setTimeout(1000, () => { probe.destroy(); resolve(true); }); });
      if (active) throw new Error('Worker socket is active or unavailable'); unlinkSync(config.socket);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); if (config.socket) server.listen(config.socket, resolve); else server.listen(config.devPort ?? 4318, '127.0.0.1', resolve); });
  if (config.socket) chmodSync(config.socket, 0o660);
  return { server, close: async () => {
    if (closing) return; closing = true; channels.clear(); leases.clear(); clearInterval(heartbeat); service.off('event', events); service.off('restart-required', requestRestart); for (const ws of sockets) ws.terminate(); wss.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    if (config.socket) try { unlinkSync(config.socket); } catch {}
  } };
}

export function executionPolicyFromEnvironment(env: NodeJS.ProcessEnv, launcherUser: string): ExecutionPolicy | undefined {
  const revision = env.HARNESS_EXECUTION_REVISION, mode = env.HARNESS_EXECUTION_MODE, allowed = env.HARNESS_ROOT_ALLOWED;
  if (revision === undefined && mode === undefined && allowed === undefined && /^ch-[a-z0-9][a-z0-9-]*-worker$/.test(launcherUser)) return undefined;
  if (!revision || !/^[a-f0-9]{64}$/.test(revision) || !['native', 'root'].includes(mode ?? '') || !['0', '1'].includes(allowed ?? '') ||
      (mode === 'root' ? launcherUser !== 'root' || allowed !== '1' : !/^ch-[a-z0-9][a-z0-9-]*-worker$/.test(launcherUser))) throw new Error('Invalid managed execution policy');
  return { mode: mode as 'native' | 'root', rootAllowed: allowed === '1', revision };
}

export function configFromEnvironment(env: NodeJS.ProcessEnv): { runtime: RuntimeConfig; server: WorkerServerConfig } {
  const dev = env.HARNESS_DEV === '1'; const bin = string(env.HARNESS_CODEX_BIN, 'HARNESS_CODEX_BIN'); const home = string(env.HARNESS_CODEX_HOME, 'HARNESS_CODEX_HOME'); const workerHome = string(env.HARNESS_WORKER_HOME, 'HARNESS_WORKER_HOME');
  if (![bin, home, workerHome].every(value => path.isAbsolute(value))) throw new Error('Worker paths must be absolute');
  const nativeHome = !dev || env.HARNESS_NATIVE_HOME !== undefined ? string(env.HARNESS_NATIVE_HOME, 'HARNESS_NATIVE_HOME') : undefined;
  if (nativeHome !== undefined && (!path.isAbsolute(nativeHome) || path.normalize(nativeHome) !== nativeHome)) throw new Error('Native home must be an absolute normalized path');
  if (!dev && process.platform === 'win32') throw new Error('Windows requires explicit HARNESS_DEV=1');
  if (!dev && process.getuid?.() === 0) throw new Error('Production worker must run as an unprivileged supervisor identity');
  const childEnv: NodeJS.ProcessEnv = { HOME: workerHome, USERPROFILE: workerHome, CODEX_HOME: home };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TERM', 'HARNESS_PROVIDER_API_KEY', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION', 'Z_AI_API_KEY', 'Z_AI_MODE', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) if (env[key] !== undefined) childEnv[key] = env[key];
  for (const [key, value] of Object.entries(env)) if (/^HARNESS_PROVIDER_KEY_(?:DEFAULT|[0-9A-F]{32})$/.test(key) && value !== undefined) childEnv[key] = value;
  const runtime: RuntimeConfig = { bin, home, workerHome, ...(nativeHome === undefined ? {} : { nativeHome }), cwd: workerHome, env: childEnv, dev };
  if (env.HARNESS_PROVIDER_REGISTRY_FILE) {
    const registryPath = env.HARNESS_PROVIDER_REGISTRY_FILE;
    if (!path.isAbsolute(registryPath)) throw new Error('Provider registry path must be absolute');
    const info = lstatSync(registryPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024 || !dev && (info.uid !== 0 || (info.mode & 0o022) !== 0)) throw new Error('Invalid managed provider registry');
    runtime.providerRegistry = object(JSON.parse(readFileSync(registryPath, 'utf8')));
  }
  if (dev) { const token = string(env.HARNESS_WORKER_TOKEN, 'HARNESS_WORKER_TOKEN', 256); if (token.length < 32) throw new Error('Worker token must contain at least 32 characters'); const port = Number(env.HARNESS_WORKER_PORT ?? '4318'); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid worker port'); return { runtime, server: { devPort: port, token } }; }
  const launcher = { path: string(env.HARNESS_NATIVE_LAUNCHER, 'HARNESS_NATIVE_LAUNCHER'), user: string(env.HARNESS_NATIVE_USER, 'HARNESS_NATIVE_USER', 64) }; validateLauncher(launcher);
  const executionPolicy = executionPolicyFromEnvironment(env, launcher.user);
  const gid = Number(string(env.HARNESS_ATTACHMENT_GID, 'HARNESS_ATTACHMENT_GID', 16)); if (!Number.isSafeInteger(gid) || gid <= 0 || gid > 0xffffffff || !process.getgroups?.().includes(gid)) throw new Error('Invalid native attachment read group');
  runtime.launcher = launcher; runtime.attachmentGid = gid; if (executionPolicy) runtime.executionPolicy = executionPolicy;
  return { runtime, server: { socket: string(env.HARNESS_WORKER_SOCKET, 'HARNESS_WORKER_SOCKET') } };
}
export function prepareRuntimeHomes(config: RuntimeConfig): void {
  // Managed native homes belong to the selected execution identity, which can
  // be root. The unprivileged supervisor only creates its own private storage.
  if (!config.launcher) mkdirSync(config.home, { recursive: true, mode: 0o700 });
  mkdirSync(config.workerHome, { recursive: true, mode: 0o700 });
}
async function main(): Promise<void> {
  const config = configFromEnvironment(process.env); prepareRuntimeHomes(config.runtime);
  if ((await runNativeHelper(config.runtime, 'version')).trim() !== `codex-cli ${CODEX_VERSION}`) throw new Error('Codex runtime version does not match the pinned package');
  const service = await RuntimeService.create(config.runtime); let shuttingDown = false;
  let handle: Awaited<ReturnType<typeof startWorkerServer>>;
  try { handle = await startWorkerServer(service, config.server); } catch (error) { await service.close(); throw error; }
  const stop = (code: number): void => { if (shuttingDown) return; shuttingDown = true; const deadline = setTimeout(() => process.exit(code || 1), 7000); void (async () => { try { await handle.close(); await service.close(); clearTimeout(deadline); process.exit(code); } catch { process.exit(1); } })(); };
  service.on('fatal', () => stop(1));
  // Managed services use Restart=on-failure. Code 75 requests a clean new epoch
  // after a separately hosted CLI has finished and all RPC replies have drained.
  service.on('restart-ready', () => stop(75));
  process.on('SIGTERM', () => stop(0)); process.on('SIGINT', () => stop(0));
  if (!service.native.connected) stop(1);
}
// Release activation uses a `current` symlink. Node resolves the module URL to
// the release directory while argv retains the user's entrypoint spelling.
let invokedAsMain = false;
try { invokedAsMain = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { /* Import-only context has no existing entrypoint. */ }
if (invokedAsMain) void main().catch(() => { process.stderr.write('Worker startup failed. Verify its isolated runtime and configuration.\n'); process.exit(1); });
