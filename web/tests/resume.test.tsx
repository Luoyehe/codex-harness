// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Api } from '../lib/api';
import { useResume } from '../hooks/useResume';
afterEach(cleanup);
it('loads the selected thread again after runtime replacement and ignores delayed prior defaults', async () => {
  const finish: ((value: Record<string, unknown>) => void)[] = [];
  const call = vi.fn(
    (_method: string, _params: unknown, _signal?: AbortSignal) =>
      new Promise<Record<string, unknown>>((resolve) => finish.push(resolve)),
  );
  const api = { call } as unknown as Api,
    loaded = vi.fn();
  const view = renderHook(({ epoch }) => useResume(api, 't', epoch, loaded), {
    initialProps: { epoch: 'one' },
  });
  await act(async () => finish[0]!({ requiresResume: false, thread: { id: 't' }, model: 'first' }));
  expect(view.result.current.resumedThread).toBe('t');
  view.rerender({ epoch: 'two' });
  expect(view.result.current.resumedThread).toBe('');
  view.rerender({ epoch: 'three' });
  await act(async () => finish[1]!({ requiresResume: false, thread: { id: 't' }, model: 'stale' }));
  expect(view.result.current.resumedThread).toBe('');
  await act(async () =>
    finish[2]!({ requiresResume: false, thread: { id: 't' }, model: 'current' }),
  );
  await waitFor(() =>
    expect(view.result.current.threadDefaults).toEqual({
      requiresResume: false,
      thread: { id: 't' },
      model: 'current',
    }),
  );
  expect(loaded).toHaveBeenCalledTimes(2);
  expect(call.mock.calls.every((args) => args[0] === 'thread/session')).toBe(true);
});
it('reads unloaded history metadata without silently resuming queued work', async () => {
  const call = vi.fn().mockResolvedValue({ requiresResume: true }),
    mutate = vi.fn(),
    loaded = vi.fn();
  const view = renderHook(() =>
    useResume({ call, mutate } as unknown as Api, 't', 'epoch', loaded),
  );
  await waitFor(() => expect(view.result.current.requiresResume).toBe(true));
  expect(view.result.current.resumedThread).toBe('');
  expect(loaded).not.toHaveBeenCalled();
  expect(mutate).not.toHaveBeenCalled();
  expect(call).toHaveBeenCalledWith('thread/session', { threadId: 't' }, expect.any(AbortSignal));
});
