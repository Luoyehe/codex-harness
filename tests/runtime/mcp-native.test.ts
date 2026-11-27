import { processIdentity, expectNativeClosed } from './process-identity.js';
import { expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NativeRpc } from '../../src/runtime/native.js';
import { RuntimeService } from '../../src/runtime/service.js';
import { object, type JsonValue } from '../../src/runtime/types.js';
import { nativeTestEnvironment } from '../fixtures/native-env.js';

test('official pinned CLI discovers and calls isolated local MCP tools and resources without model inference', async () => {
  const parent = path.resolve('.work/mcp-native'); mkdirSync(parent, { recursive: true }); const workerHome = mkdtempSync(path.join(parent, 'home-')); const home = path.join(workerHome, 'codex'); const temp = path.join(workerHome, 'tmp'); mkdirSync(home); mkdirSync(temp);
  const env = nativeTestEnvironment({ home: workerHome, codexHome: home, temporary: temp });
  const log = path.join(workerHome, 'mcp.jsonl'); const bin = process.env.HARNESS_TEST_CODEX_BIN ?? path.resolve('reference/runtime/codex-0.169.0/package/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
  writeFileSync(path.join(home, 'config.toml'), ['check_for_update_on_startup = false', '[mcp_servers.local]', `command = ${JSON.stringify(process.execPath)}`, `args = ${JSON.stringify([path.resolve('tests/runtime/mcp-fixture.mjs'), log])}`, 'startup_timeout_sec = 10', 'tool_timeout_sec = 45'].join('\n'));
  const runtime = await RuntimeService.create({ bin, home, workerHome, cwd: workerHome, env, dev: true }); const context = { clientId: 'mcp-native', eventChannelId: 'test', beforeWrite: () => {} }; let identities: { pid: number; identity: string | null }[] = [];
  try {
    const beforeProbe = existsSync(log) ? readFileSync(log, 'utf8') : '';
    await runtime.call('defaults/read', { cwd: workerHome }, context);
    expect(existsSync(log) ? readFileSync(log, 'utf8') : '').toBe(beforeProbe);
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
    const dispatch = vi.spyOn(runtime.native, 'call');
    const delayed = runtime.call('mcp/tool/call', { threadId, server: 'local', tool: 'echo', arguments: { message: 'delayed-fixture' } }, context);
    await expect.poll(() => readFileSync(log, 'utf8').split('"tools/call"').length, { timeout: 5000 }).toBe(4);
    const started = Date.now();
    expect(object(await runtime.call('thread/read', { threadId }, context)).thread).toMatchObject({ id: threadId });
    await expect(delayed).resolves.toMatchObject({ isError: false });
    expect(Date.now() - started).toBeGreaterThan(30000);
    expect(dispatch.mock.calls.find(([method]) => method === 'mcpServer/tool/call')?.[2]?.timeoutMs).toBe(65_000);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)); expect(calls.filter(call => call.method === 'tools/call')).toHaveLength(3);
    const pids = new Set(calls.map(call => call.pid as number)); identities = await Promise.all([...pids].map(async pid => ({ pid, identity: await processIdentity(pid) })));
  } finally {
    await runtime.close(); expectNativeClosed(runtime.native);
    for (const { pid, identity } of identities) if (identity !== null) expect(await processIdentity(pid)).not.toBe(identity);
  }
}, 70000);

test.each([[undefined, 320_000], [1, 21_000], [600, 620_000], [1801, null]] as const)(
  'official CLI uses the selected server timeout %s from effective config', async (seconds, expected) => {
    const parent = path.resolve('.work/mcp-native'); mkdirSync(parent, { recursive: true });
    const workerHome = mkdtempSync(path.join(parent, 'deadline-')), home = path.join(workerHome, 'codex');
    const env = nativeTestEnvironment({ home: workerHome, codexHome: home, temporary: path.join(workerHome, 'tmp') });
    const log = path.join(workerHome, 'tool.log');
    writeFileSync(path.join(home, 'config.toml'), [
      'check_for_update_on_startup = false', '[mcp_servers."fixture.with.dots"]',
      'command = ' + JSON.stringify(process.execPath),
      'args = ' + JSON.stringify([path.resolve('tests/runtime/mcp-fixture.mjs'), log]),
      ...(seconds === undefined ? [] : ['tool_timeout_sec = ' + seconds]),
    ].join('\n'));
    const service = await RuntimeService.create({ bin: process.env.HARNESS_TEST_CODEX_BIN!, home, workerHome, cwd: workerHome, env, dev: true });
    const context = { clientId: 'timeout-check', eventChannelId: 'test', beforeWrite: () => {} };
    try {
      const threadId = object(object(await service.call('thread/start', { cwd: workerHome }, context)).thread).id!;
      const server = 'fixture.with.dots';
      await expect.poll(async () => {
        const page = object(await service.call('mcp/list', { threadId, serverName: server }, context));
        return object((page.data as JsonValue[])[0]).runtimeStatus;
      }, { timeout: 10_000 }).toBe('connected');
      const dispatch = vi.spyOn(service.native, 'call');
      const call = service.call('mcp/tool/call', { threadId, server, tool: 'echo', arguments: { message: 'fixture' } }, context);
      if (expected === null) {
        await expect(call).rejects.toMatchObject({ code: 'mcp_timeout_limit', delivery: 'not_sent' });
        expect(dispatch.mock.calls.some(([method]) => method === 'mcpServer/tool/call')).toBe(false);
        expect(readFileSync(log, 'utf8')).not.toContain('"tools/call"');
      } else {
        await expect(call).resolves.toMatchObject({ isError: false });
        expect(dispatch.mock.calls.find(([method]) => method === 'mcpServer/tool/call')?.[2]?.timeoutMs).toBe(expected);
      }
    } finally { await service.close(); expectNativeClosed(service.native); }
  });
