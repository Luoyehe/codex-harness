// @vitest-environment jsdom
import { enabledButton } from './enabled-button';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { Events } from '../lib/events';
import { AccountSettings } from '../components/AccountSettings';
import { Settings } from '../components/Settings';
import { listOperations } from '../lib/operations';
type Call = { method: string; params: Record<string, unknown>; operationId?: string };
const code = () => ({
  loginId: 'login',
  type: 'chatgptDeviceCode',
  status: 'pending',
  verificationUrl: 'https://example.invalid/device',
  userCode: 'PRIVATE-DEVICE-CODE',
  expiresAt: Date.now() + 60000,
});
function setup(handler: (c: Call) => unknown = () => undefined) {
  const api = new Api(),
    events = new Events(),
    calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url, init) => {
      const c: Call = JSON.parse(init.body);
      calls.push(c);
      const result =
        (await handler(c)) ??
        (c.method === 'system/provider/read'
          ? { revision: 'provider-fixture', defaultProviderId: 'chatgpt', profiles: [], connections: [{
            id: 'chatgpt', name: 'ChatGPT', kind: 'chatgpt', enabled: true, modelProvider: 'harness_chatgpt',
          }] }
          : c.method === 'model/list' ? { data: [], nextCursor: null }
          : c.method === 'account/read'
          ? { account: null }
          : c.method === 'account/login'
            ? { loginId: 'login', type: 'chatgptDeviceCode' }
            : c.method === 'account/login/handoff'
              ? code()
              : c.method === 'account/login/cancel'
                ? { status: 'canceled' }
                : {});
      return {
        ok: true,
        status: 200,
        json: async () =>
          result && typeof result === 'object' && 'fault' in result
            ? { ok: false, error: result.fault }
            : { ok: true, result },
      };
    }),
  );
  return { api, events, calls };
}
const props = (s: ReturnType<typeof setup>) => ({
  api: s.api,
  events: s.events,
  epoch: 'runtime',
  connectionId: 'connection',
  connected: true,
  enabled: true,
  onServiceSettings: vi.fn(),
});
const start = async () => fireEvent.click(await enabledButton({ name: '使用 ChatGPT 登录' }));
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('blocks account changes during reading but allows an explicit login after a terminal read failure without reading limits', async () => {
  let finish!: (value: unknown) => void;
  const s = setup(c => c.method === 'account/read'
    ? new Promise(resolve => { finish = resolve; })
    : undefined);
  render(<AccountSettings {...props(s)} />);
  const login = screen.getByRole('button', { name: '使用 ChatGPT 登录' });
  const logout = screen.getByRole('button', { name: '退出模型账户' });
  expect(login).toHaveProperty('disabled', true);
  expect(logout).toHaveProperty('disabled', true);
  fireEvent.click(login);
  fireEvent.click(logout);
  expect(s.calls.some(c => ['account/login', 'account/logout', 'account/rateLimits'].includes(c.method))).toBe(false);
  await act(async () => finish({ fault: { code: 'runtime_error', message: 'account read failed', delivery: 'not_sent' } }));
  await screen.findByText(/account read failed/);
  expect(login).toHaveProperty('disabled', false);
  expect(logout).toHaveProperty('disabled', false);
  expect(s.calls.some(c => ['account/login', 'account/logout', 'account/rateLimits'].includes(c.method))).toBe(false);
  await start();
  await screen.findByText('PRIVATE-DEVICE-CODE');
  expect(s.calls.filter(c => c.method === 'account/login')).toHaveLength(1);
  expect(login).toHaveProperty('disabled', true);
  expect(logout).toHaveProperty('disabled', true);
  expect(await enabledButton({ name: '取消原设备码登录' })).toBeTruthy();
  expect(s.calls.some(c => c.method === 'account/rateLimits')).toBe(false);
});

