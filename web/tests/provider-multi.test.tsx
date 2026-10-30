// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Api } from '../lib/api';
import { ProviderSettings } from '../components/ProviderSettings';
import { useModelCatalogRefresh } from '../hooks/useModelCatalogRefresh';
afterEach(cleanup);

const id = 'b'.repeat(32);
const registry = {
  kind: 'chatgpt', revision: 'a'.repeat(32), models: [], hasApiKey: false, defaultProviderId: 'default',
  connections: [
    { id: 'default', name: 'ChatGPT', kind: 'chatgpt', enabled: true, modelProvider: 'harness_chatgpt', providerAliases: ['openai'], models: [], hasApiKey: false },
    { id, name: 'Coding Plan', kind: 'zhipu-coding', enabled: true, modelProvider: 'harness_' + id, hasApiKey: true,
      model: 'glm-5.3', models: [{ id: 'glm-5.3', defaultEffort: 'max', efforts: ['low', 'high', 'max'] }] },
  ],
};
const fixtureApi = () => ({
  csrf: 'fixture', call: vi.fn(async (method: string) => method === 'system/provider/read' ? registry : { data: [], nextCursor: null }),
  mutate: vi.fn().mockResolvedValue(registry),
}) as unknown as Api;

it('keeps model login beside its saved provider and hides it when the editor switches to an API provider', async () => {
  const api = fixtureApi();
  render(<ProviderSettings api={api} epoch="a" onChanged={vi.fn()} accountPanel={<p>共享 ChatGPT 登录</p>} />);
  await screen.findByText('共享 ChatGPT 登录');
  fireEvent.click(screen.getByRole('button', { name: 'Coding Plan' }));
  await waitFor(() => expect(screen.queryByText('共享 ChatGPT 登录')).toBeNull());
  expect((screen.getByLabelText('默认模型 ID') as HTMLInputElement).value).toBe('glm-5.3');
  expect(screen.getByText('low / high / max', { exact: false })).toBeTruthy();
});

it('saves a Coding Plan with a blank optional model without making the user type an ID', async () => {
  const api = fixtureApi();
  render(<ProviderSettings api={api} epoch="a" onChanged={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Coding Plan' }));
  await waitFor(() => expect((screen.getByLabelText('默认模型 ID') as HTMLInputElement).value).toBe('glm-5.3'));
  fireEvent.change(screen.getByLabelText('默认模型 ID'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => expect(api.mutate).toHaveBeenCalledWith('system/provider/write', expect.objectContaining({
    providerId: id, expectedRevision: registry.revision, kind: 'zhipu-coding',
  })));
  const payload = vi.mocked(api.mutate).mock.calls[0]![1];
  expect(payload).not.toHaveProperty('model');
  expect(payload).not.toHaveProperty('apiKey');
});

it('an explicit refresh synchronizes exactly the selected provider', async () => {
  const api = fixtureApi();
  const view = renderHook(() => useModelCatalogRefresh(api, 'harness_' + id));
  await act(async () => { await view.result.current.refresh(); });
  expect(api.mutate).toHaveBeenCalledWith('system/models/refresh', {
    expectedRevision: registry.revision, providerId: id, automatic: true,
  });
});

it('does not revive an old directory write after leaving and returning to the same provider', async () => {
  let finish!: (value: typeof registry) => void;
  const api = fixtureApi();
  vi.mocked(api.call).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = renderHook(({ provider }) => useModelCatalogRefresh(api, provider), { initialProps: { provider: 'harness_' + id } });
  let pending!: Promise<void>;
  act(() => { pending = view.result.current.refresh(); });
  view.rerender({ provider: 'harness_chatgpt' });
  view.rerender({ provider: 'harness_' + id });
  await act(async () => { finish(registry); await pending; });
  expect(api.mutate).not.toHaveBeenCalled();
});

it('refreshing a logged-in native provider does not restart or rewrite provider configuration', async () => {
  const api = fixtureApi();
  const view = renderHook(() => useModelCatalogRefresh(api, 'harness_chatgpt'));
  await act(async () => { await view.result.current.refresh(); });
  expect(api.mutate).not.toHaveBeenCalled();
});

it('recognizes a historical ChatGPT provider alias during directory refresh', async () => {
  const api = fixtureApi();
  const view = renderHook(() => useModelCatalogRefresh(api, 'openai'));
  await act(async () => { await view.result.current.refresh(); });
  expect(view.result.current.error).toBe('');
  expect(api.mutate).not.toHaveBeenCalled();
});
