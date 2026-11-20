import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Api } from '../lib/api';
import { message, object } from '../lib/types';
import { threadListTime } from '../../src/shared/thread-list-time';

function uniqueRows<T>(method: string, items: T[]): T[] {
  const rows = new Map<string, T>();
  for (const item of items) {
    const row = object(item);
    const threadId = method === 'thread/search' ? object(row.thread).id : row.id;
    const id = String(threadId ?? row.processId ?? row.name ?? JSON.stringify(item));
    rows.set(method === 'model/list' ? JSON.stringify([row.modelProvider ?? '', id]) : id, item);
  }
  return [...rows.values()];
}

type Catalog<T> = { indexed: T[]; live: T[] };

function visibleRows<T>({ indexed, live }: Catalog<T>, sortKey: unknown, direction: unknown): T[] {
  if (!live.length) return indexed;
  const time = (row: T) => threadListTime(object(row), sortKey);
  // Legacy entries without any time retain their original display order.
  if (sortKey !== 'section_position' &&
      !live.some(row => time(row) !== undefined) && !indexed.some(row => time(row) !== undefined))
    return uniqueRows('thread/list', [...live, ...indexed]);
  const indexedIds = new Set(indexed.map(row => object(row).id));
  const pending = live.filter(row => !indexedIds.has(object(row).id));
  if (!pending.length) return indexed;
  if (sortKey === 'section_position') return [...pending, ...indexed];

  const rank = (row: T) => {
    const value = time(row);
    return value === undefined ? Infinity : direction === 'asc' ? value : -value;
  };
  pending.sort((a, b) => rank(a) - rank(b));
  // Native ordering has sub-second precision which the response does not expose.
  // Insert pending rows between native rows without reordering the native pages.
  const rows: T[] = [];
  let i = 0;
  for (const row of indexed) {
    while (i < pending.length && rank(pending[i]!) <= rank(row)) rows.push(pending[i++]!);
    rows.push(row);
  }
  return rows.concat(pending.slice(i));
}

