// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Api } from '../lib/api';
import { acknowledgeOperation, createOperation, listOperations, stopUnknownRecovery, updateOperation } from '../lib/operations';
import { OperationHistory } from '../components/OperationHistory';
import { Recovery } from '../components/Recovery';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('shows processed and failed history alongside unresolved records without acknowledgement or bulk cleanup', async () => {
  const accepted = await createOperation('conversation/start', { projectId: 'project' });
  await updateOperation(accepted.id, 'accepted', 'created-thread');
  await acknowledgeOperation(accepted.id);
  const failed = await createOperation('system/provider/write', {});
  await updateOperation(failed.id, 'not_sent');
  await acknowledgeOperation(failed.id);
  const unresolved = await createOperation('turn/start', { threadId: 'existing' });
  await updateOperation(unresolved.id, 'unknown');
  const openThread = vi.fn(), api = { call: vi.fn(), mutate: vi.fn() } as unknown as Api;
  const view = render(<OperationHistory api={api} runtimeReady recoveryEpoch="one" openThread={openThread} />);
  await screen.findByText('本地操作记录 3 条');
  expect(screen.getByText(/最近 500 条已处理记录，待确认操作不会被清理/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /已知悉|关闭提醒|清理已完成记录/ })).toBeNull();
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.getAllByRole('button', { name: '查询回执' })).toHaveLength(1);
  expect(screen.queryByRole('button', { name: '查看失败原因' })).toBeNull();
  expect(screen.getByText(/确定未发送 · 已关闭提醒/)).toBeTruthy();
  const acceptedRow = screen.getByText(accepted.id.slice(0, 8), { exact: false }).closest('.recovery-row') as HTMLElement;
  fireEvent.click(within(acceptedRow).getByRole('button', { name: '打开' }));
  expect(openThread).toHaveBeenCalledExactlyOnceWith('created-thread');
  expect(api.call).not.toHaveBeenCalled(); expect(api.mutate).not.toHaveBeenCalled();
  view.unmount();
  render(<OperationHistory api={api} runtimeReady recoveryEpoch="two" openThread={openThread} />);
  await screen.findByText('本地操作记录 3 条');
  expect(await listOperations()).toEqual([expect.objectContaining({ id: unresolved.id, state: 'unknown' })]);
});

it('keeps a queried accepted receipt in history without another acknowledgement or resend', async () => {
  const operation = await createOperation('thread/fork', { threadId: 'original' });
  await updateOperation(operation.id, 'unknown');
  const api = { call: vi.fn().mockResolvedValue({ operationId: operation.id, state: 'accepted',
    result: { thread: { id: 'recovered-copy' } } }), mutate: vi.fn() } as unknown as Api;
  const openThread = vi.fn();
  render(<OperationHistory api={api} runtimeReady recoveryEpoch="one" openThread={openThread} />);
  fireEvent.click(await screen.findByRole('button', { name: '查询回执' }));
  await screen.findByText(/· 已受理$/);
  expect(screen.queryByRole('button', { name: /已知悉|关闭提醒|清理已完成记录|查询回执/ })).toBeNull();
  expect(await listOperations()).toEqual([expect.objectContaining({ id: operation.id, state: 'accepted', resolvedThreadId: 'recovered-copy' })]);
  fireEvent.click(screen.getByRole('button', { name: '打开' }));
  expect(openThread).toHaveBeenCalledExactlyOnceWith('recovered-copy');
  expect(api.call).toHaveBeenCalledExactlyOnceWith('operation/read', { operationId: operation.id });
  expect(api.mutate).not.toHaveBeenCalled();
});

it('warns before capacity is exhausted even when every retained receipt succeeded', async () => {
  const rows = Array.from({ length: 180 }, (_, index) => ({ id: crypto.randomUUID(), method: 'conversation/start',
    projectId: `project-${index}`, state: 'accepted' as const, createdAt: index }));
  render(<Recovery api={{ call: vi.fn() } as unknown as Api} operations={rows} error="" openThread={vi.fn()} runtimeReady recoveryEpoch="one" />);
  expect(screen.getByText('本地操作记录接近上限')).toBeTruthy();
  expect(screen.getByText(/设置 → 操作记录/)).toBeTruthy();
  expect(screen.queryByText(rows[0]!.id.slice(0, 8), { exact: false })).toBeNull();
});

it('shows a failed attempt and successful retry by creation time with full dates after closure', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-01-02T10:00:00Z').valueOf());
  const failed = await createOperation('project/add', { projectId: 'same-project' });
  await updateOperation(failed.id, 'not_sent');
  await acknowledgeOperation(failed.id);
  clock.mockReturnValue(new Date('2026-01-03T10:00:00Z').valueOf());
  const retry = await createOperation('project/add', { projectId: 'same-project' });
  await updateOperation(retry.id, 'accepted'); await acknowledgeOperation(retry.id);
  clock.mockRestore();
  const api = { call: vi.fn(), mutate: vi.fn() } as unknown as Api;
  const view = render(<OperationHistory api={api} runtimeReady recoveryEpoch="one" openThread={vi.fn()} />);
  await screen.findByText('本地操作记录 2 条');
  const rows = view.container.querySelectorAll('.recovery-row');
  expect(rows[0]!.textContent).toContain(retry.id.slice(0, 8));
  expect(rows[1]!.textContent).toContain(failed.id.slice(0, 8));
  expect(rows[0]!.textContent).toContain(new Date(retry.createdAt).toLocaleString());
  expect(rows[1]!.textContent).toContain(new Date(failed.createdAt).toLocaleString());
  expect(rows[0]!.textContent).toContain('已受理'); expect(rows[1]!.textContent).toContain('确定未发送');
  expect(await listOperations()).toEqual([]);
  expect(api.call).not.toHaveBeenCalled(); expect(api.mutate).not.toHaveBeenCalled();
});

it('updates to a closed unknown history row without exposing queries or recovery actions again', async () => {
  const record = await createOperation('turn/start', { threadId: 'source' });
  await updateOperation(record.id, 'unknown');
  const api = { call: vi.fn(), mutate: vi.fn() } as unknown as Api;
  const openThread = vi.fn();
  render(<OperationHistory api={api} runtimeReady recoveryEpoch="one" openThread={openThread} />);
  await screen.findByRole('button', { name: '查询回执' });
  await act(async () => { await stopUnknownRecovery(record.id, { operationId: record.id, state: 'unknown' }); });
  await screen.findByText(/结果未知 · 已停止本地恢复/);
  expect(screen.queryByRole('button', { name: /查询回执|停止恢复此操作|阻止尚未登记/ })).toBeNull();
  expect(screen.queryByRole('checkbox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '打开' }));
  expect(openThread).toHaveBeenCalledExactlyOnceWith('source');
  expect(await listOperations()).toEqual([]);
  expect(api.call).not.toHaveBeenCalled(); expect(api.mutate).not.toHaveBeenCalled();
  await act(async () => { await updateOperation(record.id, 'accepted'); });
  await waitFor(() => expect(screen.getByText(/结果未知 · 已停止本地恢复/)).toBeTruthy());
});