it('allows an explicit logout after a failed account read and checks the resulting signed-out account', async () => {
  let signedOut = false;
  const s = setup(c => {
    if (c.method === 'account/read') return signedOut ? { account: null }
      : { fault: { code: 'runtime_error', message: 'account read failed', delivery: 'not_sent' } };
    if (c.method === 'account/logout') { signedOut = true; return {}; }
    return undefined;
  });
  render(<AccountSettings {...props(s)} />);
  await screen.findByText(/无法确认当前账户/);
  expect(s.calls.some(c => ['account/login', 'account/logout'].includes(c.method))).toBe(false);
  fireEvent.click(await enabledButton({ name: '退出模型账户' }));
  await screen.findByText('尚未登录');
  expect(s.calls.filter(c => c.method === 'account/logout')).toHaveLength(1);
  expect(s.calls.filter(c => c.method === 'account/read')).toHaveLength(2);
  expect(s.calls.some(c => ['account/login', 'account/rateLimits'].includes(c.method))).toBe(false);
  expect(await enabledButton({ name: '使用 ChatGPT 登录' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '退出模型账户' })).toHaveProperty('disabled', true);
});

it('reads limits only after authenticated state and removes them on logout without another signed-out request', async () => {
  let loggedIn = true;
  const s = setup(c => {
    if (c.method === 'account/read') return { account: loggedIn ? { type: 'chatgpt', email: 'fixture@example.test' } : null };
    if (c.method === 'account/rateLimits') return { rateLimits: { fixtureRemaining: 42 } };
    if (c.method === 'account/logout') { loggedIn = false; return {}; }
    return undefined;
  });
  render(<AccountSettings {...props(s)} />);
  await screen.findByText('fixture@example.test');
  await screen.findByText(/fixtureRemaining/);
  expect(s.calls.filter(c => c.method === 'account/rateLimits')).toHaveLength(1);
  fireEvent.click(await enabledButton({ name: '退出模型账户' }));
  await screen.findByText('尚未登录');
  expect(screen.queryByText(/fixtureRemaining/)).toBeNull();
  expect(s.calls.filter(c => c.method === 'account/rateLimits')).toHaveLength(1);
  await start();
  await screen.findByText('PRIVATE-DEVICE-CODE');
  expect(s.calls.filter(c => c.method === 'account/rateLimits')).toHaveLength(1);
  loggedIn = true;
  act(() => s.events.publish({ type: 'notification', data: {
    method: 'account/login/completed', params: { loginId: 'login', success: true },
  } }));
  await screen.findByText('fixture@example.test');
  await screen.findByText(/fixtureRemaining/);
  expect(s.calls.filter(c => c.method === 'account/rateLimits')).toHaveLength(2);
  expect(s.calls.filter(c => c.method === 'account/login')).toHaveLength(1);
});

it('keeps cancellation of the original device login available while account status is being re-read', async () => {
  let hold = false;
  const finishes: ((value: unknown) => void)[] = [];
  const s = setup(c => c.method === 'account/read' && hold
    ? new Promise(resolve => { finishes.push(resolve); }) : undefined);
  render(<AccountSettings {...props(s)} />);
  await start();
  await screen.findByText('PRIVATE-DEVICE-CODE');
  hold = true;
  fireEvent.click(screen.getByRole('button', { name: '重新读取账户与登录状态' }));
  await screen.findByText('读取账户中…');
  fireEvent.click(await enabledButton({ name: '取消原设备码登录' }));
  await screen.findByText('已取消原设备码登录。');
  expect(s.calls.filter(c => c.method === 'account/login/cancel')).toHaveLength(1);
  expect(s.calls.filter(c => c.method === 'account/login')).toHaveLength(1);
  hold = false;
  await act(async () => finishes.forEach(finish => finish({ account: null })));
});

