import { expect, test } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import WebSocket from 'ws';
import { RuntimeService } from '../../src/runtime/service.js';
import { startWorkerServer } from '../../src/runtime/main.js';
import { WorkerClient } from '../../src/gateway/worker-client.js';
import { Dispatcher } from '../../src/gateway/dispatch.js';
import { GatewayServer } from '../../src/gateway/server.js';
import { Authentication } from '../../src/gateway/auth.js';
import { Ledger } from '../../src/core/ledger.js';
import { object, type JsonObject, type JsonValue, type RuntimeEvent } from '../../src/runtime/types.js';
import { nativeTestEnvironment } from '../fixtures/native-env.js';

// Event contract: https://developers.openai.com/api/reference/resources/responses/streaming-events
function streamResponse(res: ServerResponse, number: number): void {
  const text = `Local fixture answer ${number}.`; const messageId = `msg_fixture_${number}`;
  const content = { type: 'output_text', text, annotations: [], logprobs: [] };
  const item = { id: messageId, type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [content] };
  const response = { id: `resp_fixture_${number}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', background: false, completed_at: Math.floor(Date.now() / 1000), error: null, incomplete_details: null, instructions: null, max_output_tokens: null, model: 'harness-loopback-fixture', output: [item], parallel_tool_calls: false, previous_response_id: null, reasoning: { effort: 'low', summary: null }, store: false, temperature: 1, text: { format: { type: 'text' } }, tool_choice: 'auto', tools: [], top_p: 1, truncation: 'disabled', usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 }, user: null, metadata: {} };
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'x-request-id': `req_fixture_${number}` });
  let sequence = 0; const event = (value: object): void => { const entry = { ...value, sequence_number: sequence++ }; res.write(`event: ${(value as { type: string }).type}\ndata: ${JSON.stringify(entry)}\n\n`); };
  event({ type: 'response.created', response: { ...response, status: 'in_progress', output: [], usage: null, completed_at: null } });
  event({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
  event({ type: 'response.content_part.added', item_id: messageId, output_index: 0, content_index: 0, part: { ...content, text: '' } });
  event({ type: 'response.output_text.delta', item_id: messageId, output_index: 0, content_index: 0, delta: text, logprobs: [] });
  event({ type: 'response.output_text.done', item_id: messageId, output_index: 0, content_index: 0, text, logprobs: [] });
  event({ type: 'response.content_part.done', item_id: messageId, output_index: 0, content_index: 0, part: content });
  event({ type: 'response.output_item.done', output_index: 0, item });
  event({ type: 'response.completed', response }); res.end();
}

test('real gateway/worker/CLI chain sends to loopback Responses only, stores history, and replays receipts without resending', async () => {
  const parent = path.resolve('.work/gateway-native'); mkdirSync(parent, { recursive: true }); const root = mkdtempSync(path.join(parent, 'run-'));
  const codexHome = path.join(root, 'codex'); const projectPath = path.join(root, 'project'); mkdirSync(codexHome); mkdirSync(projectPath);
  const bin = process.env.HARNESS_TEST_CODEX_BIN ?? path.resolve('reference/runtime/codex-0.164.0/package/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
  const temporary = path.join(root, 'tmp'); mkdirSync(temporary);
  const env = nativeTestEnvironment({ home: root, codexHome, temporary, fixtureApiKey: 'local-protocol-fixture' });
  expect(execFileSync(bin, ['--version'], { env, encoding: 'utf8', windowsHide: true }).trim()).toBe('codex-cli 0.164.0');
  let providerRequests = 0; const received: JsonObject[] = []; const providerErrors: string[] = []; const unexpectedPaths: string[] = [];
  let holdNextResponse = false; const held = new Set<ServerResponse>();
  const provider = createServer((req, res) => { void (async () => {
    if (req.method !== 'POST' || req.url !== '/v1/responses') { unexpectedPaths.push(`${req.method} ${req.url}`); res.writeHead(404).end(); return; }
    const chunks: Buffer[] = []; let size = 0; for await (const raw of req) { const chunk = Buffer.from(raw); size += chunk.length; if (size > 4 * 1024 * 1024) throw new Error('Fixture body exceeds budget'); chunks.push(chunk); }
    const request = object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); received.push(request); providerRequests++;
    if (holdNextResponse) {
      holdNextResponse = false; held.add(res); res.once('close', () => held.delete(res)); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', sequence_number: 0, response: { id: 'resp_fixture_interrupted', object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model: 'harness-loopback-fixture', output: [] } })}\n\n`);
    } else streamResponse(res, providerRequests);
  })().catch(error => { providerErrors.push(String(error)); res.destroy(); }); });
  let runtime: RuntimeService | undefined; let workerHandle: Awaited<ReturnType<typeof startWorkerServer>> | undefined; let worker: WorkerClient | undefined; let gateway: GatewayServer | undefined; let ledger: Ledger | undefined; let browser: WebSocket | undefined; let auth: Authentication | undefined;
  try {
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve)); const providerPort = (provider.address() as AddressInfo).port;
    const catalog = path.join(root, 'models.json'); writeFileSync(catalog, readFileSync(path.resolve('tests/runtime/fixture-model-catalog.json')));
    writeFileSync(path.join(codexHome, 'config.toml'), [
      'model = "harness-loopback-fixture"', 'model_provider = "local_fixture"', 'approval_policy = "never"', 'sandbox_mode = "read-only"',
      `model_catalog_json = ${JSON.stringify(catalog)}`, 'check_for_update_on_startup = false',
      '[model_providers.local_fixture]', 'name = "Local protocol fixture"', `base_url = "http://127.0.0.1:${providerPort}/v1"`, 'env_key = "HARNESS_PROVIDER_API_KEY"', 'wire_api = "responses"', 'requires_openai_auth = false', 'supports_websockets = false', 'request_max_retries = 0', 'stream_max_retries = 0',
    ].join('\n') + '\n');
    runtime = await RuntimeService.create({ bin, home: codexHome, workerHome: root, cwd: projectPath, env, dev: true });
    const workerToken = randomBytes(32).toString('hex'); workerHandle = await startWorkerServer(runtime, { devPort: 0, token: workerToken });
    worker = new WorkerClient({ port: (workerHandle.server.address() as AddressInfo).port, token: workerToken }); ledger = new Ledger(path.join(root, 'gateway.sqlite'));
    const dispatcher = new Dispatcher(ledger, worker, { call: async () => { throw new Error('Management is outside this integration'); } });
    worker.on('event', event => dispatcher.event(event)); worker.on('disconnect', () => dispatcher.disconnected()); worker.connect();
    await expect.poll(() => object(dispatcher.status()).connected, { timeout: 10000 }).toBe(true);
    await expect.poll(() => object(object(dispatcher.status()).activity).unknown, { timeout: 10000 }).toBe(false);
    const adminToken = randomBytes(32).toString('hex'); auth = new Authentication(adminToken, 'http://127.0.0.1:0'); gateway = new GatewayServer(auth, dispatcher, worker); const gatewayPort = await gateway.listen(0); auth.origin.port = String(gatewayPort); const origin = auth.origin.origin;
    const credentials = { username: 'fixture-admin', password: randomBytes(32).toString('hex') };
    const setupResponse = await fetch(`${origin}/api/account/setup`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: adminToken, ...credentials }) });
    expect(setupResponse.status).toBe(200); await setupResponse.arrayBuffer();
    const loginResponse = await fetch(`${origin}/api/session`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(credentials) }); expect(loginResponse.status).toBe(200); const login = object(await loginResponse.json()); const cookie = loginResponse.headers.get('set-cookie')!.split(';')[0]!; const tabId = randomUUID();
    const rpc = async (method: string, params: JsonObject, operationId?: string): Promise<JsonObject> => { const response = await fetch(`${origin}/api/rpc`, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json', 'x-harness-csrf': String(login.csrf), 'x-harness-client': tabId }, body: JSON.stringify({ method, params, ...(operationId ? { operationId } : {}) }) }); const envelope = object(await response.json()); if (envelope.ok !== true) throw new Error(`${method}: ${JSON.stringify(envelope.error)}`); return object(envelope.result); };
    browser = new WebSocket(`${origin.replace('http:', 'ws:')}/api/events?clientId=${tabId}`, { headers: { origin, cookie } }); const events: RuntimeEvent[] = []; browser.on('message', data => events.push(JSON.parse(data.toString()) as RuntimeEvent)); await once(browser, 'open');
    const models = await rpc('model/list', {}); expect(models.data).toHaveLength(1); expect(object((models.data as JsonValue[])[0])).toMatchObject({ id: 'harness-loopback-fixture', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Local protocol fixture' }], inputModalities: ['text'] });
    const project = await rpc('project/add', { path: projectPath, name: 'Fixture project' }, randomUUID()); const operationId = randomUUID();
    const creationParams = { projectId: project.id!, text: 'First deterministic fixture message.', options: { model: 'harness-loopback-fixture', effort: 'low', approvalPolicy: 'never', sandbox: 'read-only' } };
    const created = await rpc('conversation/start', creationParams, operationId); const threadId = object(created.thread).id!; const firstTurnId = object(created.turn).id!;
    const completed = (turnId: JsonValue): RuntimeEvent | undefined => events.find(event => event.type === 'notification' && object(event.data).method === 'turn/completed' && object(object(object(event.data).params).turn).id === turnId);
    await expect.poll(() => completed(firstTurnId), { timeout: 20000 }).toBeTruthy(); expect(object(object(object(completed(firstTurnId)!.data).params).turn).status).toBe('completed');
    const history = await rpc('thread/history', { threadId }); const serialized = JSON.stringify(history); expect(serialized).toContain('First deterministic fixture message.'); expect(serialized).toContain('Local fixture answer 1.'); expect(history.complete).toBe(true);
    const receipt = await rpc('operation/read', { operationId }); expect(receipt.state).toBe('accepted'); expect(providerRequests).toBe(1);
    expect(await rpc('conversation/start', creationParams, operationId)).toEqual(created); expect(providerRequests).toBe(1);
    const secondOperation = randomUUID(); const second = await rpc('turn/start', { threadId, text: 'Second deterministic fixture message.' }, secondOperation); const secondTurnId = object(second.turn).id!;
    await expect.poll(() => completed(secondTurnId), { timeout: 20000 }).toBeTruthy(); expect(object(object(object(completed(secondTurnId)!.data).params).turn).status).toBe('completed');
    expect((await rpc('operation/read', { operationId: secondOperation })).state).toBe('accepted'); expect(providerRequests).toBe(2); expect(received.every(request => request.model === 'harness-loopback-fixture' && request.stream === true)).toBe(true); expect(providerErrors).toEqual([]); expect(unexpectedPaths).toEqual([]);
    const finalHistory = JSON.stringify(await rpc('thread/history', { threadId })); expect(finalHistory).toContain('Local fixture answer 2.'); expect(finalHistory).toContain('Second deterministic fixture message.');
    expect(events.some(event => event.type === 'notification' && object(event.data).method === 'item/agentMessage/delta')).toBe(true);
    holdNextResponse = true; const interruptedOperation = randomUUID(); const third = await rpc('turn/start', { threadId, text: 'This local response will be interrupted.' }, interruptedOperation); const thirdTurnId = object(third.turn).id!;
    await expect.poll(() => providerRequests, { timeout: 10000 }).toBe(3); await rpc('turn/interrupt', { threadId, turnId: thirdTurnId });
    await expect.poll(() => completed(thirdTurnId), { timeout: 10000 }).toBeTruthy(); expect(object(object(object(completed(thirdTurnId)!.data).params).turn).status).toBe('interrupted');
    expect((await rpc('operation/read', { operationId: interruptedOperation })).state).toBe('accepted');
    // Native turn interruption does not promise immediate upstream HTTP stream closure.
    // End this controlled provider stream explicitly; whole-process cleanup is verified in finally.
    for (const response of held) response.end(); await expect.poll(() => held.size, { timeout: 5000 }).toBe(0); expect(providerRequests).toBe(3);
  } finally {
    const cleanupErrors: unknown[] = []; browser?.terminate();
    for (const close of [async () => gateway?.close(), async () => worker?.close(), async () => workerHandle?.close(), async () => runtime?.close(), async () => ledger?.close(), async () => auth?.close()]) { try { await close(); } catch (error) { cleanupErrors.push(error); } }
    for (const response of held) response.destroy();
    await new Promise<void>(resolve => { provider.close(() => resolve()); provider.closeAllConnections(); });
    if (runtime?.native.processId !== undefined) expect(() => process.kill(runtime!.native.processId!, 0)).toThrow();
    expect(provider.listening).toBe(false); if (gateway) expect(gateway.server.listening).toBe(false); if (workerHandle) expect(workerHandle.server.listening).toBe(false);
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Integration cleanup was not fully confirmed');
  }
}, 60000);
