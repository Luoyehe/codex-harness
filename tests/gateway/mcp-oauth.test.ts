import { afterEach, expect, test } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Ledger } from '../../src/core/ledger.js';
import { Dispatcher } from '../../src/gateway/dispatch.js';
import { RuntimeService } from '../../src/runtime/service.js';
import { DeliveryError, object, type JsonObject, type JsonValue, type RuntimeEvent } from '../../src/runtime/types.js';
import { HarnessError } from '../../src/core/errors.js';
import type { NativeRpc, NativeOptions } from '../../src/runtime/native.js';
import type { WorkerPort } from '../../src/core/contracts.js';

const url = 'https://auth.example/authorize?state=PRIVATE-STATE&code_challenge=PRIVATE-CHALLENGE';
const roots = resolve('.work/mcp-oauth-tests'); mkdirSync(roots, { recursive: true });
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const finish of cleanup.splice(0).reverse()) await finish(); });
class Native extends EventEmitter {
  connected = true; budget = {}; calls = 0;
  response: JsonValue = { authorizationUrl: url, loginId: 'login' };
  async call(method: string, _params: JsonValue, options?: NativeOptions): Promise<JsonValue> { options?.beforeWrite?.(); if (method === 'mcpServer/oauth/login') { this.calls++; return this.response; } return {}; }
  async close() { this.connected = false; }
}
function setup(file?: string) {
  const cwd = mkdtempSync(join(roots, 'gateway-')), native = new Native();
  const service = new RuntimeService({ bin: process.execPath, home: cwd, workerHome: cwd, cwd, env: {} }, native as unknown as NativeRpc);
  cleanup.push(() => service.close());
  const ledger = new Ledger(file ?? join(cwd, 'journal.sqlite')); cleanup.push(() => ledger.close());
  const worker: WorkerPort = { connected: true, call: async (method, params, context) => {
    try { return await service.call(method, params, { ...context, eventChannelId: 'channel' }); }
    catch (e) { if (e instanceof DeliveryError) throw new HarnessError(e.code, e.message, e.delivery, e.data); throw e; }
  } };
  const dispatcher = new Dispatcher(ledger, worker, { call: async () => ({}) });
  const events: RuntimeEvent[] = []; service.on('event', event => events.push(event));
  const context = { clientId: 'owner', requireConnection: () => {} };
  return { native, service, ledger, dispatcher, context, cwd, events };
}
async function archive(f: ReturnType<typeof setup>) {
  const preview = object(await f.dispatcher.call({ method: 'operation/maintenance/preview', params: {} }, f.context));
  const chunk = object(await f.dispatcher.call({ method: 'operation/maintenance/chunk', params: { exportId: preview.exportId!, digest: preview.digest!, offset: 0 } }, f.context));
  return Buffer.from(String(chunk.base64), 'base64').toString();
}
test('actual runtime to gateway Ledger persistence, replay, operation read and export never retain OAuth URL', async () => {
  const f = setup(), operationId = randomUUID(), request = { method: 'mcp/oauth', params: { name: 'server', threadId: 'thread' }, operationId };
  const identity = object(await f.dispatcher.call(request, f.context));
  expect(identity).toEqual({ handoffId: expect.any(String), epoch: f.service.epoch, name: 'server', threadId: 'thread' });
  const handoff = await f.dispatcher.call({ method: 'mcp/oauth/handoff', params: { handoffId: identity.handoffId!, epoch: identity.epoch! } }, f.context);
  expect(handoff).toMatchObject({ authorizationUrl: url });
  expect(await f.dispatcher.call(request, f.context)).toEqual(identity); expect(f.native.calls).toBe(1);
  const read = await f.dispatcher.call({ method: 'operation/read', params: { operationId } }, f.context);
  expect(read).toMatchObject({ state: 'accepted', result: identity });
  const db = new DatabaseSync(join(f.cwd, 'journal.sqlite')); try { expect(JSON.stringify(db.prepare('SELECT * FROM receipts').all())).not.toContain('PRIVATE'); } finally { db.close(); }
  const reopened = new Ledger(join(f.cwd, 'journal.sqlite')); try { expect(reopened.read(operationId)?.result).toEqual(identity); } finally { reopened.close(); }
  expect(await archive(f)).not.toContain('PRIVATE');
  f.native.emit('notification', { method: 'mcpServer/oauthLogin/completed', params: { name: 'server', threadId: 'thread', loginId: 'login', success: true, error: url } });
  expect(f.events.at(-1)).toMatchObject({ type: 'mcp', eventChannelId: 'channel', data: { ...identity, type: 'oauth-completed', clientId: 'owner', success: true } });
  expect(JSON.stringify(f.events)).not.toContain('PRIVATE');
});
test.each(['client', 'gateway', 'native'] as const)('service %s disconnect revokes handoff without replaying a native login', async kind => {
  const f = setup(), identity = object(await f.dispatcher.call({ method: 'mcp/oauth', params: { name: 'server' }, operationId: randomUUID() }, f.context));
  if (kind === 'client') await f.service.clientDisconnected('owner', 'channel');
  if (kind === 'gateway') await f.service.gatewayDisconnected('channel');
  if (kind === 'native') f.native.emit('fatal');
  const request = { method: 'mcp/oauth/handoff', params: { handoffId: identity.handoffId!, epoch: identity.epoch! } };
  if (kind === 'native') await expect(f.dispatcher.call(request, f.context)).rejects.toMatchObject({ code: 'not_found' });
  else expect(await f.dispatcher.call(request, f.context)).toMatchObject({ unavailable: true, restartRequired: true });
  expect(f.native.calls).toBe(1);
});
test('historical accepted URL receipts are redacted on read, replay and new export while original database evidence remains', async () => {
  const f = setup(), id = randomUUID(), params = { name: 'server' };
  f.ledger.reserve(id, 'mcp/oauth', params, 'mcp/oauth'); f.ledger.dispatch(id); f.ledger.settle(id, { ok: true, value: {} });
  const db = new DatabaseSync(join(f.cwd, 'journal.sqlite'));
  try {
    db.prepare('UPDATE receipts SET result=? WHERE id=?').run(JSON.stringify({ authorizationUrl: url, ignored: { authorizationUrl: url } }), id);
    expect(f.ledger.read(id)).toMatchObject({ operationId: id, state: 'accepted', result: { handoffUnavailable: true } });
    expect(await f.dispatcher.call({ method: 'operation/read', params: { operationId: id } }, f.context)).toMatchObject({ state: 'accepted', result: { handoffUnavailable: true } });
    expect(await f.dispatcher.call({ method: 'mcp/oauth', params, operationId: id }, f.context)).toEqual({ handoffUnavailable: true });
    expect(await archive(f)).not.toContain('PRIVATE');
    expect(db.prepare('SELECT state,result FROM receipts WHERE id=?').get(id)).toEqual(expect.objectContaining({ state: 'accepted', result: expect.stringContaining(url) }));
    expect(f.native.calls).toBe(0);
  } finally { db.close(); }
});
test('legacy OAuth error bodies are hidden on public reads and exports without changing unknown state or the original row', async () => {
  const f = setup(), id = randomUUID();
  f.ledger.reserve(id, 'mcp/oauth', { name: 'server' }, 'global'); f.ledger.dispatch(id);
  f.ledger.settle(id, { ok: false, error: { code: 'lost', message: 'lost', delivery: 'unknown' } });
  const db = new DatabaseSync(join(f.cwd, 'journal.sqlite'));
  try {
    db.prepare('UPDATE receipts SET error=? WHERE id=?').run(JSON.stringify({ code: 'native', message: url, data: { authorizationUrl: url }, delivery: 'unknown' }), id);
    expect(JSON.stringify(f.ledger.read(id))).not.toContain('PRIVATE');
    expect(f.ledger.read(id)).toMatchObject({ state: 'unknown', error: { delivery: 'unknown' } });
    expect(await archive(f)).not.toContain('PRIVATE');
    expect(db.prepare('SELECT error FROM receipts WHERE id=?').get(id)?.error).toContain(url);
  } finally { db.close(); }
});
test('an owner guard that rejects before native dispatch stays not_sent and releases its reservation', async () => {
  const f = setup(), context = { clientId: 'owner', eventChannelId: 'channel', beforeWrite: () => { throw new DeliveryError('client_disconnected', 'owner closed'); } };
  await expect(f.service.call('mcp/oauth', { name: 'server' }, context)).rejects.toMatchObject({ code: 'client_disconnected', delivery: 'not_sent' });
  expect(f.native.calls).toBe(0);
  await expect(f.service.call('mcp/oauth', { name: 'server' }, { ...context, beforeWrite: () => {} })).resolves.toMatchObject({ name: 'server' });
});
test('real NativeRpc pipe and RuntimeService keep rejected owner guards not_sent, then complete one usable local OAuth handoff', async () => {
  const cwd = mkdtempSync(join(roots, 'pipe-'));
  const service = await RuntimeService.create({ bin: process.execPath, args: [resolve('tests/runtime/mcp-oauth-fixture.mjs')], home: cwd, workerHome: cwd, cwd, env: {}, requestTimeoutMs: 2000 });
  cleanup.push(() => service.close());
  const context = { clientId: 'owner', eventChannelId: 'channel', beforeWrite: () => { throw new Error('owner event connection closed before write'); } };
  await expect(service.call('mcp/oauth', { name: 'server' }, context)).rejects.toMatchObject({ code: 'before_write', delivery: 'not_sent' });
  expect(await service.native.call('fixture/oauth/count', {})).toEqual({ starts: 0 });
  const identity = object(await service.call('mcp/oauth', { name: 'server' }, { ...context, beforeWrite: () => {} }));
  const params = { handoffId: identity.handoffId!, epoch: identity.epoch! };
  expect(await service.call('mcp/oauth/handoff', params, context)).toMatchObject({ authorizationUrl: 'http://127.0.0.1:8888/authorize?state=PRIVATE-LOCAL-STATE', status: 'pending' });
  await service.native.call('fixture/oauth/complete', {});
  expect(await service.call('mcp/oauth/handoff', params, context)).toMatchObject({ status: 'completed', unavailable: true });
  expect(await service.native.call('fixture/oauth/count', {})).toEqual({ starts: 1 });
});
