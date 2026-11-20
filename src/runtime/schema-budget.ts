import { DeliveryError, type JsonValue } from './types.js';

/** Shared structural fence only; callers retain their distinct schema dialects. */
export function schemaBudget(value: JsonValue, limits: { nodes: number; depth: number; code: string; asynchronous?: boolean }): Set<string> {
  let nodes = 0; const annotations = new Set<string>();
  type Role = 'schema' | 'map' | 'list' | 'data';
  const maps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies']);
  const lists = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
  const schemas = new Set(['items', 'additionalItems', 'additionalProperties', 'unevaluatedItems', 'unevaluatedProperties', 'contains', 'not', 'if', 'then', 'else', 'propertyNames', 'contentSchema']);
  const visit = (item: JsonValue, depth: number, role: Role): void => {
    if (++nodes > limits.nodes || depth > limits.depth) throw new DeliveryError(limits.code, 'Schema exceeds its structural budget');
    if (Array.isArray(item)) { for (const child of item) visit(child, depth + 1, role === 'list' ? 'schema' : 'data'); return; }
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      let next: Role = 'data';
      if (role === 'map') next = 'schema';
      else if (role === 'schema') {
        if ((key === '$async' && !limits.asynchronous) || (['$ref', '$dynamicRef', '$recursiveRef'].includes(key) && (typeof child !== 'string' || !child.startsWith('#')))) throw new DeliveryError(limits.code, 'Schema requires unsupported external or asynchronous validation');
        if (key === 'example' || /^x-[A-Za-z0-9_-]{1,128}$/.test(key)) annotations.add(key);
        if (maps.has(key)) next = 'map';
        else if (lists.has(key) || key === 'items' && Array.isArray(child)) next = 'list';
        else if (schemas.has(key)) next = 'schema';
      }
      visit(child, depth + 1, next);
    }
  };
  visit(value, 0, 'schema'); return annotations;
}
