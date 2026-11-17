// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { ProviderSettings } from '../components/ProviderSettings';

type Call = { method: string; params: Record<string, unknown>; operationId?: string };
const row = (id: string, kind = 'responses') => ({ id, name: id, kind, enabled: true,
  modelProvider: id, baseUrl: `https://${id}.invalid/v1`, models: [] });
const registry = (ids = ['a', 'b'], defaultId = 'a', revision = 'r1'): Record<string, unknown> => ({
  kind: 'responses', baseUrl: `https://${defaultId}.invalid/v1`, revision,
  defaultProviderId: defaultId, connections: ids.map(id => row(id)), profiles: [],
});
const props = { epoch: 'one', enabled: true, onChanged: () => {} };
const settlements: (() => Promise<unknown>)[] = [];
function setup(initial = registry(), write?: (call: Call) => Record<string, unknown>) {
  let current = initial;
  const api = new Api(), calls: Call[] = [], mutations = vi.spyOn(api, 'mutate');
  const settle = () => Promise.allSettled(mutations.mock.results.filter(result => result.type === 'return').map(result => result.value));
  settlements.push(settle);
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    const call = JSON.parse(String(init.body)) as Call;
    calls.push(call);
    if (write && call.method === 'system/provider/write') current = write(call);
    const result = call.method === 'system/provider/read' ? current : call.method === 'model/list' ? { data: [], nextCursor: null } : {
      kind: 'responses', providerId: call.params.providerId, revision: 'r3', applied: true, requiresConfirmation: false,
    };
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
  }));
  return { api, calls, settle, replace: (next: Record<string, unknown>) => { current = next; } };
}
beforeEach(() => {
  sessionStorage.clear();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(async () => {
  await act(async () => { for (const settle of settlements.splice(0)) await settle(); });
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function editCatalog(id = 'b-only-model') {
  fireEvent.change(await screen.findByLabelText('手动添加模型 ID'), { target: { value: id } });
  fireEvent.click(screen.getByRole('button', { name: '添加' }));
  fireEvent.click(screen.getByRole('checkbox', { name: id }));
  fireEvent.change(screen.getByLabelText(`${id}：允许覆盖的推理强度`), { target: { value: 'high' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /我已核对选中模型的能力/ }));
}

it('keeps a removed provider catalog bound to its original ID and sends no request to the default', async () => {
  const fixture = setup(), view = render(<ProviderSettings {...props} api={fixture.api} />);
  fireEvent.click(await screen.findByRole('button', { name: 'b' }));
  await editCatalog();
  const oldApply = screen.getByRole('button', { name: '应用 1 个确认的模型' });
  fixture.replace(registry(['a'], 'a', 'r2'));
  view.rerender(<ProviderSettings {...props} epoch="two" api={fixture.api} />);
  await screen.findByText(/供应商“b”已不在当前配置中/);
  expect(screen.getByLabelText('API Base URL')).toHaveProperty('value', 'https://b.invalid/v1');
  expect(screen.getByLabelText('b-only-model：允许覆盖的推理强度')).toHaveProperty('value', 'high');
  expect(screen.getByRole('checkbox', { name: /我已核对选中模型的能力/ })).toHaveProperty('checked', false);
  for (const name of ['保存配置', '发现模型', '应用 1 个确认的模型'])
    expect(screen.getByRole('button', { name })).toHaveProperty('disabled', true);
  expect(screen.queryByRole('button', { name: '设为默认供应商' })).toBeNull();
  expect(screen.queryByRole('button', { name: '确认移除 b' })).toBeNull();
  fireEvent.click(oldApply);
  fireEvent.submit(screen.getByRole('button', { name: '保存配置' }).closest('form')!);
  fireEvent.click(screen.getByRole('button', { name: '发现模型' }));
  await act(fixture.settle);
  expect(fixture.calls.some(call => call.operationId)).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'a（默认）' }));
  fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
  expect(screen.getByLabelText('b-only-model：允许覆盖的推理强度')).toHaveProperty('value', 'high');
  fireEvent.click(screen.getByRole('button', { name: 'a（默认）' }));
  fireEvent.click(screen.getByRole('button', { name: '放弃目录编辑并切换供应商' }));
  expect(screen.queryByText(/已不在当前配置中/)).toBeNull();
  expect(screen.queryByRole('checkbox', { name: 'b-only-model' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '发现模型' }));
  await waitFor(() => expect(fixture.calls.filter(call => call.method === 'system/models/refresh')).toHaveLength(1));
  expect(fixture.calls.find(call => call.method === 'system/models/refresh')?.params).toEqual({
    providerId: 'a', automatic: true, expectedRevision: 'r2',
  });
});

it('retains form and catalog ownership when a restored profile replaces the whole registry', async () => {
  const fixture = setup(), view = render(<ProviderSettings {...props} api={fixture.api} />);
  fireEvent.click(await screen.findByRole('button', { name: 'b' }));
  await editCatalog();
  fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: 'My unfinished b' } });
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'secret-draft' } });
  fixture.replace(registry(['c', 'd'], 'd', 'profile-revision'));
  view.rerender(<ProviderSettings {...props} epoch="profile-restored" api={fixture.api} />);
  await screen.findByText(/供应商“b”已不在当前配置中/);
  expect(screen.getByLabelText('显示名称')).toHaveProperty('value', 'My unfinished b');
  expect(screen.getByLabelText('API Base URL')).toHaveProperty('value', 'https://b.invalid/v1');
  expect(screen.getByLabelText('API Key')).toHaveProperty('value', '');
  expect(screen.getByLabelText('b-only-model：允许覆盖的推理强度')).toHaveProperty('value', 'high');
  fireEvent.click(screen.getByText('配置备份', { selector: 'summary' }));
  fireEvent.change(screen.getByLabelText('新配置档名称'), { target: { value: 'must-not-save' } });
  expect(screen.getByRole('button', { name: '保存当前配置为配置档' })).toHaveProperty('disabled', true);
  fireEvent.submit(screen.getByRole('button', { name: '保存配置' }).closest('form')!);
  await act(fixture.settle);
  expect(fixture.calls.some(call => call.operationId)).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '放弃当前编辑' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'c' })).toHaveProperty('disabled', false));
  fireEvent.click(screen.getByRole('button', { name: 'c' }));
  fireEvent.click(screen.getByRole('button', { name: '放弃目录编辑并切换供应商' }));
  expect(screen.getByLabelText('显示名称')).toHaveProperty('value', 'c');
  expect(screen.getByLabelText('API Base URL')).toHaveProperty('value', 'https://c.invalid/v1');
});

