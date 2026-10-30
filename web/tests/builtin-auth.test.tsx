// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api, type AccountSecurity } from '../lib/api';
import { Login } from '../components/Login';
import { SecuritySettings } from '../components/SecuritySettings';
import { Settings } from '../components/Settings';
import { Events } from '../lib/events';

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const failure = (code: string, status = 400) => ({ ok: false, status, json: async () => ({ ok: false, error: { code, message: code } }) });
const session = { authenticated: true, operationRecoveryProtocol: 2, csrf: 'synthetic-csrf', initialized: true, authenticationMode: 'account' };
const password = 'synthetic password only';
function deferred() {
  let resolve!: (result: unknown) => void;
  const promise = new Promise((done) => { resolve = done; });
  return { resolve, promise };
}
function loginFields() {
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'admin' } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: password } });
}
function securityState(revision = 'revision-1', mfaEnabled = false): AccountSecurity {
  return {
    revision, username: 'admin', mfaEnabled, recoveryCodesRemaining: mfaEnabled ? 8 : 0,
    sessions: [
      { id: 'current-id', label: 'Browser current', createdAt: 1, lastSeenAt: 2, expiresAt: 3, current: true },
      { id: 'other-id', label: 'Browser other', createdAt: 1, lastSeenAt: 2, expiresAt: 3, current: false },
    ],
  };
}
async function security(handler: (url: string, body: Record<string, unknown>) => unknown = () => ({}), enabled = false) {
  let state = securityState('revision-1', enabled);
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'GET') return ok(state);
    return handler(url, JSON.parse(String(init?.body)));
  });
  vi.stubGlobal('fetch', fetch);
  const api = new Api(); api.csrf = 'synthetic-csrf';
  const view = render(<SecuritySettings api={api} authenticated />);
  await screen.findByText('admin');
  return { api, fetch, view, setState: (next: AccountSecurity) => { state = next; } };
}
function proof(mfa = false) {
  fireEvent.change(screen.getByLabelText('当前密码（安全验证）'), { target: { value: password } });
  if (mfa) fireEvent.change(screen.getByLabelText('当前验证码或恢复码'), { target: { value: '123456' } });
}

it('keeps MFA challenge within the same login and never persists credentials', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(failure('mfa_required', 401)).mockResolvedValueOnce(ok(session));
  vi.stubGlobal('fetch', fetch);
  const api = new Api(), onLogin = vi.fn(), lost = vi.fn(); api.onAuthenticationLost(lost);
  render(<Login api={api} onLogin={onLogin} />);
  loginFields();
  fireEvent.click(screen.getByRole('button', { name: '进入工作台 →' }));
  const code = await screen.findByLabelText('验证码或恢复码');
  expect(api.externalAuthenticationRequired).toBe(false);
  expect(lost).not.toHaveBeenCalled();
  expect((screen.getByLabelText('密码') as HTMLInputElement).value).toBe(password);
  fireEvent.change(code, { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: '进入工作台 →' }));
  await waitFor(() => expect(onLogin).toHaveBeenCalledOnce());
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ username: 'admin', password, remember: false, otp: '123456' });
  expect(JSON.stringify(localStorage) + JSON.stringify(sessionStorage)).not.toContain(password);
  expect((screen.getByLabelText('密码') as HTMLInputElement).value).toBe('');
});

it('submits account creation once and keeps password whitespace intact', async () => {
  const response = deferred(), fetch = vi.fn((_url: string, _init: RequestInit) => response.promise); vi.stubGlobal('fetch', fetch);
  const api = new Api(), onLogin = vi.fn(); render(<Login api={api} onLogin={onLogin} setupRequired />);
  fireEvent.change(screen.getByLabelText('一次性初始化令牌'), { target: { value: 'synthetic-bootstrap-token' } });
  const value = ` ${password} `;
  fireEvent.change(screen.getByLabelText('设置密码'), { target: { value } });
  fireEvent.change(screen.getByLabelText('再次输入密码'), { target: { value } });
  const form = screen.getByLabelText('设置密码').closest('form')!;
  act(() => { fireEvent.submit(form); fireEvent.submit(form); });
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][0]).toBe('/api/account/setup');
  expect(JSON.parse(String(fetch.mock.calls[0][1].body))).toEqual({ token: 'synthetic-bootstrap-token', username: 'admin', password: value });
  await act(async () => response.resolve(ok(session)));
  await waitFor(() => expect(onLogin).toHaveBeenCalledOnce());
  expect(JSON.stringify(localStorage) + JSON.stringify(sessionStorage)).not.toContain('synthetic-bootstrap');
});

