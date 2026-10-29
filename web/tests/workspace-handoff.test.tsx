// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workspace } from '../Workspace';
import type { Composer } from '../components/Composer';
import type { Sidebar } from '../components/Sidebar';
import type { BranchDialog, ReviewDialog } from '../components/HistoryTools';
import type { Messages } from '../components/Messages';
import { Api } from '../lib/api';
import { emptyDraft, readDraft, writeDraft, type Draft } from '../lib/drafts';
import { listOperations, reconcileOperation } from '../lib/operations';

const controls = vi.hoisted(() => ({
  composer: undefined as ComponentProps<typeof Composer> | undefined,
  refresh: vi.fn(),
  activeTurn: false,
  review: undefined as ComponentProps<typeof ReviewDialog> | undefined,
  branch: undefined as ComponentProps<typeof BranchDialog> | undefined,
  messages: undefined as ComponentProps<typeof Messages> | undefined,
  data: { projects: [{ id: 'p', name: 'Project', cwd: '/project' }], data: [] },
  empty: [],
}));
vi.mock('../hooks/useEvents', () => ({ useEvents: () => ({
  connection: 'connected', runtimeConnected: true, activityReady: true,
  configurationReady: true, epoch: 'one', revision: 1, connectionId: 'local',
}) }));
vi.mock('../hooks/useResource', () => ({ useResource: () => ({
  data: controls.data, loading: false, error: '', refresh: controls.refresh,
}) }));
vi.mock('../hooks/usePaged', () => ({ usePaged: (_api: unknown, _method: unknown, _params: unknown, key: string) => ({
  items: controls.empty, snapshotKey: key, refresh: controls.refresh, loading: false, hasMore: false,
}) }));
vi.mock('../hooks/useConversation', () => ({ useConversation: () => ({
  ready: true, turns: controls.empty, active: controls.activeTurn,
  activeTurn: controls.activeTurn ? { id: 'active-turn' } : undefined,
  refresh: controls.refresh,
}) }));
vi.mock('../hooks/usePrompts', () => ({ usePrompts: () => ({ prompts: controls.empty }) }));
vi.mock('../hooks/useResume', () => ({ useResume: (_api: unknown, thread: string) => ({
  resumedThread: thread, threadDefaults: {}, requiresResume: false,
}) }));
vi.mock('../components/HookEventsPanel', () => ({
  HookEventsProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../components/McpPanel', () => ({ McpEventBridge: () => null }));
vi.mock('../components/Welcome', () => ({ Welcome: () => null }));
vi.mock('../components/Messages', () => ({
  Messages: (props: ComponentProps<typeof Messages>) => { controls.messages = props; return null; },
  Diff: () => null,
}));
vi.mock('../components/HistoryTools', () => ({
  HistoryTools: () => null,
  ReviewDialog: (props: ComponentProps<typeof ReviewDialog>) => { controls.review = props; return null; },
  BranchDialog: (props: ComponentProps<typeof BranchDialog>) => { controls.branch = props; return null; },
}));
vi.mock('../components/Sidebar', () => ({ Sidebar: (props: ComponentProps<typeof Sidebar>) => <>
  <output data-testid="thread">{props.threadId}</output>
  <button onClick={() => props.onThread('other')}>Open other thread</button>
  <button onClick={props.onNew}>New chat</button>
</> }));
// Keep the actual Workspace callbacks and its real draft/API/receipt ownership.
// Only presentational controls and unrelated resource readers are substituted.
vi.mock('../components/Composer', () => ({ Composer: (props: ComponentProps<typeof Composer>) => {
  controls.composer = props;
  return <textarea aria-label="Draft" value={props.value} onChange={event => props.onChange(event.target.value)} />;
} }));

beforeEach(() => {
  sessionStorage.clear();
  sessionStorage.setItem('harness.project', 'p');
  history.replaceState({}, '', '/');
  controls.activeTurn = false;
  controls.composer = undefined;
  controls.review = undefined;
  controls.branch = undefined;
  controls.messages = undefined;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function rejectDraftWrites() {
  const original = Storage.prototype.setItem;
  return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (this === sessionStorage && key.startsWith('harness.draft.v1.'))
      throw new DOMException('quota', 'QuotaExceededError');
    original.call(this, key, value);
  });
}
function visibleFields() {
  const p = controls.composer!;
  return { text: p.value, options: p.options, attachments: p.savedAttachments,
    references: p.references, extraContext: p.extraContext, outputSchema: p.outputSchema };
}
async function start(thread = '', intent: 'send' | 'queue' | 'steer' = 'send', initial: Partial<Draft> = {}) {
  if (thread) history.replaceState({}, '', `/?thread=${thread}`);
  const key = thread || 'new:p';
  writeDraft({ ...emptyDraft(key), text: 'submitted A', ...initial });
  let release!: (response: unknown) => void;
  const fetcher = vi.fn(() => new Promise(resolve => { release = resolve; }));
  vi.stubGlobal('fetch', fetcher);
  render(<Workspace api={new Api()} logout={async () => {}} active />);
  await waitFor(() => expect(controls.composer?.value).toBe('submitted A'));
  let sending!: Promise<boolean>;
  await act(async () => { sending = controls.composer!.onSend([], intent); });
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  const request = JSON.parse((fetcher.mock.calls as unknown as [string, RequestInit][])[0]![1].body as string);
  expect(request.params.text).toBe('submitted A');
  return {
    fetcher, request,
    accept: async (beforeResponse?: () => void) => {
      await act(async () => {
        beforeResponse?.();
        release({ ok: true, status: 200, json: async () => ({ ok: true, result: { thread: { id: 'created' } } }) });
        expect(await sending).toBe(true);
      });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(await listOperations()).toEqual([expect.objectContaining({ state: 'accepted', id: request.operationId })]);
    },
  };
}

it.each(['HTTP', 'receipt first'] as const)('retains newer memory-only input and warning after new conversation acceptance (%s)', async delivery => {
  const send = await start();
  rejectDraftWrites();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unsent B' } });
  const warning = screen.getByRole('alert').textContent;
  expect(warning).toContain('草稿保存失败');
  expect(readDraft('new:p').text).toBe('submitted A');
  if (delivery === 'receipt first') await act(async () => {
    await reconcileOperation(send.request.operationId, { state: 'accepted', threadId: 'created' });
  });
  await send.accept();
  expect(screen.getByTestId('thread').textContent).toBe('');
  expect(screen.getByRole('textbox')).toHaveProperty('value', 'unsent B');
  expect(screen.getByRole('alert').textContent).toBe(warning);
  expect(controls.refresh).toHaveBeenCalled();
  expect(screen.getByText(/新会话已创建/)).toBeTruthy();
});

it.each(['text ABA', 'options', 'attachments', 'references', 'extraContext', 'outputSchema'] as const)(
  'preserves a newer revision when only %s changed while sending', async field => {
    const send = await start();
    rejectDraftWrites();
    act(() => {
      const p = controls.composer!;
      if (field === 'text ABA') { p.onChange('B'); p.onChange('submitted A'); }
      if (field === 'options') p.onOptions({ model: 'changed-model' });
      if (field === 'attachments') p.onAttachmentsChange!([{ attachmentId: 'new-file', name: 'a.txt', size: 1, mimeType: 'text/plain' }]);
      if (field === 'references') p.onReferences!([{ type: 'app', appId: 'app', projectId: 'p', label: 'Changed label' }]);
      if (field === 'extraContext') p.onExtraContext!([{ label: 'note', text: 'B' }]);
      if (field === 'outputSchema') p.onOutputSchema!('{"type":"object"}');
    });
    const fields = visibleFields();
    await send.accept();
    expect(screen.getByTestId('thread').textContent).toBe('');
    expect(visibleFields()).toEqual(fields);
    expect(screen.getByRole('alert').textContent).toContain('草稿保存失败');
  },
);

it('keeps newer successfully persisted input at its original owner too', async () => {
  const send = await start();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'saved B' } });
  await send.accept();
  expect(screen.getByTestId('thread').textContent).toBe('');
  expect(screen.getByRole('textbox')).toHaveProperty('value', 'saved B');
  expect(readDraft('new:p').text).toBe('saved B');
});

