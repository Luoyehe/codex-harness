// @vitest-environment jsdom
import { enabledButton } from './enabled-button';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { AutomationForm } from '../components/AutomationForm';
import { AutomationDetail, AutomationsPanel } from '../components/AutomationsPanel';
import { reconcileOperation } from '../lib/operations';
import { useAutomationRuns } from '../hooks/useAutomationRuns';
import { localTime, zonedTime, type Automation, type Run } from '../lib/automations';
type Call = { method: string; params: Record<string, unknown>; operationId?: string };
const project = { id: 'registered-root', name: 'Workspace', cwd: '/work/root' },
  future = Date.now() + 3_600_000;
const job: Automation = {
  id: 'job-one',
  revision: 4,
  state: 'paused',
  name: 'Daily review',
  text: 'Inspect changes',
  projectId: project.id,
  options: { model: 'native-model', serviceTier: 'flex', approvalPolicy: 'on-request' },
  schedule: { kind: 'weekly', time: '09:00', days: [1], timeZone: 'Asia/Shanghai' },
  maxRunMinutes: 30,
  nextAt: future,
  createdAt: future - 100,
  updatedAt: future - 100,
};
const run: Run = {
  id: 'run-one',
  automationId: job.id,
  revision: 4,
  scheduledAt: future - 100,
  manual: false,
  operationId: 'original-dispatch',
  state: 'running',
  threadId: 'thread-one',
  turnId: 'turn-one',
  startedAt: future - 50,
  finishedAt: null,
  stopRequested: false,
  stopSent: false,
  code: null,
};
function setup(handler: (call: Call) => unknown = () => undefined) {
  const api = new Api(),
    calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      const call = JSON.parse(String(init.body));
      calls.push(call);
      const value = await handler(call),
        result =
          value ??
          (call.method === 'automation/preview'
            ? {
                next: [
                  future,
                  future + 86400_000,
                  future + 2 * 86400_000,
                  future + 3 * 86400_000,
                  future + 4 * 86400_000,
                ],
              }
            : call.method === 'automation/runs'
              ? { data: [], next: null }
              : call.method === 'defaults/read'
                ? { model: 'native-model' }
                : { id: job.id, revision: 1 });
      return {
        ok: true,
        status: 200,
        json: async () =>
          result && typeof result === 'object' && 'fault' in result
            ? { ok: false, error: (result as { fault: unknown }).fault }
            : { ok: true, result },
      };
    }),
  );
  return { api, calls };
}
const formProps = (api: Api) => ({
  api,
  projects: [project],
  projectId: project.id,
  models: [],
  modes: [],
  enabled: true,
  onChanged: vi.fn(),
  onSaved: vi.fn(),
  onCancel: vi.fn(),
});
const providerModels = [
  { id: 'shared', model: 'shared', modelProvider: 'alpha', providerName: 'Alpha', displayName: 'Shared',
    supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
  { id: 'shared', model: 'shared', modelProvider: 'beta', providerName: 'Beta', displayName: 'Shared',
    supportedReasoningEfforts: [{ reasoningEffort: 'max' }] },
];
const providerDefaults = (call: Call) => {
  if (call.method !== 'defaults/read') return undefined;
  const options = call.params.options as Record<string, unknown>;
  return { model: options.model || 'shared', modelProvider: options.modelProvider || 'alpha',
    reasoningEffort: options.modelProvider === 'beta' ? 'max' : 'high' };
};
function openModelSettings() {
  fireEvent.click(screen.getByText('模型、模式与权限'));
}
function chooseProvider(name: string) {
  const row = within(screen.getByRole('group', { name })).getByRole('option', { name: `Shared · ${name}` }) as HTMLOptionElement;
  fireEvent.change(screen.getByRole('combobox', { name: '自动化模型' }), { target: { value: row.value } });
}
async function savePlan(edit = false) {
  fireEvent.click(screen.getByRole('checkbox', { name: /确认保存计划/ }));
  fireEvent.click(await enabledButton({ name: edit ? '保存计划修改' : '创建暂停的计划' }));
}
const detailProps = (api: Api) => ({
  api,
  record: job,
  epoch: 'worker-one',
  enabled: true,
  idle: true,
  onChanged: vi.fn(),
  onEdit: vi.fn(),
  onRemoved: vi.fn(),
  onOpenThread: vi.fn(),
});
async function prepareForm() {
  fireEvent.change(screen.getByRole('textbox', { name: '计划名称' }), {
    target: { value: 'Daily check' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: '自动执行的指令' }), {
    target: { value: 'Review my project' },
  });
  const timeZone = (screen.getByRole('combobox', { name: '时区' }) as HTMLInputElement).value;
  fireEvent.click(screen.getByRole('button', { name: '预览接下来五次执行时间' }));
  await screen.findByText(`执行时间 · ${timeZone}`);
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
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
it('resolves entered times in the chosen zone and rejects DST gaps while selecting the first fold', () => {
  expect(zonedTime('2026-10-26T09:00', 'Asia/Shanghai')).toBe(Date.UTC(2026, 9, 26, 1));
  expect(localTime(Date.UTC(2026, 9, 26, 1), 'Asia/Shanghai')).toBe('2026-10-26T09:00');
  expect(() => zonedTime('2026-03-08T02:30', 'America/New_York')).toThrow(/夏令时/);
  expect(zonedTime('2026-11-01T01:30', 'America/New_York')).toBe(Date.UTC(2026, 10, 1, 5, 30));
  expect(() => zonedTime('2026-02-30T09:00', 'UTC')).toThrow(/无效/);
});
it('requires preview and consent, creates explicitly paused with registered project ID', async () => {
  const { api, calls } = setup(),
    props = formProps(api);
  render(<AutomationForm {...props} />);
  expect(
    (screen.getByRole('button', { name: '创建暂停的计划' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await prepareForm();
  fireEvent.click(screen.getByRole('checkbox', { name: /确认保存计划/ }));
  fireEvent.click(screen.getByRole('button', { name: '创建暂停的计划' }));
  await waitFor(() => expect(props.onSaved).toHaveBeenCalledWith(job.id));
  const params = calls.find((call) => call.method === 'automation/create')!.params;
  expect(params.enabled).toBe(false);
  expect(params.spec).toMatchObject({
    projectId: project.id,
    text: 'Review my project',
    options: {},
    maxRunMinutes: 30,
  });
  expect(params).not.toHaveProperty('cwd');
});
it('selects same-named models by provider and saves its reasoning effort and collaboration model', async () => {
  const { api, calls } = setup(providerDefaults), props = formProps(api);
  render(<AutomationForm {...props} models={providerModels}
    modes={[{ name: 'Plan', mode: 'plan', model: 'shared', reasoning_effort: 'high' }]} />);
  await prepareForm();
  openModelSettings();
  chooseProvider('Beta');
  await waitFor(() => expect(calls.at(-1)?.params).toMatchObject({
    projectId: project.id, options: { model: 'shared', modelProvider: 'beta' },
  }));
  const effort = screen.getByRole('combobox', { name: '自动化推理强度' });
  expect(within(effort).queryByRole('option', { name: 'high' })).toBeNull();
  fireEvent.change(effort, { target: { value: 'max' } });
  fireEvent.change(screen.getByRole('combobox', { name: '自动化协作模式' }), { target: { value: 'plan' } });
  await savePlan();
  await waitFor(() => expect(props.onSaved).toHaveBeenCalled());
  expect(calls.find(call => call.method === 'automation/create')?.params.spec).toMatchObject({
    options: { model: 'shared', modelProvider: 'beta', effort: 'max',
      collaborationMode: { mode: 'plan', settings: { model: 'shared', reasoning_effort: 'max' } } },
  });
});
it.each(['unchanged', 'alpha', 'default'])(
  'preserves an existing provider and unrelated native settings until explicitly changed (%s)', async (choice) => {
    const record = { ...job, options: { model: 'shared', modelProvider: 'beta', effort: 'max', serviceTier: 'flex',
      collaborationMode: { mode: 'plan', settings: { model: 'shared', reasoning_effort: 'max', developer_instructions: 'Keep instruction' } } } };
    const { api, calls } = setup(call => call.method === 'automation/update'
      ? { id: job.id, revision: 5 } : providerDefaults(call));
    const props = formProps(api);
    render(<AutomationForm {...props} record={record} models={providerModels} />);
    await prepareForm();
    openModelSettings();
    expect(((screen.getByRole('combobox', { name: '自动化模型' }) as HTMLSelectElement).selectedOptions[0]?.parentElement as HTMLOptGroupElement)?.label).toBe('Beta');
    if (choice === 'alpha') chooseProvider('Alpha');
    if (choice === 'default') fireEvent.change(screen.getByRole('combobox', { name: '自动化模型' }), { target: { value: '' } });
    await savePlan(true);
    await waitFor(() => expect(props.onSaved).toHaveBeenCalled());
    const options = (calls.find(call => call.method === 'automation/update')?.params.spec as { options: unknown }).options;
    expect(options).toEqual(choice === 'unchanged' ? record.options : {
      ...(choice === 'alpha' ? { model: 'shared', modelProvider: 'alpha' } : {}),
      serviceTier: 'flex', collaborationMode: { mode: 'plan', settings: {
        model: 'shared', reasoning_effort: 'high', developer_instructions: 'Keep instruction',
      } },
    });
  },
);
it('fences late provider defaults and cannot save while the newly selected defaults are pending', async () => {
  const pending = new Map<string, (value: unknown) => void>();
  const { api, calls } = setup(call => call.method === 'defaults/read'
    ? new Promise(resolve => pending.set(String((call.params.options as Record<string, unknown>).modelProvider || 'default'), resolve)) : undefined);
  const props = formProps(api);
  render(<AutomationForm {...props} models={providerModels}
    modes={[{ name: 'Plan', mode: 'plan', model: 'shared', reasoning_effort: 'high' }]} />);
  await prepareForm();
  openModelSettings();
  chooseProvider('Alpha');
  await waitFor(() => expect(pending.has('alpha')).toBe(true));
  chooseProvider('Beta');
  fireEvent.change(screen.getByRole('combobox', { name: '自动化协作模式' }), { target: { value: 'plan' } });
  await waitFor(() => expect(pending.has('beta')).toBe(true));
  fireEvent.click(screen.getByRole('checkbox', { name: /确认保存计划/ }));
  const save = screen.getByRole('button', { name: '创建暂停的计划' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  await act(async () => pending.get('alpha')!({ model: 'shared', modelProvider: 'alpha', reasoningEffort: 'high' }));
  expect(save.disabled).toBe(true);
  expect(calls.some(call => call.method === 'automation/create')).toBe(false);
  await act(async () => pending.get('beta')!({ model: 'shared', modelProvider: 'beta', reasoningEffort: null }));
  fireEvent.click(await enabledButton({ name: '创建暂停的计划' }));
  await waitFor(() => expect(props.onSaved).toHaveBeenCalled());
  expect(calls.find(call => call.method === 'automation/create')?.params.spec).toMatchObject({
    options: { modelProvider: 'beta', collaborationMode: { settings: { reasoning_effort: null } } },
  });
});
it('retains an unavailable selected model and requires an explicit replacement before saving', async () => {
  const { api, calls } = setup(providerDefaults), props = formProps(api);
  const view = render(<AutomationForm {...props} models={providerModels} />);
  await prepareForm();
  openModelSettings();
  chooseProvider('Beta');
  await waitFor(() => expect(screen.queryByText(/正在核对模型设置/)).toBeNull());
  view.rerender(<AutomationForm {...props} models={[providerModels[0]!]} />);
  const select = screen.getByRole('combobox', { name: '自动化模型' }) as HTMLSelectElement;
  expect(select.selectedOptions[0]?.textContent).toContain('beta / shared（保留）');
  fireEvent.click(screen.getByRole('checkbox', { name: /确认保存计划/ }));
  expect((screen.getByRole('button', { name: '创建暂停的计划' }) as HTMLButtonElement).disabled).toBe(true);
  expect(calls.some(call => call.method === 'automation/create')).toBe(false);
  fireEvent.change(select, { target: { value: '' } });
  await savePlan();
  await waitFor(() => expect(props.onSaved).toHaveBeenCalled());
  expect(calls.find(call => call.method === 'automation/create')?.params.spec).toMatchObject({ options: {} });
});
it('keeps an unlisted existing provider/model when only the schedule or text is edited', async () => {
  const record = { ...job, options: { modelProvider: 'beta', model: 'shared', serviceTier: 'flex' } };
  const { api, calls } = setup(call => call.method === 'automation/update' ? { id: job.id, revision: 5 } : providerDefaults(call));
  const props = formProps(api);
  render(<AutomationForm {...props} record={record} models={[providerModels[0]!]} />);
  await prepareForm();
  openModelSettings();
  expect((screen.getByRole('combobox', { name: '自动化模型' }) as HTMLSelectElement).selectedOptions[0]?.textContent).toContain('beta / shared（保留）');
  await savePlan(true);
  await waitFor(() => expect(props.onSaved).toHaveBeenCalled());
  expect(calls.find(call => call.method === 'automation/update')?.params.spec).toMatchObject({ options: record.options });
});
it('blocks a failed defaults read and retries without losing provider choice or prior edits', async () => {
  let failed = true;
  const { api, calls } = setup(call => {
    if (call.method === 'defaults/read' && (call.params.options as Record<string, unknown>).modelProvider === 'beta' && failed)
      throw new Error('provider temporarily unavailable');
    return providerDefaults(call);
  }), props = formProps(api);
  render(<AutomationForm {...props} models={providerModels} />);
  await prepareForm();
  openModelSettings();
  chooseProvider('Beta');
  await screen.findByText(/无法核对模型默认设置/);
  fireEvent.click(screen.getByRole('checkbox', { name: /确认保存计划/ }));
  expect((screen.getByRole('button', { name: '创建暂停的计划' }) as HTMLButtonElement).disabled).toBe(true);
  failed = false;
  fireEvent.click(screen.getByRole('button', { name: '重新读取模型默认设置' }));
  await waitFor(() => expect(screen.queryByText(/正在核对模型设置/)).toBeNull());
  expect((screen.getByRole('checkbox', { name: /确认保存计划/ }) as HTMLInputElement).checked).toBe(false);
  await savePlan();
  await waitFor(() => expect(props.onSaved).toHaveBeenCalled());
  expect(calls.find(call => call.method === 'automation/create')?.params.spec).toMatchObject({
    name: 'Daily check', options: { modelProvider: 'beta', model: 'shared' },
  });
});
it.each([
  ['Asia/Shanghai', 'UTC'],
  ['UTC', 'Asia/Shanghai'],
])(
  'invalidates preview after schedule changes and ignores a late response for the old zone (%s → %s)',
  async (oldZone, newZone) => {
    let resolve!: (value: unknown) => void;
    const { api, calls } = setup((call) =>
      call.method === 'automation/preview'
        ? new Promise((done) => {
            resolve = done;
          })
        : undefined,
    );
    render(<AutomationForm {...formProps(api)} />);
    // The browser default is deliberately host-dependent. Establish two distinct
    // schedule identities so UTC runners exercise the same late-response race.
    const timeZone = screen.getByRole('combobox', { name: '时区' }) as HTMLInputElement;
    fireEvent.change(timeZone, { target: { value: oldZone } });
    expect(timeZone.value).toBe(oldZone);
    expect(oldZone).not.toBe(newZone);
    fireEvent.click(screen.getByRole('button', { name: '预览接下来五次执行时间' }));
    await waitFor(() => expect(resolve).toBeTypeOf('function'));
    expect(
      calls.find((call) => call.method === 'automation/preview')?.params.schedule,
    ).toMatchObject({ timeZone: oldZone });
    fireEvent.change(timeZone, { target: { value: newZone } });
    expect(timeZone.value).toBe(newZone);
    await act(async () => resolve({ next: [future] }));
    expect(screen.queryByText(/执行时间 ·/)).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /确认保存计划/ }));
    expect(
      (screen.getByRole('button', { name: '创建暂停的计划' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(calls.filter((call) => call.method === 'automation/create')).toHaveLength(0);
  },
);
it('preserves unedited native options and requires explicit rebase after a conflicting version', async () => {
  let reject = true;
  const { api, calls } = setup((call) =>
      call.method === 'automation/update' && reject
        ? { fault: { code: 'automation_conflict', message: '计划版本冲突', delivery: 'not_sent' } }
        : undefined,
    ),
    props = formProps(api);
  const view = render(<AutomationForm {...props} record={job} />);
  await prepareForm();
  fireEvent.click(screen.getByRole('checkbox', { name: /确认保存计划/ }));
  fireEvent.click(screen.getByRole('button', { name: '保存计划修改' }));
  await screen.findByText('计划版本冲突');
  expect(calls.find((call) => call.method === 'automation/update')?.params).toMatchObject({
    id: job.id,
    expectedRevision: 4,
    spec: { options: job.options },
  });
  view.rerender(<AutomationForm {...props} record={{ ...job, revision: 5, text: 'Other edit' }} />);
  expect(
    (screen.getByRole('textbox', { name: '自动执行的指令' }) as HTMLTextAreaElement).value,
  ).toBe('Review my project');
  expect(calls.filter((call) => call.method === 'automation/update')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '保留草稿并以最新版本为基准' }));
  reject = false;
  fireEvent.click(screen.getByRole('checkbox', { name: /确认保存计划/ }));
  fireEvent.click(await enabledButton({ name: '保存计划修改' }));
  await waitFor(() =>
    expect(calls.filter((call) => call.method === 'automation/update')).toHaveLength(2),
  );
  expect(
    calls.filter((call) => call.method === 'automation/update')[1]!.params.expectedRevision,
  ).toBe(5);
});
it('recovers accepted creation from its original receipt without creating a second plan', async () => {
  let originalId = '';
  const { api, calls } = setup((call) => {
    if (call.method === 'automation/create') {
      originalId = call.operationId!;
      throw new TypeError('response lost');
    }
    if (call.method === 'operation/read')
      return {
        operationId: originalId,
        method: 'automation/create',
        state: 'accepted',
        result: { id: job.id, revision: 1 },
      };
  });
  const props = formProps(api);
  render(<AutomationForm {...props} />);
  await prepareForm();
  fireEvent.click(screen.getByRole('checkbox', { name: /确认保存计划/ }));
  fireEvent.click(screen.getByRole('button', { name: '创建暂停的计划' }));
  fireEvent.click(await enabledButton({ name: '查询原自动化操作回执' }));
  await waitFor(() => expect(props.onSaved).toHaveBeenCalled());
  expect(calls.filter((call) => call.method === 'automation/create')).toHaveLength(1);
  expect(calls.find((call) => call.method === 'operation/read')?.params.operationId).toBe(
    originalId,
  );
});
it('retains edits made after an unknown create as edits of the accepted plan, including after reopening', async () => {
  let originalId = '',
    created = false;
  const createdJob = { ...job, revision: 1, text: 'Review my project' };
  const { api, calls } = setup((call) => {
    if (call.method === 'automation/create') {
      originalId = call.operationId!;
      created = true;
      throw new TypeError('response lost');
    }
    if (call.method === 'operation/read')
      return {
        operationId: originalId,
        method: 'automation/create',
        state: 'accepted',
        result: { id: job.id, revision: 1 },
      };
    if (call.method === 'automation/list') return { data: created ? [createdJob] : [] };
    if (call.method === 'automation/read') return createdJob;
    if (call.method === 'automation/update') return { id: job.id, revision: 2, state: 'paused' };
    if (call.method === 'automation/status')
      return { running: true, lastTickAt: future, lastError: null };
  });
  render(
    <AutomationsPanel
      api={api}
      epoch="session-a"
      projects={[project]}
      projectId={project.id}
      models={[]}
      modes={[]}
      enabled
      idle
      onOpenThread={vi.fn()}
      onChanged={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '新建自动化' }));
  await prepareForm();
  fireEvent.click(screen.getByRole('checkbox', { name: /确认保存计划/ }));
  fireEvent.click(screen.getByRole('button', { name: '创建暂停的计划' }));
  await enabledButton({ name: '查询原自动化操作回执' });
  fireEvent.change(screen.getByRole('textbox', { name: '自动执行的指令' }), {
    target: { value: 'New unsent instruction' },
  });
  fireEvent.click(await enabledButton({ name: '查询原自动化操作回执' }));
  await screen.findByText(/原版本已保存.*新草稿尚未提交/);
  expect(
    (screen.getByRole('textbox', { name: '自动执行的指令' }) as HTMLTextAreaElement).value,
  ).toBe('New unsent instruction');
  expect(screen.queryByRole('button', { name: '创建暂停的计划' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '返回计划列表（保留草稿）' }));
  fireEvent.click(await screen.findByRole('button', { name: '编辑计划' }));
  expect(
    (screen.getByRole('textbox', { name: '自动执行的指令' }) as HTMLTextAreaElement).value,
  ).toBe('New unsent instruction');
  fireEvent.click(screen.getByRole('button', { name: '预览接下来五次执行时间' }));
  await screen.findByText(/执行时间 ·/);
  fireEvent.click(screen.getByRole('checkbox', { name: /确认保存计划/ }));
  fireEvent.click(screen.getByRole('button', { name: '保存计划修改' }));
  await screen.findByRole('button', { name: '新建自动化' });
  expect(calls.filter((call) => call.method === 'automation/create')).toHaveLength(1);
  expect(calls.find((call) => call.method === 'automation/update')?.params).toMatchObject({
    id: job.id,
    expectedRevision: 1,
    spec: { text: 'New unsent instruction' },
  });
  fireEvent.click(screen.getByRole('button', { name: '新建自动化' }));
  expect(
    (screen.getByRole('textbox', { name: '自动执行的指令' }) as HTMLTextAreaElement).value,
  ).toBe('');
});
it('keeps an edited-then-restored draft after update recovery and requires explicit rebase for a newer record', async () => {
  let originalId = '',
    submitted = false;
  const { api, calls } = setup((call) => {
      if (call.method === 'automation/update') {
        if (!submitted) {
          submitted = true;
          originalId = call.operationId!;
          throw new TypeError('response lost');
        }
        return { id: job.id, revision: 7, state: 'paused' };
      }
      if (call.method === 'operation/read')
        return {
          operationId: originalId,
          method: 'automation/update',
          state: 'accepted',
          result: { id: job.id, revision: 5, state: 'paused' },
        };
    }),
    props = formProps(api),
    view = render(<AutomationForm {...props} record={job} />);
  await prepareForm();
  fireEvent.click(screen.getByRole('checkbox', { name: /确认保存计划/ }));
  fireEvent.click(screen.getByRole('button', { name: '保存计划修改' }));
  await enabledButton({ name: '查询原自动化操作回执' });
  fireEvent.change(screen.getByRole('textbox', { name: '自动执行的指令' }), {
    target: { value: 'Temporary newer edit' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: '自动执行的指令' }), {
    target: { value: 'Review my project' },
  });
  fireEvent.click(await enabledButton({ name: '查询原自动化操作回执' }));
  await screen.findByText(/原版本已保存.*新草稿尚未提交/);
  expect(props.onSaved).not.toHaveBeenCalled();
  view.rerender(
    <AutomationForm {...props} record={{ ...job, revision: 6, text: 'External newer content' }} />,
  );
  await screen.findByText(/草稿仍基于版本 5/);
  fireEvent.click(screen.getByRole('checkbox', { name: /确认保存计划/ }));
  expect((screen.getByRole('button', { name: '保存计划修改' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByRole('button', { name: '保留草稿并以最新版本为基准' }));
  expect((screen.getByRole('checkbox', { name: /确认保存计划/ }) as HTMLInputElement).checked).toBe(
    false,
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /确认保存计划/ }));
  fireEvent.click(screen.getByRole('button', { name: '保存计划修改' }));
  await waitFor(() => expect(props.onSaved).toHaveBeenCalledTimes(1));
  expect(calls.filter((call) => call.method === 'automation/update')[1]?.params).toMatchObject({
    id: job.id,
    expectedRevision: 6,
    spec: { text: 'Review my project' },
  });
});
it('retains the original create intent across reopen and ignores its late successful response', async () => {
  let originalId = '',
    finish!: (value: unknown) => void;
  const { api, calls } = setup((call) => {
      if (call.method === 'automation/create') {
        originalId = call.operationId!;
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      if (call.method === 'operation/read')
        return {
          operationId: originalId,
          method: 'automation/create',
          state: 'accepted',
          result: { id: job.id, revision: 1 },
        };
    }),
    props = formProps(api);
  let view = render(<AutomationForm {...props} />);
  await prepareForm();
  fireEvent.click(screen.getByRole('checkbox', { name: /确认保存计划/ }));
  fireEvent.click(screen.getByRole('button', { name: '创建暂停的计划' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  view.unmount();
  view = render(<AutomationForm {...props} />);
  fireEvent.change(screen.getByRole('textbox', { name: '自动执行的指令' }), {
    target: { value: 'Edited after reopening' },
  });
  await act(async () => finish({ id: job.id, revision: 1 }));
  expect(props.onSaved).not.toHaveBeenCalled();
  fireEvent.click(await enabledButton({ name: '查询原自动化操作回执' }));
  await screen.findByText(/原版本已保存.*新草稿尚未提交/);
  expect(
    (screen.getByRole('textbox', { name: '自动执行的指令' }) as HTMLTextAreaElement).value,
  ).toBe('Edited after reopening');
  expect(calls.filter((call) => call.method === 'automation/create')).toHaveLength(1);
  expect(calls.find((call) => call.method === 'operation/read')?.params.operationId).toBe(
    originalId,
  );
});
it.each(['api', 'epoch', 'record'] as const)(
  'ignores a late recovery after %s ownership changes away and back',
  async (kind) => {
    let originalId = '',
      finish!: (value: unknown) => void;
    const { api } = setup((call) => {
        if (call.method === 'automation/update') {
          originalId = call.operationId!;
          throw new TypeError('response lost');
        }
        if (call.method === 'operation/read')
          return new Promise((resolve) => {
            finish = resolve;
          });
      }),
      props = { ...formProps(api), record: job, epoch: 'session-a' },
      otherApi = new Api();
    const view = render(<AutomationForm {...props} />);
    await prepareForm();
    fireEvent.click(screen.getByRole('checkbox', { name: /确认保存计划/ }));
    fireEvent.click(screen.getByRole('button', { name: '保存计划修改' }));
    fireEvent.click(await enabledButton({ name: '查询原自动化操作回执' }));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    view.rerender(
      <AutomationForm
        {...props}
        {...(kind === 'api'
          ? { api: otherApi }
          : kind === 'epoch'
            ? { epoch: 'session-b' }
            : { record: { ...job, id: 'job-two' } })}
      />,
    );
    view.rerender(<AutomationForm {...props} />);
    fireEvent.change(screen.getByRole('textbox', { name: '自动执行的指令' }), {
      target: { value: 'New visit draft' },
    });
    await act(async () =>
      finish({
        operationId: originalId,
        method: 'automation/update',
        state: 'accepted',
        result: { id: job.id, revision: 5, state: 'paused' },
      }),
    );
    expect(props.onSaved).not.toHaveBeenCalled();
    expect(
      (screen.getByRole('textbox', { name: '自动执行的指令' }) as HTMLTextAreaElement).value,
    ).toBe('New visit draft');
    expect(await enabledButton({ name: '查询原自动化操作回执' })).toBeTruthy();
  },
);
it.each([{}, { id: job.id }, { id: job.id, revision: 99 }])(
  'keeps a create blocked on an incomplete accepted result %j until its original receipt is valid',
  async (malformed) => {
    let originalId = '',
      valid = false;
    const { api, calls } = setup(async (call) => {
        if (call.method === 'automation/create') {
          originalId = call.operationId!;
          (await reconcileOperation(originalId, { state: 'accepted' }));
          throw new TypeError('response lost after accepted event');
        }
        if (call.method === 'operation/read')
          return {
            operationId: originalId,
            method: 'automation/create',
            state: 'accepted',
            result: valid ? { id: job.id, revision: 1 } : malformed,
          };
      }),
      props = formProps(api);
    render(<AutomationForm {...props} />);
    await prepareForm();
    fireEvent.click(screen.getByRole('checkbox', { name: /确认保存计划/ }));
    fireEvent.click(screen.getByRole('button', { name: '创建暂停的计划' }));
    fireEvent.click(await enabledButton({ name: '查询原自动化操作回执' }));
    await screen.findByText(/回执缺少有效.*标识或版本/);
    expect(props.onSaved).not.toHaveBeenCalled();
    expect(
      (screen.getByRole('button', { name: '创建暂停的计划' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    valid = true;
    fireEvent.click(await enabledButton({ name: '查询原自动化操作回执' }));
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledTimes(1));
    expect(props.onSaved).toHaveBeenCalledWith(job.id);
    expect(calls.filter((call) => call.method === 'automation/create')).toHaveLength(1);
  },
);
it('preserves both drafts if a recovered creation already has a separately edited plan draft', async () => {
  let originalId = '';
  const { api } = setup((call) => {
      if (call.method === 'automation/create') {
        originalId = call.operationId!;
        throw new TypeError('response lost');
      }
      if (call.method === 'operation/read')
        return {
          operationId: originalId,
          method: 'automation/create',
          state: 'accepted',
          result: { id: job.id, revision: 1 },
        };
    }),
    props = formProps(api),
    createdJob = { ...job, revision: 1 };
  const view = render(<AutomationForm {...props} />);
  await prepareForm();
  fireEvent.click(screen.getByRole('checkbox', { name: /确认保存计划/ }));
  fireEvent.click(screen.getByRole('button', { name: '创建暂停的计划' }));
  await enabledButton({ name: '查询原自动化操作回执' });
  fireEvent.change(screen.getByRole('textbox', { name: '自动执行的指令' }), {
    target: { value: 'Original form newer draft' },
  });
  view.rerender(<AutomationForm {...props} record={createdJob} />);
  fireEvent.change(screen.getByRole('textbox', { name: '自动执行的指令' }), {
    target: { value: 'Separately edited plan draft' },
  });
  view.rerender(<AutomationForm {...props} />);
  fireEvent.click(await enabledButton({ name: '查询原自动化操作回执' }));
  await screen.findByText(/已有另一份未保存草稿/);
  expect(props.onSaved).not.toHaveBeenCalled();
  expect(
    (screen.getByRole('textbox', { name: '自动执行的指令' }) as HTMLTextAreaElement).value,
  ).toBe('Original form newer draft');
  view.rerender(<AutomationForm {...props} record={createdJob} />);
  expect(
    (screen.getByRole('textbox', { name: '自动执行的指令' }) as HTMLTextAreaElement).value,
  ).toBe('Separately edited plan draft');
});
it('rejects foreign update receipts and only releases an intent on explicit not_sent evidence', async () => {
  let originalId = '',
    response: Record<string, unknown> = {};
  const { api, calls } = setup((call) => {
      if (call.method === 'automation/update') {
        originalId = call.operationId!;
        throw new TypeError('response lost');
      }
      if (call.method === 'operation/read') return response;
    }),
    props = formProps(api);
  render(<AutomationForm {...props} record={job} />);
  await prepareForm();
  fireEvent.click(screen.getByRole('checkbox', { name: /确认保存计划/ }));
  fireEvent.click(screen.getByRole('button', { name: '保存计划修改' }));
  await enabledButton({ name: '查询原自动化操作回执' });
  response = {
    operationId: originalId,
    method: 'automation/update',
    state: 'accepted',
    result: { id: 'other-job', revision: 5 },
  };
  fireEvent.click(await enabledButton({ name: '查询原自动化操作回执' }));
  await screen.findByText(/回执缺少有效.*标识或版本/);
  response = { operationId: 'foreign-operation', method: 'automation/update', state: 'not_sent' };
  fireEvent.click(await enabledButton({ name: '查询原自动化操作回执' }));
  await screen.findByText('操作回执身份不匹配。');
  expect((screen.getByRole('button', { name: '保存计划修改' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(props.onSaved).not.toHaveBeenCalled();
  response = { operationId: originalId, method: 'operation/retire', state: 'not_sent' };
  fireEvent.click(await enabledButton({ name: '查询原自动化操作回执' }));
  await screen.findByText(/已确认原操作未发送/);
  expect(screen.queryByRole('button', { name: '查询原自动化操作回执' })).toBeNull();
  expect(
    (screen.getByRole('textbox', { name: '自动执行的指令' }) as HTMLTextAreaElement).value,
  ).toBe('Review my project');
  expect((screen.getByRole('checkbox', { name: /确认保存计划/ }) as HTMLInputElement).checked).toBe(
    false,
  );
  expect(calls.filter((call) => call.method === 'automation/update')).toHaveLength(1);
});
it('enables only after displaying the server preview and explicit execution confirmation', async () => {
  const { api, calls } = setup();
  render(<AutomationDetail {...detailProps(api)} />);
  fireEvent.click(screen.getByRole('button', { name: '启用计划…' }));
  await screen.findByText('启用后将在服务端自动执行');
  await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(5));
  expect(calls.some((call) => call.method === 'automation/resume')).toBe(false);
  fireEvent.click(screen.getByRole('checkbox', { name: /确认执行此指令/ }));
  fireEvent.click(screen.getByRole('button', { name: '确认启用计划' }));
  await waitFor(() => expect(calls.some((call) => call.method === 'automation/resume')).toBe(true));
  expect(calls.find((call) => call.method === 'automation/resume')?.params).toEqual({
    id: job.id,
    expectedRevision: 4,
  });
});
it('separates pausing future triggers from stopping the actual run and opens its thread', async () => {
  const { api, calls } = setup((call) =>
      call.method === 'automation/runs' ? { data: [run], next: null } : undefined,
    ),
    props = detailProps(api);
  render(<AutomationDetail {...props} record={{ ...job, state: 'active' }} />);
  fireEvent.click(await screen.findByRole('button', { name: '查看运行会话' }));
  expect(props.onOpenThread).toHaveBeenCalledWith('thread-one');
  fireEvent.click(screen.getByRole('button', { name: '暂停未来触发' }));
  await screen.findByText('计划已暂停；已经开始的运行会继续，请在运行记录中单独停止。');
  expect(calls.filter((call) => call.method === 'automation/stop')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '停止本次运行' }));
  await waitFor(() =>
    expect(calls.find((call) => call.method === 'automation/stop')?.params).toEqual({
      runId: run.id,
    }),
  );
});
it('never repeats an unknown run and requires idle plus confirmation to close without success', async () => {
  const { api, calls } = setup((call) =>
      call.method === 'automation/runs'
        ? { data: [{ ...run, state: 'unknown' }], next: null }
        : undefined,
    ),
    props = detailProps(api);
  const view = render(<AutomationDetail {...props} idle={false} />);
  fireEvent.click(await screen.findByRole('checkbox', { name: /已核对结果/ }));
  expect(
    (screen.getByRole('button', { name: '关闭未知运行记录' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(screen.queryByRole('button', { name: '停止本次运行' })).toBeNull();
  expect(
    (screen.getByRole('button', { name: '立即运行一次…' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  view.rerender(<AutomationDetail {...props} idle />);
  fireEvent.click(screen.getByRole('button', { name: '关闭未知运行记录' }));
  await screen.findByText('未知记录已关闭；没有将本次运行标记为成功。');
  expect(calls.find((call) => call.method === 'automation/acknowledge')?.params).toEqual({
    runId: run.id,
    confirm: true,
  });
  expect(calls.some((call) => call.method === 'automation/run')).toBe(false);
});
it('preserves loaded run pages on refresh and discards responses from a previous automation', async () => {
  let oldState = 'running',
    release!: (value: unknown) => void;
  const { api, calls } = setup((call) =>
    call.method === 'automation/runs'
      ? call.params.id === 'pending-job'
        ? new Promise((done) => {
            release = done;
          })
        : call.params.before
          ? { data: [{ ...run, id: 'older', state: oldState }], next: null }
          : { data: [{ ...run, id: 'newest' }], next: 50 }
      : undefined,
  );
  const { result, rerender } = renderHook(({ id }) => useAutomationRuns(api, id, 'epoch', true), {
    initialProps: { id: job.id },
  });
  await waitFor(() => expect(result.current.items).toHaveLength(1));
  await act(async () => {
    await result.current.more();
  });
  expect(result.current.items).toHaveLength(2);
  oldState = 'completed';
  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.items.find((item) => item.id === 'older')?.state).toBe('completed');
  expect(calls.filter((call) => call.params.before === 50)).toHaveLength(2);
  rerender({ id: 'pending-job' });
  await waitFor(() => expect(release).toBeTypeOf('function'));
  rerender({ id: job.id });
  await waitFor(() => expect(result.current.items).toHaveLength(1));
  await act(async () =>
    release({ data: [{ ...run, automationId: 'pending-job', id: 'foreign' }], next: null }),
  );
  expect(result.current.items.some((item) => item.id === 'foreign')).toBe(false);
});
