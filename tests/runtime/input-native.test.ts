import { expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RuntimeService } from '../../src/runtime/service.js';
import { object, type JsonValue } from '../../src/runtime/types.js';
import { loopbackProvider } from './loopback-provider.js';
import { nativeTestEnvironment } from '../fixtures/native-env.js';

test('official CLI sends discovered skill input, untrusted context and structured output to a local Responses fixture', async () => {
  const parent = path.resolve('.work/input-native'); mkdirSync(parent, { recursive: true }); const workerHome = mkdtempSync(path.join(parent, 'home-')), home = path.join(workerHome, 'codex'), tmp = path.join(workerHome, 'tmp'), project = path.join(workerHome, 'project'), skillPath = path.join(project, '.agents', 'skills', 'fixture-skill'); for (const folder of [home, tmp, skillPath]) mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(skillPath, 'SKILL.md'), '---\nname: fixture-skill\ndescription: Local input protocol validation fixture.\n---\n\nReturn the supplied structured result. Fixture marker: skill-source-retained.\n');
  const env = nativeTestEnvironment({ home: workerHome, codexHome: home, temporary: tmp, fixtureApiKey: 'local-fixture' });
  const provider = await loopbackProvider('{"answer_code":"local-fixture"}'); const catalog = path.join(workerHome, 'models.json'); writeFileSync(catalog, readFileSync('tests/runtime/fixture-model-catalog.json'));
  writeFileSync(path.join(home, 'config.toml'), ['check_for_update_on_startup = false', 'model = "harness-loopback-fixture"', 'model_provider = "local_fixture"', 'approval_policy = "never"', 'sandbox_mode = "read-only"', `model_catalog_json = ${JSON.stringify(catalog)}`, '[model_providers.local_fixture]', 'name = "Local protocol fixture"', `base_url = ${JSON.stringify(provider.url)}`, 'env_key = "HARNESS_PROVIDER_API_KEY"', 'wire_api = "responses"', 'requires_openai_auth = false', 'supports_websockets = false', 'request_max_retries = 0', 'stream_max_retries = 0'].join('\n'));
  const bin = process.env.HARNESS_TEST_CODEX_BIN ?? path.resolve('reference/runtime/codex-0.164.0/package/vendor/x86_64-pc-windows-msvc/bin/codex.exe'); let runtime: RuntimeService | undefined;
  try {
    runtime = await RuntimeService.create({ bin, home, workerHome, cwd: project, env, dev: true }); const context = { clientId: 'input-native', beforeWrite: () => {} };
    const skills = object(await runtime.call('skills/list', { cwd: project, forceReload: true }, context)); const skill = (skills.data as JsonValue[]).flatMap(entry => object(entry).skills as JsonValue[]).map(entry => object(entry)).find(entry => entry.name === 'fixture-skill')!; expect(skill).toBeTruthy();
    const schema = { type: 'object', properties: { answer_code: { type: 'string' } }, required: ['answer_code'], additionalProperties: false };
    const result = object(await runtime.call('conversation/start', { cwd: project, references: [{ type: 'skill', skillId: skill.skillId! }], extraContext: [{ label: 'Local evidence', text: 'native-untrusted-context-fixture' }], options: { outputSchema: schema } }, context)); const threadId = object(result.thread).id!;
    await expect.poll(() => provider.calls(), { timeout: 10000 }).toBe(1);
    await expect.poll(async () => object(object(await runtime!.call('thread/read', { threadId }, context)).thread).status, { timeout: 10000 }).toMatchObject({ type: 'idle' }); expect(provider.calls()).toBe(1);
    const request = object(provider.inputs()[0]); expect(JSON.stringify(request)).toContain('skill-source-retained'); expect(JSON.stringify(request)).toContain('native-untrusted-context-fixture'); expect(object(object(request.text).format)).toMatchObject({ type: 'json_schema', schema });
    expect(JSON.stringify(await runtime.call('thread/history', { threadId }, context))).toContain('answer_code');
  } finally { try { await runtime?.close(); } finally { await provider.close(); } if (runtime?.native.processId) expect(() => process.kill(runtime.native.processId!, 0)).toThrow(); }
}, 30000);

