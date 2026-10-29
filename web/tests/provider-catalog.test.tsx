// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { ProviderSettings } from '../components/ProviderSettings';
import { listOperations } from '../lib/operations';
import { enabledButton } from './enabled-button';

type Call = { method: string; params: Record<string, unknown>; operationId?: string };
const settleFixtures: (() => Promise<unknown>)[] = [];
const provider = (revision = 'r1') => ({
  revision, kind: 'responses', baseUrl: 'https://example.invalid/v1', hasApiKey: false, models: [],
});
const discovered = () => ({
  ...provider(), source: 'provider', applied: false, requiresConfirmation: true,
  models: [{ id: 'model-x', defaultEffort: null, efforts: [] }],
});
const applied = () => ({ ...provider('r2'), applied: true, requiresConfirmation: false });
function setup(handler: (call: Call) => unknown) {
  const calls: Call[] = [], api = new Api(), onChanged = vi.fn();
  // Keep the real Api/IndexedDB path and observe when its receipt writes finish.
  const mutations = vi.spyOn(api, 'mutate');
  const settle = () => Promise.allSettled(
    mutations.mock.results.filter((result) => result.type === 'return').map((result) => result.value),
  );
  settleFixtures.push(settle);
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    const call = JSON.parse(String(init.body)) as Call;
    calls.push(call);
    return { ok: true, status: 200, json: async () => ({ ok: true, result: await handler(call) }) };
  }));
  const view = render(<ProviderSettings api={api} epoch="one" onChanged={onChanged} />);
  return { calls, api, onChanged, view, settle };
}
async function discover() {
  fireEvent.click(await screen.findByRole('button', { name: '发现模型' }));
}
function confirm() {
  fireEvent.click(screen.getByRole('checkbox', { name: 'model-x' }));
  const button = screen.getByRole('button', { name: '应用 1 个确认的模型' }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('model-x：允许覆盖的推理强度'), {
    target: { value: 'medium, high' },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: '支持工具调用' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '支持图片输入' }));
  fireEvent.click(screen.getByRole('checkbox', {
    name: '我已核对选中模型的能力；应用后将重启运行时。',
  }));
  expect(button.disabled).toBe(false);
  return button;
}
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(async () => {
  await act(async () => {
    for (const settle of settleFixtures.splice(0)) await settle();
  });
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function prepareManualCatalog() {
  const manual = await screen.findByLabelText('手动添加模型 ID');
  fireEvent.change(manual, { target: { value: 'model-x' } });
  fireEvent.click(screen.getByRole('button', { name: '添加' }));
  const apply = confirm();
  fireEvent.change(manual, { target: { value: 'next-model-draft' } });
  return apply;
}
async function expectCatalogLocked() {
  const user = userEvent.setup();
  const fields = [
    '手动添加模型 ID',
    'model-x：原生默认推理强度',
    'model-x：允许覆盖的推理强度',
    'model-x：上下文窗口',
    'model-x：模型基础指令',
  ].map(label => screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement);
  const values = fields.map(field => field.value);
  for (const field of fields) {
    expect(field.matches(':disabled')).toBe(true);
    await user.type(field, '9876');
  }
  expect(fields.map(field => field.value)).toEqual(values);
  const checks = [
    'model-x', '支持工具调用', '支持图片输入', '支持音频输入',
    '我已核对选中模型的能力；应用后将重启运行时。',
  ].map(name => screen.getByRole('checkbox', { name }) as HTMLInputElement);
  const checked = checks.map(check => check.checked);
  // The first legend is exempt from a disabled fieldset, so its own control must be disabled.
  expect(checks[0]!.disabled).toBe(true);
  for (const check of checks) {
    expect(check.matches(':disabled')).toBe(true);
    await user.click(check);
  }
  expect(checks.map(check => check.checked)).toEqual(checked);
  const add = screen.getByRole('button', { name: '添加' }) as HTMLButtonElement;
  expect(add.disabled).toBe(true);
  await user.click(add);
  expect(screen.queryByRole('checkbox', { name: 'next-model-draft' })).toBeNull();
  const filter = screen.getByLabelText('筛选目录') as HTMLInputElement;
  expect(filter.disabled).toBe(false);
  await user.type(filter, 'model-x');
  expect(filter.value).toBe('model-x');
}

it('retains discovered rows in ProviderSettings until explicit capability application refreshes the provider', async () => {
  let saved = false;
  const { calls, onChanged } = setup(call => {
    if (call.method === 'system/provider/read') return provider(saved ? 'r2' : 'r1');
    if (!call.params.confirmCapabilities) return discovered();
    saved = true;
    return applied();
  });
  await discover();
  await screen.findByRole('checkbox', { name: 'model-x' });
  expect(calls.filter(call => call.method === 'system/provider/read')).toHaveLength(1);
  expect(onChanged).not.toHaveBeenCalled();
  const apply = confirm();
  fireEvent.click(apply);
  fireEvent.click(apply);
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(calls.filter(call => call.method === 'system/provider/read')).toHaveLength(2));
  const changes = calls.filter(call => call.method === 'system/models/refresh');
  expect(changes).toHaveLength(2);
  expect(changes[1]!.params).toMatchObject({
    expectedRevision: 'r1', confirmCapabilities: true,
    models: [{ id: 'model-x', efforts: ['medium', 'high'], supportsTools: true, inputModalities: ['text', 'image'] }],
  });
  await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'model-x' })).toBeNull());
});

