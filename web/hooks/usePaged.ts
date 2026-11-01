import { useEffect, useMemo, useRef, useState } from 'react';
import type { Api } from '../lib/api';
import { message, object } from '../lib/types';
export function usePaged<T>(
  api: Api,
  method: string,
  params: Record<string, unknown>,
  resourceKey: string,
  enabled = true,
) {
  const [items, setItems] = useState<T[]>([]),
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
  const owner = useMemo(() => ({}), [api, method, resourceKey, enabled, revision]);
  const [loadedOwner, setLoadedOwner] = useState<object>();
  const running = useRef(false);
  const [snapshotKey, setSnapshotKey] = useState<string>();
  const validate = (value: unknown, current: T[]) => {
    const result = object(value), raw = result.data ?? result.threads ?? result.models ?? result.servers;
    if (!Array.isArray(raw)) throw new Error('目录响应格式无效。');
    let data: unknown[] = raw;
    if (method === 'thread/list' && result.liveData !== undefined) {
      const live = result.liveData;
      if (!Array.isArray(live) || live.length > 128 || live.some(row => typeof object(row).id !== 'string') ||
          JSON.stringify(live).length > 2_000_000)
        throw new Error('正在运行的会话目录响应无效。');
      // New native threads may not have reached the persistent index. The
      // runtime supplies its known creations separately so its cursor is intact.
      // An indexed copy always wins; never show a duplicate on a later page.
      const rows = new Map<string, unknown>();
      for (const row of [...live, ...data]) rows.set(String(object(row).id), row);
      data = [...rows.values()];
    }
    const next = result.nextCursor;
    if (
      next !== null &&
      next !== undefined &&
      (typeof next !== 'string' || next.length > 4096 || seen.current.has(next))
    )
      throw new Error('目录返回了无效或循环游标。');
    if (
      pageCount.current >= 50 ||
      current.length + data.length > 3000 ||
      JSON.stringify(data).length > 2_000_000
    )
      throw new Error('目录达到读取上限，已保留现有结果。');
    const warnings = method === 'model/list' && Array.isArray(result.providerErrors)
      ? result.providerErrors.slice(0, 16).map(value => {
        const failure = object(value);
        return `${String(failure.name ?? '供应商').slice(0, 64)}：${String(failure.message ?? '模型目录读取失败').slice(0, 300)}`;
      }) : method === 'thread/list' && result.liveDataTruncated === true
        ? ['正在建立索引的会话较多。可在“已加载会话”查看其余会话，或稍后刷新列表。'] : [];
    return { data: data as T[], next: typeof next === 'string' ? next : null, warning: warnings.join('；') };
  };
  useEffect(() => {
    const gen = ++epoch.current,
      controller = new AbortController();
    setLoadedOwner(owner);
    running.current = false;
    setItems([]);
    setError('');
    setWarning('');
    setCursor(null);
    setSnapshotKey(undefined);
    seen.current.clear();
    pageCount.current = 0;
    if (!enabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    api
      .call(method, { ...paramsRef.current, limit: 50 }, controller.signal)
      .then((value) => {
        if (epoch.current !== gen) return;
        const page = validate(value, []);
        if (page.next !== null) seen.current.add(page.next);
        pageCount.current++;
        setItems(page.data);
        setWarning(page.warning);
        setCursor(page.next);
        setSnapshotKey(resourceKey);
      })
      .catch((e) => {
        if (epoch.current === gen && !controller.signal.aborted) setError(message(e));
      })
      .finally(() => {
        if (epoch.current === gen) setLoading(false);
      });
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
      const page = validate(value, items);
      if (page.next !== null) seen.current.add(page.next);
      pageCount.current++;
      const merged = new Map<string, T>();
      for (const item of [...items, ...page.data]) {
        const row = object(item);
        const identity = String(row.id ?? row.name ?? JSON.stringify(item));
        merged.set(method === 'model/list' ? JSON.stringify([row.modelProvider ?? '', identity]) : identity, item);
      }
      setItems([...merged.values()]);
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
  return {
    items: current ? items : [],
    loading: enabled && (!current || loading),
    error: current ? error : '',
    warning: current ? warning : '',
    snapshotKey: current ? snapshotKey : undefined,
    hasMore: current && cursor !== null,
    more,
    refresh: () => setRevision((v) => v + 1),
  };
}
