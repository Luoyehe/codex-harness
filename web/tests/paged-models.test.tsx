// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Api } from '../lib/api';
import { usePaged } from '../hooks/usePaged';
afterEach(cleanup);

it('preserves same-name models from different providers across pages and updates the same provider entry', async () => {
  const api = { call: vi.fn()
    .mockResolvedValueOnce({ data: [{ id: 'shared', modelProvider: 'provider-a', displayName: 'A' }], nextCursor: 'page-2' })
    .mockResolvedValueOnce({ data: [{ id: 'shared', modelProvider: 'provider-b', displayName: 'B' },
      { id: 'shared', modelProvider: 'provider-a', displayName: 'A updated' }], nextCursor: null }) } as unknown as Api;
  const view = renderHook(() => usePaged<Record<string, unknown>>(api, 'model/list', {}, 'models'));
  await waitFor(() => expect(view.result.current.hasMore).toBe(true));
  await act(() => view.result.current.more());
  expect(view.result.current.items).toEqual([
    { id: 'shared', modelProvider: 'provider-a', displayName: 'A updated' },
    { id: 'shared', modelProvider: 'provider-b', displayName: 'B' },
  ]);
});

it('reports a failed provider while keeping working models available and clears the warning after recovery', async () => {
  const api = { call: vi.fn()
    .mockResolvedValueOnce({ data: [{ id: 'working', modelProvider: 'a' }], nextCursor: null,
      providerErrors: [{ name: 'ChatGPT', message: '无法读取模型目录，请检查该供应商的登录或连接。' }] })
    .mockResolvedValueOnce({ data: [{ id: 'working', modelProvider: 'a' }, { id: 'recovered', modelProvider: 'b' }], nextCursor: null }) } as unknown as Api;
  const view = renderHook(() => usePaged(api, 'model/list', {}, 'models'));
  await waitFor(() => expect(view.result.current.warning).toContain('ChatGPT'));
  expect(view.result.current.items).toHaveLength(1);
  expect(view.result.current.error).toBe('');
  act(() => view.result.current.refresh());
  await waitFor(() => expect(view.result.current.items).toHaveLength(2));
  expect(view.result.current.warning).toBe('');
});

it('never exposes old models on the first render of a changed identity and rejects its late page', async () => {
  let finish!: (value: unknown) => void;
  const api = { call: vi.fn(async (_method, params) => params.cursor
    ? new Promise(resolve => { finish = resolve; })
    : { data: [{ id: params.identity }], nextCursor: params.identity === 'native' ? 'old' : null }) } as unknown as Api;
  const renders: { identity: string; ids: string[] }[] = [];
  const view = renderHook(({ identity }) => {
    const directory = usePaged<{ id: string }>(api, 'model/list', { identity }, identity);
    renders.push({ identity, ids: directory.items.map(row => row.id) });
    return directory;
  }, { initialProps: { identity: 'native' } });
  await waitFor(() => expect(view.result.current.items).toEqual([{ id: 'native' }]));
  let oldPage!: Promise<void>;
  act(() => { oldPage = view.result.current.more(); });
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  view.rerender({ identity: 'root' });
  await waitFor(() => expect(view.result.current.items).toEqual([{ id: 'root' }]));
  await act(async () => { finish({ data: [{ id: 'late-native' }], nextCursor: null }); await oldPage; });
  expect(renders.filter(row => row.identity === 'root').every(row => !row.ids.includes('native') && !row.ids.includes('late-native'))).toBe(true);
  expect(view.result.current.items).toEqual([{ id: 'root' }]);
});

it('deduplicates simultaneous page requests from shared consumers', async () => {
  let finish!: (value: unknown) => void;
  const api = { call: vi.fn().mockResolvedValueOnce({ data: [{ id: 'first' }], nextCursor: 'next' })
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })) } as unknown as Api;
  const view = renderHook(() => usePaged(api, 'model/list', {}, 'shared'));
  await waitFor(() => expect(view.result.current.hasMore).toBe(true));
  let first!: Promise<void>, second!: Promise<void>;
  act(() => { first = view.result.current.more(); second = view.result.current.more(); });
  expect(api.call).toHaveBeenCalledTimes(2);
  await act(async () => { finish({ data: [{ id: 'second' }], nextCursor: null }); await Promise.all([first, second]); });
  expect(view.result.current.items).toEqual([{ id: 'first' }, { id: 'second' }]);
});
