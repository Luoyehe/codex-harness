import { expect, test } from 'vitest';
import { createServer } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RuntimeService } from '../../src/runtime/service.js';
import { object, type JsonObject } from '../../src/runtime/types.js';
import { nativeTestEnvironment } from '../fixtures/native-env.js';
import { withFixtureCleanup } from './fixture-cleanup.js';

function trackNativeClose(service: RuntimeService) {
  // Bind cleanup proof to this spawned child, never to a PID that a later
  // native restart (or another process) may reuse.
  const child = (service.native as unknown as { child: ChildProcess }).child;
  let closed = false; child.once('close', () => { closed = true; });
  return async () => {
    await service.close();
    expect(closed).toBe(true);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  };
}

test('RuntimeService and official CLI send the same persisted thread both ways through selected loopback providers', () => withFixtureCleanup(async defer => {
  const parent = path.resolve('.work/provider-switch-native'); mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(path.join(parent, 'home-')), codex = path.join(home, 'codex'), cwd = path.join(home, 'project'), temporary = path.join(home, 'tmp');
  mkdirSync(cwd); const env = nativeTestEnvironment({ home, codexHome: codex, temporary, fixtureApiKey: 'local-fixture' });
  const requests: { route: string; body: JsonObject }[] = [], errors: unknown[] = [];
  const server = createServer((req, res) => { void (async () => {
    if (req.method !== 'POST' || !['/a/v1/responses', '/b/v1/responses'].includes(req.url ?? '')) throw new Error('Unexpected fixture route');
    let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 4 * 1024 * 1024) throw new Error('Fixture request exceeded budget'); }
    requests.push({ route: req.url!, body: object(JSON.parse(body)) });
    const n = requests.length, item = { id: 'msg_' + n, type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'Local answer ' + n, annotations: [], logprobs: [] }] };
    const response = { id: 'resp_' + n, object: 'response', created_at: 1, status: 'completed', model: 'harness-loopback-fixture', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const [sequence_number, event] of [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }, { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }].entries()) res.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`);
    res.end();
  })().catch(error => { errors.push(error); res.destroy(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  defer(async () => { const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); server.closeAllConnections(); await closed; });
  const port = (server.address() as AddressInfo).port, catalog = path.join(home, 'catalog-' + 'a'.repeat(32) + '.json');
  const catalogData = JSON.parse(readFileSync('tests/runtime/fixture-model-catalog.json', 'utf8'));
  catalogData.models[0].supports_reasoning_summary_parameter = true;
  catalogData.models[0].base_instructions = 'PRESERVED_CUSTOM_BASE';
  writeFileSync(catalog, JSON.stringify(catalogData));
  const definitions = ['a', 'b'].flatMap(id => [`[model_providers.provider_${id}]`, `name = "Local ${id}"`, `base_url = "http://127.0.0.1:${port}/${id}/v1"`, 'env_key = "HARNESS_PROVIDER_API_KEY"', 'wire_api = "responses"', 'requires_openai_auth = false', 'supports_websockets = false', 'request_max_retries = 0', 'stream_max_retries = 0']);
  writeFileSync(path.join(codex, 'config.toml'), ['model = "harness-loopback-fixture"', 'model_provider = "provider_a"', 'approval_policy = "on-request"', 'sandbox_mode = "read-only"', 'developer_instructions = "PRESERVED_GLOBAL_DEVELOPER"', `model_catalog_json = ${JSON.stringify(catalog)}`, 'check_for_update_on_startup = false', '[features]', 'goals = true', ...definitions].join('\n'));
  const registry = { defaultProviderId: 'default', nativeCatalogProvider: 'provider_a', connections: ['a', 'b'].map((id, i) => ({ id: i ? 'b'.repeat(32) : 'default', modelProvider: 'provider_' + id, kind: 'responses', name: id, enabled: true, model: 'harness-loopback-fixture', models: [{ id: 'harness-loopback-fixture', defaultEffort: 'low', efforts: ['low'] }], catalogPath: catalog })) };
  const config = { bin: process.env.HARNESS_TEST_CODEX_BIN ?? path.resolve('reference/runtime/codex-0.164.0/package/vendor/x86_64-pc-windows-msvc/bin/codex.exe'), home: codex, workerHome: home, cwd, env, dev: true, providerRegistry: registry };
  let runtime = await RuntimeService.create(config);
  const rpc = runtime.native, context = { clientId: 'provider-switch-native', beforeWrite: () => {} };
  const closeInitial = trackNativeClose(runtime); defer(closeInitial);
  const completed = new Map<string, JsonObject>();
  rpc.on('notification', (message: JsonObject) => { if (message.method === 'turn/completed') { const turn = object(object(message.params).turn); completed.set(String(turn.id), turn); } });
  const created = object(await runtime.call('thread/start', { cwd, options: { model: 'harness-loopback-fixture', modelProvider: 'provider_a', approvalPolicy: 'on-request', sandbox: 'read-only' } }, context));
  const threadId = String(object(created.thread).id);
  const turn = async (text: string, modelProvider = 'provider_a') => { const result = object(await runtime.call('turn/start', { threadId, text, options: { modelProvider, model: 'harness-loopback-fixture' } }, context)); const id = String(object(result.turn).id); await expect.poll(() => completed.get(id), { timeout: 10000 }).toMatchObject({ status: 'completed' }); };
  await turn('first local message');
  await runtime.call('thread/history', { threadId }, context);
  await runtime.call('thread/settings/update', { threadId, collaborationMode: { mode: 'plan', settings: { model: 'harness-loopback-fixture', reasoning_effort: 'low', developer_instructions: 'PRESERVED_COLLABORATION' } }, summary: 'detailed', serviceTier: 'priority' }, context);
  for (const [target, text] of [['provider_b', 'second local message'], ['provider_a', 'third local message']]) {
    await runtime.call('thread/history', { threadId }, context);
    await turn(text!, target!);
    const snapshot = object(await runtime.call('thread/session', { threadId }, context));
    expect(snapshot).toMatchObject({ modelProvider: target, approvalPolicy: 'on-request', sandbox: { type: 'readOnly', networkAccess: false }, serviceTier: 'priority', collaborationMode: { mode: 'plan' } });
    expect(object(snapshot.thread).id).toBe(threadId);
    expect(JSON.stringify(await runtime.call('thread/history', { threadId }, context))).toContain('first local message');
  }
  expect(requests.map(item => item.route)).toEqual(['/a/v1/responses', '/b/v1/responses', '/a/v1/responses']);
  for (const request of requests) { expect(JSON.stringify(request.body).includes('PRESERVED_CUSTOM_BASE'), request.route + ' base instructions').toBe(true); expect(JSON.stringify(request.body).includes('PRESERVED_GLOBAL_DEVELOPER'), request.route + ' developer instructions').toBe(true); }
  // The saved tier is verified above. This custom Responses provider does not
  // advertise priority transport, so its request need not contain service_tier.
  for (const request of requests.slice(1)) { expect(JSON.stringify(request.body).includes('PRESERVED_COLLABORATION'), request.route + ' collaboration instructions').toBe(true); expect(request.body.reasoning).toMatchObject({ summary: 'detailed' }); }
  expect(JSON.stringify(requests[2]!.body)).toContain('first local message'); expect(JSON.stringify(requests[2]!.body)).toContain('second local message');
  // Simulate a provider removal and runtime restart: the old native definition
  // really disappears, not just its public menu entry. Loading itself sends no input.
  await closeInitial();
  runtime = await RuntimeService.create(config);
  const closeBaseline = trackNativeClose(runtime); defer(closeBaseline);
  await runtime.call('thread/history', { threadId }, context);
  const coldBaseline = object(await runtime.call('thread/resume', { threadId, automatic: true }, context));
  expect(coldBaseline).toMatchObject({ modelProvider: 'provider_a', approvalPolicy: 'on-request', sandbox: { type: 'readOnly', networkAccess: false }, collaborationMode: { mode: 'plan' } });
  expect(requests).toHaveLength(3);
  await closeBaseline();
  const configPath = path.join(codex, 'config.toml');
  writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('model_provider = "provider_a"', 'model_provider = "provider_b"')
    .replace(/\[model_providers\.provider_a\][\s\S]*?(?=\[model_providers\.provider_b\])/, ''));
  const remaining = registry.connections.filter(row => row.modelProvider === 'provider_b');
  runtime = await RuntimeService.create({ ...config, providerRegistry: { ...registry, defaultProviderId: remaining[0]!.id, nativeCatalogProvider: 'provider_b', connections: remaining } });
  defer(trackNativeClose(runtime));
  runtime.native.on('notification', (message: JsonObject) => { if (message.method === 'turn/completed') { const result = object(object(message.params).turn); completed.set(String(result.id), result); } });
  await runtime.call('thread/history', { threadId }, context);
  await expect(runtime.call('thread/resume', { threadId, automatic: true }, context)).rejects.toMatchObject({ code: 'provider_unavailable', delivery: 'not_sent' });
  const migrated = object(await runtime.call('thread/resume', { threadId, automatic: true, options: { modelProvider: 'provider_b', model: 'harness-loopback-fixture' } }, context));
  expect(migrated).toMatchObject({ modelProvider: 'provider_b', thread: { id: threadId }, approvalPolicy: 'on-request', sandbox: { type: 'readOnly', networkAccess: false }, collaborationMode: { mode: 'plan' } });
  for (const key of ['approvalPolicy', 'approvalsReviewer', 'sandbox', 'activePermissionProfile', 'runtimeWorkspaceRoots', 'serviceTier', 'disabledPluginIds'])
    expect(migrated[key], key).toEqual(coldBaseline[key]);
  expect(requests).toHaveLength(3);
  const restored = await runtime.call('thread/history', { threadId }, context);
  expect(JSON.stringify(restored)).toContain('first local message'); expect(JSON.stringify(restored)).toContain('third local message');
  await turn('fourth local message after cold provider removal', 'provider_b');
  expect(requests.map(item => item.route)).toEqual(['/a/v1/responses', '/b/v1/responses', '/a/v1/responses', '/b/v1/responses']);
  expect(JSON.stringify(requests[3]!.body)).toContain('PRESERVED_CUSTOM_BASE');
  expect(JSON.stringify(requests[3]!.body)).toContain('PRESERVED_GLOBAL_DEVELOPER');
  expect(JSON.stringify(requests[3]!.body)).toContain('PRESERVED_COLLABORATION');
  expect(errors).toEqual([]);
}), 45000);