it('pins the initially displayed provider when the default changes in another client', async () => {
  const fixture = setup(), view = render(<ProviderSettings {...props} api={fixture.api} />);
  await editCatalog('a-only-model');
  fixture.replace(registry(['a', 'b'], 'b', 'r2'));
  view.rerender(<ProviderSettings {...props} epoch="two" api={fixture.api} />);
  await screen.findByRole('button', { name: 'b（默认）' });
  expect(screen.getByRole('button', { name: 'a' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByLabelText('显示名称')).toHaveProperty('value', 'a');
  expect(screen.getByLabelText('a-only-model：允许覆盖的推理强度')).toHaveProperty('value', 'high');
  fireEvent.click(screen.getByRole('checkbox', { name: /我已核对选中模型的能力/ }));
  fireEvent.click(screen.getByRole('button', { name: '应用 1 个确认的模型' }));
  await waitFor(() => expect(fixture.calls.filter(call => call.method === 'system/models/refresh')).toHaveLength(1));
  expect(fixture.calls.find(call => call.method === 'system/models/refresh')?.params.providerId).toBe('a');
});

it('hides login controls when the selected ChatGPT provider disappears', async () => {
  const fixture = setup({ ...registry(), connections: [row('a'), row('b', 'chatgpt')] });
  const panel = vi.fn((_provider: Record<string, unknown>) => <button type="button">Target login</button>);
  const view = render(<ProviderSettings {...props} api={fixture.api} accountPanel={panel} />);
  fireEvent.click(await screen.findByRole('button', { name: 'b' }));
  await screen.findByRole('button', { name: 'Target login' });
  panel.mockClear();
  fixture.replace(registry(['a'], 'a', 'r2'));
  view.rerender(<ProviderSettings {...props} epoch="two" api={fixture.api} accountPanel={panel} />);
  await screen.findByText(/供应商“b”已不在当前配置中/);
  expect(screen.queryByRole('button', { name: 'Target login' })).toBeNull();
  expect(panel.mock.calls.some(([provider]) => provider.providerId === 'a')).toBe(false);
  expect(fixture.calls.some(call => call.operationId)).toBe(false);
});

it('revokes a pending selection if its destination is removed before confirmation', async () => {
  const fixture = setup(), view = render(<ProviderSettings {...props} api={fixture.api} />);
  await editCatalog('a-only-model');
  fireEvent.click(screen.getByRole('button', { name: 'b' }));
  const oldConfirm = screen.getByRole('button', { name: '放弃目录编辑并切换供应商' });
  fixture.replace(registry(['a'], 'a', 'r2'));
  view.rerender(<ProviderSettings {...props} epoch="two" api={fixture.api} />);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'b' })).toBeNull());
  fireEvent.click(oldConfirm);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByLabelText('显示名称')).toHaveProperty('value', 'a');
  expect(screen.getByLabelText('a-only-model：允许覆盖的推理强度')).toHaveProperty('value', 'high');
  expect(fixture.calls.some(call => call.operationId)).toBe(false);
});