it('does not mistake metadata-only changes for the accepted snapshot', async () => {
  const reference = { type: 'app' as const, appId: 'app', projectId: 'p', label: 'original' };
  const send = await start('', 'send', { references: [reference] });
  rejectDraftWrites();
  await send.accept(() => controls.composer!.onReferences!([{ ...reference, label: 'new label' }]));
  expect(screen.getByTestId('thread').textContent).toBe('');
  expect(controls.composer!.references).toEqual([{ ...reference, label: 'new label' }]);
});

it('revokes a completed receipt cleanup when new input arrives in the response batch', async () => {
  const send = await start();
  await act(async () => {
    await reconcileOperation(send.request.operationId, { state: 'accepted', threadId: 'created' });
  });
  expect(screen.getByRole('textbox')).toHaveProperty('value', '');
  rejectDraftWrites();
  await send.accept(() => controls.composer!.onChange('B after receipt'));
  expect(screen.getByTestId('thread').textContent).toBe('');
  expect(screen.getByRole('textbox')).toHaveProperty('value', 'B after receipt');
  expect(screen.getByRole('alert').textContent).toContain('草稿保存失败');
});

it.each(['HTTP', 'receipt first'] as const)('opens the created conversation after unchanged A is cleared (%s)', async delivery => {
  const send = await start();
  if (delivery === 'receipt first') await act(async () => {
    await reconcileOperation(send.request.operationId, { state: 'accepted', threadId: 'created' });
  });
  await send.accept();
  expect(screen.getByTestId('thread').textContent).toBe('created');
  expect(screen.getByRole('textbox')).toHaveProperty('value', '');
  expect(readDraft('new:p').text).toBe('');
});

