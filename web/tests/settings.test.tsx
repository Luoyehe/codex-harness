// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Api } from '../lib/api';
import { Events } from '../lib/events';
import { Settings } from '../components/Settings';
import { AdminSettings } from '../components/AdminSettings';
afterEach(cleanup);
it('serializes initial status and logs through a shared queue across refresh and remount', async () => {
  const pending: (() => void)[] = [];
  let inflight = 0,
    maximum = 0;
  const call = vi.fn().mockImplementation(
    () =>
      new Promise((resolve) => {
        inflight++;
        maximum = Math.max(maximum, inflight);
        pending.push(() => {
          inflight--;
          resolve({ text: 'healthy' });
        });
      }),
  );
  const api = { call } as unknown as Api;
  const view = render(<AdminSettings api={api} epoch="one" />);
  await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
  expect(call.mock.calls[0]?.[0]).toBe('system/status');
  view.rerender(<AdminSettings api={api} epoch="two" />);
  await act(async () => pending.shift()!());
  await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
  expect(call.mock.calls[1]?.[0]).toBe('system/status');
  await act(async () => pending.shift()!());
  await waitFor(() => expect(call).toHaveBeenCalledTimes(3));
  expect(call.mock.calls[2]?.[0]).toBe('system/logs');
  await act(async () => pending.shift()!());
  expect(maximum).toBe(1);
});
it('uses the deployed manager logs contract and displays its text payload', async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const api = {
    call: vi.fn().mockImplementation(async (method, params) => {
      if (method === 'system/logs') {
        expect(params).toEqual({ service: 'gateway', lines: 100 });
        return { text: 'runtime healthy' };
      }
      return {};
    }),
  } as unknown as Api;
  render(
    <Settings
      api={api}
      epoch="a"
      events={new Events()}
      projects={[]}
      theme="system"
      onTheme={vi.fn()}
      onClose={vi.fn()}
      onChanged={vi.fn()}
      onProjectAction={vi.fn()}
      onLogout={vi.fn()}
      onOpenDraft={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '服务管理' }));
  await waitFor(() =>
    expect(api.call).toHaveBeenCalledWith('system/logs', { service: 'gateway', lines: 100 }, expect.any(AbortSignal)),
  );
  expect(await screen.findByText('runtime healthy')).toBeTruthy();
});
it('shows local TLS evidence without claiming public acceptance and selects certificate logs', async () => {
  const api = { call: vi.fn().mockImplementation(async (method, params) => method === 'system/status'
    ? { https: { configured: true, ready: true, certificate: { notAfter: '2027-01-01', daysRemaining: 8 }, renewal: { automatic: true } } }
    : { text: params.service === 'caddy' ? 'certificate renewal diagnostic' : 'gateway diagnostic' }) } as unknown as Api;
  render(<AdminSettings api={api} epoch="tls" />);
  expect(await screen.findByText('服务器上的 HTTPS 和实例身份验证通过。')).toBeTruthy();
  expect(screen.getByText(/此检查来自服务器本机/)).toBeTruthy();
  expect(screen.getByText(/证书将在两周内到期/)).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox', { name: '日志服务' }), { target: { value: 'caddy' } });
  expect(await screen.findByText('certificate renewal diagnostic')).toBeTruthy();
  expect(api.call).toHaveBeenCalledWith('system/logs', { service: 'caddy', lines: 100 }, expect.any(AbortSignal));
});
it('does not label unrecognized certificate configuration as manually managed', async () => {
  const api = { call: vi.fn().mockResolvedValue({ https: { configured: true, ready: false } }) } as unknown as Api;
  render(<AdminSettings api={api} epoch="invalid-tls" />);
  expect(await screen.findByText('证书管理方式尚未确认，请检查配置。')).toBeTruthy();
  expect(screen.queryByText('证书由管理员提供，需要自行更新。')).toBeNull();
});
it('requires explicit consent to terminate running work and restarts without a force parameter', async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  let finish!: () => void;
  const mutate = vi.fn().mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const api = { call: vi.fn().mockResolvedValue({}), mutate } as unknown as Api;
  render(
    <Settings
      api={api}
      epoch="a"
      events={new Events()}
      projects={[]}
      theme="system"
      onTheme={vi.fn()}
      onClose={vi.fn()}
      onChanged={vi.fn()}
      onProjectAction={vi.fn()}
      onLogout={vi.fn()}
      onOpenDraft={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '服务管理' }));
  expect(screen.getByText(/重启会终止本实例仍在运行的任务和终端/).textContent).toContain(
    '未知操作不会重放',
  );
  const consent = screen.getByRole('checkbox', {
    name: '我确认终止本实例运行中的任务和终端，并重启服务',
  }) as HTMLInputElement;
  const restart = screen.getByRole('button', { name: '终止任务并重启服务' }) as HTMLButtonElement;
  expect(restart.disabled).toBe(true);
  fireEvent.click(restart);
  expect(mutate).not.toHaveBeenCalled();
  fireEvent.click(consent);
  expect(restart.disabled).toBe(false);
  fireEvent.click(restart);
  expect(mutate.mock.calls).toEqual([['system/restart']]);
  expect(screen.getByRole('button', { name: '正在提交…' }).hasAttribute('disabled')).toBe(true);
  await act(async () => finish());
  expect(consent.checked).toBe(false);
  expect(
    (screen.getByRole('button', { name: '终止任务并重启服务' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
it('opens Hooks management for the selected registered project without launching or trusting from settings', async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const api = {
      call: vi
        .fn()
        .mockImplementation(async (method: string) =>
          method === 'skills/list' || method === 'hooks/list' ? { data: [] } : {},
        ),
      mutate: vi.fn(),
    } as unknown as Api,
    open = vi.fn();
  render(
    <Settings
      api={api}
      epoch="epoch"
      events={new Events()}
      projects={[
        { id: 'p', name: 'Project', cwd: '/p' },
        { id: 'q', name: 'Other', cwd: '/q' },
      ]}
      projectId="p"
      theme="system"
      onTheme={vi.fn()}
      onClose={vi.fn()}
      onChanged={vi.fn()}
      onProjectAction={vi.fn()}
      onLogout={vi.fn()}
      onOpenDraft={vi.fn()}
      onOpenNativeTerminal={open}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '扩展与配置' }));
  fireEvent.change(screen.getByRole('combobox', { name: '扩展与配置的项目范围' }), {
    target: { value: 'q' },
  });
  fireEvent.click(await screen.findByRole('button', { name: '打开原生 Hooks 管理终端' }));
  expect(open).toHaveBeenCalledWith('q');
  expect(api.mutate).not.toHaveBeenCalled();
  expect(api.call).not.toHaveBeenCalledWith('terminal/open', expect.anything());
});
