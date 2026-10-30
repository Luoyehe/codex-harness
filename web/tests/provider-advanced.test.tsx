// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Api, RpcError } from '../lib/api';
import { ProviderSettings } from '../components/ProviderSettings';
import { listOperations } from '../lib/operations';

type Call = { method: string; params: Record<string, unknown>; operationId?: string };
const settleFixtures: (() => Promise<unknown>)[] = [];
function routed(handler: (call: Call) => unknown) {
  const calls: Call[] = [],
    api = new Api();
  const mutations = vi.spyOn(api, 'mutate');
  settleFixtures.push(() => Promise.allSettled(
    mutations.mock.results.filter((result) => result.type === 'return').map((result) => result.value),
  ));
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      const call = JSON.parse(String(init.body)) as Call;
      calls.push(call);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: await handler(call) }),
      };
    }),
  );
  return { calls, api };
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(async () => {
  await act(async () => {
    for (const settle of settleFixtures.splice(0)) await settle();
  });
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
test('gateway credential consent binds every displayed destination and keeps gateway configuration separate from API keys', async () => {
  const { calls, api } = routed(() => ({ revision: 'r', kind: 'chatgpt' }));
  render(<ProviderSettings api={api} epoch="one" onChanged={() => {}} />);
  await screen.findByRole('button', { name: '发现模型' });
  fireEvent.change(screen.getByLabelText('供应商'), { target: { value: 'chatgpt-gateway' } });
  for (const [label, value] of [
    ['网关 Codex Base URL', 'https://gateway.example/backend-api/codex'],
    ['OAuth 授权 URL', 'https://login.example/authorize'],
    ['OAuth Token URL', 'https://login.example/token'],
    ['OAuth 公共 Client ID', 'public'],
    ['网关认证 Cookie 名称', 'gateway-auth'],
    ['服务器回调端口（可选）', '43127'],
  ])
    fireEvent.change(screen.getByLabelText(label!), { target: { value } });
  const save = screen.getByRole('button', { name: '保存配置' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  const consent = screen.getByRole('checkbox', { name: /此网关会收到 ChatGPT 凭据/ });
  fireEvent.click(consent);
  expect(save.disabled).toBe(false);
  fireEvent.change(screen.getByLabelText('OAuth Token URL'), {
    target: { value: 'https://other.example/token' },
  });
  expect(save.disabled).toBe(true);
  fireEvent.click(consent);
  fireEvent.click(save);
  fireEvent.click(save);
  await waitFor(() =>
    expect(calls.filter((call) => call.method === 'system/provider/write')).toHaveLength(1),
  );
  const sent = calls.find((call) => call.method === 'system/provider/write')!;
  expect(sent.params).toMatchObject({
    expectedRevision: 'r',
    kind: 'chatgpt-gateway',
    confirmGatewayCredentials: true,
    gatewayOAuth: { tokenUrl: 'https://other.example/token', redirectPort: 43127 },
  });
  expect(sent.params).not.toHaveProperty('apiKey');
});
test('unknown provider changes clear secrets and recover their original receipt without a second write', async () => {
  let operationId = '';
  const { api, calls } = routed((call) => {
    if (call.method === 'system/provider/write') {
      operationId = call.operationId!;
      throw new Error('lost transport');
    }
    if (call.method === 'operation/read')
      return {
        operationId,
        method: 'system/provider/write',
        state: 'accepted',
        result: { kind: 'responses' },
      };
    return {
      revision: 'r',
      kind: 'responses',
      baseUrl: 'https://provider.example/v1',
      model: 'fixture',
    };
  });
  render(<ProviderSettings api={api} epoch="one" onChanged={() => {}} />);
  await waitFor(() =>
    expect((screen.getByLabelText('供应商') as HTMLSelectElement).value).toBe('responses'),
  );
  fireEvent.change(screen.getByLabelText('API Key'), {
    target: { value: 'private-fixture-value' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  const recover = await screen.findByRole('button', { name: '查询原供应商配置回执' });
  expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toBe('');
  expect(((await screen.findByRole('button', { name: '保存配置' })) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(JSON.stringify(localStorage)).not.toContain('private-fixture-value');
  fireEvent.click(recover);
  await waitFor(() =>
    expect(
      calls.some(
        (call) => call.method === 'operation/read' && call.params.operationId === operationId,
      ),
    ).toBe(true),
  );
  await waitFor(async () =>
    expect((await listOperations()).find((operation) => operation.id === operationId)?.state).toBe('accepted'),
  );
  expect(calls.filter((call) => call.method === 'system/provider/write')).toHaveLength(1);
});
test('gateway catalog stays native and configuration readiness prevents writes', async () => {
  const { api, calls } = routed(() => ({
    revision: 'r',
    kind: 'chatgpt-gateway',
    baseUrl: 'https://gateway.example',
  }));
  render(<ProviderSettings api={api} epoch="one" onChanged={() => {}} enabled={false} />);
  await screen.findByRole('button', { name: '发现模型' });
  expect(screen.queryByLabelText('手动添加模型 ID')).toBeNull();
  expect((screen.getByRole('button', { name: '发现模型' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(calls.every((call) => call.method === 'system/provider/read')).toBe(true);
});

test('changing the Bedrock region clears an unsent key and submits the selected native provider without an arbitrary endpoint', async () => {
  const { api, calls } = routed(() => ({ revision: 'r', kind: 'chatgpt' }));
  render(<ProviderSettings api={api} epoch="one" onChanged={() => {}} />);
  await screen.findByRole('button', { name: '发现模型' });
  fireEvent.change(screen.getByLabelText('供应商'), { target: { value: 'bedrock-runtime' } });
  fireEvent.change(screen.getByLabelText('AWS 区域'), { target: { value: 'us-east-1' } });
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'old-unsent-fixture' } });
  fireEvent.change(screen.getByLabelText('AWS 区域'), { target: { value: 'us-west-2' } });
  expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toBe('');
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'new-unsent-fixture' } });
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() =>
    expect(calls.some((call) => call.method === 'system/provider/write')).toBe(true),
  );
  const sent = calls.find((call) => call.method === 'system/provider/write')!.params;
  expect(sent).toMatchObject({
    kind: 'bedrock-runtime',
    region: 'us-west-2',
    apiKey: 'new-unsent-fixture',
  });
  expect(sent).not.toHaveProperty('baseUrl');
  expect(sent).not.toHaveProperty('gatewayOAuth');
});

test('initial provider read keeps editors unavailable until their baseline exists', async () => {
  let resolve!: (value: unknown) => void;
  const call = vi.fn(() => new Promise((done) => { resolve = done; }));
  const mutate = vi.fn();
  render(<ProviderSettings api={{ call, mutate } as unknown as Api} epoch="one" onChanged={() => {}} />);
  expect(screen.getByLabelText('供应商').matches(':disabled')).toBe(true);
  expect(screen.queryByRole('button', { name: '发现模型' })).toBeNull();
  fireEvent.submit(screen.getByLabelText('供应商').closest('form')!);
  expect(mutate).not.toHaveBeenCalled();
  await act(async () => resolve({ revision: 'r', kind: 'chatgpt' }));
  expect(screen.getByLabelText('供应商').matches(':disabled')).toBe(false);
});

test('the first exposed provider editor binds immediate input to its initialized revision', async () => {
  let resolve!: (value: unknown) => void;
  const call = vi.fn(() => new Promise((done) => { resolve = done; }));
  const mutate = vi.fn().mockResolvedValue({ revision: 'r2', kind: 'bedrock-runtime' });
  let edited = false, clearedKey: string | undefined, interactionError: unknown;
  // Observe the first DOM commit, before passive effects can run. A later wait
  // for a particular hydrated value would conceal this initialization window.
  const observer = new MutationObserver(() => {
    if (edited || !screen.queryByRole('button', { name: '发现模型' })) return;
    edited = true;
    try {
      fireEvent.change(screen.getByLabelText('供应商'), { target: { value: 'bedrock-runtime' } });
      fireEvent.change(screen.getByLabelText('AWS 区域'), { target: { value: 'us-east-1' } });
      fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'old-unsent-fixture' } });
      fireEvent.change(screen.getByLabelText('AWS 区域'), { target: { value: 'us-west-2' } });
      clearedKey = (screen.getByLabelText('API Key') as HTMLInputElement).value;
      fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'new-unsent-fixture' } });
    } catch (error) { interactionError = error; }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  try {
    render(<ProviderSettings api={{ call, mutate } as unknown as Api} epoch="one" onChanged={() => {}} />);
    resolve({ revision: 'r', kind: 'chatgpt' });
    await waitFor(() => expect(edited).toBe(true));
    expect(interactionError).toBeUndefined();
    expect(clearedKey).toBe('');
    expect(call).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/已保存的配置发生变化/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(mutate).toHaveBeenCalledWith('system/provider/write', {
      expectedRevision: 'r', kind: 'bedrock-runtime', region: 'us-west-2', apiKey: 'new-unsent-fixture',
    }));
    expect(mutate).toHaveBeenCalledTimes(1);
  } finally { observer.disconnect(); }
});

test('an initial provider read failure keeps retry reachable outside the disabled editors', async () => {
  const call = vi.fn().mockRejectedValueOnce(new Error('fixture initial read failure'))
    .mockResolvedValue({ revision: 'r', kind: 'responses', model: 'saved-model' });
  render(<ProviderSettings api={{ call, mutate: vi.fn() } as unknown as Api} epoch="one" onChanged={() => {}} />);
  const retry = await screen.findByRole('button', { name: '重新读取' });
  expect(retry.matches(':disabled')).toBe(false);
  expect(screen.getByLabelText('供应商').matches(':disabled')).toBe(true);
  fireEvent.click(retry);
  await waitFor(() => expect((screen.getByLabelText('默认模型 ID') as HTMLInputElement).value).toBe('saved-model'));
  expect(screen.getByLabelText('供应商').matches(':disabled')).toBe(false);
});

test('keeps a provider save owned across its own maintenance and runtime restart', async () => {
  let finish!: (value: unknown) => void, revision = 'r1';
  const { api, calls } = routed(call => {
    if (call.method === 'system/provider/write') return new Promise(resolve => { finish = resolve; });
    return { revision, kind: 'responses', baseUrl: 'https://provider.example/v1', model: revision === 'r1' ? 'old-model' : 'new-model' };
  });
  const onChanged = vi.fn();
  const view = render(<ProviderSettings api={api} epoch="before" enabled onChanged={onChanged} />);
  await waitFor(() => expect((screen.getByLabelText('默认模型 ID') as HTMLInputElement).value).toBe('old-model'));
  fireEvent.change(screen.getByLabelText('默认模型 ID'), { target: { value: 'new-model' } });
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  view.rerender(<ProviderSettings api={api} epoch="restarting" enabled={false} onChanged={onChanged} />);
  expect(screen.getByLabelText('默认模型 ID').matches(':disabled')).toBe(true);
  expect(screen.getByRole('button', { name: '正在保存…' }).matches(':disabled')).toBe(true);
  await act(async () => { revision = 'r2'; finish({ revision, kind: 'responses', model: 'new-model' }); });
  await screen.findByText('配置已保存。');
  view.rerender(<ProviderSettings api={api} epoch="after" enabled onChanged={onChanged} />);
  await waitFor(() => expect(screen.getByRole('button', { name: '保存配置' }).matches(':disabled')).toBe(false));
  expect(screen.queryByText(/已保存的配置发生变化/)).toBeNull();
  expect((screen.getByLabelText('默认模型 ID') as HTMLInputElement).value).toBe('new-model');
  expect(calls.filter(call => call.method === 'system/provider/write')).toHaveLength(1);
  expect(onChanged).toHaveBeenCalledOnce();
});

test('distinguishes accepted settings from a failed follow-up read and retries only the read', async () => {
  let saved = false, busyRead = true;
  const call = vi.fn(async () => {
    if (saved && busyRead) throw new RpcError('Another management transaction is running', 'busy', 'not_sent');
    return { revision: saved ? 'r2' : 'r1', kind: 'responses', baseUrl: 'https://provider.example/v1', model: saved ? 'new-model' : 'old-model' };
  });
  const mutate = vi.fn(async () => { saved = true; return {}; });
  render(<ProviderSettings api={{ call, mutate } as unknown as Api} epoch="one" onChanged={() => {}} />);
  await waitFor(() => expect((screen.getByLabelText('默认模型 ID') as HTMLInputElement).value).toBe('old-model'));
  fireEvent.change(screen.getByLabelText('默认模型 ID'), { target: { value: 'new-model' } });
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await screen.findByText(/配置已保存，但暂时无法读取最新状态。无需重复保存/);
  expect(screen.queryByText('Another management transaction is running')).toBeNull();
  expect((screen.getByLabelText('默认模型 ID') as HTMLInputElement).value).toBe('new-model');
  busyRead = false;
  fireEvent.click(screen.getByRole('button', { name: '重新读取' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '保存配置' }).matches(':disabled')).toBe(false));
  expect(mutate).toHaveBeenCalledOnce();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('does not apply an old authenticated editor completion to a new login', async () => {
  let finish!: (value: unknown) => void;
  const api = { csrf: 'old-session', call: vi.fn().mockResolvedValue({ revision: 'r1', kind: 'chatgpt', model: 'original' }),
    mutate: vi.fn(() => new Promise(resolve => { finish = resolve; })) } as unknown as Api;
  const onChanged = vi.fn(), view = render(<ProviderSettings api={api} epoch="before" onChanged={onChanged} />);
  await screen.findByRole('button', { name: '发现模型' });
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  api.csrf = 'new-session';
  view.rerender(<ProviderSettings api={api} epoch="new-session" onChanged={onChanged} />);
  await screen.findByRole('button', { name: '发现模型' });
  fireEvent.change(screen.getByLabelText('默认模型 ID'), { target: { value: 'new-session-draft' } });
  await act(async () => finish({}));
  expect(onChanged).not.toHaveBeenCalled();
  expect(screen.queryByText('配置已保存。')).toBeNull();
  expect((screen.getByLabelText('默认模型 ID') as HTMLInputElement).value).toBe('new-session-draft');
});
