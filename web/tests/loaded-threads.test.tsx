// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { LoadedThreadsPanel } from '../components/LoadedThreadsPanel';
type Call = { method: string; params: Record<string, unknown>; operationId?: string };
function setup(handler: (call: Call) => unknown = () => undefined) {
  const calls: Call[] = [],
    api = new Api(),
    onOpenThread = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url, init) => {
      const c: Call = JSON.parse(init.body);
      calls.push(c);
      const result =
        (await handler(c)) ??
        (c.method === 'thread/loaded/list'
          ? { data: ['first'], nextCursor: null }
          : c.method === 'thread/read'
            ? {
                thread: {
                  id: c.params.threadId,
                  name: `Name ${c.params.threadId}`,
                  cwd: '/registered/project',
                  status: { type: 'idle' },
                },
              }
            : { status: 'unsubscribed' });
      return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
    }),
  );
  const view = render(
    <LoadedThreadsPanel
      api={api}
      epoch="epoch"
      connected
      enabled
      onChanged={vi.fn()}
      onOpenThread={onOpenThread}
      onClose={vi.fn()}
    />,
  );
  return { calls, onOpenThread, api, view };
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
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
it('discovers paginated ids and opens only the explicitly selected thread without resuming it', async () => {
  const s = setup((c) =>
    c.method === 'thread/loaded/list'
      ? c.params.cursor
        ? { data: ['second'], nextCursor: null }
        : { data: ['first'], nextCursor: 'next' }
      : undefined,
  );
  fireEvent.click(await screen.findByRole('button', { name: '加载更多已加载会话' }));
  fireEvent.click(await screen.findByRole('button', { name: 'second' }));
  await screen.findByText('Name second');
  fireEvent.click(screen.getByRole('button', { name: '打开此会话' }));
  expect(s.onOpenThread).toHaveBeenCalledWith('second');
  expect(s.calls.some((c) => c.method === 'thread/resume')).toBe(false);
  expect(s.calls.filter((c) => c.method === 'thread/read')).toHaveLength(1);
});
it('confirms an idle identity and reports unsubscribe without claiming process cleanup', async () => {
  const s = setup();
  fireEvent.click(await screen.findByRole('button', { name: 'first' }));
  const stop = await screen.findByRole('button', { name: '停止订阅所选会话' });
  expect((stop as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: /确认停止订阅此空闲会话/ }));
  fireEvent.click(stop);
  await screen.findByText(/已停止此连接的订阅；不保证原生进程已卸载/);
  expect(s.calls.find((c) => c.method === 'thread/unsubscribe')?.params).toEqual({
    threadId: 'first',
  });
  await waitFor(() =>
    expect(s.calls.filter((c) => c.method === 'thread/loaded/list').length).toBeGreaterThan(1),
  );
  expect(s.calls.some((c) => /thread\/(delete|resume)/.test(c.method))).toBe(false);
});
it('blocks an active thread and does not accept malformed directory identities', async () => {
  const s = setup((c) =>
    c.method === 'thread/read'
      ? { thread: { id: 'first', status: { type: 'active' } } }
      : undefined,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'first' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: /确认停止订阅此空闲会话/ }));
  expect(
    (screen.getByRole('button', { name: '停止订阅所选会话' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(s.calls.some((c) => c.method === 'thread/unsubscribe')).toBe(false);
  s.view.unmount();
  setup((c) =>
    c.method === 'thread/loaded/list' ? { data: [{ id: 'bad' }], nextCursor: null } : undefined,
  );
  await screen.findByText(/目录包含无效会话身份/);
  expect(screen.queryByRole('button', { name: '打开此会话' })).toBeNull();
});
it('recovers only the original unknown unsubscribe operation', async () => {
  let id = '';
  const s = setup((c) => {
    if (c.method === 'thread/unsubscribe') {
      id = c.operationId!;
      throw new Error('response lost');
    }
    if (c.method === 'operation/read')
      return { operationId: id, method: 'thread/unsubscribe', state: 'unknown' };
  });
  fireEvent.click(await screen.findByRole('button', { name: 'first' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: /确认停止订阅此空闲会话/ }));
  fireEvent.click(screen.getByRole('button', { name: '停止订阅所选会话' }));
  fireEvent.click(await screen.findByRole('button', { name: '查询原停止订阅回执' }));
  await waitFor(() => expect(s.calls.some((c) => c.method === 'operation/read')).toBe(true));
  expect(s.calls.filter((c) => c.method === 'thread/unsubscribe')).toHaveLength(1);
});
