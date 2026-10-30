import { useEffect, useRef, useState } from 'react';
import type { Api } from '../lib/api';
import { array, message } from '../lib/types';

/** One explicit refresh synchronizes only the provider chosen in the composer. */
export function useModelCatalogRefresh(api: Api, modelProvider?: string, enabled = true) {
  const [refreshing, setRefreshing] = useState(false), [error, setError] = useState('');
  const owner = useRef({ api, csrf: api.csrf, modelProvider, enabled, mounted: true, generation: 0 });
  const running = useRef(false);
  if (owner.current.api !== api || owner.current.csrf !== api.csrf || owner.current.modelProvider !== modelProvider || owner.current.enabled !== enabled)
    owner.current = { api, csrf: api.csrf, modelProvider, enabled, mounted: owner.current.mounted, generation: owner.current.generation + 1 };
  useEffect(() => { owner.current.mounted = true; return () => { owner.current.mounted = false; }; }, []);
  const refresh = async () => {
    if (running.current) return;
    if (!enabled) { setError('请先结束正在运行的任务，再同步供应商模型目录。'); return; }
    const scope = { api, csrf: api.csrf, modelProvider, generation: owner.current.generation };
    const current = () => owner.current.mounted && owner.current.enabled && owner.current.api === scope.api &&
      owner.current.csrf === scope.csrf && owner.current.modelProvider === scope.modelProvider && owner.current.generation === scope.generation;
    running.current = true; setRefreshing(true); setError('');
    try {
      const registry = await api.call('system/provider/read', {});
      if (!current()) return;
      const connections = array<Record<string, unknown>>(registry.connections);
      const provider = modelProvider ? connections.find(row => row.modelProvider === modelProvider || Array.isArray(row.providerAliases) && row.providerAliases.includes(modelProvider)) :
        connections.find(row => row.id === registry.defaultProviderId);
      if (connections.length && (!provider || provider.enabled !== true))
        throw new Error('所选模型供应商已停用或移除，请重新选择。');
      // Native catalogs are read dynamically by model/list; no root mutation
      // or restart is needed merely to refresh a ChatGPT/Bedrock directory.
      const kind = String(provider?.kind ?? registry.kind);
      if (!['responses', 'zhipu-coding'].includes(kind)) return;
      await api.mutate('system/models/refresh', {
        expectedRevision: registry.revision,
        automatic: true,
        providerId: provider?.id ?? 'default',
      });
    } catch (failure) { if (current()) { setError(message(failure)); throw failure; } }
    finally { running.current = false; if (owner.current.mounted) setRefreshing(false); }
  };
  return { refresh, refreshing, error };
}
