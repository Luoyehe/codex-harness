// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as operationStorage from '../lib/operations';
import { Api, RpcError, type TerminalRecovery } from '../lib/api';
import { listOperations, reconcileOperation } from '../lib/operations';
import { Events } from '../lib/events';
const terminalState = vi.hoisted(() => ({
  input: (_text: string) => {},
  output: [] as string[],
  proposal: undefined as { rows: number; cols: number } | undefined,
  grid: { rows: 24, cols: 80 },
  resized: () => {},
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    rows = 24;
    cols = 80;
    loadAddon() {}
    open() {}
    clear() {}
    dispose() {}
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      terminalState.grid = { rows, cols };
    }
    write(data: Uint8Array) {
      terminalState.output.push(new TextDecoder().decode(data));
    }
    writeln(text: string) {
      terminalState.output.push(text);
    }
    focus() {}
    onData(fn: (text: string) => void) {
      terminalState.input = fn;
      return { dispose() {} };
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    proposeDimensions() {
      return terminalState.proposal;
    }
  },
}));
import { TerminalPanel } from '../components/TerminalPanel';
function terminalApi(backend: {
  mutate: (...args: unknown[]) => unknown;
  call: (...args: unknown[]) => unknown;
}): Api {
  return Object.assign(backend, {
    clientId: 'fixture-owner',
    openTerminal: (
      params: {
        projectId: string;
        rows: number;
        cols: number;
        program?: 'shell' | 'codex' | 'codex-cloud';
      },
      connectionId: string,
    ) => ({
      operation: {
        operationId: crypto.randomUUID(),
        clientId: 'fixture-owner',
        connectionId,
        projectId: params.projectId,
        ...(params.program ? { program: params.program } : {}),
      },
      result: backend.mutate('terminal/open', params),
    }),
  }) as unknown as Api;
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  terminalState.output = [];
  terminalState.proposal = undefined;
  terminalState.grid = { rows: 24, cols: 80 };
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        terminalState.resized = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('terminal ownership and bounded input', () => {
  it('keeps the rendered grid and native PTY within limits on open and resize', async () => {
    terminalState.proposal = { rows: 900, cols: 1200 };
    const api = terminalApi({
      mutate: vi.fn().mockResolvedValue({ terminalId: 't' }),
      call: vi.fn().mockResolvedValue({}),
    });
    render(<TerminalPanel api={api} events={new Events()} projectId="p" connected epoch="a" />);
    fireEvent.click(screen.getByRole('button', { name: '打开终端' }));
    await screen.findByRole('button', { name: '关闭终端' });
    expect(api.mutate).toHaveBeenCalledWith('terminal/open', {
      projectId: 'p',
      rows: 500,
      cols: 500,
    });
    expect(terminalState.grid).toEqual({ rows: 500, cols: 500 });
    terminalState.proposal = { rows: 30.7, cols: 10000 };
    act(() => terminalState.resized());
    await waitFor(() =>
      expect(api.call).toHaveBeenCalledWith('terminal/resize', {
        terminalId: 't',
        rows: 30,
        cols: 500,
      }),
    );
    expect(terminalState.grid).toEqual({ rows: 30, cols: 500 });
  });
  it('uses the valid existing grid when hidden or unmeasured dimensions are invalid', async () => {
    terminalState.proposal = { rows: NaN, cols: 0 };
    const api = terminalApi({
      mutate: vi.fn().mockResolvedValue({ terminalId: 't' }),
      call: vi.fn().mockResolvedValue({}),
    });
    render(<TerminalPanel api={api} events={new Events()} projectId="p" connected epoch="a" />);
    fireEvent.click(screen.getByRole('button', { name: '打开终端' }));
    await screen.findByRole('button', { name: '关闭终端' });
    expect(api.mutate).toHaveBeenCalledWith('terminal/open', {
      projectId: 'p',
      rows: 24,
      cols: 80,
    });
  });
  it('does not send a late terminal startup through a disconnected owner', async () => {
    let resolveOpen!: (v: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveOpen = resolve;
    });
    const api = terminalApi({
        mutate: vi.fn().mockReturnValue(pending),
        call: vi.fn().mockResolvedValue({}),
      }),
      events = new Events();
    const view = render(
      <TerminalPanel api={api} events={events} projectId="p" connected epoch="a" />,
    );
    fireEvent.click(screen.getByRole('button', { name: '打开终端' }));
    view.rerender(
      <TerminalPanel api={api} events={events} projectId="p" connected={false} epoch="a" />,
    );
    await act(async () => resolveOpen({ terminalId: 'late' }));
    expect(api.call).not.toHaveBeenCalledWith('terminal/close', { terminalId: 'late' });
    expect(screen.queryByRole('button', { name: '关闭终端' })).toBeNull();
  });
  it('does not enqueue an unbounded paste into a slow RPC transport', async () => {
    const api = terminalApi({
      mutate: vi.fn().mockResolvedValue({ terminalId: 't' }),
      call: vi.fn().mockResolvedValue({}),
    });
    render(<TerminalPanel api={api} events={new Events()} projectId="p" connected epoch="a" />);
    fireEvent.click(screen.getByRole('button', { name: '打开终端' }));
    await screen.findByRole('button', { name: '关闭终端' });
    act(() => terminalState.input('x'.repeat(65537)));
    expect(screen.getByRole('alert').textContent).toContain('64 KiB');
    expect(api.call).not.toHaveBeenCalledWith('terminal/write', expect.anything());
  });
  it('replays authenticated early output and exit in order before exposing the opened terminal', async () => {
    let finish!: (v: unknown) => void;
    const api = terminalApi({
        mutate: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        ),
        call: vi.fn().mockResolvedValue({}),
      }),
      events = new Events();
    render(<TerminalPanel api={api} events={events} projectId="p" connected epoch="a" />);
    fireEvent.click(screen.getByRole('button', { name: '打开终端' }));
    act(() => {
      events.publish({
        type: 'terminal',
        data: { terminalId: 'other', owned: true, type: 'output', deltaBase64: btoa('other') },
      });
      events.publish({
        type: 'terminal',
        data: { terminalId: 't', type: 'output', deltaBase64: btoa('unverified') },
      });
      events.publish({
        type: 'terminal',
        data: { terminalId: 't', owned: true, type: 'output', deltaBase64: btoa('hello') },
      });
      events.publish({
        type: 'terminal',
        data: { terminalId: 't', owned: true, type: 'exit', exitCode: 0 },
      });
    });
    await act(async () => finish({ terminalId: 't' }));
    expect(terminalState.output).toEqual(['hello', '\r\n[进程已退出：0]']);
    expect(screen.getByRole('button', { name: '打开新终端' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '关闭终端' })).toBeNull();
    act(() => terminalState.input('do not send'));
    expect(api.call).not.toHaveBeenCalledWith('terminal/write', expect.anything());
  });
  it('closes a startup whose bounded buffer overflowed instead of silently losing its output', async () => {
    let finish!: (v: unknown) => void;
    const api = terminalApi({
        mutate: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        ),
        call: vi.fn().mockResolvedValue({}),
      }),
      events = new Events();
    render(<TerminalPanel api={api} events={events} projectId="p" connected epoch="a" />);
    fireEvent.click(screen.getByRole('button', { name: '打开终端' }));
    act(() => {
      for (let i = 0; i < 129; i++)
        events.publish({
          type: 'terminal',
          data: { terminalId: 't', owned: true, type: 'output', deltaBase64: 'YQ==' },
        });
    });
    await act(async () => finish({ terminalId: 't' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('128'));
    await screen.findByRole('button', { name: '打开新终端' });
    expect(api.call).toHaveBeenCalledWith('terminal/close', { terminalId: 't' });
    expect(screen.queryByRole('button', { name: '关闭终端' })).toBeNull();
  });
  it('does not let a prior open or close response replace a later terminal attempt', async () => {
    const finish: ((v: unknown) => void)[] = [];
    let finishClose!: (v: unknown) => void;
    const api = terminalApi({
        mutate: vi.fn().mockImplementation(() => new Promise((resolve) => finish.push(resolve))),
        call: vi.fn().mockImplementation((method, params) =>
          method === 'terminal/close' && params.terminalId === 't1'
            ? new Promise((resolve) => {
                finishClose = resolve;
              })
            : Promise.resolve({}),
        ),
      }),
      events = new Events();
    const view = render(
      <TerminalPanel api={api} events={events} projectId="p" connected epoch="a" />,
    );
    fireEvent.click(screen.getByRole('button', { name: '打开终端' }));
    await act(async () => finish[0]!({ terminalId: 't1' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭终端' }));
    view.rerender(<TerminalPanel api={api} events={events} projectId="q" connected epoch="b" />);
    fireEvent.click(screen.getByRole('button', { name: '打开新终端' }));
    act(() =>
      events.publish({
        type: 'terminal',
        data: { terminalId: 't1', owned: true, type: 'exit', exitCode: 0 },
      }),
    );
    await act(async () => finish[1]!({ terminalId: 't2' }));
    await act(async () => finishClose({}));
    expect(screen.getByRole('button', { name: '关闭终端' })).toBeTruthy();
    expect(terminalState.output).toEqual([]);
    act(() => terminalState.input('ok'));
    await waitFor(() =>
      expect(api.call).toHaveBeenCalledWith('terminal/write', { terminalId: 't2', text: 'ok' }),
    );
  });
});

async function lostResponseFixture(program: 'shell' | 'codex' | 'codex-cloud' = 'shell') {
  const api = new Api(),
    events = new Events(),
    calls: { method: string; params: Record<string, unknown>; operationId?: string }[] = [];
  let rejectOpen!: (error: Error) => void,
    receipt: Record<string, unknown> = { state: 'pending' },
    rejectClose = false;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      calls.push(request);
      if (request.method === 'terminal/open')
        return new Promise((_resolve, reject) => {
          rejectOpen = reject;
        });
      if (request.method === 'terminal/close' && rejectClose)
        throw new TypeError('close response lost');
      const result =
        request.method === 'operation/read'
          ? { operationId: request.params.operationId, method: 'terminal/open', ...receipt }
          : {};
      return { status: 200, ok: true, json: async () => ({ ok: true, result }) };
    }),
  );
  const view = render(
    <TerminalPanel
      api={api}
      events={events}
      projectId="p"
      connected
      epoch="lease-a"
      program={program}
    />,
  );
  fireEvent.click(
    screen.getByRole('button', {
      name:
        program === 'codex-cloud'
          ? '打开官方云任务界面'
          : program === 'codex'
            ? '启动原生 CLI'
            : '打开终端',
    }),
  );
  await waitFor(() => expect(calls.some((call) => call.method === 'terminal/open')).toBe(true));
  return {
    api,
    events,
    calls,
    view,
    fail: async () => {
      await act(async () => rejectOpen(new TypeError('open response lost')));
      await waitFor(() => expect(screen.queryByText('正在确认终端启动…')).toBeNull());
    },
    proof: (value: Record<string, unknown>) => {
      receipt = value;
    },
    closeFailure: (value: boolean) => {
      rejectClose = value;
    },
  };
}
it('uses a positive WebSocket receipt after HTTP loss and preserves early output without a second open', async () => {
  const f = await lostResponseFixture();
  const operationId = f.calls[0]!.operationId!;
  await act(async () => {
    f.events.publish({
      type: 'terminal',
      data: {
        terminalId: 'accepted',
        owned: true,
        type: 'output',
        deltaBase64: btoa('early output'),
      },
    });
    (await reconcileOperation(operationId, {
      operationId,
      method: 'terminal/open',
      state: 'accepted',
      result: { terminalId: 'accepted', privateUnexpectedField: 'discard' },
    }));
  });
  expect((await listOperations())[0]?.terminalResult).toEqual({ terminalId: 'accepted' });
  await f.fail();
  expect(screen.getByRole('button', { name: '关闭终端' })).toBeTruthy();
  expect(terminalState.output).toEqual(['early output']);
  act(() => terminalState.input('whoami\n'));
  await waitFor(() =>
    expect(
      f.calls.some((c) => c.method === 'terminal/write' && c.params.terminalId === 'accepted'),
    ).toBe(true),
  );
  expect(f.calls.filter((c) => c.method === 'terminal/open')).toHaveLength(1);
  expect((await listOperations())).toEqual([]);
});
it('queries the original operation after a later acceptance and replays no creation request', async () => {
  const f = await lostResponseFixture();
  await f.fail();
  expect(screen.queryByRole('button', { name: '打开终端' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '查询并恢复终端' }));
  await screen.findByText('原终端操作仍待确认。查询不会重发创建请求，请稍后再次查询。');
  expect(screen.queryByRole('button', { name: '关闭终端' })).toBeNull();
  f.proof({ state: 'accepted', result: { terminalId: 'recovered' } });
  fireEvent.click(screen.getByRole('button', { name: '查询并恢复终端' }));
  await screen.findByRole('button', { name: '关闭终端' });
  expect(
    f.calls.filter((c) => c.method === 'operation/read').map((c) => c.params.operationId),
  ).toEqual([f.calls[0]!.operationId, f.calls[0]!.operationId]);
  expect(f.calls.filter((c) => c.method === 'terminal/open')).toHaveLength(1);
});
it('can explicitly close a recovered terminal and retain close controls if closure fails', async () => {
  const f = await lostResponseFixture();
  await f.fail();
  f.proof({ state: 'accepted', result: { terminalId: 'close-me' } });
  f.closeFailure(true);
  fireEvent.click(screen.getByRole('button', { name: '查询并关闭终端' }));
  await screen.findByText(/输入已暂停，请重试关闭/);
  expect(screen.getByRole('button', { name: '关闭终端' })).toBeTruthy();
  act(() => terminalState.input('never written'));
  expect(f.calls.filter((c) => c.method === 'terminal/write')).toEqual([]);
  f.closeFailure(false);
  fireEvent.click(screen.getByRole('button', { name: '关闭终端' }));
  await screen.findByRole('button', { name: '打开新终端' });
  expect(f.calls.filter((c) => c.method === 'terminal/close')).toHaveLength(2);
  expect(f.calls.filter((c) => c.method === 'terminal/open')).toHaveLength(1);
});
it('keeps an unresolved original-project attempt closeable without adopting it into the new project', async () => {
  const f = await lostResponseFixture();
  await f.fail();
  f.view.rerender(
    <TerminalPanel api={f.api} events={f.events} projectId="other" connected epoch="lease-a" />,
  );
  expect(screen.queryByRole('button', { name: '查询并恢复终端' })).toBeNull();
  expect(screen.queryByRole('button', { name: '打开终端' })).toBeNull();
  f.proof({ state: 'accepted', result: { terminalId: 'original-project' } });
  fireEvent.click(screen.getByRole('button', { name: '查询并关闭终端' }));
  await screen.findByRole('button', { name: '打开新终端' });
  expect(
    f.calls.filter((c) => c.method === 'terminal/close').map((c) => c.params.terminalId),
  ).toEqual(['original-project']);
  expect(terminalState.output).toEqual([]);
  expect(f.calls.filter((c) => c.method === 'terminal/open')).toHaveLength(1);
});
it('rejects a delayed recovery proof after a replacement connection and does not control the old terminal', async () => {
  const f = await lostResponseFixture();
  await f.fail();
  let finish!: (value: TerminalRecovery) => void;
  vi.spyOn(f.api, 'recoverTerminal').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByRole('button', { name: '查询并恢复终端' }));
  f.view.rerender(
    <TerminalPanel api={f.api} events={f.events} projectId="p" connected epoch="lease-b" />,
  );
  await act(async () => finish({ state: 'accepted', result: { terminalId: 'old-lease' } }));
  expect(screen.queryByRole('button', { name: '关闭终端' })).toBeNull();
  expect(
    f.calls.filter((c) => c.method === 'terminal/close' || c.method === 'terminal/write'),
  ).toEqual([]);
});
it('only permits a new open after a definitive not-sent recovery result', async () => {
  const f = await lostResponseFixture();
  await f.fail();
  f.proof({ state: 'not_sent' });
  fireEvent.click(screen.getByRole('button', { name: '查询并恢复终端' }));
  await screen.findByRole('button', { name: '打开终端' });
  expect((await listOperations())).toEqual([]);
  expect(f.calls.filter((c) => c.method === 'terminal/open')).toHaveLength(1);
});
it('requires an idle CLI launch and automatically reenables shell after the refreshed epoch arrives', async () => {
  const api = terminalApi({
      mutate: vi.fn().mockResolvedValue({ terminalId: 'cli' }),
      call: vi.fn().mockResolvedValue({}),
    }),
    events = new Events(),
    service = vi.fn(),
    shell = vi.fn();
  const view = render(
    <TerminalPanel
      api={api}
      events={events}
      projectId="p"
      connected
      epoch="lease"
      runtimeEpoch="runtime"
      program="codex"
      enabled={false}
      onServiceSettings={service}
      onShell={shell}
    />,
  );
  expect((screen.getByRole('button', { name: '启动原生 CLI' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(api.mutate).not.toHaveBeenCalled();
  view.rerender(
    <TerminalPanel
      api={api}
      events={events}
      projectId="p"
      connected
      epoch="lease"
      runtimeEpoch="runtime"
      program="codex"
      enabled
      onServiceSettings={service}
      onShell={shell}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '启动原生 CLI' }));
  await screen.findByRole('button', { name: '关闭终端' });
  expect(api.mutate).toHaveBeenCalledWith('terminal/open', {
    projectId: 'p',
    rows: 24,
    cols: 80,
    program: 'codex',
  });
  expect(
    (screen.getByRole('button', { name: '切换到项目 shell' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  act(() =>
    events.publish({
      type: 'terminal',
      data: { owned: true, terminalId: 'cli', type: 'exit', exitCode: 0 },
    }),
  );
  expect(await screen.findByText(/终端已结束，正在自动刷新后台环境/)).toBeTruthy();
  expect((screen.getByRole('button', { name: '启动原生 CLI' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByRole('button', { name: '前往服务管理' }));
  expect(service).toHaveBeenCalledOnce();
  expect(api.mutate).toHaveBeenCalledOnce();
  expect(
    (screen.getByRole('button', { name: '切换到项目 shell' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  view.rerender(
    <TerminalPanel
      api={api}
      events={events}
      projectId="p"
      connected
      epoch="new-lease"
      runtimeEpoch="new-runtime"
      program="codex"
      enabled
      onServiceSettings={service}
      onShell={shell}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '切换到项目 shell' }));
  expect(shell).toHaveBeenCalledOnce();
});
it('keeps unknown CLI creation recoverable under its original program and never repeats launch', async () => {
  const f = await lostResponseFixture('codex');
  expect(f.calls[0]?.params.program).toBe('codex');
  await f.fail();
  f.proof({ state: 'accepted', result: { terminalId: 'cli' } });
  fireEvent.click(screen.getByRole('button', { name: '查询并恢复终端' }));
  await screen.findByRole('button', { name: '关闭终端' });
  act(() => terminalState.input('/hooks\n'));
  await waitFor(() =>
    expect(f.calls.find((c) => c.method === 'terminal/write')?.params).toEqual({
      terminalId: 'cli',
      text: '/hooks\n',
    }),
  );
  expect(f.calls.filter((c) => c.method === 'terminal/open')).toHaveLength(1);
});
it('does not adopt an unresolved CLI startup after switching to shell mode', async () => {
  const f = await lostResponseFixture('codex');
  await f.fail();
  f.view.rerender(
    <TerminalPanel
      api={f.api}
      events={f.events}
      projectId="p"
      connected
      epoch="lease-a"
      program="shell"
    />,
  );
  expect(screen.queryByRole('button', { name: '查询并恢复终端' })).toBeNull();
  f.proof({ state: 'accepted', result: { terminalId: 'cli' } });
  fireEvent.click(screen.getByRole('button', { name: '查询并关闭终端' }));
  await screen.findByRole('button', { name: '打开新终端' });
  expect(
    f.calls.filter((c) => c.method === 'terminal/close').map((c) => c.params.terminalId),
  ).toEqual(['cli']);
  expect(f.calls.filter((c) => c.method === 'terminal/open')).toHaveLength(1);
  expect(screen.getByText(/终端已结束，正在自动刷新后台环境/)).toBeTruthy();
});

it('recovers the fixed cloud program once and waits for the automatic epoch refresh after close', async () => {
  const f = await lostResponseFixture('codex-cloud');
  expect(f.calls[0]?.params).toEqual({
    projectId: 'p',
    rows: 24,
    cols: 80,
    program: 'codex-cloud',
  });
  await f.fail();
  f.proof({ state: 'accepted', result: { terminalId: 'cloud' } });
  fireEvent.click(screen.getByRole('button', { name: '查询并恢复终端' }));
  await screen.findByRole('button', { name: '关闭终端' });
  expect(f.calls.filter((c) => c.method === 'terminal/open')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '关闭终端' }));
  await screen.findByText(/终端已结束，正在自动刷新后台环境/);
  expect(
    (screen.getByRole('button', { name: '打开官方云任务界面' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    f.calls.filter((c) => c.method === 'terminal/close').map((c) => c.params.terminalId),
  ).toEqual(['cloud']);
});

it('keeps a replacement terminal startup intact when an old failure finishes reading local recovery', async () => {
  let release!: (records: operationStorage.Operation[]) => void;
  const read = vi.spyOn(operationStorage, 'listOperations').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const mutate = vi.fn().mockRejectedValueOnce(new RpcError('old failure', 'rejected', 'not_sent'))
    .mockImplementationOnce(() => new Promise(() => {}));
  const api = terminalApi({ mutate, call: vi.fn().mockResolvedValue({}) }), events = new Events();
  const view = render(<TerminalPanel api={api} events={events} projectId="p" connected epoch="old" />);
  fireEvent.click(screen.getByRole('button', { name: '打开终端' }));
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  view.rerender(<TerminalPanel api={api} events={events} projectId="p" connected epoch="new" />);
  fireEvent.click(screen.getByRole('button', { name: '打开终端' }));
  expect(mutate).toHaveBeenCalledTimes(2);
  await act(async () => release([]));
  expect(screen.getByRole('button', { name: '查询并恢复终端' })).toHaveProperty('disabled', true);
  expect(screen.queryByText('old failure')).toBeNull();
});
