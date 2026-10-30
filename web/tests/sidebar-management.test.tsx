// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { Events } from '../lib/events';
import { SidebarManagementDialog, type SidebarAction } from '../components/SidebarManagementDialog';
import { enabledButton } from './enabled-button';
import { createOperation, listOperations, updateOperation } from '../lib/operations';

type Call = { method: string; params: Record<string, unknown>; operationId?: string };
const project = { id: 'project-row', name: 'Project row', cwd: '/registered/row' };
const thread = { id: 'thread-row', name: 'Thread row', cwd: project.cwd };
const page = { turns: [], timeline: [], turnsComplete: true, timelineComplete: true,
  historyVersion: 0, activeRealtimeSessionAtPageStart: null, complete: true, nextCursor: null };
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture(selection: SidebarAction, handle: (call: Call) => unknown = () => ({}), beforeSubmit = () => true) {
  const calls: Call[] = [], api = new Api(), onAccepted = vi.fn(), onClose = vi.fn(), events = new Events();
  vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
    const call = JSON.parse(String(init.body)) as Call;
    calls.push(call);
    const result = await handle(call);
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
  }));
  const props = { api, events, epoch: 'first', selection, enabled: true, beforeSubmit, onAccepted, onClose };
  const view = render(<SidebarManagementDialog {...props} />);
  return { ...view, calls, props, onAccepted, onClose };
}
it.each(['project', 'thread'] as const)('renames the frozen %s row without loading or resuming it', async kind => {
  const f = fixture(kind === 'project' ? { kind, target: project, action: 'rename' } : { kind, target: thread, action: 'rename' });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '  New name  ' } });
  fireEvent.click(await enabledButton({ name: '保存名称' }));
  await waitFor(() => expect(f.onAccepted).toHaveBeenCalledOnce());
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toMatchObject(kind === 'project'
    ? { method: 'project/rename', params: { id: project.id, name: 'New name' } }
    : { method: 'thread/name/set', params: { threadId: thread.id, name: 'New name' } });
  expect(f.calls[0]?.operationId).toBeTruthy();
});
it.each(['archive', 'unarchive'] as const)('performs %s directly on the listed row without resume', async action => {
  const f = fixture({ kind: 'thread', target: thread, action });
  fireEvent.click(await enabledButton({ name: action === 'archive' ? '归档会话' : '取消归档会话' }));
  await waitFor(() => expect(f.onAccepted).toHaveBeenCalledOnce());
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toMatchObject({ method: `thread/${action}`, params: { threadId: thread.id } });
});
it('preserves an unsaved draft by refusing current-project removal before dispatch', async () => {
  const f = fixture({ kind: 'project', target: project, action: 'remove' }, undefined, () => false);
  fireEvent.click(await enabledButton({ name: '移除项目' }));
  expect(await screen.findByText(/当前草稿尚未安全保存/)).toBeTruthy();
  expect(f.calls).toEqual([]);
  expect(f.onAccepted).not.toHaveBeenCalled();
});
it('removes only the registered project identity and makes the retained directory explicit', async () => {
  const f = fixture({ kind: 'project', target: project, action: 'remove' });
  expect(screen.getByText(/目录、文件和会话历史都会保留/)).toBeTruthy();
  fireEvent.click(await enabledButton({ name: '移除项目' }));
  await waitFor(() => expect(f.onAccepted).toHaveBeenCalledOnce());
  expect(f.calls[0]).toMatchObject({ method: 'project/remove', params: { id: project.id } });
});
it('waits for the target complete history and explicit consent before deleting without resume', async () => {
  let finish!: (value: unknown) => void;
  const f = fixture({ kind: 'thread', target: thread, action: 'delete' }, call => {
    if (call.method === 'thread/read') return { thread: { ...thread, status: { type: 'idle' } } };
    if (call.method === 'thread/history' && !call.params.cursor) return { ...page, complete: false, turnsComplete: false, nextCursor: 'next-page' };
    if (call.method === 'thread/history') return new Promise(resolve => { finish = resolve; });
    return {};
  });
  const button = screen.getByRole('button', { name: '永久删除会话' }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox'));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(button.disabled).toBe(true);
  await act(async () => finish(page));
  fireEvent.click(await enabledButton({ name: '永久删除会话' }));
  await waitFor(() => expect(f.onAccepted).toHaveBeenCalledOnce());
  expect(f.calls.map(call => call.method)).toEqual(['thread/read', 'thread/history', 'thread/history', 'thread/delete']);
  expect(f.calls.at(-1)?.params).toEqual({ threadId: thread.id });
});
it('does not delete an active row even with complete history and consent', async () => {
  const f = fixture({ kind: 'thread', target: thread, action: 'delete' }, call => call.method === 'thread/read'
    ? { thread: { ...thread, status: { type: 'active' } } } : page);
  fireEvent.click(screen.getByRole('checkbox'));
  await screen.findByText(/请先结束此会话中正在运行/);
  expect((screen.getByRole('button', { name: '永久删除会话' }) as HTMLButtonElement).disabled).toBe(true);
  expect(f.calls.some(call => call.method === 'thread/delete')).toBe(false);
});
it('recovers the original unknown write once, without submitting a second mutation', async () => {
  const f = fixture({ kind: 'project', target: project, action: 'rename' }, call => {
    if (call.method === 'project/rename') throw new TypeError('connection closed');
    if (call.method === 'operation/read') return { operationId: call.params.operationId, method: 'project/rename', state: 'accepted', result: { id: project.id, name: 'Accepted name', path: project.cwd } };
    throw new Error('Unexpected request');
  });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Accepted name' } });
  fireEvent.click(await enabledButton({ name: '保存名称' }));
  const recover = await screen.findByRole('button', { name: '查询原管理操作回执' });
  expect((await screen.findByRole('button', { name: '保存名称' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('textbox') as HTMLInputElement).closest('fieldset')?.disabled).toBe(true);
  fireEvent.click(recover);
  await waitFor(() => expect(f.onAccepted).toHaveBeenCalledOnce());
  expect(f.calls.map(call => call.method)).toEqual(['project/rename', 'operation/read']);
  expect(f.calls[1]?.params.operationId).toBe(f.calls[0]?.operationId);
  await act(async () => {});
  expect(f.onAccepted).toHaveBeenCalledOnce();
});
it('blocks another global unknown operation even for a project without thread scope', async () => {
  const op = await createOperation('project/remove', {});
  await updateOperation(op.id, 'unknown');
  const f = fixture({ kind: 'project', target: project, action: 'rename' });
  await screen.findByText(/有操作结果待确认/);
  expect((screen.getByRole('button', { name: '保存名称' }) as HTMLButtonElement).disabled).toBe(true);
  expect(f.calls).toEqual([]);
  expect((await listOperations()).find(item => item.id === op.id)?.state).toBe('unknown');
});
it('ignores IME confirmation and keeps the dialog owned until an in-flight mutation completes', async () => {
  let finish!: (value: unknown) => void;
  const f = fixture({ kind: 'thread', target: thread, action: 'rename' }, () => new Promise(resolve => { finish = resolve; }));
  const input = screen.getByRole('textbox');
  expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: true })).toBe(false);
  expect(f.calls).toEqual([]);
  fireEvent.click(await enabledButton({ name: '保存名称' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  fireEvent.click(screen.getByRole('button', { name: '关闭对话框' }));
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(f.onClose).not.toHaveBeenCalled();
  await act(async () => finish({}));
  await waitFor(() => expect(f.onAccepted).toHaveBeenCalledOnce());
});
