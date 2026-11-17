import { useCallback, useEffect, useRef, useState } from 'react';
import { message } from '../lib/types';

export function useResource<T>(
  key: string,
  loader: (signal: AbortSignal) => Promise<T>,
  enabled = true,
  retainWhileRefreshing = false,
) {
  const [result, setResult] = useState<{
    key: string;
    scope: string;
    data?: T;
    loading: boolean;
    error: string;
  }>();
  const [revision, setRevision] = useState(0);
  const epoch = useRef(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const refresh = useCallback(() => setRevision((v) => v + 1), []);
  const requestKey = JSON.stringify([key, revision, enabled]);
  useEffect(() => {
    const generation = ++epoch.current;
    const controller = new AbortController();
    setResult(previous => ({ key: requestKey, scope: key, loading: enabled, error: '',
      ...(retainWhileRefreshing && enabled && previous?.scope === key ? { data: previous.data } : {}) }));
    if (!enabled) return;
    loaderRef.current(controller.signal).then(
      (data) => {
        if (epoch.current === generation)
          setResult({ key: requestKey, scope: key, data, loading: false, error: '' });
      },
      (e) => {
        if (epoch.current === generation && !controller.signal.aborted)
          setResult(previous => ({ key: requestKey, scope: key, loading: false, error: message(e),
            ...(retainWhileRefreshing && previous?.scope === key ? { data: previous.data } : {}) }));
      },
    );
    return () => {
      epoch.current++;
      controller.abort();
    };
  }, [requestKey, enabled, retainWhileRefreshing]);
  const current = result?.key === requestKey ? result : undefined;
  return {
    data: current?.data ?? (retainWhileRefreshing && enabled && result?.scope === key ? result.data : undefined),
    loading: current?.loading ?? enabled,
    error: current?.error ?? '',
    refresh,
  };
}
