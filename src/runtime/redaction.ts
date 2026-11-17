import { DeliveryError, type JsonValue } from './types.js';

const managedProviderKey = /^HARNESS_PROVIDER_KEY_(?:DEFAULT|[0-9A-F]{32})$/;

/** Applied to diagnostics, not to user attachments or native request payloads. */
export class DiagnosticRedactor {
  private secrets: string[];
  constructor(env: NodeJS.ProcessEnv) {
    this.secrets = [...new Set(Object.entries(env).flatMap(([key, value]) => {
      if (!value) return [];
      if (managedProviderKey.test(key) || /(?:^|_)(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)(?:_|$)/i.test(key) || /(?:api[_-]?key|password|secret|token)$/i.test(key) && value.length >= 8) return [value];
      if (/PROXY$/i.test(key)) { try { const url = new URL(value); return url.password ? [value, decodeURIComponent(url.password)] : []; } catch { return []; } }
      return [];
    }))].sort((a, b) => b.length - a.length);
  }
  text(value: string): string {
    let result = value;
    for (const secret of this.secrets) result = result.split(secret).join('[redacted]');
    return result.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
      .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@')
      .replace(/(--(?:api[-_]?key|token|password|secret)(?:=|\s+))[^\s"']+/gi, '$1[redacted]')
      .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)=)[^\s"']+/g, '$1[redacted]')
      .replace(/\b(HARNESS_PROVIDER_KEY_(?:DEFAULT|[0-9A-F]{32})\s*["']?\s*[:=]\s*["']?)[^\s"',;}&#]+/g, '$1[redacted]')
      .replace(/([?&](?:access_token|refresh_token|id_token|api_key|apikey|token|key)=)[^&#\s]+/gi, '$1[redacted]')
      .replace(/((?:access_token|refresh_token|id_token|api_key|authorization)\s*["']?\s*[:=]\s*["']?)[^\s"',;}&#]+/gi, '$1[redacted]');
  }
  addSecret(value: string): void {
    if (!value || this.secrets.includes(value)) return;
    if (this.secrets.length >= 256 || this.secrets.reduce((bytes, secret) => bytes + Buffer.byteLength(secret), 0) + Buffer.byteLength(value) > 1024 * 1024) throw new DeliveryError('capacity', '诊断密钥保护容量已满，请先结束当前任务，再通过服务管理重启后台后重试；已有密钥仍受保护。');
    this.secrets.push(value); this.secrets.sort((a, b) => b.length - a.length);
  }
  value(value: JsonValue): JsonValue {
    if (typeof value === 'string') return this.text(value);
    if (Array.isArray(value)) return value.map((entry, index) => typeof entry === 'string' && typeof value[index - 1] === 'string' && /^--(?:api[-_]?key|token|password|secret)$/i.test(value[index - 1] as string) ? '[redacted]' : this.value(entry));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [this.text(key), managedProviderKey.test(key) || /(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|authorization|password|secret)/i.test(key) ? '[redacted]' : this.value(entry)]));
    return value;
  }
}