it('queries an unknown discovery by original identity, retaining recovered rows without replay or parent refresh', async () => {
  let operationId = '', reads = 0;
  const { calls, onChanged } = setup(call => {
    if (call.method === 'system/provider/read') return provider();
    if (call.method === 'system/models/refresh') {
      if (call.params.confirmCapabilities) return applied();
      operationId = call.operationId!;
      throw new Error('lost discovery response');
    }
    return {
      operationId, method: 'system/models/refresh',
      state: ++reads === 1 ? 'unknown' : 'accepted', result: discovered(),
    };
  });
  await discover();
  const recover = await enabledButton({ name: '查询原目录操作回执' });
  expect((screen.getByRole('button', { name: '发现模型' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(recover);
  await screen.findByText('原目录请求仍待确认，不能重复发现或应用。');
  expect(screen.queryByRole('checkbox', { name: 'model-x' })).toBeNull();
  fireEvent.click(recover);
  await screen.findByRole('checkbox', { name: 'model-x' });
  expect(calls.filter(call => call.method === 'system/models/refresh')).toHaveLength(1);
  expect(calls.filter(call => call.method === 'operation/read').map(call => call.params)).toEqual([
    { operationId }, { operationId },
  ]);
  expect(calls.filter(call => call.method === 'system/provider/read')).toHaveLength(1);
  expect(onChanged).not.toHaveBeenCalled();
  await waitFor(() => expect((screen.getByRole('checkbox', { name: 'model-x' }) as HTMLInputElement).disabled).toBe(false));
  fireEvent.click(confirm());
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  expect(calls.filter(call => call.method === 'system/models/refresh')).toHaveLength(2);
});

it('refreshes once after an unknown application has an explicit applied receipt, without applying again', async () => {
  let operationId = '';
  const { calls, onChanged } = setup(call => {
    if (call.method === 'system/provider/read') return provider();
    if (call.method === 'operation/read')
      return { operationId, method: 'system/models/refresh', state: 'accepted', result: applied() };
    if (!call.params.confirmCapabilities) return discovered();
    operationId = call.operationId!;
    throw new Error('lost application response');
  });
  await discover();
  await screen.findByRole('checkbox', { name: 'model-x' });
  fireEvent.click(confirm());
  const recover = await enabledButton({ name: '查询原目录操作回执' });
  expect(onChanged).not.toHaveBeenCalled();
  fireEvent.click(recover);
  fireEvent.click(recover);
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  expect(calls.filter(call => call.method === 'operation/read')).toHaveLength(1);
  expect(calls.filter(call => call.method === 'system/models/refresh')).toHaveLength(2);
});

it.each(['discover', 'apply'] as const)('does not publish a late %s receipt into a replacement provider revision', async kind => {
  let operationId = '', revision = 'r1', finish!: (value: unknown) => void;
  const { calls, api, onChanged, view } = setup(call => {
    if (call.method === 'system/provider/read') return provider(revision);
    if (call.method === 'operation/read') return new Promise(resolve => { finish = resolve; });
    if (kind === 'apply' && !call.params.confirmCapabilities) return discovered();
    operationId = call.operationId!;
    throw new Error('lost response');
  });
  await discover();
  if (kind === 'apply') {
    await screen.findByRole('checkbox', { name: 'model-x' });
    fireEvent.click(confirm());
  }
  fireEvent.click(await enabledButton({ name: '查询原目录操作回执' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  revision = 'r3';
  view.rerender(<ProviderSettings api={api} epoch="two" onChanged={onChanged} />);
  await screen.findByRole('button', { name: '发现模型' });
  await act(async () => finish({
    operationId, method: 'system/models/refresh', state: 'accepted',
    result: kind === 'discover' ? discovered() : applied(),
  }));
  await waitFor(async () =>
    expect((await listOperations()).find((operation) => operation.id === operationId)?.state).toBe('accepted'),
  );
  expect(screen.queryByRole('checkbox', { name: 'model-x' })).toBeNull();
  expect(onChanged).not.toHaveBeenCalled();
  expect(calls.filter(call => call.method === 'system/provider/read')).toHaveLength(2);
});

it('does not refresh from a late direct application acknowledgement after provider replacement', async () => {
  let revision = 'r1', finish!: (value: unknown) => void;
  const { api, view, onChanged, settle } = setup(call => {
    if (call.method === 'system/provider/read') return provider(revision);
    if (!call.params.confirmCapabilities) return discovered();
    return new Promise(resolve => { finish = resolve; });
  });
  await discover();
  await screen.findByRole('checkbox', { name: 'model-x' });
  fireEvent.click(confirm());
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  revision = 'r3';
  view.rerender(<ProviderSettings api={api} epoch="two" onChanged={onChanged} />);
  await screen.findByRole('button', { name: '发现模型' });
  await act(async () => {
    finish(applied());
    await settle();
  });
  expect(onChanged).not.toHaveBeenCalled();
  expect(screen.queryByRole('checkbox', { name: 'model-x' })).toBeNull();
});

it('keeps discovery gated when an accepted receipt carries a different configuration revision', async () => {
  let operationId = '';
  const { calls, onChanged } = setup(call => {
    if (call.method === 'system/provider/read') return provider();
    if (call.method === 'operation/read') return {
      operationId, method: 'system/models/refresh', state: 'accepted',
      result: { ...discovered(), revision: 'other' },
    };
    operationId = call.operationId!;
    throw new Error('lost discovery response');
  });
  await discover();
  fireEvent.click(await enabledButton({ name: '查询原目录操作回执' }));
  await screen.findByText('发现结果与当前配置版本不匹配，请重新读取供应商配置。');
  expect(screen.queryByRole('checkbox', { name: 'model-x' })).toBeNull();
  expect((screen.getByRole('button', { name: '发现模型' }) as HTMLButtonElement).disabled).toBe(true);
  expect(onChanged).not.toHaveBeenCalled();
  expect(calls.filter(call => call.method === 'system/models/refresh')).toHaveLength(1);
});

it.each(['identity', 'method'])('rejects a recovered catalog receipt with the wrong %s', async mismatch => {
  let operationId = '';
  const { calls, onChanged } = setup(call => {
    if (call.method === 'system/provider/read') return provider();
    if (call.method === 'operation/read') return {
      operationId: mismatch === 'identity' ? 'foreign-operation' : operationId,
      method: mismatch === 'method' ? 'system/provider/write' : 'system/models/refresh',
      state: 'accepted', result: discovered(),
    };
    operationId = call.operationId!;
    throw new Error('lost discovery response');
  });
  await discover();
  fireEvent.click(await enabledButton({ name: '查询原目录操作回执' }));
  await screen.findByText('目录操作回执身份不匹配。');
  expect(screen.queryByRole('checkbox', { name: 'model-x' })).toBeNull();
  expect((screen.getByRole('button', { name: '发现模型' }) as HTMLButtonElement).disabled).toBe(true);
  expect(onChanged).not.toHaveBeenCalled();
  expect(calls.filter(call => call.method === 'system/models/refresh')).toHaveLength(1);
});

it('does not treat a successful RPC without applied proof as an applied catalog', async () => {
  const { calls, onChanged } = setup(call =>
    call.method === 'system/provider/read' ? provider() : discovered(),
  );
  await discover();
  await screen.findByRole('checkbox', { name: 'model-x' });
  fireEvent.click(confirm());
  await screen.findByText('目录应用尚未取得明确的应用证明，未刷新供应商配置。');
  expect(onChanged).not.toHaveBeenCalled();
  expect(calls.filter(call => call.method === 'system/provider/read')).toHaveLength(1);
  expect(screen.getByRole('checkbox', { name: 'model-x' })).toBeTruthy();
});

it.each(['discover', 'apply'] as const)('locks directory edits while a deferred %s can replace them', async kind => {
  let finish!: (value: unknown) => void;
  const { calls, onChanged, settle } = setup(call => {
    if (call.method === 'system/provider/read') return provider();
    return new Promise(resolve => { finish = resolve; });
  });
  const apply = await prepareManualCatalog();
  if (kind === 'discover') await discover();
  else fireEvent.click(apply);
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  await expectCatalogLocked();
  await act(async () => {
    finish(kind === 'discover' ? discovered() : applied());
    await settle();
  });
  expect(calls.filter(call => call.method === 'system/models/refresh')).toHaveLength(1);
  if (kind === 'discover') {
    await waitFor(() => expect((screen.getByRole('checkbox', { name: 'model-x' }) as HTMLInputElement).disabled).toBe(false));
    expect(onChanged).not.toHaveBeenCalled();
  } else {
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('checkbox', { name: 'model-x' })).toBeNull();
  }
});

it.each(['discover', 'apply'] as const)('keeps unknown %s edits frozen and restores the unchanged confirmation after not-sent proof', async kind => {
  let operationId = '', finish!: (value: unknown) => void;
  const { calls, onChanged } = setup(call => {
    if (call.method === 'system/provider/read') return provider();
    if (call.method === 'operation/read') return new Promise(resolve => { finish = resolve; });
    operationId = call.operationId!;
    throw new Error('lost catalog response');
  });
  const apply = await prepareManualCatalog();
  if (kind === 'discover') await discover();
  else fireEvent.click(apply);
  const recover = await enabledButton({ name: '查询原目录操作回执' });
  await expectCatalogLocked();
  fireEvent.click(recover);
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  expect((screen.getByLabelText('手动添加模型 ID') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('checkbox', { name: 'model-x' }) as HTMLInputElement).disabled).toBe(true);
  await act(async () => finish({ operationId, method: 'system/models/refresh', state: 'not_sent' }));
  await screen.findByText('已确认原目录请求未发送；再次操作需要你明确选择。');
  await waitFor(() => expect((screen.getByRole('checkbox', { name: 'model-x' }) as HTMLInputElement).disabled).toBe(false));
  expect((screen.getByLabelText('手动添加模型 ID') as HTMLInputElement).value).toBe('next-model-draft');
  expect((screen.getByLabelText('model-x：允许覆盖的推理强度') as HTMLInputElement).value).toBe('medium, high');
  expect((screen.getByRole('checkbox', {
    name: '我已核对选中模型的能力；应用后将重启运行时。',
  }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole('checkbox', { name: 'model-x' }) as HTMLInputElement).disabled).toBe(false);
  expect((screen.getByRole('button', { name: '应用 1 个确认的模型' }) as HTMLButtonElement).disabled).toBe(false);
  expect(calls.filter(call => call.method === 'system/models/refresh')).toHaveLength(1);
  expect(onChanged).not.toHaveBeenCalled();
});
