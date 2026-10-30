import { createContext, useContext } from 'react';
import type { Api } from '../lib/api';
import type { Model } from '../lib/types';
import { usePaged } from './usePaged';

type Directory = ReturnType<typeof usePaged<Model>>;
/** One authenticated runtime generation owns the directory, not a project or chat. */
export const ModelDirectoryContext = createContext<{ api: Api; csrf: string; directory: Directory } | undefined>(undefined);

export function useModelDirectory(api: Api, resourceKey: string, enabled = true, modelProvider?: string) {
  const context = useContext(ModelDirectoryContext);
  const shared = context?.api === api && context.csrf === api.csrf ? context.directory : undefined;
  // Standalone consumers remain usable without a workspace. Inside the workspace
  // this reader stays disabled: paging and refresh operate on the shared catalog.
  const local = usePaged<Model>(api, 'model/list', modelProvider ? { modelProvider } : {},
    JSON.stringify([api.csrf, resourceKey, modelProvider]), enabled && !shared);
  const directory = shared ?? local;
  const items = shared && modelProvider ? directory.items.filter(row =>
    row.modelProvider === modelProvider || row.providerAliases?.includes(modelProvider) ||
    !row.modelProvider && !row.providerId && !directory.hasMore && !directory.loading &&
      !directory.error && !directory.warning && directory.items.every(item => !item.modelProvider && !item.providerId),
  ) : directory.items;
  return { ...directory, items,
    snapshotKey: directory.snapshotKey === undefined ? undefined : resourceKey };
}