it('checks a lost setup result by reading session and does not resubmit initialization', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error('transport')).mockResolvedValueOnce(ok({ authenticated: false, initialized: true, setupRequired: false }));
  vi.stubGlobal('fetch', fetch);
  render(<Login api={new Api()} onLogin={vi.fn()} setupRequired />);
  fireEvent.change(screen.getByLabelText('一次性初始化令牌'), { target: { value: 'synthetic-bootstrap-token' } });
  fireEvent.change(screen.getByLabelText('设置密码'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('再次输入密码'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: '创建账号并进入工作台' }));
  fireEvent.click(await screen.findByRole('button', { name: '重新检查账号状态' }));
  await screen.findByLabelText('密码');
  expect(screen.queryByLabelText('一次性初始化令牌')).toBeNull();
  expect(fetch.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
    ['/api/account/setup', 'POST'], ['/api/session', 'GET'],
  ]);
});

it('rejects stale login completion after a newer authentication transition', async () => {
  const response = deferred(); vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => response.promise).mockResolvedValueOnce(ok(session)));
  const api = new Api();
  const old = api.session({ username: 'admin', password });
  const assertion = expect(old).rejects.toMatchObject({ code: 'stale_session' });
  await api.session({ username: 'admin', password });
  response.resolve(ok({ ...session, csrf: 'obsolete-csrf' }));
  await assertion; expect(api.csrf).toBe('synthetic-csrf');
});

it('does not call login completion after the login view is unmounted', async () => {
  const response = deferred(); vi.stubGlobal('fetch', vi.fn(() => response.promise));
  const onLogin = vi.fn(), view = render(<Login api={new Api()} onLogin={onLogin} />);
  loginFields(); fireEvent.click(screen.getByRole('button', { name: '进入工作台 →' })); view.unmount();
  await act(async () => response.resolve(ok(session)));
  expect(onLogin).not.toHaveBeenCalled();
});

it('returns from retained external-auth migration mode to the built-in login', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ authenticated: false, initialized: true, setupRequired: false })));
  render(<Login api={new Api()} onLogin={vi.fn()} externalAuthentication />);
  fireEvent.click(screen.getByRole('button', { name: '重新检查登录' }));
  await screen.findByLabelText('用户名');
  expect(screen.queryByRole('link', { name: '在新标签页完成访问认证 ↗' })).toBeNull();
});

it('changes password with the observed revision and invalidates the application session', async () => {
  const f = await security(() => ok({ authenticated: false })), lost = vi.fn(); f.api.onAuthenticationLost(lost);
  proof();
  fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'synthetic new password' } });
  fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'synthetic new password' } });
  fireEvent.click(screen.getByRole('button', { name: '修改密码并退出所有设备' }));
  await waitFor(() => expect(lost).toHaveBeenCalledWith(false));
  expect(f.api.csrf).toBe('');
  const [, init] = f.fetch.mock.calls.find(([url]) => url === '/api/account/password')!;
  expect(JSON.parse(String(init?.body))).toEqual({ currentPassword: password, password: 'synthetic new password', expectedRevision: 'revision-1' });
  expect(JSON.stringify(localStorage) + JSON.stringify(sessionStorage)).not.toContain('synthetic new password');
});

it('holds unknown mutations until an explicit status read and never replays them', async () => {
  const f = await security(() => { throw new Error('lost'); });
  proof(); fireEvent.click(screen.getByRole('button', { name: '设置两步验证' }));
  await screen.findByText(/操作结果或账号版本需要核对/);
  expect(screen.getByRole('button', { name: '设置两步验证' }).matches(':disabled')).toBe(true);
  expect((screen.getByLabelText('当前密码（安全验证）') as HTMLInputElement).value).toBe('');
  f.setState(securityState('revision-2'));
  fireEvent.click(screen.getByRole('button', { name: '重新读取状态' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '重新读取状态' }).matches(':disabled')).toBe(false));
  expect(f.fetch.mock.calls.filter(([url]) => url === '/api/account/totp/start')).toHaveLength(1);
  expect(screen.queryByLabelText('验证器设置密钥')).toBeNull();
});