it('continues to support an actual legacy single-provider response', async () => {
  const fixture = setup({ revision: 'legacy', kind: 'responses', baseUrl: 'https://legacy.invalid/v1', profiles: [] });
  render(<ProviderSettings {...props} api={fixture.api} />);
  await screen.findByLabelText('手动添加模型 ID');
  expect(screen.queryByText(/已不在当前配置中/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await waitFor(() => expect(fixture.calls.filter(call => call.method === 'system/provider/write')).toHaveLength(1));
  expect(fixture.calls.find(call => call.method === 'system/provider/write')?.params).toMatchObject({
    expectedRevision: 'legacy', kind: 'responses', baseUrl: 'https://legacy.invalid/v1',
  });
  expect(fixture.calls.find(call => call.method === 'system/provider/write')?.params).not.toHaveProperty('providerId');
});

it('keeps restored same-ID drafts and requires fresh capability consent before applying to that ID', async () => {
  const fixture = setup(), view = render(<ProviderSettings {...props} api={fixture.api} />);
  fireEvent.click(await screen.findByRole('button', { name: 'b' }));
  await editCatalog();
  fixture.replace(registry(['a'], 'a', 'r2'));
  view.rerender(<ProviderSettings {...props} epoch="two" api={fixture.api} />);
  await screen.findByText(/供应商“b”已不在当前配置中/);
  fixture.replace(registry(['a', 'b'], 'a', 'r3'));
  view.rerender(<ProviderSettings {...props} epoch="three" api={fixture.api} />);
  await waitFor(() => expect(screen.queryByText(/已不在当前配置中/)).toBeNull());
  expect(screen.getByLabelText('b-only-model：允许覆盖的推理强度')).toHaveProperty('value', 'high');
  expect(screen.getByRole('button', { name: '应用 1 个确认的模型' })).toHaveProperty('disabled', true);
  expect(fixture.calls.some(call => call.operationId)).toBe(false);
  fireEvent.click(screen.getByRole('checkbox', { name: /我已核对选中模型的能力/ }));
  fireEvent.click(screen.getByRole('button', { name: '应用 1 个确认的模型' }));
  await waitFor(() => expect(fixture.calls.filter(call => call.method === 'system/models/refresh')).toHaveLength(1));
  expect(fixture.calls.find(call => call.method === 'system/models/refresh')?.params).toMatchObject({
    providerId: 'b', automatic: true, expectedRevision: 'r3',
  });
});

it('selects a known remaining provider after the user explicitly removes the default', async () => {
  const fixture = setup(registry(), () => registry(['b'], 'b', 'r2'));
  render(<ProviderSettings {...props} api={fixture.api} />);
  fireEvent.click(await screen.findByText('移除供应商', { selector: 'summary' }));
  fireEvent.click(screen.getByRole('button', { name: '确认移除 a' }));
  await act(fixture.settle);
  await waitFor(() => expect(screen.getByLabelText('显示名称')).toHaveProperty('value', 'b'));
  expect(screen.queryByText(/已不在当前配置中/)).toBeNull();
  expect(fixture.calls.filter(call => call.method === 'system/provider/write')).toHaveLength(1);
  expect(fixture.calls.find(call => call.method === 'system/provider/write')?.params).toEqual({
    removeProviderId: 'a', expectedRevision: 'r1',
  });
});

it('does not reinterpret an already selected registry default as an unidentified legacy provider', async () => {
  const fixture = setup(registry(['default'], 'default'));
  const view = render(<ProviderSettings {...props} api={fixture.api} />);
  await editCatalog('original-default-model');
  fixture.replace({ revision: 'legacy', kind: 'responses', baseUrl: 'https://other.invalid/v1', profiles: [] });
  view.rerender(<ProviderSettings {...props} epoch="two" api={fixture.api} />);
  await screen.findByText(/供应商“default”已不在当前配置中/);
  expect(screen.getByLabelText('API Base URL')).toHaveProperty('value', 'https://default.invalid/v1');
  expect(screen.getByRole('button', { name: '应用 1 个确认的模型' })).toHaveProperty('disabled', true);
  expect(fixture.calls.some(call => call.operationId)).toBe(false);
});

it.each([[], null])('does not treat an empty or invalid registry as a legacy default: %j', async connections => {
  const fixture = setup({ ...registry(), connections });
  render(<ProviderSettings {...props} api={fixture.api} />);
  await screen.findByText(/已不在当前配置中/);
  expect(screen.getByRole('button', { name: '保存配置' })).toHaveProperty('disabled', true);
  expect(screen.queryByRole('button', { name: '发现模型' })).toBeNull();
  expect(fixture.calls.some(call => call.operationId)).toBe(false);
});
