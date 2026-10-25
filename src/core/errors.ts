import type { Delivery, ErrorBody, JsonValue } from './contracts.js';
export class HarnessError extends Error {
  constructor(readonly code: string, message: string, readonly delivery: Delivery = 'not_sent', readonly data?: JsonValue) {
    super(message); this.name = 'HarnessError';
  }
}
export function errorBody(error: unknown, fallbackDelivery: Delivery = 'not_sent'): ErrorBody {
  if (error instanceof HarnessError) return { code: error.code, message: error.message, delivery: error.delivery, ...(error.data === undefined ? {} : { data: error.data }) };
  // Do not disclose stack traces, subprocess output, environment or upstream credentials.
  return { code: 'internal', message: '操作未能完成，请查看服务状态。', delivery: fallbackDelivery };
}
