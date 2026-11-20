import { DeliveryError, jsonBytes, object, string, type JsonObject, type JsonValue } from './types.js';
export function mediaModalities(input: JsonValue | undefined): string[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map(item => object(item).type).flatMap(type => type === 'harnessQueuedImageReference' ? ['toolImageReference'] : type === 'harnessQueuedNativeImage' ? ['nativeQueuedImage'] : type === 'harnessQueuedLegacyVideo' ? ['legacyQueuedVideo'] : type === 'image' || type === 'localImage' ? ['image'] : type === 'audio' || type === 'localAudio' ? ['audio'] : []))];
}
export function selectedInputModel(settings: JsonObject, fallback: JsonValue | undefined): JsonValue | undefined {
  if (settings.collaborationMode != null) return object(object(settings.collaborationMode).settings).model;
  return typeof settings.model === 'string' ? settings.model : fallback;
}
/** Media requires positive fresh native catalog evidence, including custom models. */
export async function validateInputModalities(native: (method: string, params: JsonValue) => Promise<JsonValue>, model: JsonValue | undefined, input: JsonValue | undefined, toolReference?: (item: JsonObject) => JsonObject | undefined): Promise<void> {
  const required = mediaModalities(input); if (!required.length) return;
  const unknown = (reason: string) => new DeliveryError('model_capability_unknown', '发送前核对模型能力失败，媒体尚未发送。' + reason);
  const reroute = () => new DeliveryError('queue_media_route_change', '队列中的媒体格式与当前模型所需的格式不同。可在待办中按当前模型重存媒体。更换模型前，请先保存待办副本、确认删除原项，切换后再从副本恢复。原附件无需重新上传。');
  if (required.includes('legacyQueuedVideo')) throw reroute();
  if (typeof model !== 'string' || !model) throw unknown('请重新读取设置或选择本次实际使用的模型。');
  let cursor: string | undefined, bytes = 0, match: JsonObject | undefined; const seen = new Set<string>();
  for (let page = 0; page < 32; page++) {
    let result: JsonObject;
    try { result = object(await native('model/list', { includeHidden: true, limit: 100, ...(cursor ? { cursor } : {}) })); }
    catch { throw unknown('当前无法读取供应商的原生模型目录，请稍后重试。'); }
    try { bytes += Buffer.byteLength(jsonBytes(result, 2 * 1024 * 1024)); }
    catch { throw unknown('原生模型目录过大或格式无效，无法完整核验。'); }
    if (bytes > 2 * 1024 * 1024 || !Array.isArray(result.data) || result.data.length > 100) throw unknown('原生模型目录过大或缺少有效的模型列表。');
    for (const item of result.data) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw unknown('原生模型目录中有格式无效的条目。');
      const entry = item; if (entry.id !== model && entry.model !== model) continue;
      if (match || !Array.isArray(entry.inputModalities) || !entry.inputModalities.every(value => ['text', 'image', 'audio'].includes(String(value)))) throw unknown('当前模型的目录条目重复，或未提供可核验的输入能力。');
      match = entry;
    }
    if (result.nextCursor === null) {
      if (!match) throw unknown('原生目录中没有本次实际使用的模型，请重新读取设置或选择其他模型。');
      const modalities = match.inputModalities as JsonValue[];
      const nativeImage = modalities.includes('image');
      const tools = match.supportsTools === true && modalities.includes('text');
      if (required.includes('toolImageReference') && nativeImage || required.includes('nativeQueuedImage') && !nativeImage && tools) throw reroute();
      if (required.includes('toolImageReference') && !tools || required.includes('nativeQueuedImage') && !nativeImage)
        throw new DeliveryError('model_modality_unsupported', '当前模型无法接收此排队图片。可先保存待办副本、确认删除原项，再选择支持图片或工具的模型恢复。');
      const missing = required.filter(modality => !['toolImageReference', 'nativeQueuedImage'].includes(modality) && !modalities.includes(modality));
      if (Array.isArray(input) && missing.length === 1 && missing[0] === 'image' && toolReference &&
          match.supportsTools === true && (match.inputModalities as JsonValue[]).includes('text')) {
        const routed = input.map(row => {
          const value = object(row);
          if (value.type !== 'image' && value.type !== 'localImage') return row;
          const reference = toolReference(value);
          if (!reference) throw new DeliveryError('model_modality_unsupported', '图片尚未发送。当前模型仅能接收本次会话的受管图片引用，请重新选择附件。');
          return reference;
        });
        input.splice(0, input.length, ...routed); return;
      }
      if (missing.length) {
        const labels = missing.map(modality => modality === 'image' ? '图片' : '音频');
        const reason = missing.includes('image') && !tools ? '，也未核实可供图片引用使用的文本及工具能力' : '';
        throw new DeliveryError('model_modality_unsupported', `媒体尚未发送。当前模型的原生目录未声明支持${labels.join('和')}输入${reason}。请更换模型或移除相应附件。`);
      }
      return;
    }
    try { cursor = string(result.nextCursor, 'model catalog cursor', 4096); }
    catch { throw unknown('原生模型目录返回了无效的分页位置。'); }
    if (seen.has(cursor)) throw unknown('原生模型目录重复返回相同分页位置，请重新核验。');
    seen.add(cursor);
  }
  throw unknown('原生模型目录超过本次可核验的分页上限。');
}
