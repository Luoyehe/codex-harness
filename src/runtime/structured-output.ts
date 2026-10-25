import { DeliveryError, jsonBytes, object, type JsonValue } from './types.js';
/** Bound schemas before the provider sees them; references stay local. */
export function outputSchema(value: JsonValue): JsonValue {
  object(value, 'output schema'); jsonBytes(value, 64 * 1024); let nodes = 0;
  const visit = (item: JsonValue, depth: number): void => {
    if (++nodes > 2048 || depth > 24) throw new DeliveryError('capacity', 'Output schema is too complex');
    if (Array.isArray(item)) for (const child of item) visit(child, depth + 1);
    else if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) {
      if ((key === '$ref' || key === '$dynamicRef' || key === '$recursiveRef') && (typeof child !== 'string' || !child.startsWith('#'))) throw new DeliveryError('invalid_params', 'Output schema references must remain inside the schema');
      visit(child, depth + 1);
    }
  }; visit(value, 0); return value;
}
