import { visionReferenceGuidance } from '../../src/core/attachment-media.js';
import { Attachments } from '../../src/runtime/attachments.js';
import { expect, test } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { type AddressInfo } from 'node:net';
import { RuntimeService } from '../../src/runtime/service.js';
import { object, type JsonObject, type JsonValue, type RuntimeEvent } from '../../src/runtime/types.js';
import { nativeTestEnvironment } from '../fixtures/native-env.js';

const binary = process.env.HARNESS_TEST_CODEX_BIN;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAI0lEQVR4nGPsn7+RgRTARJJqhlENxAEmItXBwagGYgDJoQQA62sB/85+iZAAAAAASUVORK5CYII=', 'base64');
function referencedPath(text: string, filename: string): string {
  const prefix = `Attached file ${JSON.stringify(filename)} is available at `;
  // The optional tool guidance follows on a new line; the path is a JSON string literal.
  const [line] = text.split('\n', 1);
  if (!line?.startsWith(prefix) || !line.endsWith('.')) throw new Error('Missing attachment reference');
  const decoded: unknown = JSON.parse(line.slice(prefix.length, -1));
  if (typeof decoded !== 'string' || !path.isAbsolute(decoded)) throw new Error('Invalid attachment path');
  return decoded;
}
function answer(res: ServerResponse, item: JsonObject, n: number): void {
  const response = { id: 'rsp_' + n, object: 'response', status: 'completed', created_at: 1, model: 'fixture', output: [item], usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 } };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const [sequence_number, event] of [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }, { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }].entries())
    res.write('event: ' + event.type + '\ndata: ' + JSON.stringify({ sequence_number, ...event }) + '\n\n');
  res.end();
}
// Both the primary Responses endpoint and the last-hop vision endpoint bind to
// loopback. Only the native client and installed MCP package exercise real code.
test('official CLI routes native images and tool references, including a model-selected vision call', async () => {
  if (!binary) throw new Error('The visual routing test requires the pinned independent Codex CLI.');
  const visionMcp = createRequire(import.meta.url).resolve('@z_ai/mcp-server');
  const base = path.resolve('.work/visual-routing'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'run-')), home = path.join(root, 'codex'), temp = path.join(root, 'tmp');
  mkdirSync(home); mkdirSync(temp);
  const requests: JsonObject[] = [], visual: JsonObject[] = [], errors: string[] = [], events: RuntimeEvent[] = [];
  let chooseTool = false, failVision = false, attachmentPath = '', activeThread: JsonValue = null;
  const server = createServer((req, res) => { void (async () => {
    const chunks: Buffer[] = []; for await (const data of req) chunks.push(Buffer.from(data));
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    const body = object(JSON.parse(Buffer.concat(chunks).toString()));
    if (req.url === '/vision/chat/completions') {
      visual.push(body);
      if (failVision) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture-vision-service-unavailable' } })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'vision', choices: [{ message: { role: 'assistant', content: 'LOCAL_VISION_RESULT' } }] })); return;
    }
    if (req.url !== '/v1/responses') { res.writeHead(404); res.end(); return; }
    requests.push(body); const n = requests.length;
    if (chooseTool) {
      chooseTool = false;
      const tools = body.tools as JsonObject[], namespace = tools.find(row => JSON.stringify(row).includes('analyze_image') && row.type === 'namespace');
      const named = tools.find(row => typeof row.name === 'string' && row.name.endsWith('analyze_image'));
      const tool = namespace ? { namespace: namespace.name!, name: 'analyze_image' } : { name: named?.name ?? 'mcp__vision__analyze_image' };
      const userText = (body.input as JsonObject[]).filter(row => row.role === 'user')
        .flatMap(row => row.content as JsonObject[]).find(part => part.type === 'input_text' && String(part.text).startsWith('Attached file '));
      const source = referencedPath(String(userText?.text), 'sample.png');
      expect(source).toBe(attachmentPath);
      answer(res, { id: 'fc_' + n, type: 'function_call', call_id: 'call_' + n, ...tool, arguments: JSON.stringify({ image_source: source, prompt: 'Describe this local fixture.' }) }, n);
    } else answer(res, { id: 'msg_' + n, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Fixture reply.', annotations: [] }] }, n);
  })().catch(error => { errors.push(String(error)); res.destroy(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const catalog = path.join(home, 'catalog-default.json'), template = JSON.parse(readFileSync('tests/runtime/fixture-model-catalog.json', 'utf8')).models[0];
  writeFileSync(catalog, JSON.stringify({ models: ['text', 'image'].map(kind => ({ ...template, slug: 'fixture-' + kind, input_modalities: kind === 'text' ? ['text'] : ['text', 'image'] })) }));
  const lines = ['model = "fixture-text"', 'model_provider = "local_fixture"', 'approval_policy = "never"', 'sandbox_mode = "read-only"', 'check_for_update_on_startup = false', 'model_catalog_json = ' + JSON.stringify(catalog),
    '[model_providers.local_fixture]', 'name="Fixture"', 'wire_api="responses"', 'requires_openai_auth=false', 'base_url=' + JSON.stringify(url + '/v1')];
  const registry = { defaultProviderId: 'default', nativeCatalogProvider: 'local_fixture', connections: [{ id: 'default', name: 'Fixture', enabled: true, kind: 'responses', modelProvider: 'local_fixture', model: 'fixture-text', catalogPath: catalog,
    models: [{ id: 'fixture-text', inputModalities: ['text'], supportsTools: true }, { id: 'fixture-image', inputModalities: ['text', 'image'], supportsTools: false }] }] };
  const cfg = { bin: binary!, home, workerHome: root, cwd: root, env: nativeTestEnvironment({ home: root, codexHome: home, temporary: temp, fixtureApiKey: 'local-fixture' }), dev: true, providerRegistry: registry };
  let service: RuntimeService | undefined;
  const context = { clientId: 'fixture', eventChannelId: 'browser', beforeWrite: () => {} };
  const start = async (model: string, text: string): Promise<JsonObject[]> => {
    const image = object(await service!.call('attachment/upload', { name: 'sample.png', mimeType: 'application/octet-stream', base64: png.toString('base64') }, context));
    attachmentPath = path.join(root, 'attachments', String(image.attachmentId) + '.png');
    const before = requests.length;
    const result = object(await service!.call('conversation/start', { cwd: root, text, attachmentIds: [image.attachmentId!], options: { modelProvider: 'local_fixture', model } }, context));
    const turnId = object(result.turn).id; activeThread = object(result.thread).id!;
    await expect.poll(() => events.some(event => event.type === 'notification' && object(event.data).method === 'turn/completed' && object(object(object(event.data).params).turn).id === turnId), { timeout: 20000 }).toBe(true);
    return requests.slice(before);
  };
  const completedVisionCalls = (threadId: JsonValue) => events.flatMap(event => {
    if (event.type !== 'notification') return [];
    const notification = object(event.data);
    if (notification.method !== 'item/completed') return [];
    const params = object(notification.params), item = object(params.item);
    return params.threadId === threadId && item.type === 'mcpToolCall' ? [item] : [];
  });
  try {
    writeFileSync(path.join(home, 'config.toml'), lines.join('\n'));
    service = await RuntimeService.create(cfg); service.on('event', event => events.push(event));
    const native = await start('fixture-image', 'Inspect natively.');
    expect(JSON.stringify(native[0]!.input)).toContain('data:image/png;base64,'); expect(visual).toHaveLength(0);
    const direct = await start('fixture-text', 'Acknowledge the filename.');
    expect(JSON.stringify(direct[0]!.input)).toContain(path.basename(attachmentPath)); expect(JSON.stringify(direct)).not.toContain(png.toString('base64')); expect(visual).toHaveLength(0);
    expect(JSON.stringify(direct[0]!.tools)).not.toContain('analyze_image');
    expect(JSON.stringify(direct[0]!.input)).toContain(visionReferenceGuidance.trim());
    await service.close();
    const file = path.join(home, 'config.toml');
    const mcpLines = [...lines, '[mcp_servers.vision]', 'command=' + JSON.stringify(process.execPath), 'args=' + JSON.stringify([visionMcp]),
      'startup_timeout_sec=20','tool_timeout_sec=30','[mcp_servers.vision.env]', 'Z_AI_API_KEY="local-fixture"', 'Z_AI_BASE_URL=' + JSON.stringify(url + '/vision/'), 'ZAI_MCP_LOG_PATH=' + JSON.stringify(path.join(temp, 'vision.log'))];
    writeFileSync(file, mcpLines.map(line => line === '[mcp_servers.vision]' ? line + '\nenabled=false' : line).join('\n'));
    service = await RuntimeService.create(cfg); service.on('event', event => events.push(event));
    const disabled = await start('fixture-text', 'Answer the text even though the configured vision server is disabled.');
    expect(JSON.stringify(disabled[0]!.tools)).not.toContain('analyze_image');
    expect(JSON.stringify(disabled[0]!.input)).toContain(path.basename(attachmentPath));
    expect(JSON.stringify(disabled[0]!.input)).toContain(visionReferenceGuidance.trim());
    expect(JSON.stringify(disabled[0]!.input)).not.toContain(png.toString('base64'));
    expect(disabled).toHaveLength(1); expect(visual).toHaveLength(0); expect(completedVisionCalls(activeThread)).toEqual([]);
    await service.close();
    writeFileSync(file, mcpLines.join('\n'));
    service = await RuntimeService.create(cfg); service.on('event', event => events.push(event)); chooseTool = true;
    const denied = await start('fixture-text', 'Try the available vision tool under the configured never-approve policy.');
    expect(visual).toHaveLength(0); expect(JSON.stringify(denied.at(-1)!.input)).toContain('approval');
    await service.close();
    writeFileSync(file, readFileSync(file, 'utf8').replace('approval_policy = "never"', 'approval_policy = "on-request"'));
    service = await RuntimeService.create(cfg); service.on('event', event => {
      events.push(event);
      if (event.type === 'prompt') {
        const prompt = object(event.data), body = object(prompt.params);
        writeFileSync(path.join(temp, 'prompt.json'), JSON.stringify({ method: prompt.method, params: body }));
        if (prompt.method === 'mcpServer/elicitation/request' && body.serverName === 'vision') void service!.call('prompt/answer', {
          promptId: prompt.promptId!, response: { action: 'accept', content: {} }
        }, context).catch(error => errors.push(String(error)));
      }
    }); chooseTool = true;
    const called = await start('fixture-text', 'Use the available vision tool to read this local sample.');
    expect(JSON.stringify(called[0]!.input)).not.toContain(png.toString('base64'));
    expect(visual).toHaveLength(1); expect(JSON.stringify(visual[0])).toContain('data:image/png;base64,' + png.toString('base64'));
    expect(JSON.stringify(called.at(-1)!.input)).toContain('LOCAL_VISION_RESULT'); expect(errors).toEqual([]);
    expect(completedVisionCalls(activeThread)).toMatchObject([{ server: 'vision', tool: 'analyze_image', status: 'completed' }]);
    const optional = await start('fixture-text', 'Just acknowledge receipt of the attachment.');
    expect(optional).toHaveLength(1); expect(completedVisionCalls(activeThread)).toEqual([]);
    expect(visual).toHaveLength(1);
    const media = path.resolve('tests/fixtures/visual-media');
    {
      const scenarios = [
        ['jpg','image/jpeg','image/jpeg'], ['png','image/png','image/png'],
        ['gif','image/gif','image/gif'], ['webp','image/webp','image/webp'],
        ['mp4','video/mp4','video/quicktime'], ['mov','video/quicktime','video/mp4'],
        ['mp4','video/mp4','application/octet-stream'], ['mov','video/quicktime','application/octet-stream'],
        ['mov','video/quicktime','legacy'], ['mov','video/quicktime','','sample-classic.mov'],
      ];
      for (const [extension, mime, declared, fileName] of scenarios as [string,string,string,string?][]) {
        const bytes = readFileSync(path.join(media, fileName ?? 'sample.' + extension));
        let file: string;
        if (declared === 'legacy') {
          const legacyRoot = mkdtempSync(path.join(root, 'older-')), store = new Attachments(legacyRoot);
          const uploaded = object(store.upload({name:'old-record',mimeType:mime,base64:bytes.toString('base64')},'owner'));
          const dir=path.join(legacyRoot,'attachments'), bare=String(uploaded.attachmentId);
          renameSync(path.join(dir,bare+'.mov'),path.join(dir,bare));
          const indexFile=path.join(dir,'index.json'), index=JSON.parse(readFileSync(indexFile,'utf8'));
          delete index.entries[0].fileName; index.entries[0].mimeType='application/octet-stream'; writeFileSync(indexFile,JSON.stringify(index));
          const restored=new Attachments(legacyRoot);
          const part=object(restored.prepare([bare],String(activeThread)).input[0]);
          file = referencedPath(String(part.text), 'old-record');
          expect(file).toBe(path.join(dir, bare + '.mov'));
          expect(readFileSync(file)).toEqual(readFileSync(path.join(dir, bare)));
        } else {
          const upload = object(await service.call('attachment/upload', { name: 'clipboard', mimeType: declared, base64: bytes.toString('base64') }, context));
          expect(upload.mimeType).toBe(mime);
          file=path.join(root,'attachments',String(upload.attachmentId)+'.'+extension);
        }
        const before=visual.length, video=mime.startsWith('video/');
        let history = object(await service.call('thread/history', { threadId: activeThread }, context));
        while (!history.complete) history = object(await service.call('thread/history', { threadId: activeThread, cursor: history.nextCursor! }, context));
        const receipt = object(await service.call('mcp/tool/call', { threadId: activeThread, server: 'vision', tool: video ? 'analyze_video' : 'analyze_image',
          arguments: { [video ? 'video_source' : 'image_source']: file, prompt: 'Read the local fixture.' } }, context));
        const result = object(await service.call('mcp/result/read', { resultId: receipt.resultId! }, context));
        if (extension === 'gif' || extension === 'webp') { expect(visual.length).toBe(before); expect(JSON.stringify(result)).toMatch(/unsupported image format/i); }
        else { expect(visual.length).toBe(before + 1); expect(JSON.stringify(visual.at(-1))).toContain('data:' + mime + ';base64,' + bytes.toString('base64')); }
      }
    }
    const beforeFailure = visual.length;
    chooseTool = true; failVision = true;
    const failed = await start('fixture-text', 'Inspect this image with the available tool.');
    expect(visual.length).toBeGreaterThan(beforeFailure); expect(JSON.stringify(failed.at(-1)!.input)).toMatch(/503|fixture-vision-service-unavailable/);
    const failures = completedVisionCalls(activeThread);
    expect(failures).toMatchObject([{ server: 'vision', tool: 'analyze_image', status: 'failed' }]);
    expect(JSON.stringify(failures)).toMatch(/503|fixture-vision-service-unavailable/);
    expect(errors).toEqual([]);
  } finally { await service?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 90000);
