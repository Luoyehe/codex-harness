// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountToolsPanel } from '../components/AccountToolsPanel';
import { Api } from '../lib/api';
import { Events } from '../lib/events';
type Call = { method: string; params: Record<string, unknown>; operationId?: string };
function routed(handler: (call: Call) => unknown) {
  const calls: Call[] = [],
    api = new Api();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      const call: Call = JSON.parse(String(init.body));
      calls.push(call);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: await handler(call) }),
      };
    }),
  );
  return { api, calls };
}
const base = {
  epoch: 'one',
  connectionId: 'connection',
  enabled: true,
  connected: true,
  onChanged: vi.fn(),
};
const preview = {
  previewHash: 'hash',
  accountId: 'account',
  redeemable: true,
  summary: {
    availableCount: 1,
    credits: [
      { id: 'credit', title: 'One reset', description: null, status: 'available', expiresAt: null },
    ],
  },
};
const gateway = {
  providerId: 'enterprise',
  providerName: 'Enterprise',
  required: true,
  status: 'notReady',
  error: null,
};
const route = (call: Call) =>
  call.method === 'account/resetCredit/preview'
    ? preview
    : call.method === 'account/gatewayOAuth/read'
      ? gateway
      : call.method === 'userVerification/status'
        ? {
            credentialId: null,
            unavailableReason: 'providerUnavailable',
            unavailableMessage: 'This host has no verification provider.',
          }
        : {};
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('only explicitly redeems the selected current credit and displays the exact native non-reset outcome', async () => {
  const { api, calls } = routed((call) =>
    call.method === 'account/resetCredit/consume'
      ? { outcome: 'nothingToReset', accountId: 'account' }
      : route(call),
  );
  render(<AccountToolsPanel {...base} api={api} events={new Events()} />);
  fireEvent.click(screen.getByText('明确使用一次额度重置', { selector: 'summary' }));
  await screen.findByText('可用重置次数：1');
  const redeem = screen.getByRole('button', { name: '使用一次重置' });
  expect((redeem as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByRole('combobox', { name: '选择重置权益' }), {
    target: { value: 'credit' },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: '确认使用当前账号的一次重置权益' }));
  fireEvent.click(redeem);
  fireEvent.click(redeem);
  await screen.findByText('当前没有需要重置的额度。');
  const writes = calls.filter((call) => call.method === 'account/resetCredit/consume');
  expect(writes).toHaveLength(1);
  expect(writes[0]!.params).toEqual({ previewHash: 'hash', creditId: 'credit', confirm: true });
  expect(writes[0]!.operationId).toBeTruthy();
});
it('an unknown redemption queries its original operation without submitting another redemption', async () => {
  let id = '';
  const { api, calls } = routed((call) => {
    if (call.method === 'account/resetCredit/consume') {
      id = call.operationId!;
      throw new Error('lost response');
    }
    if (call.method === 'operation/read')
      return {
        operationId: id,
        state: 'accepted',
        method: 'account/resetCredit/consume',
        result: { outcome: 'alreadyRedeemed', accountId: 'account' },
      };
    return route(call);
  });
  render(<AccountToolsPanel {...base} api={api} events={new Events()} />);
  fireEvent.click(screen.getByText('明确使用一次额度重置', { selector: 'summary' }));
  await screen.findByText('可用重置次数：1');
  fireEvent.click(screen.getByRole('checkbox', { name: '确认使用当前账号的一次重置权益' }));
  fireEvent.click(screen.getByRole('button', { name: '使用一次重置' }));
  fireEvent.click(await screen.findByRole('button', { name: '查询原账号操作回执' }));
  await screen.findByText('此重置次数已经使用，不会重复兑换。');
  expect(calls.filter((call) => call.method === 'account/resetCredit/consume')).toHaveLength(1);
});
it('gateway authorization uses a private handoff and clears the link on browser connection loss', async () => {
  const { api, calls } = routed((call) =>
    call.method === 'account/gatewayOAuth/login'
      ? { handoffId: 'handoff', providerId: 'enterprise', started: true }
      : call.method === 'account/gatewayOAuth/handoff'
        ? {
            status: 'started',
            authUrl: 'https://auth.example/start?state=private',
            expiresAt: Date.now() + 300000,
          }
        : route(call),
  );
  const events = new Events(),
    view = render(<AccountToolsPanel {...base} api={api} events={events} />);
  fireEvent.click(screen.getByText('供应商网关 OAuth', { selector: 'summary' }));
  await screen.findByText('当前供应商：Enterprise');
  fireEvent.click(screen.getByRole('checkbox', { name: '确认开始当前供应商的网关授权流程' }));
  fireEvent.click(screen.getByRole('button', { name: '开始网关授权' }));
  const link = await screen.findByRole('link', { name: '打开此连接的网关授权链接 ↗' });
  expect(link.getAttribute('href')).toContain('state=private');
  expect(calls.find((call) => call.method === 'account/gatewayOAuth/handoff')!.params).toEqual({
    handoffId: 'handoff',
  });
  expect(JSON.stringify(localStorage)).not.toContain('state=private');
  view.rerender(<AccountToolsPanel {...base} api={api} events={events} connected={false} />);
  await waitFor(() =>
    expect(screen.queryByRole('link', { name: '打开此连接的网关授权链接 ↗' })).toBeNull(),
  );
});

it('a closed native authorization epoch requires restart instead of starting another handoff', async () => {
  const { api, calls } = routed((call) =>
    call.method === 'account/gatewayOAuth/read'
      ? { ...gateway, restartRequired: true }
      : route(call),
  );
  render(<AccountToolsPanel {...base} api={api} events={new Events()} />);
  fireEvent.click(screen.getByText('供应商网关 OAuth', { selector: 'summary' }));
  await screen.findByText(/请先在服务设置中重启原生服务/);
  fireEvent.click(screen.getByRole('checkbox', { name: '确认开始当前供应商的网关授权流程' }));
  expect((screen.getByRole('button', { name: '开始网关授权' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByText('执行服务器的原生身份验证能力', { selector: 'summary' }));
  await screen.findByText(/This host has no verification provider/);
  expect(calls.some((call) => call.method === 'account/gatewayOAuth/login')).toBe(false);
  expect(calls.some((call) => /userVerification\/(enroll|verify)/.test(call.method))).toBe(false);
});
