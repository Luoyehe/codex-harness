// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RpcError, type Api } from '../lib/api';
import { useWorkspaceWatch } from '../hooks/useWorkspaceWatch';
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const scope = {
  projectId: 'project',
  epoch: 'one',
  directory: '',
  file: 'src.ts',
  enabled: true,
  connected: true,
};
it('reports only confirmed external version changes, including deletion, without overlapping reads', async () => {
  vi.useFakeTimers();
  let version = 'a',
    missing = false;
  const changed = vi.fn(),
    call = vi.fn(async (_method, params) => {
      if (missing && params.path) throw new RpcError('Gone', 'not_found');
      return { path: params.path, kind: params.path ? 'file' : 'directory', revision: version };
    });
  const api = { call } as unknown as Api;
  const view = renderHook(() => useWorkspaceWatch(api, scope, changed));
  await act(async () => {});
  expect(changed).not.toHaveBeenCalled();
  expect(call).toHaveBeenCalledTimes(2);
  version = 'b';
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(changed).toHaveBeenLastCalledWith(['', 'src.ts']);
  missing = true;
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(changed).toHaveBeenLastCalledWith(['src.ts']);
  view.unmount();
  const count = call.mock.calls.length;
  await act(() => vi.advanceTimersByTimeAsync(20000));
  expect(call).toHaveBeenCalledTimes(count);
});
it('does not poll ahead of a slow read or publish results after connection loss', async () => {
  vi.useFakeTimers();
  const pending: (() => void)[] = [],
    changed = vi.fn(),
    call = vi.fn(
      (_method, params) =>
        new Promise((resolve) =>
          pending.push(() => resolve({ path: params.path, kind: 'file', revision: 'a' })),
        ),
    );
  const api = { call } as unknown as Api,
    view = renderHook(({ connected }) => useWorkspaceWatch(api, { ...scope, connected }, changed), {
      initialProps: { connected: true },
    });
  await act(() => vi.advanceTimersByTimeAsync(30000));
  expect(call).toHaveBeenCalledTimes(2);
  view.rerender({ connected: false });
  await act(async () => pending.forEach((done) => done()));
  expect(changed).not.toHaveBeenCalled();
  expect(view.result.current.active).toBe(false);
  await act(() => vi.advanceTimersByTimeAsync(30000));
  expect(call).toHaveBeenCalledTimes(2);
});
