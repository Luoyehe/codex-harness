// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api, RpcError } from '../lib/api';
import { branchDraftKey, emptyDraft, readDraft, writeDraft } from '../lib/drafts';
import { listOperations, updateOperation } from '../lib/operations';
import { BranchDialog, ReviewDialog } from '../components/HistoryTools';
import { RenameDialog } from '../components/RenameDialog';
import { ProjectDialog } from '../components/ProjectDialog';
import { WorkspacePanel } from '../components/WorkspacePanel';

type Call = { method: string; params: Record<string, unknown>; operationId: string };
const turn = { id: 'turn', status: 'completed', items: [] };
const project = { id: 'project', name: 'Project', cwd: '/workspace' };
const revision = 'a'.repeat(64);
let inFlight: Promise<unknown>[] = [];
beforeEach(() => {
  inFlight = [];
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
  vi.restoreAllMocks();
});
function deferred() {
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve: async (value: unknown) => { resolve(value); await Promise.allSettled(inFlight); }, reject: async (error: Error) => { reject(error); await Promise.allSettled(inFlight); } };
}
function server(handler: (call: Call) => unknown) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init: RequestInit) => {
      const call: Call = JSON.parse(String(init.body));
      calls.push(call);
      try {
        const result = await handler(call);
        return { status: 200, ok: true, json: async () => ({ ok: true, result }) };
      } catch (error) {
        if (!(error instanceof RpcError)) throw error;
        return {
          status: 400,
          ok: false,
          json: async () => ({
            ok: false,
            error: { message: error.message, code: error.code, delivery: error.delivery },
          }),
        };
      }
    }),
  );
  const api = new Api(), begin = api.beginMutation.bind(api);
  api.beginMutation = ((...args: Parameters<Api['beginMutation']>) => {
    const request = begin(...args); inFlight.push(request.result); return request;
  }) as Api['beginMutation'];
  return { api, calls };
}
async function submitTwice(input: HTMLElement) {
  const writes = () => vi.mocked(fetch).mock.calls.filter((call) => JSON.parse(String(call[1]?.body)).operationId).length;
  const before = writes(), expectsDispatch = !input.matches(':disabled');
  const form = input.closest('form')!;
  act(() => {
    fireEvent.submit(form);
    fireEvent.submit(form);
  });
  if (expectsDispatch) await waitFor(() => expect(writes()).toBeGreaterThan(before));
}
function attemptClose() {
  fireEvent.click(screen.getByRole('button', { name: '关闭对话框' }));
  fireEvent.keyDown(document, { key: 'Escape' });
}
function branch(api: Api) {
  const onClose = vi.fn(),
    onFork = vi.fn((id: string, text?: string) => {
      writeDraft({ ...emptyDraft(id), text: text ?? '' });
      return true;
    });
  const view = render(
    <BranchDialog
      api={api}
      threadId="thread"
      enabled
      turn={turn}
      action="edit"
      onDraft={vi.fn()}
      onFork={onFork}
      onChanged={vi.fn()}
      onClose={onClose}
    />,
  );
  const input = screen.getByRole('textbox', { name: '新分支的消息草稿' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'draft A' } });
  return { view, input, onClose, onFork, key: branchDraftKey('thread', turn.id) };
}

