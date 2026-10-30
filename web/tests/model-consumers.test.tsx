// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../App';
import { ConfigSettings } from '../components/ConfigSettings';
import { ModelCatalog } from '../components/ModelCatalog';
import type { Api } from '../lib/api';
import type { Model } from '../lib/types';
import { enabledButton } from './enabled-button';

vi.mock('@xterm/xterm', () => ({ Terminal: class {} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
type Call = { method: string; params: Record<string, unknown>; operationId?: string };
const alpha: Model = { id: 'shared', model: 'shared', modelProvider: 'alpha', providerName: 'Alpha',
  displayName: 'Shared', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] };
const beta: Model = { id: 'shared', model: 'shared', modelProvider: 'beta', providerName: 'Beta',
  providerAliases: ['legacy-beta'], displayName: 'Shared', supportedReasoningEfforts: [{ reasoningEffort: 'max' }] };
const legacyModel: Model = { id: 'native-model', model: 'native-model',
  supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'low' }] };
const firstPage = [alpha, ...Array.from({ length: 49 }, (_, i) => ({ ...alpha, id: `first-${i}`, model: `first-${i}` }))];
const partial = [{ modelProvider: 'offline', name: 'Offline', message: 'Catalog temporarily unavailable' }];
const provider = (id = 'beta') => ({ kind: 'chatgpt', revision: 'r1', providerId: id, modelProvider: id, models: [] });
const page = (data: Model[], nextCursor: string | null = null) => ({ data, nextCursor });
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function configApi(catalog: (params: Record<string, unknown>) => unknown,
  config: () => Record<string, unknown> = () => ({ model: 'shared', model_provider: 'beta' })) {
  return {
    csrf: 'fixture',
    call: vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'settings/read') return { config: config(), editableKeys: ['model', 'model_reasoning_effort'], userVersion: 'v1', origins: {}, layers: [] };
      if (method === 'configRequirements/read') return { requirements: {} };
      if (method === 'model/list') return catalog(params);
      return page([]);
    }),
    mutate: vi.fn(async () => ({})),
  } as unknown as Api;
}
const configProps = (api: Api, id: string) => ({ api, project: { id, name: 'Fixture', cwd: '/fixture' },
  epoch: 'one', enabled: true, onChanged: vi.fn() });