it('treats server errors after a security mutation as unknown', async () => {
  const f = await security(() => failure('internal', 500));
  proof(); fireEvent.click(screen.getByRole('button', { name: '设置两步验证' }));
  await screen.findByText(/操作结果或账号版本需要核对/);
  expect(f.fetch.mock.calls.filter(([url]) => url === '/api/account/totp/start')).toHaveLength(1);
});

it('honors an explicit unknown delivery on a 400 security response', async () => {
  const f = await security(() => ({ ok: false, status: 400, json: async () => ({ ok: false, error: { code: 'capacity', message: 'response lost', delivery: 'unknown' } }) }));
  proof(); fireEvent.click(screen.getByRole('button', { name: '设置两步验证' }));
  await screen.findByText(/操作结果或账号版本需要核对/);
  expect(screen.getByRole('button', { name: '设置两步验证' }).matches(':disabled')).toBe(true);
  expect(f.fetch.mock.calls.filter(([url]) => url === '/api/account/totp/start')).toHaveLength(1);
});

it.each(['setup', 'login'] as const)('honors an explicit unknown delivery on a 400 %s response', async (mode) => {
  const fetch = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ ok: false, error: { code: 'capacity', delivery: 'unknown' } }) });
  vi.stubGlobal('fetch', fetch);
  const api = new Api();
  const result = mode === 'setup'
    ? api.setupAccount({ token: 'synthetic-token', username: 'admin', password })
    : api.session({ username: 'admin', password });
  await expect(result).rejects.toMatchObject({ code: 'capacity', delivery: 'unknown' });
  expect(api.externalAuthenticationRequired).toBe(false);
  expect(fetch).toHaveBeenCalledOnce();
});

it('does not classify an unknown MFA result as an external authentication challenge', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ ok: false, error: { code: 'mfa_required', delivery: 'unknown' } }) }));
  const api = new Api();
  await expect(api.session({ username: 'admin', password })).rejects.toMatchObject({ code: 'mfa_required', delivery: 'unknown' });
  expect(api.externalAuthenticationRequired).toBe(false);
});

it('enrolls TOTP and shows recovery codes only in volatile view state', async () => {
  const f = await security((url) => {
    if (url.endsWith('/start')) return ok({ enrollmentId: 'enrollment', secret: 'SYNTHETICSECRET', uri: 'otpauth://totp/synthetic', expiresAt: Date.now() + 60000 });
    f.setState(securityState('revision-2', true));
    return ok({ mfaEnabled: true, recoveryCodes: ['synthetic-recovery-1', 'synthetic-recovery-2'] });
  });
  proof(); fireEvent.click(screen.getByRole('button', { name: '设置两步验证' }));
  expect((await screen.findByLabelText('验证器设置密钥') as HTMLInputElement).value).toBe('SYNTHETICSECRET');
  fireEvent.change(screen.getByLabelText('验证器生成的 6 位验证码'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: '验证并开启两步验证' }));
  expect((await screen.findByLabelText('新的恢复码') as HTMLTextAreaElement).value).toContain('synthetic-recovery-1');
  expect(screen.queryByLabelText('验证器设置密钥')).toBeNull();
  expect(JSON.stringify(localStorage) + JSON.stringify(sessionStorage)).not.toMatch(/SYNTHETICSECRET|synthetic-recovery/);
  fireEvent.click(screen.getByRole('button', { name: '我已保存，隐藏恢复码' }));
  expect(screen.queryByLabelText('新的恢复码')).toBeNull();
});

it('discards a late enrollment secret after authentication suspension', async () => {
  const response = deferred(), f = await security(() => response.promise);
  proof(); fireEvent.click(screen.getByRole('button', { name: '设置两步验证' }));
  f.view.rerender(<SecuritySettings api={f.api} authenticated={false} />);
  await act(async () => response.resolve(ok({ enrollmentId: 'enrollment', secret: 'SYNTHETICSECRET', uri: 'otpauth://totp/synthetic', expiresAt: Date.now() + 60000 })));
  expect(screen.queryByLabelText('验证器设置密钥')).toBeNull();
  expect(screen.queryByText('SYNTHETICSECRET')).toBeNull();
});

