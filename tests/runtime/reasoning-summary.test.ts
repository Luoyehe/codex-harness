import { afterEach, expect, test } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { RuntimeService } from '../../src/runtime/service.js';
import type { NativeRpc, NativeOptions } from '../../src/runtime/native.js';
import { object, type JsonObject, type JsonValue, type RuntimeEvent } from '../../src/runtime/types.js';
import { validateOfficial } from '../../src/runtime/validation.js';
import { Ledger } from '../../src/core/ledger.js';
import { Dispatcher } from '../../src/gateway/dispatch.js';
import { applyNotification, checkedPage, mergeHistory } from '../../web/lib/history.js';
import type { Turn } from '../../web/lib/types.js';

const roots = path.resolve('.work/reasoning-summary-tests'); mkdirSync(roots, { recursive: true });
const context = { clientId: 'fixture-browser' };
const item = (summary: string[]): JsonObject => ({ id: 'reasoning', type: 'reasoning', summary, content: [] });
class Native extends EventEmitter {
  connected = true; budget = { pending: 0, retainedBytes: 0 };
  calls: { method: string; params: JsonObject }[] = []; history: JsonValue[] = [];
  async call(method: string, input: JsonValue, options: NativeOptions = {}): Promise<JsonValue> {
    options.beforeWrite?.(); const params = object(input); this.calls.push({ method, params });
    if (method === 'thread/read' || method === 'thread/start')
      return { thread: { id: params.threadId ?? 'created', status: { type: 'idle' }, historyMode: 'paginated', turns: [] } };
    if (method === 'thread/turns/list') return { data: this.history, nextCursor: null, backwardsCursor: null };
    if (method === 'thread/timeline/list') return { data: [], nextCursor: null, activeRealtimeSessionAtPageStart: null };
    if (method === 'turn/start') return { turn: { id: 'turn', status: 'inProgress', items: [] } };
    throw new Error('Unexpected offline native method: ' + method);
  }
  async close(): Promise<void> { this.connected = false; }
}
const services: RuntimeService[] = [], ledgers: Ledger[] = [];
function setup() {
  const cwd = mkdtempSync(path.join(roots, 'home-')), native = new Native();
  const service = new RuntimeService({ bin: process.execPath, home: cwd, workerHome: cwd, cwd, env: {} }, native as unknown as NativeRpc);
  services.push(service);
  return { cwd, native, service };
}
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  for (const ledger of ledgers.splice(0)) ledger.close();
});

test('official summary notifications pass through runtime and gateway to the web reducer without filtering or inference', () => {
  const { service, native } = setup(), ledger = new Ledger(':memory:'); ledgers.push(ledger);
  const dispatcher = new Dispatcher(ledger, { connected: true, call: service.call.bind(service) }, { call: async () => { throw new Error('No management call expected'); } });
  const forwarded: RuntimeEvent[] = []; let turns: Turn[] = [];
  service.on('event', event => dispatcher.event(event));
  dispatcher.on('event', (event: RuntimeEvent) => {
    if (event.type !== 'notification') return;
    forwarded.push(event);
    const data = object(event.data);
    turns = applyNotification(turns, String(data.method), object(data.params)).turns;
  });
  const send = (method: string, params: JsonObject, schema: string) => {
    validateOfficial(schema, params);
    native.emit('notification', { method, params });
    expect(forwarded.at(-1)).toEqual({ type: 'notification', data: { method, params } });
  };
  const identity = { threadId: 'thread', turnId: 'turn' };
  send('item/started', { ...identity, item: item([]), startedAtMs: 1000 }, 'ItemStartedNotification');
  send('item/reasoning/summaryPartAdded', { ...identity, itemId: 'reasoning', summaryIndex: 0 }, 'ReasoningSummaryPartAddedNotification');
  send('item/reasoning/summaryTextDelta', { ...identity, itemId: 'reasoning', summaryIndex: 0, delta: 'Public ' }, 'ReasoningSummaryTextDeltaNotification');
  send('item/reasoning/summaryPartAdded', { ...identity, itemId: 'reasoning', summaryIndex: 0 }, 'ReasoningSummaryPartAddedNotification');
  send('item/reasoning/summaryTextDelta', { ...identity, itemId: 'reasoning', summaryIndex: 0, delta: 'summary' }, 'ReasoningSummaryTextDeltaNotification');
  expect(turns[0]?.items[0]).toMatchObject({ summary: ['Public summary'], content: [] });
  send('item/completed', { ...identity, item: item(['Public summary']), completedAtMs: 2000 }, 'ItemCompletedNotification');
  expect(turns[0]?.items[0]).toMatchObject({ summary: ['Public summary'], streamComplete: true });
  expect(native.calls).toEqual([]);
});

test('full native history preserves the official public summary without converting raw reasoning content into it', async () => {
  const { service, native } = setup();
  const publicItem = item(['Historical public summary']); validateOfficial('ThreadItem', publicItem);
  const noSummary: JsonObject = { ...item([]), id: 'no-summary', content: ['fixture raw content is not a summary'] };
  validateOfficial('ThreadItem', noSummary);
  native.history = [{ id: 'turn', status: 'completed', itemsView: 'full', items: [publicItem, noSummary] }];
  const result = checkedPage(await service.call('thread/history', { threadId: 'thread' }, context), new Set());
  expect(result.complete).toBe(true);
  const turns = mergeHistory([], result.turns, new Set());
  expect(turns[0]?.items[0]?.summary).toEqual(['Historical public summary']);
  expect(turns[0]?.items[1]?.summary).toEqual([]);
  expect(turns[0]?.items[1]?.content).toEqual(['fixture raw content is not a summary']);
  expect(native.calls.map(call => call.method)).toEqual(['thread/read', 'thread/turns/list', 'thread/timeline/list']);
});

test('omitting summary preserves native defaults and explicit none reaches thread and turn options unchanged', async () => {
  const { service, native, cwd } = setup();
  validateOfficial('ReasoningSummary', 'none');
  await service.call('thread/start', { cwd }, context);
  const defaultStart = native.calls.find(call => call.method === 'thread/start')!.params;
  expect(defaultStart.summary).toBeUndefined();
  expect(defaultStart.config).toBeUndefined();
  await service.call('thread/start', { cwd, options: { summary: 'none' } }, context);
  expect(native.calls.filter(call => call.method === 'thread/start')[1]!.params.config).toEqual({ model_reasoning_summary: 'none' });
  await service.call('turn/start', { threadId: 'created', text: 'offline fixture input', options: { summary: 'none' } }, context);
  expect(native.calls.find(call => call.method === 'turn/start')!.params.summary).toBe('none');
  expect(JSON.stringify(native.calls)).not.toContain('detailed');
});
