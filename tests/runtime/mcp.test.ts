import { afterEach, expect, test } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { RuntimeService } from '../../src/runtime/service.js';
import type { NativeRpc, NativeOptions } from '../../src/runtime/native.js';
import { DeliveryError, object, type JsonObject, type JsonValue, type RuntimeEvent } from '../../src/runtime/types.js';

const parent = path.resolve('.work/mcp-tests'); mkdirSync(parent, { recursive: true });
const context = { clientId: 'owner', eventChannelId: 'channel', beforeWrite: () => {} };
const descriptor = (): JsonObject => ({ name: 'echo', inputSchema: { type: 'object', properties: { message: { type: 'string', maxLength: 64 } }, required: ['message'], additionalProperties: false } });
const catalog = (): JsonObject => ({ name: 'local', runtimeStatus: 'connected', pluginId: null, httpOrigin: null, serverInfo: null, serverCapabilities: {}, toolListMeta: null, tools: { echo: descriptor() }, toolsError: null, resources: [{ name: 'known', uri: 'fixture://known' }], resourceTemplates: [{ name: 'items', uriTemplate: 'fixture://items/{id}' }], authStatus: 'unsupported' });
class Native extends EventEmitter {
  connected = true; budget = {}; calls: { method: string; params: JsonValue }[] = []; server = catalog(); active = false; stopError = false; hook?: (method: string) => void; gate?: Promise<void>; gateMethod?: string; responseGate?: Promise<void>; responseGateMethod?: string; toolResult: JsonValue = { content: [{ type: 'text', text: 'private result' }], isError: true };
  async call(method: string, params: JsonValue, options: NativeOptions = {}): Promise<JsonValue> {
    if (method === this.gateMethod) await this.gate; this.hook?.(method); options.beforeWrite?.(); this.calls.push({ method, params });
    if (method === this.responseGateMethod) await this.responseGate;
    if (method === 'thread/start' || method === 'thread/read') return { thread: { id: 'thread', historyMode: 'paginated', status: this.active ? { type: 'active' } : { type: 'idle' }, turns: [] } };
    if (method === 'mcpServerStatus/list') return { data: [this.server], nextCursor: null };
    if (method === 'mcpServer/tool/call') return this.toolResult;
    if (method === 'mcpServer/resource/read') return { contents: [{ uri: object(params).uri!, text: 'resource body' }], originCallId: object(params).originCallId ?? null };
    if (method === 'mcpServer/event/stream/stop' && this.stopError) throw new DeliveryError('lost', 'stop acknowledgement lost', 'unknown');
    return {};
  }
  async close() { this.connected = false; }
}
const services: RuntimeService[] = [];
async function setup() {
  const cwd = mkdtempSync(path.join(parent, 'home-')); const native = new Native(); const service = new RuntimeService({ bin: process.execPath, home: cwd, workerHome: cwd, cwd, env: {} }, native as unknown as NativeRpc); services.push(service);
  const events: RuntimeEvent[] = []; service.on('event', event => events.push(event)); await service.call('thread/start', { cwd }, context); return { native, service, events };
}
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });
const toolParams = { threadId: 'thread', server: 'local', tool: 'echo', arguments: { message: 'hello' } };
const streamParams = { threadId: 'thread', server: 'local', name: 'watch', arguments: {} };

