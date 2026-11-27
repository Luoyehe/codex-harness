import type { Model } from './types';

/** A fixed native default is still an explicit transport value, not an adjustable range. */
export function modelDefaultEffort(model?: Model): string | undefined {
  const value = model?.defaultReasoningEffort;
  return typeof value === 'string' && value &&
    (model?.supportedReasoningEfforts?.length === 0 ||
      model?.supportedReasoningEfforts?.some(row => row.reasoningEffort === value)) ? value : undefined;
}
export function modelSupportsEffort(model: Model | undefined, value: string): boolean {
  return Boolean(model?.supportedReasoningEfforts?.some(row => row.reasoningEffort === value) ||
    model?.supportedReasoningEfforts?.length === 0 && modelDefaultEffort(model) === value);
}

/** Unlabelled rows are safe only in a complete, entirely legacy directory. */
export function providerModels(models: Model[], provider: string | undefined, complete: boolean): Model[] {
  if (complete && models.every(row => !row.modelProvider && !row.providerId && !row.providerAliases?.length)) {
    const unique = new Set<string>(), duplicates = new Set<string>();
    for (const row of models) {
      const name = row.model ?? row.id;
      if (unique.has(name)) duplicates.add(name);
      unique.add(name);
    }
    return models.filter(row => !duplicates.has(row.model ?? row.id));
  }
  return provider ? models.filter(row => row.modelProvider === provider || row.providerAliases?.includes(provider)) : [];
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
