// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import {
  captureHook,
  HookEventsPanel,
  HookEventsProvider,
  type HookSnapshot,
} from '../components/HookEventsPanel';
import { Events } from '../lib/events';
import type { HarnessEvent } from '../lib/types';
const event = (id = 'run', status = 'running', extra = {}): HarnessEvent => ({
  type: 'notification',
  data: {
    method: status === 'running' ? 'hook/started' : 'hook/completed',
    params: {
      threadId: 'thread',
      turnId: 'turn',
      run: {
        id,
        status,
        eventName: 'Stop',
        source: 'project',
        sourcePath: '/project/hooks',
        handlerType: 'command',
        executionMode: 'sync',
        scope: 'turn',
        startedAt: 10,
        completedAt: status === 'running' ? null : 11,
        durationMs: status === 'running' ? null : 25,
        entries: [],
        ...extra,
      },
    },
  },
});
afterEach(cleanup);
it('captures while the panel is closed, merges run identities, and renders output as text', () => {
  const events = new Events();
  const view = render(
    <HookEventsProvider events={events} lease="owner" connected>
      <span>closed</span>
    </HookEventsProvider>,
  );
  act(() => events.publish(event()));
  view.rerender(
    <HookEventsProvider events={events} lease="owner" connected>
      <HookEventsPanel />
    </HookEventsProvider>,
  );
  expect(screen.getByText(/Stop · 运行中/)).toBeTruthy();
  act(() =>
    events.publish(
      event('run', 'failed', {
        statusMessage: 'blocked failure',
        entries: [{ kind: 'error', text: '<script>danger()</script> https://example.invalid/run' }],
      }),
    ),
  );
  expect(screen.queryByText(/Stop · 运行中/)).toBeNull();
  expect(screen.getByText(/Stop · 失败/)).toBeTruthy();
  expect(screen.getByText('<script>danger()</script> https://example.invalid/run')).toBeTruthy();
  expect(document.querySelector('script')).toBeNull();
  expect(document.querySelector('a')).toBeNull();
  act(() => events.publish(event()));
  expect(screen.queryByText(/Stop · 运行中/)).toBeNull();
});
it('clears records immediately on disconnect and never carries them to another lease', () => {
  const events = new Events();
  const view = render(
    <HookEventsProvider events={events} lease="owner" connected>
      <HookEventsPanel />
    </HookEventsProvider>,
  );
  act(() => events.publish(event()));
  view.rerender(
    <HookEventsProvider events={events} lease="owner" connected={false}>
      <HookEventsPanel />
    </HookEventsProvider>,
  );
  expect(screen.queryByText(/Stop · 运行中/)).toBeNull();
  act(() => events.publish(event('offline')));
  view.rerender(
    <HookEventsProvider events={events} lease="next-owner" connected>
      <HookEventsPanel />
    </HookEventsProvider>,
  );
  expect(screen.queryByText(/Stop · 运行中/)).toBeNull();
  act(() => events.publish(event('new')));
  expect(screen.getByText(/Stop · 运行中/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '清除本页运行记录' }));
  expect(screen.queryByText(/Stop · 运行中/)).toBeNull();
});
it('bounds record count and retained bytes and explicitly marks truncated or malformed notifications', () => {
  let state: HookSnapshot = { records: [], discarded: 0, malformed: 0 };
  for (let i = 0; i < 105; i++) state = captureHook(state, event(String(i), 'completed'));
  expect(state.records).toHaveLength(100);
  expect(state.discarded).toBe(5);
  expect(state.records[0]?.id).toBe('104');
  for (let i = 0; i < 100; i++)
    state = captureHook(
      state,
      event(`large-${i}`, 'completed', {
        entries: [{ kind: 'context', text: '语'.repeat(30000) }],
      }),
    );
  expect(new TextEncoder().encode(JSON.stringify(state.records)).byteLength).toBeLessThanOrEqual(
    512 * 1024,
  );
  expect(state.records.every((row) => row.truncated)).toBe(true);
  expect(state.discarded).toBeGreaterThan(5);
  state = captureHook(state, {
    type: 'notification',
    data: { method: 'hook/completed', params: { run: { id: 'missing-thread' } } },
  });
  expect(state.malformed).toBe(1);
});
it('keeps equal run ids in different threads separate and filters the visible range', () => {
  const events = new Events();
  render(
    <HookEventsProvider events={events} lease="owner" connected>
      <HookEventsPanel />
    </HookEventsProvider>,
  );
  const second = event('run', 'blocked');
  (second.data.params as Record<string, unknown>).threadId = 'second';
  act(() => {
    events.publish(event());
    events.publish(second);
  });
  expect(screen.getByText(/Stop · 运行中/)).toBeTruthy();
  expect(screen.getByText(/Stop · 已阻止/)).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox', { name: '运行记录的会话范围' }), {
    target: { value: 'second' },
  });
  expect(screen.queryByText(/Stop · 运行中/)).toBeNull();
  expect(screen.getByText(/Stop · 已阻止/)).toBeTruthy();
});