it('clears displayed secrets as soon as authentication is lost', async () => {
  const f = await security(() => ok({ recoveryCodes: ['synthetic-recovery-1'] }), true);
  proof(true); fireEvent.click(screen.getByRole('button', { name: '重新生成恢复码（旧码失效）' }));
  await screen.findByLabelText('新的恢复码');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(failure('unauthorized', 401)));
  await act(async () => { await expect(f.api.account()).rejects.toMatchObject({ code: 'unauthorized' }); });
  expect(screen.queryByLabelText('新的恢复码')).toBeNull();
});

it('keeps invalid password errors local to security settings without logging out', async () => {
  const f = await security(() => failure('credential_invalid')), lost = vi.fn(); f.api.onAuthenticationLost(lost);
  proof(); fireEvent.click(screen.getByRole('button', { name: '设置两步验证' }));
  await screen.findByRole('alert');
  expect(lost).not.toHaveBeenCalled(); expect(f.api.csrf).toBe('synthetic-csrf');
  expect(screen.queryByText(/操作结果或账号版本需要核对/)).toBeNull();
});

it('revokes only the selected session and binds it to the observed account revision', async () => {
  const f = await security(() => ok({ authenticated: true, operationRecoveryProtocol: 2 }));
  fireEvent.click(screen.getByRole('button', { name: '撤销此设备登录' }));
  await screen.findByText('已撤销该设备的登录。');
  const [, init] = f.fetch.mock.calls.find(([url]) => url === '/api/account/sessions/revoke')!;
  expect(JSON.parse(String(init?.body))).toEqual({ sessionId: 'other-id', expectedRevision: 'revision-1' });
});

it('does not disclose a stale account response after a new login', async () => {
  const response = deferred(); vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => response.promise).mockResolvedValueOnce(ok(session)));
  const api = new Api(); api.csrf = 'old';
  const request = api.account('totp/recovery', {}), rejected = expect(request).rejects.toMatchObject({ code: 'stale_session' });
  await api.session({ username: 'admin', password });
  response.resolve(ok({ recoveryCodes: ['obsolete-sensitive-code'] }));
  await rejected;
});

it('accepts full Unicode passwords and counts setup length by code points', async () => {
  const fetch = vi.fn().mockResolvedValue(ok(session)); vi.stubGlobal('fetch', fetch);
  render(<Login api={new Api()} onLogin={vi.fn()} setupRequired />);
  fireEvent.change(screen.getByLabelText('一次性初始化令牌'), { target: { value: 'synthetic-bootstrap-token' } });
  const input = screen.getByLabelText('设置密码') as HTMLInputElement;
  expect(input.maxLength).toBe(512);
  fireEvent.change(input, { target: { value: '🔐'.repeat(6) } });
  fireEvent.change(screen.getByLabelText('再次输入密码'), { target: { value: '🔐'.repeat(6) } });
  expect(screen.getByRole('button', { name: '创建账号并进入工作台' }).matches(':disabled')).toBe(true);
  const value = '🔐'.repeat(256);
  fireEvent.change(input, { target: { value } });
  fireEvent.change(screen.getByLabelText('再次输入密码'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: '创建账号并进入工作台' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect(JSON.parse(fetch.mock.calls[0][1].body).password).toBe(value);
});

it('keeps gateway account management available while the worker connection is down', async () => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  const fetch = vi.fn().mockResolvedValue(ok(securityState())); vi.stubGlobal('fetch', fetch);
  const api = new Api(); api.csrf = 'synthetic-csrf';
  render(<Settings api={api} events={new Events()} epoch="runtime-down" connected={false}
    projects={[]} theme="system" onTheme={vi.fn()} onClose={vi.fn()} onChanged={vi.fn()}
    onProjectAction={vi.fn()} onLogout={vi.fn()} onOpenDraft={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '账号与安全' }));
  await screen.findByText('admin');
  expect(screen.getByRole('button', { name: '撤销此设备登录' }).matches(':disabled')).toBe(false);
  expect(fetch.mock.calls[0][0]).toBe('/api/account');
});
