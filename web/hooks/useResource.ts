import { useCallback, useEffect, useRef, useState } from 'react';
import { message } from '../lib/types';

export function useResource<T>(key: string, loader: (signal: AbortSignal) => Promise<T>, enabled = true) {
  const [result, setResult] = useState<{ key: string; data?: T; loading: boolean; error: string }>();
  const [revision, setRevision] = useState(0);
  const epoch = useRef(0);
  const loaderRef = useRef(loader); loaderRef.current = loader;
  const refresh = useCallback(() => setRevision(v => v + 1), []);
  const requestKey = JSON.stringify([key, revision, enabled]);
  useEffect(() => {
    const generation = ++epoch.current;
    const controller = new AbortController();
    setResult({ key: requestKey, loading: enabled, error: '' });
    if (!enabled) return;
    loaderRef.current(controller.signal).then(data => { if (epoch.current === generation) setResult({ key: requestKey, data, loading: false, error: '' }); }, e => { if (epoch.current === generation && !controller.signal.aborted) setResult({ key: requestKey, loading: false, error: message(e) }); });
    return () => { epoch.current++; controller.abort(); };
  }, [requestKey, enabled]);
  const current = result?.key === requestKey ? result : undefined;
  return { data: current?.data, loading: current?.loading ?? enabled, error: current?.error ?? '', refresh };
}
