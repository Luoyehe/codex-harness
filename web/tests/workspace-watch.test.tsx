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

it('reports a partial failure promptly, waits for its slow sibling, then retries against the last complete baseline', async () => {
  vi.useFakeTimers();
  let version = 'a',
    failing = false,
    finish!: () => void;
  const changed = vi.fn(),
    call = vi.fn(async (_method, params) => {
      if (failing) {
        if (!params.path) throw new Error('Directory unavailable');
        return new Promise((resolve) => {
          finish = () => resolve({ path: params.path, kind: 'file', revision: 'b' });
        });
      }
      return { path: params.path, kind: params.path ? 'file' : 'directory', revision: version };
    }),
    api = { call } as unknown as Api;
  const view = renderHook(() => useWorkspaceWatch(api, scope, changed));
  await act(async () => {});
  const checkedAt = view.result.current.checkedAt;
  failing = true;
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(view.result.current.error).toBe('Directory unavailable');
  expect(view.result.current.checkedAt).toBe(checkedAt);
  await act(() => vi.advanceTimersByTimeAsync(20000));
  expect(call).toHaveBeenCalledTimes(4);
  expect(changed).not.toHaveBeenCalled();
  failing = false;
  version = 'b';
  await act(async () => finish());
  expect(changed).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(4999));
  expect(call).toHaveBeenCalledTimes(4);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(call).toHaveBeenCalledTimes(6);
  expect(changed).toHaveBeenCalledExactlyOnceWith(['', 'src.ts']);
  expect(view.result.current.error).toBe('');
  expect(view.result.current.checkedAt).toBeGreaterThan(checkedAt!);
});

it.each(['disabled', 'disconnected', 'unmounted'] as const)(
  'does not restart a failed poll after its late sibling rejects while %s',
  async (transition) => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void,
      signal!: AbortSignal;
    const changed = vi.fn(),
      call = vi.fn(async (_method, params, requestSignal: AbortSignal) => {
        if (!params.path) throw new Error('Directory unavailable');
        signal = requestSignal;
        return new Promise((_resolve, fail) => {
          reject = fail;
        });
      }),
      api = { call } as unknown as Api;
    const view = renderHook(
      ({ enabled, connected }) => useWorkspaceWatch(api, { ...scope, enabled, connected }, changed),
      { initialProps: { enabled: true, connected: true } },
    );
    await act(async () => {});
    expect(view.result.current.error).toBe('Directory unavailable');
    if (transition === 'unmounted') view.unmount();
    else view.rerender({ enabled: transition !== 'disabled', connected: transition !== 'disconnected' });
    expect(signal.aborted).toBe(true);
    await act(async () => reject(new Error('Late file failure')));
    await act(() => vi.advanceTimersByTimeAsync(30000));
    expect(call).toHaveBeenCalledTimes(2);
    expect(changed).not.toHaveBeenCalled();
    if (transition !== 'unmounted') {
      expect(view.result.current.active).toBe(false);
      expect(view.result.current.error).toBe('');
    }
  },
);

it('keeps a replacement owner on its own schedule after the old failed poll finishes', async () => {
  vi.useFakeTimers();
  let oldOwner = true,
    version = 'b',
    finish!: () => void,
    oldSignal!: AbortSignal;
  const changed = vi.fn(),
    call = vi.fn(async (_method, params, signal: AbortSignal) => {
      if (oldOwner) {
        if (!params.path) throw new Error('Old directory unavailable');
        oldSignal = signal;
        return new Promise((resolve) => {
          finish = () => resolve({ path: params.path, kind: 'file', revision: 'obsolete' });
        });
      }
      return { path: params.path, kind: params.path ? 'file' : 'directory', revision: version };
    }),
    api = { call } as unknown as Api;
  const view = renderHook(({ epoch }) => useWorkspaceWatch(api, { ...scope, epoch }, changed), {
    initialProps: { epoch: 'one' },
  });
  await act(async () => {});
  oldOwner = false;
  view.rerender({ epoch: 'two' });
  await act(async () => {});
  expect(oldSignal.aborted).toBe(true);
  expect(view.result.current.error).toBe('');
  await act(() => vi.advanceTimersByTimeAsync(1000));
  await act(async () => finish());
  version = 'c';
  await act(() => vi.advanceTimersByTimeAsync(4000));
  expect(call).toHaveBeenCalledTimes(6);
  expect(changed).toHaveBeenCalledExactlyOnceWith(['', 'src.ts']);
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(call).toHaveBeenCalledTimes(6);
  expect(view.result.current.error).toBe('');
});
