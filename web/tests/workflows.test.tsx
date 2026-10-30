// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { Events } from '../lib/events';
import { createOperation, listOperations, updateOperation } from '../lib/operations';
import { branchDraftKey, emptyDraft, readDraft, writeDraft } from '../lib/drafts';
import { agentTreeRows, executionOptions, type CollaborationModeMask } from '../lib/workflows';
import { TaskPanel } from '../components/TaskPanel';
import { BranchDialog, HistoryTools, ReviewDialog } from '../components/HistoryTools';
import { Composer } from '../components/Composer';
import { Messages } from '../components/Messages';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const goal = {
  threadId: 't',
  objective: 'Finish the task',
  status: 'paused',
  tokenBudget: 9000,
  tokensUsed: 150,
  timeUsedSeconds: 12,
  createdAt: 1,
  updatedAt: 1,
};
const queued = (id: string, text: string) => ({
  id,
  text,
  clientUserMessageId: `client-${id}`,
  input: [{ type: 'text', text, text_elements: [] }],
  attachments: [],
});
const taskProps = (api: Api) => ({
  api,
  threadId: 't',
  epoch: 'one',
  enabled: true,
  active: false,
  events: new Events(),
  onClose: vi.fn(),
  onChanged: vi.fn(),
  onOpenThread: vi.fn(),
});
const turn = {
  id: 'turn-1',
  status: 'completed',
  items: [
    {
      id: 'item-1',
      type: 'userMessage',
      content: [{ type: 'text', text: 'Original instruction' }],
    },
  ],
};
const branchProps = (api: Api) => ({
  api,
  threadId: 't',
  enabled: true,
  onClose: vi.fn(),
  onChanged: vi.fn(),
  onFork: vi.fn().mockReturnValue(true),
  onDraft: vi.fn(),
  turn,
  action: 'edit' as const,
});

