import { DeliveryError, jsonBytes, object, type JsonValue } from './types.js';
import { schemaBudget } from './schema-budget.js';
/** Bound schemas before the provider sees them; references stay local. */
export function outputSchema(value: JsonValue): JsonValue {
  object(value, 'output schema'); jsonBytes(value, 64 * 1024);
  try { schemaBudget(value, { nodes: 2048, depth: 24, code: 'invalid_params', asynchronous: true }); }
  catch (error) { if (error instanceof DeliveryError && error.message === 'Schema exceeds its structural budget') throw new DeliveryError('capacity', 'Output schema is too complex'); throw error; }
  return value;
}
