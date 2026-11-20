import { useEffect, useRef, useState } from 'react';
import type { Api } from '../lib/api';
import { message, object } from '../lib/types';

/** A loaded thread belongs to a particular runtime/connection generation. */
export function useResume(api: Api, threadId: string, epoch: string, onLoaded: () => void, visitEpoch = epoch, settingsEpoch = epoch) {
  const lastLoaded = useRef<string | undefined>(undefined);
  const visitKey = JSON.stringify([threadId, visitEpoch]);
  const key = JSON.stringify([threadId, epoch]);
  const settingsKey = JSON.stringify([threadId, settingsEpoch]);
  const [result, setResult] = useState<{
    key: string;
    settingsKey: string;
    defaults?: Record<string, unknown>;
    requiresResume?: boolean;
    requiresContinuationConfirmation?: boolean;
    error?: string;
  }>();
  useEffect(() => {
    if (!threadId) { lastLoaded.current = undefined; return; }
    const controller = new AbortController();
    api
      .call('thread/session', { threadId, checkContinuation: true }, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        if (value.requiresResume === true) {
          lastLoaded.current = undefined;
          setResult({ key, settingsKey, requiresResume: true, requiresContinuationConfirmation: value.requiresContinuationConfirmation !== false });
          return;
        }
        if (value.requiresResume !== false || object(value.thread).id !== threadId)
          throw new Error('会话加载状态无效，请重新读取。');
        setResult({ key, settingsKey, defaults: value, requiresResume: false });
        if (lastLoaded.current !== visitKey) { lastLoaded.current = visitKey; onLoaded(); }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setResult({ key, settingsKey, error: message(error) });
      });
    return () => controller.abort();
  }, [api, threadId, key, onLoaded, visitKey, settingsKey]);
  const fresh = result?.key === key;
  // A plain input receipt does not revoke loaded settings. Overrides invalidate the settings key.
  // A different owner, directory epoch or settings mutation still discards both.
  const current = fresh || result?.settingsKey === settingsKey && result.defaults ? result : undefined;
  return {
    resumedThread: current?.defaults ? threadId : '',
    threadDefaults: current?.defaults,
    requiresResume: current?.requiresResume === true,
    requiresContinuationConfirmation: current?.requiresContinuationConfirmation === true,
    requireContinuationConfirmation: () => setResult(previous => previous?.key === key && previous.requiresResume
      ? { ...previous, requiresContinuationConfirmation: true } : previous),
    loading: Boolean(threadId) && !fresh,
    error: current?.error ?? '',
  };
}
