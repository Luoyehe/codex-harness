import { afterEach, expect, test } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { RuntimeService } from '../../src/runtime/service.js';
import type { NativeOptions, NativeRpc } from '../../src/runtime/native.js';
import { DeliveryError, object, type JsonValue } from '../../src/runtime/types.js';
class Native extends EventEmitter {
  connected = true; budget = {}; calls: { method: string; params: JsonValue }[] = []; status = 'disabled'; error?: DeliveryError; gate?: Promise<void>; gateMethod?: string; cwd = 'file:///remote/workspace';
  manualPairingCode: string | null | undefined = 'SECRET-MANUAL'; cursor: string | null | undefined = null; omitCwd = false; nullCwd = false; errorMethod?: string;
  async call(method: string, params: JsonValue, options: NativeOptions = {}): Promise<JsonValue> {
    options.beforeWrite?.(); this.calls.push({ method, params }); if (method === this.gateMethod) await this.gate; if (this.error && (!this.errorMethod || this.errorMethod === method)) throw this.error;
    if (method === 'environment/info') return { shell: { name: 'bash', path: '/bin/bash' }, ...(this.omitCwd ? {} : { cwd: this.nullCwd ? null : this.cwd }) };
    if (method === 'environment/status') return { status: 'ready' };
    if (method === 'remoteControl/enable') this.status = 'connected'; if (method === 'remoteControl/disable') this.status = 'disabled';
    if (['remoteControl/enable', 'remoteControl/disable', 'remoteControl/status/read'].includes(method)) return { status: this.status, serverName: 'fixture', installationId: 'installation', environmentId: this.status === 'disabled' ? null : 'native-remote' };
    if (method === 'remoteControl/pairing/start') return { pairingCode: 'secret-pair-code', ...(this.manualPairingCode === undefined ? {} : { manualPairingCode: this.manualPairingCode }), environmentId: 'native-remote', expiresAt: Math.floor(Date.now() / 1000) + 60 };
    if (method === 'remoteControl/pairing/status') return { claimed: false };
    if (method === 'remoteControl/client/list') return { data: [], ...(this.cursor === undefined ? {} : { nextCursor: this.cursor }) };
    if (method === 'thread/read' || method === 'thread/start') return { thread: { id: method === 'thread/read' ? object(params).threadId : 'thread', cwd: '/local', status: { type: 'idle' }, historyMode: 'paginated', turns: [] } };
    if (method === 'thread/turns/list') return { data: [], nextCursor: null, backwardsCursor: null };
    if (method === 'thread/timeline/list') return { data: [], nextCursor: null, activeRealtimeSessionAtPageStart: null };
    return {};
  }
  async close() { this.connected = false; }
}
const services: RuntimeService[] = []; const owner = { clientId: 'owner', eventChannelId: 'channel', beforeWrite: () => {} };
function setup(env: NodeJS.ProcessEnv = {}) {
  const parent = path.resolve('.work/remote-tests'); mkdirSync(parent, { recursive: true }); const home = mkdtempSync(path.join(parent, 'home-')); const native = new Native();
  const service = new RuntimeService({ bin: process.execPath, home, workerHome: home, cwd: home, env }, native as unknown as NativeRpc); services.push(service); return { service, native };
}
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });
const add = (service: RuntimeService) => service.call('environment/add', { name: 'Remote', execServerUrl: 'wss://executor.example.test/ws', authBearerToken: 'secret-executor-token', confirmRemoteExecution: true }, owner);
test('environment authorization is explicit and remote selection uses only an inspected registered root', async () => {
  const { service, native } = setup();
  await expect(service.call('environment/add', { name: 'Remote', execServerUrl: 'wss://example.test' }, owner)).rejects.toMatchObject({ code: 'confirmation_required' });
  for (const execServerUrl of ['ws://example.test', 'wss://user:password@example.test', 'wss://example.test/?token=secret']) await expect(service.call('environment/add', { name: 'Remote', execServerUrl, confirmRemoteExecution: true }, owner)).rejects.toMatchObject({ delivery: 'not_sent' });
  const added = object(await add(service)), environmentId = added.environmentId!;
  expect(added).toMatchObject({ registered: true, requiresRestartToDisconnect: true }); expect(JSON.stringify(await service.call('environment/list', {}, owner))).not.toContain('secret-executor-token');
  await expect(service.call('thread/start', { cwd: '/local', options: { environments: [environmentId] } }, owner)).rejects.toMatchObject({ code: 'environment_not_inspected' });
  await service.call('environment/info', { environmentId }, owner);
  await expect(service.call('thread/start', { cwd: '/local', options: { environments: [{ environmentId, cwd: '/arbitrary' }] } }, owner)).rejects.toMatchObject({ delivery: 'not_sent' });
  await service.call('thread/start', { cwd: '/local', options: { environments: [environmentId] } }, owner);
  expect(native.calls.at(-1)).toMatchObject({ method: 'thread/start', params: { cwd: '/local', environments: [{ environmentId, cwd: '/remote/workspace' }] } });
  await service.clientDisconnected('owner', 'channel'); expect(await service.call('environment/status', { environmentId }, owner)).toEqual({ status: 'ready' });
});
test('environment errors redact supplied credentials and unknown registration locks later writes', async () => {
  const { service, native } = setup(); native.error = new DeliveryError('lost', 'secret-executor-token failed', 'unknown');
  await expect(add(service)).rejects.toMatchObject({ code: 'lost', message: '[redacted] failed', delivery: 'unknown' });
  expect(object(object(service.status()).activity).unknown).toBe(true); native.error = undefined;
  await expect(add(service)).rejects.toMatchObject({ code: 'activity_unknown' }); expect(native.calls.filter(call => call.method === 'environment/add')).toHaveLength(1);
});
test('native remote access defaults ephemeral and pairing secrets stay owned and outside mutation identities', async () => {
  const { service, native } = setup(); await expect(service.call('remoteControl/enable', {}, owner)).rejects.toMatchObject({ code: 'confirmation_required' });
  await service.call('remoteControl/enable', { confirmExternalAccess: true }, owner); expect(native.calls.at(-1)).toMatchObject({ params: { ephemeral: true } });
  const pairing = object(await service.call('remoteControl/pairing/start', { manualCode: true }, owner)); expect(pairing).not.toHaveProperty('pairingCode');
  const params = { pairingId: pairing.pairingId! }; expect(await service.call('remoteControl/pairing/read', params, owner)).toMatchObject({ pairingCode: 'secret-pair-code', manualPairingCode: 'SECRET-MANUAL' });
  await expect(service.call('remoteControl/pairing/read', params, { ...owner, eventChannelId: 'other' })).rejects.toMatchObject({ code: 'not_found' });
  expect(await service.call('remoteControl/pairing/status', params, owner)).toEqual({ claimed: false });
  await expect(service.call('remoteControl/client/list', { environmentId: 'foreign' }, owner)).rejects.toMatchObject({ code: 'remote_environment_changed' });
  expect(await service.call('remoteControl/client/list', { environmentId: 'native-remote' }, owner)).toEqual({ data: [], nextCursor: null });
  await service.clientDisconnected('owner', 'channel'); await expect(service.call('remoteControl/pairing/read', params, owner)).rejects.toMatchObject({ code: 'not_found' }); expect(native.status).toBe('connected');
});
test('a pairing response arriving after owner loss is never retained for a replacement connection', async () => {
  const { service, native } = setup(); await service.call('remoteControl/enable', { confirmExternalAccess: true }, owner);
  let release!: () => void; let revoked = false; native.gateMethod = 'remoteControl/pairing/start'; native.gate = new Promise(resolve => { release = resolve; });
  const pending = service.call('remoteControl/pairing/start', {}, { ...owner, beforeWrite: () => { if (revoked) throw new DeliveryError('client_disconnected', 'revoked'); } });
  await expect.poll(() => native.calls.some(call => call.method === 'remoteControl/pairing/start')).toBe(true); revoked = true; await service.clientDisconnected('owner', 'channel'); release(); const pairing = object(await pending);
  await expect(service.call('remoteControl/pairing/read', { pairingId: pairing.pairingId! }, owner)).rejects.toMatchObject({ code: 'not_found' });
});
test('registered executors never silently widen new local threads or unloaded continuation/fork authority', async () => {
  const { service, native } = setup(); await add(service);
  await service.call('thread/start', { cwd: '/local' }, owner); expect(native.calls.at(-1)).toMatchObject({ params: { environments: [{ environmentId: 'local', cwd: '/local' }] } });
  await service.call('thread/history', { threadId: 'stored' }, owner);
  for (const method of ['thread/resume', 'thread/fork', 'thread/unarchive']) await expect(service.call(method, { threadId: 'stored' }, owner)).rejects.toMatchObject({ code: 'environment_selection_unknown', delivery: 'not_sent' });
  expect(native.calls.some(call => ['thread/resume', 'thread/fork', 'thread/unarchive'].includes(call.method))).toBe(false);
});

