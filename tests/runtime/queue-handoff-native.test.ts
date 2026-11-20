import { expect, test } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeService } from '../../src/runtime/service.js';
import { InputContext } from '../../src/runtime/input-context.js';
import { object, type JsonObject, type JsonValue } from '../../src/runtime/types.js';
import { nativeTestEnvironment } from '../fixtures/native-env.js';
import { withFixtureCleanup } from './fixture-cleanup.js';
import { loopbackProvider } from './loopback-provider.js';
import { expectNativeClosed } from './process-identity.js';

// Real, differently coloured PNG files with uncompressed IDAT payloads near 2.4 MiB.
function largePng(index: number, width = 900, height = 930): Buffer {
  const stride = 1 + width * 3;
  const pixels = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width * 3; col++) pixels[row * stride + col + 1] = (row * 11 + col * 23 + index * 47) & 255;
  }
  const chunk = (type: string, content: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), content]), head = Buffer.alloc(4), tail = Buffer.alloc(4);
    head.writeUInt32BE(content.length); tail.writeUInt32BE(crc32(body)); return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Only the stopped private fixture database is edited. Keep the CLI's original
 * row/identity and combine four actual paths as serialized by that exact binary. */
function combineNativeQueueImages(home: string, threadId: string, firstClient: string): number {
  const db = new DatabaseSync(path.join(home, 'queue_1.sqlite'));
  try {
    db.exec('BEGIN IMMEDIATE');
    const rows = db.prepare('SELECT payload_json FROM queued_items WHERE thread_id=?').all(threadId)
      .map(row => ({ raw: String(row.payload_json), input: object(JSON.parse(String(row.payload_json))) }));
    expect(rows).toHaveLength(4);
    const first = rows.find(row => object(row.input.UserInput).client_id === firstClient)!;
    const content = object(first.input.UserInput).content as JsonValue[];
    for (const row of rows) if (row !== first) {
      const images = (object(row.input.UserInput).content as JsonValue[]).filter(value => object(value).type === 'image');
      expect(images.length).toBe(1); content.push(images[0]!);
      expect(db.prepare('DELETE FROM queued_items WHERE thread_id=? AND payload_json=?').run(threadId, row.raw).changes).toBe(1);
    }
    const payload = JSON.stringify(first.input), bytes = Buffer.byteLength(payload);
    expect(bytes).toBeGreaterThan(12 * 1024 * 1024);
    expect(db.prepare('UPDATE queued_items SET payload_json=? WHERE thread_id=? AND payload_json=?').run(payload, threadId, first.raw).changes).toBe(1);
    db.exec('COMMIT');
    return bytes;
  } finally { db.close(); }
}

