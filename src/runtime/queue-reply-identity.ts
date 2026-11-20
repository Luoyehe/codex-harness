import { createHash, type Hash } from 'node:crypto';
import type { JsonObject } from './types.js';

type Scope = 'envelope' | 'result' | 'queued' | 'input' | 'part' | 'other';
type Container = { object: boolean; scope: Scope; state: 'key' | 'colon' | 'value' | 'end'; key?: string; keys?: Set<string>; ordinal?: number };

/** Extract two short identities from a positively correlated, oversized native
 * JSON reply. Never retain input text or image data. Incomplete, ambiguous or
 * malformed identity locations return no proof; the original operation stays unknown. */
export class QueueReplyIdentity {
  private stack: Container[] = [];
  private source: number[] = [];
  private capturing = false;
  private inString = false;
  private escaped = false;
  private scalar = false;
  private scalarBytes: number[] = [];
  private envelopeId = false;
  private inputCount = 0;
  private urlHash: Hash | undefined;
  private hashBuffer = Buffer.allocUnsafe(16384);
  private hashLength = 0;
  private urlBySlot: { ordinal: number; sha256: string }[] = [];
  constructor(private expectedId: number) {}
  private invalid = false;
  private started = false;
  private fields = new Map<string, string>();
  private paths = new Set<Scope>();
  update(bytes: Buffer): void {
    for (const byte of bytes) {
      if (this.invalid) return;
      if (this.inString) {
        if (byte === 34 && !this.escaped) {
          this.inString = false;
          const parent = this.stack.at(-1);
          if (!parent) { this.invalid = true; return; }
          if (this.urlHash) {
            if (parent.ordinal === undefined || this.urlBySlot.length >= 128) { this.invalid = true; return; }
            this.urlHash.update(this.hashBuffer.subarray(0, this.hashLength));
            this.urlBySlot.push({ ordinal: parent.ordinal, sha256: this.urlHash.digest('hex') });
            this.urlHash = undefined;
          }
          let value = '';
          if (this.capturing) {
            try { value = JSON.parse('"' + new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(this.source)) + '"'); }
            catch { this.invalid = true; return; }
          }
          if (parent.state === 'key') {
            if (parent.keys && (parent.keys.has(value) || parent.keys.size >= 32)) { this.invalid = true; return; }
            parent.keys?.add(value); parent.key = value; parent.state = 'colon';
          }
          else {
            if (this.capturing && parent.key) {
              if (!value || Buffer.byteLength(value) > 256 || this.fields.has(parent.key)) { this.invalid = true; return; }
              this.fields.set(parent.key, value);
            }
            parent.state = 'end';
          }
          continue;
        }
        if (byte < 32 || this.capturing && this.source.length >= 1536) { this.invalid = true; return; }
        if (this.capturing) this.source.push(byte);
        if (this.urlHash) {
          if (this.escaped && byte !== 47) { this.invalid = true; return; }
          if (byte !== 92) {
            this.hashBuffer[this.hashLength++] = byte;
            if (this.hashLength === this.hashBuffer.length) { this.urlHash.update(this.hashBuffer); this.hashLength = 0; }
          }
        }
        this.escaped = !this.escaped && byte === 92;
        continue;
      }
      if (this.scalar) {
        if (byte !== 44 && byte !== 125 && byte !== 93 && byte > 32) {
          if (this.scalarBytes.length >= 80) { this.invalid = true; return; }
          this.scalarBytes.push(byte); continue;
        }
        const parent = this.stack.at(-1);
        try {
          const primitive: unknown = JSON.parse(Buffer.from(this.scalarBytes).toString('ascii'));
          if (parent?.scope === 'envelope' && parent.key === 'id') this.envelopeId = primitive === this.expectedId;
        } catch { this.invalid = true; return; }
        this.scalar = false;
      }
      if ([32, 9, 10, 13].includes(byte)) continue;
      const parent = this.stack.at(-1);
      if (byte === 123 || byte === 91) {
        if (parent && parent.state !== 'value' || !parent && this.started || this.stack.length >= 96) { this.invalid = true; return; }
        let scope: Scope = 'other';
        if (!parent) scope = 'envelope';
        else if (parent.scope === 'envelope' && parent.key === 'result') scope = 'result';
        else if (parent.scope === 'result' && parent.key === 'queuedSubmission') scope = 'queued';
        else if (parent.scope === 'queued' && parent.key === 'input') scope = 'input';
        else if (parent.scope === 'input') scope = 'part';
        if (scope !== 'other' && scope !== 'part') {
          if (byte !== (scope === 'input' ? 91 : 123) || this.paths.has(scope)) { this.invalid = true; return; }
          this.paths.add(scope);
        }
        this.started = true;
        if (parent) parent.state = 'end';
        if (scope === 'part' && (byte !== 123 || this.inputCount >= 8192)) { this.invalid = true; return; }
        this.stack.push({ object: byte === 123, scope, ...(scope === 'part' ? {ordinal: this.inputCount++} : {}), state: byte === 123 ? 'key' : 'value', ...(scope !== 'other' ? { keys: new Set<string>() } : {}) });
      } else if (!parent) { this.invalid = true; return; }
      else if (byte === 34) {
        if (parent.state !== 'key' && parent.state !== 'value') { this.invalid = true; return; }
        this.inString = true; this.escaped = false; this.source = [];
        if (parent.scope === 'part' && parent.state === 'value' && parent.key === 'url') { this.urlHash = createHash('sha256'); this.hashLength = 0; }
        this.capturing = parent.state === 'key' ? parent.scope !== 'other'
          : parent.scope === 'queued' && (parent.key === 'id' || parent.key === 'clientUserMessageId');
      } else if (byte === 58 && parent.state === 'colon') parent.state = 'value';
      else if (byte === 44 && parent.state === 'end') { delete parent.key; parent.state = parent.object ? 'key' : 'value'; }
      else if (byte === 125 && parent.object || byte === 93 && !parent.object) {
        if (parent.state === 'colon' || parent.object && parent.state === 'value') { this.invalid = true; return; }
        this.stack.pop();
      } else if (parent.state === 'value' && (byte >= 48 && byte <= 57 || [45, 116, 102, 110].includes(byte))) {
        this.scalar = true; this.scalarBytes = [byte]; parent.state = 'end';
      } else { this.invalid = true; return; }
    }
  }
  proof(): JsonObject | undefined {
    if (this.invalid || !this.paths.has('input') || !this.envelopeId || this.stack.length || this.inString || !this.fields.has('id') || !this.fields.has('clientUserMessageId')) return;
    return { queuedSubmissionId: this.fields.get('id')!, clientUserMessageId: this.fields.get('clientUserMessageId')!, inputCount: this.inputCount, urlBySlot: this.urlBySlot };
  }
}
