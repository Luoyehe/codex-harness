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
