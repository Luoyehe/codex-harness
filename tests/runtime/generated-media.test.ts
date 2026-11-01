import { afterEach, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { GeneratedMedia, GENERATED_MEDIA_BYTES, GENERATED_MEDIA_CHUNK } from '../../src/runtime/generated-media.js';
import { readMediaHistory } from '../../src/runtime/media-history.js';
import { RuntimeService } from '../../src/runtime/service.js';
import type { NativeRpc } from '../../src/runtime/native.js';
import { object, type JsonObject, type JsonValue, type RuntimeEvent } from '../../src/runtime/types.js';
import { options } from '../../src/runtime/validation.js';
import { nativeThread } from './fixture-values.js';

const png = (size = 3 * 1024 * 1024) => { const bytes = Buffer.alloc(size, 17); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes); return bytes; };
const item = (bytes: Buffer, id = 'image'): JsonObject => ({ type: 'imageGeneration', id, status: 'completed', revisedPrompt: 'A test image', failure: null, result: bytes.toString('base64'), savedPath: '/not-an-authorized-file.png' });
function setup(bytes = png()) {
  let revision = 0, closed = false; let current: JsonValue[] = [{ turnId: 'turn', item: item(bytes) }];
  const native = vi.fn(async (method: string, params: JsonValue): Promise<JsonValue> => {
    expect(method).toBe('thread/items/read'); expect(params).toEqual({ threadId: 'thread', turnId: 'turn', itemIds: ['image'] }); return { data: current };
  });
  const host = { native, revision: () => revision, closed: () => closed }, media = new GeneratedMedia(host);
  const projected = object(media.project({ threadId: 'thread', turnId: 'turn', item: item(bytes) }));
  const ref = object(object(projected.item).generatedMedia), params = { threadId: 'thread', turnId: 'turn', itemId: 'image', mediaId: ref.mediaId!, offset: 0 };
  return { bytes, native, host, media, projected, ref, params, change: (rows: JsonValue[]) => { current = rows; revision++; }, close: () => { closed = true; } };
}
test('3 MiB and full 8 MiB generated images cross only bounded chunks and keep native input unchanged', async () => {
  for (const size of [3 * 1024 * 1024, GENERATED_MEDIA_BYTES]) {
    const state = setup(png(size)), original = item(state.bytes), saved = JSON.stringify(original), chunks: Buffer[] = [];
    expect(JSON.stringify(state.projected).length).toBeLessThan(1024);
    expect(object(state.projected.item)).toMatchObject({ result: '', generatedMedia: { size, mimeType: 'image/png' } });
    state.media.project({ turns: [{ id: 'turn', items: [original] }] }, 'thread'); expect(JSON.stringify(original)).toBe(saved);
    let offset = 0;
    for (;;) {
      const result = object(await state.media.read({ ...state.params, offset }));
      expect(result.offset).toBe(offset); expect(JSON.stringify(result).length).toBeLessThan(263000);
      const chunk = Buffer.from(String(result.base64), 'base64'); expect(chunk.length).toBeLessThanOrEqual(GENERATED_MEDIA_CHUNK); chunks.push(chunk);
      if (result.nextOffset === null) break; offset = Number(result.nextOffset);
    }
    expect(Buffer.concat(chunks).equals(state.bytes)).toBe(true); expect(state.ref.mediaId).toBe(createHash('sha256').update(state.bytes).digest('hex')); expect(state.native).toHaveBeenCalledTimes(1);
  }
});
test('restart/cache eviction rehydrates exact items while removal, changed content, identity changes and invalid reads cannot reuse bytes', async () => {
  const state = setup(); state.media.clear(); await expect(state.media.read(state.params)).resolves.toMatchObject({ mediaId: state.ref.mediaId });
  const restart = new GeneratedMedia(state.host); await expect(restart.read(state.params)).resolves.toMatchObject({ size: state.bytes.length });
  for (let n = 0; n < 130; n++) state.media.project({ threadId: 'other', turnId: 'turn', item: item(png(64), 'image-' + n) });
  await expect(state.media.read({ ...state.params, offset: GENERATED_MEDIA_CHUNK })).resolves.toMatchObject({ mediaId: state.ref.mediaId });
  state.change([]); await expect(state.media.read({ ...state.params, offset: GENERATED_MEDIA_CHUNK })).rejects.toMatchObject({ code: 'media_unavailable' });
  state.change([{ turnId: 'turn', item: item(png(128)) }]); await expect(state.media.read(state.params)).rejects.toMatchObject({ code: 'media_changed' });
  state.change([{ turnId: 'another-turn', item: item(state.bytes) }]); await expect(state.media.read(state.params)).rejects.toMatchObject({ code: 'media_unavailable' });
  for (const change of [{ offset: -1 }, { length: GENERATED_MEDIA_CHUNK + 1 }, { path: '/root/secret' }, { mediaId: '../file' }]) await expect(state.media.read({ ...state.params, ...change })).rejects.toMatchObject({ code: 'invalid_params' });
  state.close(); await expect(state.media.read(state.params)).rejects.toMatchObject({ code: 'runtime_unavailable' });
});
test('a deleted item invalidates a previously warm cache even without a local notification', async () => {
  const state = setup(); state.native.mockResolvedValue({ data: [] });
  await expect(state.media.read(state.params)).rejects.toMatchObject({ code: 'media_unavailable' });
  await expect(state.media.read({ ...state.params, offset: 16 })).rejects.toMatchObject({ code: 'media_unavailable' });
});
test('over-limit and invalid media are localized errors and never retain inline bytes or rewrite arbitrary tool output', () => {
  const state = setup();
  for (const result of [png(GENERATED_MEDIA_BYTES + 1).toString('base64'), 'YWJj', 'YWJj====', 'not base64']) {
    const value = object(state.media.project({ turns: [{ id: 'turn', items: [{ ...item(png(12)), result }] }] }, 'thread'));
    expect(JSON.stringify(value).length).toBeLessThan(1024); const turn = object((value.turns as JsonValue[])[0]); expect(object((turn.items as JsonValue[])[0]).generatedMediaError).toEqual(expect.any(String));
  }
  const tool = { type: 'mcpToolCall', result: { structuredContent: { items: [item(png(128))], item: item(png(128)) }, payload: { ...item(png(128)) } } };
  expect(state.media.project({ items: [tool] }, 'thread', 'turn')).toEqual({ items: [tool] });
  const metadata = { thread: { id: 'thread', extra: { items: [item(png(128))] } } }; expect(state.media.project(metadata)).toEqual(metadata);
});
test('multi-image turn and canonical timeline are read one native item per frame, retaining order and original cursors', async () => {
  const state = setup(), rows = [item(png(), 'a'), item(png(), 'b'), item(png(), 'c')];
  const native = vi.fn(async (method: string, params: JsonValue): Promise<JsonValue> => {
    const p = object(params);
    if (method === 'thread/turns/list') { expect(p.itemsView).toBe('notLoaded'); return { data: [{ id: 'turn', items: [], itemsView: 'notLoaded', status: 'completed' }], nextCursor: 'next-turn', backwardsCursor: 'back-turn' }; }
    expect(p.limit).toBe(1); const n = p.cursor == null ? 0 : Number(p.cursor), nextCursor = n + 1 < rows.length ? String(n + 1) : null;
    if (method === 'thread/items/list') return { data: [{ turnId: 'turn', item: rows[n]! }], nextCursor, backwardsCursor: null };
    if (method === 'thread/timeline/list') return { data: [{ type: 'item', position: rows.length - 1 - n, turnId: 'turn', item: rows[rows.length - 1 - n]! }], nextCursor, activeRealtimeSessionAtPageStart: n === rows.length - 1 ? 'voice-at-start' : null };
    throw new Error('Unexpected native method');
  });
  const turns = object(await readMediaHistory(native, state.media, 'thread/turns/list', { threadId: 'thread', limit: 25, itemsView: 'full' }));
  expect(turns).toMatchObject({ nextCursor: 'next-turn', backwardsCursor: 'back-turn', data: [{ itemsView: 'full', items: rows.map(value => ({ id: value.id, result: '', generatedMedia: { size: 3 * 1024 * 1024 } })) }] });
  const timeline = object(await readMediaHistory(native, state.media, 'thread/timeline/list', { threadId: 'thread', limit: 25 }));
  expect(timeline).toMatchObject({ nextCursor: null, activeRealtimeSessionAtPageStart: 'voice-at-start', data: [expect.objectContaining({ position: 0 }), expect.objectContaining({ position: 1 }), expect.objectContaining({ position: 2 })] });
  expect(JSON.stringify({ turns, timeline }).length).toBeLessThan(4000);
});
test('unbounded/repeated item cursors and mismatched identities cannot declare complete history', async () => {
  const state = setup(), turn = { data: [{ id: 'turn', items: [], itemsView: 'notLoaded' }], nextCursor: null };
  const native = vi.fn(async (method: string): Promise<JsonValue> => method === 'thread/turns/list' ? turn : { data: [], nextCursor: 'same' });
  await expect(readMediaHistory(native, state.media, 'thread/turns/list', { threadId: 'thread', itemsView: 'full' })).rejects.toMatchObject({ code: 'cursor_loop' });
});

