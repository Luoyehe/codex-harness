import { expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RuntimeService } from '../../src/runtime/service.js';
import { object, type RuntimeEvent } from '../../src/runtime/types.js';
import { receiptResult } from '../../src/gateway/receipt-result.js';
test('fixed CLI doctor and bundled catalog diagnostics use private results and end after independent process cleanup', async () => {
  const base = path.resolve('.work/cli-diagnostics-native'); mkdirSync(base, { recursive: true }); const root = mkdtempSync(path.join(base, 'home-')), home = path.join(root, 'codex'), tmp = path.join(root, 'tmp'); mkdirSync(home); mkdirSync(tmp); writeFileSync(path.join(home, 'config.toml'), 'check_for_update_on_startup=false\n');
  const env: NodeJS.ProcessEnv = { HOME: root, USERPROFILE: root, CODEX_HOME: home, TEMP: tmp, TMP: tmp, HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9' }; for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC']) if (process.env[key]) env[key] = process.env[key];
  const runtime = await RuntimeService.create({ bin: process.env.HARNESS_TEST_CODEX_BIN!, home, workerHome: root, cwd: root, env, dev: true }), context = { clientId: 'diagnostics', eventChannelId: 'channel', beforeWrite: () => {} }, events: RuntimeEvent[] = []; runtime.on('event', event => events.push(event));
  try {
    for (const kind of ['doctor', 'models-bundled']) {
      const result = object(await runtime.call('diagnostics/cli/run', { kind }, context)); expect(result).toMatchObject({ kind, status: 'completed' }); expect(Object.keys(result).sort()).toEqual(['kind', 'resultId', 'status']);
      const read = object(await runtime.call('diagnostics/cli/result/read', { resultId: result.resultId! }, context)); expect(read.status).toBe('completed');
      if (kind === 'doctor') { expect(object(read.data)).toMatchObject({ schemaVersion: 1, codexVersion: '0.164.0' }); expect(read.exitCode).toBe(1); }
      else { expect(read.exitCode).toBe(0); expect(object(read.data).models).toBeInstanceOf(Array); }
      expect(receiptResult('diagnostics/cli/run', read)).toEqual(result);
      await expect(runtime.call('diagnostics/cli/result/read', { resultId: result.resultId! }, { ...context, clientId: 'other' })).rejects.toMatchObject({ code: 'not_found' });
      expect(object(object(runtime.status()).activity)).toMatchObject({ pendingStarts: 0, processes: 0, unknown: false });
    }
    expect(events.every(event => event.type === 'state' || event.type === 'notification')).toBe(true);
    await expect(runtime.call('diagnostics/cli/run', { kind: 'models-current' }, context)).rejects.toMatchObject({ code: 'invalid_params' });
  } finally { await runtime.close(); }
}, 45000);
