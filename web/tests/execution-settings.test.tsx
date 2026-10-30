// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { Events } from '../lib/events';
import { ThreadExecutionSettings } from '../components/ThreadExecutionSettings';
import { listOperations } from '../lib/operations';
const model = {
  id: 'm',
  model: 'model',
  displayName: 'Model',
  supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
  serviceTiers: [{ id: 'fast', name: 'Fast', description: 'Lower latency' }],
};
const snapshot = {
  requiresResume: false,
  thread: { id: 'thread' },
  model: 'model',
  modelProvider: 'provider',
  reasoningEffort: 'high',
  serviceTier: null,
  approvalsReviewer: 'user',
  approvalPolicy: 'on-request',
  sandbox: { type: 'workspaceWrite' },
  activePermissionProfile: { id: ':workspace' },
};
type Call = { method: string; params: Record<string, unknown>; operationId?: string };
function setup(handler: (call: Call) => unknown = () => undefined) {
  const api = new Api(),
    events = new Events(),
    calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url, init) => {
      const call: Call = JSON.parse(init.body);
      calls.push(call);
      const result =
        (await handler(call)) ??
        (call.method === 'thread/session'
          ? snapshot
          : call.method === 'permissionProfile/list'
            ? {
                data: [
                  { id: ':read', description: 'Read files only', allowed: true },
                  { id: ':forbidden', description: 'Restricted', allowed: false },
                ],
                nextCursor: null,
              }
            : call.method === 'modelProvider/capabilities/read'
              ? { imageGeneration: false, webSearch: true }
              : {});
      return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
    }),
  );
  return { api, events, calls };
}
const props = (api: Api, events: Events) => ({
  api,
  events,
  threadId: 'thread',
  projectId: 'project',
  epoch: 'epoch',
  enabled: true,
  activeTurnId: 'turn',
  models: [model],
  moreModels: false,
  modelsLoading: false,
  onMoreModels: vi.fn(),
  onChanged: vi.fn(),
  onClose: vi.fn(),
});
const choose = (name: string, value: string) =>
  fireEvent.change(screen.getByRole('combobox', { name }), { target: { value } });
