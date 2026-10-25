import { expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RuntimeService } from '../../src/runtime/service.js';
import { object, type JsonValue } from '../../src/runtime/types.js';
import { nativeTestEnvironment } from '../fixtures/native-env.js';

test('official pinned CLI discovers and calls isolated local MCP tools and resources without model inference', async () => {
  const parent = path.resolve('.work/mcp-native'); mkdirSync(parent, { recursive: true }); const workerHome = mkdtempSync(path.join(parent, 'home-')); const home = path.join(workerHome, 'codex'); const temp = path.join(workerHome, 'tmp'); mkdirSync(home); mkdirSync(temp);
  const env = nativeTestEnvironment({ home: workerHome, codexHome: home, temporary: temp });
  const log = path.join(workerHome, 'mcp.jsonl'); const bin = process.env.HARNESS_TEST_CODEX_BIN ?? path.resolve('reference/runtime/codex-0.164.0/package/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
  writeFileSync(path.join(home, 'config.toml'), ['check_for_update_on_startup = false', '[mcp_servers.local]', `command = ${JSON.stringify(process.execPath)}`, `args = ${JSON.stringify([path.resolve('tests/runtime/mcp-fixture.mjs'), log])}`, 'startup_timeout_sec = 10', 'tool_timeout_sec = 5'].join('\n'));
  const runtime = await RuntimeService.create({ bin, home, workerHome, cwd: workerHome, env, dev: true }); const context = { clientId: 'mcp-native', eventChannelId: 'test', beforeWrite: () => {} }; const pid = runtime.native.processId;
  try {
    const created = object(await runtime.call('thread/start', { cwd: workerHome }, context)); const threadId = object(created.thread).id!;
    await expect.poll(async () => { const page = object(await runtime.call('mcp/list', { threadId, serverName: 'local' }, context)); return object((page.data as JsonValue[])[0]).runtimeStatus; }, { timeout: 10000 }).toBe('connected');
    const page = object(await runtime.call('mcp/list', { threadId, serverName: 'local', detail: 'full' }, context)); const server = object((page.data as JsonValue[])[0]); expect(server.toolsError).toBeNull(); expect(Object.values(object(server.tools)).map(item => object(item).name)).toContain('echo');
    await expect(runtime.call('mcp/tool/call', { threadId, server: 'local', tool: 'echo', arguments: { message: 123 } }, context)).rejects.toMatchObject({ code: 'invalid_params', delivery: 'not_sent' });
    for (const fail of [false, true]) {
      const receipt = object(await runtime.call('mcp/tool/call', { threadId, server: 'local', tool: 'echo', arguments: { message: 'local MCP message', fail } }, context)); expect(receipt.isError).toBe(fail);
      const result = object(await runtime.call('mcp/result/read', { resultId: receipt.resultId! }, context)); expect(object(result.result).content).toEqual([{ type: 'text', text: 'local MCP message' }]);
      await runtime.call('mcp/result/remove', { resultId: receipt.resultId! }, context);
    }
    for (const uri of ['fixture://known', 'fixture://items/123']) expect(object(await runtime.call('mcp/resource/read', { threadId, server: 'local', uri }, context)).contents).toMatchObject([{ uri, text: 'Local resource: ' + uri }]);
    await expect(runtime.call('mcp/resource/read', { threadId, server: 'local', uri: 'file:///outside' }, context)).rejects.toMatchObject({ code: 'resource_not_discovered' });
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)); expect(calls.filter(call => call.method === 'tools/call')).toHaveLength(2);
  } finally {
    await runtime.close(); if (pid) expect(() => process.kill(pid, 0)).toThrow();
    const pids = new Set(readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line).pid as number)); for (const child of pids) expect(() => process.kill(child, 0)).toThrow();
  }
}, 30000);
