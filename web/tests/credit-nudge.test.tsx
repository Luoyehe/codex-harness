// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
function pendingPreview() {
  let resolve!: (value: typeof preview) => void;
  const promise = new Promise<typeof preview>((done) => { resolve = done; });
  return { promise, resolve: () => resolve(preview) };
}
async function openReadyNudge(api: Api, calls: Call[], request: ReturnType<typeof pendingPreview>) {
  render(<CreditNudge api={api} enabled connected epoch="one" />);
  fireEvent.click(screen.getByText('通知工作区所有者补充额度', { selector: 'summary' }));
  const button = screen.getByRole('button', { name: '发送通知邮件' }) as HTMLButtonElement;
  const confirmation = screen.getByRole('checkbox') as HTMLInputElement;
  expect(screen.getByText('正在读取…')).toBeTruthy();
  expect(button.disabled).toBe(true);
  fireEvent.click(confirmation);
  fireEvent.click(button);
  expect(confirmation.checked).toBe(false);
  expect(calls.filter((call) => call.method === 'account/sendAddCreditsNudgeEmail')).toHaveLength(0);
  // The button exists before the account preview commits. Resolve that exact
  // read and flush its React update before granting the required confirmation.
  await act(async () => { request.resolve(); await request.promise; });
  expect(screen.queryByText('正在读取…')).toBeNull();
  expect(confirmation.checked).toBe(false);
  expect(button.disabled).toBe(true);
  return { button, confirmation };
}
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
  const request = pendingPreview();
  const { api, calls } = routed((call) =>
    call.method === 'account/sendAddCreditsNudgeEmail' ? { status: 'cooldown_active' } : request.promise,
  );
  const { button, confirmation } = await openReadyNudge(api, calls, request);
  fireEvent.click(confirmation);
  expect(button.disabled).toBe(false);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'usage_limit' } });
  expect(confirmation.checked).toBe(false);
  expect(button.disabled).toBe(true);
  fireEvent.click(confirmation);
  expect(button.disabled).toBe(false);
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
  const request = pendingPreview();
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
    return request.promise;
  });
  const { button, confirmation } = await openReadyNudge(api, calls, request);
  fireEvent.click(confirmation);
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  const recover = await screen.findByRole('button', { name: '查询原通知邮件回执' });
  expect(id).not.toBe('');
  expect(calls.filter((call) => call.method === 'account/sendAddCreditsNudgeEmail')).toHaveLength(1);
  expect(calls.filter((call) => call.method === 'operation/read')).toHaveLength(0);
  fireEvent.click(recover);
  await screen.findByText('原生服务已确认向当前工作区所有者发送邮件。');
  expect(calls.filter((call) => call.method === 'account/sendAddCreditsNudgeEmail')).toHaveLength(
    1,
  );
  const reads = calls.filter((call) => call.method === 'operation/read');
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.every((call) => call.params.operationId === id)).toBe(true);
});
