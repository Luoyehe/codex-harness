import { useEffect, useRef, useState } from 'react';
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
  const [snapshotKey, setSnapshotKey] = useState<string>();
  const validate = (value: unknown, current: T[]) => {
    const result = object(value),
      data = result.data ?? result.threads ?? result.models ?? result.servers;
    if (!Array.isArray(data)) throw new Error('目录响应格式无效。');
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
      }) : [];
    return { data: data as T[], next: typeof next === 'string' ? next : null, warning: warnings.join('；') };
  };
  useEffect(() => {
    const gen = ++epoch.current,
      controller = new AbortController();
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
  }, [api, method, resourceKey, enabled, revision]);
  const more = async () => {
    if (loading || cursor === null) return;
    const gen = epoch.current;
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
      setWarning(page.warning);
      setCursor(page.next);
    } catch (e) {
      if (epoch.current === gen) setError(message(e));
    } finally {
      if (epoch.current === gen) setLoading(false);
    }
  };
  return {
    items,
    loading,
    error,
    warning,
    snapshotKey,
    hasMore: cursor !== null,
    more,
    refresh: () => setRevision((v) => v + 1),
  };
}
