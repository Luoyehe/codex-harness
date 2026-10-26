// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Api } from '../lib/api';
import { ProviderSettings } from '../components/ProviderSettings';

type Call = { method: string; params: Record<string, unknown>; operationId?: string };
function routed(handler: (call: Call) => unknown) {
  const calls: Call[] = [],
    api = new Api();
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
afterEach(() => {
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
  expect((screen.getByRole('button', { name: '保存配置' }) as HTMLButtonElement).disabled).toBe(
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
