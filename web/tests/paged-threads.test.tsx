// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Api } from '../lib/api';
import { usePaged } from '../hooks/usePaged';

afterEach(cleanup);
it('keeps a newly running thread visible before indexing, without duplicating its later indexed row', async () => {
  const api = { call: vi.fn()
    .mockResolvedValueOnce({ data: [{ id: 'old' }], liveData: [{ id: 'new', name: 'Running' }], nextCursor: 'native-cursor' })
    .mockResolvedValueOnce({ data: [{ id: 'new', name: 'Indexed' }], nextCursor: null })
    .mockResolvedValueOnce({ data: [{ id: 'new', name: 'Indexed' }, { id: 'old' }], liveData: [], nextCursor: null }) } as unknown as Api;
  const view = renderHook(() => usePaged<{ id: string; name?: string }>(api, 'thread/list', { projectId: 'p' }, 'p'));
  await waitFor(() => expect(view.result.current.items.map(row => row.id)).toEqual(['new', 'old']));
  await act(() => view.result.current.more());
  expect(vi.mocked(api.call).mock.calls[1]![1]).toMatchObject({ cursor: 'native-cursor' });
  expect(view.result.current.items).toEqual([{ id: 'new', name: 'Indexed' }, { id: 'old' }]);
  act(() => view.result.current.refresh());
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  expect(view.result.current.items).toEqual([{ id: 'new', name: 'Indexed' }, { id: 'old' }]);
});
it('never carries an unindexed thread into a different project or execution mode', async () => {
  let finish!: (value: unknown) => void;
  const api = { call: vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue({ data: [], liveData: [{ id: 'root-project' }], nextCursor: null }) } as unknown as Api;
  const view = renderHook(({ scope }) => usePaged(api, 'thread/list', {}, scope), { initialProps: { scope: 'native:p' } });
  view.rerender({ scope: 'root:q' });
  await waitFor(() => expect(view.result.current.items).toEqual([{ id: 'root-project' }]));
  await act(async () => finish({ data: [], liveData: [{ id: 'late-native' }], nextCursor: null }));
  expect(view.result.current.items).toEqual([{ id: 'root-project' }]);
});
it('reports a bounded live list without discarding the persistent directory', async () => {
  const api = { call: vi.fn().mockResolvedValueOnce({ data: [{ id: 'old' }], liveData: [{ id: 'new' }],
    liveDataTruncated: true, nextCursor: 'next' })
    .mockResolvedValueOnce({ data: [{ id: 'older' }], nextCursor: null })
    .mockResolvedValue({ data: [{ id: 'new' }, { id: 'old' }], liveData: [], liveDataTruncated: false, nextCursor: null }) } as unknown as Api;
  const view = renderHook(() => usePaged(api, 'thread/list', {}, 'p'));
  await waitFor(() => expect(view.result.current.warning).toContain('已加载会话'));
  expect(view.result.current.items).toEqual([{ id: 'new' }, { id: 'old' }]);
  await act(() => view.result.current.more());
  expect(view.result.current.warning).toContain('已加载会话');
  expect(view.result.current.items).toEqual([{ id: 'new' }, { id: 'old' }, { id: 'older' }]);
  act(() => view.result.current.refresh());
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  expect(view.result.current.warning).toBe('');
});
