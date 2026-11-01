// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Events } from '../lib/events';
import { useSidebarRefresh } from '../hooks/useSidebarRefresh';

afterEach(() => { cleanup(); vi.useRealTimers(); });
it('coalesces lifecycle events and local mutations, ignores stream deltas and rejected operations', () => {
  vi.useFakeTimers();
  const events = new Events(), projects = vi.fn(), threads = vi.fn(), search = vi.fn();
  const { result } = renderHook(() => useSidebarRefresh(events, 'root', { projects, threads, search }));
  act(() => {
    events.publish({ type: 'notification', data: { method: 'thread/started' } });
    events.publish({ type: 'receipt', data: { state: 'accepted', method: 'conversation/start' } });
    result.current();
    events.publish({ type: 'receipt', data: { state: 'accepted', method: 'project/rename' } });
    vi.advanceTimersByTime(100);
  });
  expect(projects).toHaveBeenCalledTimes(1); expect(threads).toHaveBeenCalledTimes(1); expect(search).toHaveBeenCalledTimes(1);
  act(() => {
    for (let i = 0; i < 50; i++) events.publish({ type: 'notification', data: { method: 'item/agentMessage/delta' } });
    events.publish({ type: 'receipt', data: { state: 'not_sent', method: 'project/create' } });
    events.publish({ type: 'receipt', data: { state: 'pending', method: 'thread/delete' } });
    vi.advanceTimersByTime(500);
  });
  expect(threads).toHaveBeenCalledTimes(1);
});
it('refreshes both ordinary and searched lists on remote mutations, including uncertain outcomes', () => {
  vi.useFakeTimers();
  const events = new Events(), projects = vi.fn(), threads = vi.fn(), search = vi.fn();
  renderHook(() => useSidebarRefresh(events, 'root', { projects, threads, search }));
  const methods = ['thread/name/set', 'thread/archive', 'thread/unarchive', 'thread/delete', 'thread/fork', 'thread/section/move'];
  for (const method of methods) act(() => {
    events.publish({ type: 'receipt', data: { state: 'accepted', method } });
    vi.advanceTimersByTime(100);
  });
  act(() => {
    events.publish({ type: 'receipt', data: { state: 'unknown', method: 'project/add' } });
    vi.advanceTimersByTime(100);
  });
  expect(threads).toHaveBeenCalledTimes(methods.length + 1); expect(search).toHaveBeenCalledTimes(methods.length + 1);
  expect(projects).toHaveBeenCalledTimes(1);
});
it('drops a queued old-mode refresh and detaches its subscription on unmount', () => {
  vi.useFakeTimers();
  const events = new Events(), projects = vi.fn(), threads = vi.fn(), search = vi.fn();
  const { rerender, unmount } = renderHook(({ scope }) => useSidebarRefresh(events, scope, { projects, threads, search }),
    { initialProps: { scope: 'native' } });
  act(() => events.publish({ type: 'notification', data: { method: 'thread/started' } }));
  rerender({ scope: 'root' });
  act(() => vi.advanceTimersByTime(100)); expect(threads).not.toHaveBeenCalled();
  act(() => events.publish({ type: 'notification', data: { method: 'turn/completed' } }));
  unmount();
  act(() => vi.advanceTimersByTime(100)); expect(threads).not.toHaveBeenCalled();
});
