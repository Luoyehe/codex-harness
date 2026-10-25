export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type Delivery = 'not_sent' | 'unknown';
export class DeliveryError extends Error {
  constructor(public code: string, message: string, public delivery: Delivery = 'not_sent', public data?: JsonValue) { super(message); this.name = 'DeliveryError'; }
}
export interface CallContext { clientId: string; eventChannelId?: string; operationId?: string; beforeWrite?: () => void; gatewayRequestDigest?: string; projectId?: string }
export interface RuntimeEvent { type: 'state' | 'notification' | 'prompt' | 'prompt-closed' | 'terminal' | 'mcp' | 'process' | 'realtime' | 'prediction'; data: JsonValue; eventChannelId?: string }
export const LIMITS = Object.freeze({ frameBytes: 12 * 1024 * 1024, retainedBytes: 32 * 1024 * 1024, pending: 64, prompts: 64, promptBytes: 8 * 1024 * 1024, historyBytes: 8 * 1024 * 1024, historyItems: 2000, cursorBytes: 4096, attachmentBytes: 4 * 1024 * 1024, attachmentTotal: 128 * 1024 * 1024, attachments: 128, terminals: 16, eventBytes: 12 * 1024 * 1024 });
export function object(value: unknown, label = 'params'): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new DeliveryError('invalid_params', `${label} must be an object`);
  return value as JsonObject;
}
export function string(value: unknown, label: string, max = 4096, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.length) || Buffer.byteLength(value) > max || !value.isWellFormed()) throw new DeliveryError('invalid_params', `Invalid ${label}`);
  return value;
}
export function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new DeliveryError('invalid_params', `Invalid ${label}`);
  return value;
}
export function jsonBytes(value: unknown, max = LIMITS.frameBytes): string {
  let nodes = 0;
  const visit = (entry: unknown, depth: number): void => {
    if (++nodes > 200000 || depth > 64) throw new DeliveryError('capacity', 'JSON structure exceeds budget');
    if (typeof entry === 'string') { if (!entry.isWellFormed()) throw new DeliveryError('invalid_unicode', 'Unpaired UTF-16 surrogate'); return; }
    if (entry === null || typeof entry === 'boolean') return;
    if (typeof entry === 'number' && Number.isFinite(entry)) return;
    if (Array.isArray(entry)) { for (const item of entry) visit(item, depth + 1); return; }
    if (entry && typeof entry === 'object') { for (const [key, item] of Object.entries(entry)) { visit(key, depth + 1); visit(item, depth + 1); } return; }
    throw new DeliveryError('invalid_json', 'Value is not JSON');
  };
  visit(value, 0);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > max) throw new DeliveryError('capacity', 'JSON exceeds byte budget');
  return serialized;
}
export function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function onlyKeys(value: JsonObject, allowed: string[]): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new DeliveryError('invalid_params', `Unsupported field: ${key}`); }
