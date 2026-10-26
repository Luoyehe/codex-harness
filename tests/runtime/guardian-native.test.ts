import { expect, test } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeService } from '../../src/runtime/service.js';
import { object, type JsonObject, type JsonValue, type RuntimeEvent } from '../../src/runtime/types.js';
import { PtyTranscript } from './pty-transcript.js';
function stream(res: ServerResponse, item: JsonObject, n: number) {
  const response = { id: `response_${n}`, object: 'response', created_at: 1, status: 'completed', model: 'harness-loopback-fixture', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const [sequence_number, event] of [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }, { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }].entries()) res.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`);
  res.end();
}
async function fixture(guardian: boolean | 'permissions') {
  const base = path.resolve('.work/guardian-native-tests'); mkdirSync(base, { recursive: true }); const root = mkdtempSync(path.join(base, 'home-')), home = path.join(root, 'codex'), temp = path.join(root, 'tmp'); mkdirSync(home); mkdirSync(temp);
  const requests: JsonObject[] = [], errors: string[] = [];
  const server = createServer((req, res) => { void (async () => {
    if (req.url !== '/v1/responses' || req.method !== 'POST') { req.resume(); res.writeHead(503); res.end('Local fixture rejects network access'); return; }
    let bytes = 0; const chunks: Buffer[] = []; for await (const chunk of req) { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) throw new Error('Fixture request cap'); chunks.push(chunk); }
    const body = object(JSON.parse(Buffer.concat(chunks).toString())); requests.push(body); const n = requests.length;
    if (!guardian || n > 4) throw new Error('Unexpected model request');
    const item: JsonObject = n === 1 ? { id: 'call_fixture', type: 'function_call', call_id: 'fixture', name: guardian === 'permissions' ? 'request_permissions' : 'exec_command', arguments: JSON.stringify(guardian === 'permissions' ? { permissions: { file_system: { read: [root], write: [root] } }, reason: 'Isolated permission fixture.' } : { cmd: 'echo guarded-fixture', sandbox_permissions: 'require_escalated', justification: 'Isolated local guardian contract fixture.' }), status: 'completed' } : { id: `message_${n}`, type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: JSON.stringify({ outcome: 'deny', rationale: 'Isolated fixture denial', risk_level: 'low', user_authorization: 'low' }), annotations: [] }] };
    stream(res, item, n);
  })().catch(error => { errors.push(String(error)); res.destroy(); }); });
  server.on('connect', (_req, socket) => socket.end('HTTP/1.1 503 Denied\r\nContent-Length: 0\r\n\r\n'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, catalog = path.join(root, 'models.json');
  const models = JSON.parse(readFileSync('tests/runtime/fixture-model-catalog.json', 'utf8')); if (guardian) models.models[0].shell_type = 'unified_exec'; writeFileSync(catalog, JSON.stringify(models));
  writeFileSync(path.join(home, 'config.toml'), `check_for_update_on_startup=false\nmodel="harness-loopback-fixture"\nmodel_provider="fixture"\nmodel_catalog_json=${JSON.stringify(catalog)}\napproval_policy="on-request"\napprovals_reviewer="auto_review"\nsandbox_mode="read-only"\n[projects.${JSON.stringify(root)}]\ntrust_level="trusted"\n[model_providers.fixture]\nname="Fixture"\nbase_url="${url}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\nrequest_max_retries=0\nstream_max_retries=0\n`);
  if (guardian === 'permissions') writeFileSync(path.join(home, 'config.toml'), `${readFileSync(path.join(home, 'config.toml'), 'utf8')}\n[features]\nrequest_permissions_tool=true\n`);
  const env: NodeJS.ProcessEnv = { HOME: root, USERPROFILE: root, CODEX_HOME: home, TEMP: temp, TMP: temp, HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url, NO_PROXY: '127.0.0.1' }; for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC']) if (process.env[key]) env[key] = process.env[key];
  const config = { bin: process.env.HARNESS_TEST_CODEX_BIN!, home, workerHome: root, cwd: root, env, dev: true }, service = await RuntimeService.create(config), events: RuntimeEvent[] = []; service.on('event', event => events.push(event));
  const context = { clientId: 'fixture', eventChannelId: 'channel', beforeWrite: () => {} };
  return { root, home, service, events, requests, errors, context, close: async () => { await service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
test.each([true, 'permissions'] as const)('real CLI denial %s is captured once and approval inserts an exact-action marker without starting a turn', async kind => {
  const f = await fixture(kind); try {
    const created = object(await f.service.call('conversation/start', { cwd: f.root, text: 'Inspect the harmless command.' }, f.context)), threadId = object(created.thread).id!;
    await expect.poll(() => f.events.some(event => event.type === 'notification' && object(event.data).method === 'turn/completed'), { timeout: 15000 }).toBe(true);
    const denial = object((object(await f.service.call('thread/guardian/list', { threadId }, f.context)).data as JsonValue[])[0]);
    expect(denial.review).toMatchObject({ status: 'denied', rationale: 'Isolated fixture denial' }); expect(denial.action).toMatchObject(kind === 'permissions' ? { type: 'requestPermissions', permissions: { fileSystem: { read: [f.root], write: [f.root] } } } : { type: 'command', source: 'unifiedExec' }); expect(f.requests).toHaveLength(3);
    await f.service.call('thread/history', { threadId }, f.context);
    expect(await f.service.call('thread/approveGuardianDeniedAction', { threadId, approvalId: denial.approvalId!, confirm: true }, f.context)).toEqual({ threadId, approvalId: denial.approvalId, registered: true });
    await expect(f.service.call('thread/approveGuardianDeniedAction', { threadId, approvalId: denial.approvalId!, confirm: true }, f.context)).rejects.toMatchObject({ code: 'guardian_already_used' });
    expect(f.requests).toHaveLength(3); await expect(f.service.call('turn/start', { threadId, text: 'Read only.' }, f.context)).rejects.toMatchObject({ code: 'history_incomplete' });
    await f.service.call('thread/history', { threadId }, f.context); await f.service.call('turn/start', { threadId, text: 'Read the context; do not run the command.' }, f.context);
    await expect.poll(() => f.requests.length, { timeout: 15000 }).toBe(4);
    const input = f.requests[3]!.input as JsonValue[], marker = input.map(value => object(value)).filter(value => value.role === 'developer').flatMap(value => value.content as JsonValue[]).map(value => object(value).text).find(value => typeof value === 'string' && value.includes('The user has manually approved a specific action'));
    expect(marker).toContain('Do not assume this also authorizes similar operations');
    const action = object(object(JSON.parse(String(marker).split('Approved action:\n')[1]!)).action);
    if (kind === 'permissions') expect(action).toEqual({ type: 'request_permissions', reason: 'Isolated permission fixture.', permissions: { network: null, file_system: { read: [f.root], write: [f.root] } } });
    else expect(action).toEqual({ type: 'command', source: 'unified_exec', command: object(denial.action).command, cwd: f.root });
    expect(f.errors).toEqual([]);
    expect(object(await f.service.call('thread/guardian/list', { threadId }, f.context)).data).toEqual([]);
  } finally { await f.close(); }
}, 30000);
test('fixed native CLI PTY exposes the real hook trust flow, makes zero model calls and requires restart after proven cleanup', async () => {
  const f = await fixture(false); let terminalId: JsonValue | undefined, unansweredQueries = 0;
  const transcript = new PtyTranscript(), pending: Promise<unknown>[] = [], replyErrors: unknown[] = [];
  const phases: { phase: string; at: number; monotonicMs: number; outputLength: number; hasReview: boolean; hasTrustAll: boolean }[] = [];
  const phase = (name: string) => { phases.push({ phase: name, at: Date.now(), monotonicMs: performance.now(), outputLength: transcript.mark(), hasReview: transcript.tail.includes('Hooks need review'), hasTrustAll: transcript.tail.includes('trust all') }); };
  const answerQueries = () => {
    if (!terminalId) return;
    while (unansweredQueries > 0) {
      unansweredQueries--;
      pending.push(f.service.call('terminal/write', { terminalId, text: '\x1b[1;1R' }, f.context).catch(error => { replyErrors.push(error); }));
    }
  };
  const waitForMenu = async (mark: number, content: string[]) => {
    await expect.poll(() => content.filter(value => !transcript.since(mark).includes(value)), { timeout: 10000 }).toEqual([]);
    return performance.now();
  };
  const confirmMenu = async (visibleAt: number) => {
    // Pinned CLI 0.164.0 intentionally consumes another legacy Enter for one
    // second after a view transition (activation_key_guard.rs:9-10,46-49).
    // Measure from the observed menu, which is later than its activation. This
    // is a distinct user press, not a retry of a deliberately discarded key.
    // https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/tui/src/activation_key_guard.rs
    const freshAfter = visibleAt + 1000;
    while (performance.now() <= freshAfter) await delay(Math.max(1, Math.ceil(freshAfter - performance.now() + 1)));
    await f.service.call('terminal/write', { terminalId: terminalId!, text: '\r' }, f.context);
  };
  writeFileSync(path.join(f.home, 'hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo isolated-hook-not-executed' }] }] } }));
  f.service.on('event', (event: RuntimeEvent) => { if (event.type === 'terminal' && object(event.data).type === 'output') { unansweredQueries += transcript.append(Buffer.from(String(object(event.data).deltaBase64), 'base64')); answerQueries(); } });
  try {
    terminalId = object(await f.service.call('terminal/open', { cwd: f.root, program: 'codex', rows: 40, cols: 120 }, f.context)).terminalId!;
    answerQueries();
    await waitForMenu(0, ['OpenAI Codex', 'Ask Codex to do anything']);
    phase('initial-screen');
    for (const [method, params] of [['conversation/start', { cwd: f.root, text: 'must not start' }], ['thread/goal/set', { threadId: 'other', objective: 'blocked' }], ['settings/write', { expectedVersion: 'stale', changes: [] }], ['terminal/open', { cwd: f.root }]] as [string, JsonObject][]) await expect(f.service.call(method, params, f.context)).rejects.toMatchObject({ code: 'native_cli_busy' });
    phase('before-hooks'); let mark = transcript.mark();
    await f.service.call('terminal/write', { terminalId, text: '/hooks\r' }, f.context);
    let visibleAt = await waitForMenu(mark, ['Hooks need review', '1. Review hooks', 'enter confirm · esc skip']);
    phase('review-menu-ready'); mark = transcript.mark();
    await confirmMenu(visibleAt); phase('review-enter-sent');
    visibleAt = await waitForMenu(mark, ['Lifecycle hooks from config and enabled plugins.', 'UserPromptSubmit', 't trust all · enter review · esc close']);
    phase('trust-all-visible');
    mark = transcript.mark();
    await confirmMenu(visibleAt); phase('detail-enter-sent');
    await waitForMenu(mark, ['UserPromptSubmit hooks', 'echo isolated-hook-not-executed', 't trust · esc back']);
    phase('hook-detail-ready');
    await f.service.call('terminal/write', { terminalId, text: 't' }, f.context);
    await expect.poll(async () => JSON.stringify(await f.service.call('hooks/list', { cwd: f.root }, f.context)), { timeout: 10000 }).toContain('"trustStatus":"trusted"');
    await Promise.all(pending); expect(replyErrors).toEqual([]);
    await f.service.call('terminal/close', { terminalId }, f.context);
    expect(object(object(f.service.status()).activity)).toMatchObject({ terminals: 0, unknown: true }); expect(f.requests).toHaveLength(0); expect(f.errors).toEqual([]);
    await expect(f.service.call('thread/start', { cwd: f.root }, f.context)).rejects.toMatchObject({ code: 'activity_unknown' });
  } catch (error) {
    phase('failure');
    // Only this isolated, zero-credential fixture is included. Preserve actual
    // PTY frames so CI failures distinguish input ordering from terminal render.
    console.error(JSON.stringify({ fixture: 'guardian-native-hook-pty', phases, runtime: f.service.status(), terminalTail: transcript.tail.slice(-16000) }));
    throw error;
  } finally {
    writeFileSync(path.join(f.root, 'hook-pty-transcript.json'), JSON.stringify({ phases, terminalTail: transcript.tail }));
    await f.close();
  }
}, 45000);

test('fixed cloud PTY reports actual missing ChatGPT auth and releases its tree only with a restart requirement', async () => {
  const f = await fixture(false); let text = '';
  f.service.on('event', (event: RuntimeEvent) => { if (event.type === 'terminal' && object(event.data).type === 'output') text = (text + Buffer.from(String(object(event.data).deltaBase64), 'base64').toString()).slice(-262144); });
  try {
    const result = object(await f.service.call('terminal/open', { cwd: f.root, program: 'codex-cloud', rows: 30, cols: 100 }, f.context)); expect(typeof result.terminalId).toBe('string');
    await expect.poll(() => f.events.some(event => event.type === 'terminal' && object(event.data).type === 'exit'), { timeout: 10000 }).toBe(true);
    expect(text).toContain('Not signed in.'); expect(text).toContain('codex login'); expect(f.requests).toHaveLength(0); expect(f.errors).toEqual([]);
    expect(object(object(f.service.status()).activity)).toMatchObject({ terminals: 0, unknown: true });
    await expect(f.service.call('thread/start', { cwd: f.root }, f.context)).rejects.toMatchObject({ code: 'activity_unknown' });
  } finally { await f.close(); }
}, 20000);
