// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CreditNudge } from '../components/CreditNudge';
import { Api } from '../lib/api';
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
const preview = { previewHash: 'current', accountId: 'account' };
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('requires a new explicit confirmation when reason changes and shows cooldown without claiming delivery', async () => {
  const { api, calls } = routed((call) =>
    call.method === 'account/sendAddCreditsNudgeEmail' ? { status: 'cooldown_active' } : preview,
  );
  render(<CreditNudge api={api} enabled connected epoch="one" />);
  fireEvent.click(screen.getByText('通知工作区所有者补充额度', { selector: 'summary' }));
  await screen.findByRole('button', { name: '发送通知邮件' });
  const button = screen.getByRole('button', { name: '发送通知邮件' });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'usage_limit' } });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(button);
  fireEvent.click(button);
  await screen.findByText('处于发送冷却期，本次没有再次发送邮件。');
  const writes = calls.filter((call) => call.method === 'account/sendAddCreditsNudgeEmail');
  expect(writes).toHaveLength(1);
  expect(writes[0]!.params).toEqual({
    previewHash: 'current',
    creditType: 'usage_limit',
    confirm: true,
  });
});
it('uncertain email delivery queries its original receipt and never resends', async () => {
  let id = '';
  const { api, calls } = routed((call) => {
    if (call.method === 'account/sendAddCreditsNudgeEmail') {
      id = call.operationId!;
      throw new Error('lost');
    }
    if (call.method === 'operation/read')
      return {
        operationId: id,
        method: 'account/sendAddCreditsNudgeEmail',
        state: 'accepted',
        result: { status: 'sent' },
      };
    return preview;
  });
  render(<CreditNudge api={api} enabled connected epoch="one" />);
  fireEvent.click(screen.getByText('通知工作区所有者补充额度', { selector: 'summary' }));
  await screen.findByRole('button', { name: '发送通知邮件' });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: '发送通知邮件' }));
  fireEvent.click(await screen.findByRole('button', { name: '查询原通知邮件回执' }));
  await screen.findByText('原生服务已确认向当前工作区所有者发送邮件。');
  expect(calls.filter((call) => call.method === 'account/sendAddCreditsNudgeEmail')).toHaveLength(
    1,
  );
});
