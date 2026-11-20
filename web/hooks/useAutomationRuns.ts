import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api } from '../lib/api';
import type { Run } from '../lib/automations';
import { message } from '../lib/types';
type Snapshot = { key: string; items: Run[]; next: number | null; error: string; loading: boolean };
/** Rebuild contiguous pages through the previously loaded boundary, including late state changes. */
export function useAutomationRuns(api: Api, id: string, epoch: string, enabled: boolean) {
  const key = JSON.stringify([id, epoch, enabled]),
    owner = useRef(key);
  owner.current = key;
  const [state, setState] = useState<Snapshot>({
    key,
    items: [],
    next: null,
    error: '',
    loading: false,
  });
  const cache = useRef<{ membership?: string; items: Run[] }>({ items: [] });
  const pageCount = useRef(1),
    boundary = useRef<number | null | undefined>(undefined),
    pending = useRef(false),
    queuedRefresh = useRef(false),
    generation = useRef(0);
  const fetchPages = useCallback(
    async (more = false, next: number | null = null) => {
      if (!enabled || !id || (more && next === null)) return;
      if (pending.current) { if (!more) queuedRefresh.current = true; return; }
      const gen = generation.current,
        expectedOwner = key;
      if (more && pageCount.current >= 20) {
        setState((old) => ({
          ...old,
          error: '已加载 1,000 条运行记录。请重新打开计划查看最近记录。',
        }));
        return;
      }
      const wantedPages = pageCount.current + Number(more),
        oldBoundary = boundary.current;
      pending.current = true;
      setState((old) => ({
        ...(old.key === key ? old : { key, items: [], next: null }),
        loading: true,
        error: old.key === key ? old.error : '',
      }));
      try {
        const records = new Map<string, Run>();
        const prior = cache.current;
        const track = prior.items.filter(row => ['queued', 'dispatching', 'running', 'needs_attention', 'stopping', 'unknown'].includes(row.state)).map(row => row.id);
        let membership: string | undefined;
        let aligned = false;
        let last: number | null = null,
          before: number | undefined = more && prior.membership && next !== null ? next : undefined,
          pages = 0;
        do {
          const result = await api.call<{ data: Run[]; next: number | null; membership?: string; tracked?: Run[] }>('automation/runs', {
            id,
            limit: 50,
            ...(prior.membership && !pages && track.length ? { track } : {}),
            ...(before === undefined ? {} : { before }),
          });
          if (owner.current !== expectedOwner || generation.current !== gen) return;
          if (
            !Array.isArray(result.data) ||
            result.data.length > 50 ||
            (result.next !== null &&
              (!Number.isSafeInteger(result.next) ||
                result.next < 0 ||
                (before !== undefined && result.next >= before)))
          )
            throw new Error('运行记录分页响应无效。');
          if (!pages) {
            membership = result.membership;
            aligned = Boolean(membership && membership === prior.membership && Array.isArray(result.tracked) &&
              result.tracked.length === track.length && new Set(result.tracked.map(row => row.id)).size === track.length && result.tracked.every(row => row.automationId === id && track.includes(row.id)));
            if (more && before !== undefined && !aligned) { before = undefined; continue; }
          } else if (membership !== result.membership) throw new Error('加载时运行记录已变化，请刷新。');
          if (aligned && more) for (const row of prior.items) records.set(row.id, row);
          for (const run of result.data) {
            if (run.automationId !== id || typeof run.id !== 'string')
              throw new Error('运行记录归属不匹配。');
            records.set(run.id, run);
          }
          last = result.next;
          before = result.next ?? undefined;
          pages++;
          if (aligned) {
            for (const row of prior.items) if (!records.has(row.id)) records.set(row.id, row);
            for (const row of result.tracked ?? []) if (records.has(row.id)) records.set(row.id, row);
            pages = wantedPages;
            if (!more) last = oldBoundary ?? null;
            break;
          }
        } while (
          last !== null &&
          pages < 20 &&
          (pages < wantedPages ||
            (oldBoundary !== undefined && (oldBoundary === null || last > oldBoundary)))
        );
        cache.current = { membership, items: [...records.values()] };
        pageCount.current = pages;
        boundary.current = last;
        setState({
          key,
          items: [...records.values()],
          next: last,
          error:
            pages === 20 && last !== null
              ? '已达到本页 1,000 条记录上限，请重新打开计划查看最近记录。'
              : '',
          loading: false,
        });
      } catch (error) {
        if (owner.current === expectedOwner && generation.current === gen)
          setState((old) => ({ ...old, loading: false, error: message(error) }));
      } finally {
        if (generation.current === gen) {
          pending.current = false;
          if (queuedRefresh.current) { queuedRefresh.current = false; void fetchPages(); }
        }
      }
    },
    [api, id, enabled, key],
  );
  useEffect(() => {
    generation.current++;
    pending.current = false;
    queuedRefresh.current = false;
    cache.current = { items: [] };
    pageCount.current = 1;
    boundary.current = undefined;
    void fetchPages();
    return () => {
      generation.current++;
    };
  }, [fetchPages]);
  const current =
    state.key === key ? state : { key, items: [], next: null, error: '', loading: enabled };
  return { ...current, initialLoading: current.loading && current.items.length === 0,
    refresh: fetchPages, more: () => fetchPages(true, current.next) };
}