const effortSelect = () => screen.getByRole('combobox', { name: /^推理强度/ }) as HTMLSelectElement;

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); history.replaceState({}, '', '/');
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('creates an automation with a same-named provider from page two entirely inside its dialog', async () => {
  sessionStorage.setItem('harness.project', 'project');
  Element.prototype.scrollIntoView = vi.fn();
  const sockets: { onopen: () => void; onmessage: (event: { data: string }) => void }[] = [];
  const calls: Call[] = [];
  let failNextPage = true;
  let includeBeta = true;
  vi.stubGlobal('WebSocket', class {
    onopen = () => {}; onclose = () => {}; onmessage = (_event: { data: string }) => {}; close() {}
    constructor() { sockets.push(this); }
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url === '/api/session') return { status: 200, ok: true, json: async () => ({ authenticated: true, csrf: 'fixture', operationRecoveryProtocol: 2 }) };
    const request = JSON.parse(String(init.body)) as Call;
    calls.push(request);
    let result: unknown = {};
    switch (request.method) {
      case 'project/list': result = { projects: [{ id: 'project', name: 'Project', path: '/fixture' }] }; break;
      case 'model/list':
        if (request.params.cursor && failNextPage) {
          failNextPage = false;
          throw new Error('Second page unavailable');
        }
        result = { ...(!request.params.cursor ? page(firstPage, 'page-two') : page(includeBeta ? [beta] : [])), providerErrors: partial };
        break;
      case 'thread/list': case 'collaborationMode/list': case 'environment/list': result = page([]); break;
      case 'prompt/list': result = { prompts: [] }; break;
      case 'defaults/read': {
        const options = request.params.options as Record<string, unknown> | undefined;
        result = { model: options?.model || 'shared', modelProvider: options?.modelProvider || 'alpha', reasoningEffort: options?.modelProvider === 'beta' ? 'max' : 'high' };
        break;
      }
      case 'automation/list': result = { data: [] }; break;
      case 'automation/status': result = { running: true, lastTickAt: Date.now(), lastError: null }; break;
      case 'automation/preview': result = { next: [Date.now() + 3_600_000] }; break;
      case 'automation/create': result = { id: 'new-plan', revision: 1 }; break;
      case 'automation/read': result = { id: 'new-plan', revision: 1, name: 'Daily check', state: 'paused', projectId: 'project', text: 'Review my project', options: {}, schedule: { kind: 'weekly', time: '09:00', days: [1], timeZone: 'UTC' }, nextAt: null }; break;
      case 'automation/runs': result = { data: [], next: null }; break;
    }
    return { status: 200, ok: true, json: async () => ({ ok: true, result }) };
  }));
  render(<App />);
  await screen.findByRole('button', { name: 'Project' });
  await waitFor(() => expect(sockets).toHaveLength(1));
  await act(async () => {
    sockets[0]!.onopen();
    sockets[0]!.onmessage({ data: JSON.stringify({ type: 'state', data: { connected: true, runtime: { connected: true, epoch: 'fixture', activity: { unknown: false, activeThreads: [], pendingStarts: 0, terminals: 0, processes: 0, subscriptions: 0 } } } }) });
  });
  fireEvent.click(screen.getByRole('button', { name: '自动化' }));
  const dialog = within(screen.getByRole('dialog', { name: '自动化' }));
  const loadMore = async () => {
    const button = await dialog.findByRole('button', { name: '加载更多模型' });
    await waitFor(() => expect(button.matches(':disabled')).toBe(false));
    fireEvent.click(button);
  };
  fireEvent.click(await dialog.findByRole('button', { name: '新建自动化' }));
  fireEvent.click(dialog.getByText('模型、模式与权限'));
  const select = dialog.getByRole('combobox', { name: '自动化模型' }) as HTMLSelectElement;
  expect(select.options).toHaveLength(51);
  expect(dialog.getByText(/Offline.*Catalog temporarily unavailable/)).toBeTruthy();
  fireEvent.click(dialog.getByRole('button', { name: '加载更多模型' }));
  await dialog.findByText(/Second page unavailable/);
  expect(select.options).toHaveLength(51);
  fireEvent.click(dialog.getByRole('button', { name: '加载更多模型' }));
  const betaOption = await dialog.findByRole('option', { name: 'Shared · Beta' }) as HTMLOptionElement;
  fireEvent.change(select, { target: { value: betaOption.value } });
  const effort = dialog.getByRole('combobox', { name: '自动化推理强度' }) as HTMLSelectElement;
  await waitFor(() => expect(within(effort).getByRole('option', { name: 'max' })).toBeTruthy());
  expect(within(effort).queryByRole('option', { name: 'high' })).toBeNull();
  fireEvent.change(effort, { target: { value: 'max' } });
  fireEvent.change(dialog.getByRole('textbox', { name: '计划名称' }), { target: { value: 'Daily check' } });
  fireEvent.change(dialog.getByRole('textbox', { name: '自动执行的指令' }), { target: { value: 'Review my project' } });
  fireEvent.click(dialog.getByRole('button', { name: '预览接下来五次执行时间' }));
  await dialog.findByText(/执行时间 ·/);
  fireEvent.click(dialog.getByRole('checkbox', { name: /确认保存计划/ }));
  await enabledButton({ name: '创建暂停的计划' });
  // Refresh must retain the chosen provider/effort while it is beyond the first page.
  fireEvent.click(dialog.getByRole('button', { name: '重新读取模型目录' }));
  await waitFor(() => expect(select.value).toBe('__unavailable__'));
  expect(effort.value).toBe('max');
  expect(dialog.getByRole('button', { name: '创建暂停的计划' }).matches(':disabled')).toBe(true);
  await loadMore();
  await waitFor(() => expect(select.value).toBe(betaOption.value));
  await enabledButton({ name: '创建暂停的计划' });
  // A removed entry stays visible as unavailable, without silently picking Alpha.
  includeBeta = false;
  fireEvent.click(dialog.getByRole('button', { name: '重新读取模型目录' }));
  await loadMore();
  await waitFor(() => expect(dialog.queryByRole('button', { name: '加载更多模型' })).toBeNull());
  expect(select.value).toBe('__unavailable__');
  expect(effort.value).toBe('max');
  expect(dialog.getByRole('button', { name: '创建暂停的计划' }).matches(':disabled')).toBe(true);
  expect(calls.some(call => call.method === 'automation/create')).toBe(false);
  includeBeta = true;
  fireEvent.click(dialog.getByRole('button', { name: '重新读取模型目录' }));
  await loadMore();
  fireEvent.click(await enabledButton({ name: '创建暂停的计划' }));
  await waitFor(() => expect(calls.some(call => call.method === 'automation/create')).toBe(true));
  expect(calls.find(call => call.method === 'automation/create')?.params.spec).toMatchObject({ options: { model: 'shared', modelProvider: 'beta', effort: 'max' } });
  expect(calls.filter(call => call.method === 'model/list').every(call => call.params.limit === 50)).toBe(true);
  await dialog.findByRole('button', { name: '编辑计划' });
});

