// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Api } from '../lib/api';
import { Recovery, useOperations } from '../components/Recovery';
import { createOperation, listOperations, updateOperation } from '../lib/operations';
import { emptyDraft, readDraft, writeDraft } from '../lib/drafts';
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(cleanup);
function Harness({
  api,
  ready = true,
  epoch = 'one',
}: {
  api: Api;
  ready?: boolean;
  epoch?: string;
}) {
  const operations = useOperations();
  return (
    <Recovery
      api={api}
      operations={operations.operations}
      error={operations.error}
      openThread={vi.fn()}
      runtimeReady={ready}
      recoveryEpoch={epoch}
    />
  );
}
it('treats archived generation receipts as unknown and requires explicit review without retirement or resend', async () => {
  const op = (await createOperation('turn/start', { threadId: 't' }));
  const api = {
    call: vi
      .fn()
      .mockResolvedValue({
        operationId: op.id,
        scope: `operation:${op.id}`,
        method: 'operation/archived',
        state: 'unknown',
        error: { code: 'operation_archived' },
      }),
  } as unknown as Api;
  render(<Harness api={api} />);
  fireEvent.click(await screen.findByRole('button', { name: '查询回执' }));
  await screen.findByText(/该编号所属回执已归档/);
  expect((await listOperations())[0]?.state).toBe('unknown');
  expect(screen.queryByRole('button', { name: '阻止尚未登记的请求' })).toBeNull();
  expect(screen.getByRole('button', { name: '停止恢复此操作' }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(api.call).toHaveBeenCalledExactlyOnceWith('operation/read', { operationId: op.id });
});
it('closes only a positively read unknown receipt after explicit review, preserving the draft without a permanent tombstone', async () => {
  const draft = { ...emptyDraft('t'), text: 'unsent', options: { model: 'next' } };
  writeDraft(draft);
  const op = (await createOperation('turn/start', {
    threadId: 't',
    draftKey: 't',
    draftRevision: draft.revision,
  }));
  (await updateOperation(op.id, 'unknown'));
  const api = {
    call: vi.fn().mockResolvedValue({ operationId: op.id, state: 'unknown' }),
  } as unknown as Api;
  render(<Harness api={api} />);
  expect(screen.queryByRole('button', { name: '停止恢复此操作' })).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: '查询回执' }));
  const stop = await screen.findByRole('button', { name: '停止恢复此操作' });
  expect((stop as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(stop);
  expect((await listOperations())).toEqual([]);
  expect(readDraft('t')).toEqual(draft);
  await act(async () => {
    (await updateOperation(op.id, 'accepted'));
    localStorage.setItem(`harness.operation.v1.${op.id}`, JSON.stringify(op));
    window.dispatchEvent(new Event('storage'));
  });
  expect((await listOperations())).toEqual([]);
  expect(readDraft('t')).toEqual(draft);
  expect((await createOperation('turn/start', { threadId: 't' })).id).not.toBe(op.id);
  expect(api.call).toHaveBeenCalledExactlyOnceWith('operation/read', { operationId: op.id });
});
it('invalidates review proof on runtime changes and refuses a late read from the prior generation', async () => {
  const op = (await createOperation('turn/start', { threadId: 't' }));
  let finish!: (v: unknown) => void;
  const api = {
    call: vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    ),
  } as unknown as Api;
  const view = render(<Harness api={api} />);
  fireEvent.click(await screen.findByRole('button', { name: '查询回执' }));
  view.rerender(<Harness api={api} ready={false} />);
  view.rerender(<Harness api={api} />);
  await act(async () => finish({ operationId: op.id, state: 'unknown' }));
  expect(screen.queryByRole('button', { name: '停止恢复此操作' })).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: '查询回执' }));
  await act(async () => finish({ operationId: op.id, state: 'unknown' }));
  expect(await screen.findByRole('button', { name: '停止恢复此操作' })).toBeTruthy();
  view.rerender(<Harness api={api} epoch="two" />);
  expect(screen.queryByRole('button', { name: '停止恢复此操作' })).toBeNull();
});
it.each(['pending', 'dispatching', 'unknown'])(
  'keeps a registered %s operation blocked when retirement returns the existing fact',
  async (state) => {
    const op = (await createOperation('conversation/start', { projectId: 'p' }));
    const api = {
      call: vi
        .fn()
        .mockResolvedValueOnce({ operationId: op.id, state: 'not_received' })
        .mockResolvedValueOnce({ operationId: op.id, state }),
    } as unknown as Api;
    render(<Harness api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: '查询回执' }));
    fireEvent.click(await screen.findByRole('button', { name: '阻止尚未登记的请求' }));
    await waitFor(() =>
      expect(api.call).toHaveBeenCalledWith('operation/retire', { operationId: op.id }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '阻止尚未登记的请求' })).toBeNull(),
    );
    expect(screen.queryByRole('button', { name: '停止恢复此操作' })).toBeNull();
    await expect(createOperation('conversation/start', { projectId: 'p' })).rejects.toThrow('待确认');
  },
);
it('unblocks a missing operation only after retirement returns a not-sent fence', async () => {
  const op = (await createOperation('conversation/start', { projectId: 'p' }));
  const api = {
    call: vi
      .fn()
      .mockResolvedValueOnce({ operationId: op.id, state: 'not_received' })
      .mockResolvedValueOnce({ operationId: op.id, state: 'not_sent' }),
  } as unknown as Api;
  render(<Harness api={api} />);
  fireEvent.click(await screen.findByRole('button', { name: '查询回执' }));
  const retire = await screen.findByRole('button', { name: '阻止尚未登记的请求' });
  await expect(createOperation('conversation/start', { projectId: 'p' })).rejects.toThrow();
  fireEvent.click(retire);
  await screen.findByRole('button', { name: '已知悉' });
  expect((await listOperations())[0]?.state).toBe('not_sent');
  await expect(createOperation('conversation/start', { projectId: 'p' })).resolves.toBeDefined();
});
