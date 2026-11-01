import { expect, test, vi } from 'vitest';
import { createServer } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { zstdCompressSync } from 'node:zlib';
import path from 'node:path';
import { RuntimeService } from '../../src/runtime/service.js';
import { object, type JsonObject } from '../../src/runtime/types.js';
import { nativeTestEnvironment } from '../fixtures/native-env.js';
import * as compatibility from '../../src/runtime/thread-history-compatibility.js';
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
    if (req.url === '/b/v1/responses') {
      const input = requests.at(-1)!.body.input;
      const incompatible = Array.isArray(input) ? input.findIndex(value => object(value).type === 'other' || object(value).type === 'reasoning' && Array.isArray(object(value).content) && (object(value).content as unknown[]).length > 0) : -1;
      if (incompatible >= 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Invalid 'input[${incompatible}].content': array too long. Expected an array with maximum length 0, but got an array with length 1 instead.`, type: 'invalid_request_error', param: `input[${incompatible}].content`, code: 'array_above_max_length' } }));
        return;
      }
    }
    const n = requests.length, item = { id: 'msg_' + n, type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'Local answer ' + n, annotations: [], logprobs: [] }] };
    const reasoning = { id: 'rs_' + n, type: 'reasoning', summary: [{ type: 'summary_text', text: 'Public reasoning summary fixture' }], content: [{ type: 'reasoning_text', text: 'Foreign provider reasoning ' + n }], encrypted_content: null };
    const output = req.url === '/a/v1/responses' ? [reasoning, item] : [item];
    const response = { id: 'resp_' + n, object: 'response', created_at: 1, status: 'completed', model: 'harness-loopback-fixture', output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const [sequence_number, event] of [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }, ...output.flatMap((item, output_index) => [{ type: 'response.output_item.added', output_index, item }, { type: 'response.output_item.done', output_index, item }]), { type: 'response.completed', response }].entries()) res.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`);
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
  env.HARNESS_DEV_PYTHON = process.env.HARNESS_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const config = { bin: process.env.HARNESS_TEST_CODEX_BIN ?? path.resolve('reference/runtime/codex-0.164.0/package/vendor/x86_64-pc-windows-msvc/bin/codex.exe'), home: codex, workerHome: home, cwd, env, dev: true, providerRegistry: registry };
  let runtime = await RuntimeService.create(config);
  const rpc = runtime.native, context = { clientId: 'provider-switch-native', beforeWrite: () => {} };
  const nativeCall = rpc.call.bind(rpc);
  rpc.call = async (method, params, options) => { try { return await nativeCall(method, params, options); } catch (error) { writeFileSync(path.join(home, 'native-error.json'), JSON.stringify({ method, code: (error as { code?: string }).code, message: (error as Error).message })); throw error; } };
  const closeInitial = trackNativeClose(runtime); defer(closeInitial);
  const completed = new Map<string, JsonObject>();
  rpc.on('notification', (message: JsonObject) => { if (message.method === 'turn/completed') { const turn = object(object(message.params).turn); completed.set(String(turn.id), turn); } });
  const created = object(await runtime.call('thread/start', { cwd, options: { model: 'harness-loopback-fixture', modelProvider: 'provider_a', approvalPolicy: 'on-request', sandbox: 'read-only' } }, context));
  const threadId = String(object(created.thread).id);
  let currentProvider = 'provider_a';
  const turn = async (text: string, modelProvider = 'provider_a') => { const result = object(await runtime.call('turn/start', { threadId, text, options: { modelProvider, model: 'harness-loopback-fixture' }, ...(modelProvider === currentProvider ? {} : { historyConversionConsent: { sourceProvider: currentProvider, targetProvider: modelProvider } }) }, context).catch(error => { throw new Error(String(error.code) + ': ' + error.message); })); const id = String(object(result.turn).id); await expect.poll(() => completed.get(id), { timeout: 10000 }).toMatchObject({ status: 'completed' }); currentProvider = modelProvider; };
  await turn('first local message');
  // Add a complete, inert tool pair through the official append API; no tool runs.
  await rpc.call('thread/inject_items', { threadId, items: [
    { type: 'function_call', name: 'fixture_tool', call_id: 'preserved-tool-call', arguments: '{"fixture":true}' },
    { type: 'function_call_output', call_id: 'preserved-tool-call', output: 'PRESERVED_TOOL_RESULT' },
  ] });
  const initialHistory = await runtime.call('thread/history', { threadId }, context);
  expect(JSON.stringify(initialHistory)).toContain('Public reasoning summary fixture');
  await expect(compatibility.historyCompatibility(config, object(object(await rpc.call('thread/read', { threadId })).thread), 'foreign', true))
    .rejects.toMatchObject({ code: 'thread_history_busy', delivery: 'not_sent' });
  const noConsentRequests = requests.length;
  await expect(runtime.call('turn/start', { threadId, text: 'not sent without confirmation', options: { modelProvider: 'provider_b', model: 'harness-loopback-fixture' } }, context))
    .rejects.toMatchObject({ code: 'history_conversion_confirmation_required', delivery: 'not_sent' });
  expect(requests).toHaveLength(noConsentRequests);
  expect(object(object(runtime.status()).activity).unknown).toBe(false);
  const forked = object(await runtime.call('thread/fork', { threadId }, context)), forkId = String(object(forked.thread).id);
  await runtime.call('thread/history', { threadId: forkId }, context);
  const parentPath = String(object(object(await rpc.call('thread/read', { threadId })).thread).path), parentBefore = readFileSync(parentPath);
  await expect(runtime.call('turn/start', { threadId: forkId, text: 'unsupported inherited conversion', options: { modelProvider: 'provider_b', model: 'harness-loopback-fixture' },
    historyConversionConsent: { sourceProvider: 'provider_a', targetProvider: 'provider_b' } }, context))
    .rejects.toMatchObject({ code: 'history_conversion_unsupported', delivery: 'not_sent' });
  expect(readFileSync(parentPath)).toEqual(parentBefore); expect(requests).toHaveLength(noConsentRequests);
  expect(object(object(await rpc.call('thread/read', { threadId: forkId })).thread).status).toMatchObject({ type: 'idle' });
  expect(object(object(runtime.status()).activity).unknown).toBe(false);
  await runtime.call('thread/settings/update', { threadId, collaborationMode: { mode: 'plan', settings: { model: 'harness-loopback-fixture', reasoning_effort: 'low', developer_instructions: 'PRESERVED_COLLABORATION' } }, summary: 'detailed', serviceTier: 'priority' }, context);
  for (const [target, text] of [['provider_b', 'second local message'], ['provider_a', 'third local message']]) {
    await runtime.call('thread/history', { threadId }, context);
    const checks = target === 'provider_a' ? vi.spyOn(compatibility, 'historyCompatibility') : undefined;
    let flushed = false;
    const flush = (message: JsonObject) => {
      if (message.method !== 'thread/closed' || object(message.params).threadId !== threadId) return;
      // Simulate the writer's final flush after the initial inspection found no
      // reasoning. The true closed event proves that no writer can overlap it.
      const rows = readFileSync(parentPath, 'utf8').trimEnd().split('\n').map(line => object(JSON.parse(line)));
      appendFileSync(parentPath, JSON.stringify({ timestamp: new Date().toISOString(),
        ordinal: Math.max(...rows.map(row => Number(row.ordinal ?? 0))) + 1, type: 'response_item',
        payload: { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'LATE_FLUSH_REASONING' }] } }) + '\n');
      flushed = true;
    };
    if (checks) rpc.on('notification', flush);
    try {
      await turn(text!, target!);
      if (checks) {
        expect(flushed).toBe(true);
        expect(checks.mock.calls.map(args => args[3] ?? false)).toEqual([false, true]);
        await expect(checks.mock.results[0]!.value).resolves.toBe(false);
        await expect(checks.mock.results[1]!.value).resolves.toBe(true);
        expect(JSON.stringify(requests.at(-1)!.body)).not.toContain('LATE_FLUSH_REASONING');
      }
    } finally { rpc.off('notification', flush); checks?.mockRestore(); }
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
  const migrated = object(await runtime.call('thread/resume', { threadId, automatic: true, options: { modelProvider: 'provider_b', model: 'harness-loopback-fixture' }, historyConversionConsent: { sourceProvider: 'provider_a', targetProvider: 'provider_b' } }, context));
  expect(migrated).toMatchObject({ modelProvider: 'provider_b', thread: { id: threadId }, approvalPolicy: 'on-request', sandbox: { type: 'readOnly', networkAccess: false }, collaborationMode: { mode: 'plan' } });
  for (const key of ['approvalPolicy', 'approvalsReviewer', 'sandbox', 'activePermissionProfile', 'runtimeWorkspaceRoots', 'serviceTier', 'disabledPluginIds'])
    expect(migrated[key], key).toEqual(coldBaseline[key]);
  expect(requests).toHaveLength(3);
  const restored = await runtime.call('thread/history', { threadId }, context);
  expect(JSON.stringify(restored)).toContain('first local message'); expect(JSON.stringify(restored)).toContain('third local message');
  currentProvider = 'provider_b';
  await turn('fourth local message after cold provider removal', 'provider_b');
  expect(requests.map(item => item.route)).toEqual(['/a/v1/responses', '/b/v1/responses', '/a/v1/responses', '/b/v1/responses']);
  expect(JSON.stringify(requests[3]!.body)).toContain('PRESERVED_CUSTOM_BASE');
  expect(JSON.stringify(requests[3]!.body)).toContain('PRESERVED_GLOBAL_DEVELOPER');
  expect(JSON.stringify(requests[3]!.body)).toContain('PRESERVED_COLLABORATION');
  expect(JSON.stringify(await runtime.call('thread/history', { threadId }, context))).toContain('Public reasoning summary fixture');
  const forwarded = requests[1]!.body.input as JsonObject[];
  expect(forwarded.find(item => item.type === 'function_call')).toMatchObject({ call_id: 'preserved-tool-call', arguments: '{"fixture":true}' });
  expect(forwarded.find(item => item.type === 'function_call_output')).toMatchObject({ call_id: 'preserved-tool-call', output: 'PRESERVED_TOOL_RESULT' });
  expect(forwarded.some(item => item.type === 'reasoning' || item.type === 'other')).toBe(false);
  // Reproduce an already-failed old conversation: its saved current provider is
  // B, but a foreign reasoning item remains in its rollout after a prior failure.
  const stored = object(object(await runtime.native.call('thread/read', { threadId })).thread);
  await runtime.close();
  const rollout = String(stored.path), records = readFileSync(rollout, 'utf8').trimEnd().split('\n').map(line => object(JSON.parse(line)));
  const ordinal = Math.max(...records.map(row => Number(row.ordinal ?? 0))) + 1;
  const oldReasoning = { type: 'reasoning', id: 'rs_old_foreign', summary: [], content: [{ type: 'reasoning_text', text: 'old foreign private reasoning' }], encrypted_content: null };
  const replacement = [...records.filter(row => row.type === 'response_item' && object(row.payload).type !== 'other').map(row => object(row.payload)), oldReasoning];
  appendFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), ordinal, type: 'response_item', payload: oldReasoning }) + '\n' +
    JSON.stringify({ timestamp: new Date().toISOString(), ordinal: ordinal + 1, type: 'compacted', payload: { message: 'Local checkpoint fixture',
      replacement_history: replacement, replacement_history_metadata: replacement.map(() => ({})), window_number: 1 } }) + '\n');
  const strictRegistry = { ...registry, defaultProviderId: remaining[0]!.id, nativeCatalogProvider: 'provider_b', connections: remaining.map(row => ({ ...row, kind: 'chatgpt' })) };
  runtime = await RuntimeService.create({ ...config, providerRegistry: strictRegistry }); defer(trackNativeClose(runtime));
  runtime.native.on('notification', (message: JsonObject) => { if (message.method === 'turn/completed') { const result = object(object(message.params).turn); completed.set(String(result.id), result); } });
  await runtime.call('thread/history', { threadId }, context);
  await expect(runtime.call('thread/resume', { threadId, automatic: true }, context)).rejects.toMatchObject({
    code: 'history_conversion_confirmation_required', delivery: 'not_sent', data: { sourceProvider: 'provider_b', targetProvider: 'provider_b' },
  });
  expect(requests).toHaveLength(4); expect(object(object(runtime.status()).activity).unknown).toBe(false);
  const repaired = await runtime.call('thread/resume', { threadId, automatic: true, historyConversionConsent: { sourceProvider: 'provider_b', targetProvider: 'provider_b' } }, context);
  expect(repaired).toMatchObject({ thread: { id: threadId }, modelProvider: 'provider_b' });
  await runtime.call('thread/history', { threadId }, context);
  const inspections = vi.spyOn(compatibility, 'historyCompatibility');
  await turn('fifth local message after same-provider repair', 'provider_b');
  expect(inspections).not.toHaveBeenCalled(); inspections.mockRestore();
  expect(JSON.stringify(requests[4]!.body)).toContain('PRESERVED_TOOL_RESULT');
  expect(JSON.stringify(requests[4]!.body)).not.toContain('old foreign private reasoning');
  await runtime.call('thread/history', { threadId }, context);
  const validFork = object(await runtime.call('thread/fork', { threadId }, context)), validForkId = String(object(validFork.thread).id);
  // Codex compresses cold rollouts. Compatibility inspection must not turn a
  // valid same-provider compressed conversation into a new load restriction.
  await runtime.close();
  const plain = process.platform === 'win32' && rollout.startsWith('\\\\?\\') ? rollout.slice(4) : rollout;
  const relative = path.relative(codex, plain); expect(path.isAbsolute(relative) || relative.startsWith('..')).toBe(false);
  writeFileSync(plain + '.zst', zstdCompressSync(readFileSync(plain)), { flag: 'wx' }); unlinkSync(plain);
  runtime = await RuntimeService.create({ ...config, providerRegistry: strictRegistry }); defer(trackNativeClose(runtime));
  await runtime.call('thread/history', { threadId }, context);
  const compressedResume = await runtime.call('thread/resume', { threadId, automatic: true }, context);
  expect(compressedResume).toMatchObject({ thread: { id: threadId }, modelProvider: 'provider_b' });
  await runtime.call('thread/history', { threadId: validForkId }, context);
  expect(await runtime.call('thread/resume', { threadId: validForkId, automatic: true }, context))
    .toMatchObject({ thread: { id: validForkId }, modelProvider: 'provider_b' });
  expect(requests).toHaveLength(5);
  expect(errors).toEqual([]);
}), 45000);
