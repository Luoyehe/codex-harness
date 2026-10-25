import { DeliveryError, jsonBytes, object, string, type JsonObject, type JsonValue } from './types.js';
export function mediaModalities(input: JsonValue | undefined): string[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map(item => object(item).type).flatMap(type => type === 'image' || type === 'localImage' ? ['image'] : type === 'audio' || type === 'localAudio' ? ['audio'] : []))];
}
export function selectedInputModel(settings: JsonObject, fallback: JsonValue | undefined): JsonValue | undefined {
  if (settings.collaborationMode != null) return object(object(settings.collaborationMode).settings).model;
  return typeof settings.model === 'string' ? settings.model : fallback;
}
/** Media requires positive fresh native catalog evidence, including custom models. */
export async function validateInputModalities(native: (method: string, params: JsonValue) => Promise<JsonValue>, model: JsonValue | undefined, input: JsonValue | undefined): Promise<void> {
  const required = mediaModalities(input); if (!required.length) return;
  if (typeof model !== 'string' || !model) throw new DeliveryError('model_capability_unknown', 'The effective model is unknown; reload settings or choose a model before attaching media');
  let cursor: string | undefined, bytes = 0, match: JsonObject | undefined; const seen = new Set<string>();
  for (let page = 0; page < 32; page++) {
    const result = object(await native('model/list', { includeHidden: true, limit: 100, ...(cursor ? { cursor } : {}) })); bytes += Buffer.byteLength(jsonBytes(result, 2 * 1024 * 1024));
    if (bytes > 2 * 1024 * 1024 || !Array.isArray(result.data) || result.data.length > 100) throw new DeliveryError('model_capability_unknown', 'Model catalog exceeded the validation budget');
    for (const item of result.data) {
      const entry = object(item); if (entry.id !== model && entry.model !== model) continue;
      if (match || !Array.isArray(entry.inputModalities) || !entry.inputModalities.every(value => ['text', 'image', 'audio'].includes(String(value)))) throw new DeliveryError('model_capability_unknown', 'Model capabilities are ambiguous or unavailable');
      match = entry;
    }
    if (result.nextCursor === null) {
      if (!match) throw new DeliveryError('model_capability_unknown', 'The effective model is absent from the native catalog');
      const missing = required.filter(modality => !(match!.inputModalities as JsonValue[]).includes(modality));
      if (missing.length) throw new DeliveryError('model_modality_unsupported', `The effective model does not support ${missing.join(' and ')} input`);
      return;
    }
    cursor = string(result.nextCursor, 'model catalog cursor', 4096); if (seen.has(cursor)) throw new DeliveryError('model_capability_unknown', 'Model catalog pagination did not advance'); seen.add(cursor);
  }
  throw new DeliveryError('model_capability_unknown', 'Model catalog pagination exceeded the validation budget');
}
