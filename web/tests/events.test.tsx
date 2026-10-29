// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listOperations } from '../lib/operations';
import { Api } from '../lib/api';
import { useEvents } from '../hooks/useEvents';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe('transport and runtime state separation', () => {
  it('updates operation generation from state events even without a runtime reconnect', () => {
    let socket!: { onmessage: (event: { data: string }) => void };
    vi.stubGlobal(
      'WebSocket',
      class {
        onmessage = (_: { data: string }) => {};
        close() {}
        constructor() {
          socket = this;
        }
      },
    );
    const api = new Api();
    renderHook(() => useEvents(api, vi.fn()));
    for (const generation of [1, 2, 1])
      act(() =>
        socket.onmessage({
          data: JSON.stringify({ type: 'state', data: { operationGeneration: generation } }),
        }),
      );
    expect(api.operationGeneration).toBe(2);
  });
  it('allows configuration only when the runtime reports no work, terminals or subscriptions', () => {
    let socket!: { onmessage: (e: { data: string }) => void };
    vi.stubGlobal(
      'WebSocket',
      class {
        onmessage = (_e: { data: string }) => {};
        close() {}
        constructor() {
          socket = this;
        }
      },
    );
    const api = { clientId: 'client' } as Api;
    const { result } = renderHook(() => useEvents(api, vi.fn()));
    const state = (extra = {}) =>
      act(() =>
        socket.onmessage({
          data: JSON.stringify({
            type: 'state',
            data: {
              connected: true,
              activity: {
                unknown: false,
                activeThreads: [],
                pendingStarts: 0,
                terminals: 0,
                subscriptions: 0,
                ...extra,
              },
            },
          }),
        }),
      );
    state();
    expect(result.current.configurationReady).toBe(true);
    for (const extra of [
      { activeThreads: ['thread'] },
      { pendingStarts: 1 },
      { terminals: 1 },
      { subscriptions: 1 },
      { processes: 1 },
      { unknown: true },
    ]) {
      state(extra);
      expect(result.current.configurationReady).toBe(false);
    }
  });
  it('advances one resource generation on same-worker recovery, never on repeated healthy snapshots', () => {
    let socket!: {
      onopen: () => void;
      onmessage: (e: { data: string }) => void;
      close: () => void;
    };
    vi.stubGlobal(
      'WebSocket',
      class {
        onopen = () => {};
        onmessage = (_e: { data: string }) => {};
        close() {}
        constructor() {
          socket = this;
        }
      },
    );
    const api = { clientId: 'client' } as Api;
    const { result } = renderHook(() => useEvents(api, vi.fn()));
    const state = (connected: boolean, epoch = 'same') =>
      socket.onmessage({
        data: JSON.stringify({
          type: 'state',
          data: { connected, epoch, activity: { unknown: !connected } },
        }),
      });
    act(() => socket.onopen());
    expect(result.current.revision).toBe(0);
    act(() => state(true));
    expect(result.current.revision).toBe(1);
    const firstConnection = result.current.connectionId;
    expect(firstConnection).not.toBe('');
    act(() => {
      state(true);
      state(true);
    });
    expect(result.current.revision).toBe(1);
    expect(result.current.connectionId).toBe(firstConnection);
    act(() => state(false));
    expect(result.current.activityReady).toBe(false);
    act(() => state(true));
    expect(result.current.revision).toBe(2);
    expect(result.current.epoch).toBe('same');
    expect(result.current.connectionId).not.toBe(firstConnection);
    act(() => state(true, 'replacement'));
    expect(result.current.revision).toBe(3);
  });
  it('checks the session on socket loss and does not reconnect a confirmed logged-out document', async () => {
    const sockets: { onopen: () => void; onclose: () => void; close: () => void }[] = [];
    vi.stubGlobal(
      'WebSocket',
      class {
        onopen = () => {};
        onclose = () => {};
        close() {}
        constructor() {
          sockets.push(this);
        }
      },
    );
    const session = vi.fn().mockResolvedValue({ authenticated: false });
    const api = { clientId: 'client', session } as unknown as Api;
    const { result } = renderHook(() => useEvents(api, vi.fn()));
    await act(async () => {
      sockets[0]!.onopen();
      sockets[0]!.onclose();
    });
    expect(session).toHaveBeenCalledOnce();
    expect(result.current.connection).toBe('offline');
    expect(sockets).toHaveLength(1);
  });
  it('reads a gateway snapshot nested runtime epoch and keeps unknown activity conservative', () => {
    let socket!: {
      onopen: () => void;
      onclose: () => void;
      onmessage: (e: { data: string }) => void;
      close: () => void;
    };
    vi.stubGlobal(
      'WebSocket',
      class {
        onopen = () => {};
        onclose = () => {};
        onmessage = (_e: { data: string }) => {};
        close() {}
        constructor() {
          socket = this;
        }
      },
    );
    const api = { clientId: 'client' } as Api;
    const { result } = renderHook(() => useEvents(api, vi.fn()));
    act(() => {
      socket.onopen();
      socket.onmessage({
        data: JSON.stringify({
          type: 'state',
          data: {
            connected: true,
            runtime: { epoch: 'worker-a', connected: true, activity: { unknown: false } },
            activityUncertain: false,
          },
        }),
      });
    });
    expect(result.current).toMatchObject({
      connection: 'connected',
      runtimeConnected: true,
      activityReady: true,
      epoch: 'worker-a',
    });
    act(() =>
      socket.onmessage({
        data: JSON.stringify({
          type: 'state',
          data: { connected: true, epoch: 'worker-a', activity: { unknown: true } },
        }),
      }),
    );
    expect(result.current.runtimeConnected).toBe(true);
    expect(result.current.activityReady).toBe(false);
    act(() =>
      socket.onmessage({
        data: JSON.stringify({
          type: 'state',
          data: {
            connected: true,
            epoch: 'worker-a',
            activity: { unknown: false },
            maintenance: true,
          },
        }),
      }),
    );
    expect(result.current.activityReady).toBe(false);
    act(() =>
      socket.onmessage({
        data: JSON.stringify({
          type: 'state',
          data: {
            connected: true,
            epoch: 'worker-a',
            activity: { unknown: false },
            maintenance: false,
          },
        }),
      }),
    );
    expect(result.current.activityReady).toBe(true);
    act(() => socket.onclose());
    expect(result.current.runtimeConnected).toBe(false);
    expect(result.current.activityReady).toBe(false);
  });
});

it('cancels an intent waiting for durable creation when the runtime disconnects without closing the socket', async () => {
  let socket!: { onmessage: (event: { data: string }) => void };
  vi.stubGlobal('WebSocket', class {
    onmessage = (_: { data: string }) => {};
    close() {}
    constructor() { socket = this; }
  });
  const api = new Api(), prepare = vi.fn(), fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  renderHook(() => useEvents(api, vi.fn()));
  const state = (connected: boolean) => act(() => socket.onmessage({
    data: JSON.stringify({ type: 'state', data: { connected, epoch: 'same', activity: { unknown: !connected } } }),
  }));
  state(true);
  const intent = api.beginMutation('project/add', {}, prepare);
  state(false);
  await expect(intent.result).rejects.toMatchObject({ delivery: 'not_sent' });
  expect(prepare).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  expect(await listOperations()).toEqual([expect.objectContaining({ id: intent.operationId, state: 'not_sent' })]);
});
