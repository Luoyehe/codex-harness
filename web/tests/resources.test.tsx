// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useResource } from '../hooks/useResource';
afterEach(cleanup);
describe('resource generations', () => {
  it('does not allow a slow old selection to replace a newer page result', async () => {
    let resolveOld!: (v: string) => void;
    const old = new Promise<string>(resolve => { resolveOld = resolve; });
    const { result, rerender } = renderHook(({ key }) => useResource(key, async () => key === 'old' ? old : 'new data'), { initialProps: { key: 'old' } });
    rerender({ key: 'new' }); await waitFor(() => expect(result.current.data).toBe('new data'));
    await act(async () => resolveOld('old data')); expect(result.current.data).toBe('new data'); expect(result.current.loading).toBe(false);
  });
  it('keeps an unrelated slow resource from blocking an independent read', async () => {
    const { result } = renderHook(() => ({ mcp: useResource('mcp', () => new Promise(() => {})), history: useResource('history', async () => ['readable']) }));
    await waitFor(() => expect(result.current.history.data).toEqual(['readable'])); expect(result.current.mcp.loading).toBe(true);
  });
  it('never exposes the prior value as current during refresh or a new-key render', async () => {
    let finish!: (v: string) => void;
    const snapshots: { key: string; data: string | undefined; loading: boolean }[] = [];
    const view = renderHook(({ name }) => { const resource = useResource(name, () => new Promise<string>(resolve => { finish = resolve; })); snapshots.push({ key: name, data: resource.data, loading: resource.loading }); return resource; }, { initialProps: { name: 'a' } });
    await act(async () => finish('a-defaults')); snapshots.length = 0;
    act(() => view.result.current.refresh()); expect(snapshots.every(s => s.data === undefined && s.loading)).toBe(true);
    await act(async () => finish('refreshed')); snapshots.length = 0;
    view.rerender({ name: 'b' }); expect(snapshots.every(s => s.data === undefined && s.loading)).toBe(true);
  });
});
