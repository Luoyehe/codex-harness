import { DeliveryError, type JsonValue } from './types.js';

/** Applied to diagnostics, not to user attachments or native request payloads. */
export class DiagnosticRedactor {
  private secrets: string[];
  constructor(env: NodeJS.ProcessEnv) {
    this.secrets = [...new Set(Object.entries(env).flatMap(([key, value]) => {
      if (!value) return [];
      if (/(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(key)) return [value];
      if (/PROXY$/i.test(key)) { try { const url = new URL(value); return url.password ? [value, decodeURIComponent(url.password)] : []; } catch { return []; } }
      return [];
    }))].sort((a, b) => b.length - a.length);
  }
  text(value: string): string {
    let result = value;
    for (const secret of this.secrets) result = result.split(secret).join('[redacted]');
    return result.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
      .replace(/([?&](?:access_token|refresh_token|id_token|api_key|apikey|token|key)=)[^&#\s]+/gi, '$1[redacted]')
      .replace(/((?:access_token|refresh_token|id_token|api_key|authorization)\s*["']?\s*[:=]\s*["']?)[^\s"',;}&#]+/gi, '$1[redacted]');
  }
  addSecret(value: string): void {
    if (!value || this.secrets.includes(value)) return;
    if (this.secrets.length >= 256 || this.secrets.reduce((bytes, secret) => bytes + Buffer.byteLength(secret), 0) + Buffer.byteLength(value) > 1024 * 1024) throw new DeliveryError('capacity', 'Diagnostic secret retention budget exhausted');
    this.secrets.push(value); this.secrets.sort((a, b) => b.length - a.length);
  }
  value(value: JsonValue): JsonValue {
    if (typeof value === 'string') return this.text(value);
    if (Array.isArray(value)) return value.map(entry => this.value(entry));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [this.text(key), /(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|authorization|password|secret)/i.test(key) ? '[redacted]' : this.value(entry)]));
    return value;
  }
}
