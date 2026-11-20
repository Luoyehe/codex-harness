import { randomUUID } from 'node:crypto';
import { LIMITS, jsonBytes, type JsonObject, type JsonValue } from './types.js';

const imagePrefix = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const methods = new Set(['item/started', 'item/completed', 'turn/started', 'turn/completed']);

function record(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function inlineUserImages(items: JsonValue[]): JsonObject[] {
  const images: JsonObject[] = [];
  for (const value of items) {
    const item = record(value);
    if (item?.type !== 'userMessage' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      const image = record(part);
      if (image?.type === 'image' && typeof image.url === 'string') images.push(image);
    }
  }
  return images;
}

function omitImages(images: Iterable<JsonObject>, text: string): void {
  for (const image of images) {
    image.type = 'text'; image.text = text; image.text_elements = [];
    delete image.url; delete image.detail;
  }
}
const historyNote = '［大图已保留在原会话，历史预览省略图片内容］';

export type NativeHistoryShape = 'items' | 'timeline' | 'thread';
/** Tool data and voice records can have similar property names. Inspect only official item locations. */
function historyItems(value: JsonValue, shape: NativeHistoryShape): JsonValue[] {
  if (shape === 'thread') {
    const turns = record(record(value)?.thread)?.turns;
    return Array.isArray(turns) ? turns.flatMap(value => {
      const turn = record(value);
      return turn && typeof turn.id === 'string' && Array.isArray(turn.items) ? turn.items : [];
    }) : [];
  }
  const rows = record(value)?.data;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap(value => {
    const row = record(value);
    return row && (shape !== 'timeline' || row.type === 'item') && typeof row.turnId === 'string' && record(row.item) ? [row.item!] : [];
  });
}

export function fitHistoryImages(page: JsonValue, shape: NativeHistoryShape, displayChars: number): JsonValue {
  const images = inlineUserImages(historyItems(page, shape)).filter(image =>
    (image.url as string).startsWith('data:image/'));
  if (images.reduce((total, image) => total + (image.url as string).length, 0) >= displayChars)
    omitImages(images, historyNote);
  return page;
}

/** The native server can echo all accepted images in an item notification.
 * Keep the actual event and identifiers while removing base64 from its preview. */
export class NativeMediaEvent {
  private buffer = Buffer.allocUnsafe(512 * 1024);
  private size = 0;
  private start = -1;
  private escaped = false;
  private image = false;
  private readonly nonce = randomUUID();
  private readonly replacements = new Set<string>();
  private urlValue = false;
  private invalid = false;
  static matches(prefix: string): boolean {
    return /^\{"method":"(?:item\/(?:started|completed)|turn\/(?:started|completed))","params":\{/.test(prefix);
  }
  update(chunk: Buffer): void {
    for (const byte of chunk) {
      if (this.invalid) return;
      if (this.image && byte !== 34) {
        if (!(byte >= 65 && byte <= 90 || byte >= 97 && byte <= 122 || byte >= 48 && byte <= 57 || byte === 43 || byte === 47 || byte === 61)) this.invalid = true;
        continue;
      }
      if (this.size === this.buffer.length) {
        // Legal chat text can be 1 MiB before JSON escaping. Budget the
        // projected notification exactly as an ordinary native event.
        if (this.size === LIMITS.eventBytes) { this.invalid = true; return; }
        const larger = Buffer.allocUnsafe(Math.min(this.size * 2, LIMITS.eventBytes));
        this.buffer.copy(larger); this.buffer = larger;
      }
      this.buffer[this.size++] = byte;
      if (this.start < 0) {
        if (byte === 34) {
          this.start = this.size;
          this.urlValue = this.buffer.toString('ascii', Math.max(0, this.size - 7), this.size) === '"url":"';
        }
        continue;
      }
      if (byte === 34 && !this.escaped) {
        this.start = -1; this.image = false; continue;
      }
      this.escaped = byte === 92 && !this.escaped;
      if (this.urlValue && this.size - this.start === 192 && imagePrefix.test(this.buffer.toString('ascii', this.start, this.size))) {
        if (this.replacements.size >= 128) { this.invalid = true; return; }
        const token = this.nonce + ':' + this.replacements.size;
        this.replacements.add(token);
        this.size = this.start + this.buffer.write(token, this.start, 'ascii');
        this.image = true;
      }
    }
  }
  private envelope(): JsonObject | undefined {
    if (this.invalid || !this.replacements.size || this.start >= 0) return;
    try {
      const raw = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.buffer.subarray(0, this.size))));
      if (raw) jsonBytes(raw);
      return raw;
    } catch { return; }
  }
  private replace(raw: JsonObject, items: JsonValue[], label: string): boolean {
    const allowed = new Set(inlineUserImages(items).filter(image => this.replacements.has(image.url as string)));
    // A temporary marker must occur once and only at a known user image URL.
    // Other fields can contain arbitrary literal text, including a data URL.
    const seen = new Set<string>();
    const visit = (value: JsonValue, isUserImageUrl = false): boolean => {
      if (typeof value === 'string' && this.replacements.has(value)) {
        if (!isUserImageUrl || seen.has(value)) return false;
        seen.add(value);
      }
      if (!value || typeof value !== 'object') return true;
      if (Array.isArray(value)) return value.every(child => visit(child));
      return Object.entries(value).every(([key, child]) =>
        !this.replacements.has(key) && visit(child, key === 'url' && allowed.has(value)));
    };
    if (!visit(raw) || seen.size !== this.replacements.size) return false;
    omitImages(allowed, label);
    return true;
  }
  historyReply(id: number, shape: NativeHistoryShape): JsonObject | undefined {
    const raw = this.envelope(), result = record(raw?.result);
    if (!raw || raw.id !== id || !result || 'method' in raw || 'error' in raw) return;
    return this.replace(raw, historyItems(result, shape), historyNote) ? result : undefined;
  }
  projection(): JsonObject | undefined {
    const raw = this.envelope(), params = record(raw?.params);
    if (!raw || typeof raw.method !== 'string' || !methods.has(raw.method) || 'id' in raw || !params ||
        typeof params.threadId !== 'string' || this.replacements.has(params.threadId)) return;
    let items: JsonValue[];
    if (raw.method.startsWith('item/')) {
      if (typeof params.turnId !== 'string' || typeof record(params.item)?.id !== 'string') return;
      items = [params.item!];
    } else {
      const turn = record(params.turn);
      if (!turn || typeof turn.id !== 'string') return;
      items = Array.isArray(turn.items) ? turn.items : [];
    }
    if (!this.replace(raw, items, '［此回合含有图片，实时预览省略］'))
      return { method: 'harness/historyPreviewOmitted', params: { threadId: params.threadId } };
    return { method: raw.method, params };
  }
}
