import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { NativeRpc } from '../../src/runtime/native.js';
import { DeliveryError } from '../../src/runtime/types.js';
import { validateOfficial } from '../../src/runtime/validation.js';

const roots = path.resolve('.work/runtime-tests'); mkdirSync(roots, { recursive: true });
const natives: NativeRpc[] = [];
async function native(): Promise<NativeRpc> { const cwd = mkdtempSync(path.join(roots, 'native-')); const rpc = new NativeRpc({ bin: process.execPath, args: [path.resolve('tests/runtime/native-fixture.mjs')], home: cwd, cwd, env: {}, requestTimeoutMs: 2000 }); natives.push(rpc); await rpc.initialize(); return rpc; }
afterEach(async () => { await Promise.all(natives.splice(0).map(rpc => rpc.close())); });
describe('bounded native delivery', () => {
  test('initialization requests explicit gateway authorization under the pinned schema', async () => {
    const rpc = await native(), initialization = await rpc.call('fixture/initialize/read', {});
    validateOfficial('InitializeParams', initialization); expect(initialization).toMatchObject({ capabilities: { experimentalApi: true, requestAttestation: false, explicitGatewayOauth: true } });
  });
  test('validates keys and nested Unicode before any write and keeps the connection usable', async () => {
    const rpc = await native(); let writes = 0;
    await expect(rpc.call('echo', { ['bad\ud800']: 'x' }, { beforeWrite: () => writes++ })).rejects.toMatchObject({ delivery: 'not_sent', code: 'invalid_unicode' });
    await expect(rpc.call('echo', { nested: ['\udfff'] })).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(writes).toBe(0); await expect(rpc.call('echo', { emoji: '🙂' })).resolves.toEqual({ emoji: '🙂' }); expect(rpc.budget.pending).toBe(0);
  });
  test('beforeWrite rejection is not_sent and does not reject unrelated requests', async () => {
    const rpc = await native();
    await expect(rpc.call('echo', {}, { beforeWrite: () => { throw new DeliveryError('thread_busy', 'busy'); } })).rejects.toMatchObject({ delivery: 'not_sent', code: 'thread_busy' });
    await expect(rpc.call('echo', {}, { beforeWrite: () => { throw new Error('storage unavailable'); } })).rejects.toMatchObject({ delivery: 'not_sent' });
    await expect(rpc.call('echo', { okay: true })).resolves.toEqual({ okay: true });
  });
  test('timeout after write is unknown and fails the epoch without replay', async () => {
    const rpc = await native(); let writes = 0;
    await expect(rpc.call('hold', {}, { timeoutMs: 20, beforeWrite: () => writes++ })).rejects.toMatchObject({ delivery: 'unknown' });
    expect(writes).toBe(1); expect(rpc.connected).toBe(false);
    await expect(rpc.call('echo', {})).rejects.toMatchObject({ delivery: 'not_sent' });
    await rpc.close(); expect(rpc.budget.retainedBytes).toBe(0);
  });
  test('queued timeout under actual pipe backpressure is not_sent and retains sent work budget', async () => {
    const rpc = await native(); await rpc.call('pause', {});
    const large = rpc.call('hold', { text: 'x'.repeat(10 * 1024 * 1024) }, { timeoutMs: 3000 }); const caught = large.catch(error => error);
    await expect(rpc.call('echo', {}, { timeoutMs: 30 })).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(rpc.budget.retainedBytes).toBeGreaterThan(10 * 1024 * 1024); expect(rpc.connected).toBe(true);
    await rpc.close(); expect(await caught).toMatchObject({ delivery: 'unknown' }); expect(rpc.budget.retainedBytes).toBe(0);
  });
  test('preserves upstream error code/data and server request id type', async () => {
    const rpc = await native(); await expect(rpc.call('error', {})).rejects.toMatchObject({ code: 'native_error', delivery: 'not_sent', data: { code: -32000, data: { kind: 'fixture' } } });
    let id: unknown; rpc.on('request', request => { id = request.id; }); await rpc.call('prompt', {}); expect(id).toBe('original-string-id');
  });
  test('malformed native responses reject all waiters instead of hanging or claiming not_sent', async () => {
    const rpc = await native(); await expect(rpc.call('malformed', {})).rejects.toMatchObject({ delivery: 'unknown' }); expect(rpc.connected).toBe(false);
  });
});
