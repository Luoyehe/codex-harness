import { expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Ledger } from '../../src/core/ledger.js';
import { RuntimeService } from '../../src/runtime/service.js';
import { NativeRpc } from '../../src/runtime/native.js';
import { object, type JsonObject, type RuntimeEvent } from '../../src/runtime/types.js';
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

test('official CLI reports and logs out a shared ChatGPT account while an API-key provider is default', async () => {
  const bin = process.env.HARNESS_TEST_CODEX_BIN ?? path.resolve('reference/runtime/codex-0.164.0/package/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
  const base = path.resolve('.work/provider-account-native'); mkdirSync(base, { recursive: true });
  const workerHome = mkdtempSync(path.join(base, 'case-')), home = path.join(workerHome, 'codex'), temporary = path.join(workerHome, 'tmp');
  const env = nativeTestEnvironment({ home: workerHome, codexHome: home, temporary, fixtureApiKey: 'local-api-fixture' });
  const backend = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ accounts: [{ id: 'local-fixture',
      plan_type: 'plus', workspace_backend_origin: 'https://chatgpt.com', account_routing_override: 'NO_CONSTRAINT' }] }));
  });
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
  const backendUrl = 'http://127.0.0.1:' + (backend.address() as AddressInfo).port;
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = part({ alg: 'none', typ: 'JWT' }) + '.' + part({
    email: 'fixture@example.invalid', exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: 'local-fixture', chatgpt_plan_type: 'plus' },
  }) + '.fixture';
  writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    id_token: token, access_token: 'local-access-fixture', refresh_token: 'local-refresh-fixture', account_id: 'local-fixture',
  }, last_refresh: new Date().toISOString() }));
  writeFileSync(path.join(home, 'config.toml'), [
    'check_for_update_on_startup = false', 'cli_auth_credentials_store = "file"',
    'chatgpt_base_url = ' + JSON.stringify(backendUrl),
    'model_catalog_json = ' + JSON.stringify(path.resolve('tests/runtime/fixture-model-catalog.json')),
    'model_provider = "custom"', '[model_providers.custom]',
    'name = "Local fixture"', 'base_url = "http://127.0.0.1:9/v1"', 'env_key = "HARNESS_PROVIDER_API_KEY"',
    'wire_api = "responses"', 'requires_openai_auth = false',
  ].join('\n'));
  const service = await RuntimeService.create({ bin, home, workerHome, cwd: workerHome, env, dev: true,
    providerRegistry: { defaultProviderId: 'default', nativeCatalogProvider: 'custom', connections: [
      { id: 'default', name: 'Custom', enabled: true, modelProvider: 'custom', kind: 'responses', models: [] },
      { id: 'a'.repeat(32), name: 'ChatGPT', enabled: true, modelProvider: 'openai', kind: 'chatgpt', models: [] },
    ] } });
  const context = { clientId: 'account-fixture', beforeWrite: vi.fn() };
  try {
    expect(object(await service.native.call('account/read', { refreshToken: false })).account).toBeNull();
    const account = object(await service.call('account/read', {}, context));
    expect(account.account).toMatchObject({ type: 'chatgpt', email: 'fixture@example.invalid' });
    expect(account.requiresOpenaiAuth).toBe(true);
    await service.call('account/logout', {}, context);
    expect(context.beforeWrite).toHaveBeenCalledTimes(1);
    const after = object(await service.call('account/read', {}, context));
    expect(after.account).toBeNull();
  } finally { await service.close(); const stopped = new Promise<void>(resolve => backend.close(() => resolve())); backend.closeAllConnections(); await stopped; }
}, 45000);