it('freezes branch input and dismissal, sends once, and preserves a newer durable source revision', async () => {
  const request = deferred(),
    { api, calls } = server(() => request.promise),
    ui = branch(api);
  const submitted = readDraft(ui.key);
  await submitTwice(ui.input);
  expect(ui.input.matches(':disabled')).toBe(true);
  expect(screen.getByRole('button', { name: '取消' }).matches(':disabled')).toBe(true);
  attemptClose();
  expect(ui.onClose).not.toHaveBeenCalled();
  const newer = { ...emptyDraft(ui.key), text: 'draft B from recovery' };
  writeDraft(newer);
  await act(async () => request.resolve({ thread: { id: 'forked' } }));
  expect(calls).toHaveLength(1);
  expect(ui.onFork).toHaveBeenCalledWith('forked', 'draft A');
  expect(readDraft('forked').text).toBe('draft A');
  expect(readDraft(ui.key)).toEqual(newer);
  expect(submitted.revision).not.toBe(newer.revision);
  expect(ui.onClose).toHaveBeenCalledOnce();
});
it('clears only the exact branch revision handed off successfully', async () => {
  const request = deferred(),
    { api } = server(() => request.promise),
    ui = branch(api);
  await submitTwice(ui.input);
  await act(async () => request.resolve({ thread: { id: 'forked' } }));
  expect(readDraft(ui.key).text).toBe('');
  expect(readDraft('forked').text).toBe('draft A');
});
it('retains branch text after a rejected write and permits a corrected retry', async () => {
  const request = deferred(),
    { api } = server(() => request.promise),
    ui = branch(api);
  await submitTwice(ui.input);
  await act(async () => request.reject(new RpcError('not sent', 'rejected', 'not_sent')));
  await waitFor(() => expect(ui.input.matches(':disabled')).toBe(false));
  expect(ui.input.value).toBe('draft A');
  expect(readDraft(ui.key).text).toBe('draft A');
  expect(ui.onClose).not.toHaveBeenCalled();
  fireEvent.change(ui.input, { target: { value: 'corrected draft' } });
  expect(readDraft(ui.key).text).toBe('corrected draft');
});
it('retains newer durable branch bytes through unknown receipt recovery without reforking', async () => {
  const request = deferred(),
    { api, calls } = server(() => request.promise),
    ui = branch(api);
  await submitTwice(ui.input);
  await act(async () => request.reject(new Error('response lost')));
  expect(ui.input.matches(':disabled')).toBe(true);
  expect(ui.input.value).toBe('draft A');
  const newer = { ...emptyDraft(ui.key), text: 'recovered draft B' };
  writeDraft(newer);
  await act(async () => (await updateOperation(calls[0].operationId, 'accepted', 'forked')));
  fireEvent.click(await screen.findByRole('button', { name: '保存草稿并打开已有分支' }));
  expect(calls).toHaveLength(1);
  expect(ui.onFork).toHaveBeenCalledWith('forked', 'draft A');
  expect(readDraft(ui.key)).toEqual(newer);
});
it('does not hand off or clear branch drafts when a previous dialog has unmounted', async () => {
  const request = deferred(),
    { api } = server(() => request.promise),
    ui = branch(api);
  await submitTwice(ui.input);
  ui.view.unmount();
  const newer = { ...emptyDraft(ui.key), text: 'draft after navigation' };
  writeDraft(newer);
  await act(async () => request.resolve({ thread: { id: 'forked' } }));
  expect(ui.onFork).not.toHaveBeenCalled();
  expect(ui.onClose).not.toHaveBeenCalled();
  expect(readDraft(ui.key)).toEqual(newer);
});
it.each(['fork', 'revert'] as const)(
  'freezes %s boundary or confirmation controls while pending',
  async (kind) => {
    const request = deferred(),
      { api, calls } = server(() => request.promise),
      close = vi.fn();
    render(
      <BranchDialog
        api={api}
        threadId="thread"
        enabled
        turn={turn}
        action={kind}
        onDraft={vi.fn()}
        onFork={vi.fn().mockReturnValue(true)}
        onChanged={vi.fn()}
        onClose={close}
      />,
    );
    const controls = screen.getAllByRole(kind === 'fork' ? 'radio' : 'checkbox');
    if (kind === 'revert') fireEvent.click(controls[0]);
    await submitTwice(controls[0]);
    controls.forEach((control) => expect(control.matches(':disabled')).toBe(true));
    attemptClose();
    expect(close).not.toHaveBeenCalled();
    await act(async () => request.reject(new RpcError('not sent', 'rejected', 'not_sent')));
    expect(calls).toHaveLength(1);
    await waitFor(() => controls.forEach((control) => expect(control.matches(':disabled')).toBe(false)));
  },
);