test('a defaults probe leaves a literal dotted MCP server dormant until the ordinary thread starts', async () => {
  const parent = path.resolve('.work/mcp-native'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'dotted-probe-')), home = path.join(root, 'codex');
  const env = nativeTestEnvironment({ home: root, codexHome: home, temporary: path.join(root, 'tmp') });
  const log = path.join(root, 'mcp.jsonl'), name = 'fixture.with.dots';
  writeFileSync(path.join(home, 'config.toml'), ['check_for_update_on_startup=false', '[mcp_servers."fixture.with.dots"]',
    'command=' + JSON.stringify(process.execPath), 'args=' + JSON.stringify([path.resolve('tests/runtime/mcp-fixture.mjs'), log])].join('\n'));
  const runtime = await RuntimeService.create({ bin: process.env.HARNESS_TEST_CODEX_BIN!, home, workerHome: root, cwd: root, env, dev: true });
  const context = { clientId: 'dotted-probe' };
  try {
    await runtime.call('defaults/read', { cwd: root }, context);
    expect(existsSync(log)).toBe(false);
    const result = object(await runtime.call('thread/start', { cwd: root }, context)), threadId = object(result.thread).id!;
    await expect.poll(async () => {
      const page = object(await runtime.call('mcp/list', { threadId, serverName: name }, context));
      return object((page.data as JsonValue[])[0]).runtimeStatus;
    }, { timeout: 10000 }).toBe('connected');
    expect(readFileSync(log, 'utf8')).toContain('"initialize"');
  } finally { await runtime.close(); }
});
test('the native startup flag changes only the inherited MCP switch while a separate ordinary config write remains effective', async () => {
  const parent = path.resolve('.work/mcp-native'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'layers-')), home = path.join(root, 'codex'), temp = path.join(root, 'tmp');
  const env = nativeTestEnvironment({ home: root, codexHome: home, temporary: temp });
  const file = path.join(home, 'config.toml'), name = 'fixture.with.dots';
  writeFileSync(file, ['check_for_update_on_startup=false', '[mcp_servers."fixture.with.dots"]', 'command=' + JSON.stringify(process.execPath),
    '[mcp_servers."fixture.with.dots".env]', 'FIXTURE_VALUE="local-sentinel"'].join('\n'));
  const bin = process.env.HARNESS_TEST_CODEX_BIN!;
  for (const override of [true, false]) {
    const rpc = new NativeRpc({ bin, home, cwd: root, env, dev: true,
      args: ['app-server', '--listen', 'stdio://', ...(override ? ['-c', 'mcp_servers={"fixture.with.dots"={enabled=false}}'] : [])] });
    try {
      await rpc.initialize();
      const read = async () => object(object(await rpc.call('config/read', { cwd: root })).config);
      const settings = await read(), server = object(object(settings.mcp_servers)[name]);
      expect(server).toMatchObject({ command: process.execPath, env: { FIXTURE_VALUE: 'local-sentinel' }, enabled: !override });
      if (override) {
        await rpc.call('config/batchWrite', { edits: [{ keyPath: 'model_reasoning_effort', value: 'low', mergeStrategy: 'replace' }], reloadUserConfig: true });
        expect(readFileSync(file, 'utf8')).not.toContain('enabled = false');
      } else expect(settings.model_reasoning_effort).toBe('low');
    } finally { await rpc.close(); }
  }
});
