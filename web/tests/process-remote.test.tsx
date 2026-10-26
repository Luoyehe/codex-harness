// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api, RpcError } from '../lib/api';
import { Events } from '../lib/events';
import { ProcessPanel } from '../components/ProcessPanel';
import { RemoteSettings } from '../components/RemoteSettings';
const project = { id: 'project', name: 'Project', cwd: '/project' };
type Call = { method: string; params: Record<string, unknown>; operationId?: string };
function routed(handler: (call: Call, signal?: AbortSignal | null) => unknown) {
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
        json: async () => {
          try {
            return { ok: true, result: await handler(call, init.signal) };
          } catch (error) {
            if (error instanceof RpcError)
              return {
                ok: false,
                error: { message: error.message, code: error.code, delivery: error.delivery },
              };
            throw error;
          }
        },
      };
    }),
  );
  return { api, calls };
}
const base = () => ({
  project,
  epoch: 'epoch',
  connectionId: 'connection',
  connected: true,
  enabled: true,
  events: new Events(),
  onChanged: vi.fn(),
});
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const process = {
  processHandle: 'handle',
  cwd: project.cwd,
  tty: false,
  status: 'running',
  timedOut: false,
  stdoutCapReached: false,
  stderrCapReached: false,
};
function processRoute(call: Call) {
  if (call.method === 'process/list') return { data: [process] };
  if (call.method === 'process/read')
    return { ...process, stdoutBase64: btoa('hello'), stderrBase64: '' };
  if (call.method === 'process/spawn')
    return { processHandle: 'handle', cwd: project.cwd, tty: false };
  return {};
}
const interactiveProcesses = [
  { ...process, tty: true },
  { ...process, tty: true, processHandle: 'other' },
];
function interactiveRoute(call: Call) {
  if (call.method === 'process/list') return { data: interactiveProcesses };
  if (call.method === 'process/read')
    return {
      ...interactiveProcesses.find((item) => item.processHandle === call.params.processHandle),
      stdoutBase64: '',
      stderrBase64: '',
    };
  return {};
}
function delayedWrite() {
  let resolve!: (value: Record<string, unknown>) => void;
  const promise = new Promise<Record<string, unknown>>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function selectProcessInput(handle = 'handle') {
  const select = screen.getByRole('combobox', { name: '当前连接的进程' }) as HTMLSelectElement;
  await waitFor(() =>
    expect(Array.from(select.options).some((option) => option.value === handle)).toBe(true),
  );
  fireEvent.change(select, { target: { value: handle } });
  return (await screen.findByRole('textbox', { name: '发送给进程的输入' })) as HTMLTextAreaElement;
}
it.each([
  { button: '发送 Ctrl+C', params: { deltaBase64: 'Aw==' }, notice: '输入已确认发送。' },
  { button: '关闭输入流', params: { closeStdin: true }, notice: '进程输入流已关闭。' },
])('preserves unsent stdin when $button succeeds', async ({ button, params, notice }) => {
  const { api, calls } = routed(interactiveRoute);
  render(<ProcessPanel {...base()} api={api} />);
  const input = await selectProcessInput();
  fireEvent.change(input, { target: { value: 'unsent human draft' } });
  fireEvent.click(screen.getByRole('button', { name: button }));
  await screen.findByText(notice);
  expect(input.value).toBe('unsent human draft');
  const writes = calls.filter((call) => call.method === 'process/writeStdin');
  expect(writes).toHaveLength(1);
  expect(writes[0]!.params).toEqual({ processHandle: 'handle', ...params });
  expect(writes[0]!.operationId).toBeTruthy();
});
it('clears an unchanged accepted stdin submission and sends it only once', async () => {
  const pending = delayedWrite(),
    { api, calls } = routed((call) =>
      call.method === 'process/writeStdin' ? pending.promise : interactiveRoute(call),
    );
  render(<ProcessPanel {...base()} api={api} />);
  const input = await selectProcessInput();
  fireEvent.change(input, { target: { value: 'A' } });
  const send = screen.getByRole('button', { name: '发送输入' });
  fireEvent.click(send);
  fireEvent.click(send);
  expect(input.value).toBe('A');
  await act(async () => pending.resolve({}));
  expect(input.value).toBe('');
  const writes = calls.filter((call) => call.method === 'process/writeStdin');
  expect(writes).toHaveLength(1);
  expect(writes[0]!.params).toEqual({ processHandle: 'handle', deltaBase64: btoa('A\n') });
});
it.each(['B', 'A'])(
  'preserves draft revision after pending send and A to B to %s edits',
  async (finalText) => {
    const pending = delayedWrite(),
      { api, calls } = routed((call) =>
        call.method === 'process/writeStdin' ? pending.promise : interactiveRoute(call),
      );
    render(<ProcessPanel {...base()} api={api} />);
    const input = await selectProcessInput();
    fireEvent.change(input, { target: { value: 'A' } });
    fireEvent.click(screen.getByRole('button', { name: '发送输入' }));
    fireEvent.change(input, { target: { value: 'B' } });
    if (finalText === 'A') fireEvent.change(input, { target: { value: 'A' } });
    await act(async () => pending.resolve({}));
    expect(input.value).toBe(finalText);
    expect(calls.filter((call) => call.method === 'process/writeStdin')).toHaveLength(1);
  },
);
it.each(['other', 'handle'])(
  'preserves new %s process draft after changing selection during pending send',
  async (finalProcess) => {
    const pending = delayedWrite(),
      { api, calls } = routed((call) =>
        call.method === 'process/writeStdin' ? pending.promise : interactiveRoute(call),
      );
    render(<ProcessPanel {...base()} api={api} />);
    const input = await selectProcessInput();
    fireEvent.change(input, { target: { value: 'A' } });
    fireEvent.click(screen.getByRole('button', { name: '发送输入' }));
    let next = await selectProcessInput('other');
    if (finalProcess === 'handle') next = await selectProcessInput('handle');
    fireEvent.change(next, { target: { value: 'A' } });
    await act(async () => pending.resolve({}));
    expect(next.value).toBe('A');
    const writes = calls.filter((call) => call.method === 'process/writeStdin');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.params.processHandle).toBe('handle');
  },
);
it.each(['not_sent', 'unknown'])(
  'retains stdin after %s and reads the original receipt without replay',
  async (delivery) => {
    let operationId = '';
    const { api, calls } = routed((call) => {
      if (call.method === 'process/writeStdin') {
        operationId = call.operationId!;
        if (delivery === 'not_sent')
          throw new RpcError('write rejected', 'invalid_params', 'not_sent');
        throw new Error('transport lost');
      }
      if (call.method === 'operation/read')
        return { operationId, method: 'process/writeStdin', state: 'accepted', result: {} };
      return interactiveRoute(call);
    });
    render(<ProcessPanel {...base()} api={api} />);
    const input = await selectProcessInput();
    fireEvent.change(input, { target: { value: 'A' } });
    fireEvent.click(screen.getByRole('button', { name: '发送输入' }));
    await screen.findByText(delivery === 'not_sent' ? 'write rejected' : 'transport lost');
    expect(input.value).toBe('A');
    if (delivery === 'unknown') {
      fireEvent.click(screen.getByRole('button', { name: '查询原进程控制回执' }));
      await waitFor(() =>
        expect(calls.some((call) => call.method === 'operation/read')).toBe(true),
      );
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: '查询原进程控制回执' })).toBeNull(),
      );
    }
    expect(input.value).toBe('A');
    expect(calls.filter((call) => call.method === 'process/writeStdin')).toHaveLength(1);
  },
);
it.each(['epoch', 'connection', 'disconnect', 'unmount'])(
  'isolates a pending stdin response across %s changes',
  async (transition) => {
    const pending = delayedWrite(),
      props = base(),
      { api, calls } = routed((call) =>
        call.method === 'process/writeStdin' ? pending.promise : interactiveRoute(call),
      );
    const view = render(<ProcessPanel {...props} api={api} />);
    const input = await selectProcessInput();
    fireEvent.change(input, { target: { value: 'A' } });
    fireEvent.click(screen.getByRole('button', { name: '发送输入' }));
    if (transition === 'unmount') {
      view.unmount();
      render(<ProcessPanel {...props} api={api} />);
    } else if (transition === 'disconnect') {
      view.rerender(<ProcessPanel {...props} api={api} connected={false} />);
      view.rerender(<ProcessPanel {...props} api={api} />);
    } else
      view.rerender(
        <ProcessPanel
          {...props}
          api={api}
          {...(transition === 'epoch'
            ? { epoch: 'next-epoch' }
            : { connectionId: 'next-connection' })}
        />,
      );
    const next = await selectProcessInput();
    fireEvent.change(next, { target: { value: 'A' } });
    await act(async () => pending.resolve({}));
    expect(next.value).toBe('A');
    expect(calls.filter((call) => call.method === 'process/writeStdin')).toHaveLength(1);
  },
);
it.each(['selection', 'edit', 'existing draft'])(
  'preserves the current input owner after delayed spawn and %s',
  async (change) => {
    const pending = delayedWrite(),
      started = { ...process, tty: true, processHandle: 'new-handle' };
    let ready = false;
    const { api, calls } = routed((call) => {
      if (call.method === 'process/spawn') return pending.promise;
      if (call.method === 'process/list')
        return { data: [...interactiveProcesses, ...(ready ? [started] : [])] };
      if (call.method === 'process/read' && call.params.processHandle === started.processHandle)
        return { ...started, stdoutBase64: '', stderrBase64: '' };
      return interactiveRoute(call);
    });
    render(<ProcessPanel {...base()} api={api} />);
    let input = await selectProcessInput();
    if (change === 'existing draft')
      fireEvent.change(input, { target: { value: 'keep with original process' } });
    fireEvent.click(screen.getByText('启动命令', { selector: 'summary' }));
    fireEvent.change(
      screen.getByRole('textbox', { name: '命令参数（每行一个，第一行是可执行文件）' }),
      { target: { value: 'fixture-program' } },
    );
    fireEvent.click(
      screen.getByRole('checkbox', { name: '确认以执行账号权限在此项目运行上述命令' }),
    );
    fireEvent.click(screen.getByRole('button', { name: '启动一次命令' }));
    if (change === 'selection') input = await selectProcessInput('other');
    if (change !== 'existing draft')
      fireEvent.change(input, { target: { value: 'keep with original process' } });
    ready = true;
    await act(async () => pending.resolve({ processHandle: started.processHandle }));
    expect(
      (screen.getByRole('combobox', { name: '当前连接的进程' }) as HTMLSelectElement).value,
    ).toBe(change === 'selection' ? 'other' : 'handle');
    expect(
      (screen.getByRole('textbox', { name: '发送给进程的输入' }) as HTMLTextAreaElement).value,
    ).toBe('keep with original process');
    expect(screen.getByText(/为保留当前选择或输入，未自动切换/)).toBeTruthy();
    expect(calls.filter((call) => call.method === 'process/spawn')).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'process/writeStdin')).toHaveLength(0);
  },
);
it('keeps a new process selection and draft when removing a previous exited process finishes', async () => {
  const pending = delayedWrite(),
    exited = { ...process, status: 'exited' };
  let removed = false;
  const { api, calls } = routed((call) => {
    if (call.method === 'process/remove') return pending.promise;
    if (call.method === 'process/list')
      return { data: [...(removed ? [] : [exited]), interactiveProcesses[1]] };
    if (call.method === 'process/read' && call.params.processHandle === exited.processHandle)
      return { ...exited, stdoutBase64: '', stderrBase64: '' };
    return interactiveRoute(call);
  });
  render(<ProcessPanel {...base()} api={api} />);
  await screen.findByRole('option', { name: /handle/ });
  fireEvent.change(screen.getByRole('combobox', { name: '当前连接的进程' }), {
    target: { value: 'handle' },
  });
  fireEvent.click(await screen.findByRole('button', { name: '移除已退出进程的输出' }));
  const input = await selectProcessInput('other');
  fireEvent.change(input, { target: { value: 'keep new input' } });
  removed = true;
  await act(async () => pending.resolve({}));
  expect(
    (screen.getByRole('combobox', { name: '当前连接的进程' }) as HTMLSelectElement).value,
  ).toBe('other');
  expect(
    (screen.getByRole('textbox', { name: '发送给进程的输入' }) as HTMLTextAreaElement).value,
  ).toBe('keep new input');
  expect(calls.filter((call) => call.method === 'process/remove')).toHaveLength(1);
});
it('starts an explicitly confirmed argv once, without a shell rewrite', async () => {
  const { api, calls } = routed(processRoute);
  render(<ProcessPanel {...base()} api={api} />);
  fireEvent.click(screen.getByText('启动命令', { selector: 'summary' }));
  fireEvent.change(
    screen.getByRole('textbox', { name: '命令参数（每行一个，第一行是可执行文件）' }),
    { target: { value: 'printf\n%s\n$(should-stay-literal)' } },
  );
  const start = screen.getByRole('button', { name: '启动一次命令' });
  expect((start as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: '确认以执行账号权限在此项目运行上述命令' }));
  fireEvent.click(start);
  fireEvent.click(start);
  await screen.findByText('hello');
  const spawns = calls.filter((call) => call.method === 'process/spawn');
  expect(spawns).toHaveLength(1);
  expect(spawns[0]!.params).toMatchObject({
    projectId: project.id,
    command: ['printf', '%s', '$(should-stay-literal)'],
    timeoutMs: 3600000,
  });
  expect(spawns[0]!.operationId).toBeTruthy();
});
it('refreshes authoritative output snapshots without duplicating event bytes and clears on disconnect', async () => {
  let text = '甲';
  const props = base(),
    { api } = routed((call) =>
      call.method === 'process/read'
        ? { ...process, stdoutBase64: Buffer.from(text).toString('base64'), stderrBase64: '' }
        : processRoute(call),
    );
  const view = render(<ProcessPanel {...props} api={api} />);
  await screen.findByRole('option', { name: /handle/ });
  fireEvent.change(screen.getByRole('combobox', { name: '当前连接的进程' }), {
    target: { value: 'handle' },
  });
  await screen.findByText('甲');
  text = '甲乙';
  act(() =>
    props.events.publish({
      type: 'process',
      data: {
        type: 'output',
        processHandle: 'handle',
        deltaBase64: Buffer.from('乙').toString('base64'),
      },
    }),
  );
  await screen.findByText('甲乙');
  expect(screen.queryByText('甲乙乙')).toBeNull();
  view.rerender(<ProcessPanel {...props} api={api} connected={false} />);
  await waitFor(() => expect(screen.queryByText('甲乙')).toBeNull());
});
it('unknown process start uses the original receipt and process list without re-running the command', async () => {
  let id = '';
  const { api, calls } = routed((call) => {
    if (call.method === 'process/spawn') {
      id = call.operationId!;
      throw new Error('transport lost');
    }
    if (call.method === 'operation/read')
      return {
        operationId: id,
        method: 'process/spawn',
        state: 'accepted',
        result: { processHandle: 'handle' },
      };
    return processRoute(call);
  });
  render(<ProcessPanel {...base()} api={api} />);
  fireEvent.click(screen.getByText('启动命令', { selector: 'summary' }));
  fireEvent.change(
    screen.getByRole('textbox', { name: '命令参数（每行一个，第一行是可执行文件）' }),
    { target: { value: 'echo\nhello' } },
  );
  fireEvent.click(screen.getByRole('checkbox', { name: '确认以执行账号权限在此项目运行上述命令' }));
  fireEvent.click(screen.getByRole('button', { name: '启动一次命令' }));
  fireEvent.click(await screen.findByRole('button', { name: '查询原启动回执' }));
  await waitFor(() => expect(calls.some((call) => call.method === 'operation/read')).toBe(true));
  expect(calls.filter((call) => call.method === 'process/spawn')).toHaveLength(1);
});
const status = {
  status: 'connected',
  serverName: 'fixture',
  installationId: 'install',
  environmentId: 'remote-env',
};
function remoteRoute(call: Call) {
  if (call.method === 'environment/list') return { data: [] };
  if (call.method === 'remoteControl/status/read') return status;
  if (call.method === 'remoteControl/client/list') return { data: [], nextCursor: null };
  return {};
}
it('environment registration clears its credential and never selects a session implicitly', async () => {
  const { api, calls } = routed((call) =>
    call.method === 'environment/add'
      ? { environmentId: 'executor', registered: true }
      : remoteRoute(call),
  );
  render(<RemoteSettings {...base()} api={api} />);
  fireEvent.click(screen.getByText('登记新的远端环境', { selector: 'summary' }));
  fireEvent.change(screen.getByRole('textbox', { name: '环境名称' }), {
    target: { value: 'Remote' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Exec-server WebSocket 地址' }), {
    target: { value: 'wss://executor.example/' },
  });
  const secret = screen.getByLabelText('Bearer token（按需填写，仅保留在本次运行内存）');
  fireEvent.change(secret, { target: { value: 'test-private-bearer' } });
  fireEvent.click(
    screen.getByRole('checkbox', {
      name: '确认连接此执行服务，并授权后续明确选中的会话在远端执行',
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: '确认登记远端' }));
  await waitFor(() => expect(calls.some((call) => call.method === 'environment/add')).toBe(true));
  expect((secret as HTMLInputElement).value).toBe('');
  expect(JSON.stringify(localStorage)).not.toContain('test-private-bearer');
  expect(calls.some((call) => /thread\/start|conversation\/start/.test(call.method))).toBe(false);
});
it('remote access defaults to ephemeral and requires explicit independent-channel authorization', async () => {
  const { api, calls } = routed((call) =>
    call.method === 'remoteControl/status/read'
      ? { ...status, status: 'disabled', environmentId: null }
      : remoteRoute(call),
  );
  render(<RemoteSettings {...base()} api={api} />);
  await screen.findByText('状态：disabled · fixture');
  const enable = screen.getByRole('button', { name: '启用原生远程控制' });
  expect((enable as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: '确认开放独立于网页登录的原生远程访问' }));
  fireEvent.click(enable);
  await waitFor(() =>
    expect(calls.some((call) => call.method === 'remoteControl/enable')).toBe(true),
  );
  expect(calls.find((call) => call.method === 'remoteControl/enable')!.params).toEqual({
    ephemeral: true,
    confirmExternalAccess: true,
  });
});
it('pairing secrets are owner reads, survive status refresh, never persist, and clear on disconnect', async () => {
  const pair = {
    pairingId: 'pair',
    environmentId: 'remote-env',
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    pairingCode: 'private-pair-code',
    manualPairingCode: null,
  };
  const { api, calls } = routed((call) =>
    call.method === 'remoteControl/pairing/start'
      ? { pairingId: pair.pairingId, environmentId: pair.environmentId, expiresAt: pair.expiresAt }
      : call.method === 'remoteControl/pairing/read'
        ? pair
        : remoteRoute(call),
  );
  const props = base(),
    view = render(<RemoteSettings {...props} api={api} />);
  await screen.findByText('状态：connected · fixture');
  fireEvent.click(screen.getByText('配对新的客户端', { selector: 'summary' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '确认创建用于授权新客户端的配对码' }));
  fireEvent.click(screen.getByRole('button', { name: '创建一次配对' }));
  await screen.findByDisplayValue(pair.pairingCode);
  fireEvent.click(screen.getByRole('button', { name: '刷新远程控制状态' }));
  await screen.findByText('状态：connected · fixture');
  expect(screen.getByDisplayValue(pair.pairingCode)).toBeTruthy();
  expect(JSON.stringify(localStorage)).not.toContain(pair.pairingCode);
  expect(calls.filter((call) => call.method === 'remoteControl/pairing/start')).toHaveLength(1);
  view.rerender(<RemoteSettings {...props} api={api} connected={false} />);
  await waitFor(() => expect(screen.queryByDisplayValue(pair.pairingCode)).toBeNull());
});
it('revocation targets only the explicitly selected current remote client', async () => {
  const { api, calls } = routed((call) =>
    call.method === 'remoteControl/client/list'
      ? {
          data: [
            {
              clientId: 'client',
              displayName: 'My tablet',
              platform: 'test',
              deviceType: 'tablet',
              lastSeenAt: null,
            },
          ],
          nextCursor: null,
        }
      : remoteRoute(call),
  );
  render(<RemoteSettings {...base()} api={api} />);
  const revoke = await screen.findByRole('button', { name: '撤销此客户端' });
  expect((revoke as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: '确认撤销此客户端' }));
  fireEvent.click(revoke);
  await waitFor(() =>
    expect(calls.some((call) => call.method === 'remoteControl/client/revoke')).toBe(true),
  );
  expect(calls.find((call) => call.method === 'remoteControl/client/revoke')!.params).toEqual({
    environmentId: 'remote-env',
    clientId: 'client',
  });
});

