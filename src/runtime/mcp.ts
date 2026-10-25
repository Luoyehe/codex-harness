import { randomUUID } from 'node:crypto';
import { DeliveryError, integer, jsonBytes, LIMITS, object, onlyKeys, string, type CallContext, type JsonObject, type JsonValue } from './types.js';
import { validateOfficial } from './validation.js';
import { validateMcpArguments } from './mcp-schema.js';
import type { NativeOptions } from './native.js';
import type { WorkflowMutation } from './workflows.js';

export const mcpMethods = new Set(['mcp/list', 'mcp/tool/call', 'mcp/resource/read', 'mcp/stream/start', 'mcp/stream/stop', 'mcp/stream/list', 'mcp/result/read', 'mcp/result/remove', 'mcp/reload']);
interface Owner { clientId: string; eventChannelId: string | undefined }
interface Stream extends Owner { subscriptionId: string; threadId: string; server: string; name: string; revoked: boolean; dispatched: boolean; startSettled: Promise<void>; stopping?: Promise<void> }
interface Result extends Owner { resultId: string; threadId: string; server: string; tool: string; pending: boolean; revoked: boolean; expiresAt: number; bytes: number; result?: JsonValue; timer?: NodeJS.Timeout }
interface McpHost {
  native(method: string, params: JsonValue, options?: NativeOptions): Promise<JsonValue>;
  mutate(operation: WorkflowMutation, context: CallContext): Promise<JsonValue>;
  configure(operation: (write: (method: string, params: JsonValue, options?: NativeOptions) => Promise<JsonValue>) => Promise<JsonValue>, context: CallContext): Promise<JsonValue>;
  requireLoaded(threadId: string): void;
  emit(data: JsonObject, eventChannelId?: string): void;
  changed(): void;
  failEpoch(): Promise<void>;
}
const owned = (a: Owner, b: CallContext): boolean => a.clientId === b.clientId && a.eventChannelId === b.eventChannelId;
const checked = (schema: string, value: JsonValue): JsonObject => { try { validateOfficial(schema, value); jsonBytes(value, LIMITS.historyBytes); return object(value); } catch { throw new DeliveryError('invalid_native_response', 'MCP returned an invalid or oversized response'); } };
function matchesTemplate(template: string, uri: string): boolean {
  if (template.length > 4096 || template.split('{').length > 17) return false;
  const fragments = template.split(/\{[^{}]+\}/); if (fragments.length < 2 || fragments.some(part => /[{}]/.test(part))) return false;
  if (!uri.startsWith(fragments[0]!) || !uri.endsWith(fragments.at(-1)!)) return false;
  let offset = fragments[0]!.length;
  for (const fragment of fragments.slice(1)) { const at = uri.indexOf(fragment, offset); if (at < 0) return false; offset = at + fragment.length; }
  return true;
}

