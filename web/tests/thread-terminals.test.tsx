// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { Events } from '../lib/events';
import { ThreadTerminals } from '../components/ThreadTerminals';
import { listOperations } from '../lib/operations';
const row = {
  itemId: 'item',
  processId: 'native-process',
  command: 'long running task',
  cwd: '/project',
  osPid: 456,
  cpuPercent: 2,
  rssKb: 1024,
};
type Call = { method: string; params: Record<string, unknown>; operationId?: string };
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
        (c.method === 'thread/backgroundTerminals/list' ? { data: [row], nextCursor: null } : {});
      return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
    }),
  );
  return { api, events, calls };
}
const props = (s: ReturnType<typeof setup>) => ({
  api: s.api,
  events: s.events,
  epoch: 'epoch',
  threadId: 'thread',
  enabled: true,
  connected: true,
  idle: true,
  onChanged: vi.fn(),
  onLocate: vi.fn(),
  onChat: vi.fn(),
});
const ready = () => screen.findByText('long running task');
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('lists native process identities and terminates only a discovered ID in the same thread', async () => {
  const s = setup((c) =>
      c.method === 'thread/backgroundTerminals/terminate'
        ? { threadId: 'thread', processId: row.processId, terminated: false }
        : undefined,
    ),
    locate = vi.fn();
  render(<ThreadTerminals {...props(s)} onLocate={locate} />);
  await ready();
  expect(s.calls[0]?.params).toEqual({ threadId: 'thread', limit: 50 });
  fireEvent.click(screen.getByRole('button', { name: '定位命令历史' }));
  expect(locate).toHaveBeenCalledWith('item');
  expect(
    (screen.getByRole('button', { name: '终止此后台进程' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: '确认终止这个原生后台进程' }));
  fireEvent.click(screen.getByRole('button', { name: '终止此后台进程' }));
  await screen.findByText(/原生服务未报告终止成功/);
  expect(s.calls.find((c) => c.method === 'thread/backgroundTerminals/terminate')?.params).toEqual({
    threadId: 'thread',
    processId: 'native-process',
  });
  expect(s.calls.some((c) => ['terminal/close', 'process/kill'].includes(c.method))).toBe(false);
});
it('requires full page review and explicit whole-thread cleanup consent without claiming OS proof', async () => {
  const s = setup((c) =>
    c.method === 'thread/backgroundTerminals/list'
      ? c.params.cursor
        ? { data: [{ ...row, processId: 'second', itemId: 'other' }], nextCursor: null }
        : { data: [row], nextCursor: 'next' }
      : undefined,
  );
  render(<ThreadTerminals {...props(s)} />);
  await ready();
  fireEvent.click(screen.getByText('清理这个会话的所有原生后台终端', { selector: 'summary' }));
  const consent = screen.getByRole('checkbox', {
    name: '确认清理当前会话的所有原生后台终端',
  }) as HTMLInputElement;
  const clean = screen.getByRole('button', { name: '清理所有原生后台终端' }) as HTMLButtonElement;
  expect(consent.disabled).toBe(true);
  fireEvent.click(consent);
  expect(consent.checked).toBe(false);
  expect(clean.disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '加载更多后台进程' }));
  await screen.findByText('原生进程 second');
  expect(
    s.calls.filter((c) => c.method === 'thread/backgroundTerminals/list')[1]?.params.cursor,
  ).toBe('next');
  expect(consent.disabled).toBe(false);
  expect(consent.checked).toBe(false);
  expect(clean.disabled).toBe(true);
  fireEvent.click(consent);
  expect(clean.disabled).toBe(false);
  fireEvent.click(clean);
  await screen.findByText(/清理请求已受理，正在重新读取；不代表所有进程已清理完成/);
  expect(s.calls.find((c) => c.method === 'thread/backgroundTerminals/clean')?.params).toEqual({
    threadId: 'thread',
    confirm: true,
  });
});
it('submits an explicitly unsandboxed shell once and preserves newer edits while awaiting acceptance', async () => {
  let finish!: (v: unknown) => void;
  const s = setup((c) =>
    c.method === 'thread/shellCommand'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : undefined,
  );
  render(<ThreadTerminals {...props(s)} />);
  await ready();
  fireEvent.click(screen.getByText('在当前会话运行一次 shell 命令', { selector: 'summary' }));
  fireEvent.change(screen.getByRole('textbox', { name: '会话 shell 命令' }), {
    target: { value: 'echo first' },
  });
  expect(
    (screen.getByRole('button', { name: '执行此会话 shell 命令' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: /确认以原生完整权限/ }));
  fireEvent.click(screen.getByRole('button', { name: '执行此会话 shell 命令' }));
  fireEvent.change(screen.getByRole('textbox', { name: '会话 shell 命令' }), {
    target: { value: 'echo later' },
  });
  await act(async () => finish({ threadId: 'thread', submitted: true }));
  await screen.findByText(/命令已受理，尚不代表执行完成/);
  expect(s.calls.find((c) => c.method === 'thread/shellCommand')?.params).toEqual({
    threadId: 'thread',
    command: 'echo first',
    timeoutMs: 3600000,
    confirmUnsandboxed: true,
  });
  expect(
    (screen.getByRole('textbox', { name: '会话 shell 命令' }) as HTMLTextAreaElement).value,
  ).toBe('echo later');
  expect(s.calls.filter((c) => c.operationId)).toHaveLength(1);
});
it('recovers an unknown shell via its original operation and never resends it', async () => {
  let id = '';
  const s = setup((c) => {
    if (c.method === 'thread/shellCommand') {
      id = c.operationId!;
      throw new Error('response lost');
    }
    if (c.method === 'operation/read')
      return {
        operationId: id,
        method: 'thread/shellCommand',
        state: 'accepted',
        result: { threadId: 'thread', submitted: true },
      };
  });
  render(<ThreadTerminals {...props(s)} />);
  await ready();
  fireEvent.click(screen.getByText('在当前会话运行一次 shell 命令', { selector: 'summary' }));
  fireEvent.change(screen.getByRole('textbox', { name: '会话 shell 命令' }), {
    target: { value: 'echo once' },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: /确认以原生完整权限/ }));
  fireEvent.click(screen.getByRole('button', { name: '执行此会话 shell 命令' }));
  fireEvent.click(await screen.findByRole('button', { name: '查询原会话终端操作回执' }));
  await waitFor(() => expect(listOperations().find((op) => op.id === id)?.state).toBe('accepted'));
  expect(s.calls.filter((c) => c.method === 'thread/shellCommand')).toHaveLength(1);
});
it('blocks malformed directory controls and new shell submission while active or history is not ready', async () => {
  const s = setup((c) =>
    c.method === 'thread/backgroundTerminals/list'
      ? { data: [{ ...row, processId: '' }], nextCursor: null }
      : undefined,
  );
  render(<ThreadTerminals {...props(s)} enabled={false} idle={false} />);
  await screen.findByText(/原生后台终端目录无效/);
  expect(screen.queryByRole('button', { name: '终止此后台进程' })).toBeNull();
  fireEvent.click(screen.getByText('在当前会话运行一次 shell 命令', { selector: 'summary' }));
  fireEvent.change(screen.getByRole('textbox', { name: '会话 shell 命令' }), {
    target: { value: 'echo no' },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: /确认以原生完整权限/ }));
  expect(
    (screen.getByRole('button', { name: '执行此会话 shell 命令' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(s.calls.some((c) => c.operationId)).toBe(false);
});
it('refreshes after native command completion and discards prior termination consent', async () => {
  const s = setup();
  render(<ThreadTerminals {...props(s)} />);
  await ready();
  fireEvent.click(screen.getByRole('checkbox', { name: '确认终止这个原生后台进程' }));
  act(() =>
    s.events.publish({
      type: 'notification',
      data: { method: 'item/completed', params: { threadId: 'thread' } },
    }),
  );
  await waitFor(() =>
    expect(s.calls.filter((c) => c.method === 'thread/backgroundTerminals/list')).toHaveLength(2),
  );
  await ready();
  expect(
    (screen.getByRole('checkbox', { name: '确认终止这个原生后台进程' }) as HTMLInputElement)
      .checked,
  ).toBe(false);
});

function shellDraft() {
  fireEvent.click(screen.getByText('在当前会话运行一次 shell 命令', { selector: 'summary' }));
  const input = screen.getByRole('textbox', { name: '会话 shell 命令' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'echo repeat' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /确认以原生完整权限/ }));
  fireEvent.click(screen.getByRole('button', { name: '执行此会话 shell 命令' }));
  return input;
}
it.each(['accepted', 'failure'] as const)(
  'preserves an A-to-B-to-A shell draft after an earlier request is %s',
  async (outcome) => {
    let finish!: (value: unknown) => void, fail!: (error: Error) => void;
    const s = setup((call) =>
      call.method === 'thread/shellCommand'
        ? new Promise((resolve, reject) => {
            finish = resolve;
            fail = reject;
          })
        : undefined,
    );
    render(<ThreadTerminals {...props(s)} />);
    await ready();
    const input = shellDraft();
    fireEvent.change(input, { target: { value: 'echo changed' } });
    fireEvent.change(input, { target: { value: 'echo repeat' } });
    await act(async () =>
      outcome === 'accepted' ? finish({ submitted: true }) : fail(new Error('response lost')),
    );
    expect(input.value).toBe('echo repeat');
    expect(s.calls.filter((call) => call.method === 'thread/shellCommand')).toHaveLength(1);
    expect(
      (screen.getByRole('checkbox', { name: /确认以原生完整权限/ }) as HTMLInputElement).checked,
    ).toBe(false);
    if (outcome === 'failure')
      expect(screen.getByRole('button', { name: '查询原会话终端操作回执' })).toBeTruthy();
  },
);
it.each(['thread', 'epoch', 'connection'] as const)(
  'ignores an old shell acknowledgement after the %s scope changes away and back',
  async (field) => {
    let finish!: (value: unknown) => void;
    const s = setup((call) =>
        call.method === 'thread/shellCommand'
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : undefined,
      ),
      initial = props(s);
    const view = render(<ThreadTerminals {...initial} />);
    await ready();
    shellDraft();
    view.rerender(
      <ThreadTerminals
        {...initial}
        {...(field === 'thread'
          ? { threadId: 'other' }
          : field === 'epoch'
            ? { epoch: 'other' }
            : { connected: false })}
      />,
    );
    view.rerender(<ThreadTerminals {...initial} />);
    const input = screen.getByRole('textbox', { name: '会话 shell 命令' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'new scope draft' } });
    await act(async () => finish({ submitted: true }));
    expect(input.value).toBe('new scope draft');
    expect(initial.onChanged).not.toHaveBeenCalled();
    expect(screen.queryByText(/命令已受理，尚不代表执行完成/)).toBeNull();
    expect(s.calls.filter((call) => call.method === 'thread/shellCommand')).toHaveLength(1);
    // Non-input success is acknowledged by Api, even when its old UI owner has gone.
    expect(listOperations()).toHaveLength(0);
  },
);
it('invalidates whole-thread cleanup consent immediately on refresh and keeps confirmation disabled during the read', async () => {
  let finish!: (value: unknown) => void,
    reads = 0;
  const s = setup((call) =>
    call.method === 'thread/backgroundTerminals/list' && ++reads > 1
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : undefined,
  );
  render(<ThreadTerminals {...props(s)} />);
  await ready();
  fireEvent.click(screen.getByText('清理这个会话的所有原生后台终端', { selector: 'summary' }));
  const consent = screen.getByRole('checkbox', {
    name: '确认清理当前会话的所有原生后台终端',
  }) as HTMLInputElement;
  fireEvent.click(consent);
  expect(consent.checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '刷新后台进程' }));
  expect(consent.checked).toBe(false);
  expect(consent.disabled).toBe(true);
  await act(async () =>
    finish({ data: [{ ...row, command: 'replacement process' }], nextCursor: null }),
  );
  expect(consent.checked).toBe(false);
  expect(
    (screen.getByRole('button', { name: '清理所有原生后台终端' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(s.calls.some((call) => call.method === 'thread/backgroundTerminals/clean')).toBe(false);
});
it('requires new row confirmation when another page replaces the same displayed process object', async () => {
  const s = setup((call) =>
    call.method === 'thread/backgroundTerminals/list'
      ? call.params.cursor
        ? {
            data: [{ ...row }, { ...row, processId: 'second', itemId: 'second' }],
            nextCursor: null,
          }
        : { data: [{ ...row }], nextCursor: 'next' }
      : undefined,
  );
  render(<ThreadTerminals {...props(s)} />);
  await ready();
  fireEvent.click(screen.getByRole('checkbox', { name: '确认终止这个原生后台进程' }));
  fireEvent.click(screen.getByRole('button', { name: '加载更多后台进程' }));
  await screen.findByText('原生进程 second');
  expect(
    screen
      .getAllByRole('checkbox', { name: '确认终止这个原生后台进程' })
      .every((input) => !(input as HTMLInputElement).checked),
  ).toBe(true);
  expect(
    screen
      .getAllByRole('button', { name: '终止此后台进程' })
      .every((button) => (button as HTMLButtonElement).disabled),
  ).toBe(true);
  expect(s.calls.some((call) => call.method === 'thread/backgroundTerminals/terminate')).toBe(
    false,
  );
});
it.each(['accepted', 'failed'] as const)(
  'keeps an old recovery query %s outcome from changing the replacement UI owner',
  async (outcome) => {
    let operationId = '',
      finish!: (value: unknown) => void,
      fail!: (error: Error) => void;
    const s = setup((call) => {
        if (call.method === 'thread/shellCommand') {
          operationId = call.operationId!;
          throw new Error('response lost');
        }
        if (call.method === 'operation/read')
          return new Promise((resolve, reject) => {
            finish = resolve;
            fail = reject;
          });
        return undefined;
      }),
      initial = props(s);
    const view = render(<ThreadTerminals {...initial} />);
    await ready();
    shellDraft();
    fireEvent.click(await screen.findByRole('button', { name: '查询原会话终端操作回执' }));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    view.rerender(<ThreadTerminals {...initial} epoch="replacement" />);
    fireEvent.change(screen.getByRole('textbox', { name: '会话 shell 命令' }), {
      target: { value: 'replacement draft' },
    });
    await act(async () =>
      outcome === 'accepted'
        ? finish({
            operationId,
            method: 'thread/shellCommand',
            state: 'accepted',
            result: { threadId: 'thread', submitted: true },
          })
        : fail(new Error('old recovery failure')),
    );
    expect(listOperations().find((operation) => operation.id === operationId)?.state).toBe(
      outcome === 'accepted' ? 'accepted' : 'unknown',
    );
    expect(initial.onChanged).not.toHaveBeenCalled();
    expect(
      (screen.getByRole('textbox', { name: '会话 shell 命令' }) as HTMLTextAreaElement).value,
    ).toBe('replacement draft');
    expect(screen.queryByText('old recovery failure')).toBeNull();
    expect(s.calls.filter((call) => call.method === 'thread/shellCommand')).toHaveLength(1);
  },
);
it('preserves the command when its next invocation timeout is edited before acknowledgement', async () => {
  let finish!: (value: unknown) => void;
  const s = setup((call) =>
    call.method === 'thread/shellCommand'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : undefined,
  );
  render(<ThreadTerminals {...props(s)} />);
  await ready();
  const input = shellDraft();
  fireEvent.change(screen.getByRole('spinbutton', { name: '最长运行时间（分钟，1–120）' }), {
    target: { value: '1' },
  });
  await act(async () => finish({ submitted: true }));
  expect(input.value).toBe('echo repeat');
  expect(
    (screen.getByRole('spinbutton', { name: '最长运行时间（分钟，1–120）' }) as HTMLInputElement)
      .value,
  ).toBe('1');
  expect(s.calls.find((call) => call.method === 'thread/shellCommand')?.params.timeoutMs).toBe(
    3600000,
  );
});
