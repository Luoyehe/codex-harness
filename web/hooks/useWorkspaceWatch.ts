import { useEffect, useRef, useState } from 'react';
import { RpcError, type Api } from '../lib/api';
import { message } from '../lib/types';
import { workspacePath } from '../lib/workspace';

/** A bounded alternative to unrestricted native fs/watch. No background owner
 * survives the mounted, connected browser view, and no draft is ever replaced. */
export function useWorkspaceWatch(
  api: Api,
  scope: {
    projectId: string;
    epoch: string;
    directory: string;
    file?: string;
    enabled: boolean;
    connected: boolean;
  },
  onChanged: (paths: string[]) => void,
) {
  const [state, setState] = useState<{ key: string; error: string; checkedAt?: number }>(),
    callback = useRef(onChanged);
  callback.current = onChanged;
  const paths = [...new Set([scope.directory, ...(scope.file ? [scope.file] : [])])],
    key = JSON.stringify([scope.projectId, scope.epoch, paths, scope.enabled, scope.connected]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observed = new Map<string, string>();
    if (!scope.enabled || !scope.connected) return;
    const read = async () => {
      let pending: Promise<readonly [string, string]>[] = [];
      try {
        pending = paths.map(async (path) => {
          workspacePath(path, true);
          try {
            const value = await api.call(
              'workspace/metadata',
              { projectId: scope.projectId, path },
              controller.signal,
            );
            if (
              value.path !== path ||
              typeof value.kind !== 'string' ||
              typeof value.revision !== 'string'
            )
              throw new Error('文件监测响应缺少可核对的版本。');
            return [path, `${value.kind}:${value.revision}`] as const;
          } catch (e) {
            if (e instanceof RpcError && e.code === 'not_found')
              return [path, 'missing'] as const;
            throw e;
          }
        });
        const latest = await Promise.all(pending);
        if (controller.signal.aborted) return;
        const changed = latest
          .filter(([path, revision]) => observed.has(path) && observed.get(path) !== revision)
          .map(([path]) => path);
        latest.forEach(([path, revision]) => observed.set(path, revision));
        setState({ key, error: '', checkedAt: Date.now() });
        if (changed.length) callback.current(changed);
      } catch (e) {
        if (!controller.signal.aborted)
          setState((previous) => ({
            ...(previous?.key === key ? previous : {}),
            key,
            error: message(e),
          }));
      } finally {
        // Report failures promptly, but keep this poll's remaining reads owned
        // until they settle so the next poll cannot overlap them.
        await Promise.allSettled(pending);
        if (!controller.signal.aborted) timer = setTimeout(() => void read(), 5000);
      }
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, key]);
  return {
    active: scope.enabled && scope.connected,
    error: state?.key === key ? state.error : '',
    checkedAt: state?.key === key ? state.checkedAt : undefined,
  };
}
