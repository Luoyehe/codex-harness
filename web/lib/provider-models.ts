import type { Model } from './types';

/** Unlabelled rows are safe only in a complete, entirely legacy directory. */
export function providerModels(models: Model[], provider: string, complete: boolean): Model[] {
  const legacy = complete && models.every(row => !row.modelProvider && !row.providerId);
  return models.filter(row => row.modelProvider === provider || row.providerAliases?.includes(provider) ||
    legacy && !row.modelProvider && !row.providerId);
}

/** A partial catalog cannot disprove an alias that may appear on a later page. */
export function providerRelation(models: Model[], source: string, target: string, complete: boolean): 'same' | 'different' | 'unknown' {
  if (source === target) return 'same';
  const canonical = (provider: string) => new Set(models.filter(row => row.modelProvider === provider || row.providerAliases?.includes(provider))
    .map(row => row.modelProvider).filter((value): value is string => Boolean(value)));
  const from = canonical(source), to = canonical(target);
  if (from.size === 1 && to.size === 1 && [...from][0] === [...to][0]) return 'same';
  return complete ? 'different' : 'unknown';
}