test('official CLI receives uploaded WAV bytes as input_audio and rejects a text-only model before another turn', async () => {
  const parent = path.resolve('.work/audio-native'); mkdirSync(parent, { recursive: true }); const workerHome = mkdtempSync(path.join(parent, 'home-')), home = path.join(workerHome, 'codex'), tmp = path.join(workerHome, 'tmp'); [home, tmp].forEach(folder => mkdirSync(folder));
  const provider = await loopbackProvider('Local audio fixture received.'); const models = JSON.parse(readFileSync('tests/runtime/fixture-model-catalog.json', 'utf8')); models.models[0].input_modalities = ['text', 'image', 'audio']; models.models.push({ ...models.models[0], slug: 'text-only-fixture', display_name: 'Text-only fixture', input_modalities: ['text'] });
  const catalog = path.join(workerHome, 'models.json'); writeFileSync(catalog, JSON.stringify(models)); writeFileSync(path.join(home, 'config.toml'), `check_for_update_on_startup=false\nmodel="harness-loopback-fixture"\nmodel_provider="fixture"\nmodel_catalog_json=${JSON.stringify(catalog)}\n[model_providers.fixture]\nname="Fixture"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\nrequest_max_retries=0\nstream_max_retries=0\n`);
  const env: NodeJS.ProcessEnv = { HOME: workerHome, USERPROFILE: workerHome, CODEX_HOME: home, TEMP: tmp, TMP: tmp, HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' }; for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC']) if (process.env[key]) env[key] = process.env[key];
  const wave = Buffer.alloc(1644); wave.write('RIFF', 0); wave.writeUInt32LE(1636, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(16000, 24); wave.writeUInt32LE(32000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(1600, 40);
  let runtime: RuntimeService | undefined;
  try {
    runtime = await RuntimeService.create({ bin: process.env.HARNESS_TEST_CODEX_BIN!, home, workerHome, cwd: workerHome, env, dev: true }); const context = { clientId: 'audio', eventChannelId: 'channel', beforeWrite: () => {} };
    const attachmentId = object(await runtime.call('attachment/upload', { name: 'recording.wav', mimeType: 'audio/wav', base64: wave.toString('base64') }, context)).attachmentId!;
    const result = object(await runtime.call('conversation/start', { cwd: workerHome, attachmentIds: [attachmentId] }, context)), threadId = object(result.thread).id!;
    await expect.poll(() => provider.calls(), { timeout: 10000 }).toBe(1);
    await expect.poll(async () => object(object(await runtime!.call('thread/read', { threadId }, context)).thread).status, { timeout: 10000 }).toMatchObject({ type: 'idle' }); expect(provider.calls()).toBe(1);
    const input = object(provider.inputs()[0]).input as JsonValue[], audio = input.map(item => object(item)).flatMap(item => Array.isArray(item.content) ? item.content : []).map(item => object(item)).find(item => item.type === 'input_audio');
    expect(audio).toEqual({ type: 'input_audio', audio_url: `data:audio/wav;base64,${wave.toString('base64')}` });
    const history = await runtime.call('thread/history', { threadId }, context); expect(JSON.stringify(history)).toContain('localAudio'); expect(JSON.stringify(history)).toContain(`${attachmentId}.wav`);
    expect(await runtime.call('attachment/history/read', { threadId, path: path.join(workerHome, 'attachments', `${attachmentId}.wav`) }, context)).toMatchObject({ base64: wave.toString('base64') });
    await expect(runtime.call('turn/start', { threadId, attachmentIds: [attachmentId], options: { model: 'text-only-fixture' } }, context)).rejects.toMatchObject({ code: 'model_modality_unsupported', delivery: 'not_sent' }); expect(provider.calls()).toBe(1);
  } finally { await runtime?.close(); await provider.close(); }
}, 30000);