type PendingPairCheck = {
  signal?: AbortSignal | null;
  resolve: (value: { claimed: boolean }) => void;
  reject: (error: Error) => void;
};
async function pairingFixture(reusePairingId = false) {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  let environmentId = status.environmentId,
    sequence = 0;
  let pair = {
    pairingId: '',
    environmentId,
    pairingCode: '',
    manualPairingCode: null,
    expiresAt: 0,
  };
  const reads: PendingPairCheck[] = [];
  const { api, calls } = routed((call, signal) => {
    if (call.method === 'remoteControl/status/read') return { ...status, environmentId };
    if (call.method === 'remoteControl/pairing/start') {
      sequence++;
      pair = {
        ...pair,
        environmentId,
        pairingId: reusePairingId ? 'same-pair' : `pair-${sequence}`,
        pairingCode: `code-${sequence}`,
        expiresAt: Date.now() + (sequence === 1 ? 1000 : 60000),
      };
      return { pairingId: pair.pairingId, environmentId, expiresAt: pair.expiresAt };
    }
    if (call.method === 'remoteControl/pairing/read') return pair;
    // Deliberately ignore abort so late transport success and failure still arrive.
    if (call.method === 'remoteControl/pairing/status')
      return new Promise<{ claimed: boolean }>((resolve, reject) => {
        reads.push({ signal, resolve, reject });
      });
    return remoteRoute(call);
  });
  const props = base(),
    view = render(<RemoteSettings {...props} api={api} />);
  await act(async () => {});
  const create = async () => {
    const summary = screen.getByText('配对新的客户端', { selector: 'summary' });
    if (!(summary.parentElement as HTMLDetailsElement).open) fireEvent.click(summary);
    fireEvent.click(screen.getByRole('checkbox', { name: '确认创建用于授权新客户端的配对码' }));
    fireEvent.click(screen.getByRole('button', { name: '创建一次配对' }));
    await act(async () => {});
    expect(screen.getByDisplayValue(`code-${sequence}`)).toBeTruthy();
    return screen.getByRole('button', { name: '检查是否已配对' }) as HTMLButtonElement;
  };
  const check = async (button: HTMLButtonElement, repeatBeforeRender = false) => {
    const before = reads.length;
    act(() => {
      fireEvent.click(button);
      if (repeatBeforeRender) fireEvent.click(button);
    });
    await act(async () => {});
    expect(reads).toHaveLength(before + 1);
    expect(button.disabled).toBe(true);
    return reads[before]!;
  };
  const expire = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1001);
    });
    expect(screen.getByText('配对显示已到期。需要新配对时请重新确认。')).toBeTruthy();
  };
  const changeEnvironment = async (next: string) => {
    environmentId = next;
    fireEvent.click(screen.getByRole('button', { name: '刷新远程控制状态' }));
    await act(async () => {});
  };
  return { api, calls, reads, props, view, create, check, expire, changeEnvironment };
}
async function completeOldCheck(read: PendingPairCheck, outcome: string) {
  await act(async () => {
    if (outcome === 'success') read.resolve({ claimed: true });
    else read.reject(new Error('old pairing query failed'));
  });
}
const latePairingCases = ['success', 'failure'].flatMap((outcome) =>
  ['before new pair', 'after new pair', 'during new check'].map((timing) => ({ outcome, timing })),
);
it.each(latePairingCases)(
  'isolates an expired pairing query with late $outcome $timing',
  async ({ outcome, timing }) => {
    const fixture = await pairingFixture(true),
      first = await fixture.create(),
      old = await fixture.check(first);
    await fixture.expire();
    if (timing === 'before new pair') await completeOldCheck(old, outcome);
    const next = await fixture.create();
    expect(next.disabled).toBe(false);
    let current: PendingPairCheck | undefined;
    if (timing === 'during new check') current = await fixture.check(next);
    if (timing !== 'before new pair') await completeOldCheck(old, outcome);
    expect(screen.getByDisplayValue('code-2')).toBeTruthy();
    expect(screen.queryByText('old pairing query failed')).toBeNull();
    expect(screen.queryByText('客户端已领取此配对，请核对下方客户端列表。')).toBeNull();
    expect(next.disabled).toBe(timing === 'during new check');
    expect(old.signal?.aborted).toBe(true);
    current ??= await fixture.check(next);
    await act(async () => current!.resolve({ claimed: true }));
    expect(screen.queryByDisplayValue('code-2')).toBeNull();
    expect(screen.getByText('客户端已领取此配对，请核对下方客户端列表。')).toBeTruthy();
    expect(fixture.reads).toHaveLength(2);
  },
);
const changedPairingOwners = [
  'disconnect',
  'environment',
  'environment return',
  'connection',
  'epoch',
  'unmount',
];
it.each(
  changedPairingOwners.flatMap((transition) =>
    ['success', 'failure'].map((outcome) => ({ transition, outcome })),
  ),
)(
  'isolates late pairing $outcome across $transition and repeated identity values',
  async ({ transition, outcome }) => {
    const fixture = await pairingFixture(true),
      old = await fixture.check(await fixture.create());
    const { props, api, view } = fixture;
    if (transition === 'disconnect') {
      view.rerender(<RemoteSettings {...props} api={api} connected={false} />);
      view.rerender(<RemoteSettings {...props} api={api} />);
    } else if (transition.startsWith('environment')) {
      await fixture.changeEnvironment('other-environment');
      if (transition === 'environment return')
        await fixture.changeEnvironment(status.environmentId);
    } else if (transition === 'unmount') {
      view.unmount();
      render(<RemoteSettings {...props} api={api} />);
    } else
      view.rerender(
        <RemoteSettings
          {...props}
          api={api}
          {...(transition === 'epoch'
            ? { epoch: 'next-epoch' }
            : { connectionId: 'next-connection' })}
        />,
      );
    await act(async () => {});
    expect(screen.queryByDisplayValue('code-1')).toBeNull();
    const next = await fixture.create();
    expect(next.disabled).toBe(false);
    const current = await fixture.check(next);
    await completeOldCheck(old, outcome);
    expect(old.signal?.aborted).toBe(true);
    expect(next.disabled).toBe(true);
    expect(screen.getByDisplayValue('code-2')).toBeTruthy();
    expect(screen.queryByText('old pairing query failed')).toBeNull();
    expect(screen.queryByText('客户端已领取此配对，请核对下方客户端列表。')).toBeNull();
    await act(async () => current.resolve({ claimed: false }));
    expect(next.disabled).toBe(false);
    expect(screen.getByDisplayValue('code-2')).toBeTruthy();
    expect(fixture.reads).toHaveLength(2);
  },
);
it('releases only the current failed pairing check and permits a fresh check after an unclaimed response', async () => {
  const fixture = await pairingFixture(),
    button = await fixture.create(),
    first = await fixture.check(button);
  await act(async () => first.reject(new Error('current pairing query failed')));
  expect(screen.getByText('current pairing query failed')).toBeTruthy();
  expect(button.disabled).toBe(false);
  const second = await fixture.check(button);
  expect(screen.queryByText('current pairing query failed')).toBeNull();
  await act(async () => second.resolve({ claimed: false }));
  expect(button.disabled).toBe(false);
  const third = await fixture.check(button);
  await act(async () => third.resolve({ claimed: true }));
  expect(screen.queryByDisplayValue('code-1')).toBeNull();
  expect(screen.getByText('客户端已领取此配对，请核对下方客户端列表。')).toBeTruthy();
  expect(fixture.reads).toHaveLength(3);
});
it('dispatches one pairing status read for repeated clicks before the pending state renders', async () => {
  const fixture = await pairingFixture(),
    pending = await fixture.check(await fixture.create(), true);
  await act(async () => pending.resolve({ claimed: false }));
  expect(fixture.reads).toHaveLength(1);
});
