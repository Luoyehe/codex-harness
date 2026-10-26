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
  const pageCount = useRef(1),
    boundary = useRef<number | null | undefined>(undefined),
    pending = useRef(false),
    generation = useRef(0);
  const fetchPages = useCallback(
    async (more = false, next: number | null = null) => {
      if (!enabled || !id || pending.current || (more && next === null)) return;
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
        error: '',
      }));
      try {
        const records = new Map<string, Run>();
        let last: number | null = null,
          before: number | undefined,
          pages = 0;
        do {
          const result = await api.call<{ data: Run[]; next: number | null }>('automation/runs', {
            id,
            limit: 50,
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
          for (const run of result.data) {
            if (run.automationId !== id || typeof run.id !== 'string')
              throw new Error('运行记录归属不匹配。');
            records.set(run.id, run);
          }
          last = result.next;
          before = result.next ?? undefined;
          pages++;
        } while (
          last !== null &&
          pages < 20 &&
          (pages < wantedPages ||
            (oldBoundary !== undefined && (oldBoundary === null || last > oldBoundary)))
        );
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
        if (generation.current === gen) pending.current = false;
      }
    },
    [api, id, enabled, key],
  );
  useEffect(() => {
    generation.current++;
    pending.current = false;
    pageCount.current = 1;
    boundary.current = undefined;
    void fetchPages();
    return () => {
      generation.current++;
    };
  }, [fetchPages]);
  const current =
    state.key === key ? state : { key, items: [], next: null, error: '', loading: enabled };
  return { ...current, refresh: fetchPages, more: () => fetchPages(true, current.next) };
}
