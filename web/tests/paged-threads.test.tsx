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
it('keeps all previously confirmed pages on failed refresh and retries the same number of pages', async () => {
  let round = 0; const visits: string[] = [];
  const api = { call: vi.fn(async (_m: string, p: { cursor?: string }) => {
    const i = Number(p.cursor ?? 0); visits.push(round + '/' + i);
    if (round === 1 && i === 1) throw new Error('interrupted');
    return { data: [{ id: String(i), round }], nextCursor: i === 2 ? null : String(i+1) };
  }) } as unknown as Api;
  const v = renderHook(() => usePaged<{ id: string; round: number }>(api, 'thread/list', {}, 'p'));
  await waitFor(() => expect(v.result.current.items).toHaveLength(1));
  await act(() => v.result.current.more()); await act(() => v.result.current.more());
  round = 1; act(() => v.result.current.refresh());
  await waitFor(() => expect(v.result.current.error).toBe('interrupted'));
  expect(v.result.current.items.map(row => row.round)).toEqual([0,0,0]);
  round = 2; act(() => v.result.current.refresh());
  await waitFor(() => expect(v.result.current.items.map(row => row.round)).toEqual([2,2,2]));
  expect(visits).toEqual(['0/0','0/1','0/2','1/0','1/1','2/0','2/1','2/2']);
});

it.each([
  { sortKey: undefined, sortDirection: undefined, expected: ['later-created', 'native-one', 'native-two', 'earlier-created', 'unknown'] },
  { sortKey: 'updated_at', sortDirection: 'asc', expected: ['later-created', 'native-one', 'native-two', 'earlier-created', 'unknown'] },
  { sortKey: 'recency_at', sortDirection: 'desc', expected: ['earlier-created', 'native-one', 'native-two', 'later-created', 'unknown'] },
  { sortKey: 'section_position', sortDirection: 'asc', expected: ['earlier-created', 'later-created', 'unknown', 'native-one', 'native-two'] },
])('merges $sortKey/$sortDirection without disturbing native order within one second', async ({ sortKey, sortDirection, expected }) => {
  const second = 1_790_000_000;
  const native = { createdAt: second, updatedAt: second, recencyAt: null };
  const api = { call: vi.fn().mockResolvedValue({
    data: [{ ...native, id: 'native-one' }, { ...native, id: 'native-two' }],
    liveData: [
      { id: 'earlier-created', createdAt: (second - 5) * 1000, updatedAt: (second + 3) * 1000, recencyAt: null },
      { id: 'later-created', createdAt: second + 5, updatedAt: second - 1, recencyAt: second - 4 },
      { id: 'unknown' },
    ], nextCursor: null,
  }) } as unknown as Api;
  const view = renderHook(() => usePaged<{ id: string }>(api, 'thread/list', { sortKey, sortDirection }, 'project'));
  await waitFor(() => expect(view.result.current.items.map(row => row.id)).toEqual(expected));
});
