// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workspace } from '../Workspace';
import { checkedTimeline, type TimelineEntry } from '../lib/timeline';
import type { ThreadTerminals } from '../components/ThreadTerminals';
import type { Composer } from '../components/Composer';
import type { Sidebar } from '../components/Sidebar';
import type { BranchDialog, ReviewDialog } from '../components/HistoryTools';
import type { Messages } from '../components/Messages';
import type { Settings } from '../components/Settings';
import type { Recovery } from '../components/Recovery';
import type { WorkspacePanel } from '../components/WorkspacePanel';
import { Api } from '../lib/api';
import { branchDraftKey, emptyDraft, readDraft, writeDraft, type Draft } from '../lib/drafts';
import { listOperations, reconcileOperation } from '../lib/operations';

const controls = vi.hoisted(() => ({
  composer: undefined as ComponentProps<typeof Composer> | undefined,
  refresh: vi.fn(),
  activeTurn: false,
  historyComplete: true,
  timeline: [] as TimelineEntry[],
  terminals: undefined as ComponentProps<typeof ThreadTerminals> | undefined,
  review: undefined as ComponentProps<typeof ReviewDialog> | undefined,
  branch: undefined as ComponentProps<typeof BranchDialog> | undefined,
  messages: undefined as ComponentProps<typeof Messages> | undefined,
  settings: undefined as ComponentProps<typeof Settings> | undefined,
  recovery: undefined as ComponentProps<typeof Recovery> | undefined,
  workspace: undefined as ComponentProps<typeof WorkspacePanel> | undefined,
  data: { projects: [{ id: 'p', name: 'Project', cwd: '/project' }, { id: 'other-project', name: 'Other project', cwd: '/other-project' }], data: [] },
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
vi.mock('../hooks/useConversation', () => ({ useConversation: (_api: unknown, _events: unknown, threadId: string) => ({
  ready: true, turns: controls.empty, timeline: controls.timeline, loadedThreadId: threadId, complete: controls.historyComplete, truncated: !controls.historyComplete, active: controls.activeTurn, thread: { id: 'thread', cwd: '/project' },
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
vi.mock('../components/Settings', () => ({ Settings: (props: ComponentProps<typeof Settings>) => {
  controls.settings = props; return <div data-testid="settings-open" />;
} }));
vi.mock('../components/Recovery', async () => ({
  ...await vi.importActual<typeof import('../components/Recovery')>('../components/Recovery'),
  Recovery: (props: ComponentProps<typeof Recovery>) => { controls.recovery = props; return null; },
}));
vi.mock('../components/ThreadTerminals', () => ({ ThreadTerminals: (props: ComponentProps<typeof ThreadTerminals>) => {
  controls.terminals = props; return null;
} }));
vi.mock('../components/WorkspacePanel', () => ({ WorkspacePanel: (props: ComponentProps<typeof WorkspacePanel>) => {
  controls.workspace = props; return null;
} }));
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
  <button onClick={props.onSettings}>Settings</button>
</> }));
// Keep the actual Workspace callbacks and its real draft/API/receipt ownership.
// Only presentational controls and unrelated resource readers are substituted.
vi.mock('../components/Composer', () => ({ Composer: (props: ComponentProps<typeof Composer>) => {
  controls.composer = props;
  return <textarea id="message-input" aria-label="Draft" value={props.value} onChange={event => props.onChange(event.target.value)} />;
} }));

beforeEach(() => {
  sessionStorage.clear();
  sessionStorage.setItem('harness.project', 'p');
  history.replaceState({}, '', '/');
  controls.activeTurn = false;
  controls.historyComplete = true;
  controls.timeline = [];
  controls.terminals = undefined;
  controls.composer = undefined;
  controls.review = undefined;
  controls.branch = undefined;
  controls.messages = undefined;
  controls.settings = undefined;
  controls.recovery = undefined;
  controls.workspace = undefined;
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
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
it.each(['workspace', 'recovery-files', 'recovery-thread', 'settings-draft', 'settings-thread', 'settings-terminal'] as const)(
  'guards the real Workspace %s navigation callback before changing project, panel or modal', async route => {
    writeDraft({ ...emptyDraft('new:p'), text: 'saved A' });
    render(<Workspace api={new Api()} logout={async () => {}} active />);
    await waitFor(() => expect(controls.composer?.value).toBe('saved A'));
    fireEvent.click(screen.getByRole('button', { name: '打开项目文件' }));
    if (route.startsWith('settings')) {
      fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
      await act(async () => { await import('../components/Settings'); });
      await screen.findByTestId('settings-open');
    }
    rejectDraftWrites();
    act(() => controls.composer!.onChange('memory only'));
    const url = location.href;
    const panel = document.querySelector('.workspace-body')!.getAttribute('data-panel');
    act(() => {
      if (route === 'workspace') controls.workspace!.onSelectProject!('other-project');
      if (route === 'recovery-files') controls.recovery!.openWorkspace!('other-project', 'file.txt');
      if (route === 'recovery-thread') controls.recovery!.openThread('other-thread');
      if (route === 'settings-draft') controls.settings!.onOpenDraft('new:other-project');
      if (route === 'settings-thread') controls.settings!.onOpenThread!('other-thread');
      if (route === 'settings-terminal') controls.settings!.onOpenNativeTerminal!('other-project');
    });
    expect(screen.getByRole('dialog', { name: '草稿尚未保存' })).toBeTruthy();
    expect(controls.composer?.value).toBe('memory only');
    expect(screen.getByTestId('thread').textContent).toBe('');
    expect(sessionStorage.getItem('harness.project')).toBe('p');
    expect(location.href).toBe(url);
    expect(document.querySelector('.workspace-body')!.getAttribute('data-panel')).toBe(panel);
    if (route.startsWith('settings')) expect(screen.getByTestId('settings-open')).toBeTruthy();
  },
);
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
  await waitFor(() => expect(controls.refresh).toHaveBeenCalled());
  expect(screen.getByTestId('thread').textContent).toBe('');
  expect(screen.getByRole('textbox')).toHaveProperty('value', 'unsent B');
  expect(screen.getByRole('alert').textContent).toBe(warning);
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


it('locates a timeline-only command from background terminals and rejects missing or ambiguous targets', async () => {
  history.replaceState({}, '', '/?thread=existing');
  const command = (turnId: string, id: string, position: number, reference = false) => ({
    type: 'item', turnId, position, item: { id, type: 'commandExecution', ...(reference ? {} : { command: id }) },
    ...(reference ? { itemReference: true } : {}),
  });
  controls.historyComplete = false;
  controls.timeline = checkedTimeline([command('a', 'actual', 0), command('a', 'duplicate', 1),
    command('b', 'duplicate', 2), command('b', 'missing', 3, true),
    { type: 'item', turnId: 'b', position: 4, item: { type: 'agentMessage', id: 'actual', text: 'Another item kind' } },
    { type: 'item', turnId: 'c', position: 5, item: { type: 'agentMessage', id: 'missing', text: 'Not a command' } }]);
  render(<Workspace api={new Api()} logout={async () => {}} active />);
  fireEvent.click(screen.getByRole('button', { name: '打开会话命令与后台终端' }));
  await waitFor(() => expect(controls.terminals).toBeTruthy());
  act(() => controls.terminals!.onLocate('actual'));
  expect(controls.messages?.focusTarget).toEqual({ turnId: 'a', itemId: 'actual' });
  act(() => controls.terminals!.onLocate('duplicate'));
  expect(controls.messages?.focusTarget).toBeUndefined();
  expect(screen.getByText(/多个回合含有相同的历史条目标识/)).toBeTruthy();
  act(() => controls.terminals!.onLocate('missing'));
  expect(controls.messages?.focusTarget).toBeUndefined();
  expect(screen.getByText(/后台进程的历史条目尚未加载/)).toBeTruthy();
});
it.each(['saved edit', ''])('restores only explicitly saved branch text for a timeline-only turn (%s)', async text => {
  const key = branchDraftKey('existing', 'turn');
  writeDraft({ ...emptyDraft(key), text });
  controls.historyComplete = false;
  controls.timeline = checkedTimeline([
    { type: 'item', position: 1, turnId: 'turn', item: { id: 'original', type: 'userMessage', content: [{ type: 'text', text: 'partial original' }] } },
    { type: 'turnCompleted', position: 2, turnId: 'turn', status: 'completed', error: null },
  ]);
  render(<Workspace api={new Api()} logout={async () => {}} active />);
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  await screen.findByTestId('settings-open');
  act(() => controls.settings!.onOpenDraft(key));
  if (text) {
    await waitFor(() => expect(controls.branch?.memoryDraft).toBe(text));
    expect(controls.branch?.turn).toMatchObject({ id: 'turn', itemsView: 'summary' });
  } else {
    await screen.findByText(/当前窗口只包含部分回合/);
    expect(controls.branch).toBeUndefined();
  }
  expect(readDraft(key).text).toBe(text);
});

it('wires a certified history window to scoped reads, submission and cleanup separately', async () => {
  history.replaceState({}, '', '/?thread=existing');
  controls.historyComplete = false;
  render(<Workspace api={new Api()} logout={async () => {}} active />);
  expect(controls.composer?.disabled).toBe(false);
  expect(controls.composer?.historyComplete).toBe(false);
  fireEvent.click(screen.getByRole('button', {name:'打开会话命令与后台终端'}));
  expect(controls.terminals?.enabled).toBe(true);
  expect(controls.terminals?.shellEnabled).toBe(false);
  fireEvent.click(screen.getByText('启动代码审查'));
  expect(controls.review?.enabled).toBe(true);
  expect(controls.review?.inlineEnabled).toBe(false);
  act(() => controls.review!.onClose());
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  await act(async () => { await import('../components/Settings'); });
  await waitFor(() => expect(controls.settings?.threadReady).toBe(true));
  expect(controls.settings?.historyComplete).toBe(false);
});

it.each([[1200, 0, true, true], [1200, 1, true, false], [600, 0, true, false], [1200, 0, false, false]] as const)(
  'restores composer focus only on intentional desktop return (width %d, touches %d, fine %s)', async (width, touches, fine, shouldFocus) => {
    vi.stubGlobal('innerWidth', width);
    vi.stubGlobal('matchMedia', () => ({ matches: fine }));
    const old = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints');
    Object.defineProperty(navigator, 'maxTouchPoints', { value: touches, configurable: true });
    try {
      render(<Workspace api={new Api()} logout={async () => {}} active />);
      const input = await screen.findByLabelText('Draft');
      expect(document.activeElement).not.toBe(input);
      fireEvent.click(screen.getByRole('button', { name: '打开项目文件' }));
      expect(document.activeElement).not.toBe(input);
      fireEvent.click(screen.getByRole('button', { name: /返回聊天/ }));
      expect(document.activeElement === input).toBe(shouldFocus);
      fireEvent.click(screen.getByRole('button', { name: '打开项目文件' }));
      fireEvent.click(screen.getByRole('button', { name: 'Open other thread' }));
      expect(document.activeElement).not.toBe(input);
    } finally {
      if (old) Object.defineProperty(navigator, 'maxTouchPoints', old);
      else Reflect.deleteProperty(navigator, 'maxTouchPoints');
    }
  },
);