it.each([false, true])('does not steal navigation after the user leaves (return to original: %s)', async returnToOriginal => {
  const send = await start();
  fireEvent.click(screen.getByRole('button', { name: 'Open other thread' }));
  if (returnToOriginal) fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new visit input' } });
  await send.accept();
  expect(screen.getByTestId('thread').textContent).toBe(returnToOriginal ? '' : 'other');
  expect(screen.getByRole('textbox')).toHaveProperty('value', 'new visit input');
});

it.each(['send', 'queue', 'steer'] as const)('preserves existing-thread %s behavior', async intent => {
  controls.activeTurn = intent !== 'send';
  const send = await start('existing', intent);
  rejectDraftWrites();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unsent B' } });
  await send.accept();
  expect(send.request.method).toBe({ send: 'turn/start', queue: 'thread/queue/add', steer: 'turn/steer' }[intent]);
  expect(screen.getByTestId('thread').textContent).toBe('existing');
  expect(screen.getByRole('textbox')).toHaveProperty('value', 'unsent B');
  expect(screen.getByRole('alert').textContent).toContain('草稿保存失败');
});

it.each(['before archive', 'while pending', 'unchanged', 'manual navigation'] as const)(
  'preserves draft ownership on archive acceptance: %s', async scenario => {
    history.replaceState({}, '', '/?thread=existing');
    writeDraft({ ...emptyDraft('existing'), text: 'draft A' });
    let release!: (value: unknown) => void;
    const fetcher = vi.fn(() => new Promise(resolve => { release = resolve; }));
    vi.stubGlobal('fetch', fetcher);
    render(<Workspace api={new Api()} logout={async () => {}} active />);
    await waitFor(() => expect(controls.composer?.value).toBe('draft A'));
    const edit = () => {
      rejectDraftWrites();
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'memory B' } });
    };
    if (scenario === 'before archive') edit();
    fireEvent.click(screen.getByText('归档会话'));
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    if (scenario === 'while pending') edit();
    if (scenario === 'manual navigation') fireEvent.click(screen.getByRole('button', { name: 'Open other thread' }));
    await act(async () => {
      release({ ok: true, status: 200, json: async () => ({ ok: true, result: {} }) });
    });
    await waitFor(async () => expect(await listOperations()).toEqual([]));
    expect(fetcher).toHaveBeenCalledOnce();
    if (scenario === 'unchanged') {
      await waitFor(() => expect(screen.getByTestId('thread').textContent).toBe(''));
      expect(readDraft('existing').text).toBe('draft A');
    } else if (scenario === 'manual navigation') {
      expect(screen.getByTestId('thread').textContent).toBe('other');
    } else {
      expect(screen.getByTestId('thread').textContent).toBe('existing');
      expect(screen.getByRole('textbox')).toHaveProperty('value', 'memory B');
      expect(screen.getByRole('alert').textContent).toContain('草稿保存失败');
    }
  },
);

it.each(['review', 'branch'] as const)('preserves volatile composer input on the actual %s completion callback', async workflow => {
  history.replaceState({}, '', '/?thread=existing');
  writeDraft({ ...emptyDraft('existing'), text: 'draft A' });
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  render(<Workspace api={new Api()} logout={async () => {}} active />);
  await waitFor(() => expect(controls.composer?.value).toBe('draft A'));
  rejectDraftWrites();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'memory B' } });
  let finish!: () => void;
  if (workflow === 'review') {
    fireEvent.click(screen.getByText('启动代码审查'));
    const callback = controls.review!.onCreatedThread!;
    finish = () => callback('created-review');
  } else {
    act(() => controls.messages!.onAction!({ id: 'turn', items: [], status: 'completed' }, 'fork'));
    const callback = controls.branch!.onCreatedFork!;
    finish = () => { expect(callback('created-branch')).toBe(true); };
  }
  await act(async () => { finish(); });
  expect(screen.getByTestId('thread').textContent).toBe('existing');
  expect(screen.getByRole('textbox')).toHaveProperty('value', 'memory B');
  expect(screen.getByRole('alert').textContent).toContain('草稿保存失败');
  expect(screen.getByRole('button', { name: '打开已创建的会话' })).toBeTruthy();
  expect(fetcher).not.toHaveBeenCalled();
});