type ModalKind = 'rename' | 'project' | 'review';
function transient(kind: ModalKind, api: Api) {
  const close = vi.fn(),
    changed = vi.fn();
  if (kind === 'rename')
    render(
      <RenameDialog api={api} threadId="thread" name="name A" onSaved={changed} onClose={close} />,
    );
  else if (kind === 'project') {
    render(<ProjectDialog api={api} onAdded={changed} onClose={close} />);
    fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), {
      target: { value: 'project A' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '服务器上的绝对目录' }), {
      target: { value: '/workspace/a' },
    });
  } else
    render(
      <ReviewDialog
        api={api}
        threadId="thread"
        projectId="project"
        enabled
        initialTarget={{ type: 'custom', instructions: 'instructions A' }}
        onChanged={changed}
        onOpenThread={vi.fn()}
        onClose={close}
      />,
    );
  const inputs = screen.getAllByRole('textbox') as (HTMLInputElement | HTMLTextAreaElement)[];
  return { close, changed, inputs, values: inputs.map((input) => input.value) };
}
it.each(['rename', 'project', 'review'] as const)(
  'freezes every %s control and close path until a single successful submission finishes',
  async (kind) => {
    const request = deferred(),
      { api, calls } = server(() => request.promise),
      ui = transient(kind, api);
    await submitTwice(ui.inputs[0]);
    ui.inputs.forEach((input) => expect(input.matches(':disabled')).toBe(true));
    if (kind === 'review') {
      expect(screen.getByRole('combobox').matches(':disabled')).toBe(true);
      expect(screen.getByRole('checkbox').matches(':disabled')).toBe(true);
    }
    attemptClose();
    expect(ui.close).not.toHaveBeenCalled();
    await act(async () => request.resolve({}));
    expect(calls).toHaveLength(1);
    expect(ui.close).toHaveBeenCalledOnce();
    expect(ui.changed).toHaveBeenCalledOnce();
    expect(calls[0].params).toEqual(
      kind === 'rename'
        ? { threadId: 'thread', name: 'name A' }
        : kind === 'project'
          ? { name: 'project A', path: '/workspace/a' }
          : {
              threadId: 'thread',
              delivery: 'inline',
              target: { type: 'custom', instructions: 'instructions A' },
            },
    );
  },
);
it.each(['rename', 'project', 'review'] as const)(
  'preserves the %s draft and reenables controls after a definite failure',
  async (kind) => {
    const request = deferred(),
      { api, calls } = server(() => request.promise),
      ui = transient(kind, api);
    await submitTwice(ui.inputs[0]);
    await act(async () => request.reject(new RpcError('not sent', 'rejected', 'not_sent')));
    await waitFor(() => ui.inputs.forEach((input, index) => {
      expect(input.value).toBe(ui.values[index]);
      expect(input.matches(':disabled')).toBe(false);
    }));
    expect(ui.close).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toContain('not sent');
  },
);
it.each(['rename', 'project', 'review'] as const)(
  'keeps an unknown %s submission frozen and recoverable without replay',
  async (kind) => {
    const request = deferred(),
      { api, calls } = server(() => request.promise),
      ui = transient(kind, api);
    await submitTwice(ui.inputs[0]);
    await act(async () => request.reject(new Error('response lost')));
    ui.inputs.forEach((input, index) => {
      expect(input.value).toBe(ui.values[index]);
      expect(input.matches(':disabled')).toBe(true);
    });
    await submitTwice(ui.inputs[0]);
    expect(calls).toHaveLength(1);
    expect((await listOperations())[0].state).toBe('unknown');
    expect(ui.close).not.toHaveBeenCalled();
    await act(async () => (await updateOperation(calls[0].operationId, 'not_sent')));
    await waitFor(() => ui.inputs.forEach((input) => expect(input.matches(':disabled')).toBe(false)));
  },
);
it('fences an old rename response from a different thread dialog', async () => {
  const request = deferred(),
    { api } = server(() => request.promise),
    close = vi.fn(),
    saved = vi.fn();
  const view = render(
    <RenameDialog api={api} threadId="old" name="old name" onSaved={saved} onClose={close} />,
  );
  await submitTwice(screen.getByRole('textbox'));
  view.rerender(
    <RenameDialog api={api} threadId="new" name="new name" onSaved={saved} onClose={close} />,
  );
  await act(async () => request.resolve({}));
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('new name');
  expect(close).not.toHaveBeenCalled();
  expect(saved).not.toHaveBeenCalled();
});
it('allows choosing a separate review when only inline review is unavailable', async () => {
  const { api, calls } = server(() => ({ reviewThreadId: 'reviewed' }));
  render(
    <ReviewDialog
      api={api}
      threadId="thread"
      projectId="project"
      enabled
      inlineEnabled={false}
      onChanged={vi.fn()}
      onOpenThread={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  const separate = screen.getByRole('checkbox', { name: '在项目的新会话中审查' });
  expect(separate.matches(':disabled')).toBe(false);
  fireEvent.click(separate);
  fireEvent.click(screen.getByRole('button', { name: '开始审查' }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0].method).toBe('review/startNew');
});

function workspace(kind: 'mkdir' | 'copy' | 'remove', result: (call: Call) => unknown) {
  const { api, calls } = server((call) => {
    const path = String(call.params.path ?? '');
    if (call.method === 'workspace/list')
      return {
        path,
        entries: [{ name: 'file.txt', kind: 'file', bytes: 4, accessible: true }],
        truncated: false,
      };
    if (call.method === 'workspace/metadata')
      return path
        ? { path, kind: 'file', revision, bytes: 4, editable: true }
        : { path, kind: 'directory', revision };
    if (call.method === 'workspace/read')
      return {
        path,
        kind: 'file',
        revision,
        text: 'base',
        bytes: 4,
        editable: true,
        binary: false,
      };
    return result(call);
  });
  render(
    <WorkspacePanel
      api={api}
      project={project}
      epoch="epoch"
      connected
      ready
      onReviewBase={vi.fn()}
    />,
  );
  return {
    calls,
    async begin() {
      if (kind === 'mkdir') fireEvent.click(screen.getByRole('button', { name: '新建目录' }));
      else {
        fireEvent.click(await screen.findByRole('button', { name: /file.txt/ }));
        fireEvent.click(
          await screen.findByRole('button', { name: kind === 'copy' ? '复制' : '删除' }),
        );
      }
      const input = screen.getByRole('textbox', {
        name:
          kind === 'mkdir'
            ? '项目内新路径'
            : kind === 'copy'
              ? '复制到项目内路径（必须不存在）'
              : '输入完整相对路径以确认',
      }) as HTMLInputElement;
      fireEvent.change(input, {
        target: { value: kind === 'remove' ? 'file.txt' : 'destination-a' },
      });
      return input;
    },
  };
}
it.each(['mkdir', 'copy', 'remove'] as const)(
  'freezes workspace %s controls until acceptance and sends once',
  async (kind) => {
    const request = deferred(),
      ui = workspace(kind, () => request.promise),
      input = await ui.begin();
    await submitTwice(input);
    expect(input.matches(':disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '取消' }).matches(':disabled')).toBe(true);
    await act(async () => request.resolve({}));
    expect(
      screen.queryByRole('textbox', {
        name:
          input.getAttribute('aria-label') ??
          (kind === 'mkdir'
            ? '项目内新路径'
            : kind === 'copy'
              ? '复制到项目内路径（必须不存在）'
              : '输入完整相对路径以确认'),
      }),
    ).toBeNull();
    expect(ui.calls.filter((call) => call.method === `workspace/${kind}`)).toHaveLength(1);
  },
);
it('preserves a mkdir path on definite failure and while unknown until a not-sent receipt', async () => {
  const request = deferred();
  let state = 'not_received';
  const ui = workspace('mkdir', (call) =>
    call.method === 'operation/read'
      ? { operationId: call.params.operationId, method: 'workspace/mkdir', state }
      : request.promise,
  );
  const input = await ui.begin();
  await submitTwice(input);
  await act(async () => request.reject(new Error('response lost')));
  expect(input.value).toBe('destination-a');
  expect(input.matches(':disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '查询原文件操作回执' }));
  await screen.findByText(/原文件操作仍待确认/);
  expect(input.matches(':disabled')).toBe(true);
  state = 'not_sent';
  fireEvent.click(screen.getByRole('button', { name: '查询原文件操作回执' }));
  await screen.findByText('原操作确定未发送。');
  expect(input.value).toBe('destination-a');
  expect(input.matches(':disabled')).toBe(false);
  expect(ui.calls.filter((call) => call.method === 'workspace/mkdir')).toHaveLength(1);
});
it('retains a copy destination after a definite rejection', async () => {
  const request = deferred(),
    ui = workspace('copy', () => request.promise),
    input = await ui.begin();
  await submitTwice(input);
  await act(async () => request.reject(new RpcError('not sent', 'rejected', 'not_sent')));
  expect(input.value).toBe('destination-a');
  expect(input.matches(':disabled')).toBe(false);
  expect(ui.calls.filter((call) => call.method === 'workspace/copy')).toHaveLength(1);
});
