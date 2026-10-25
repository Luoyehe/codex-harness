import { afterEach, expect, test, vi } from 'vitest';
import { DeviceLogin } from '../../src/runtime/device-login.js';
import { DiagnosticRedactor } from '../../src/runtime/redaction.js';
import { DeliveryError, type JsonValue } from '../../src/runtime/types.js';
import type { NativeOptions } from '../../src/runtime/native.js';
const owner = { clientId: 'owner', eventChannelId: 'channel', beforeWrite: () => {} };
const response = { type: 'chatgptDeviceCode', loginId: 'login', userCode: 'short-private-code', verificationUrl: 'https://auth.example/device' };
const completion = { loginId: 'login', success: true, error: null, onboardingEntrypoint: null };
const instances: DeviceLogin[] = [];
afterEach(() => { instances.splice(0).forEach(login => login.close()); vi.useRealTimers(); });
function fixture() {
  const calls: { method: string; params: JsonValue }[] = [], redactor = new DiagnosticRedactor({});
  const native = async (method: string, params: JsonValue, options?: NativeOptions): Promise<JsonValue> => { options?.beforeWrite?.(); calls.push({ method, params }); return method.endsWith('/start') ? response : method.endsWith('/cancel') ? { status: 'canceled' } : {}; };
  const login = new DeviceLogin({ native, redactor }); instances.push(login); return { login, native, calls, redactor };
}
test('device credentials are private to one connection and durable result contains identity only', async () => {
  const { login, native, redactor } = fixture();
  expect(await login.start({}, native, owner)).toEqual({ type: 'chatgptDeviceCode', loginId: 'login' });
  expect(login.read({ loginId: 'login' }, owner)).toMatchObject({ ...response, status: 'pending' });
  for (const changed of [{ ...owner, clientId: 'other' }, { ...owner, eventChannelId: 'other' }]) {
    expect(() => login.read({ loginId: 'login' }, changed)).toThrow(expect.objectContaining({ code: 'not_found' }));
    await expect(login.cancel({ loginId: 'login' }, native, changed)).rejects.toMatchObject({ code: 'not_found' });
  }
  expect(JSON.stringify(redactor.value(response))).not.toContain('short-private-code');
  expect(await login.cancel({ loginId: 'login' }, native, owner)).toEqual({ status: 'canceled' });
  expect(() => login.read({ loginId: 'login' }, owner)).toThrow(expect.objectContaining({ code: 'not_found' }));
});
test('completion before the login response never revives an expired code', async () => {
  const { login, native } = fixture();
  await login.start({}, async (method, params, options) => { const result = await native(method, params, options); login.notification('account/login/completed', completion); return result; }, owner);
  expect(login.read({ loginId: 'login' }, owner)).toMatchObject({ status: 'completed' });
  expect(login.read({ loginId: 'login' }, owner)).not.toHaveProperty('userCode');
});
test('disconnection before dispatch prevents the queued login from starting', async () => {
  const { login, native, calls } = fixture(); let release!: () => void, ready!: () => void;
  const queued = new Promise<void>(resolve => { ready = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const task = login.start({}, async (method, params, options) => { ready(); await held; return native(method, params, options); }, owner);
  const outcome = expect(task).rejects.toMatchObject({ code: 'client_disconnected', delivery: 'not_sent' });
  await queued; await login.disconnect(owner.clientId, owner.eventChannelId); release(); await outcome; expect(calls).toEqual([]);
});
test('disconnection while dispatched revokes the late code and cancels its exact login ID', async () => {
  const { login, native, calls } = fixture(); let release!: () => void, ready!: () => void;
  const queued = new Promise<void>(resolve => { ready = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const task = login.start({}, async (method, params, options) => { const result = await native(method, params, options); ready(); await held; return result; }, owner);
  await queued; await login.disconnect(owner.clientId, owner.eventChannelId); release(); await task;
  expect(calls.at(-1)).toEqual({ method: 'account/login/cancel', params: { loginId: 'login' } });
  expect(() => login.read({ loginId: 'login' }, owner)).toThrow(expect.objectContaining({ code: 'not_found' }));
});
test('unknown or inconsistent native outcome cannot be retried or logged out as if no login happened', async () => {
  const { login, native } = fixture();
  await expect(login.start({}, async (_method, _params, options) => { options?.beforeWrite?.(); throw new DeliveryError('native_error', 'rejected', 'not_sent'); }, owner)).rejects.toMatchObject({ delivery: 'unknown' });
  await expect(login.start({}, native, owner)).rejects.toMatchObject({ code: 'login_pending' });
  await expect(login.logout({}, native)).rejects.toMatchObject({ code: 'login_pending' });
});
test('uncertain cancellation removes secrets and reserves login identity until known completion', async () => {
  const { login, native } = fixture(); await login.start({}, native, owner);
  await expect(login.cancel({ loginId: 'login' }, async () => { throw new DeliveryError('transport', 'lost', 'unknown'); }, owner)).rejects.toMatchObject({ delivery: 'unknown' });
  expect(() => login.read({ loginId: 'login' }, owner)).toThrow();
  await expect(login.start({}, native, owner)).rejects.toMatchObject({ code: 'login_pending' });
  login.notification('account/login/completed', completion); expect(await login.logout({}, native)).toEqual({});
});
test('expiry revokes and cancels a pending login; unsafe URLs never become a handoff', async () => {
  vi.useFakeTimers(); const { login, native, calls } = fixture(); await login.start({}, native, owner);
  await vi.advanceTimersByTimeAsync(600001);
  expect(calls.at(-1)).toEqual({ method: 'account/login/cancel', params: { loginId: 'login' } }); expect(() => login.read({ loginId: 'login' }, owner)).toThrow();
  await expect(login.start({}, async (_method, _params, options) => { options?.beforeWrite?.(); return { ...response, verificationUrl: 'http://bad.example' }; }, owner)).rejects.toMatchObject({ delivery: 'unknown' });
  expect(() => login.read({ loginId: 'login' }, owner)).toThrow();
});