test.each([undefined, null])('pairing without manual code (%s) retains an owner-scoped handoff', async manual => {
  const { service, native } = setup(); native.status = 'connected'; native.manualPairingCode = manual;
  const pairing = object(await service.call('remoteControl/pairing/start', { manualCode: false }, owner));
  expect(pairing).not.toHaveProperty('pairingCode');
  const params = { pairingId: pairing.pairingId! };
  expect(await service.call('remoteControl/pairing/read', params, owner)).toMatchObject({ pairingCode: 'secret-pair-code' });
  await expect(service.call('remoteControl/pairing/read', params, { ...owner, clientId: 'other' })).rejects.toMatchObject({ code: 'not_found' });
  expect(object(object(service.status()).activity).unknown).toBe(false);
});

test.each(['redaction-capacity', 'manual-code-bound'])('a positive pairing reply followed by %s failure is unknown and blocks another dispatch', async failure => {
  const env = failure === 'redaction-capacity' ? Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`FIXTURE_TOKEN_${i}`, `isolated-fixture-sensitive-${i}`])) : {};
  const { service, native } = setup(env); native.status = 'connected';
  if (failure === 'manual-code-bound') native.manualPairingCode = 'x'.repeat(257);
  await expect(service.call('remoteControl/pairing/start', {}, owner)).rejects.toMatchObject({ code: 'configuration_acknowledgement', delivery: 'unknown' });
  expect(object(object(service.status()).activity).unknown).toBe(true);
  await expect(service.call('remoteControl/pairing/start', {}, owner)).rejects.toMatchObject({ code: 'activity_unknown' });
  expect(native.calls.filter(call => call.method === 'remoteControl/pairing/start')).toHaveLength(1);
});

