import { expect, test, vi } from 'vitest';
import { createServer } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

test('explicit conversion creates independent named threads while original history and provider remain unchanged', () => withFixtureCleanup(async defer => {
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
  rpc.call = async (method, params, options) => { try { const result = await nativeCall(method, params, options);
    if (method === 'thread/resume') appendFileSync(path.join(home, 'resume-settings.jsonl'), JSON.stringify({ threadId: object(object(result).thread).id, serviceTier: object(result).serviceTier, effort: object(result).reasoningEffort, collaborationMode: object(result).collaborationMode }) + '\n');
    return result; } catch (error) { writeFileSync(path.join(home, 'native-error.json'), JSON.stringify({ method, code: (error as { code?: string }).code, message: (error as Error).message })); throw error; } };
  const closeInitial = trackNativeClose(runtime); defer(closeInitial);
  const completed = new Map<string, JsonObject>();
  rpc.on('notification', (message: JsonObject) => { if (message.method === 'turn/completed') { const turn = object(object(message.params).turn); completed.set(String(turn.id), turn); } });
  const created = object(await runtime.call('thread/start', { cwd, options: { model: 'harness-loopback-fixture', modelProvider: 'provider_a', approvalPolicy: 'on-request', sandbox: 'read-only' } }, context));
  const sourceId = String(object(created.thread).id);
  const send = async (id: string, text: string, provider: string) => {
    await runtime.call('thread/history', { threadId: id }, context);
    const sent = object(await runtime.call('turn/start', { threadId: id, text, options: { modelProvider: provider, model: 'harness-loopback-fixture' } }, context));
    await expect.poll(() => completed.get(String(object(sent.turn).id)), { timeout: 10000 }).toMatchObject({ status: 'completed' });
  };
  await send(sourceId, 'first original message', 'provider_a');
  await rpc.call('thread/inject_items', { threadId: sourceId, items: [{ type: 'function_call', name: 'fixture_tool', call_id: 'preserved-tool-call', arguments: '{"fixture":true}' }, { type: 'function_call_output', call_id: 'preserved-tool-call', output: 'PRESERVED_TOOL_RESULT' }] });
  const sourceThread = object(object(await rpc.call('thread/read', { threadId: sourceId })).thread), sourcePath = String(sourceThread.path);
  const busy = await compatibility.historyHelper(config, { action: 'inspect', threadId: sourceId, path: sourcePath, mode: 'foreign' });
  await expect(compatibility.historyHelper(config, { action: 'repair', threadId: sourceId, path: sourcePath, mode: 'foreign', expected: busy.expected! }, true)).rejects.toMatchObject({ code: 'thread_history_busy', delivery: 'not_sent' });
  const closed = compatibility.awaitThreadClosed(rpc, sourceId); await rpc.call('thread/unsubscribe', { threadId: sourceId }); await closed.wait;
  const rows = readFileSync(sourcePath, 'utf8').trimEnd().split('\n').map(line => object(JSON.parse(line)));
  const replacement = rows.filter(row => row.type === 'response_item').map(row => row.payload!);
  appendFileSync(sourcePath, JSON.stringify({ timestamp: new Date().toISOString(), ordinal: Math.max(...rows.map(row => Number(row.ordinal ?? 0))) + 1, type: 'compacted', payload: { message: 'CHECKPOINT', replacement_history: replacement, replacement_history_metadata: replacement.map(() => ({})), window_number: 1 } }) + '\n');
  await runtime.call('thread/history', { threadId: sourceId }, context); await runtime.call('thread/resume', { threadId: sourceId }, context);
  await runtime.call('thread/settings/update', { threadId: sourceId, summary: 'detailed', serviceTier: 'priority', collaborationMode: { mode: 'plan', settings: { model: 'harness-loopback-fixture', reasoning_effort: 'low', developer_instructions: 'PRESERVED_COLLABORATION' } } }, context);
  await rpc.call('thread/goal/set', { threadId: sourceId, origin: 'user', objective: 'Paused fixture', status: 'paused', tokenBudget: 1000 });
  await runtime.call('thread/history', { threadId: sourceId }, context);
  await expect(runtime.call('turn/start', { threadId: sourceId, text: 'must not send', options: { modelProvider: 'provider_b', model: 'harness-loopback-fixture' } }, context)).rejects.toMatchObject({ code: 'provider_conversion_required', delivery: 'not_sent' });
  await expect(runtime.call('thread/resume', { threadId: sourceId, options: { modelProvider: 'provider_b', model: 'harness-loopback-fixture' } }, context)).rejects.toMatchObject({ code: 'provider_conversion_required', delivery: 'not_sent' });
  const params = { threadId: sourceId, sourceProvider: 'provider_a', targetProvider: 'provider_b', model: 'harness-loopback-fixture', effort: 'low', confirm: true };
  await expect(runtime.call('thread/convert', { ...params, confirm: false }, context)).rejects.toMatchObject({ delivery: 'not_sent' });
  expect(requests).toHaveLength(1);
  let frozen: Buffer | undefined;
  const freeze = (event: JsonObject) => { if (event.method === 'thread/closed' && object(event.params).threadId === sourceId) frozen = readFileSync(sourcePath); };
  rpc.on('notification', freeze);
  // The just-created target is visible before copying finishes. A second UI
  // page must not resume or send to either side while conversion owns them.
  const guardedCall = rpc.call.bind(rpc); let guardedTarget: string | undefined;
  rpc.call = async (method, p, options) => {
    if (method === 'thread/name/set' && object(p).threadId !== sourceId && !guardedTarget) {
      guardedTarget = String(object(p).threadId);
      for (const id of [sourceId, guardedTarget]) {
        await expect(runtime.call('thread/resume', { threadId: id }, context)).rejects.toMatchObject({ code: 'thread_busy', delivery: 'not_sent' });
        await expect(runtime.call('turn/start', { threadId: id, text: 'must not race conversion' }, context)).rejects.toMatchObject({ code: 'thread_busy', delivery: 'not_sent' });
      }
    }
    return guardedCall(method, p, options);
  };
  const converted = object(await runtime.call('thread/convert', params, context)); rpc.call = guardedCall; rpc.off('notification', freeze);
  const newId = String(object(converted.thread).id); expect(newId).not.toBe(sourceId);
  expect(guardedTarget).toBe(newId);
  expect(converted).toMatchObject({ sourceThreadId: sourceId, sourceProvider: 'provider_a', targetProvider: 'provider_b', thread: { cwd, modelProvider: 'provider_b' } });
  expect(String(object(converted.thread).name)).toMatch(/^\[已转换至 b\]/); expect(readFileSync(sourcePath)).toEqual(frozen); expect(requests).toHaveLength(1);
  const independent = object(object(await rpc.call('thread/read', { threadId: newId })).thread), independentPath = String(independent.path);
  expect(independent.parentThreadId).toBeNull(); expect(independent.forkedFromId).toBeNull();
  expect(independent.sessionId).toBe(newId); expect(independent.sessionId).not.toBe(sourceThread.sessionId);
  expect(independentPath).not.toBe(sourcePath);
  const originalStat = statSync(sourcePath, { bigint: true }), independentStat = statSync(independentPath, { bigint: true });
  expect([independentStat.dev, independentStat.ino]).not.toEqual([originalStat.dev, originalStat.ino]);
  const header = object(JSON.parse(readFileSync(independentPath, 'utf8').split('\n')[0]!));
  expect(header.type).toBe('session_meta'); expect(object(header.payload).id).toBe(newId);
  expect(object(header.payload).session_id).toBe(newId);
  expect(object(header.payload).history_base ?? null).toBeNull();
  expect(object(object(await rpc.call('thread/read', { threadId: sourceId })).thread).name).toBe(sourceThread.name);
  expect(object(object(await rpc.call('thread/read', { threadId: sourceId })).thread).modelProvider).toBe('provider_a');
  expect(await rpc.call('thread/goal/get', { threadId: newId })).toMatchObject({ goal: null });
  expect(await rpc.call('thread/queue/list', { threadId: newId, limit: 1 })).toMatchObject({ data: [] });
  await expect(runtime.call('turn/start', { threadId: newId, text: 'unread inherited history', options: { modelProvider: 'provider_b' } }, context)).rejects.toMatchObject({ code: 'history_incomplete', delivery: 'not_sent' });
  expect(requests).toHaveLength(1);
  expect(JSON.stringify(await runtime.call('thread/history', { threadId: newId }, context))).toContain('Public reasoning summary fixture');
  await send(newId, 'new converted message', 'provider_b');
  const forwarded = JSON.stringify(requests[1]!.body); for (const text of ['first original message', 'PRESERVED_TOOL_RESULT', 'PRESERVED_CUSTOM_BASE', 'PRESERVED_GLOBAL_DEVELOPER', 'PRESERVED_COLLABORATION']) expect(forwarded).toContain(text);
  expect(forwarded).not.toContain('Foreign provider reasoning'); expect(requests[1]!.body.reasoning).toMatchObject({ summary: 'detailed' });
  await runtime.call('thread/history', { threadId: sourceId }, context); await runtime.call('thread/resume', { threadId: sourceId }, context);
  await send(sourceId, 'original remains independently usable', 'provider_a');
  expect(JSON.stringify(requests[2]!.body)).toContain('Foreign provider reasoning');
  await rpc.call('thread/archive', { threadId: sourceId }); await rpc.call('thread/delete', { threadId: sourceId });
  await closeInitial(); runtime = await RuntimeService.create(config); defer(trackNativeClose(runtime));
  runtime.native.on('notification', (message: JsonObject) => { if (message.method === 'turn/completed') { const turn = object(object(message.params).turn); completed.set(String(turn.id), turn); } });
  await runtime.call('thread/history', { threadId: newId }, context); await runtime.call('thread/resume', { threadId: newId }, context);
  await send(newId, 'converted survives deletion and restart', 'provider_b');
  expect(JSON.stringify(requests[3]!.body)).toContain('new converted message'); expect(JSON.stringify(requests[3]!.body)).not.toContain('original remains independently usable');
  const newThread = object(object(await runtime.native.call('thread/read', { threadId: newId })).thread), newPath = String(newThread.path);
  await runtime.close();
  const newRows = readFileSync(newPath, 'utf8').trimEnd().split('\n').map(line => object(JSON.parse(line)));
  appendFileSync(newPath, JSON.stringify({ timestamp: new Date().toISOString(), ordinal: Math.max(...newRows.map(row => Number(row.ordinal ?? 0))) + 1, type: 'response_item', payload: { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'OLD_BAD_FOREIGN_REASONING' }] } }) + '\n');
  runtime = await RuntimeService.create({ ...config, providerRegistry: { ...registry, connections: registry.connections.map(row => row.modelProvider === 'provider_b' ? { ...row, kind: 'chatgpt' } : row) } }); defer(trackNativeClose(runtime));
  runtime.native.on('notification', (message: JsonObject) => { if (message.method === 'turn/completed') { const turn = object(object(message.params).turn); completed.set(String(turn.id), turn); } });
  await runtime.call('thread/history', { threadId: newId }, context); await runtime.call('thread/resume', { threadId: newId }, context);
  expect(readFileSync(newPath, 'utf8')).toContain('OLD_BAD_FOREIGN_REASONING');
  const repairedCopy = object(await runtime.call('thread/convert', { threadId: newId, sourceProvider: 'provider_b', targetProvider: 'provider_b', model: 'harness-loopback-fixture', effort: 'low', confirm: true }, context));
  const repairedId = String(object(repairedCopy.thread).id); expect(repairedId).not.toBe(newId); expect(readFileSync(newPath, 'utf8')).toContain('OLD_BAD_FOREIGN_REASONING');
  await send(repairedId, 'explicit same-provider compatibility copy', 'provider_b'); expect(JSON.stringify(requests[4]!.body)).not.toContain('OLD_BAD_FOREIGN_REASONING');
  expect(requests.map(request => request.route)).toEqual(['/a/v1/responses', '/b/v1/responses', '/a/v1/responses', '/b/v1/responses', '/b/v1/responses']);
  expect(errors).toEqual([]);
}), 120000);