test('fresh tool discovery validates arguments, retains native isError, and separates receipt identity from owner-only result', async () => {
  const { native, service } = await setup();
  await expect(service.call('mcp/tool/call', { ...toolParams, arguments: { message: 1 } }, context)).rejects.toMatchObject({ code: 'invalid_params', delivery: 'not_sent' });
  expect(native.calls.some(call => call.method === 'mcpServer/tool/call')).toBe(false);
  const receipt = object(await service.call('mcp/tool/call', toolParams, context)); expect(receipt).toMatchObject({ threadId: 'thread', server: 'local', tool: 'echo', isError: true }); expect(receipt).not.toHaveProperty('content');
  const result = await service.call('mcp/result/read', { resultId: receipt.resultId! }, context); expect(object(result).result).toEqual(native.toolResult);
  for (const owner of [{ ...context, clientId: 'other' }, { ...context, eventChannelId: 'other' }]) await expect(service.call('mcp/result/read', { resultId: receipt.resultId! }, owner)).rejects.toMatchObject({ code: 'not_found' });
  object(native.server.tools).echo = { ...descriptor(), inputSchema: { type: 'object', required: ['newField'] } };
  await expect(service.call('mcp/tool/call', toolParams, context)).rejects.toMatchObject({ code: 'invalid_params' });
  expect(native.calls.filter(call => call.method === 'mcpServerStatus/list')).toHaveLength(3);
  await service.call('mcp/result/remove', { resultId: receipt.resultId! }, context); await expect(service.call('mcp/result/read', { resultId: receipt.resultId! }, context)).rejects.toMatchObject({ code: 'not_found' });
});
test('MCP never resumes unloaded threads and rechecks owner plus active work after asynchronous discovery', async () => {
  const { native, service } = await setup(); await expect(service.call('mcp/tool/call', { ...toolParams, threadId: 'unloaded' }, context)).rejects.toMatchObject({ code: 'session_not_loaded' });
  await expect(service.call('mcp/tool/call', toolParams, { ...context, beforeWrite: () => { throw new DeliveryError('client_disconnected', 'revoked'); } })).rejects.toMatchObject({ code: 'client_disconnected' });
  native.hook = method => { if (method === 'mcpServer/tool/call') native.emit('notification', { method: 'turn/started', params: { threadId: 'thread', turn: { id: 'active', status: 'inProgress' } } }); };
  await expect(service.call('mcp/tool/call', toolParams, context)).rejects.toMatchObject({ code: 'history_incomplete' });
  expect(native.calls.some(call => call.method === 'thread/resume' || call.method === 'mcpServer/tool/call')).toBe(false);
});
test('resources must match fresh discovered URIs, templates or an observed native origin in this thread/server', async () => {
  const { native, service } = await setup();
  await expect(service.call('mcp/resource/read', { threadId: 'thread', server: 'local', uri: 'file:///secret' }, context)).rejects.toMatchObject({ code: 'resource_not_discovered' });
  expect(await service.call('mcp/resource/read', { threadId: 'thread', server: 'local', uri: 'fixture://items/123' }, context)).toMatchObject({ contents: [{ uri: 'fixture://items/123' }] });
  native.emit('notification', { method: 'item/completed', params: { threadId: 'thread', item: { id: 'call', type: 'mcpToolCall', server: 'local' } } });
  expect(await service.call('mcp/resource/read', { threadId: 'thread', server: 'local', uri: 'ui://tool-output', originCallId: 'call' }, context)).toMatchObject({ originCallId: 'call' });
  await expect(service.call('mcp/resource/read', { threadId: 'thread', server: 'local', uri: 'ui://tool-output', originCallId: 'forged' }, context)).rejects.toMatchObject({ code: 'invalid_params' });
});
test('subscriptions route to their exact connection, block configuration, and disconnect waits for stop', async () => {
  const { native, service, events } = await setup(); const stream = object(await service.call('mcp/stream/start', streamParams, context));
  expect(object(object(service.status()).activity).subscriptions).toBe(1);
  await expect(service.call('mcp/reload', {}, context)).rejects.toMatchObject({ code: 'activity_busy' });
  await expect(service.call('mcp/stream/stop', { subscriptionId: stream.subscriptionId! }, { ...context, eventChannelId: 'other' })).rejects.toMatchObject({ code: 'not_found' });
  expect(await service.call('mcp/stream/list', {}, { ...context, clientId: 'other' })).toEqual({ data: [] });
  native.emit('notification', { method: 'mcpServer/event/stream/notification', params: { subscriptionId: stream.subscriptionId!, notification: { method: 'changed', params: { private: true } } } });
  expect(events.filter(event => event.type === 'mcp')).toMatchObject([{ eventChannelId: 'channel', data: { clientId: 'owner', type: 'event', subscriptionId: stream.subscriptionId } }]);
  let release!: () => void; native.gateMethod = 'mcpServer/event/stream/stop'; native.gate = new Promise(resolve => { release = resolve; }); let done = false;
  const pending = service.clientDisconnected(context.clientId, context.eventChannelId).then(() => { done = true; }); await new Promise(resolve => setTimeout(resolve, 10)); expect(done).toBe(false);
  native.emit('notification', { method: 'mcpServer/event/stream/notification', params: { subscriptionId: stream.subscriptionId!, notification: { method: 'late', params: {} } } }); expect(events.filter(event => event.type === 'mcp')).toHaveLength(1);
  release(); await pending; expect(object(object(service.status()).activity).subscriptions).toBe(0);
  await service.call('mcp/reload', {}, context); expect(native.calls.at(-1)?.method).toBe('config/mcpServer/reload');
});
test('unconfirmed subscription stop closes the native process before reporting cleanup complete', async () => {
  const { native, service } = await setup(); await service.call('mcp/stream/start', streamParams, context); native.stopError = true;
  await service.gatewayDisconnected(context.eventChannelId); expect(native.connected).toBe(false); expect(object(object(service.status()).activity).unknown).toBe(true);
});
test('disconnect before stream dispatch removes reservation and prevents a late stream from starting', async () => {
  const { native, service } = await setup(); let release!: () => void; native.gateMethod = 'mcpServerStatus/list'; native.gate = new Promise(resolve => { release = resolve; });
  const pending = service.call('mcp/stream/start', streamParams, context); const rejected = expect(pending).rejects.toMatchObject({ code: 'client_disconnected', delivery: 'not_sent' });
  await expect.poll(() => object(object(service.status()).activity).subscriptions).toBe(1); const disconnected = service.clientDisconnected(context.clientId, context.eventChannelId); release(); await rejected; await disconnected;
  expect(native.calls.some(call => call.method === 'mcpServer/event/stream/start')).toBe(false); expect(object(object(service.status()).activity).subscriptions).toBe(0);
});
test('owner loss before tool dispatch prevents transmission', async () => {
  const { native, service } = await setup(); let release!: () => void; native.gateMethod = 'mcpServer/tool/call'; native.gate = new Promise(resolve => { release = resolve; });
  const pending = service.call('mcp/tool/call', toolParams, context); const rejected = expect(pending).rejects.toMatchObject({ code: 'client_disconnected' });
  await expect.poll(() => native.calls.some(call => call.method === 'mcpServerStatus/list')).toBe(true); await service.clientDisconnected(context.clientId, context.eventChannelId); release(); await rejected;
  expect(native.calls.some(call => call.method === 'mcpServer/tool/call')).toBe(false);
});
test('disconnect waits for an in-flight subscription start before stopping its registered identity', async () => {
  const { native, service } = await setup(); let release!: () => void; native.responseGateMethod = 'mcpServer/event/stream/start'; native.responseGate = new Promise(resolve => { release = resolve; });
  const starting = service.call('mcp/stream/start', streamParams, context); await expect.poll(() => native.calls.some(call => call.method === 'mcpServer/event/stream/start')).toBe(true);
  let finished = false; const disconnected = service.clientDisconnected(context.clientId, context.eventChannelId).then(() => { finished = true; }); await new Promise(resolve => setTimeout(resolve, 10));
  expect(finished).toBe(false); expect(native.calls.some(call => call.method === 'mcpServer/event/stream/stop')).toBe(false);
  release(); const result = object(await starting); await disconnected;
  expect(native.calls.filter(call => call.method === 'mcpServer/event/stream/stop')).toEqual([{ method: 'mcpServer/event/stream/stop', params: { subscriptionId: result.subscriptionId } }]);
});
test('a completed tool result is discarded after owner loss while its response was in flight', async () => {
  const { native, service } = await setup(); let release!: () => void; native.responseGateMethod = 'mcpServer/tool/call'; native.responseGate = new Promise(resolve => { release = resolve; });
  const calling = service.call('mcp/tool/call', toolParams, context); await expect.poll(() => native.calls.some(call => call.method === 'mcpServer/tool/call')).toBe(true);
  await service.clientDisconnected(context.clientId, context.eventChannelId); release(); const result = object(await calling);
  await expect(service.call('mcp/result/read', { resultId: result.resultId! }, context)).rejects.toMatchObject({ code: 'not_found' }); expect(native.calls.filter(call => call.method === 'mcpServer/tool/call')).toHaveLength(1);
});
