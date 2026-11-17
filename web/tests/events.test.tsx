// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listOperations } from '../lib/operations';
import { Api } from '../lib/api';
import { useEvents } from '../hooks/useEvents';
import { MAX_EVENT_BYTES } from '../../src/shared/event-limits';
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function sizedEvent(bytes: number, character = 'a') {
  const envelope = JSON.stringify({ type: 'notification', data: { text: '' } });
  const remaining = bytes - new TextEncoder().encode(envelope).byteLength;
  const width = new TextEncoder().encode(character).byteLength;
  return JSON.stringify({ type: 'notification', data: {
    text: character.repeat(Math.floor(remaining / width)) + 'a'.repeat(remaining % width),
  } });
}

it.each([
  ['large ASCII', 2 * 1024 * 1024 + 1, 'a'],
  ['maximum ASCII', MAX_EVENT_BYTES, 'a'],
  ['maximum UTF-8', MAX_EVENT_BYTES, '界'],
] as const)('delivers a legal %s event under the shared byte contract', (_name, bytes, character) => {
  let socket!: { onmessage: (event: { data: string }) => void; close: ReturnType<typeof vi.fn> };
  vi.stubGlobal('WebSocket', class {
    onmessage = (_event: { data: string }) => {};
    close = vi.fn();
    constructor() { socket = this; }
  });
  const onEvent = vi.fn(), api = { clientId: 'owner' } as Api;
  const { result } = renderHook(() => useEvents(api, onEvent));
  const payload = sizedEvent(bytes, character);
  expect(new TextEncoder().encode(payload).byteLength).toBe(bytes);
  act(() => socket.onmessage({ data: payload }));
  expect(socket.close).not.toHaveBeenCalled();
  expect(onEvent).toHaveBeenCalledExactlyOnceWith(JSON.parse(payload));
  expect(result.current.error).toBe('');
});

it('rejects a UTF-8 oversized event, reconnects and receives fresh state without replaying work', async () => {
  vi.useFakeTimers();
  class Socket {
    onopen = () => {};
    onclose = () => {};
    onmessage = (_event: { data: string }) => {};
    close = vi.fn(() => this.onclose());
    constructor() { sockets.push(this); }
  }
  const sockets: Socket[] = [];
  vi.stubGlobal('WebSocket', Socket);
  const session = vi.fn().mockResolvedValue({ authenticated: true }), call = vi.fn(), mutate = vi.fn();
  const api = { clientId: 'owner', session, call, mutate, connectionChanged: vi.fn() } as unknown as Api;
  const onEvent = vi.fn(), { result } = renderHook(() => useEvents(api, onEvent));
  const state = (epoch: string) => JSON.stringify({ type: 'state', data: {
    connected: true, epoch, activity: { unknown: false, activeThreads: [], pendingStarts: 0, terminals: 0 },
  } });
  act(() => { sockets[0]!.onopen(); sockets[0]!.onmessage({ data: state('before') }); });
  expect(result.current.activityReady).toBe(true);
  onEvent.mockClear();
  const payload = sizedEvent(MAX_EVENT_BYTES + 1, '界');
  expect(payload.length).toBeLessThan(MAX_EVENT_BYTES);
  expect(new TextEncoder().encode(payload).byteLength).toBe(MAX_EVENT_BYTES + 1);
  await act(async () => sockets[0]!.onmessage({ data: payload }));
  expect(onEvent).not.toHaveBeenCalled();
  expect(sockets[0]!.close).toHaveBeenCalledOnce();
  expect(result.current.error).toContain('超过传输上限');
  expect(result.current.activityReady).toBe(false);
  expect(session).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(sockets).toHaveLength(2);
  act(() => { sockets[1]!.onopen(); sockets[1]!.onmessage({ data: state('after') }); });
  expect(result.current).toMatchObject({ epoch: 'after', activityReady: true, connection: 'connected' });
  expect(onEvent).toHaveBeenCalledExactlyOnceWith(JSON.parse(state('after')));
  expect(call).not.toHaveBeenCalled(); expect(mutate).not.toHaveBeenCalled();
});

describe('transport and runtime state separation', () => {
  it('keeps the previous ROOT warning until a connected runtime confirms native identity', () => {
    let socket!: { onmessage: (event: { data: string }) => void; onclose: () => void };
    vi.stubGlobal('WebSocket', class { onmessage = (_: { data: string }) => {}; onclose = () => {}; close() {} constructor() { socket = this; } });
    const api = { clientId: 'owner', connectionChanged: vi.fn(), session: vi.fn().mockResolvedValue({ authenticated: false }) } as unknown as Api;
    const { result } = renderHook(() => useEvents(api, vi.fn()));
    const state = (extra: Record<string, unknown>) => act(() => socket.onmessage({ data: JSON.stringify({ type: 'state', data: {
      connected: true, epoch: 'one', activity: { unknown: false, activeThreads: [], pendingStarts: 0, terminals: 0 }, ...extra,
    } }) }));
    expect(result.current.executionMode).toBeUndefined();
    state({ executionMode: { mode: 'root', effectiveUid: 0 } });
    expect(result.current.executionModeConfirmed).toBe(true);
    for (const extra of [{}, { connected: false }, { executionMode: { mode: 'native', effectiveUid: 0 } }, { connected: false, executionMode: { mode: 'native', effectiveUid: 990 } }]) {
      state(extra);
      expect(result.current.executionMode).toEqual({ mode: 'root', effectiveUid: 0 });
      expect(result.current.executionModeConfirmed).toBe(false);
    }
    state({ executionMode: { mode: 'native', effectiveUid: 990 } });
    expect(result.current.executionMode).toEqual({ mode: 'native', effectiveUid: 990 });
    expect(result.current.executionModeConfirmed).toBe(true);
    state({ executionMode: { mode: 'root', effectiveUid: 0 } });
    act(() => socket.onclose());
    expect(result.current.executionMode?.mode).toBe('root');
    expect(result.current.executionModeConfirmed).toBe(false);
  });
  it('blocks work only during automatic CLI refresh and restores it on the next runtime epoch', () => {
    let socket!: { onmessage: (event: { data: string }) => void };
    vi.stubGlobal('WebSocket', class { onmessage = (_: { data: string }) => {}; close() {} constructor() { socket = this; } });
    const api = { clientId: 'owner', connectionChanged: vi.fn() } as unknown as Api;
    const { result } = renderHook(() => useEvents(api, vi.fn()));
    const state = (extra: Record<string, unknown>) => act(() => socket.onmessage({ data: JSON.stringify({ type: 'state', data: {
      connected: true, epoch: 'before', activity: { unknown: false, activeThreads: [], pendingStarts: 0, terminals: 0 }, ...extra,
    } }) }));
    state({}); expect(result.current.activityReady).toBe(true); const revision = result.current.revision;
    state({ restarting: true }); expect(result.current.restarting).toBe(true); expect(result.current.activityReady).toBe(false); expect(result.current.configurationReady).toBe(false);
    state({ connected: false }); expect(result.current.restarting).toBe(true);
    state({ epoch: 'after', restarting: false }); expect(result.current.restarting).toBe(false); expect(result.current.activityReady).toBe(true); expect(result.current.configurationReady).toBe(true); expect(result.current.revision).toBe(revision + 1);
  });
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