async function ready() {
  await screen.findByText('model / provider');
}
async function submit(turn = false) {
  fireEvent.click(screen.getByRole('checkbox', { name: /确认将以上明确选择/ }));
  fireEvent.click(screen.getByRole('button', { name: turn ? '应用到当前回合' : '保存会话设置' }));
}
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('reads scoped profiles and provider capabilities without resume or any mutation', async () => {
  const s = setup();
  render(<ThreadExecutionSettings {...props(s.api, s.events)} />);
  await ready();
  expect(await screen.findByText(/网页搜索可用；图像生成不可用/)).toBeTruthy();
  expect(s.calls.find((c) => c.method === 'permissionProfile/list')?.params).toEqual({
    projectId: 'project',
    limit: 50,
  });
  expect((screen.getByRole('option', { name: /:forbidden/ }) as HTMLOptionElement).disabled).toBe(
    true,
  );
  expect(s.calls.some((c) => c.operationId || c.method === 'thread/resume')).toBe(false);
});
it.each([false, true])('uses the current thread provider for identical model IDs and effort choices (turn=%s)', async (turn) => {
  const s = setup(c => c.method === 'thread/session'
    ? { ...snapshot, modelProvider: 'beta-native' } : c.method === 'turn/settings/update' ? { status: 'applied' } : undefined);
  render(<ThreadExecutionSettings {...props(s.api, s.events)} models={[
    { ...model, modelProvider: 'alpha' },
    { ...model, id: 'alpha-only', model: 'alpha-only', modelProvider: 'alpha', displayName: 'Alpha only' },
    { ...model, modelProvider: 'beta', providerAliases: ['beta-native'], displayName: 'Beta model',
      supportedReasoningEfforts: [{ reasoningEffort: 'max' }],
      serviceTiers: [{ id: 'beta-tier', name: 'Beta tier', description: 'Beta service' }] },
  ]} />);
  await screen.findByText('model / beta-native');
  if (turn) fireEvent.click(screen.getByRole('button', { name: '仅当前回合' }));
  const selector = screen.getByRole('combobox', { name: '模型' });
  expect(within(selector).queryByRole('option', { name: 'Alpha only' })).toBeNull();
  expect(within(selector).getAllByRole('option')).toHaveLength(2);
  const efforts = screen.getByRole('combobox', { name: '推理强度' });
  expect(within(efforts).queryByRole('option', { name: 'high' })).toBeNull();
  expect(within(efforts).getByRole('option', { name: 'max' })).toBeTruthy();
  choose('模型', 'model');
  choose('推理强度', 'max');
  choose('服务档位', 'beta-tier');
  await submit(turn);
  await waitFor(() => expect(s.calls.find(c => c.method === (turn ? 'turn/settings/update' : 'thread/settings/update'))?.params).toEqual({
    threadId: 'thread', ...(turn ? { turnId: 'turn' } : {}), model: 'model', effort: 'max', serviceTier: 'beta-tier',
  }));
});
it('retains a removed provider model and blocks submission despite another provider having the same ID', async () => {
  const s = setup(), inherited = { ...model, modelProvider: 'provider' },
    foreign = { ...model, modelProvider: 'foreign' };
  const view = render(<ThreadExecutionSettings {...props(s.api, s.events)} models={[foreign, inherited]} />);
  await ready();
  choose('模型', 'model');
  choose('推理强度', 'high');
  view.rerender(<ThreadExecutionSettings {...props(s.api, s.events)} models={[foreign]} />);
  expect((screen.getByRole('combobox', { name: '模型' }) as HTMLSelectElement).selectedOptions[0]?.textContent).toContain('原模型已不可用');
  expect((screen.getByRole('combobox', { name: '推理强度' }) as HTMLSelectElement).selectedOptions[0]?.textContent).toContain('原强度已不可用');
  await submit();
  expect(s.calls.some(c => c.operationId)).toBe(false);
});
it('does not reinterpret selected model settings under a different provider after a snapshot refresh', async () => {
  let provider = 'provider';
  const s = setup(c => c.method === 'thread/session' ? { ...snapshot, modelProvider: provider } : undefined);
  render(<ThreadExecutionSettings {...props(s.api, s.events)} models={[
    { ...model, modelProvider: 'provider' }, { ...model, modelProvider: 'other' },
  ]} />);
  await ready();
  choose('模型', 'model');
  choose('推理强度', 'high');
  provider = 'other';
  fireEvent.click(screen.getByRole('button', { name: '重新读取设置' }));
  await screen.findByText('model / other');
  await submit();
  expect(s.calls.some(c => c.operationId)).toBe(false);
  expect(screen.getByRole('alert').textContent).toContain('所选设置已不在当前目录');
});
it('changes only selected future fields and explicitly clears service tier with null', async () => {
  const s = setup();
  render(<ThreadExecutionSettings {...props(s.api, s.events)} />);
  await ready();
  choose('命名权限档案', ':read');
  choose('推理摘要', 'concise');
  choose('服务档位', '__clear__');
  expect((screen.getByRole('button', { name: '保存会话设置' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await submit();
  await waitFor(() =>
    expect(s.calls.find((c) => c.method === 'thread/settings/update')?.params).toEqual({
      threadId: 'thread',
      summary: 'concise',
      serviceTier: null,
      permissions: ':read',
    }),
  );
  expect(s.calls.filter((c) => c.operationId)).toHaveLength(1);
});
it('binds current-only settings to a specific turn and reports targetUnavailable without retargeting', async () => {
  const s = setup((c) =>
    c.method === 'turn/settings/update' ? { status: 'targetUnavailable' } : undefined,
  );
  render(<ThreadExecutionSettings {...props(s.api, s.events)} />);
  await ready();
  fireEvent.click(screen.getByRole('button', { name: '仅当前回合' }));
  expect(screen.queryByRole('combobox', { name: '命名权限档案' })).toBeNull();
  choose('推理强度', 'high');
  await submit(true);
  await screen.findByText('目标回合已结束或不可用，未应用到其他回合。');
  expect(s.calls.find((c) => c.method === 'turn/settings/update')?.params).toEqual({
    threadId: 'thread',
    turnId: 'turn',
    effort: 'high',
  });
  expect(s.calls.filter((c) => c.operationId)).toHaveLength(1);
});
it('clears an unsubmitted current-turn selection when that turn changes', async () => {
  const s = setup();
  const view = render(<ThreadExecutionSettings {...props(s.api, s.events)} />);
  await ready();
  fireEvent.click(screen.getByRole('button', { name: '仅当前回合' }));
  choose('推理摘要', 'detailed');
  fireEvent.click(screen.getByRole('checkbox', { name: /确认将以上明确选择/ }));
  view.rerender(<ThreadExecutionSettings {...props(s.api, s.events)} activeTurnId="later" />);
  expect((screen.getByRole('combobox', { name: '推理摘要' }) as HTMLSelectElement).value).toBe('');
  expect(
    (screen.getByRole('button', { name: '应用到当前回合' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(s.calls.some((c) => c.operationId)).toBe(false);
});
it('never resumes an unloaded thread and refreshes its snapshot after a native settings notification', async () => {
  let loaded = false;
  const s = setup((c) =>
    c.method === 'thread/session' && !loaded ? { requiresResume: true } : undefined,
  );
  render(<ThreadExecutionSettings {...props(s.api, s.events)} />);
  await screen.findByText(/此会话尚未加载/);
  choose('推理摘要', 'auto');
  fireEvent.click(screen.getByRole('checkbox', { name: /确认将以上明确选择/ }));
  expect((screen.getByRole('button', { name: '保存会话设置' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  loaded = true;
  act(() =>
    s.events.publish({
      type: 'notification',
      data: { method: 'thread/settings/updated', params: { threadId: 'thread' } },
    }),
  );
  await ready();
  expect(s.calls.filter((c) => c.method === 'thread/session')).toHaveLength(2);
  expect(s.calls.some((c) => c.method === 'thread/resume' || c.operationId)).toBe(false);
});
it('recovers unknown settings by original receipt only, without promising current application state', async () => {
  let id = '';
  const s = setup((c) => {
    if (c.method === 'turn/settings/update') {
      id = c.operationId!;
      throw new Error('response lost');
    }
    if (c.method === 'operation/read')
      return {
        operationId: id,
        method: 'turn/settings/update',
        state: 'accepted',
        result: { status: 'applied' },
      };
  });
  render(<ThreadExecutionSettings {...props(s.api, s.events)} />);
  await ready();
  fireEvent.click(screen.getByRole('button', { name: '仅当前回合' }));
  choose('推理摘要', 'none');
  await submit(true);
  fireEvent.click(await screen.findByRole('button', { name: '查询原设置操作回执' }));
  await waitFor(async () => expect((await listOperations()).find((op) => op.id === id)?.state).toBe('accepted'));
  expect(s.calls.filter((c) => c.method === 'turn/settings/update')).toHaveLength(1);
  expect(screen.queryByText('当前回合设置已应用；不改变后续回合的会话设置。')).toBeNull();
});
it('blocks stale model choices and pages permission profiles with the returned cursor', async () => {
  const s = setup((c) =>
    c.method === 'permissionProfile/list'
      ? c.params.cursor
        ? { data: [{ id: ':extra', allowed: true, description: null }], nextCursor: null }
        : { data: [], nextCursor: 'next' }
      : undefined,
  );
  const view = render(<ThreadExecutionSettings {...props(s.api, s.events)} />);
  await ready();
  fireEvent.click(await screen.findByRole('button', { name: '加载更多权限档案' }));
  await screen.findByRole('option', { name: ':extra' });
  expect(s.calls.filter((c) => c.method === 'permissionProfile/list')[1]?.params.cursor).toBe(
    'next',
  );
  choose('模型', 'model');
  choose('服务档位', 'fast');
  view.rerender(<ThreadExecutionSettings {...props(s.api, s.events)} models={[]} />);
  expect(await screen.findByText(/所选设置已不在当前目录/)).toBeTruthy();
  await submit();
  expect(s.calls.some((c) => c.operationId)).toBe(false);
});
it.each([false, true])(
  'locks the submitted execution fields and retains them after failure (turn=%s)',
  async (turnScope) => {
    let reject!: (reason: Error) => void;
    const method = turnScope ? 'turn/settings/update' : 'thread/settings/update';
    const s = setup((c) =>
      c.method === method
        ? new Promise((_done, fail) => {
            reject = fail;
          })
        : undefined,
    );
    render(<ThreadExecutionSettings {...props(s.api, s.events)} />);
    await ready();
    if (turnScope) fireEvent.click(screen.getByRole('button', { name: '仅当前回合' }));
    choose('推理摘要', 'concise');
    fireEvent.click(screen.getByRole('checkbox', { name: /确认将以上明确选择/ }));
    const button = screen.getByRole('button', {
      name: turnScope ? '应用到当前回合' : '保存会话设置',
    });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await waitFor(() => expect(reject).toBeTypeOf('function'));
    const summary = screen.getByRole('combobox', { name: '推理摘要' }) as HTMLSelectElement;
    expect(summary.matches(':disabled')).toBe(true);
    expect(screen.getByRole('checkbox', { name: /确认将以上明确选择/ }).matches(':disabled')).toBe(
      true,
    );
    await act(async () => reject(new Error('settings response lost')));
    await screen.findByText(/settings response lost/);
    expect(summary.matches(':disabled')).toBe(false);
    expect(summary.value).toBe('concise');
    expect(s.calls.filter((c) => c.method === method)).toHaveLength(1);
  },
);
it('isolates a pending settings acknowledgement from a newly selected turn editor', async () => {
  let resolve!: (value: unknown) => void;
  const s = setup((c) =>
    c.method === 'turn/settings/update'
      ? new Promise((done) => {
          resolve = done;
        })
      : undefined,
  );
  const view = render(<ThreadExecutionSettings {...props(s.api, s.events)} />);
  await ready();
  fireEvent.click(screen.getByRole('button', { name: '仅当前回合' }));
  choose('推理摘要', 'concise');
  await submit(true);
  await waitFor(() => expect(resolve).toBeTypeOf('function'));
  view.rerender(<ThreadExecutionSettings {...props(s.api, s.events)} activeTurnId="later" />);
  choose('推理摘要', 'detailed');
  await act(async () => resolve({ status: 'applied' }));
  expect((screen.getByRole('combobox', { name: '推理摘要' }) as HTMLSelectElement).value).toBe(
    'detailed',
  );
  expect(s.calls.filter((c) => c.method === 'turn/settings/update')).toHaveLength(1);
  expect(s.calls.find((c) => c.method === 'turn/settings/update')?.params.turnId).toBe('turn');
  expect(screen.queryByText('当前回合设置已应用；不改变后续回合的会话设置。')).toBeNull();
});
