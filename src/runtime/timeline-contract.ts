import { integer, jsonBytes, object, onlyKeys, string, type JsonObject, type JsonValue } from './types.js';
import { validateOfficial } from './validation.js';
function nullableInteger(value: JsonValue | undefined, name: string): void { if (value !== null) integer(value, name, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER); }
function item(value: JsonValue): JsonObject {
  const entry = object(value); string(entry.id, 'realtime item id', 256); string(entry.realtimeSessionId, 'realtimeSessionId', 256);
  const fields: Record<string, string[]> = { realtimeSessionStarted: [], transcriptSegment: ['role', 'text'], realtimeSessionClosed: ['outcome'], bemItemPromoted: ['turnId', 'itemId', 'presentation'] };
  if (!Object.hasOwn(fields, String(entry.type))) { validateOfficial('ThreadRealtimeItem', entry); return entry; }
  onlyKeys(entry, ['type', 'id', 'realtimeSessionId', ...fields[String(entry.type)]!]);
  if (entry.type !== 'bemItemPromoted') return entry;
  onlyKeys(entry, ['type', 'id', 'realtimeSessionId', 'turnId', 'itemId', 'presentation']);
  return { ...entry, turn_id: string(entry.turnId, 'turnId', 256), item_id: string(entry.itemId, 'itemId', 256) };
}
/** Pinned 0.164.0 JSON schema has snake_case for three enum variants, while
 * its generated TS and observed native wire use camelCase. Adapt only the
 * validator input; never rewrite upstream generated files or public results. */
export function validateTimelineContract(schema: string, value: JsonValue): void {
  const response = object(value); jsonBytes(response);
  if (schema === 'ThreadRealtimeItemStartedNotification' || schema === 'ThreadRealtimeItemCompletedNotification') { onlyKeys(response, ['threadId', 'item']); validateOfficial(schema, { ...response, item: item(response.item!) }); return; }
  if (schema !== 'ThreadTimelineListResponse') { validateOfficial(schema, value); return; }
  onlyKeys(response, ['data', 'nextCursor', 'activeRealtimeSessionAtPageStart']);
  if (response.nextCursor !== null) string(response.nextCursor, 'nextCursor', 4096, true);
  if (response.activeRealtimeSessionAtPageStart !== null) string(response.activeRealtimeSessionAtPageStart, 'activeRealtimeSessionAtPageStart', 256);
  const data = response.data;
  if (!Array.isArray(data)) { validateOfficial(schema, value); return; }
  const projected = data.map(value => {
    const entry = object(value);
    if (entry.type === 'realtime') { onlyKeys(entry, ['type', 'position', 'item']); return { ...entry, item: item(entry.item!) }; }
    if (entry.type === 'item') { onlyKeys(entry, ['type', 'position', 'turnId', 'item']); return entry; }
    if (entry.type !== 'turnStarted' && entry.type !== 'turnCompleted') return entry;
    const completed = entry.type === 'turnCompleted'; onlyKeys(entry, ['type', 'position', 'turnId', 'startedAt', ...(completed ? ['status', 'error', 'completedAt', 'durationMs'] : [])]);
    nullableInteger(entry.startedAt, 'startedAt'); const result = { ...entry, turn_id: string(entry.turnId, 'turnId', 256), started_at: entry.startedAt! };
    if (!completed) return result;
    nullableInteger(entry.completedAt, 'completedAt'); nullableInteger(entry.durationMs, 'durationMs');
    return { ...result, completed_at: entry.completedAt!, duration_ms: entry.durationMs! };
  });
  validateOfficial(schema, { ...response, data: projected });
}
