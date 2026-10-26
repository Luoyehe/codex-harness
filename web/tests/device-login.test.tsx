// @vitest-environment jsdom
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
        (c.method === 'account/read'
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
const start = () => fireEvent.click(screen.getByRole('button', { name: '使用 ChatGPT 登录' }));
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
it('keeps device secrets outside receipts and storage and reads only the owner handoff after explicit login', async () => {
  const s = setup();
  render(<AccountSettings {...props(s)} />);
  expect(s.calls.some((c) => c.method === 'account/login')).toBe(false);
  start();
  await screen.findByText('PRIVATE-DEVICE-CODE');
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
  start();
  const recover = await screen.findByRole('button', { name: '查询原账户操作回执' });
  expect(
    (screen.getByRole('button', { name: '使用 ChatGPT 登录' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(recover);
  await screen.findByText('PRIVATE-DEVICE-CODE');
  expect(s.calls.filter((c) => c.method === 'account/login')).toHaveLength(1);
  expect(listOperations()).toEqual([]);
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
  start();
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
  start();
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
    onProjectsChanged: vi.fn(),
    onLogout: vi.fn(),
    onOpenDraft: vi.fn(),
  };
  const view = render(<Settings {...p} />);
  fireEvent.click(screen.getByRole('button', { name: '模型账户' }));
  start();
  await screen.findByText('PRIVATE-DEVICE-CODE');
  fireEvent.click(screen.getByRole('button', { name: '通用' }));
  expect(screen.queryByRole('link', { name: '打开验证页面 ↗' })).toBeNull();
  view.rerender(<Settings {...p} epoch="resource-2" />);
  fireEvent.click(screen.getByRole('button', { name: '模型账户' }));
  expect(screen.getByRole('link', { name: '打开验证页面 ↗' })).toBeTruthy();
  expect(s.calls.filter((c) => c.method === 'account/login')).toHaveLength(1);
});
it('treats revoked handoffs as closed and blocks changes when global admission is disabled', async () => {
  const s = setup((c) =>
    c.method === 'account/login/handoff'
      ? { fault: { code: 'not_found', message: 'expired', delivery: 'not_sent' } }
      : undefined,
  );
  const view = render(<AccountSettings {...props(s)} enabled={false} />);
  start();
  expect(s.calls.some((c) => c.method === 'account/login')).toBe(false);
  view.rerender(<AccountSettings {...props(s)} />);
  start();
  await screen.findByText(/原设备码已撤销或过期/);
  expect(screen.queryByText('PRIVATE-DEVICE-CODE')).toBeNull();
  expect(
    (screen.getByRole('button', { name: '使用 ChatGPT 登录' }) as HTMLButtonElement).disabled,
  ).toBe(false);
});
it('does not turn accepted receipt without login identity into a fresh automatic login', async () => {
  const s = setup((c) => (c.method === 'account/login' ? {} : undefined));
  const service = vi.fn();
  render(<AccountSettings {...props(s)} onServiceSettings={service} />);
  start();
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
  start();
  await screen.findByText(/没有取得有效登录 ID/);
  view.unmount();
  render(<AccountSettings {...props(s)} />);
  expect(
    (screen.getByRole('button', { name: '使用 ChatGPT 登录' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(screen.getByRole('button', { name: '查询原账户操作回执' })).toBeTruthy();
  expect(s.calls.filter((c) => c.method === 'account/login')).toHaveLength(1);
});
