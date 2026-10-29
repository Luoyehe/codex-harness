// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { WorkspacePanel } from '../components/WorkspacePanel';
import { WorkspaceCommit } from '../components/WorkspaceCommit';
import { listOperations } from '../lib/operations';

type Call = { method: string; params: Record<string, unknown>; operationId?: string };
const project = { id: 'project-one', name: 'One', cwd: '/registered/one' };
const state = {
  head: 'a'.repeat(40),
  symbolicTarget: 'refs/heads/main',
  headRevision: 'b'.repeat(64),
  indexRevision: 'c'.repeat(64),
};
const status = { complete: true, entries: [], commitState: state };
function setup(handler: (call: Call, signal: AbortSignal) => unknown = () => undefined) {
  const api = new Api(), calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
    const call: Call = JSON.parse(String(init.body));
    calls.push(call);
    const result = (await handler(call, init.signal as AbortSignal)) ?? (
      call.method === 'workspace/git/status' ? status
      : call.method === 'workspace/git/diff' ? { text: '+new', staged: call.params.staged, complete: true }
      : call.method === 'workspace/git/refs' ? { refs: [], truncated: false }
      : call.method === 'workspace/list' ? { path: '', entries: [], truncated: false }
      : call.method === 'workspace/metadata' ? { path: '', kind: 'directory', revision: 'd'.repeat(64), bytes: 0 }
      : {}
    );
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
  }));
  return { api, calls };
}
const props = (api: Api) => ({ api, project, epoch: 'one', connected: true, ready: true, idle: true, onReviewBase: vi.fn() });
const draft = { '提交作者': 'Draft Reviewer', '提交作者邮箱': 'draft@example.invalid', '提交说明': 'Retain my multiline\ncommit draft' };
function fillDraft() {
  for (const [name, value] of Object.entries(draft)) fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } });
}
function expectDraft() {
  for (const [name, value] of Object.entries(draft)) expect((screen.getByRole('textbox', { name }) as HTMLInputElement).value).toBe(value);
}
async function preview() {
  fireEvent.click(screen.getByRole('button', { name: '核对 HEAD 与已暂存修改' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: /确认以上暂存修改/ }));
}
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('retains commit drafts while returning through a loading Git view without persisting them', async () => {
  let hold = false;
  const pending: (() => void)[] = [];
  const { api, calls } = setup((call) => hold && call.method.startsWith('workspace/git/')
    ? new Promise((resolve) => { pending.push(() => resolve(undefined)); }) : undefined);
  render(<WorkspacePanel {...props(api)} />);
  expect(calls.some((call) => call.method.startsWith('workspace/git/'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Git' }));
  await screen.findByText('当前没有未提交的修改。');
  fillDraft();
  const message = screen.getByRole('textbox', { name: '提交说明' });
  fireEvent.click(screen.getByRole('button', { name: '文件' }));
  expect(document.contains(message)).toBe(true);
  expect(message.closest('[hidden][inert]')).not.toBeNull();
  expect(screen.queryByRole('textbox', { name: '提交说明' })).toBeNull();
  hold = true;
  fireEvent.click(screen.getByRole('button', { name: 'Git' }));
  expect(screen.getByText('读取 Git 状态…')).toBeTruthy();
  expect(screen.getByRole('textbox', { name: '提交说明' })).toBe(message);
  expectDraft();
  await act(async () => { for (const finish of pending) finish(); });
  await screen.findByText('当前没有未提交的修改。');
  expectDraft();
  expect(JSON.stringify(localStorage)).not.toContain(draft['提交说明']);
  expect(JSON.stringify(sessionStorage)).not.toContain(draft['提交作者邮箱']);
});

it('revokes commit confirmation on hiding, blocks hidden handlers and requires a fresh preview on return', async () => {
  const { api, calls } = setup();
  const initial = props(api), view = render(<WorkspacePanel {...initial} />);
  fireEvent.click(screen.getByRole('button', { name: 'Git' }));
  fillDraft();
  await preview();
  const commit = screen.getByRole('button', { name: '提交已暂存内容' });
  const inspect = screen.getByRole('button', { name: '核对 HEAD 与已暂存修改' });
  view.rerender(<WorkspacePanel {...initial} visible={false} />);
  const reads = calls.length;
  fireEvent.click(commit);
  fireEvent.click(inspect);
  expect(calls).toHaveLength(reads);
  view.rerender(<WorkspacePanel {...initial} />);
  expectDraft();
  expect(screen.queryByRole('checkbox', { name: /确认以上暂存修改/ })).toBeNull();
  expect((screen.getByRole('button', { name: '提交已暂存内容' }) as HTMLButtonElement).disabled).toBe(true);
  await preview();
  fireEvent.click(screen.getByRole('button', { name: '提交已暂存内容' }));
  await waitFor(() => expect(calls.filter((call) => call.method === 'workspace/git/commit')).toHaveLength(1));
});

it('aborts a hidden preview and ignores its late status before starting additional reads', async () => {
  let finish!: () => void, signal!: AbortSignal;
  const { api, calls } = setup((call, abort) => call.method === 'workspace/git/status'
    ? new Promise((resolve) => { finish = () => resolve(status); signal = abort; }) : undefined);
  const initial = { api, project, epoch: 'one', enabled: true, onChanged: vi.fn() };
  const view = render(<WorkspaceCommit {...initial} />);
  fillDraft();
  fireEvent.click(screen.getByRole('button', { name: '核对 HEAD 与已暂存修改' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  view.rerender(<WorkspaceCommit {...initial} visible={false} />);
  expect(signal.aborted).toBe(true);
  view.rerender(<WorkspaceCommit {...initial} />);
  await act(async () => finish());
  expect(calls.filter((call) => call.method === 'workspace/git/status')).toHaveLength(1);
  expect(calls.some((call) => call.method === 'workspace/git/diff')).toBe(false);
  expect(screen.queryByRole('checkbox', { name: /确认以上暂存修改/ })).toBeNull();
  expectDraft();
});

it('retains an unknown commit receipt across tab changes and never resends the commit', async () => {
  let reject!: (error: Error) => void, operationId = '';
  const { api, calls } = setup((call) => {
    if (call.method === 'workspace/git/commit') {
      operationId = call.operationId!;
      return new Promise((_resolve, fail) => { reject = fail; });
    }
    if (call.method === 'operation/read') return { operationId, method: 'workspace/git/commit', state: 'accepted', result: {} };
  });
  render(<WorkspacePanel {...props(api)} />);
  fireEvent.click(screen.getByRole('button', { name: 'Git' }));
  fillDraft();
  await preview();
  fireEvent.click(screen.getByRole('button', { name: '提交已暂存内容' }));
  await waitFor(() => expect(reject).toBeTypeOf('function'));
  fireEvent.click(screen.getByRole('button', { name: '文件' }));
  await act(async () => reject(new Error('commit response lost')));
  fireEvent.click(screen.getByRole('button', { name: 'Git' }));
  expectDraft();
  fireEvent.click(await screen.findByRole('button', { name: '查询原 Git 提交回执' }));
  await waitFor(async () => expect((await listOperations()).find((op) => op.id === operationId)?.state).toBe('accepted'));
  expect(calls.filter((call) => call.method === 'workspace/git/commit')).toHaveLength(1);
  expect(calls.find((call) => call.method === 'operation/read')?.params).toEqual({ operationId });
  expectDraft();
});

it('does not restore drafts or previews after an owner ABA transition', async () => {
  const { api } = setup();
  const initial = { api, project, epoch: 'one', enabled: true, onChanged: vi.fn() };
  const view = render(<WorkspaceCommit {...initial} />);
  fillDraft();
  await preview();
  view.rerender(<WorkspaceCommit {...initial} epoch="two" />);
  view.rerender(<WorkspaceCommit {...initial} />);
  for (const name of Object.keys(draft)) expect((screen.getByRole('textbox', { name }) as HTMLInputElement).value).toBe('');
  expect(screen.queryByRole('checkbox', { name: /确认以上暂存修改/ })).toBeNull();
  fillDraft();
  view.rerender(<WorkspaceCommit {...initial} api={new Api()} />);
  view.rerender(<WorkspaceCommit {...initial} />);
  for (const name of Object.keys(draft)) expect((screen.getByRole('textbox', { name }) as HTMLInputElement).value).toBe('');
  fillDraft();
  view.rerender(<WorkspaceCommit {...initial} project={{ ...project, id: 'other' }} />);
  view.rerender(<WorkspaceCommit {...initial} />);
  for (const name of Object.keys(draft)) expect((screen.getByRole('textbox', { name }) as HTMLInputElement).value).toBe('');
});

it('pauses all automatic Git reads while hidden, including reconnect and epoch updates', async () => {
  const { api, calls } = setup(), initial = props(api);
  const view = render(<WorkspacePanel {...initial} />);
  fireEvent.click(screen.getByRole('button', { name: 'Git' }));
  await screen.findByText('当前没有未提交的修改。');
  fireEvent.click(screen.getByRole('button', { name: '文件' }));
  const count = () => calls.filter((call) => call.method.startsWith('workspace/git/')).length;
  const reads = count();
  view.rerender(<WorkspacePanel {...initial} connected={false} epoch="two" />);
  view.rerender(<WorkspacePanel {...initial} epoch="two" />);
  await act(async () => {});
  expect(count()).toBe(reads);
  fireEvent.click(screen.getByRole('button', { name: 'Git' }));
  await screen.findByText('当前没有未提交的修改。');
  expect(count()).toBe(reads + 3);
});

it('retains the commit draft through a local file refresh while revoking the old preview and consent', async () => {
  const { api, calls } = setup();
  render(<WorkspacePanel {...props(api)} />);
  fireEvent.click(screen.getByRole('button', { name: 'Git' }));
  fillDraft();
  await preview();
  const input = screen.getByRole('textbox', { name: '提交说明' });
  fireEvent.click(screen.getByRole('button', { name: '文件' }));
  await waitFor(() => expect((screen.getByRole('button', { name: '刷新文件' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '刷新文件' }));
  fireEvent.click(screen.getByRole('button', { name: 'Git' }));
  expect(screen.getByRole('textbox', { name: '提交说明' })).toBe(input);
  expectDraft();
  expect(screen.queryByRole('checkbox', { name: /确认以上暂存修改/ })).toBeNull();
  expect((screen.getByRole('button', { name: '提交已暂存内容' }) as HTMLButtonElement).disabled).toBe(true);
  expect(calls.some((call) => call.method === 'workspace/git/commit')).toBe(false);
});

it('does not let a late hidden inspection finish or replace the next visible inspection', async () => {
  const pending: (() => void)[] = [];
  let statusReads = 0;
  const { api } = setup((call) => call.method === 'workspace/git/status' && ++statusReads <= 2
    ? new Promise((resolve) => { pending.push(() => resolve(status)); }) : undefined);
  const initial = { api, project, epoch: 'one', enabled: true, onChanged: vi.fn() };
  const view = render(<WorkspaceCommit {...initial} />);
  fillDraft();
  fireEvent.click(screen.getByRole('button', { name: '核对 HEAD 与已暂存修改' }));
  view.rerender(<WorkspaceCommit {...initial} visible={false} />);
  view.rerender(<WorkspaceCommit {...initial} />);
  fireEvent.click(screen.getByRole('button', { name: '核对 HEAD 与已暂存修改' }));
  await act(async () => pending[0]!());
  expect(screen.getByRole('button', { name: '正在核对…' })).toBeTruthy();
  expect(screen.queryByRole('checkbox', { name: /确认以上暂存修改/ })).toBeNull();
  await act(async () => pending[1]!());
  await screen.findByRole('checkbox', { name: /确认以上暂存修改/ });
  expect(statusReads).toBe(3);
  expectDraft();
});

it('keeps a late old-owner commit receipt global without attaching it to the new form', async () => {
  let reject!: (error: Error) => void, operationId = '';
  const { api } = setup((call) => {
    if (call.method !== 'workspace/git/commit') return undefined;
    operationId = call.operationId!;
    return new Promise((_resolve, fail) => { reject = fail; });
  });
  const initial = { api, project, epoch: 'one', enabled: true, onChanged: vi.fn() };
  const view = render(<WorkspaceCommit {...initial} />);
  fillDraft();
  await preview();
  fireEvent.click(screen.getByRole('button', { name: '提交已暂存内容' }));
  await waitFor(() => expect(reject).toBeTypeOf('function'));
  view.rerender(<WorkspaceCommit {...initial} epoch="two" />);
  view.rerender(<WorkspaceCommit {...initial} />);
  fireEvent.change(screen.getByRole('textbox', { name: '提交说明' }), { target: { value: 'New owner draft' } });
  await act(async () => reject(new Error('old owner response lost')));
  expect((await listOperations()).find((op) => op.id === operationId)?.state).toBe('unknown');
  expect(screen.queryByRole('button', { name: '查询原 Git 提交回执' })).toBeNull();
  expect((screen.getByRole('textbox', { name: '提交说明' }) as HTMLTextAreaElement).value).toBe('New owner draft');
  expect(initial.onChanged).not.toHaveBeenCalled();
});
