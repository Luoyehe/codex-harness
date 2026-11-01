import { afterEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { McpOauth } from '../../src/runtime/mcp-oauth.js';
import { DiagnosticRedactor } from '../../src/runtime/redaction.js';
import { RuntimeService } from '../../src/runtime/service.js';
import { DeliveryError, object, type JsonObject, type JsonValue } from '../../src/runtime/types.js';
import type { NativeOptions, NativeRpc } from '../../src/runtime/native.js';

const owner = { clientId: 'owner', eventChannelId: 'channel', beforeWrite: () => {} };
const url = 'https://oauth.example/authorize?state=PRIVATE-STATE&code_challenge=PRIVATE-CHALLENGE';
const instances: McpOauth[] = [];
const runtimes: RuntimeService[] = [];
afterEach(async () => { instances.splice(0).forEach(login => login.close()); await Promise.all(runtimes.splice(0).map(runtime => runtime.close())); vi.useRealTimers(); });
const statusPage = (name: JsonValue = 'server', authStatus: JsonValue = 'notLoggedIn'): JsonObject => ({ data: [{ name, authStatus,
  runtimeStatus: null, pluginId: null, httpOrigin: 'https://mcp.example', serverInfo: null, serverCapabilities: null,
  toolListMeta: null, tools: {}, toolsError: null, resources: [], resourceTemplates: [] }], nextCursor: null });
function fixture() {
  const redactor = new DiagnosticRedactor({}), events: { params: JsonObject; channel: string }[] = [], calls: string[] = [];
  const serverStatus = vi.fn(async (params: JsonObject): Promise<JsonValue> => statusPage(params.serverName));
  const login = new McpOauth({ epoch: 'epoch', redactor, serverStatus, notify: (params, channel) => events.push({ params, channel }) }); instances.push(login);
  const native = async (method: string, _params: JsonValue, options?: NativeOptions): Promise<JsonValue> => { options?.beforeWrite?.(); calls.push(method); return { authorizationUrl: url, loginId: 'native-login' }; };
  const read = (identity: JsonObject, context = owner) => object(login.read({ handoffId: identity.handoffId!, epoch: identity.epoch! }, context));
  const complete = (params: JsonObject = {}) => login.notification('mcpServer/oauthLogin/completed', { name: 'server', threadId: null, loginId: 'native-login', success: true, ...params });
  return { login, redactor, events, native, read, complete, calls, serverStatus };
}
test.each(['bearerToken', 'unsupported', 'unknown', 'apiKey'])('fresh %s status blocks OAuth before dispatch without retaining an uncertain login', async status => {
  const f = fixture(); f.serverStatus.mockResolvedValue(statusPage('server', status));
  for (let attempt = 0; attempt < 2; attempt++) await expect(f.login.start({ name: 'server' }, f.native, owner)).rejects.toMatchObject({ delivery: 'not_sent' });
  expect(f.calls).toEqual([]); expect(f.serverStatus).toHaveBeenCalledTimes(2);
  f.serverStatus.mockResolvedValue(statusPage('server', 'notLoggedIn'));
  await f.login.start({ name: 'server' }, f.native, owner); expect(f.calls).toEqual(['mcpServer/oauth/login']);
});
test.each(['notLoggedIn', 'oAuth'])('fresh %s permits OAuth and binds discovery to the exact thread and server', async status => {
  const f = fixture(); f.serverStatus.mockResolvedValue(statusPage('server', status));
  await f.login.start({ name: 'server', threadId: 'thread' }, f.native, owner);
  expect(f.serverStatus).toHaveBeenCalledWith({ serverName: 'server', threadId: 'thread', detail: 'toolsAndAuthOnly', limit: 100 });
  expect(f.calls).toEqual(['mcpServer/oauth/login']);
});
test('failed, missing or ambiguous status never becomes a login unknown or sends authorization', async () => {
  const f = fixture();
  f.serverStatus.mockRejectedValueOnce(new DeliveryError('timeout', 'private server detail', 'unknown'));
  await expect(f.login.start({ name: 'server' }, f.native, owner)).rejects.toMatchObject({ code: 'mcp_auth_unavailable', delivery: 'not_sent' });
  for (const page of [{ data: [], nextCursor: null }, statusPage('different'), { ...statusPage(), nextCursor: 'another-page' },
    { ...statusPage(), data: [...statusPage().data as JsonValue[], ...statusPage().data as JsonValue[]] }]) {
    f.serverStatus.mockResolvedValue(page);
    await expect(f.login.start({ name: 'server' }, f.native, owner)).rejects.toMatchObject({ code: 'mcp_auth_unavailable', delivery: 'not_sent' });
  }
  expect(f.calls).toEqual([]);
});
test('the discovery reservation excludes concurrent login and disconnect prevents delayed discovery dispatch', async () => {
  const f = fixture(); let release!: (value: JsonValue) => void;
  f.serverStatus.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  const pending = f.login.start({ name: 'server' }, f.native, owner);
  const failed = expect(pending).rejects.toMatchObject({ delivery: 'not_sent' });
  await expect(f.login.start({ name: 'server' }, f.native, owner)).rejects.toMatchObject({ code: 'login_pending', delivery: 'not_sent' });
  f.login.disconnect(owner.clientId, owner.eventChannelId); release(statusPage()); await failed;
  expect(f.calls).toEqual([]);
  await f.login.start({ name: 'server' }, f.native, owner); expect(f.calls).toHaveLength(1);
});
test('RuntimeService rejects non-OAuth before its mutation gate and still retains genuine dispatched unknown activity', async () => {
  const parent = path.resolve('.work/mcp-oauth-runtime'); mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(path.join(parent, 'home-')); let authStatus = 'bearerToken'; const calls: string[] = [];
  const native = Object.assign(new EventEmitter(), { connected: true, budget: { pending: 0, retainedBytes: 0 },
    call: async (method: string, params: JsonValue, options: NativeOptions = {}): Promise<JsonValue> => {
      options.beforeWrite?.(); calls.push(method);
      if (method === 'mcpServerStatus/list') return statusPage(object(params).serverName, authStatus);
      if (method === 'mcpServer/oauth/login') throw new DeliveryError('timeout', 'Fixture dispatched OAuth unknown', 'unknown');
      return {};
    }, close: async () => { native.connected = false; } });
  const runtime = new RuntimeService({ bin: process.execPath, home, workerHome: home, cwd: home, env: {} }, native as unknown as NativeRpc); runtimes.push(runtime);
  for (const value of ['bearerToken', 'unsupported', 'unknown', 'apiKey']) {
    authStatus = value;
    await expect(runtime.call('mcp/oauth', { name: 'server' }, owner)).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(object(runtime.status()).activity).toMatchObject({ unknown: false, pendingStarts: 0 });
  }
  expect(calls).toEqual(Array(4).fill('mcpServerStatus/list'));
  authStatus = 'notLoggedIn';
  await expect(runtime.call('mcp/oauth', { name: 'server' }, owner)).rejects.toMatchObject({ delivery: 'unknown' });
  expect(object(runtime.status()).activity).toMatchObject({ unknown: true, pendingStarts: 0 });
  expect(calls.filter(method => method === 'mcpServer/oauth/login')).toHaveLength(1);
});
test('identity-only receipts and owner/channel/epoch-bound handoffs with correlated private completion', async () => {
  const f = fixture(), identity = object(await f.login.start({ name: 'server' }, f.native, owner));
  expect(identity).toEqual({ handoffId: expect.any(String), epoch: 'epoch', name: 'server', threadId: null });
  expect(f.read(identity)).toMatchObject({ authorizationUrl: url, status: 'pending' });
  for (const context of [{ ...owner, clientId: 'other' }, { ...owner, eventChannelId: 'other' }]) expect(() => f.read(identity, context)).toThrow(expect.objectContaining({ code: 'not_found' }));
  expect(() => f.read({ ...identity, epoch: 'other' })).toThrow();
  expect(f.redactor.text(url)).toBe('[redacted]');
  f.complete({ loginId: 'old' }); f.complete({ threadId: 'other' }); f.complete({ name: 'other' }); f.complete({ loginId: null });
  expect(f.read(identity).authorizationUrl).toBe(url);
  f.complete({ error: url });
  expect(f.read(identity)).toMatchObject({ status: 'completed', unavailable: true });
  expect(f.read(identity)).not.toHaveProperty('authorizationUrl');
  expect(f.events).toEqual([{ params: { ...identity, clientId: 'owner', success: true, restartRequired: false }, channel: 'channel' }]);
  await f.login.start({ name: 'server' }, f.native, owner); expect(f.calls).toHaveLength(2);
});
test.each(['complete', 'disconnect', 'gateway', 'close'] as const)('%s before a delayed response never revives its URL', async action => {
  const f = fixture(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const task = f.login.start({ name: 'server' }, async (method, params, options) => { const response = await f.native(method, params, options); await gate; return response; }, owner);
  await vi.waitFor(() => expect(f.calls).toHaveLength(1));
  if (action === 'complete') f.complete();
  if (action === 'disconnect') f.login.disconnect(owner.clientId, owner.eventChannelId);
  if (action === 'gateway') f.login.disconnect(undefined, owner.eventChannelId);
  if (action === 'close') f.login.close();
  release(); const identity = object(await task);
  if (action === 'close') expect(() => f.read(identity)).toThrow();
  else expect(f.read(identity)).not.toHaveProperty('authorizationUrl');
  expect(f.calls).toEqual(['mcpServer/oauth/login']);
  if (action !== 'complete' && action !== 'close') await expect(f.login.start({ name: 'server' }, f.native, owner)).rejects.toMatchObject({ code: 'login_pending', delivery: 'not_sent' });
});
test('disconnection before dispatch prevents any native login and does not consume the target forever', async () => {
  const f = fixture(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const task = f.login.start({ name: 'server' }, async (method, params, options) => { await gate; return f.native(method, params, options); }, owner);
  const failed = expect(task).rejects.toMatchObject({ delivery: 'not_sent' });
  f.login.disconnect(owner.clientId, owner.eventChannelId); release(); await failed;
  expect(f.calls).toHaveLength(0); await f.login.start({ name: 'server' }, f.native, owner);
});
test('expiration removes URLs but keeps uncertain reservations and never sends an invented cancellation RPC', async () => {
  vi.useFakeTimers(); const f = fixture(), identity = object(await f.login.start({ name: 'server', timeoutSecs: 1 }, f.native, owner));
  await vi.advanceTimersByTimeAsync(1001);
  expect(f.read(identity)).toMatchObject({ unavailable: true, restartRequired: true, status: 'pending' });
  expect(f.read(identity)).not.toHaveProperty('authorizationUrl');
  await expect(f.login.start({ name: 'server' }, f.native, owner)).rejects.toMatchObject({ code: 'login_pending' });
  f.complete(); expect(f.read(identity).status).toBe('completed');
  expect(f.calls).toEqual(['mcpServer/oauth/login']);
});
test.each([undefined, null])('legacy loginId %s supports a usable handoff but cannot replace an ambiguously correlated attempt', async loginId => {
  const f = fixture(), identity = object(await f.login.start({ name: 'server' }, async (_m, _p, options) => { options?.beforeWrite?.(); return { authorizationUrl: url, ...(loginId === null ? { loginId: null } : {}) }; }, owner));
  expect(f.read(identity).authorizationUrl).toBe(url); f.complete({ loginId: null });
  expect(f.read(identity)).toMatchObject({ status: 'completed', restartRequired: true });
  await expect(f.login.start({ name: 'server' }, f.native, owner)).rejects.toMatchObject({ code: 'login_pending' });
});
test.each(['unsafe', 'oversize', 'unknown', 'false-not-sent', 'invalid'])('a dispatched %s response cannot be retried and does not echo upstream URL details', async kind => {
  const f = fixture();
  await expect(f.login.start({ name: 'server' }, async (_m, _p, options) => {
    options?.beforeWrite?.();
    if (kind === 'unknown' || kind === 'false-not-sent') throw new DeliveryError('upstream', url, kind === 'unknown' ? 'unknown' : 'not_sent');
    if (kind === 'invalid') return { authorizationUrl: 5 };
    return { authorizationUrl: kind === 'unsafe' ? 'javascript:alert(1)' : 'https://example.test/' + 'x'.repeat(8192) };
  }, owner)).rejects.toMatchObject({ delivery: 'unknown', message: expect.not.stringContaining(url) });
  await expect(f.login.start({ name: 'server' }, f.native, owner)).rejects.toMatchObject({ code: 'login_pending' });
});
test('bounded capacity counts unresolved reservations after expiry; thread targets remain distinct', async () => {
  const f = fixture();
  for (let i = 0; i < 32; i++) await f.login.start({ name: 'server', threadId: 'thread-' + i }, f.native, owner);
  f.login.disconnect();
  await expect(f.login.start({ name: 'other' }, f.native, owner)).rejects.toMatchObject({ code: 'capacity' });
  expect(f.calls).toHaveLength(32);
});
test('confirmed completion frees capacity for a different target without evicting unresolved attempts', async () => {
  const f = fixture();
  for (let i = 0; i < 32; i++) await f.login.start({ name: 'server', threadId: 'thread-' + i }, f.native, owner);
  f.complete({ threadId: 'thread-7' });
  await f.login.start({ name: 'other' }, f.native, owner);
  await expect(f.login.start({ name: 'third' }, f.native, owner)).rejects.toMatchObject({ code: 'capacity' });
  expect(f.calls).toHaveLength(33);
});
test('HTTP self-hosted authorization stays supported while embedded credentials are rejected', async () => {
  const f = fixture();
  const identity = object(await f.login.start({ name: 'server' }, async (_m, _p, options) => { options?.beforeWrite?.(); return { authorizationUrl: 'http://127.0.0.1:8888/authorize', loginId: 'id' }; }, owner));
  expect(f.read(identity).authorizationUrl).toBe('http://127.0.0.1:8888/authorize');
  const credentialUrl = new URL('https://example.test/');
  credentialUrl.username = 'fixture-user'; credentialUrl.password = 'fixture-password';
  await expect(f.login.start({ name: 'other' }, async (_m, _p, options) => { options?.beforeWrite?.(); return { authorizationUrl: credentialUrl.href }; }, owner)).rejects.toMatchObject({ delivery: 'unknown' });
});
