import { createHash } from 'node:crypto';
import { canonical, DeliveryError, integer, object, onlyKeys, string, type JsonObject, type JsonValue } from './types.js';

export const GENERATED_MEDIA_BYTES = 8 * 1024 * 1024;
export const GENERATED_MEDIA_CHUNK = 192 * 1024;
const CACHE_BYTES = 64 * 1024 * 1024;
interface Media { threadId: string; turnId: string; itemId: string; mediaId: string; mimeType: string; bytes: Buffer; revision: number }
interface Host { native(method: string, params: JsonValue): Promise<JsonValue>; revision(threadId: string): number; closed(): boolean }
function mime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
}
/** Browser-only projection. Native rollouts and files are never written or used as arbitrary read capabilities. */
export class GeneratedMedia {
  private entries = new Map<string, Media>();
  private bytes = 0;
  constructor(private host: Host) {}
  clear(): void { this.entries.clear(); this.bytes = 0; }
  invalidate(threadId: string): void { for (const [key, entry] of this.entries) if (entry.threadId === threadId) { this.entries.delete(key); this.bytes -= entry.bytes.length; } }
  private key(threadId: string, turnId: string, itemId: string): string { return canonical([threadId, turnId, itemId]); }
  private put(entry: Media): void {
    const key = this.key(entry.threadId, entry.turnId, entry.itemId), old = this.entries.get(key);
    if (old) { this.entries.delete(key); this.bytes -= old.bytes.length; }
    while (this.entries.size >= 128 || this.bytes + entry.bytes.length > CACHE_BYTES) {
      const first = this.entries.entries().next().value; if (!first) break;
      this.entries.delete(first[0]); this.bytes -= first[1].bytes.length;
    }
    this.entries.set(key, entry); this.bytes += entry.bytes.length;
  }
  project(value: JsonValue, threadId?: string, turnId?: string, isItem = false): JsonValue {
    if (Array.isArray(value)) return value.map(entry => this.project(entry, threadId, turnId, isItem));
    if (!value || typeof value !== 'object') return value;
    if (typeof value.threadId === 'string') threadId = value.threadId;
    if (typeof value.turnId === 'string') turnId = value.turnId;
    if (Array.isArray(value.items) && typeof value.id === 'string') turnId = value.id;
    if (isItem && value.type === 'imageGeneration' && typeof value.result === 'string' && value.result.length > 0) {
      const { generatedMedia: _old, generatedMediaError: _error, result, ...rest } = value;
      const unavailable = (message: string): JsonObject => {
        if (threadId && turnId && typeof value.id === 'string') { const key = this.key(threadId, turnId, value.id), old = this.entries.get(key); if (old) { this.entries.delete(key); this.bytes -= old.bytes.length; } }
        return { ...rest, result: '', generatedMediaError: message };
      };
      if (!threadId || !turnId || typeof value.id !== 'string') return unavailable('生成图片缺少会话标识，请重新读取会话。');
      const encoded = result.startsWith('data:') ? /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(result)?.[1] : result;
      if (!encoded || encoded.length > 4 * Math.ceil(GENERATED_MEDIA_BYTES / 3)) return unavailable('生成图片超过 8 MiB 预览上限或编码无效。');
      if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return unavailable('生成图片编码无效。');
      const bytes = Buffer.from(encoded, 'base64'), mimeType = mime(bytes);
      if (!bytes.length || bytes.length > GENERATED_MEDIA_BYTES || bytes.toString('base64') !== encoded || !mimeType) return unavailable('生成图片格式不受支持或内容无效。');
      const mediaId = createHash('sha256').update(bytes).digest('hex');
      this.put({ threadId, turnId, itemId: value.id, mediaId, mimeType, bytes, revision: this.host.revision(threadId) });
      return { ...rest, result: '', generatedMedia: { mediaId, mimeType, size: bytes.length } };
    }
    // A ThreadItem is a leaf of the transport projection. MCP/tool output may
    // contain arbitrary objects named item/items and must remain byte-for-byte
    // semantic data rather than being treated as another native item envelope.
    if (isItem) return value;
    const projected: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      const nestedThread = key === 'thread' && entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.id === 'string' ? entry.id : threadId;
      projected[key] = ['thread', 'turn', 'turns', 'items', 'item', 'data', 'timeline'].includes(key)
        ? this.project(entry, nestedThread, turnId, key === 'item' || key === 'items') : entry;
    }
    return projected;
  }
  async read(params: JsonObject): Promise<JsonValue> {
    onlyKeys(params, ['threadId', 'turnId', 'itemId', 'mediaId', 'offset', 'length']);
    const threadId = string(params.threadId, 'threadId', 256), turnId = string(params.turnId, 'turnId', 256), itemId = string(params.itemId, 'itemId', 256), mediaId = string(params.mediaId, 'mediaId', 64);
    if (!/^[a-f0-9]{64}$/.test(mediaId)) throw new DeliveryError('invalid_params', 'Invalid mediaId');
    const offset = integer(params.offset, 'offset', 0, GENERATED_MEDIA_BYTES - 1), length = params.length === undefined ? GENERATED_MEDIA_CHUNK : integer(params.length, 'length', 1, GENERATED_MEDIA_CHUNK);
    const key = this.key(threadId, turnId, itemId), revision = this.host.revision(threadId);
    if (this.host.closed()) throw new DeliveryError('runtime_unavailable', 'Native runtime is unavailable');
    let entry = this.entries.get(key);
    // Every new download proves the item still belongs to this exact native
    // history. Later chunks reuse only this epoch and unchanged history revision.
    if (!entry || offset === 0 || entry.revision !== revision || entry.mediaId !== mediaId) {
      // Revalidation revokes the old capability immediately. A failed native
      // read must not leave old bytes available through a nonzero offset.
      if (entry) { this.entries.delete(key); this.bytes -= entry.bytes.length; entry = undefined; }
      const result = object(await this.host.native('thread/items/read', { threadId, turnId, itemIds: [itemId] }));
      if (this.host.closed() || this.host.revision(threadId) !== revision) throw new DeliveryError('media_changed', '会话已变化，请重新读取图片。');
      if (!Array.isArray(result.data) || result.data.length !== 1) throw new DeliveryError('media_unavailable', '生成图片已不存在于此会话。');
      const row = object(result.data[0]), item = object(row.item);
      if (row.turnId !== turnId || item.id !== itemId || item.type !== 'imageGeneration') throw new DeliveryError('media_unavailable', '生成图片与会话不匹配。');
      const old = this.entries.get(key); if (old) { this.entries.delete(key); this.bytes -= old.bytes.length; }
      this.project(item, threadId, turnId, true); entry = this.entries.get(key);
    }
    if (!entry || entry.mediaId !== mediaId || entry.revision !== revision || offset >= entry.bytes.length) throw new DeliveryError('media_changed', '生成图片已变化或不再可用，请重新读取会话。');
    this.entries.delete(key); this.entries.set(key, entry);
    const end = Math.min(entry.bytes.length, offset + length);
    return { mediaId, mimeType: entry.mimeType, size: entry.bytes.length, offset, base64: entry.bytes.subarray(offset, end).toString('base64'), nextOffset: end === entry.bytes.length ? null : end };
  }
}
