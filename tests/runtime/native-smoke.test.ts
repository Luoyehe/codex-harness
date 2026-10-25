import { expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Ledger } from '../../src/core/ledger.js';
import { RuntimeService } from '../../src/runtime/service.js';
import { NativeRpc } from '../../src/runtime/native.js';
import { object, type RuntimeEvent } from '../../src/runtime/types.js';
import { nativeTestEnvironment } from '../fixtures/native-env.js';

test('official 0.164.0 isolated account, probes beyond cache capacity with verified process exit, and interactive PTY without inference', async () => {
  const bin = process.env.HARNESS_TEST_CODEX_BIN ?? path.resolve('reference/runtime/codex-0.164.0/package/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
  const root = path.resolve('.work/runtime-smoke'); mkdirSync(root, { recursive: true }); const workerHome = mkdtempSync(path.join(root, 'home-')); const home = path.join(workerHome, 'codex'); mkdirSync(home);
  const temporary = path.join(workerHome, 'tmp'); mkdirSync(temporary);
  const env = nativeTestEnvironment({ home: workerHome, codexHome: home, temporary });
  const version = execFileSync(bin, ['--version'], { env, encoding: 'utf8', windowsHide: true }); expect(version.trim()).toBe('codex-cli 0.164.0');
  const configText = 'check_for_update_on_startup = false\n'; writeFileSync(path.join(home, 'config.toml'), configText);
  const service = await RuntimeService.create({ bin, home, workerHome, cwd: workerHome, env, dev: true }); const events: RuntimeEvent[] = []; service.on('event', event => events.push(event));
  const stopped = new Set<NativeRpc>(); const originalClose = NativeRpc.prototype.close;
  const closeSpy = vi.spyOn(NativeRpc.prototype, 'close').mockImplementation(async function (this: NativeRpc) { await originalClose.call(this); if (this.processId !== undefined) { expect(() => process.kill(this.processId!, 0)).toThrow(); stopped.add(this); } });
  try {
    const account = object(await service.call('account/read', {}, { clientId: 'smoke' })); expect(account.account).toBeNull();
    const list = object(await service.call('thread/list', {}, { clientId: 'smoke' })); expect(list.data).toEqual([]);
    const baseline = await service.native.call('thread/loaded/list', {});
    const defaults = object(await service.call('defaults/read', { cwd: workerHome }, { clientId: 'smoke' })); expect(typeof defaults.model).toBe('string'); expect(typeof defaults.modelProvider).toBe('string');
    expect(await service.native.call('thread/loaded/list', {})).toEqual(baseline); expect(readFileSync(path.join(home, 'config.toml'), 'utf8')).toBe(configText);
    const cached = await service.call('defaults/read', { cwd: workerHome }, { clientId: 'smoke' }); expect(cached).toEqual(defaults);
    for (let index = 0; index < 17; index++) { const cwd = path.join(workerHome, `project-${index}`); mkdirSync(cwd); await service.call('defaults/read', { cwd }, { clientId: 'smoke' }); }
    await service.call('defaults/read', { cwd: workerHome }, { clientId: 'smoke' }); expect(stopped.size).toBeGreaterThanOrEqual(19);
    expect(await service.native.call('thread/loaded/list', {})).toEqual(baseline); expect(readFileSync(path.join(home, 'config.toml'), 'utf8')).toBe(configText);
    const started = object(await service.call('thread/start', { cwd: workerHome, options: { model: defaults.model! } }, { clientId: 'smoke' })); const threadId = object(started.thread).id!;
    expect(object(object(await service.call('thread/read', { threadId }, { clientId: 'smoke' })).thread).id).toBe(threadId);
    const history = object(await service.call('thread/history', { threadId }, { clientId: 'smoke' })); expect(history.turns).toEqual([]); expect(history.complete).toBe(true);
    const logoutId = randomUUID(); const ledger = new Ledger(path.join(workerHome, 'logout.sqlite'));
    try {
      expect(ledger.reserve(logoutId, 'account/logout', {}, 'runtime').receipt.state).toBe('pending');
      const beforeWrite = vi.fn(() => ledger.dispatch(logoutId));
      const result = await service.call('account/logout', {}, { clientId: 'smoke', operationId: logoutId, beforeWrite });
      expect(beforeWrite).toHaveBeenCalledTimes(1); expect(ledger.read(logoutId)?.state).toBe('dispatching');
      expect(ledger.settle(logoutId, { ok: true, value: result }).state).toBe('accepted');
    } finally { ledger.close(); }
    expect(object(await service.call('mcp/list', {}, { clientId: 'smoke' })).data).toEqual([]);
    const terminal = object(await service.call('terminal/open', { cwd: workerHome, rows: 24, cols: 80 }, { clientId: 'smoke' })); expect(typeof terminal.terminalId).toBe('string');
    await service.call('terminal/resize', { terminalId: terminal.terminalId!, rows: 30, cols: 100 }, { clientId: 'smoke' });
    const ended = new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('PTY did not exit')), 10000); const handler = (event: RuntimeEvent): void => { if (event.type === 'terminal' && object(event.data).terminalId === terminal.terminalId && object(event.data).type === 'exit') { clearTimeout(timeout); service.off('event', handler); resolve(); } }; service.on('event', handler); });
    await service.call('terminal/write', { terminalId: terminal.terminalId!, text: process.platform === 'win32' ? 'echo runtime-smoke-ok\r\nexit\r\n' : 'printf runtime-smoke-ok\\n\nexit\n' }, { clientId: 'smoke' }); await ended;
    const output = events.filter(event => event.type === 'terminal' && object(event.data).type === 'output').map(event => Buffer.from(String(object(event.data).deltaBase64), 'base64').toString('utf8')).join(''); expect(output).toContain('runtime-smoke-ok');
  } finally { await service.close(); closeSpy.mockRestore(); }
}, 60000);
