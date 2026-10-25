import { useEffect, useState } from 'react';
import type { Api } from '../lib/api';
import { message, object } from '../lib/types';

/** A loaded thread belongs to a particular runtime/connection generation. */
export function useResume(api: Api, threadId: string, epoch: string, onLoaded: () => void) {
  const key = JSON.stringify([threadId, epoch]);
  const [result, setResult] = useState<{ key: string; defaults?: Record<string, unknown>; requiresResume?: boolean; error?: string }>();
  useEffect(() => {
    if (!threadId) return;
    const controller = new AbortController();
    api.call('thread/session', { threadId }, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      if (value.requiresResume === true) { setResult({ key, requiresResume: true }); return; }
      if (value.requiresResume !== false || object(value.thread).id !== threadId) throw new Error('会话加载状态无效，请重新读取。');
      setResult({ key, defaults: value, requiresResume: false }); onLoaded();
    }).catch(error => { if (!controller.signal.aborted) setResult({ key, error: message(error) }); });
    return () => controller.abort();
  }, [api, threadId, key, onLoaded]);
  const current = result?.key === key ? result : undefined;
  return { resumedThread: current?.defaults ? threadId : '', threadDefaults: current?.defaults, requiresResume: current?.requiresResume === true, loading: Boolean(threadId) && !current, error: current?.error ?? '' };
}
