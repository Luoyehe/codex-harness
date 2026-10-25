import { DeliveryError, integer, jsonBytes, LIMITS, object, onlyKeys, string, type CallContext, type JsonObject, type JsonValue } from './types.js';
import { validateOfficial } from './validation.js';
import type { NativeOptions } from './native.js';
import type { WorkflowMutation } from './workflows.js';
interface Host { native(method: string, params: JsonValue, options?: NativeOptions): Promise<JsonValue>; mutate(operation: WorkflowMutation, context: CallContext): Promise<JsonValue> }
export const threadTerminalMethods = new Set(['thread/shellCommand', 'thread/backgroundTerminals/list', 'thread/backgroundTerminals/terminate', 'thread/backgroundTerminals/clean']);
export class ThreadTerminals {
  constructor(private host: Host) {}
  private async list(params: JsonObject): Promise<JsonObject> {
    onlyKeys(params, ['threadId', 'cursor', 'limit']); const p = { ...params, limit: params.limit == null ? 50 : integer(params.limit, 'limit', 1, 100) };
    if (params.cursor != null) string(params.cursor, 'cursor', LIMITS.cursorBytes); validateOfficial('ThreadBackgroundTerminalsListParams', p);
    const result = await this.host.native('thread/backgroundTerminals/list', p); validateOfficial('ThreadBackgroundTerminalsListResponse', result); jsonBytes(result, 2 * 1024 * 1024); const page = object(result);
    if (!Array.isArray(page.data) || page.data.length > 100) throw new DeliveryError('invalid_native_response', 'Background terminals page exceeded its budget');
    if (page.nextCursor !== null) { string(page.nextCursor, 'nextCursor', LIMITS.cursorBytes); if (page.nextCursor === params.cursor) throw new DeliveryError('cursor_loop', 'Background terminal cursor did not advance'); } return page;
  }
  private async discovered(threadId: string, processId: string): Promise<void> {
    let cursor: JsonValue = null, bytes = 0; const seen = new Set<string>();
    for (let page = 0; page < 32; page++) {
      const result = await this.list({ threadId, cursor, limit: 100 }); bytes += Buffer.byteLength(jsonBytes(result)); if (bytes > 2 * 1024 * 1024) throw new DeliveryError('capacity', 'Background terminal discovery exceeded its budget');
      if ((result.data as JsonValue[]).some(item => object(item).processId === processId)) return;
      if (result.nextCursor === null) throw new DeliveryError('not_found', 'Background terminal is no longer listed in this thread');
      const next = string(result.nextCursor, 'nextCursor'); if (seen.has(next)) throw new DeliveryError('cursor_loop', 'Background terminal cursor loop'); seen.add(next); cursor = next;
    }
    throw new DeliveryError('capacity', 'Background terminal discovery exceeded its page budget');
  }
  async call(method: string, params: JsonObject, context: CallContext): Promise<JsonValue> {
    const threadId = string(params.threadId, 'threadId');
    if (method === 'thread/backgroundTerminals/list') return this.list(params);
    if (method === 'thread/shellCommand') {
      onlyKeys(params, ['threadId', 'command', 'timeoutMs', 'confirmUnsandboxed']); if (params.confirmUnsandboxed !== true) throw new DeliveryError('confirmation_required', 'Thread shell commands run with full native access outside the thread sandbox');
      const p = { threadId, command: string(params.command, 'command', 65536), timeoutMs: params.timeoutMs == null ? 3600000 : integer(params.timeoutMs, 'timeoutMs', 0, 86400000) };
      return this.host.mutate({ method, params: p, schema: 'ThreadShellCommandParams', responseSchema: 'ThreadShellCommandResponse', threadId, mode: 'idle', history: true, directInput: true, workResult: 'shell', project: () => ({ threadId, submitted: true }) }, context);
    }
    if (method === 'thread/backgroundTerminals/terminate') {
      onlyKeys(params, ['threadId', 'processId']); const processId = string(params.processId, 'processId', 256);
      return this.host.mutate({ method, params, schema: 'ThreadBackgroundTerminalsTerminateParams', responseSchema: 'ThreadBackgroundTerminalsTerminateResponse', threadId, mode: 'any', history: true,
        preflight: () => this.discovered(threadId, processId), project: result => ({ threadId, processId, terminated: object(result).terminated! }) }, context);
    }
    if (method === 'thread/backgroundTerminals/clean') {
      onlyKeys(params, ['threadId', 'confirm']); if (params.confirm !== true) throw new DeliveryError('confirmation_required', 'Confirm cleanup of this thread\'s native background terminals');
      return this.host.mutate({ method, params: { threadId }, schema: 'ThreadBackgroundTerminalsCleanParams', responseSchema: 'ThreadBackgroundTerminalsCleanResponse', threadId, mode: 'any', history: true, project: () => ({ threadId, cleanupRequested: true }) }, context);
    }
    throw new DeliveryError('method_not_found', 'Unsupported thread terminal workflow');
  }
}
