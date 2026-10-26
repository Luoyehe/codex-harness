import type { ErrorBody, JsonObject, JsonValue } from './contracts.js';

/** Public reads/exports of pre-handoff receipts must not re-expose old URLs.
 * Keep their state and database evidence intact; this is not secure erasure. */
export function mcpOauthReceipt(method: string, value: JsonValue): JsonValue {
  if (method !== 'mcp/oauth') return value;
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const output: JsonObject = {};
  for (const key of ['handoffId', 'epoch', 'name', 'threadId']) {
    const item = input[key];
    if (typeof item === 'string' && item.length <= 256 && !/[\x00-\x1f\x7f]/u.test(item)) output[key] = item;
    else if (key === 'threadId' && item === null) output[key] = null;
  }
  if (!output.handoffId || !output.epoch || !output.name || !Object.hasOwn(output, 'threadId')) return { handoffUnavailable: true };
  return output;
}

/** Older native errors could echo a URL in either message or arbitrary data. */
export function mcpOauthError(method: string, error: ErrorBody): ErrorBody {
  if (method !== 'mcp/oauth') return error;
  return { code: 'mcp_oauth_error', message: 'MCP 授权操作未确认成功，请按原回执状态核对服务；结果未知时不要重复提交。',
    ...(error.delivery === 'unknown' || error.delivery === 'not_sent' ? { delivery: error.delivery } : {}) };
}