it('uses catalogue modes and resolves native settings without inventing a model', () => {
  const modes: CollaborationModeMask[] = [
    { name: 'Plan', mode: 'plan', model: null, reasoning_effort: 'medium' },
  ];
  expect(
    executionOptions({ mode: 'plan', effort: 'high' }, { model: 'configured' }, modes),
  ).toEqual({
    effort: 'high',
    collaborationMode: {
      mode: 'plan',
      settings: { model: 'configured', reasoning_effort: 'high', developer_instructions: null },
    },
  });
  expect(() => executionOptions({ mode: 'plan' }, {}, modes)).toThrow(/默认模型/);
  expect(() => executionOptions({ mode: 'default' }, { model: 'configured' }, modes)).toThrow(
    /模式/,
  );
});
it('offers explicit steering and queue intent while a turn runs and keeps stop separate', async () => {
  const send = vi.fn().mockResolvedValue(true),
    stop = vi.fn();
  render(
    <Composer
      api={{} as Api}
      contextKey="t"
      existingThread
      value="Follow up"
      onChange={vi.fn()}
      onSend={send}
      onStop={stop}
      busy={false}
      disabled={false}
      active
      canSteer
      options={{}}
      onOptions={vi.fn()}
      models={[]}
      defaults={{}}
      defaultsLoading={false}
      notice=""
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '加入队列' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith([], 'queue'));
  fireEvent.change(screen.getByRole('combobox', { name: '当前发送方式' }), {
    target: { value: 'steer' },
  });
  fireEvent.keyDown(screen.getByRole('textbox', { name: '给 Codex 的消息' }), { key: 'Enter' });
  await waitFor(() => expect(send).toHaveBeenLastCalledWith([], 'steer'));
  fireEvent.click(screen.getByRole('button', { name: '停止当前回合' }));
  expect(stop).toHaveBeenCalledOnce();
});
it('edits queued text while preserving omitted attachment identities and sends a complete reorder', async () => {
  const entries = [
    {
      ...queued('a', 'First'),
      attachments: [
        { attachmentId: 'attachment-a', name: 'context.txt', size: 10, mimeType: 'text/plain' },
      ],
    },
    queued('b', 'Second'),
  ];
  const call = vi.fn().mockResolvedValue({ data: entries, nextCursor: null }),
    mutate = vi.fn().mockResolvedValue({ queuedSubmission: { id: 'a' } });
  render(<TaskPanel {...taskProps({ call, mutate } as unknown as Api)} />);
  await screen.findByText('First');
  fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]!);
  fireEvent.change(screen.getByRole('textbox', { name: '修改队列消息' }), {
    target: { value: 'Changed' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  await waitFor(() =>
    expect(mutate).toHaveBeenCalledWith('thread/queue/update', {
      threadId: 't',
      queuedSubmissionId: 'a',
      text: 'Changed',
    }),
  );
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '下移待办 1' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: '下移待办 1' }));
  await waitFor(() =>
    expect(mutate).toHaveBeenCalledWith('thread/queue/reorder', {
      threadId: 't',
      queuedSubmissionIds: ['b', 'a'],
    }),
  );
});
it('does not reorder a partial queue or start a queue while a turn runs', async () => {
  const call = vi.fn().mockResolvedValue({
      data: [queued('a', 'First'), queued('b', 'Second')],
      nextCursor: 'more',
    }),
    mutate = vi.fn();
  render(<TaskPanel {...taskProps({ call, mutate } as unknown as Api)} active />);
  await screen.findByText('First');
  expect((screen.getByRole('button', { name: '下移待办 1' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  screen
    .getAllByRole('button', { name: '立即执行此条' })
    .forEach((button) => expect((button as HTMLButtonElement).disabled).toBe(true));
  expect(mutate).not.toHaveBeenCalled();
});
it('blocks queue mutations behind an unresolved operation without silently retrying', async () => {
  const op = (await createOperation('thread/queue/start', { threadId: 't' }));
  (await updateOperation(op.id, 'unknown'));
  const call = vi.fn().mockResolvedValue({ data: [queued('a', 'First')], nextCursor: null }),
    mutate = vi.fn();
  render(<TaskPanel {...taskProps({ call, mutate } as unknown as Api)} />);
  await screen.findByText('First');
  await waitFor(() => expect((screen.getByRole('button', { name: '删除' }) as HTMLButtonElement).disabled).toBe(true));
  expect(mutate).not.toHaveBeenCalled();
  expect((await listOperations())[0]?.state).toBe('unknown');
});
it('sets only an explicitly selected goal budget and marks continuation as user intent', async () => {
  const call = vi
      .fn()
      .mockImplementation((method: string) =>
        Promise.resolve(method === 'thread/goal/get' ? { goal } : { data: [], nextCursor: null }),
      ),
    mutate = vi.fn().mockResolvedValue({ goal });
  render(<TaskPanel {...taskProps({ call, mutate } as unknown as Api)} />);
  fireEvent.click(screen.getByRole('button', { name: '目标与预算' }));
  fireEvent.click(await screen.findByRole('button', { name: '继续目标（可能启动任务）' }));
  await waitFor(() =>
    expect(mutate).toHaveBeenCalledWith('thread/goal/set', {
      threadId: 't',
      origin: 'user',
      status: 'active',
    }),
  );
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: '修改目标与预算' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: '修改目标与预算' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '设置 token 总预算' }));
  fireEvent.click(screen.getByRole('button', { name: '保存目标' }));
  await waitFor(() =>
    expect(mutate).toHaveBeenLastCalledWith('thread/goal/set', {
      threadId: 't',
      origin: 'user',
      objective: goal.objective,
      tokenBudget: null,
    }),
  );
});
it.each(['queue', 'goal'] as const)(
  'locks the pending %s editor and cancel action, rejects duplicate submits, and preserves failed edits',
  async (kind) => {
    let reject!: (reason: Error) => void;
    const mutate = vi.fn().mockImplementation(
      () =>
        new Promise((_done, fail) => {
          reject = fail;
        }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init: RequestInit) => {
        const request = JSON.parse(String(init.body));
        const result = request.operationId
          ? await mutate(request.method, request.params)
          : request.method === 'thread/goal/get'
            ? { goal }
            : { data: [queued('a', 'First')], nextCursor: null };
        return { status: 200, ok: true, json: async () => ({ ok: true, result }) };
      }),
    );
    render(<TaskPanel {...taskProps(new Api())} />);
    if (kind === 'queue') {
      fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    } else {
      fireEvent.click(screen.getByRole('button', { name: '目标与预算' }));
      fireEvent.click(await screen.findByRole('button', { name: '修改目标与预算' }));
    }
    const input = screen.getByRole('textbox', {
      name: kind === 'queue' ? '修改队列消息' : '目标',
    }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'submitted draft' } });
    act(() => {
      fireEvent.submit(input.form!);
      fireEvent.submit(input.form!);
    });
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(input.matches(':disabled')).toBe(true);
    const cancel = screen.getByRole('button', { name: '取消编辑' });
    expect(cancel.matches(':disabled')).toBe(true);
    fireEvent.click(cancel);
    expect(input.isConnected).toBe(true);
    if (kind === 'goal') {
      expect(screen.getByRole('checkbox', { name: '设置 token 总预算' }).matches(':disabled')).toBe(
        true,
      );
      expect(screen.getByRole('textbox', { name: 'Token 总预算' }).matches(':disabled')).toBe(true);
      expect(
        (screen.getByRole('button', { name: '修改目标与预算' }) as HTMLButtonElement).disabled,
      ).toBe(true);
    }
    await act(async () => reject(new Error('edit rejected')));
    await screen.findByText('edit rejected');
    expect(input.matches(':disabled')).toBe(false);
    expect(input.value).toBe('submitted draft');
    expect(cancel.matches(':disabled')).toBe(false);
    expect((await listOperations()).some((operation) => operation.state === 'unknown')).toBe(true);
    if (kind === 'goal')
      expect(
        (screen.getByRole('textbox', { name: 'Token 总预算' }) as HTMLInputElement).value,
      ).toBe('9000');
    fireEvent.change(input, { target: { value: 'corrected draft' } });
    expect(input.value).toBe('corrected draft');
    expect(mutate).toHaveBeenCalledTimes(1);
  },
);
it('does not close a different task editor after an unmounted queue request completes', async () => {
  let resolve!: (value: unknown) => void;
  const call = vi
    .fn()
    .mockImplementation((method: string) =>
      Promise.resolve(
        method === 'thread/goal/get'
          ? { goal }
          : { data: [queued('a', 'First')], nextCursor: null },
      ),
    );
  const mutate = vi.fn().mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const props = taskProps({ call, mutate } as unknown as Api),
    view = render(<TaskPanel key="first-thread" {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
  await waitFor(() => expect(resolve).toBeTypeOf('function'));
  view.rerender(<TaskPanel key="second-thread" {...props} threadId="second-thread" />);
  fireEvent.click(screen.getByRole('button', { name: '目标与预算' }));
  fireEvent.click(await screen.findByRole('button', { name: '修改目标与预算' }));
  const input = screen.getByRole('textbox', { name: '目标' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'another thread draft' } });
  await act(async () => resolve({ queuedSubmission: { id: 'a' } }));
  expect(input.isConnected).toBe(true);
  expect(input.value).toBe('another thread draft');
  expect(mutate).toHaveBeenCalledTimes(1);
});
it('retains an unsaved sibling queue draft across a delayed post-save directory refresh', async () => {
  let finish!: (value: unknown) => void;
  const entries = [queued('a', 'First'), queued('b', 'Second')];
  const call = vi
      .fn()
      .mockResolvedValueOnce({ data: entries, nextCursor: null })
      .mockImplementation(
        () =>
          new Promise((done) => {
            finish = done;
          }),
      ),
    mutate = vi.fn().mockResolvedValue({});
  render(<TaskPanel {...taskProps({ call, mutate } as unknown as Api)} />);
  await screen.findByText('First');
  fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]!);
  fireEvent.click(screen.getByRole('button', { name: '编辑' }));
  const inputs = screen.getAllByRole('textbox', { name: '修改队列消息' });
  fireEvent.change(inputs[1]!, { target: { value: 'unsaved sibling draft' } });
  fireEvent.click(screen.getAllByRole('button', { name: '保存修改' })[0]!);
  const retained = (await screen.findByRole('textbox', {
    name: '保留的队列草稿（b）',
  })) as HTMLTextAreaElement;
  expect(retained.value).toBe('unsaved sibling draft');
  expect(screen.queryByRole('button', { name: '保存修改' })).toBeNull();
  expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
  await act(async () => finish({ data: entries, nextCursor: null }));
  expect((screen.getByRole('textbox', { name: '修改队列消息' }) as HTMLTextAreaElement).value).toBe(
    'unsaved sibling draft',
  );
  expect(mutate).toHaveBeenCalledTimes(1);
});
it.each(['failed', 'missing'] as const)(
  'keeps an explicit queue draft without stale mutation controls when refresh is %s',
  async (outcome) => {
    let finish!: (value: unknown) => void, reject!: (reason: Error) => void;
    const entries = [queued('a', 'First')];
    const call = vi
        .fn()
        .mockResolvedValueOnce({ data: entries, nextCursor: null })
        .mockImplementationOnce(
          () =>
            new Promise((done, fail) => {
              finish = done;
              reject = fail;
            }),
        )
        .mockResolvedValue({ data: entries, nextCursor: null }),
      mutate = vi.fn();
    render(<TaskPanel {...taskProps({ call, mutate } as unknown as Api)} />);
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByRole('textbox', { name: '修改队列消息' }), {
      target: { value: 'retained despite refresh' },
    });
    fireEvent.click(screen.getByRole('button', { name: '刷新队列' }));
    await screen.findByRole('textbox', { name: '保留的队列草稿（a）' });
    await act(async () => {
      if (outcome === 'failed') reject(new Error('directory unavailable'));
      else finish({ data: [], nextCursor: null });
    });
    const retained = screen.getByRole('textbox', {
      name: '保留的队列草稿（a）',
    }) as HTMLTextAreaElement;
    expect(retained.value).toBe('retained despite refresh');
    expect(screen.getByText(/当前已读取的队列中未找到待办 a/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '保存修改' })).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
    if (outcome === 'failed') {
      fireEvent.click(screen.getByRole('button', { name: '刷新队列' }));
      expect(
        ((await screen.findByRole('textbox', { name: '修改队列消息' })) as HTMLTextAreaElement)
          .value,
      ).toBe('retained despite refresh');
    }
  },
);
it.each(['thread', 'epoch'] as const)(
  'isolates retained queue drafts and delayed reads when the %s owner changes',
  async (owner) => {
    let finish!: (value: unknown) => void;
    const call = vi
        .fn()
        .mockResolvedValueOnce({ data: [queued('a', 'Old owner')], nextCursor: null })
        .mockImplementationOnce(
          () =>
            new Promise((done) => {
              finish = done;
            }),
        )
        .mockResolvedValue({ data: [queued('a', 'New owner')], nextCursor: null }),
      mutate = vi.fn();
    const props = taskProps({ call, mutate } as unknown as Api),
      view = render(<TaskPanel {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByRole('textbox', { name: '修改队列消息' }), {
      target: { value: 'private old-owner draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: '刷新队列' }));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    view.rerender(
      <TaskPanel
        {...props}
        {...(owner === 'thread' ? { threadId: 'other' } : { epoch: 'next' })}
      />,
    );
    await screen.findByText('New owner');
    await act(async () => finish({ data: [queued('a', 'Late old owner')], nextCursor: null }));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText('Late old owner')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    expect(
      (screen.getByRole('textbox', { name: '修改队列消息' }) as HTMLTextAreaElement).value,
    ).toBe('New owner');
    expect(mutate).not.toHaveBeenCalled();
  },
);
it.each([
  { count: 33, size: 1, retained: 32 },
  { count: 11, size: 100000, retained: 10 },
])(
  'bounds retained queue drafts at $retained for count/size $count/$size',
  async ({ count, size, retained }) => {
    const entries = Array.from({ length: count }, (_, index) => queued(String(index), 'x'));
    const call = vi.fn().mockResolvedValue({ data: entries, nextCursor: null });
    render(<TaskPanel {...taskProps({ call, mutate: vi.fn() } as unknown as Api)} />);
    await screen.findAllByRole('button', { name: '编辑' });
    for (let index = 0; index < count; index++) {
      fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]!);
      if (index < retained)
        fireEvent.change(screen.getAllByRole('textbox', { name: '修改队列消息' })[index]!, {
          target: { value: 'x'.repeat(size) },
        });
    }
    expect(screen.getAllByRole('textbox', { name: '修改队列消息' })).toHaveLength(retained);
    expect(screen.getByText(/队列编辑最多保留 32 份/)).toBeTruthy();
  },
);
it.each(['queue', 'goal'] as const)(
  'retains unsaved %s text and budget across task tabs without submitting a mutation',
  async (kind) => {
    const call = vi.fn(async (method: string) =>
        method === 'thread/goal/get'
          ? { goal }
          : { data: method === 'thread/queue/list' ? [queued('a', 'First'), queued('b', 'Second')] : [], nextCursor: null },
      ),
      mutate = vi.fn();
    render(<TaskPanel {...taskProps({ call, mutate } as unknown as Api)} />);
    await screen.findByText('First');
    if (kind === 'queue') {
      fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]!);
      fireEvent.click(screen.getByRole('button', { name: '编辑' }));
      screen.getAllByRole('textbox', { name: '修改队列消息' }).forEach((input, index) =>
        fireEvent.change(input, { target: { value: 'unsaved instruction ' + index } }),
      );
      fireEvent.click(screen.getByRole('button', { name: '目标与预算' }));
      await screen.findByText(goal.objective);
    } else {
      fireEvent.click(screen.getByRole('button', { name: '目标与预算' }));
      fireEvent.click(await screen.findByRole('button', { name: '修改目标与预算' }));
      fireEvent.change(screen.getByRole('textbox', { name: '目标' }), {
        target: { value: 'unsaved objective' },
      });
      fireEvent.change(screen.getByRole('textbox', { name: 'Token 总预算' }), {
        target: { value: '31415' },
      });
      fireEvent.click(screen.getByRole('button', { name: '消息队列' }));
      await screen.findByText('First');
    }
    fireEvent.click(screen.getByRole('button', { name: 'Agents' }));
    await screen.findByText('没有已记录的子 Agent。');
    fireEvent.click(screen.getByRole('button', { name: kind === 'queue' ? '消息队列' : '目标与预算' }));
    if (kind === 'queue') {
      const inputs = await screen.findAllByRole('textbox', { name: '修改队列消息' });
      expect(inputs.map((input) => (input as HTMLTextAreaElement).value)).toEqual([
        'unsaved instruction 0', 'unsaved instruction 1',
      ]);
    } else {
      expect((screen.getByRole('textbox', { name: '目标' }) as HTMLTextAreaElement).value).toBe('unsaved objective');
      expect((screen.getByRole('textbox', { name: 'Token 总预算' }) as HTMLInputElement).value).toBe('31415');
      expect((screen.getByRole('checkbox', { name: '设置 token 总预算' }) as HTMLInputElement).checked).toBe(true);
    }
    expect(mutate).not.toHaveBeenCalled();
  },
);
it('loads task tabs only when visited and suspends hidden reads until the next visit', async () => {
  const call = vi.fn(async (method: string, _params: unknown, _signal?: AbortSignal) =>
      method === 'thread/goal/get'
        ? { goal }
        : { data: method === 'thread/queue/list' ? [queued('a', 'First')] : [], nextCursor: null },
    ),
    mutate = vi.fn(),
    props = taskProps({ call, mutate } as unknown as Api);
  render(<TaskPanel {...props} />);
  await screen.findByText('First');
  expect(call.mock.calls.map(([method]) => method)).toEqual(['thread/queue/list']);
  const firstRead = call.mock.calls[0]![2];
  fireEvent.click(screen.getByRole('button', { name: '目标与预算' }));
  await screen.findByText(goal.objective);
  expect(firstRead?.aborted).toBe(true);
  expect(call.mock.calls.map(([method]) => method)).toEqual(['thread/queue/list', 'thread/goal/get']);
  expect(screen.getByRole('button', { name: '刷新队列', hidden: true }).closest('[hidden]')?.hasAttribute('inert')).toBe(true);
  act(() => props.events.publish({
    type: 'notification', data: { method: 'thread/queue/changed', params: { threadId: 't' } },
  }));
  await waitFor(() => expect(call.mock.calls.filter(([method]) => method === 'thread/goal/get')).toHaveLength(2));
  expect(call.mock.calls.filter(([method]) => method === 'thread/queue/list')).toHaveLength(1);
  expect(call.mock.calls.some(([method]) => method === 'thread/agents/list')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '消息队列' }));
  await screen.findByText('First');
  expect(call.mock.calls.filter(([method]) => method === 'thread/queue/list')).toHaveLength(2);
  expect(call.mock.calls.filter(([method]) => method === 'thread/goal/get')).toHaveLength(2);
  expect(screen.getByRole('button', { name: '刷新目标', hidden: true }).closest('[hidden]')?.hasAttribute('inert')).toBe(true);
  expect(mutate).not.toHaveBeenCalled();
});
it.each(['thread', 'epoch', 'api'] as const)(
  'starts fresh task drafts when the %s owner changes, including while the goal tab is open',
  async (owner) => {
    const call = vi.fn(async (method: string) =>
        method === 'thread/goal/get' ? { goal } : { data: [queued('a', 'First')], nextCursor: null },
      ),
      mutate = vi.fn(),
      props = taskProps({ call, mutate } as unknown as Api),
      view = render(<TaskPanel {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByRole('textbox', { name: '修改队列消息' }), {
      target: { value: 'private queue draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: '目标与预算' }));
    fireEvent.click(await screen.findByRole('button', { name: '修改目标与预算' }));
    fireEvent.change(screen.getByRole('textbox', { name: '目标' }), {
      target: { value: 'private goal draft' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Token 总预算' }), {
      target: { value: '31415' },
    });
    view.rerender(<TaskPanel {...props} {...(
      owner === 'thread' ? { threadId: 'other' }
        : owner === 'epoch' ? { epoch: 'next' }
          : { api: { call, mutate } as unknown as Api }
    )} />);
    await screen.findByText('First');
    expect(screen.queryByDisplayValue('private queue draft')).toBeNull();
    expect(screen.queryByDisplayValue('private goal draft')).toBeNull();
    expect(screen.queryByDisplayValue('31415')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '目标与预算' }));
    fireEvent.click(await screen.findByRole('button', { name: '修改目标与预算' }));
    expect((screen.getByRole('textbox', { name: '目标' }) as HTMLTextAreaElement).value).toBe(goal.objective);
    expect((screen.getByRole('textbox', { name: 'Token 总预算' }) as HTMLInputElement).value).toBe('9000');
    expect(mutate).not.toHaveBeenCalled();
  },
);
it.each([
  { kind: 'queue', outcome: 'accepted' }, { kind: 'goal', outcome: 'accepted' },
  { kind: 'queue', outcome: 'unknown' }, { kind: 'goal', outcome: 'unknown' },
] as const)('keeps a pending $kind edit owned across tabs when its result is $outcome', async ({ kind, outcome }) => {
  let finish!: (value: unknown) => void, fail!: (error: Error) => void;
  let saved = false;
  const requests: { method: string; params: Record<string, unknown>; operationId?: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    requests.push(request);
    let result: unknown;
    if (request.operationId) {
      result = await new Promise((resolve, reject) => { finish = resolve; fail = reject; });
      saved = true;
    } else if (request.method === 'operation/read') {
      const write = requests.find((item) => item.operationId)!;
      result = { operationId: write.operationId, method: write.method, state: 'unknown' };
    } else if (request.method === 'thread/goal/get') {
      result = { goal: saved ? { ...goal, objective: 'submitted draft' } : goal };
    } else {
      result = { data: request.method === 'thread/queue/list' ? [queued('a', saved ? 'submitted draft' : 'First')] : [], nextCursor: null };
    }
    return { status: 200, ok: true, json: async () => ({ ok: true, result }) };
  }));
  const api = new Api();
  render(<TaskPanel {...taskProps(api)} />);
  if (kind === 'queue') fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
  else {
    fireEvent.click(screen.getByRole('button', { name: '目标与预算' }));
    fireEvent.click(await screen.findByRole('button', { name: '修改目标与预算' }));
  }
  const label = kind === 'queue' ? '修改队列消息' : '目标';
  const input = screen.getByRole('textbox', { name: label }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'submitted draft' } });
  fireEvent.submit(input.form!);
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  const originalId = requests.find((request) => request.operationId)!.operationId!;
  fireEvent.click(screen.getByRole('button', { name: 'Agents' }));
  await screen.findByText('没有已记录的子 Agent。');
  await act(async () => {
    if (outcome === 'accepted') finish({});
    else fail(new Error('edit response lost'));
  });
  fireEvent.click(screen.getByRole('button', { name: kind === 'queue' ? '消息队列' : '目标与预算' }));
  if (outcome === 'accepted') {
    await screen.findByText('submitted draft');
    await waitFor(() => expect(screen.queryByRole('textbox', { name: label })).toBeNull());
  } else {
    const retained = await screen.findByRole('textbox', { name: label }) as HTMLTextAreaElement;
    expect(retained.value).toBe('submitted draft');
    await screen.findByText('edit response lost');
    expect((await listOperations()).find((operation) => operation.id === originalId)?.state).toBe('unknown');
    await api.call('operation/read', { operationId: originalId });
    expect(requests.filter((request) => request.method === 'operation/read').map((request) => request.params)).toEqual([{ operationId: originalId }]);
  }
  expect(requests.filter((request) => request.operationId)).toHaveLength(1);
});
it('uses native ancestry and direct-input capability without inventing controls', async () => {
  const agents = [
    {
      id: 'child',
      name: 'Child',
      parentThreadId: 't',
      canAcceptDirectInput: false,
      status: { type: 'active' },
    },
    { id: 'grandchild', name: 'Nested', parentThreadId: 'child', canAcceptDirectInput: null },
  ];
  expect(agentTreeRows(agents).map((row) => [row.thread.id, row.depth])).toEqual([
    ['child', 0],
    ['grandchild', 1],
  ]);
  const call = vi
      .fn()
      .mockImplementation((method: string) =>
        Promise.resolve({ data: method === 'thread/agents/list' ? agents : [], nextCursor: null }),
      ),
    props = taskProps({ call, mutate: vi.fn() } as unknown as Api);
  render(<TaskPanel {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Agents' }));
  await screen.findByText('Child');
  expect(screen.queryByRole('button', { name: '停止此 Agent' })).toBeNull();
  expect(screen.queryByRole('button', { name: '打开并继续' })).toBeNull();
  fireEvent.click(screen.getAllByRole('button', { name: '查看结果' })[0]!);
  expect(props.onOpenThread).toHaveBeenCalledWith('child');
});
it('forks before an edited message, preserves the source draft and never automatically starts a turn', async () => {
  const mutate = vi.fn().mockResolvedValue({ thread: { id: 'new-child' } }),
    props = branchProps({ mutate } as unknown as Api);
  props.onFork.mockReturnValueOnce(false);
  render(<BranchDialog {...props} />);
  fireEvent.change(screen.getByRole('textbox', { name: '新分支的消息草稿' }), {
    target: { value: 'Edited instruction' },
  });
  await waitFor(() =>
    expect(readDraft(branchDraftKey('t', turn.id)).text).toBe('Edited instruction'),
  );
  fireEvent.click(screen.getByRole('button', { name: '创建分支并保存草稿' }));
  await waitFor(() => expect(props.onFork).toHaveBeenCalledWith('new-child', 'Edited instruction'));
  expect(mutate).toHaveBeenCalledWith('thread/fork', { threadId: 't', beforeTurnId: turn.id });
  expect(props.onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '保存草稿并打开已有分支' }));
  await waitFor(() => expect(props.onClose).toHaveBeenCalledOnce());
  expect(mutate).toHaveBeenCalledOnce();
});
it('distinguishes automatic branch completion from explicit retry without creating again', async () => {
  const mutate = vi.fn().mockResolvedValue({ thread: { id: 'child' } }),
    props = branchProps({ mutate } as unknown as Api),
    created = vi.fn().mockReturnValue(false);
  render(<BranchDialog {...props} onCreatedFork={created} />);
  fireEvent.click(screen.getByRole('button', { name: '创建分支并保存草稿' }));
  await waitFor(() => expect(created).toHaveBeenCalledWith('child', 'Original instruction'));
  expect(props.onFork).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '保存草稿并打开已有分支' }));
  await waitFor(() => expect(props.onFork).toHaveBeenCalledWith('child', 'Original instruction'));
  expect(created).toHaveBeenCalledOnce();
  expect(mutate).toHaveBeenCalledOnce();
});
it('retains a fork receipt and does not navigate after the dialog ownership ends', async () => {
  let finish!: (value: unknown) => void;
  const mutate = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    ),
    props = branchProps({ mutate } as unknown as Api);
  const view = render(<BranchDialog {...props} />);
  fireEvent.click(screen.getByRole('button', { name: '创建分支并保存草稿' }));
  view.unmount();
  await act(async () => finish({ thread: { id: 'late-child' } }));
  expect(props.onFork).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
});
it('uses accepted creation proof after a lost HTTP response without creating another branch', async () => {
  const api = new Api(),
    requests: Record<string, unknown>[] = [],
    props = branchProps(api);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      requests.push(request);
      (await updateOperation(request.operationId, 'accepted', 'proven-child'));
      return Promise.reject(new Error('response lost'));
    }),
  );
  render(<BranchDialog {...props} />);
  fireEvent.click(screen.getByRole('button', { name: '创建分支并保存草稿' }));
  await waitFor(() =>
    expect(props.onFork).toHaveBeenCalledWith('proven-child', 'Original instruction'),
  );
  expect(requests).toHaveLength(1);
  expect((await listOperations())[0]?.resolvedThreadId).toBe('proven-child');
});
it('recovers a later accepted branch only through the recorded identity', async () => {
  const api = new Api(),
    props = branchProps(api);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('response lost')));
  render(<BranchDialog {...props} />);
  fireEvent.click(screen.getByRole('button', { name: '创建分支并保存草稿' }));
  await waitFor(async () => expect((await listOperations())[0]?.state).toBe('unknown'));
  expect(
    (await screen.findByRole('button', { name: '创建分支并保存草稿' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await act(async () => (await updateOperation((await listOperations())[0]!.id, 'accepted', 'later-child')));
  fireEvent.click(await screen.findByRole('button', { name: '保存草稿并打开已有分支' }));
  expect(props.onFork).toHaveBeenCalledWith('later-child', 'Original instruction');
  expect(fetch).toHaveBeenCalledOnce();
});
it('preserves a corrupt branch draft without overwriting it or dispatching a mutation', () => {
  const key = 'harness.draft.v1.' + encodeURIComponent(branchDraftKey('t', turn.id));
  sessionStorage.setItem(key, '{broken');
  const mutate = vi.fn();
  render(<BranchDialog {...branchProps({ mutate } as unknown as Api)} />);
  expect(screen.getByRole('alert').textContent).toContain('未覆盖');
  expect(sessionStorage.getItem(key)).toBe('{broken');
  expect(
    (screen.getByRole('button', { name: '创建分支并保存草稿' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(mutate).not.toHaveBeenCalled();
});
it('requires explicit history-only revert intent and requests a fresh full read', async () => {
  const mutate = vi.fn().mockResolvedValue({ thread: { id: 't', turns: [] } }),
    props = branchProps({ mutate } as unknown as Api);
  render(<BranchDialog {...props} action="revert" />);
  const button = screen.getByRole('button', { name: '仅回退会话历史' });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(button);
  await waitFor(() =>
    expect(mutate).toHaveBeenCalledWith('thread/revert', { threadId: 't', beforeTurnId: turn.id }),
  );
  expect(props.onChanged).toHaveBeenCalledOnce();
});
it('submits an explicit review target and uses an independent review thread only when selected', async () => {
  const mutate = vi.fn().mockResolvedValue({ reviewThreadId: 'review-child' }),
    open = vi.fn();
  render(
    <ReviewDialog
      api={{ mutate } as unknown as Api}
      threadId="t"
      projectId="project"
      enabled
      onClose={vi.fn()}
      onChanged={vi.fn()}
      onOpenThread={open}
    />,
  );
  fireEvent.change(screen.getByRole('combobox', { name: '审查范围' }), {
    target: { value: 'baseBranch' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: '基准分支' }), {
    target: { value: 'release' },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: '在项目的新会话中审查' }));
  fireEvent.click(screen.getByRole('button', { name: '开始审查' }));
  await waitFor(() =>
    expect(mutate).toHaveBeenCalledWith('review/startNew', {
      projectId: 'project',
      target: { type: 'baseBranch', branch: 'release' },
    }),
  );
  expect(open).toHaveBeenCalledWith('review-child');
});
it('routes new review completion separately from explicit opening of a recovered review', async () => {
  const api = new Api(), created = vi.fn(), open = vi.fn(),
    fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, result: { reviewThreadId: 'review-child' } }) });
  vi.stubGlobal('fetch', fetcher);
  const props = { api, threadId: 't', projectId: 'project', enabled: true, initialSeparate: true,
    onClose: vi.fn(), onChanged: vi.fn(), onOpenThread: open, onCreatedThread: created };
  const view = render(<ReviewDialog {...props} />);
  fireEvent.click(screen.getByRole('button', { name: '开始审查' }));
  await waitFor(() => expect(created).toHaveBeenCalledWith('review-child'));
  expect(open).not.toHaveBeenCalled();
  view.unmount();
  fetcher.mockRejectedValue(new Error('response lost'));
  render(<ReviewDialog {...props} />);
  fireEvent.click(screen.getByRole('button', { name: '开始审查' }));
  await waitFor(async () => expect((await listOperations()).some(op => op.state === 'unknown')).toBe(true));
  const pending = (await listOperations()).find(op => op.state === 'unknown')!;
  await act(async () => updateOperation(pending.id, 'accepted', 'recovered-review'));
  fireEvent.click(await screen.findByRole('button', { name: '打开已受理的审查' }));
  expect(open).toHaveBeenCalledWith('recovered-review');
  expect(created).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('locates a search hit in an isolated partial window without issuing continuation history reads', async () => {
  const hit = {
    turnId: turn.id,
    itemId: 'item-1',
    snippet: 'Original instruction',
    snippetMatchRange: { start: 0, end: 8 },
    turnCursor: 'native-window',
  };
  const call = vi
    .fn()
    .mockImplementation((method: string) =>
      Promise.resolve(
        method === 'thread/searchOccurrences'
          ? { data: [hit], nextCursor: null }
          : { partial: true, complete: false, turns: [turn] },
      ),
    );
  render(
    <HistoryTools
      api={{ call } as unknown as Api}
      threadId="t"
      epoch="one"
      turns={[]}
      onClose={vi.fn()}
      onLocate={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByRole('searchbox', { name: '搜索当前会话' }), {
    target: { value: 'Original' },
  });
  fireEvent.click(await screen.findByRole('button', { name: /Original instruction/ }));
  await screen.findByText(/这是定位附近的只读片段/);
  expect(call).toHaveBeenCalledWith('thread/history/window', {
    threadId: 't',
    turnCursor: 'native-window',
    limit: 10,
  });
  expect(call.mock.calls.some((args) => args[0] === 'thread/history')).toBe(false);
  expect(document.activeElement?.classList.contains('search-selected')).toBe(true);
});
it('does not export the rendered window when a complete server export fails', async () => {
  const call = vi.fn().mockRejectedValue(new Error('history too large')),
    create = vi.fn();
  URL.createObjectURL = create;
  render(
    <HistoryTools
      api={{ call } as unknown as Api}
      threadId="t"
      epoch="one"
      turns={[turn]}
      onClose={vi.fn()}
      onLocate={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '导出 JSON' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toContain('未生成局部历史文件');
  expect(create).not.toHaveBeenCalled();
  expect(call).toHaveBeenCalledWith('thread/export', { threadId: 't', format: 'json' });
});
it('renders both saved plan text and live steps without requiring a raw JSON expansion', () => {
  render(
    <Messages
      turns={[
        {
          id: 'plan-turn',
          status: 'inProgress',
          items: [
            { id: 'plan', type: 'plan', text: '## Proposed approach\n\nReview the boundary.' },
            {
              id: 'steps',
              type: 'plan',
              plan: [
                { step: 'Read source', status: 'completed' },
                { step: 'Verify changes', status: 'inProgress' },
              ],
            },
          ],
        },
      ]}
      loading={false}
      complete
      onMore={vi.fn()}
    />,
  );
  expect(screen.getByRole('heading', { name: 'Proposed approach' })).toBeTruthy();
  expect(screen.getByText('Read source')).toBeTruthy();
  expect(screen.getByText('进行中')).toBeTruthy();
});
it('gives steer and queue additions stable message identities and retains unknown draft intent', async () => {
  const api = new Api();
  writeDraft({ ...emptyDraft('t'), text: 'Follow up' });
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((_url, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      return Promise.reject(new Error('response lost'));
    }),
  );
  await expect(
    api.mutate('thread/queue/add', { threadId: 't', text: 'Follow up' }),
  ).rejects.toThrow('response lost');
  expect(typeof (requests[0]?.params as Record<string, unknown>).clientUserMessageId).toBe(
    'string',
  );
  expect((await listOperations())[0]?.state).toBe('unknown');
  expect(readDraft('t').text).toBe('Follow up');
  await expect(
    api.mutate('turn/steer', { threadId: 't', text: 'Follow up', expectedTurnId: 'active' }),
  ).rejects.toThrow(/待确认/);
  expect(requests).toHaveLength(1);
});