it('loads effective reasoning choices from page two using the effective provider alias', async () => {
  const api = configApi(params => ({ ...(params.cursor ? page([beta]) : page(firstPage, 'page-two')), providerErrors: partial }),
    () => ({ model: 'shared', model_provider: 'legacy-beta' }));
  render(<ConfigSettings {...configProps(api, 'config-page-two')} />);
  await screen.findByRole('button', { name: '加载更多模型' });
  expect(within(effortSelect()).queryByRole('option', { name: 'high' })).toBeNull();
  fireEvent.click(await enabledButton({ name: '加载更多模型' }));
  await waitFor(() => expect(within(effortSelect()).getByRole('option', { name: 'max' })).toBeTruthy());
  expect(screen.getByText(/Offline.*Catalog temporarily unavailable/)).toBeTruthy();
  expect(api.call).toHaveBeenCalledWith('model/list', { cursor: 'page-two', limit: 50 });
  fireEvent.change(effortSelect(), { target: { value: 'max' } });
  fireEvent.click(await enabledButton({ name: '保存 1 项配置' }));
  await waitFor(() => expect(api.mutate).toHaveBeenCalledWith('settings/write', { expectedVersion: 'v1', changes: [{ key: 'model_reasoning_effort', value: 'max' }] }));
});

it('selects and saves reasoning effort for a complete legacy native catalog without provider metadata', async () => {
  const api = configApi(() => page([legacyModel]),
    () => ({ model: 'native-model', model_provider: 'openai' }));
  render(<ConfigSettings {...configProps(api, 'config-legacy-native')} />);
  await waitFor(() => expect(within(effortSelect()).getByRole('option', { name: 'high' })).toBeTruthy());
  expect(within(effortSelect()).getByRole('option', { name: 'low' })).toBeTruthy();
  fireEvent.change(effortSelect(), { target: { value: 'high' } });
  fireEvent.click(await enabledButton({ name: '保存 1 项配置' }));
  await waitFor(() => expect(api.mutate).toHaveBeenCalledWith('settings/write', {
    expectedVersion: 'v1', changes: [{ key: 'model_reasoning_effort', value: 'high' }],
  }));
});

