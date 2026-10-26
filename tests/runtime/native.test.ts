import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { NativeRpc } from '../../src/runtime/native.js';
import { DeliveryError } from '../../src/runtime/types.js';
import { validateOfficial } from '../../src/runtime/validation.js';
import * as nativeLaunch from '../../src/runtime/native-launch.js';

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
  test.runIf(process.platform === 'linux').each([true, false])('launcher shutdown closes saturated stdin and requires cleanup acknowledgement (%s)', async confirmed => {
    const cwd = mkdtempSync(path.join(roots, 'launcher-'));
    const python = process.env.HARNESS_TEST_PYTHON ?? '/usr/bin/python3';
    const driver = [
      'from deploy import native_launcher as n',
      'import os,signal,sys,threading',
      'n.security_process()',
      // A failed assertion must not strand the isolated fixture tree.
      'watchdog=threading.Timer(12,lambda:os.kill(os.getpid(),signal.SIGTERM)); watchdog.daemon=True; watchdog.start()',
      ...(confirmed ? [] : ['original=n.clean_children', 'n.clean_children=lambda child,deadline:(original(child,deadline) and False)']),
      "raise SystemExit(n.supervise([sys.argv[1],sys.argv[2]],{'PATH':'/usr/bin:/bin'},sys.argv[3],streaming=True))",
    ].join('\n');
    let bin = python, args = ['-c', driver, process.execPath, path.resolve('tests/runtime/native-fixture.mjs'), cwd];
    if (process.getuid?.() === 0) { bin = '/usr/bin/setpriv'; args = ['--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', python, ...args]; }
    // Substitute only fixed-launcher selection: the Node socket, Python bridge,
    // kernel backpressure and native child are real. UID policy has separate tests.
    const command = vi.spyOn(nativeLaunch, 'nativeCommand').mockReturnValue({ bin, args, cwd: path.resolve('.'), env: { PATH: '/usr/bin:/bin', PYTHONPATH: path.resolve('.') } });
    const rpc = new NativeRpc({ bin: '/unused', home: cwd, cwd, env: {}, launcher: { path: '/unused', user: 'ch-fixture-worker' } });
    let fatal = 0, cleanupUnknown = 0, written = false;
    rpc.on('fatal', () => fatal++); rpc.on('cleanup-unknown', () => cleanupUnknown++);
    try {
      await rpc.initialize(); await rpc.call('pause', {});
      const sent = rpc.call('hold', { text: 'x'.repeat(10 * 1024 * 1024) }, { timeoutMs: 0, onWritten: () => { written = true; } }).catch(error => error);
      const queued = rpc.call('echo', {}, { timeoutMs: 0 }).catch(error => error);
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(written).toBe(false); expect(rpc.budget.pending).toBe(2); expect(rpc.connected).toBe(true);
      const closed = rpc.close(); expect(rpc.close()).toBe(closed);
      expect(await sent).toMatchObject({ delivery: 'unknown' }); expect(await queued).toMatchObject({ delivery: 'not_sent' });
      if (confirmed) await closed;
      else await expect(closed).rejects.toThrow('without confirming cleanup');
      expect(fatal).toBe(1); expect(cleanupUnknown).toBe(confirmed ? 0 : 1);
      expect(written).toBe(false); expect(rpc.budget).toEqual({ pending: 0, retainedBytes: 0 });
      expect(() => process.kill(rpc.processId!, 0)).toThrow();
    } finally { command.mockRestore(); await rpc.close().catch(() => {}); }
  }, 15000);
  test('preserves upstream error code/data and server request id type', async () => {
    const rpc = await native(); await expect(rpc.call('error', {})).rejects.toMatchObject({ code: 'native_error', delivery: 'not_sent', data: { code: -32000, data: { kind: 'fixture' } } });
    let id: unknown; rpc.on('request', request => { id = request.id; }); await rpc.call('prompt', {}); expect(id).toBe('original-string-id');
  });
  test('malformed native responses reject all waiters instead of hanging or claiming not_sent', async () => {
    const rpc = await native(); await expect(rpc.call('malformed', {})).rejects.toMatchObject({ delivery: 'unknown' }); expect(rpc.connected).toBe(false);
  });
});