it('keeps device secrets outside receipts and storage and reads only the owner handoff after explicit login', async () => {
  const s = setup();
  render(<AccountSettings {...props(s)} />);
  expect(s.calls.some((c) => c.method === 'account/login')).toBe(false);
  await start();
  await screen.findByText('PRIVATE-DEVICE-CODE');
  expect(screen.getByText(/本地登录交接保留至/).textContent).toContain('设备码是否有效以验证页面为准');
  expect(screen.queryByText(/^有效至 /)).toBeNull();
  expect(s.calls.find((c) => c.method === 'account/login/handoff')?.params).toEqual({
    loginId: 'login',
  });
  expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(
    'PRIVATE-DEVICE-CODE',
  );
  fireEvent.click(screen.getByRole('button', { name: '取消原设备码登录' }));
  await screen.findByText('已取消原设备码登录。');
  expect(screen.queryByText('PRIVATE-DEVICE-CODE')).toBeNull();
  expect(s.calls.find((c) => c.method === 'account/login/cancel')?.params).toEqual({
    loginId: 'login',
  });
});
it('recovers a lost login response through the original receipt without opening a second login', async () => {
  let id = '';
  const s = setup((c) => {
    if (c.method === 'account/read')
      return { fault: { code: 'runtime_error', message: 'account read failed', delivery: 'not_sent' } };
    if (c.method === 'account/login') {
      id = c.operationId!;
      throw new Error('response lost');
    }
    if (c.method === 'operation/read')
      return {
        operationId: id,
        method: 'account/login',
        state: 'accepted',
        result: { type: 'chatgptDeviceCode', loginId: 'login' },
      };
  });
  render(<AccountSettings {...props(s)} />);
  await start();
  const recover = await enabledButton({ name: '查询原账户操作回执' });
  expect(
    (screen.getByRole('button', { name: '使用 ChatGPT 登录' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(recover);
  await screen.findByText('PRIVATE-DEVICE-CODE');
  expect(s.calls.filter((c) => c.method === 'account/login')).toHaveLength(1);
  expect((await listOperations())).toEqual([]);
});
it('does not revive a device code from a late handoff after native completion', async () => {
  let finish!: (v: unknown) => void;
  const s = setup((c) =>
    c.method === 'account/login/handoff'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : undefined,
  );
  render(<AccountSettings {...props(s)} />);
  await start();
  await waitFor(() => expect(s.calls.some((c) => c.method === 'account/login/handoff')).toBe(true));
  act(() =>
    s.events.publish({
      type: 'notification',
      data: { method: 'account/login/completed', params: { loginId: 'login', success: true } },
    }),
  );
  await act(async () => finish(code()));
  expect(screen.queryByText('PRIVATE-DEVICE-CODE')).toBeNull();
  expect(screen.queryByRole('button', { name: '取消原设备码登录' })).toBeNull();
  expect(s.calls.filter((c) => c.method === 'account/login')).toHaveLength(1);
});
it('clears codes and ignores old owner responses on disconnect or replacement', async () => {
  let finish!: (v: unknown) => void;
  const s = setup((c) =>
    c.method === 'account/login/handoff'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : undefined,
  );
  const view = render(<AccountSettings {...props(s)} />);
  await start();
  await waitFor(() => expect(s.calls.some((c) => c.method === 'account/login/handoff')).toBe(true));
  view.rerender(<AccountSettings {...props(s)} connected={false} />);
  await act(async () => finish(code()));
  expect(screen.queryByText('PRIVATE-DEVICE-CODE')).toBeNull();
  view.rerender(<AccountSettings {...props(s)} connectionId="new-connection" />);
  expect(s.calls.filter((c) => c.method === 'account/login')).toHaveLength(1);
  expect(s.calls.filter((c) => c.method === 'account/login/handoff')).toHaveLength(1);
});
it('keeps account handoff mounted across settings tabs and ordinary config refresh', async () => {
  const s = setup();
  const p = {
    api: s.api,
    events: s.events,
    epoch: 'resource-1',
    runtimeEpoch: 'runtime',
    connectionId: 'owner',
    connected: true,
    configurationReady: true,
    projects: [],
    theme: 'system',
    onTheme: vi.fn(),
    onClose: vi.fn(),
    onChanged: vi.fn(),
    onProjectAction: vi.fn(),
    onLogout: vi.fn(),
    onOpenDraft: vi.fn(),
  };
  const view = render(<Settings {...p} />);
  fireEvent.click(screen.getByRole('button', { name: '模型供应商' }));
  fireEvent.click(await enabledButton({ name: '使用 ChatGPT 登录' }));
  await screen.findByText('PRIVATE-DEVICE-CODE');
  fireEvent.click(screen.getByRole('button', { name: '通用' }));
  expect(screen.queryByRole('link', { name: '打开验证页面 ↗' })).toBeNull();
  view.rerender(<Settings {...p} epoch="resource-2" />);
  fireEvent.click(screen.getByRole('button', { name: '模型供应商' }));
  expect(screen.getByRole('link', { name: '打开验证页面 ↗' })).toBeTruthy();
  expect(s.calls.filter((c) => c.method === 'account/login')).toHaveLength(1);
});
it('treats revoked handoffs as closed and blocks changes when global admission is disabled', async () => {
  let reads = 0;
  let finishRead!: (value: unknown) => void;
  const s = setup((c) => {
    if (c.method === 'account/read' && ++reads > 1)
      return new Promise(resolve => { finishRead = resolve; });
    if (c.method === 'account/login/handoff')
      return { fault: { code: 'not_found', message: 'expired', delivery: 'not_sent' } };
    return undefined;
  });
  const view = render(<AccountSettings {...props(s)} enabled={false} />);
  fireEvent.click(screen.getByRole('button', { name: '使用 ChatGPT 登录' }));
  expect(s.calls.some((c) => c.method === 'account/login')).toBe(false);
  view.rerender(<AccountSettings {...props(s)} />);
  await start();
  await screen.findByText(/原登录交接已撤销或到期/);
  expect(screen.queryByText('PRIVATE-DEVICE-CODE')).toBeNull();
  await screen.findByText('读取账户中…');
  await waitFor(() => expect(finishRead).toBeTypeOf('function'));
  const login = screen.getByRole('button', { name: '使用 ChatGPT 登录' });
  expect(login).toHaveProperty('disabled', true);
  fireEvent.click(login);
  expect(s.calls.filter(c => c.method === 'account/login')).toHaveLength(1);
  await act(async () => finishRead({ account: null }));
  expect(await enabledButton({ name: '使用 ChatGPT 登录' })).toBe(login);
  expect(reads).toBe(2);
  expect(s.calls.filter(c => c.method === 'account/login')).toHaveLength(1);
  expect(s.calls.filter(c => c.method === 'account/login/handoff')).toHaveLength(1);
});
it('does not turn accepted receipt without login identity into a fresh automatic login', async () => {
  const s = setup((c) => (c.method === 'account/login' ? {} : undefined));
  const service = vi.fn();
  render(<AccountSettings {...props(s)} onServiceSettings={service} />);
  await start();
  await screen.findByText(/没有取得有效登录 ID/);
  expect(
    (screen.getByRole('button', { name: '使用 ChatGPT 登录' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '前往服务管理恢复' }));
  expect(service).toHaveBeenCalledOnce();
  expect(s.calls.filter((c) => c.method === 'account/login')).toHaveLength(1);
});
it('retains the missing-identity recovery gate when the settings modal is reopened', async () => {
  const s = setup((c) => (c.method === 'account/login' ? {} : undefined));
  const view = render(<AccountSettings {...props(s)} />);
  await start();
  await screen.findByText(/没有取得有效登录 ID/);
  view.unmount();
  render(<AccountSettings {...props(s)} />);
  expect(
    (screen.getByRole('button', { name: '使用 ChatGPT 登录' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(await enabledButton({ name: '查询原账户操作回执' })).toBeTruthy();
  expect(s.calls.filter((c) => c.method === 'account/login')).toHaveLength(1);
});