test('official CLI routes simultaneous equal model IDs to separate providers and resumes after catalog generation replacement', async () => {
  const bin = process.env.HARNESS_TEST_CODEX_BIN ?? path.resolve('reference/runtime/codex-0.164.0/package/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
  const base = path.resolve('.work/provider-native'); mkdirSync(base, { recursive: true });
  const workerHome = mkdtempSync(path.join(base, 'case-')), home = path.join(workerHome, 'codex'), temporary = path.join(workerHome, 'tmp');
  const env = nativeTestEnvironment({ home: workerHome, codexHome: home, temporary });
  const requests: { url: string; key: string; body: JsonObject }[] = [];
  const server = createServer((request, response) => { void (async () => {
    const pieces: Buffer[] = []; for await (const chunk of request) pieces.push(Buffer.from(chunk));
    if (request.method !== 'POST' || !request.url?.endsWith('/responses')) { response.writeHead(404).end(); return; }
    requests.push({ url: request.url, key: String(request.headers.authorization), body: object(JSON.parse(Buffer.concat(pieces).toString('utf8'))) });
    const item = { id: 'message_' + requests.length, type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Local provider route accepted.', annotations: [], logprobs: [] }] };
    const result = { id: 'response_' + requests.length, object: 'response', created_at: 1, status: 'completed',
      model: 'same-model', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const [index, event] of [
      { type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: result },
    ].entries()) response.write('event: ' + event.type + '\ndata: ' + JSON.stringify({ ...event, sequence_number: index }) + '\n\n');
    response.end();
  })().catch(() => response.destroy()); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const catalog = JSON.parse(readFileSync('tests/runtime/fixture-model-catalog.json', 'utf8'));
  const connections = ['a', 'b'].map((letter, index) => {
    const id = letter.repeat(32), modelProvider = 'harness_' + id, effort = index ? 'low' : 'max';
    const catalogPath = path.join(workerHome, 'catalog-' + id + '.json');
    writeFileSync(catalogPath, JSON.stringify({ models: [{ ...catalog.models[0], slug: 'same-model',
      default_reasoning_level: effort, supported_reasoning_levels: [{ effort, description: 'Local fixture' }] }] }));
    env['FIXTURE_KEY_' + letter.toUpperCase()] = 'local-fixture-' + letter;
    return { id, modelProvider, name: letter, enabled: true, kind: 'responses', model: 'same-model', catalogPath,
      models: [{ id: 'same-model', defaultEffort: effort, efforts: [effort], inputModalities: ['text'] }] };
  });
  writeFileSync(path.join(home, 'config.toml'), [
    'model = "same-model"', 'model_provider = ' + JSON.stringify(connections[0]!.modelProvider),
    'check_for_update_on_startup = false', 'approval_policy = "never"', 'sandbox_mode = "read-only"',
    ...connections.flatMap((row, index) => ['[model_providers.' + row.modelProvider + ']', 'name = ' + JSON.stringify(row.name),
      'base_url = "http://127.0.0.1:' + port + '/' + row.name + '/v1"', 'wire_api = "responses"',
      'env_key = "FIXTURE_KEY_' + (index ? 'B' : 'A') + '"', 'requires_openai_auth = false',
      'supports_websockets = false', 'request_max_retries = 0', 'stream_max_retries = 0']),
  ].join('\n'));
  const registry = { connections, defaultProviderId: connections[0]!.id, nativeCatalogProvider: connections[0]!.modelProvider };
  let service: RuntimeService | undefined;
  const events: RuntimeEvent[] = [], context = { clientId: 'provider-fixture' };
  const start = async () => { const value = await RuntimeService.create({ bin, home, workerHome, cwd: workerHome, env, dev: true, providerRegistry: registry }); value.on('event', event => events.push(event)); return value; };
  const completed = async (id: unknown) => {
    await expect.poll(() => events.some(event => event.type === 'notification' && object(event.data).method === 'turn/completed' &&
      object(object(object(event.data).params).turn).id === id), { timeout: 15000 }).toBe(true);
  };
  try {
    service = await start();
    const created = await Promise.all(connections.map(row => service!.call('conversation/start', {
      cwd: workerHome, text: 'Answer with the local fixture.', options: { modelProvider: row.modelProvider, model: 'same-model', effort: row.models[0]!.defaultEffort },
    }, context)));
    for (const value of created) await completed(object(object(value).turn).id);
    expect(requests.map(row => [row.url, row.key]).sort()).toEqual([['/a/v1/responses', 'Bearer local-fixture-a'], ['/b/v1/responses', 'Bearer local-fixture-b']]);
    expect(requests.find(row => row.url.startsWith('/a/'))?.body.reasoning).toMatchObject({ effort: 'max' });
    expect(requests.find(row => row.url.startsWith('/b/'))?.body.reasoning).toMatchObject({ effort: 'low' });
    const threadId = object(object(created[0]).thread).id!;
    await service.close();
    const old = connections[0]!.catalogPath, next = path.join(workerHome, 'generation-next'); mkdirSync(next);
    connections[0]!.catalogPath = path.join(next, path.basename(old)); writeFileSync(connections[0]!.catalogPath, readFileSync(old)); unlinkSync(old);
    service = await start();
    await service.call('thread/history', { threadId }, context);
    const resumed = object(await service.call('thread/resume', { threadId }, context));
    expect(resumed.modelProvider).toBe(connections[0]!.modelProvider);
    const session = object(await service.call('thread/session', { threadId }, context));
    expect(session.requiresResume).toBe(false);
    await service.call('thread/history', { threadId }, context);
    const nextTurn = object(await service.call('turn/start', { threadId, text: 'Continue on the original local provider.' }, context));
    await completed(object(nextTurn.turn).id);
    expect(requests).toHaveLength(3);
    expect(requests[2]).toMatchObject({ url: '/a/v1/responses', key: 'Bearer local-fixture-a', body: { reasoning: { effort: 'max' } } });
  } finally {
    await service?.close();
    const stopped = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); await stopped;
  }
}, 60000);
