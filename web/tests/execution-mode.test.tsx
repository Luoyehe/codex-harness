// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Api } from '../lib/api';
import { executionIdentity, executionMode } from '../lib/execution-mode';
import { ExecutionModeSettings, RootExecutionNotice } from '../components/ExecutionModeSettings';

const native = { mode: 'native', effectiveUid: 990, revision: 'a'.repeat(64), requiresRestart: true, rootAllowed: true };
const root = { ...native, mode: 'root', effectiveUid: 0, revision: 'b'.repeat(64) };
type Call = { method: string; params: Record<string, unknown>; operationId?: string };
const drains: (() => Promise<unknown>)[] = [];
const releases: (() => void)[] = [];
function fixture(handler: (call: Call) => unknown = () => root) {
  const api = new Api(), calls: Call[] = [];
  api.csrf = 'fixture-csrf';
  const mutations = vi.spyOn(api, 'mutate');
  const settle = () => Promise.allSettled(mutations.mock.results.flatMap(result => result.type === 'return' ? [result.value] : []));
  drains.push(settle);
  vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
    const call: Call = JSON.parse(String(init.body)); calls.push(call);
    return { ok: true, status: 200, json: async () => ({ ok: true, result: await handler(call) }) };
  }));
  const onRefresh = vi.fn();
  return { api, calls, mutations, settle, onRefresh };
}
afterEach(async () => {
  releases.splice(0).forEach(release => release());
  await act(async () => { for (const drain of drains.splice(0)) await drain(); });
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
it('requires valid mode/UID and an explicit server root authorization, without a web authorization write', () => {
  const f = fixture();
  const view = render(<ExecutionModeSettings {...f} value={{ ...native, rootAllowed: false }} loading={false} enabled />);
  expect(screen.getByText(/未允许。请在服务器运行一站式运维脚本/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'ROOT 模式' }).matches(':disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'ROOT 模式' }));
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(f.mutations).not.toHaveBeenCalled();
  view.rerender(<ExecutionModeSettings {...f} value={native} loading={false} enabled />);
  expect(screen.getByRole('button', { name: 'ROOT 模式' }).matches(':disabled')).toBe(false);
  expect(screen.getByRole('button', { name: '普通账号' }).getAttribute('aria-pressed')).toBe('true');
  expect(f.mutations).not.toHaveBeenCalled();
  for (const value of [undefined, {}, { ...native, effectiveUid: 0 }, { ...root, effectiveUid: 990 }, { ...native, rootAllowed: undefined }, { ...root, rootAllowed: false }]) {
    expect(executionMode(value)).toBeUndefined();
  }
  expect(executionIdentity({ mode: 'root', effectiveUid: 0 })).toEqual({ mode: 'root', effectiveUid: 0 });
});
it('requires deliberate ROOT consent and submits once, preserving the real receipt path across refresh', async () => {
  let finish!: (value: unknown) => void;
  const response = new Promise(resolve => { finish = resolve; }); releases.push(() => finish(root));
  const f = fixture(() => response);
  const view = render(<ExecutionModeSettings {...f} value={native} loading={false} enabled />);
  fireEvent.click(screen.getByRole('button', { name: 'ROOT 模式' }));
  const submit = screen.getByRole('button', { name: '应用 ROOT 执行模式' });
  expect(submit.matches(':disabled')).toBe(true);
  fireEvent.click(submit); expect(f.mutations).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox', { name: /我确认授予 Agent 和终端整机 root 权限/ }));
  fireEvent.click(submit); fireEvent.click(submit);
  expect(f.mutations).toHaveBeenCalledTimes(1);
  view.rerender(<ExecutionModeSettings {...f} value={undefined} loading enabled={false} />);
  await act(async () => { finish(root); await f.settle(); });
  expect(f.calls.filter(call => call.method === 'system/execution-mode/write')).toHaveLength(1);
  expect(f.calls[0]!.params).toEqual({ mode: 'root', expectedRevision: native.revision, confirmRestart: true, confirmRoot: true });
  expect(f.calls[0]!.operationId).toBeTruthy();
  expect(f.onRefresh).toHaveBeenCalled();
  expect(await screen.findByText(/执行权限切换已受理/)).toBeTruthy();
  expect(screen.queryByRole('status', { name: 'ROOT 执行权限' })).toBeNull();
  view.rerender(<ExecutionModeSettings {...f} value={root} loading={false} enabled />);
  expect(screen.getByRole('button', { name: 'ROOT 模式' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByRole('checkbox')).toBeNull();
});
it('requires independent confirmation to return to native and never implies undoing root changes', async () => {
  const f = fixture(() => native);
  render(<ExecutionModeSettings {...f} value={root} loading={false} enabled />);
  fireEvent.click(screen.getByRole('button', { name: '普通账号' }));
  const confirm = screen.getByRole('checkbox', { name: /这不会撤销已完成的系统修改/ });
  expect(screen.getByRole('button', { name: '应用普通执行模式' }).matches(':disabled')).toBe(true);
  fireEvent.click(confirm);
  fireEvent.click(screen.getByRole('button', { name: '应用普通执行模式' }));
  await act(f.settle);
  expect(f.calls[0]!.params).toEqual({ mode: 'native', expectedRevision: root.revision, confirmRestart: true, confirmRoot: false });
  expect(f.calls).toHaveLength(1);
});
it('requires comparison and fresh selection when server authorization or mode revision changes', () => {
  const f = fixture();
  const view = render(<ExecutionModeSettings {...f} value={native} loading={false} enabled />);
  fireEvent.click(screen.getByRole('button', { name: 'ROOT 模式' }));
  fireEvent.click(screen.getByRole('checkbox'));
  view.rerender(<ExecutionModeSettings {...f} value={{ ...native, revision: 'c'.repeat(64), rootAllowed: false }} loading={false} enabled />);
  expect(screen.getByText(/执行权限已被其他操作更改/)).toBeTruthy();
  expect(screen.getByRole('button', { name: '应用 ROOT 执行模式' }).matches(':disabled')).toBe(true);
  view.rerender(<ExecutionModeSettings {...f} value={native} loading={false} enabled />);
  expect(screen.getByRole('checkbox')).toHaveProperty('checked', false);
  expect(screen.getByRole('button', { name: '应用 ROOT 执行模式' }).matches(':disabled')).toBe(true);
  view.rerender(<ExecutionModeSettings {...f} value={{ ...native, revision: 'c'.repeat(64), rootAllowed: false }} loading={false} enabled />);
  fireEvent.click(screen.getByRole('button', { name: '使用最新状态重新选择' }));
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.getByRole('button', { name: '普通账号' }).getAttribute('aria-pressed')).toBe('true');
  expect(f.mutations).not.toHaveBeenCalled();
});
it('does not apply while tasks are active or service identity is unreadable', () => {
  const f = fixture();
  const view = render(<ExecutionModeSettings {...f} value={native} loading={false} enabled={false} />);
  expect(screen.getByRole('button', { name: 'ROOT 模式' }).matches(':disabled')).toBe(true);
  expect(screen.getByText(/请先结束任务、终端和其他活动/)).toBeTruthy();
  view.rerender(<ExecutionModeSettings {...f} value={undefined} loading={false} enabled />);
  expect(screen.getByText(/执行身份尚未确认/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'ROOT 模式' }).matches(':disabled')).toBe(true);
  expect(f.mutations).not.toHaveBeenCalled();
});
it('queries only the original receipt after an uncertain switch and never repeats the mutation', async () => {
  let id = '';
  const f = fixture(call => {
    if (call.method === 'system/execution-mode/write') { id = call.operationId!; throw new Error('Fixture lost response'); }
    if (call.method === 'operation/read') return { operationId: id, method: 'system/execution-mode/write', state: 'accepted', result: root };
    throw new Error('Unexpected fixture method');
  });
  render(<ExecutionModeSettings {...f} value={native} loading={false} enabled />);
  fireEvent.click(screen.getByRole('button', { name: 'ROOT 模式' }));
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: '应用 ROOT 执行模式' }));
  await act(f.settle);
  const query = await screen.findByRole('button', { name: '查询原执行权限切换回执' });
  expect(f.calls.filter(call => call.method === 'operation/read')).toHaveLength(0);
  expect(screen.getByRole('button', { name: 'ROOT 模式' }).matches(':disabled')).toBe(true);
  fireEvent.click(query);
  await waitFor(() => expect(f.onRefresh).toHaveBeenCalled());
  expect(f.calls.filter(call => call.method === 'operation/read').map(call => call.params.operationId)).toEqual([id]);
  expect(f.calls.filter(call => call.method === 'system/execution-mode/write')).toHaveLength(1);
  expect(f.mutations).toHaveBeenCalledTimes(1);
});
it('keeps a ROOT warning readable and offers service settings without a privilege mutation', () => {
  const onSettings = vi.fn();
  const view = render(<RootExecutionNotice identity={{ mode: 'root', effectiveUid: 0 }} confirmed onSettings={onSettings} />);
  const warning = screen.getByRole('status', { name: 'ROOT 执行权限' });
  expect(within(warning).getByText(/ROOT 执行模式已启用/)).toBeTruthy();
  expect(warning.textContent).toContain('Harness 自身');
  expect(warning.textContent).toContain('沙箱和审批设置不改变执行账号');
  fireEvent.click(within(warning).getByRole('button', { name: '查看执行权限' }));
  expect(onSettings).toHaveBeenCalledTimes(1);
  view.rerender(<RootExecutionNotice identity={{ mode: 'root', effectiveUid: 0 }} confirmed={false} onSettings={onSettings} />);
  expect(screen.getByText(/不能据此认定已经切回普通账号/)).toBeTruthy();
  view.rerender(<RootExecutionNotice identity={{ mode: 'native', effectiveUid: 990 }} confirmed onSettings={onSettings} />);
  expect(screen.queryByRole('status')).toBeNull();
});
