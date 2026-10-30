import { useEffect, useRef, useState } from 'react';
import type { Api } from '../lib/api';
import { object, type HarnessEvent } from '../lib/types';
import { uuid } from '../lib/ids';

export function useEvents(api: Api, onEvent: (event: HarnessEvent) => void, enabled = true) {
  const callback = useRef(onEvent);
  callback.current = onEvent;
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'offline'>(
    'connecting',
  );
  const [epoch, setEpoch] = useState('');
  const [runtimeConnected, setRuntimeConnected] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [activityReady, setActivityReady] = useState(false);
  const [configurationReady, setConfigurationReady] = useState(false);
  const [revision, setRevision] = useState(0);
  const [connectionId, setConnectionId] = useState('');
  useEffect(() => {
    api.connectionChanged?.();
    if (!enabled) {
      setConnection('offline');
      setRuntimeConnected(false);
      setRestarting(false);
      setActivityReady(false);
      setConfigurationReady(false);
      return;
    }
    let disposed = false,
      socket: WebSocket | undefined,
      timer: ReturnType<typeof setTimeout>,
      attempt = 0;
    let upstreamConnected = false,
      observedEpoch = '';
    const connect = () => {
      if (disposed) return;
      setConnection('connecting');
      setRuntimeConnected(false);
      setActivityReady(false);
      setConfigurationReady(false);
      upstreamConnected = false;
      const url = new URL('/api/events', location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('clientId', api.clientId);
      socket = new WebSocket(url);
      socket.onopen = () => {
        if (disposed) return;
        attempt = 0;
        setConnection('connected');
      };
      socket.onmessage = (event) => {
        if (disposed) return;
        if (typeof event.data !== 'string' || event.data.length > 2_000_000) {
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
            setActivityReady(
              connected &&
                runtime.restarting !== true &&
                activity.unknown === false &&
                data.activityUncertain !== true &&
                data.maintenance !== true,
            );
            setConfigurationReady(
              connected &&
                runtime.restarting !== true &&
                activity.unknown === false &&
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
          callback.current({ type: parsed.type, data });
        } catch {
          socket?.close();
        }
      };
      socket.onclose = () => {
        if (disposed) return;
        api.connectionChanged?.();
        upstreamConnected = false;
        setConnection('offline');
        setRuntimeConnected(false);
        setActivityReady(false);
        setConfigurationReady(false);
        void (async () => {
          try {
            const session = await api.session();
            if (!session.authenticated) return;
          } catch {
            /* An unreachable server is not evidence of logout. */
          }
          if (!disposed) timer = setTimeout(connect, Math.min(15000, 500 * 2 ** attempt++));
        })();
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => {
      api.connectionChanged?.();
      disposed = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [api, enabled]);
  return {
    connection,
    runtimeConnected,
    restarting,
    activityReady,
    configurationReady,
    epoch,
    revision,
    connectionId,
  };
}