test('actual native rejection and a revoked owner remain not_sent before any positive configuration reply', async () => {
  const { service, native } = setup(); native.status = 'connected'; native.errorMethod = 'remoteControl/pairing/start'; native.error = new DeliveryError('denied', 'Rejected by fixture');
  await expect(service.call('remoteControl/pairing/start', {}, owner)).rejects.toMatchObject({ code: 'denied', delivery: 'not_sent' });
  expect(object(object(service.status()).activity).unknown).toBe(false);
  native.error = undefined;
  await expect(service.call('remoteControl/pairing/start', {}, { ...owner, beforeWrite() { throw new DeliveryError('client_disconnected', 'Owner revoked'); } })).rejects.toMatchObject({ code: 'client_disconnected', delivery: 'not_sent' });
  expect(native.calls.filter(call => call.method === 'remoteControl/pairing/start')).toHaveLength(1);
  expect(object(object(service.status()).activity).unknown).toBe(false);
  await expect(service.call('remoteControl/pairing/start', {}, owner)).resolves.toHaveProperty('pairingId');
});

test.each([undefined, null])('remote client listing tolerates an absent nullable cursor (%s) and retains loop protection', async cursor => {
  const { service, native } = setup(); native.status = 'connected'; native.cursor = cursor;
  expect(await service.call('remoteControl/client/list', { environmentId: 'native-remote' }, owner)).toEqual({ data: [], nextCursor: null });
  native.cursor = 'repeat';
  await expect(service.call('remoteControl/client/list', { environmentId: 'native-remote', cursor: 'repeat' }, owner)).rejects.toMatchObject({ code: 'invalid_native_response' });
});

test.each(['omitted', 'null'])('a remote directory becoming %s clears its previous selection without blocking the runtime', async mode => {
  const { service, native } = setup(); const added = object(await add(service)), environmentId = added.environmentId!;
  await service.call('environment/info', { environmentId }, owner);
  native.omitCwd = mode === 'omitted'; native.nullCwd = mode === 'null';
  expect(await service.call('environment/info', { environmentId }, owner)).toMatchObject({ inspected: true, selectionReady: false });
  expect(await service.call('environment/read', { environmentId }, owner)).toMatchObject({ selectionReady: false });
  expect(object(object(service.status()).activity).unknown).toBe(false);
  await expect(service.call('thread/start', { cwd: '/local', options: { environments: [environmentId] } }, owner)).rejects.toMatchObject({ code: 'environment_not_inspected' });
  expect(native.calls.some(call => call.method === 'thread/start')).toBe(false);
});
