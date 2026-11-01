import type { Api } from './api';
import { GENERATED_MEDIA_BYTES, generatedMediaReference, mediaImageInfo, type GeneratedMediaReference } from './media';
import { object } from './types';

const chunkBytes = 196608;
/** Download only a selected thread item's media; never derive file authorization from its hash. */
export async function readGeneratedMedia(api: Api, identity: {
  threadId: string; turnId: string; itemId: string;
}, reference: GeneratedMediaReference, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const expected = generatedMediaReference(reference);
  if (!identity.threadId || !identity.turnId || !identity.itemId)
    throw new Error('缺少可核对的会话图片来源，请重新读取会话。');
  signal.throwIfAborted();
  const bytes = new Uint8Array(expected.size);
  let offset = 0;
  while (offset < bytes.length) {
    signal.throwIfAborted();
    const length = Math.min(chunkBytes, bytes.length - offset);
    const row = object(await api.call('thread/media/read', {
      ...identity, mediaId: expected.mediaId, offset, length,
    }, signal));
    signal.throwIfAborted();
    if (row.mediaId !== expected.mediaId || row.mimeType !== expected.mimeType || row.size !== expected.size ||
      row.offset !== offset || typeof row.base64 !== 'string' || row.base64.length !== Math.ceil(length / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(row.base64) ||
      row.nextOffset !== (offset + length === bytes.length ? null : offset + length))
      throw new Error('图片分块的身份、大小或顺序不匹配，未显示不完整内容。');
    const decoded = atob(row.base64);
    if (decoded.length !== length || btoa(decoded) !== row.base64)
      throw new Error('图片分块编码无效，未显示不完整内容。');
    for (let i = 0; i < length; i++) bytes[offset + i] = decoded.charCodeAt(i);
    offset += length;
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  signal.throwIfAborted();
  const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== expected.mediaId) throw new Error('图片内容校验失败，请重新读取会话后重试。');
  if (mediaImageInfo(bytes).mime !== expected.mimeType)
    throw new Error('图片格式与已记录的类型不匹配。');
  return bytes;
}

// Bound pending decoded bytes and retained image pixels across all visible history windows.
let reservedBytes = 0, reservedPixels = 0, reservations = 0;
export function reserveGeneratedMedia(size: number) {
  if (!Number.isSafeInteger(size) || size < 1 || size > GENERATED_MEDIA_BYTES || reservations >= 8 || reservedBytes + size > 32 * 1024 * 1024)
    throw new Error('同时打开的图片已达容量上限，请先收起部分图片。');
  reservedBytes += size; reservations++;
  let pixels = 0, released = false;
  return {
    decoded(bytes: Uint8Array) {
      if (released) throw new Error('此图片读取已结束。');
      const info = mediaImageInfo(bytes), next = info.width * info.height;
      if (reservedPixels - pixels + next > 40_000_000)
        throw new Error('同时预览的图片尺寸已达上限，请先收起部分图片。');
      reservedPixels += next - pixels; pixels = next;
      return info.mime;
    },
    release() {
      if (released) return;
      released = true; reservedBytes -= size; reservedPixels -= pixels; reservations--;
    },
  };
}
