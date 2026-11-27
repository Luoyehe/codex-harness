import { useEffect, useRef, useState } from 'react';
import type { Api } from '../lib/api';
import { object, type HarnessEvent } from '../lib/types';
import { uuid } from '../lib/ids';
import { executionIdentity, type ExecutionIdentity } from '../lib/execution-mode';
import { activityScope } from '../../src/shared/activity-scope';
import { MAX_EVENT_BYTES } from '../../src/shared/event-limits';

export function useEvents(api: Api, onEvent: (event: HarnessEvent) => void, enabled = true, threadId?: string) {
  const callback = useRef(onEvent);
  callback.current = onEvent;
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'offline'>(
    'connecting',
  );
  const [epoch, setEpoch] = useState('');
  const [runtimeConnected, setRuntimeConnected] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [unknownThreads, setUnknownThreads] = useState<string[]>([]);
  const [activityReady, setActivityReady] = useState(false);
  const [configurationReady, setConfigurationReady] = useState(false);
  const [revision, setRevision] = useState(0);
  const [connectionId, setConnectionId] = useState('');
  const [executionMode, setExecutionMode] = useState<ExecutionIdentity>();
  const [executionModeConfirmed, setExecutionModeConfirmed] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api.connectionChanged?.();
    if (!enabled) {
      setConnection('offline');
      setRuntimeConnected(false);
      setRestarting(false);
      setActivityReady(false);
      setConfigurationReady(false);
      setExecutionModeConfirmed(false);
      return;
    }
    let disposed = false,
      reconnecting = false,
      socket: WebSocket | undefined,
      timer: ReturnType<typeof setTimeout>,
      stableTimer: ReturnType<typeof setTimeout>,
      attempt = 0;
    let upstreamConnected = false,
      observedEpoch = '';
    const connect = () => {
      if (disposed) return;
      reconnecting = false;
      setConnection('connecting');
      setRuntimeConnected(false);
      setActivityReady(false);
      setConfigurationReady(false);
      setExecutionModeConfirmed(false);
      upstreamConnected = false;
      const url = new URL('/api/events', location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('clientId', api.clientId);
      socket = new WebSocket(url);
      const owner = socket;
      socket.onopen = () => {
        if (disposed || owner !== socket) return;
        stableTimer = setTimeout(() => { attempt = 0; }, 10_000);
        setConnection('connected');
      };
      socket.onmessage = (event) => {
        if (disposed || owner !== socket) return;
        if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).byteLength > MAX_EVENT_BYTES) {
          setError('实时事件超过传输上限，正在重新连接并读取状态；不会重复发送操作。');
          socket?.close();
          return;
        }
        try {
          const parsed = object(JSON.parse(event.data));
          if (typeof parsed.type !== 'string') return;
          const data = object(parsed.data);
          if (parsed.type === 'state') {
            api.observeOperationGeneration?.(data.operationGeneration);
            const runtime = data.runtime === undefined ? data : object(data.runtime),
              activity = object(runtime.activity);
            const nextEpoch = runtime.epoch ?? data.epoch;
            const connected = data.connected === true && runtime.connected !== false;
            const identity = executionIdentity(runtime.executionMode);
            const identityConfirmed = Boolean(connected && runtime.restarting !== true && identity);
            setExecutionModeConfirmed(identityConfirmed);
            // Keep the last ROOT warning until a connected runtime explicitly confirms
            // native execution. Missing/invalid/offline state is not a privilege drop.
            if (identity && (identityConfirmed || identity.mode === 'root')) setExecutionMode(identity);
            if (
              connected &&
              (!upstreamConnected || (typeof nextEpoch === 'string' && nextEpoch !== observedEpoch))
            ) {
              api.connectionChanged?.();
              setRevision((v) => v + 1);
              setConnectionId(uuid());
            }
            if (upstreamConnected && !connected) api.connectionChanged?.();
            upstreamConnected = connected;
            if (typeof nextEpoch === 'string') {
              observedEpoch = nextEpoch;
              setEpoch(nextEpoch);
            }
            setRuntimeConnected(connected);
            setRestarting(previous => typeof runtime.restarting === 'boolean' ? runtime.restarting : connected ? false : previous);
            const scope = activityScope(activity);
            setUnknownThreads(scope.unknownThreads);
            setActivityReady(
              connected &&
                runtime.restarting !== true &&
                !scope.globalUnknown &&
                data.activityUncertain !== true &&
                data.maintenance !== true,
            );
            setConfigurationReady(
              connected &&
                runtime.restarting !== true &&
                !scope.globalUnknown && scope.unknownThreads.length === 0 &&
                data.activityUncertain !== true &&
                data.maintenance !== true &&
                Array.isArray(activity.activeThreads) &&
                activity.activeThreads.length === 0 &&
                activity.pendingStarts === 0 &&
                activity.terminals === 0 &&
                (activity.subscriptions === undefined || activity.subscriptions === 0) &&
                (activity.processes === undefined || activity.processes === 0),
            );
          }
          if (parsed.type === 'resync' && typeof data.reason === 'string')
            setError('部分实时事件未能显示，已请求重新核对会话与待审批事项。');
          try { callback.current({ type: parsed.type, data }); }
          catch { setError('部分页面状态未能更新，请重新读取当前会话；连接仍保持。'); }
        } catch {
          socket?.close();
        }
      };
      socket.onclose = () => {
        if (disposed || owner !== socket) return;
        clearTimeout(stableTimer);
        api.connectionChanged?.();
        upstreamConnected = false;
        setConnection('offline');
        setRuntimeConnected(false);
        setActivityReady(false);
        setConfigurationReady(false);
        setExecutionModeConfirmed(false);
        reconnecting = true;
        void (async () => {
          try {
            const session = await api.session();
            if (!session.authenticated) return;
          } catch {
            /* An unreachable server is not evidence of logout. */
          }
          if (!disposed && owner === socket && reconnecting) timer = setTimeout(connect, Math.min(15000, 500 * 2 ** attempt++));
        })();
      };
      socket.onerror = () => owner.close();
    };
    const wake = () => {
      if (disposed || document.visibilityState === 'hidden' || !reconnecting) return;
      clearTimeout(timer);
      connect();
    };
    const viewError = () => setError('部分页面状态未能更新，请重新读取当前会话；连接仍保持。');
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('harness-view-error', viewError);
    connect();
    return () => {
      api.connectionChanged?.();
      disposed = true;
      clearTimeout(timer);
      clearTimeout(stableTimer);
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('harness-view-error', viewError);
      socket?.close();
    };
  }, [api, enabled]);
  return {
    connection,
    runtimeConnected,
    restarting,
    activityReady: activityReady && !unknownThreads.includes(threadId ?? ''),
    configurationReady,
    epoch,
    revision,
    connectionId,
    executionMode,
    executionModeConfirmed,
    error,
    clearError: () => setError(''),
  };
}