test.each(['tool-reference to image', 'image to tool-reference', 'oversized native image queue to tool-reference', 'acknowledged wide native image with update to tool-reference', 'four images admitted in one native request', 'two identical uploaded files restored by slot', 'four native images auto-consume under the original model', 'four native images started explicitly after cold resume'] as const)(
  'real CLI restores the deleted queue entry and opaque context once after restart: %s',
  async direction => withFixtureCleanup(async defer => {
  const parent = path.resolve('.work/queue-handoff-native'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'run-')); defer(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'codex'), cwd = path.join(root, 'project'), temporary = path.join(root, 'temp');
  for (const dir of [home, cwd, temporary]) mkdirSync(dir);
  const env = nativeTestEnvironment({ home: root, codexHome: home, temporary, fixtureApiKey: 'fixture-local' });
  const bin = process.env.HARNESS_TEST_CODEX_BIN ?? path.resolve('reference/runtime/codex-0.169.0/package/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
  expect(execFileSync(bin, ['--version'], { env, encoding: 'utf8' }).trim()).toBe('codex-cli 0.169.0');
  let held = true; let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const coldConsumption = direction === 'four native images started explicitly after cold resume';
  const originalConsumption = coldConsumption || direction === 'four native images auto-consume under the original model';
  const provider = await loopbackProvider('Fixture response', () => held ? paused : Promise.resolve(), originalConsumption ? 24 * 1024 * 1024 : undefined);
  defer(() => provider.close()); defer(() => { held = false; release(); });
  const textModel = 'harness-loopback-fixture', imageModel = 'harness-vision-fixture';
  const initialModel = direction === 'tool-reference to image' ? textModel : imageModel;
  const targetModel = initialModel === textModel ? imageModel : textModel;
  const catalog = JSON.parse(readFileSync('tests/runtime/fixture-model-catalog.json', 'utf8'));
  catalog.models.push({ ...catalog.models[0], slug: imageModel, input_modalities: ['text', 'image'] });
  const catalogFile = path.join(root, 'models.json'); writeFileSync(catalogFile, JSON.stringify(catalog));
  writeFileSync(path.join(home, 'config.toml'), [`model = "${initialModel}"`, 'model_provider = "local_fixture"',
    'approval_policy = "never"', 'sandbox_mode = "read-only"', `model_catalog_json = ${JSON.stringify(catalogFile)}`,
    '[model_providers.local_fixture]', 'name = "Local fixture"', `base_url = "${provider.url}"`,
    'env_key = "HARNESS_PROVIDER_API_KEY"', 'wire_api = "responses"', 'requires_openai_auth = false',
    'supports_websockets = false', 'request_max_retries = 0', 'stream_max_retries = 0'].join('\n'));
  const registry = { defaultProviderId: 'default', nativeCatalogProvider: 'local_fixture', connections: [
    { id: 'default', modelProvider: 'local_fixture', enabled: true, kind: 'responses', name: 'Local', model: initialModel,
      models: [{ id: textModel, inputModalities: ['text'], supportsTools: true }, { id: imageModel, inputModalities: ['text', 'image'], supportsTools: false }] }] };
  const create = () => RuntimeService.create({ bin, home, workerHome: root, cwd, env, dev: true, providerRegistry: registry });
  const actor = { clientId: 'handoff-fixture' };
  let runtime = await create(); const first = runtime.native;
  defer(() => runtime.close());
  const created = object(await runtime.call('conversation/start', { cwd, text: 'Hold to stage a queue entry.' }, actor));
  const threadId = String(object(created.thread).id);
  await expect.poll(provider.calls, { timeout: 10000 }).toBe(1);
  await runtime.call('thread/history', { threadId }, actor);
  const natural = direction === 'four images admitted in one native request' || originalConsumption;
  const paired = direction === 'two identical uploaded files restored by slot';
  const large = direction === 'oversized native image queue to tool-reference' || natural;
  const small = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAI0lEQVR4nGPsn7+RgRTARJJqhlENxAEmItXBwagGYgDJoQQA62sB/85+iZAAAAAASUVORK5CYII=', 'base64');
  const wide = direction === 'acknowledged wide native image with update to tool-reference';
  const images = large ? [0, 1, 2, 3].map(i => largePng(i)) : wide ? [largePng(9, 4096, 240)] : paired ? [small, small] : [small];
  const messageText = 'Keep this queued message exactly once' +
    (originalConsumption ? '\n' + 'Fixture observation from a long document.\n'.repeat(16_000) : '');
  const filenames: string[] = [], firstClient = randomUUID();
  let queued: JsonObject = {};
  const uploads = await Promise.all(images.map((image, i) => runtime.call('attachment/upload', {
    name: 'opaque-' + i + '.png', mimeType: 'image/png', base64: image.toString('base64') }, actor).then(value => object(value))));
  const trustedFile = '已选文件的不可编辑快照', revision = createHash('sha256').update(trustedFile).digest('hex');
  for (const [index, uploaded] of uploads.entries()) {
    filenames.push(path.join(root, 'attachments', uploaded.attachmentId + '.png'));
    if ((natural || paired) && index > 0) continue;
    const ids = natural || paired ? uploads.map(row => row.attachmentId!).reverse() : [uploaded.attachmentId!];
    const entry = object(object(await runtime.call('thread/queue/add', { threadId, text: index ? 'Other fixture row' : messageText,
      attachmentIds: ids, clientUserMessageId: index ? randomUUID() : firstClient,
      ...(index ? {} : { extraContext: [{ label: 'note', text: '保留原附加上下文' },
        ...(natural ? [{ label: 'source snapshot', text: trustedFile }] : [])] }) }, { ...actor, operationId: randomUUID() })).queuedSubmission);
    if (!index) queued = entry;
  }
  const queuedId = queued.id; expect(typeof queuedId).toBe('string');
  if (typeof queuedId !== 'string') throw new Error('Native queue did not return an ID');
  if (wide) {
    const firstImage = (queued.input as JsonValue[]).map(value => object(value)).find(row => row.type === 'image')!;
    const nativeBytes = Buffer.from(String(firstImage.url).split(',')[1]!, 'base64');
    expect(nativeBytes.length).toBeGreaterThan(0); expect(nativeBytes.equals(images[0]!)).toBe(false);
    const updated = object(object(await runtime.call('thread/queue/update', { threadId, queuedSubmissionId: queuedId,
      text: 'Keep this queued message exactly once' }, { ...actor, operationId: randomUUID() })).queuedSubmission);
    const changed = (updated.input as JsonValue[]).map(value => object(value)).find(row => row.type === 'image')!;
    expect(String(changed.url)).toBe(firstImage.url);
    queued = updated;
  }
  const contextReader = new InputContext({ extension: async () => ({}), file: async () => ({ path: 'source.txt', kind: 'file', revision, editable: true, text: trustedFile }) });
  const reference = await contextReader.prepare(cwd, [{ type: 'file', path: 'source.txt', revision }], undefined, actor, threadId);
  if (natural) {
    expect(queued.clientUserMessageId).toBe(firstClient);
    const list = object(await runtime.call('thread/queue/list', { threadId }, actor));
    expect(list.data).toMatchObject([{ id: queuedId, clientUserMessageId: firstClient, metadataOnly: true, oversized: true }]);
    expect(object(await runtime.native.call('thread/read', { threadId, includeTurns: false })).thread).toMatchObject({ id: threadId });
    expect(provider.calls()).toBe(1);
  } else {
    const original = [...queued.input as JsonValue[], ...reference.queuedInput];
    await runtime.native.call('thread/queue/update', { threadId, queuedSubmissionId: queuedId, input: original });
    expect(JSON.stringify(original)).toContain('保留原附加上下文');
    expect(JSON.stringify(original)).toContain(trustedFile);
    expect(original.some(row => ['localImage', 'image'].includes(String(object(row).type)))).toBe(initialModel === imageModel);
  }
  if (originalConsumption) {
    const finished: string[] = [], lost: string[] = [], notices: JsonObject[] = [];
    const observe = () => {
      runtime.native.on('fatal', error => lost.push(String(error)));
      runtime.native.on('notification', (event: JsonObject) => {
        const params = object(event.params);
        if (event.method === 'turn/completed') finished.push(String(object(params.turn).id));
        if (event.method === 'item/started' && object(params.item).type === 'userMessage') notices.push(params);
      });
    };
    observe();
    if (coldConsumption) {
      await runtime.call('turn/interrupt', { threadId, turnId: object(created.turn).id! }, actor);
      await expect.poll(() => finished.length, { timeout: 10000 }).toBe(1);
      await runtime.close();
      lost.length = 0;
      runtime = await create();
      observe();
      held = false; release();
      await runtime.call('thread/history', { threadId }, actor);
      await runtime.call('thread/resume', { threadId }, actor);
      const retained = object(await runtime.call('thread/queue/list', { threadId }, actor));
      expect(retained.data).toMatchObject([{ id: queuedId, oversized: true }]);
      await runtime.call('thread/queue/start', { threadId, queuedSubmissionId: queuedId }, actor);
    } else { held = false; release(); }
    await expect.poll(() => ({ completed: finished.length, received: provider.calls(), lost }), { timeout: 12000 })
      .toEqual({ completed: 2, received: 2, lost: [] });
    const modelRequest = JSON.stringify(provider.inputs()[1]);
    for (const image of images) expect(modelRequest.includes(image.toString('base64'))).toBe(true);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.threadId).toBe(threadId);
    const parts = object(notices[0]!.item).content as JsonValue[];
    expect(parts.some(value => object(value).text === messageText)).toBe(true);
    expect(modelRequest.includes(JSON.stringify(messageText).slice(1, -1))).toBe(true);
    expect(JSON.stringify(notices)).not.toContain('base64,');
    expect(runtime.native.connected).toBe(true);
    expect(object(await runtime.call('thread/queue/list', { threadId }, actor)).data).toEqual([]);
    // Reread the persisted transcript, not the live preview. The native item
    // reply itself includes the original four inline images. Exact exports
    // must not silently replace them with the browser's display notices.
    const currentNative = runtime.native;
    await runtime.close(); expectNativeClosed(currentNative); runtime = await create();
    for (const mode of [{}, { intent: 'window' }]) {
      const page = object(await runtime.call('thread/history', {
        threadId, limit: 30, timelineFormat: 'references', ...mode,
      }, actor));
      const items = (page.turns as JsonValue[]).flatMap(turn => object(turn).items as JsonValue[]).map(item => object(item));
      const user = items.find(item => item.type === 'userMessage' && (item.content as JsonValue[]).some(part => object(part).text === messageText));
      expect(user).toBeDefined();
      expect((user!.content as JsonValue[]).filter(part => String(object(part).text).includes('历史预览省略图片内容'))).toHaveLength(4);
      expect(items.some(item => item.type === 'agentMessage' && item.text === 'Fixture response')).toBe(true);
      expect(JSON.stringify(page).includes('data:image/')).toBe(false);
    }
    await expect(runtime.call('thread/export', { threadId, format:'json' }, actor)).rejects.toMatchObject({code: 'capacity'});
    expect(runtime.native.connected).toBe(true);
    return;
  }
  // The native queue still owns the original entry. A cold read must retain the
  // managed file even when the CLI stored only an inline image and no pathname.
  await runtime.close(); expectNativeClosed(first);
  let nativeBytes: number | undefined;
  if (natural) {
    const db = new DatabaseSync(path.join(home, 'queue_1.sqlite'), { readOnly: true });
    try {
      const rows = db.prepare('SELECT payload_json FROM queued_items WHERE thread_id=?').all(threadId);
      expect(rows).toHaveLength(1);
      const raw = String(rows[0]!.payload_json);
      expect(object(object(JSON.parse(raw)).UserInput).client_id).toBe(firstClient);
      nativeBytes = Buffer.byteLength(raw); expect(nativeBytes).toBeGreaterThan(12 * 1024 * 1024);
    } finally { db.close(); }
  } else if (large) nativeBytes = combineNativeQueueImages(home, threadId, firstClient);
  held = false; release();
  runtime = await create();
  for (const [index, filename] of filenames.entries()) expect(readFileSync(filename).equals(images[index]!)).toBe(true);
  expect(object(await runtime.call('thread/queue/list', { threadId }, actor)).data).toMatchObject([
    { id: queuedId, ...(large ? { metadataOnly: true, containsMedia: true, oversized: true, bytes: nativeBytes } : {}) }]);
  expect(provider.calls()).toBe(1);
  const backup = object(await runtime.call('thread/queue/handoff/save', { threadId, queuedSubmissionId: queuedId }, actor));
  expect(backup.state).toBe('saved'); expect(backup.nativeSavedImages).toBeUndefined();
  expect(await runtime.call('thread/queue/delete', { threadId, queuedSubmissionId: queuedId }, actor)).toEqual({ deleted: true });
  expect(object(await runtime.call('thread/queue/handoff/list', { threadId }, actor)).data).toMatchObject([{ id: backup.id, state: 'ready' }]);
  await runtime.call('thread/history', { threadId }, actor);
  await runtime.call('thread/resume', { threadId, options: { modelProvider: 'local_fixture', model: initialModel } }, actor);
  await runtime.call('thread/history', { threadId }, actor);
  // The first shutdown deliberately interrupted a turn. Complete a new, ordinary
  // text turn so the next startup exercises a clean idle native queue.
  const completed = new Set<string>();
  runtime.on('event', event => {
    if (event.type === 'notification' && object(event.data).method === 'turn/completed')
      completed.add(String(object(object(object(event.data).params).turn).id));
  });
  const neutral = object(await runtime.call('turn/start', { threadId, text: 'Complete the setup turn.' }, actor));
  await expect.poll(() => completed.has(String(object(neutral.turn).id)), { timeout: 10000 }).toBe(true);
  const second = runtime.native;
  await runtime.close(); expectNativeClosed(second); runtime = await create();
  expect(object(await runtime.call('thread/queue/list', { threadId }, actor)).data).toEqual([]);
  expect(object(await runtime.call('thread/queue/handoff/list', { threadId }, actor)).data).toMatchObject([{ id: backup.id, state: 'ready' }]);
  for (const [index, filename] of filenames.entries()) expect(readFileSync(filename).equals(images[index]!)).toBe(true);
  await runtime.call('thread/history', { threadId }, actor);
  await runtime.call('thread/resume', { threadId, options: { modelProvider: 'local_fixture', model: targetModel } }, actor);
  await runtime.call('thread/history', { threadId }, actor);
  const operationId = randomUUID(), beforeRestore = provider.calls();
  await runtime.call('thread/queue/handoff/restore', { threadId, handoffId: backup.id! }, { ...actor, operationId });
  await expect(runtime.call('thread/queue/handoff/restore', { threadId, handoffId: backup.id! }, { ...actor, operationId: randomUUID() })).rejects.toThrow();
  await expect.poll(() => provider.inputs().length, { timeout: 10000 }).toBe(beforeRestore + 1);
  const input = (provider.inputs()[beforeRestore] as JsonObject).input;
  for (const [index, filename] of filenames.entries()) {
    const base64 = images[index]!.toString('base64');
    if (targetModel === imageModel) {
      expect(JSON.stringify(input).includes(base64)).toBe(true);
      expect(JSON.stringify(input)).not.toContain(path.basename(filename));
    } else {
      expect(JSON.stringify(input).includes(base64)).toBe(false);
      expect(JSON.stringify(input)).toContain(path.basename(filename));
      expect(readFileSync(filename).equals(images[index]!)).toBe(true);
    }
  }
  if (paired) {
    const sent = JSON.stringify(input);
    expect(sent.indexOf(path.basename(filenames[1]!))).toBeLessThan(sent.indexOf(path.basename(filenames[0]!)));
  }
  expect(JSON.stringify(input)).toContain(trustedFile);
  expect(JSON.stringify(input)).toContain('保留原附加上下文');
  expect(JSON.stringify(input).split('Keep this queued message exactly once')).toHaveLength(2);
  expect(object(await runtime.call('thread/queue/handoff/list', { threadId }, actor)).data).toMatchObject([{ id: backup.id, state: 'restored', operationId }]);
  expect(object(await runtime.call('thread/queue/list', { threadId }, actor)).data).toEqual([]);
}), 60000);
