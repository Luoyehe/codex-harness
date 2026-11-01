import { useCallback, useEffect, useRef } from 'react';
import type { Events } from '../lib/events';

const projectMutations = new Set(['project/add', 'project/create', 'project/rename', 'project/remove']);
const threadMutations = new Set([
  'conversation/start', 'thread/start', 'thread/fork', 'thread/convert', 'review/startNew', 'turn/start',
  'thread/name/set', 'thread/archive', 'thread/unarchive', 'thread/delete', 'thread/revert',
  'thread/project/set', 'thread/section/move', 'threadSection/create', 'threadSection/update', 'threadSection/delete',
]);
const threadNotifications = new Set([
  'thread/started', 'thread/name/updated', 'thread/archived', 'thread/unarchived',
  'thread/deleted', 'thread/reverted', 'thread/project/updated', 'turn/started', 'turn/completed',
]);

/** Refresh from durable receipts as well as native events, including other tabs.
 * Coalesce a burst; streaming deltas must not repeatedly erase the sidebar. */
export function useSidebarRefresh(events: Events, scope: string, refreshers: {
  projects: () => void; threads: () => void; search: () => void;
}) {
  const latest = useRef(refreshers); latest.current = refreshers;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refresh = useCallback((projects = false) => {
    // Invalidate project ownership synchronously: a newly selected project must
    // not be redirected to the first old project before the refreshed list arrives.
    if (projects) latest.current.projects();
    if (timer.current !== undefined) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      latest.current.threads(); latest.current.search();
    }, 100);
  }, []);
  useEffect(() => {
    const unsubscribe = events.subscribe(event => {
      const method = String(event.data.method);
      if (event.type === 'notification') {
        if (method === 'project/changed') refresh(true);
        else if (threadNotifications.has(method)) refresh();
      } else if (event.type === 'receipt' && ['accepted', 'unknown'].includes(String(event.data.state))) {
        if (projectMutations.has(method)) refresh(true);
        else if (threadMutations.has(method)) refresh();
      }
    });
    return () => {
      unsubscribe(); clearTimeout(timer.current); timer.current = undefined;
    };
  }, [events, scope, refresh]);
  return refresh;
}
