export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type Delivery = 'not_sent' | 'unknown';
export interface ErrorBody { code: string; message: string; delivery?: Delivery; operationId?: string; data?: JsonValue }
export type ApiResponse = { ok: true; result: JsonValue } | { ok: false; error: ErrorBody };
export interface RpcCall { method: string; params: JsonObject; operationId?: string }
export interface CallContext { clientId: string; operationId?: string; beforeWrite?: () => void; requireConnection?: () => void; gatewayRequestDigest?: string; projectId?: string }
export interface HarnessEvent { type: string; data: JsonValue }
export interface WorkerPort {
  call(method: string, params: JsonObject, context: CallContext): Promise<JsonValue>;
  connected: boolean;
}
export interface Project { id: string; name: string; path: string }
export type ReceiptState = 'pending' | 'dispatching' | 'accepted' | 'not_sent' | 'unknown';
export interface Receipt {
  operationId: string; method: string; state: ReceiptState; scope: string;
  createdAt: number; updatedAt: number; result?: JsonValue; error?: ErrorBody;
}
export const LIMITS = Object.freeze({
  requestBytes: 8 * 1024 * 1024, responseBytes: 12 * 1024 * 1024,
  promptBytes: 1024 * 1024, receiptBytes: 2 * 1024 * 1024,
  receiptCount: 10000, receiptStorageBytes: 64 * 1024 * 1024,
  concurrentRequests: 48, retainedRequestBytes: 24 * 1024 * 1024,
  httpConnections: 96, retainedResponseBytes: 32 * 1024 * 1024, responseWriteTimeoutMs: 15000,
  sockets: 16, socketBufferedBytes: 4 * 1024 * 1024,
});
