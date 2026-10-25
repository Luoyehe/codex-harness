import { createHash } from 'node:crypto';
import type { JsonObject, JsonValue, RpcCall } from './contracts.js';
import { LIMITS } from './contracts.js';
import { HarnessError } from './errors.js';

export function object(value: unknown, label = '参数'): asserts value is JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HarnessError('invalid', `${label}必须是对象。`);
}
export function validText(value: unknown, max = 4096, label = '文本'): string {
  if (typeof value !== 'string' || value.length > max || !value.isWellFormed() || value.includes('\0'))
    throw new HarnessError('invalid', `${label}格式或长度不正确。`);
  return value;
}
export function identifier(value: unknown, label = '标识'): string {
  const text = validText(value, 256, label);
  if (!text || /[\x00-\x1f\x7f]/u.test(text)) throw new HarnessError('invalid', `${label}不能为空或包含控制字符。`);
  return text;
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new HarnessError('invalid', '操作编号必须是 UUID。');
  return value.toLowerCase();
}
export function canonical(value: unknown, maxBytes = LIMITS.requestBytes): string {
  let nodes = 0;
  function walk(item: unknown, depth: number): string {
    if (++nodes > 100000 || depth > 48) throw new HarnessError('capacity', '参数结构过于复杂。');
    if (item === null) return 'null';
    if (typeof item === 'string') return JSON.stringify(validText(item, maxBytes));
    if (typeof item === 'boolean') return String(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) return '[' + item.map(child => walk(child, depth + 1)).join(',') + ']';
    object(item);
    return '{' + Object.keys(item).sort().map(key => JSON.stringify(validText(key, 1024)) + ':' + walk(item[key], depth + 1)).join(',') + '}';
  }
  const result = walk(value, 0);
  if (Buffer.byteLength(result) > maxBytes) throw new HarnessError('capacity', '请求内容过大。');
  return result;
}
export function digest(value: JsonValue): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function rpcCall(input: unknown): RpcCall {
  object(input);
  if (Object.keys(input).some(key => !['method', 'params', 'operationId'].includes(key))) throw new HarnessError('invalid', '请求包含未知字段。');
  const method = identifier(input.method, '方法');
  object(input.params);
  canonical(input.params);
  return { method, params: input.params, ...(input.operationId === undefined ? {} : { operationId: uuid(input.operationId) }) };
}
export function safeJson(text: string, maxBytes = LIMITS.requestBytes): JsonValue {
  if (Buffer.byteLength(text) > maxBytes) throw new HarnessError('capacity', '数据超过容量限制。');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new HarnessError('invalid', 'JSON 格式不正确。'); }
  canonical(parsed, maxBytes);
  return parsed as JsonValue;
}
