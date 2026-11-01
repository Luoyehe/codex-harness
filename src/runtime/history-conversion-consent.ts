import { DeliveryError, object, onlyKeys, string, type JsonValue } from './types.js';

/** Consent belongs to this one transition, never to saved model settings. */
export function requireHistoryConversionConsent(value: JsonValue | undefined, threadId: string, source: JsonValue | undefined, target: JsonValue | undefined, required: boolean): void {
  if (!required && value === undefined) return;
  const sourceProvider = string(source, 'source provider', 80), targetProvider = string(target, 'target provider', 80);
  if (value !== undefined) {
    const consent = object(value, 'historyConversionConsent'); onlyKeys(consent, ['sourceProvider', 'targetProvider']);
    if (string(consent.sourceProvider, 'sourceProvider', 80) !== sourceProvider || string(consent.targetProvider, 'targetProvider', 80) !== targetProvider)
      throw new DeliveryError('history_conversion_consent_stale', '会话或目标供应商已变化，请重新确认历史转换。');
    return;
  }
  if (required) throw new DeliveryError('history_conversion_confirmation_required', '切换供应商需要转换专用推理历史；原始记录会保留备份，请确认后继续。', 'not_sent',
    { threadId, sourceProvider, targetProvider, conversionRequired: true });
}
