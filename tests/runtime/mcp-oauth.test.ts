import { afterEach, expect, test, vi } from 'vitest';
import { McpOauth } from '../../src/runtime/mcp-oauth.js';
import { DiagnosticRedactor } from '../../src/runtime/redaction.js';
import { DeliveryError, object, type JsonObject, type JsonValue } from '../../src/runtime/types.js';
import type { NativeOptions } from '../../src/runtime/native.js';

const owner = { clientId: 'owner', eventChannelId: 'channel', beforeWrite: () => {} };
const url = 'https://oauth.example/authorize?state=PRIVATE-STATE&code_challenge=PRIVATE-CHALLENGE';
const instances: McpOauth[] = [];
afterEach(() => { instances.splice(0).forEach(login => login.close()); vi.useRealTimers(); });
function fixture() {
  const redactor = new DiagnosticRedactor({}), events: { params: JsonObject; channel: string }[] = [], calls: string[] = [];
  const login = new McpOauth({ epoch: 'epoch', redactor, notify: (params, channel) => events.push({ params, channel }) }); instances.push(login);
  const native = async (method: string, _params: JsonValue, options?: NativeOptions): Promise<JsonValue> => { options?.beforeWrite?.(); calls.push(method); return { authorizationUrl: url, loginId: 'native-login' }; };
  const read = (identity: JsonObject, context = owner) => object(login.read({ handoffId: identity.handoffId!, epoch: identity.epoch! }, context));
  const complete = (params: JsonObject = {}) => login.notification('mcpServer/oauthLogin/completed', { name: 'server', threadId: null, loginId: 'native-login', success: true, ...params });
  return { login, redactor, events, native, read, complete, calls };
}
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
