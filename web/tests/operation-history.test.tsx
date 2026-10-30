// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Api } from '../lib/api';
import { createOperation, listOperations, updateOperation } from '../lib/operations';
import { OperationHistory } from '../components/OperationHistory';
import { Recovery } from '../components/Recovery';

afterEach(cleanup);

it('shows completed records only in history and clears them without touching unknown results', async () => {
  const accepted = await createOperation('conversation/start', { projectId: 'project' });
  await updateOperation(accepted.id, 'accepted', 'created-thread');
  const failed = await createOperation('system/provider/write', {});
  await updateOperation(failed.id, 'not_sent');
  const unresolved = await createOperation('turn/start', { threadId: 'existing' });
  await updateOperation(unresolved.id, 'unknown');
  const openThread = vi.fn();
  render(<OperationHistory api={{ call: vi.fn() } as unknown as Api} runtimeReady recoveryEpoch="one" openThread={openThread} />);
  await screen.findByText('本地操作记录 3 条');
  expect(screen.getByText(accepted.id.slice(0, 8), { exact: false })).toBeTruthy();
  fireEvent.click(screen.getAllByRole('button', { name: '打开' })[0]!);
  expect(openThread).toHaveBeenCalledWith('created-thread');
  fireEvent.click(screen.getByText('清理已完成记录（2 条）'));
  expect(screen.getByRole('button', { name: '清理已完成记录' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByLabelText('我已核对这些操作的结果'));
  fireEvent.click(screen.getByRole('button', { name: '清理已完成记录' }));
  await waitFor(async () => expect(await listOperations()).toEqual([expect.objectContaining({ id: unresolved.id, state: 'unknown' })]));
  await screen.findByText('本地操作记录 1 条');
});

it('warns before capacity is exhausted even when every retained receipt succeeded', async () => {
  const rows = Array.from({ length: 180 }, (_, index) => ({ id: crypto.randomUUID(), method: 'conversation/start',
    projectId: `project-${index}`, state: 'accepted' as const, createdAt: index }));
  render(<Recovery api={{ call: vi.fn() } as unknown as Api} operations={rows} error="" openThread={vi.fn()} runtimeReady recoveryEpoch="one" />);
  expect(screen.getByText('本地操作记录接近上限')).toBeTruthy();
  expect(screen.getByText(/设置 → 操作记录/)).toBeTruthy();
  expect(screen.queryByText(rows[0]!.id.slice(0, 8), { exact: false })).toBeNull();
});

it('requires review again when a new completed result arrives before bulk clearing', async () => {
  const first = await createOperation('conversation/start', { projectId: 'first' });
  await updateOperation(first.id, 'accepted', 'first-thread');
  render(<OperationHistory api={{ call: vi.fn() } as unknown as Api} runtimeReady recoveryEpoch="one" openThread={vi.fn()} />);
  await screen.findByText('本地操作记录 1 条');
  fireEvent.click(screen.getByText('清理已完成记录（1 条）'));
  fireEvent.click(screen.getByLabelText('我已核对这些操作的结果'));
  expect(screen.getByRole('button', { name: '清理已完成记录' }).hasAttribute('disabled')).toBe(false);
  const next = await act(async () => createOperation('conversation/start', { projectId: 'second' }));
  await screen.findByText('本地操作记录 2 条');
  expect(screen.getByText('清理已完成记录（1 条）')).toBeTruthy();
  expect(screen.getByRole('button', { name: '清理已完成记录' }).hasAttribute('disabled')).toBe(false);
  await act(async () => { await updateOperation(next.id, 'accepted', 'unseen-thread'); });
  // Total count also includes pending records; wait for the completed set to change.
  await screen.findByText('清理已完成记录（2 条）');
  expect(screen.getByRole('button', { name: '清理已完成记录' }).hasAttribute('disabled')).toBe(true);
  expect((screen.getByLabelText('我已核对这些操作的结果') as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '清理已完成记录' }));
  expect(await listOperations()).toHaveLength(2);
});