it.each(['legacy', 'mixed'])('waits for the full catalog before legacy matching (%s final page)', async kind => {
  const pending = deferred();
  const api = configApi(params => params.cursor ? pending.promise : page([legacyModel], 'page-two'),
    () => ({ model: 'native-model', model_provider: 'openai' }));
  render(<ConfigSettings {...configProps(api, `config-legacy-pages-${kind}`)} />);
  const more = await enabledButton({ name: '加载更多模型' });
  expect(within(effortSelect()).queryByRole('option', { name: 'high' })).toBeNull();
  fireEvent.click(more);
  await waitFor(() => expect(api.call).toHaveBeenCalledWith('model/list', { cursor: 'page-two', limit: 50 }));
  expect(within(effortSelect()).queryByRole('option', { name: 'high' })).toBeNull();
  await act(async () => pending.resolve(page([
    kind === 'legacy' ? { ...legacyModel, id: 'other-model', model: 'other-model' } : alpha,
  ])));
  expect(screen.queryByRole('button', { name: '加载更多模型' })).toBeNull();
  if (kind === 'legacy') {
    fireEvent.change(effortSelect(), { target: { value: 'low' } });
    fireEvent.click(await enabledButton({ name: '保存 1 项配置' }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledWith('settings/write', {
      expectedVersion: 'v1', changes: [{ key: 'model_reasoning_effort', value: 'low' }],
    }));
  } else {
    expect(within(effortSelect()).queryByRole('option', { name: 'high' })).toBeNull();
    expect(within(effortSelect()).queryByRole('option', { name: 'low' })).toBeNull();
    expect(api.mutate).not.toHaveBeenCalled();
  }
});

it.each([
  ['mixed-provider', page([legacyModel, alpha, beta])],
  ['provider-id-only', page([legacyModel, { id: 'other-model', providerId: 'beta-connection' }])],
  ['partial-failure', { ...page([legacyModel]), providerErrors: partial }],
  ['ambiguous-legacy', page([legacyModel, { ...legacyModel, id: 'native-alias' }])],
] as const)('does not infer a legacy provider from an unsafe catalog (%s)', async (kind, catalog) => {
  const api = configApi(() => catalog,
    () => ({ model: 'native-model', model_provider: 'openai' }));
  render(<ConfigSettings {...configProps(api, `config-legacy-reject-${kind}`)} />);
  await enabledButton({ name: '重新读取模型目录' });
  expect(within(effortSelect()).queryByRole('option', { name: 'high' })).toBeNull();
  expect(within(effortSelect()).queryByRole('option', { name: 'low' })).toBeNull();
  expect(api.mutate).not.toHaveBeenCalled();
});

it.each([true, false])('keeps the selected config effort during catalog reload (model remains: %s)', async remains => {
  const pending = deferred();
  let reads = 0;
  const api = configApi(() => ++reads === 1 ? page([alpha, beta]) : pending.promise);
  render(<ConfigSettings {...configProps(api, `config-retain-${remains}`)} />);
  await waitFor(() => expect(within(effortSelect()).getByRole('option', { name: 'max' })).toBeTruthy());
  fireEvent.change(effortSelect(), { target: { value: 'max' } });
  await enabledButton({ name: '保存 1 项配置' });
  fireEvent.click(screen.getByRole('button', { name: '重新读取配置' }));
  await waitFor(() => expect(reads).toBe(2));
  expect(effortSelect().value).toBe('max');
  const save = screen.getByRole('button', { name: '保存 1 项配置' });
  expect(save.matches(':disabled')).toBe(true);
  await act(async () => pending.resolve(page(remains ? [alpha, beta] : [alpha])));
  expect(effortSelect().value).toBe('max');
  expect(within(effortSelect()).queryByRole('option', { name: 'high' })).toBeNull();
  await waitFor(() => expect(save.matches(':disabled')).toBe(!remains));
  expect(api.mutate).not.toHaveBeenCalled();
  if (!remains) {
    expect(within(effortSelect()).getByRole('option', { name: 'max（当前值）' }).matches(':disabled')).toBe(true);
    fireEvent.change(effortSelect(), { target: { value: '' } });
    fireEvent.click(await enabledButton({ name: '保存 1 项配置' }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledWith('settings/write', { expectedVersion: 'v1', changes: [{ key: 'model_reasoning_effort', value: null }] }));
  }
});

it('rejects a late config catalog page after the effective provider generation changes', async () => {
  const pending = deferred();
  let currentProvider = 'beta';
  const api = configApi(params => params.cursor ? pending.promise : currentProvider === 'beta' ? page([beta], 'old-page') : page([alpha]),
    () => ({ model: 'shared', model_provider: currentProvider }));
  const props = configProps(api, 'config-generation');
  const view = render(<ConfigSettings {...props} />);
  await waitFor(() => expect(within(effortSelect()).getByRole('option', { name: 'max' })).toBeTruthy());
  fireEvent.change(effortSelect(), { target: { value: 'max' } });
  fireEvent.click(screen.getByRole('button', { name: '加载更多模型' }));
  await waitFor(() => expect(api.call).toHaveBeenCalledWith('model/list', { cursor: 'old-page', limit: 50 }));
  currentProvider = 'alpha';
  view.rerender(<ConfigSettings {...props} epoch="two" />);
  await waitFor(() => expect(within(effortSelect()).getByRole('option', { name: 'high' })).toBeTruthy());
  await act(async () => pending.resolve(page([beta])));
  expect(effortSelect().value).toBe('max');
  expect(within(effortSelect()).getByRole('option', { name: 'max（当前值）' }).matches(':disabled')).toBe(true);
  expect(screen.getByRole('button', { name: '保存 1 项配置' }).matches(':disabled')).toBe(true);
  expect(api.mutate).not.toHaveBeenCalled();
});

it('pages native catalogs with bounded requests and preserves rows through a retry and cursor rejection', async () => {
  let fail = true;
  let validCursor = false;
  const api = configApi(params => {
    if (params.cursor === 'page-two') {
      if (fail) { fail = false; throw new Error('Native page unavailable'); }
      return page([{ ...beta, id: 'native-50', model: 'native-50' }], validCursor ? null : 'page-two');
    }
    return { ...page(firstPage, 'page-two'), providerErrors: partial };
  });
  render(<ModelCatalog api={api} provider={provider()} onApplied={vi.fn()} />);
  await screen.findByText('first-48');
  expect(screen.getByText(/Offline.*Catalog temporarily unavailable/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '加载更多模型' }));
  await screen.findByText(/Native page unavailable/);
  expect(screen.getByText('first-48')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '加载更多模型' }));
  await screen.findByRole('alert');
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/游标/));
  expect(screen.queryByText('native-50')).toBeNull();
  validCursor = true;
  fireEvent.click(screen.getByRole('button', { name: '加载更多模型' }));
  await screen.findByText('native-50');
  expect(screen.getByText('first-48')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '加载更多模型' })).toBeNull();
  expect(api.call).toHaveBeenCalledWith('model/list', { modelProvider: 'beta', limit: 50 }, expect.any(AbortSignal));
  expect(api.call).toHaveBeenCalledWith('model/list', { modelProvider: 'beta', cursor: 'page-two', limit: 50 });
});

it('ignores a previous native provider page after switching the directory identity', async () => {
  const pending = deferred();
  const api = configApi(params => params.cursor ? pending.promise : params.modelProvider === 'alpha' ? page([alpha], 'old-page') : page([{ ...beta, id: 'beta-only', model: 'beta-only' }]));
  const view = render(<ModelCatalog api={api} provider={provider('alpha')} onApplied={vi.fn()} />);
  await screen.findByText('shared');
  fireEvent.click(screen.getByRole('button', { name: '加载更多模型' }));
  await waitFor(() => expect(api.call).toHaveBeenCalledWith('model/list', { modelProvider: 'alpha', cursor: 'old-page', limit: 50 }));
  view.rerender(<ModelCatalog api={api} provider={provider('beta')} onApplied={vi.fn()} />);
  await screen.findByText('beta-only');
  await act(async () => pending.resolve(page([{ ...alpha, id: 'old-only', model: 'old-only' }])));
  expect(screen.queryByText('old-only')).toBeNull();
  expect(screen.queryByText('shared')).toBeNull();
  expect(screen.getByText('beta-only')).toBeTruthy();
});
