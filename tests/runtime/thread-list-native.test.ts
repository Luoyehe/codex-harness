import { expect, test } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RuntimeService } from '../../src/runtime/service.js';
import { object, type JsonObject, type JsonValue } from '../../src/runtime/types.js';
import { nativeTestEnvironment } from '../fixtures/native-env.js';
import { withFixtureCleanup } from './fixture-cleanup.js';

test('official CLI lists persisted project threads across providers, including after a provider is removed', () => withFixtureCleanup(async defer => {
  const parent = path.resolve('.work/thread-list-native'); mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(path.join(parent, 'case-')), codex = path.join(home, 'codex'), cwd = path.join(home, 'project'); mkdirSync(cwd);
  const env = nativeTestEnvironment({ home, codexHome: codex, temporary: path.join(home, 'tmp'), fixtureApiKey: 'local-fixture' });
  let release!: () => void; const responseGate = new Promise<void>(resolve => { release = resolve; });
  const requests: string[] = [], errors: unknown[] = [];
  const server = createServer((request, response) => { void (async () => {
    if (request.method !== 'POST' || !['/a/v1/responses', '/b/v1/responses'].includes(request.url ?? '')) throw new Error('Unexpected fixture request');
    let bytes = 0; for await (const chunk of request) { bytes += Buffer.byteLength(chunk); if (bytes > 4 * 1024 * 1024) throw new Error('Fixture input exceeded budget'); }
    requests.push(request.url!); const n = requests.length;
    await responseGate;
    const item = { id: 'msg_' + n, type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'Local list fixture.', annotations: [], logprobs: [] }] };
    const result = { id: 'resp_' + n, object: 'response', created_at: 1, status: 'completed', model: 'harness-loopback-fixture', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const [sequence_number, event] of [
      { type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: result },
    ].entries()) response.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`);
    response.end();
  })().catch(error => { errors.push(error); response.destroy(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  defer(async () => { release(); const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); server.closeAllConnections(); await closed; });
  const port = (server.address() as AddressInfo).port, catalog = path.join(home, 'catalog-' + 'a'.repeat(32) + '.json');
  writeFileSync(catalog, readFileSync('tests/runtime/fixture-model-catalog.json'));
  const definitions = (letters: string[]) => letters.flatMap(letter => [`[model_providers.provider_${letter}]`, `name = "Local ${letter}"`, `base_url = "http://127.0.0.1:${port}/${letter}/v1"`, 'env_key = "HARNESS_PROVIDER_API_KEY"', 'wire_api = "responses"', 'requires_openai_auth = false', 'supports_websockets = false', 'request_max_retries = 0', 'stream_max_retries = 0']);
  const configure = (letters: string[]) => writeFileSync(path.join(codex, 'config.toml'), ['model = "harness-loopback-fixture"', 'model_provider = "provider_a"', 'approval_policy = "never"', 'sandbox_mode = "read-only"', `model_catalog_json = ${JSON.stringify(catalog)}`, 'check_for_update_on_startup = false', ...definitions(letters)].join('\n'));
  configure(['a', 'b']);
  const registry = { defaultProviderId: 'default', nativeCatalogProvider: 'provider_a', connections: ['a', 'b'].map((letter, i) => ({ id: i ? 'b'.repeat(32) : 'default', modelProvider: 'provider_' + letter, kind: 'responses', name: letter, enabled: true, model: 'harness-loopback-fixture', models: [{ id: 'harness-loopback-fixture', defaultEffort: 'low', efforts: ['low'] }], catalogPath: catalog })) };
  const config = { bin: process.env.HARNESS_TEST_CODEX_BIN ?? path.resolve('reference/runtime/codex-0.164.0/package/vendor/x86_64-pc-windows-msvc/bin/codex.exe'), home: codex, workerHome: home, cwd, env, dev: true, providerRegistry: registry };
  const completed = new Map<string, JsonObject>(), context = { clientId: 'thread-list-native' };
  const start = async () => {
    const service = await RuntimeService.create(config);
    service.native.on('notification', (message: JsonObject) => { if (message.method === 'turn/completed') { const turn = object(object(message.params).turn); completed.set(String(turn.id), turn); } });
    const child = (service.native as unknown as { child: ChildProcess }).child; let closed = false;
    child.once('close', () => { closed = true; });
    const close = async () => { release(); await service.close(); expect(closed).toBe(true); expect(child.exitCode !== null || child.signalCode !== null).toBe(true); };
    defer(close); return { service, close };
  };
  const ids = (value: JsonValue) => (object(value).data as JsonValue[]).map(row => String(object(row).id)).sort();
  const { service, close } = await start();
  const blank = object(await service.call('thread/start', { cwd, options: { modelProvider: 'provider_a', model: 'harness-loopback-fixture' } }, context));
  const a = String(object(blank.thread).id);
  const beforeInput = ids(await service.native.call('thread/list', { cwd, modelProviders: [] }));
  const liveIds = (value: JsonValue) => (object(value).liveData as JsonValue[] ?? []).map(row => String(object(row).id));
  const browserReload = await service.call('thread/list', { cwd, sortKey: 'recency_at' }, { clientId: 'reloaded-browser' });
  expect([...ids(browserReload), ...liveIds(browserReload)].sort()).toEqual([a]);
  expect(requests).toHaveLength(0);
  const first = object(await service.call('turn/start', { threadId: a, text: 'Local first turn.' }, context));
  const conversation = object(await service.call('conversation/start', { cwd, text: 'Local second provider.', options: { modelProvider: 'provider_b', model: 'harness-loopback-fixture' } }, context));
  const b = String(object(conversation.thread).id), expected = [a, b].sort();
  const immediatelyAfterStart = ids(await service.native.call('thread/list', { cwd, modelProviders: [] }));
  const activeList = await service.call('thread/list', { cwd, sortKey: 'recency_at' }, { clientId: 'reloaded-browser' });
  expect([...ids(activeList), ...liveIds(activeList)].sort()).toEqual(expected);
  release();
  for (const value of [first.turn, conversation.turn]) await expect.poll(() => completed.get(String(object(value).id)), { timeout: 10000 }).toMatchObject({ status: 'completed' });
  expect(errors).toEqual([]); expect(requests.sort()).toEqual(['/a/v1/responses', '/b/v1/responses']);
  const nativeDefault = ids(await service.native.call('thread/list', { cwd }));
  const nativeAll = ids(await service.native.call('thread/list', { cwd, modelProviders: [] }));
  const actual = ids(await service.call('thread/list', { cwd }, context));
  writeFileSync(path.join(home, 'observations.json'), JSON.stringify({ beforeInput, immediatelyAfterStart, nativeDefault, nativeAll, actual, expected }, null, 2) + '\n');
  expect(nativeDefault).toEqual([a]); expect(nativeAll).toEqual(expected);
  expect(actual).toEqual(expected);
  expect(liveIds(await service.call('thread/list', { cwd }, context))).toEqual([]);
  const other = path.join(home, 'other'); mkdirSync(other);
  expect(ids(await service.call('thread/list', { cwd: other }, context))).toEqual([]);
  const page = object(await service.call('thread/list', { cwd, limit: 1, sortKey: 'recency_at', sortDirection: 'desc' }, context));
  expect(page.data).toHaveLength(1); expect(typeof page.nextCursor).toBe('string');
  const next = await service.call('thread/list', { cwd, limit: 1, sortKey: 'recency_at', sortDirection: 'desc', cursor: page.nextCursor! }, context);
  expect([...ids(page), ...ids(next)].sort()).toEqual(expected);
  await close(); configure(['a']); registry.connections.splice(1);
  const restarted = (await start()).service;
  expect(ids(await restarted.call('thread/list', { cwd }, context))).toEqual(expected);
  await restarted.call('thread/archive', { threadId: b }, context);
  expect(ids(await restarted.call('thread/list', { cwd }, context))).toEqual([a]);
  expect(ids(await restarted.call('thread/list', { cwd, archived: true }, context))).toEqual([b]);
  await restarted.call('thread/history', { threadId: a }, context);
  await restarted.call('thread/resume', { threadId: a }, context);
  await restarted.call('thread/history', { threadId: a }, context);
  const fullFork = object(await restarted.call('thread/fork', { threadId: a }, context));
  const emptyFork = object(await restarted.call('thread/fork', { threadId: a, beforeTurnId: object(first.turn).id! }, context));
  const forks = [String(object(fullFork.thread).id), String(object(emptyFork.thread).id)].sort();
  const forkList = await restarted.native.call('thread/list', { cwd, modelProviders: [], sortKey: 'recency_at' });
  writeFileSync(path.join(home, 'fork-observations.json'), JSON.stringify({ forks, nativeIds: ids(forkList) }, null, 2) + '\n');
  const visibleForks = await restarted.call('thread/list', { cwd, sortKey: 'recency_at' }, { clientId: 'another-reloaded-browser' });
  for (const id of forks) expect([...ids(visibleForks), ...liveIds(visibleForks)]).toContain(id);
  expect(requests).toHaveLength(2);
}), 60000);