export function usePaged<T>(
  api: Api,
  method: string,
  params: Record<string, unknown>,
  resourceKey: string,
  enabled = true,
) {
  const [catalog, setCatalog] = useState<Catalog<T>>({ indexed: [], live: [] }),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [warning, setWarning] = useState(''),
    [cursor, setCursor] = useState<string | null>(null),
    [revision, setRevision] = useState(0);
  const epoch = useRef(0),
    seen = useRef(new Set<string>()),
    pageCount = useRef(0),
    paramsRef = useRef(params);
  paramsRef.current = params;
  const scope = useMemo(() => ({}), [api, method, resourceKey, enabled]);
  const owner = useMemo(() => ({}), [scope, revision]);
  const loadedScope = useRef<object | undefined>(undefined);
  const [loadedOwner, setLoadedOwner] = useState<object>();
  const running = useRef(false);
  const refresh = useCallback(() => setRevision(v => v + 1), []);
  const [snapshotKey, setSnapshotKey] = useState<string>();
  const validate = (value: unknown, current: Catalog<T>, count: number, cursors: Set<string>) => {
    const result = object(value), raw = result.data ?? result.threads ?? result.models ?? result.servers;
    if (!Array.isArray(raw)) throw new Error('目录响应格式无效。');
    let live = current.live;
    if (method === 'thread/list' && result.liveData !== undefined) {
      const rows = result.liveData;
      if (!Array.isArray(rows) || rows.length > 128 || rows.some(row => typeof object(row).id !== 'string') ||
          JSON.stringify(rows).length > 2_000_000)
        throw new Error('正在运行的会话目录响应无效。');
      live = uniqueRows(method, rows) as T[];
    }
    const next = result.nextCursor;
    if (
      next !== null &&
      next !== undefined &&
      (typeof next !== 'string' || next.length > 4096 || cursors.has(next))
    )
      throw new Error('目录返回了无效或循环游标。');
    if (
      count >= 50 ||
      current.indexed.length + raw.length + live.length > 3000 ||
      JSON.stringify(result.liveData === undefined ? raw : [...live, ...raw]).length > 2_000_000
    )
      throw new Error('目录达到读取上限，已保留现有结果。');
    const warnings = method === 'model/list' && Array.isArray(result.providerErrors)
      ? result.providerErrors.slice(0, 16).map(value => {
        const failure = object(value);
        return `${String(failure.name ?? '供应商').slice(0, 64)}：${String(failure.message ?? '模型目录读取失败').slice(0, 300)}`;
      }) : method === 'thread/list' && result.liveDataTruncated === true
        ? ['正在建立索引的会话较多。可在“已加载会话”查看其余会话，或稍后刷新列表。'] : [];
    const indexed = uniqueRows(method, current.indexed.concat(raw as T[]));
    return { catalog: { indexed, live }, next: typeof next === 'string' ? next : null, warning: warnings.join('；') };
  };
  useEffect(() => {
    const gen = ++epoch.current,
      controller = new AbortController();
    const sameScope = loadedScope.current === scope;
    const wantedPages = sameScope ? Math.max(1, pageCount.current) : 1;
    loadedScope.current = scope;
    setLoadedOwner(owner);
    running.current = false;
    if (!sameScope || !['thread/list', 'thread/search', 'model/list', 'thread/backgroundTerminals/list'].includes(method)) setCatalog({ indexed: [], live: [] });
    setError('');
    setWarning('');
    setCursor(null);
    if (!sameScope) setSnapshotKey(undefined);
    if (!sameScope) { seen.current.clear(); pageCount.current = 0; }
    if (!enabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void (async () => {
      try {
        let collected: Catalog<T> = { indexed: [], live: [] }, next: string | null = null, warnings: string[] = [];
        const cursors = new Set<string>();
        let fetched = 0;
        for (let pageNumber = 0; pageNumber < wantedPages; pageNumber++) {
          const value = await api.call(method, { ...paramsRef.current, limit: 50,
            ...(next === null ? {} : { cursor: next }) }, controller.signal);
          if (epoch.current !== gen) return;
          const page = validate(value, collected, fetched, cursors);
          if (page.next !== null) cursors.add(page.next);
          fetched++;
          collected = page.catalog; next = page.next;
          if (page.warning) warnings.push(page.warning);
          if (next === null) break;
        }
        pageCount.current = fetched;
        seen.current = cursors;
        setCatalog(collected); setWarning([...new Set(warnings)].join('；'));
        setCursor(next); setSnapshotKey(resourceKey);
      } catch (e) {
        if (epoch.current === gen && !controller.signal.aborted) setError(message(e));
      } finally { if (epoch.current === gen) setLoading(false); }
    })();
    return () => {
      epoch.current++;
      controller.abort();
    };
  }, [owner]);
  const more = async () => {
    if (!enabled || loadedOwner !== owner || running.current || loading || cursor === null) return;
    const gen = epoch.current;
    running.current = true;
    setLoading(true);
    setError('');
    try {
      const value = await api.call(method, { ...paramsRef.current, cursor, limit: 50 });
      if (epoch.current !== gen) return;
      const page = validate(value, catalog, pageCount.current, seen.current);
      if (page.next !== null) seen.current.add(page.next);
      pageCount.current++;
      setCatalog(page.catalog);
      // Later native pages have no live-data snapshot and cannot clear its
      // first-page truncation notice. A fresh directory read resets it.
      if (method !== 'thread/list' || object(value).liveDataTruncated !== undefined) setWarning(page.warning);
      setCursor(page.next);
    } catch (e) {
      if (epoch.current === gen) setError(message(e));
    } finally {
      if (epoch.current === gen) { running.current = false; setLoading(false); }
    }
  };
  // A new owner must never render the previous scope's catalog while its effect
  // is still pending (including refresh, authentication and runtime changes).
  const current = enabled && loadedOwner === owner;
  const items = useMemo(() => visibleRows(catalog, params.sortKey, params.sortDirection), [catalog, params.sortKey, params.sortDirection]);
  return {
    items: enabled && loadedScope.current === scope ? items : [],
    loading: enabled && (!current || loading),
    error: current ? error : '',
    warning: current ? warning : '',
    snapshotKey: enabled && loadedScope.current === scope ? snapshotKey : undefined,
    hasMore: current && cursor !== null,
    more,
    refresh,
  };
}
