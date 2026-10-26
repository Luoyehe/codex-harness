// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../App';

vi.mock('../Workspace', () => ({
  Workspace: ({ logout }: { logout: () => Promise<void> }) => (
    <button onClick={() => void logout()}>退出测试工作台</button>
  ),
}));
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('returns to ordinary account login after the initial administrator is created and logs out', async () => {
  let initialized = false;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/account/setup') initialized = true;
    const authenticated = url === '/api/account/setup';
    return {
      ok: true, status: 200,
      json: async () => ({ initialized, setupRequired: !initialized, authenticated, ...(authenticated ? { csrf: 'synthetic-csrf' } : {}) }),
    };
  });
  vi.stubGlobal('fetch', fetch);
  render(<App />);
  fireEvent.change(await screen.findByLabelText('一次性初始化令牌'), { target: { value: 'synthetic-bootstrap-token' } });
  fireEvent.change(screen.getByLabelText('设置密码'), { target: { value: 'synthetic password only' } });
  fireEvent.change(screen.getByLabelText('再次输入密码'), { target: { value: 'synthetic password only' } });
  fireEvent.click(screen.getByRole('button', { name: '创建账号并进入工作台' }));
  fireEvent.click(await screen.findByRole('button', { name: '退出测试工作台' }));
  await screen.findByLabelText('密码');
  expect(screen.queryByLabelText('一次性初始化令牌')).toBeNull();
  expect(fetch.mock.calls.filter(([url]) => url === '/api/account/setup')).toHaveLength(1);
  expect(fetch.mock.calls.some(([url, init]) => url === '/api/session' && init?.method === 'DELETE')).toBe(true);
});