const services: RuntimeService[] = []; afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });
test('runtime notifications, normal history, history windows and media reads all use the same bounded projection', async () => {
  const roots = path.resolve('.work/generated-media-tests'); mkdirSync(roots, { recursive: true }); const home = mkdtempSync(path.join(roots, 'home-')), bytes = png(), image = item(bytes), events: RuntimeEvent[] = [];
  class Native extends EventEmitter {
    connected = true; budget = { pending: 0, retainedBytes: 0 };
    async call(method: string): Promise<JsonValue> {
      if (method === 'thread/read') return { thread: nativeThread({ id: 'thread' }) };
      if (method === 'thread/turns/list') return { data: [{ id: 'turn', rootTurnId: null, itemsView: 'notLoaded', items: [], status: 'completed', error: null, startedAt: 1, completedAt: 2, durationMs: 1000 }], nextCursor: null, backwardsCursor: null };
      if (method === 'thread/items/list' || method === 'thread/items/read') return { data: [{ turnId: 'turn', item: image, startedAtMs: 1000, completedAtMs: 2000 }], nextCursor: null, backwardsCursor: null };
      if (method === 'thread/timeline/list') return { data: [], nextCursor: null, activeRealtimeSessionAtPageStart: null };
      throw new Error(method);
    }
    async close() { this.connected = false; }
  }
  const native = new Native(), service = new RuntimeService({ bin: process.execPath, home, workerHome: home, cwd: home, env: {} }, native as unknown as NativeRpc); services.push(service); service.on('event', event => events.push(event));
  native.emit('notification', { method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: image } });
  expect(JSON.stringify(events).length).toBeLessThan(2000);
  for (const method of ['thread/history', 'thread/history/window']) {
    const result = object(await service.call(method, { threadId: 'thread', ...(method.endsWith('window') ? { turnCursor: 'anchor' } : {}) }, { clientId: 'browser' }));
    const generated = object(object((object((result.turns as JsonValue[])[0]).items as JsonValue[])[0]).generatedMedia);
    expect(JSON.stringify(result).length).toBeLessThan(2000);
    await expect(service.call('thread/media/read', { threadId: 'thread', turnId: 'turn', itemId: 'image', mediaId: generated.mediaId!, offset: 0 }, { clientId: 'browser' })).resolves.toMatchObject({ size: bytes.length });
  }
  for (const format of ['json', 'markdown']) {
    const exported = object(await service.call('thread/export', { threadId: 'thread', format }, { clientId: 'browser' }));
    expect(exported.warnings).toEqual([expect.stringContaining('不包含图片字节')]); expect(String(exported.content)).toContain('不包含图片字节');
    expect(String(exported.content)).not.toContain(bytes.toString('base64'));
  }
  expect(image.result).toBe(bytes.toString('base64'));
});
test('nullable non-turn effort and summary inherit defaults without constructing invalid TOML; turn options remain native nullable', () => {
  expect(options({ effort: null, summary: null }, false)).toEqual({});
  expect(options({ effort: null, summary: null }, true)).toEqual({ effort: null, summary: null });
  expect(options({ effort: 'high', summary: 'none' }, false)).toEqual({ config: { model_reasoning_effort: 'high', model_reasoning_summary: 'none' } });
});
