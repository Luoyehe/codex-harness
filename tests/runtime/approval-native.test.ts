import { expect, test } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { RuntimeService } from '../../src/runtime/service.js';
import { object, type JsonObject, type JsonValue, type RuntimeEvent } from '../../src/runtime/types.js';
import { nativeTestEnvironment } from '../fixtures/native-env.js';

function stream(res: ServerResponse, item: JsonObject, number: number) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  let sequence = 0;
  const event = (type: string, params: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...params })}\n\n`);
  const response = { id: `resp_approval_${number}`, object: 'response', created_at: Math.floor(Date.now() / 1000), model: 'harness-loopback-fixture', status: 'in_progress', output: [] };
  event('response.created', { response });
  event('response.output_item.added', { output_index: 0, item });
  event('response.output_item.done', { output_index: 0, item });
  event('response.completed', { response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
  res.end();
}

test('official CLI command approval keeps invalid answers pending, cancels without execution, then executes only after acceptance', async () => {
  const base = path.resolve('.work/approval-native'); mkdirSync(base, { recursive: true }); const root = mkdtempSync(path.join(base, 'run-'));
  const home = path.join(root, 'codex'), project = path.join(root, 'project'), temporary = path.join(root, 'tmp');
  for (const directory of [home, project, temporary]) mkdirSync(directory);
  const bin = process.env.HARNESS_TEST_CODEX_BIN ?? path.resolve('reference/runtime/codex-0.164.0/package/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
  const env = nativeTestEnvironment({ home: root, codexHome: home, temporary, fixtureApiKey: 'local-protocol-fixture' });
  expect(execFileSync(bin, ['--version'], { env, encoding: 'utf8', windowsHide: true }).trim()).toBe('codex-cli 0.164.0');
  let requests = 0; let nextTool = true; const errors: string[] = []; const received: JsonObject[] = [];
  const provider = createServer((req, res) => { void (async () => {
    if (req.method !== 'POST' || req.url !== '/v1/responses') throw new Error('Unexpected provider route');
    let bytes = 0; const chunks: Buffer[] = []; for await (const raw of req) { const chunk = Buffer.from(raw); bytes += chunk.length; if (bytes > 4 * 1024 * 1024) throw new Error('Fixture request budget exceeded'); chunks.push(chunk); }
    const request = object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); received.push(request); requests++;
    if (requests > 3) throw new Error('Native tool fixture exceeded request allowance');
    if (nextTool) { nextTool = false;
      const tools = request.tools as JsonObject[];
      expect(tools.some(tool => tool.name === 'exec_command')).toBe(true);
      stream(res, { id: `fc_${requests}`, type: 'function_call', call_id: `call_${requests}`, name: 'exec_command', arguments: JSON.stringify({ cmd: `node -e "require('fs').writeFileSync('approval-marker','ok')"`, workdir: project, sandbox_permissions: 'require_escalated', justification: 'Write the isolated approval test marker.', yield_time_ms: 1000 }), status: 'completed' }, requests);
    } else stream(res, { id: `msg_${requests}`, type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'Local approval fixture finished.', annotations: [] }] }, requests);
  })().catch(error => { errors.push(String(error)); res.destroy(); }); });
  let service: RuntimeService | undefined;
  try {
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const catalog = JSON.parse(readFileSync('tests/runtime/fixture-model-catalog.json', 'utf8')); catalog.models[0].shell_type = 'unified_exec';
    const catalogPath = path.join(root, 'catalog.json'); writeFileSync(catalogPath, JSON.stringify(catalog));
    writeFileSync(path.join(home, 'config.toml'), [
      'model = "harness-loopback-fixture"', 'model_provider = "local_fixture"', 'approval_policy = "on-request"', 'sandbox_mode = "read-only"', 'check_for_update_on_startup = false',
      `model_catalog_json = ${JSON.stringify(catalogPath)}`, '[model_providers.local_fixture]', 'name = "Local approval fixture"', `base_url = "http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1"`, 'env_key = "HARNESS_PROVIDER_API_KEY"', 'wire_api = "responses"', 'requires_openai_auth = false', 'supports_websockets = false', 'request_max_retries = 0', 'stream_max_retries = 0',
    ].join('\n') + '\n');
    service = await RuntimeService.create({ bin, home, workerHome: root, cwd: project, env, dev: true });
    const events: RuntimeEvent[] = []; service.on('event', event => events.push(event));
    const context = { clientId: 'approval-fixture' };
    const first = object(await service.call('conversation/start', { cwd: project, text: 'Perform the local approval fixture.', options: { approvalPolicy: 'on-request', sandbox: 'read-only' } }, context));
    const threadId = object(first.thread).id!;
    for (const [index, decision] of ['cancel', 'accept'].entries()) {
      const startIndex = index === 0 ? 0 : events.length;
      if (index) { nextTool = true; await service.call('thread/history', { threadId }, context); await service.call('turn/start', { threadId, text: 'Perform the approved local marker fixture.' }, context); }
      const prompt = () => events.slice(startIndex).find(event => event.type === 'prompt' && object(event.data).method === 'item/commandExecution/requestApproval');
      await expect.poll(() => prompt(), { timeout: 15000 }).toBeTruthy();
      expect(errors).toEqual([]); expect(existsSync(path.join(project, 'approval-marker'))).toBe(false);
      const promptId = object(prompt()!.data).promptId!;
      await expect(service.call('prompt/answer', { promptId, response: { decision: 'invalid-decision' } }, context)).rejects.toMatchObject({ code: 'invalid_params', delivery: 'not_sent' });
      expect((object(await service.call('prompt/list', {}, context)).prompts as JsonObject[]).some(p => p.promptId === promptId)).toBe(true);
      await service.call('prompt/answer', { promptId, response: { decision: decision! } }, context);
      await expect.poll(() => events.slice(startIndex).find(event => event.type === 'notification' && object(event.data).method === 'turn/completed'), { timeout: 15000 }).toBeTruthy();
      expect(existsSync(path.join(project, 'approval-marker'))).toBe(index === 1);
    }
    expect(readFileSync(path.join(project, 'approval-marker'), 'utf8')).toBe('ok');
    expect(requests).toBe(3); expect(errors).toEqual([]);
    expect((received[2]!.input as JsonValue[]).some(item => object(item).type === 'function_call_output')).toBe(true);
  } finally {
    try { await service?.close(); }
    finally { await new Promise<void>(resolve => { provider.close(() => resolve()); provider.closeAllConnections(); }); }
    if (service?.native.processId !== undefined) expect(() => process.kill(service!.native.processId!, 0)).toThrow();
    expect(provider.listening).toBe(false);
  }
}, 60000);
