import { expect, test } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { RuntimeService } from '../../src/runtime/service.js';
import { object, type JsonValue, type RuntimeEvent } from '../../src/runtime/types.js';
import { nativeTestEnvironment } from '../fixtures/native-env.js';

// The provider is a local protocol substitute. No commercial model or MCP call
// is made; the real pinned CLI owns queue, goal, history and lifecycle state.
function answer(res: ServerResponse, id: number): void {
  const item = { id: `message_${id}`, type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: `Deterministic workflow answer ${id}.`, annotations: [], logprobs: [] }] };
  const response = { id: `response_${id}`, object: 'response', created_at: 1, status: 'completed', model: 'harness-loopback-fixture', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }, { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }];
  for (const [index, event] of events.entries()) res.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`); res.end();
}
test('official CLI persists queues and goals, steers active turns, forks/reverts history and starts inline reviews using loopback only', async () => {
  const parent = path.resolve('.work/workflows-native'); mkdirSync(parent, { recursive: true }); const home = mkdtempSync(path.join(parent, 'home-')); const codex = path.join(home, 'codex'); const project = path.join(home, 'project'); const temporary = path.join(home, 'tmp'); mkdirSync(codex); mkdirSync(project); mkdirSync(temporary);
  const bin = process.env.HARNESS_TEST_CODEX_BIN ?? path.resolve('reference/runtime/codex-0.164.0/package/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
  const env = nativeTestEnvironment({ home, codexHome: codex, temporary, fixtureApiKey: 'local-fixture' });
  expect(execFileSync(bin, ['--version'], { env, encoding: 'utf8', windowsHide: true }).trim()).toBe('codex-cli 0.164.0');
  let requests = 0; let hold = false; const held = new Set<ServerResponse>(); const errors: string[] = [];
  const provider = createServer((req, res) => { void (async () => {
    if (req.method !== 'POST' || req.url !== '/v1/responses') throw new Error(`Unexpected fixture route ${req.method} ${req.url}`);
    let bytes = 0; for await (const chunk of req) { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) throw new Error('Fixture request exceeds budget'); }
    requests++; if (hold) { held.add(res); res.on('close', () => held.delete(res)); res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', sequence_number: 0, response: { id: `held_${requests}`, object: 'response', status: 'in_progress', model: 'harness-loopback-fixture', output: [] } })}\n\n`); } else answer(res, requests);
  })().catch(error => { errors.push(String(error)); res.destroy(); }); });
  let runtime: RuntimeService | undefined; const events: RuntimeEvent[] = []; const context = { clientId: 'native-workflows' }; const pids: number[] = [];
  try {
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve)); const port = (provider.address() as AddressInfo).port; const catalog = path.join(home, 'models.json'); writeFileSync(catalog, readFileSync('tests/runtime/fixture-model-catalog.json'));
    writeFileSync(path.join(codex, 'config.toml'), ['model = "harness-loopback-fixture"', 'model_provider = "local_fixture"', 'approval_policy = "never"', 'sandbox_mode = "read-only"', `model_catalog_json = ${JSON.stringify(catalog)}`, 'check_for_update_on_startup = false', '[model_providers.local_fixture]', 'name = "Local protocol fixture"', `base_url = "http://127.0.0.1:${port}/v1"`, 'env_key = "HARNESS_PROVIDER_API_KEY"', 'wire_api = "responses"', 'requires_openai_auth = false', 'supports_websockets = false', 'request_max_retries = 0', 'stream_max_retries = 0'].join('\n'));
    const create = async () => { const service = await RuntimeService.create({ bin, home: codex, workerHome: home, cwd: project, env, dev: true }); pids.push(service.native.processId!); service.on('event', event => events.push(event)); return service; };
    runtime = await create();
    const done = async (id: JsonValue, status = 'completed') => { await expect.poll(() => events.find(event => event.type === 'notification' && object(event.data).method === 'turn/completed' && object(object(object(event.data).params).turn).id === id), { timeout: 15000 }).toBeTruthy(); const completed = events.find(event => event.type === 'notification' && object(event.data).method === 'turn/completed' && object(object(object(event.data).params).turn).id === id)!; expect(object(object(object(completed.data).params).turn).status).toBe(status); };
    const created = object(await runtime.call('conversation/start', { cwd: project, text: 'First workflow message.' }, context)); const threadId = object(created.thread).id!; await done(object(created.turn).id!);
    expect(await runtime.call('thread/session', { threadId }, context)).toMatchObject({ requiresResume: false, model: 'harness-loopback-fixture' });
    expect(object(await runtime.call('thread/loaded/list', {}, context)).data).toContain(threadId);
    expect(await runtime.call('modelProvider/capabilities/read', {}, context)).toMatchObject({ imageGeneration: expect.any(Boolean), webSearch: expect.any(Boolean) });
    expect(Array.isArray(object(await runtime.call('permissionProfile/list', { cwd: project }, context)).data)).toBe(true);
    const originalRead = object(object(await runtime.call('thread/read', { threadId }, context)).readState);
    const unread = object(object(await runtime.call('thread/readState/update', { threadId, operation: { type: 'unread' }, expectedRevision: originalRead.revision! }, context)).readState);
    expect(unread.firstUnread).not.toBeNull(); await expect(runtime.call('thread/readState/update', { threadId, operation: { type: 'read' }, expectedRevision: originalRead.revision! }, context)).rejects.toMatchObject({ code: 'native_error', delivery: 'not_sent' });
    expect(object(object(await runtime.call('thread/readState/update', { threadId, operation: { type: 'read' }, expectedRevision: unread.revision! }, context)).readState).firstUnread).toBeNull();
    await runtime.call('thread/history', { threadId }, context);
    const modes = object(await runtime.call('collaborationMode/list', {}, context)); expect((modes.data as JsonValue[]).some(mode => object(mode).mode === 'plan')).toBe(true);
    await runtime.call('thread/settings/update', { threadId, collaborationMode: { mode: 'plan', settings: { model: 'harness-loopback-fixture', reasoning_effort: 'low', developer_instructions: null } } }, context);
    await expect.poll(async () => object(await runtime!.call('thread/session', { threadId }, context)).collaborationMode).toMatchObject({ mode: 'plan' });
    hold = true; const heldTurn = object(await runtime.call('turn/start', { threadId, text: 'Hold before queued work.' }, context)); const heldTurnId = object(heldTurn.turn).id!; await expect.poll(() => held.size, { timeout: 10000 }).toBeGreaterThan(0);
    const queued = object(object(await runtime.call('thread/queue/add', { threadId, text: 'Queued workflow message.', clientUserMessageId: randomUUID() }, context)).queuedSubmission);
    await runtime.call('thread/queue/update', { threadId, queuedSubmissionId: queued.id!, text: 'Edited queued message.' }, context);
    await expect(runtime.native.call('thread/queue/start', { threadId, queuedSubmissionId: queued.id! })).rejects.toMatchObject({ code: 'native_error' });
    await runtime.call('thread/goal/set', { threadId, objective: 'Paused local workflow goal.', status: 'paused', tokenBudget: 1000 }, context);
    expect(object(object(await runtime.call('thread/goal/get', { threadId }, context)).goal).status).toBe('paused');
    await runtime.call('thread/goal/set', { threadId, status: 'paused', tokenBudget: null }, context);
    expect(object(object(await runtime.call('thread/goal/get', { threadId }, context)).goal).tokenBudget).toBeNull();
    await runtime.call('thread/goal/set', { threadId, tokenBudget: 1000 }, context); await runtime.call('thread/goal/set', { threadId, status: 'paused' }, context);
    expect(object(object(await runtime.call('thread/goal/get', { threadId }, context)).goal).tokenBudget).toBe(1000);
    // An interrupted queue is deliberately retained across cold resume in the
    // fixed CLI; do not make persistence depend on OS-specific process death.
    // See rust-v0.164.0 app-server/tests/suite/v2/thread_queue.rs:560-691.
    await runtime.call('turn/interrupt', { threadId, turnId: heldTurnId }, context); await done(heldTurnId, 'interrupted');
    await runtime.close(); for (const item of held) item.destroy(); hold = false; runtime = await create();
    expect(object(await runtime.call('thread/queue/list', { threadId }, context)).data).toMatchObject([{ id: queued.id, text: 'Edited queued message.' }]);
    expect(await runtime.call('thread/session', { threadId }, context)).toEqual({ requiresResume: true });
    await runtime.call('thread/history', { threadId }, context); const resumeIndex = events.length; await runtime.call('thread/resume', { threadId }, context); expect(await runtime.call('thread/session', { threadId }, context)).toMatchObject({ requiresResume: false });
    expect(object(object(await runtime.call('thread/goal/get', { threadId }, context)).goal).tokenBudget).toBe(1000); await runtime.call('thread/goal/clear', { threadId }, context);
    expect(object(await runtime.call('thread/queue/list', { threadId }, context)).data).toMatchObject([{ id: queued.id, text: 'Edited queued message.' }]);
    await runtime.call('thread/history', { threadId }, context);
    const queuedTurn = object(await runtime.call('thread/queue/start', { threadId, queuedSubmissionId: queued.id! }, context)), second = object(queuedTurn.turn).id!;
    await expect.poll(() => events.slice(resumeIndex).find(event => event.type === 'notification' && object(event.data).method === 'turn/started' && object(object(event.data).params).threadId === threadId && object(object(object(event.data).params).turn).id === second), { timeout: 15000 }).toBeTruthy();
    await done(second); expect(object(await runtime.call('thread/queue/list', { threadId }, context)).data).toEqual([]);
    await runtime.call('thread/history', { threadId }, context);
    const fork = object(await runtime.call('thread/fork', { threadId, beforeTurnId: second }, context)); const forkId = object(fork.thread).id!; const forkHistory = JSON.stringify(await runtime.call('thread/history', { threadId: forkId }, context)); expect(forkHistory).toContain('First workflow message.'); expect(forkHistory).not.toContain('Edited queued message.');
    await runtime.call('thread/revert', { threadId, beforeTurnId: second }, context); await expect.poll(() => events.some(event => event.type === 'notification' && object(event.data).method === 'thread/reverted')).toBe(true);
    const reverted = JSON.stringify(await runtime.call('thread/history', { threadId }, context)); expect(reverted).not.toContain('Edited queued message.');
    const exported = object(await runtime.call('thread/export', { threadId, format: 'json' }, context)); expect(String(exported.content)).toContain('First workflow message.');
    hold = true; const active = object(await runtime.call('turn/start', { threadId, text: 'Hold this local turn.' }, context)); const activeId = object(active.turn).id!; await expect.poll(() => held.size, { timeout: 10000 }).toBeGreaterThan(0);
    await expect(runtime.call('turn/steer', { threadId, expectedTurnId: 'stale', text: 'No stale steering.' }, context)).rejects.toMatchObject({ code: 'turn_changed' });
    expect(await runtime.call('turn/steer', { threadId, expectedTurnId: activeId, text: 'Steered local input.', clientUserMessageId: randomUUID() }, context)).toEqual({ turnId: activeId });
    await runtime.call('turn/interrupt', { threadId, turnId: activeId }, context); await done(activeId, 'interrupted'); hold = false; for (const item of held) item.end();
    await runtime.call('thread/history', { threadId }, context);
    const review = object(await runtime.call('review/startNew', { cwd: project, target: { type: 'custom', instructions: 'Summarize the controlled fixture.' } }, context)); expect(review.reviewThreadId).toBe(object(review.thread).id); await done(object(review.turn).id!);
    expect(await runtime.call('thread/unsubscribe', { threadId: forkId }, context)).toMatchObject({ status: 'unsubscribed' });
    expect(await runtime.call('thread/session', { threadId: forkId }, context)).toEqual({ requiresResume: true }); await runtime.call('thread/history', { threadId: forkId }, context);
    await runtime.call('thread/delete', { threadId: forkId }, context); await expect(runtime.call('thread/read', { threadId: forkId }, context)).rejects.toMatchObject({ code: 'native_error' });
    expect(errors).toEqual([]); expect(requests).toBeGreaterThanOrEqual(4);
  } finally {
    await runtime?.close(); for (const item of held) item.destroy(); await new Promise<void>(resolve => { provider.close(() => resolve()); provider.closeAllConnections(); });
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(); expect(provider.listening).toBe(false);
  }
}, 60000);
