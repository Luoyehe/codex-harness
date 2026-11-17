import { DeliveryError, type JsonValue } from './types.js';

/** Shared structural fence only; callers retain their distinct schema dialects. */
export function schemaBudget(value: JsonValue, limits: { nodes: number; depth: number; code: string; asynchronous?: boolean }): Set<string> {
  let nodes = 0; const annotations = new Set<string>();
  const visit = (item: JsonValue, depth: number): void => {
    if (++nodes > limits.nodes || depth > limits.depth) throw new DeliveryError(limits.code, 'Schema exceeds its structural budget');
    if (Array.isArray(item)) { for (const child of item) visit(child, depth + 1); return; }
    if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) {
      if ((key === '$async' && !limits.asynchronous) || (['$ref', '$dynamicRef', '$recursiveRef'].includes(key) && (typeof child !== 'string' || !child.startsWith('#')))) throw new DeliveryError(limits.code, 'Schema requires unsupported external or asynchronous validation');
      if (key === 'example' || /^x-[A-Za-z0-9_-]{1,128}$/.test(key)) annotations.add(key);
      visit(child, depth + 1);
    }
  };
  visit(value, 0); return annotations;
}