/** Native MCP connections remain authoritative; browser resources are separately owned. */
export class Mcp {
  private streams = new Map<string, Stream>();
  private results = new Map<string, Result>();
  private resultBytes = 0;
  private origins = new Map<string, { threadId: string; server: string }>();
  constructor(private host: McpHost) {}
  get subscriptions(): number { return this.streams.size; }
  private removeResult(entry: Result): void { if (this.results.delete(entry.resultId)) { clearTimeout(entry.timer); this.resultBytes -= entry.bytes; } }
  private collect(): void { const now = Date.now(); for (const entry of this.results.values()) if (!entry.pending && entry.expiresAt < now) this.removeResult(entry); }
  private requireOwner<T extends Owner>(entry: T | undefined, context: CallContext): T { if (!entry || !owned(entry, context)) throw new DeliveryError('not_found', 'MCP resource is unavailable for this connection and runtime epoch'); return entry; }
  async list(params: JsonObject): Promise<JsonObject> {
    onlyKeys(params, ['cursor', 'limit', 'threadId', 'serverName', 'detail']); if (params.threadId != null) this.host.requireLoaded(string(params.threadId, 'threadId'));
    const p: JsonObject = { ...params, limit: params.limit === undefined ? 50 : integer(params.limit, 'limit', 1, 100) };
    if (p.cursor != null) string(p.cursor, 'cursor', LIMITS.cursorBytes, true); validateOfficial('ListMcpServerStatusParams', p);
    const result = checked('ListMcpServerStatusResponse', await this.host.native('mcpServerStatus/list', p));
    if (!Array.isArray(result.data) || result.data.length > 100) throw new DeliveryError('invalid_native_response', 'MCP inventory exceeds its page budget');
    if (result.nextCursor !== null) { string(result.nextCursor, 'nextCursor', LIMITS.cursorBytes, true); if (result.nextCursor === p.cursor) throw new DeliveryError('cursor_loop', 'MCP catalog cursor did not advance'); }
    return result;
  }
  private async server(threadId: string, name: string): Promise<JsonObject> {
    this.host.requireLoaded(threadId);
    const page = await this.list({ threadId, serverName: name, detail: 'full', limit: 100 });
    if ((page.data as JsonValue[]).length !== 1 || object((page.data as JsonValue[])[0]).name !== name) throw new DeliveryError('mcp_unavailable', 'The selected MCP server was not discovered');
    const server = object((page.data as JsonValue[])[0]);
    if (server.runtimeStatus !== 'connected') throw new DeliveryError('mcp_unavailable', 'The MCP server is not connected; inspect its native connection/authentication status');
    return server;
  }
  async call(method: string, params: JsonObject, context: CallContext): Promise<JsonValue> {
    this.collect();
    if (method === 'mcp/list') return this.list(params);
    if (method === 'mcp/reload') { onlyKeys(params, []); return this.host.configure(write => write('config/mcpServer/reload', null), context); }
    if (method === 'mcp/stream/list') { onlyKeys(params, []); return { data: [...this.streams.values()].filter(entry => owned(entry, context) && !entry.revoked).map(entry => this.publicStream(entry)) }; }
    if (method === 'mcp/stream/stop') { onlyKeys(params, ['subscriptionId']); const entry = this.requireOwner(this.streams.get(string(params.subscriptionId, 'subscriptionId')), context); context.beforeWrite?.(); await this.stop(entry); return { subscriptionId: entry.subscriptionId, stopped: true }; }
    if (method === 'mcp/result/read' || method === 'mcp/result/remove') {
      onlyKeys(params, ['resultId']); const entry = this.requireOwner(this.results.get(string(params.resultId, 'resultId')), context);
      if (entry.pending) throw new DeliveryError('result_pending', 'MCP result is still pending');
      if (method === 'mcp/result/remove') { context.beforeWrite?.(); this.removeResult(entry); return { removed: true }; }
      return { resultId: entry.resultId, threadId: entry.threadId, server: entry.server, tool: entry.tool, result: entry.result! };
    }
    const threadId = string(params.threadId, 'threadId'); const server = string(params.server, 'server', 256); this.host.requireLoaded(threadId);
    if (method === 'mcp/tool/call') return this.tool(params, context, threadId, server);
    if (method === 'mcp/stream/start') return this.start(params, context, threadId, server);
    if (method === 'mcp/resource/read') return this.resource(params, context, threadId, server);
    throw new DeliveryError('method_not_found', 'Unsupported MCP workflow');
  }
  private async tool(params: JsonObject, context: CallContext, threadId: string, server: string): Promise<JsonValue> {
    onlyKeys(params, ['threadId', 'server', 'tool', 'arguments', '_meta']); const tool = string(params.tool, 'tool', 256); const p = { ...params, arguments: params.arguments ?? {} }; validateOfficial('McpServerToolCallParams', p);
    const reserve = LIMITS.historyBytes; if (this.results.size >= 64 || this.resultBytes + reserve > 32 * 1024 * 1024) throw new DeliveryError('capacity', 'MCP result retention is full; remove previous results before calling another tool');
    const entry: Result = { resultId: randomUUID(), threadId, server, tool, clientId: context.clientId, eventChannelId: context.eventChannelId, pending: true, revoked: false, expiresAt: Date.now() + 600000, bytes: reserve };
    this.results.set(entry.resultId, entry); this.resultBytes += reserve;
    try {
      return await this.host.mutate({ method: 'mcpServer/tool/call', params: p, schema: 'McpServerToolCallParams', responseSchema: 'McpServerToolCallResponse', threadId, mode: 'idle', history: true,
        preflight: async () => { const found = await this.server(threadId, server); if (found.toolsError !== null) throw new DeliveryError('mcp_unavailable', 'Fresh tool discovery failed'); const descriptor = object(object(found.tools)[tool], 'discovered tool'); if (descriptor.name !== tool) throw new DeliveryError('mcp_unavailable', 'Tool descriptor identity mismatch'); await validateMcpArguments(descriptor.inputSchema!, p.arguments); },
        beforeWrite: () => { this.host.requireLoaded(threadId); if (entry.revoked) throw new DeliveryError('client_disconnected', 'MCP caller disconnected before dispatch'); },
        project: result => { const value = checked('McpServerToolCallResponse', result); const bytes = Buffer.byteLength(jsonBytes(value, LIMITS.historyBytes)); if (!entry.revoked && this.results.get(entry.resultId) === entry) { this.resultBytes += bytes - entry.bytes; entry.bytes = bytes; entry.pending = false; entry.result = value; entry.expiresAt = Date.now() + 600000; entry.timer = setTimeout(() => this.removeResult(entry), 600000); entry.timer.unref(); } else this.removeResult(entry); return { resultId: entry.resultId, threadId, server, tool, isError: value.isError === true }; },
      }, context);
    } catch (error) { this.removeResult(entry); throw error; }
  }
  private async resource(params: JsonObject, context: CallContext, threadId: string, server: string): Promise<JsonValue> {
    onlyKeys(params, ['threadId', 'server', 'uri', 'originCallId', 'originTurnId', 'connectorId', 'target']); const uri = string(params.uri, 'uri', 4096); const found = await this.server(threadId, server);
    let discovered = (found.resources as JsonValue[]).some(resource => object(resource).uri === uri) || (found.resourceTemplates as JsonValue[]).some(resource => matchesTemplate(string(object(resource).uriTemplate, 'uriTemplate'), uri));
    if (params.originCallId != null) {
      const id = string(params.originCallId, 'originCallId'); let origin = this.origins.get(id);
      if (!origin && params.originTurnId !== undefined) {
        const turnId = string(params.originTurnId, 'originTurnId'); const items = checked('ThreadItemsReadResponse', await this.host.native('thread/items/read', { threadId, turnId, itemIds: [id] }));
        if (Array.isArray(items.data) && items.data.length === 1) { const record = object(items.data[0]); const item = object(record.item); if (record.turnId === turnId && item.type === 'mcpToolCall' && item.id === id && item.server === server) origin = { threadId, server }; }
      }
      if (!origin || origin.threadId !== threadId || origin.server !== server) throw new DeliveryError('invalid_params', 'Resource origin must identify a real MCP call in this thread'); discovered = true;
    }
    if (!discovered) throw new DeliveryError('resource_not_discovered', 'Resource URI was not discovered or tied to a native call');
    const { originTurnId: _turn, ...p } = params; validateOfficial('McpResourceReadParams', p);
    return checked('McpResourceReadResponse', await this.host.native('mcpServer/resource/read', p, { beforeWrite: () => { this.host.requireLoaded(threadId); context.beforeWrite?.(); } }));
  }
  private publicStream(entry: Stream): JsonObject { return { subscriptionId: entry.subscriptionId, threadId: entry.threadId, server: entry.server, name: entry.name }; }
  private async start(params: JsonObject, context: CallContext, threadId: string, server: string): Promise<JsonValue> {
    onlyKeys(params, ['threadId', 'server', 'name', 'arguments', '_meta']); const name = string(params.name, 'name', 256); jsonBytes(params.arguments, 256 * 1024);
    if (this.streams.size >= 16 || [...this.streams.values()].filter(entry => owned(entry, context)).length >= 2) throw new DeliveryError('capacity', 'MCP subscription capacity exhausted');
    let settleStart!: () => void;
    const entry: Stream = { subscriptionId: randomUUID(), threadId, server, name, clientId: context.clientId, eventChannelId: context.eventChannelId, revoked: false, dispatched: false, startSettled: new Promise(resolve => { settleStart = resolve; }) };
    const p = { ...params, subscriptionId: entry.subscriptionId }; validateOfficial('McpServerEventStreamStartParams', p); this.streams.set(entry.subscriptionId, entry); this.host.changed();
    try {
      await this.host.mutate({ method: 'mcpServer/event/stream/start', params: p, schema: 'McpServerEventStreamStartParams', responseSchema: 'McpServerEventStreamStartResponse', threadId, mode: 'any', history: true,
        preflight: async () => { await this.server(threadId, server); }, beforeWrite: () => { this.host.requireLoaded(threadId); if (entry.revoked || this.streams.get(entry.subscriptionId) !== entry) throw new DeliveryError('client_disconnected', 'Subscription owner disconnected'); entry.dispatched = true; },
      }, context);
      settleStart();
      return this.publicStream(entry);
    } catch (error) {
      settleStart();
      if (error instanceof DeliveryError && error.delivery === 'not_sent') { this.streams.delete(entry.subscriptionId); this.host.changed(); }
      else { entry.revoked = true; await this.stop(entry); }
      throw error;
    }
  }
  private stop(entry: Stream): Promise<void> {
    if (entry.stopping) return entry.stopping; entry.revoked = true;
    entry.stopping = Promise.resolve().then(async () => {
      // Native start may register asynchronously. A stop acknowledged before that
      // registration would not prove the later stream was released.
      await entry.startSettled;
      if (entry.dispatched) {
        try { checked('McpServerEventStreamStopResponse', await this.host.native('mcpServer/event/stream/stop', { subscriptionId: entry.subscriptionId })); }
        catch { await this.host.failEpoch(); }
      }
      this.streams.delete(entry.subscriptionId); this.host.changed(); this.host.emit({ ...this.publicStream(entry), clientId: entry.clientId, type: 'closed' }, entry.eventChannelId);
    }); return entry.stopping;
  }
  notification(method: string, params: JsonObject): boolean {
    if ((method === 'item/started' || method === 'item/completed') && params.item && typeof params.threadId === 'string') {
      const item = object(params.item); if (item.type === 'mcpToolCall' && typeof item.id === 'string' && typeof item.server === 'string') { if (this.origins.size >= 256) this.origins.delete(this.origins.keys().next().value!); this.origins.set(string(item.id, 'call id'), { threadId: params.threadId, server: string(item.server, 'server', 256) }); }
    }
    if (method !== 'mcpServer/event/stream/notification') return false;
    validateOfficial('McpServerEventStreamNotification', params); const entry = this.streams.get(string(params.subscriptionId, 'subscriptionId')); if (!entry || entry.revoked) return true;
    jsonBytes(params, 1024 * 1024); this.host.emit({ ...this.publicStream(entry), clientId: entry.clientId, type: 'event', notification: params.notification! }, entry.eventChannelId); return true;
  }
  async disconnect(clientId?: string, eventChannelId?: string): Promise<void> {
    const match = (entry: Owner): boolean => (clientId === undefined || entry.clientId === clientId) && (eventChannelId === undefined || entry.eventChannelId === eventChannelId);
    for (const entry of this.results.values()) if (match(entry)) { entry.revoked = true; if (!entry.pending) this.removeResult(entry); }
    const entries = [...this.streams.values()].filter(match); for (const entry of entries) entry.revoked = true;
    const results = await Promise.allSettled(entries.map(entry => this.stop(entry))); const failed = results.filter(result => result.status === 'rejected'); if (failed.length) throw new Error('MCP subscription cleanup was not confirmed');
  }
  reset(): void { for (const entry of this.results.values()) { entry.revoked = true; clearTimeout(entry.timer); } for (const entry of this.streams.values()) entry.revoked = true; this.results.clear(); this.resultBytes = 0; this.streams.clear(); this.origins.clear(); }
}
