import { randomUUID } from 'node:crypto';
import type { JsonObject, JsonValue } from './types.js';

const imagePrefix = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const methods = new Set(['item/started', 'item/completed', 'turn/started', 'turn/completed']);

function record(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
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
      if (this.size >= this.buffer.length) { this.invalid = true; return; }
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
  projection(): JsonObject | undefined {
    if (this.invalid || !this.replacements.size || this.start >= 0) return;
    try {
      const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.buffer.subarray(0, this.size)));
      if (!methods.has(raw.method) || 'id' in raw || !raw.params || typeof raw.params.threadId !== 'string') return;
      const params = raw.params;
      if (raw.method.startsWith('item/') && (typeof params.turnId !== 'string' || typeof params.item?.id !== 'string')) return;
      if (raw.method.startsWith('turn/') && typeof params.turn?.id !== 'string') return;
      if (this.replacements.has(params.threadId)) return;
      const items = raw.method.startsWith('item/') ? [params.item] : params.turn?.items;
      const allowed = new Set<JsonObject>();
      for (const item of Array.isArray(items) ? items : []) {
        if (item?.type !== 'userMessage' || !Array.isArray(item.content)) continue;
        for (const part of item.content) {
          const image = record(part);
          if (image?.type === 'image' && typeof image.url === 'string' && this.replacements.has(image.url)) allowed.add(image);
        }
      }
      // Every temporary marker must occur once, exactly in a known user image.
      // A literal equal to a marker or a data URL in another kind of field
      // invalidates the preview without forwarding a modified tool or message.
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
      if (!visit(raw) || seen.size !== this.replacements.size)
        return { method: 'harness/historyPreviewOmitted', params: { threadId: params.threadId } };
      for (const part of allowed) {
        part.type = 'text'; part.text = '［此回合含有图片，实时预览省略］'; delete part.url; delete part.detail;
      }
      return { method: raw.method, params };
    } catch { return; }
  }
}
