// @vitest-environment jsdom
import { createHash, webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MessageMedia } from '../components/MessageMedia';
import { Messages } from '../components/Messages';
import { HistoryTools } from '../components/HistoryTools';
import type { Api } from '../lib/api';
import { readGeneratedMedia, reserveGeneratedMedia } from '../lib/generated-media';
import { GENERATED_MEDIA_BYTES, type GeneratedMediaReference } from '../lib/media';
import { applyNotification, boundedCombined, checkedPage, mergeHistory } from '../lib/history';
import type { Turn } from '../lib/types';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const identity = { threadId: 'thread', turnId: 'turn', itemId: 'generated' };
function reference(bytes: Uint8Array): GeneratedMediaReference {
  return { mediaId: createHash('sha256').update(bytes).digest('hex'), mimeType: 'image/png', size: bytes.length };
}
function fixture(bytes: Uint8Array = png) {
  const ref = reference(bytes);
  const chunk = (p: Record<string, unknown>) => {
    const offset = Number(p.offset), length = Number(p.length), end = offset + length;
    return { ...ref, offset, base64: Buffer.from(bytes.subarray(offset, end)).toString('base64'), nextOffset: end === bytes.length ? null : end };
  };
  const call = vi.fn(async (_method: string, p: Record<string, unknown>) => chunk(p));
  return { ref, chunk, call, api: { call } as unknown as Api };
}
function item(generatedMedia: GeneratedMediaReference = reference(png)) {
  return { id: identity.itemId, type: 'imageGeneration', status: 'completed', result: '', generatedMedia };
}
function padded(size: number) { const bytes = new Uint8Array(size); bytes.set(png); return bytes; }
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:generated-image');
    static revokeObjectURL = vi.fn();
  });
  Element.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([3 * 1024 * 1024, GENERATED_MEDIA_BYTES])('reads and verifies %i raw bytes without embedding them in history', async size => {
  const bytes = padded(size), f = fixture(bytes);
  const actual = await readGeneratedMedia(f.api, identity, f.ref, new AbortController().signal);
  expect(createHash('sha256').update(actual).digest('hex')).toBe(f.ref.mediaId);
  expect(actual.length).toBe(size);
  expect(f.call).toHaveBeenCalledTimes(Math.ceil(size / 196608));
  f.call.mock.calls.forEach(([method, p], index) => {
    expect(method).toBe('thread/media/read');
    expect(p).toEqual({ ...identity, mediaId: f.ref.mediaId, offset: index * 196608, length: Math.min(196608, size - index * 196608) });
  });
});

it.each([
  { name: 'different media', patch: { mediaId: 'a'.repeat(64) } },
  { name: 'wrong format', patch: { mimeType: 'image/jpeg' } },
  { name: 'wrong size', patch: { size: png.length + 1 } },
  { name: 'wrong offset', patch: { offset: 1 } },
  { name: 'extra cursor', patch: { nextOffset: png.length } },
  { name: 'truncated bytes', patch: { base64: png.subarray(0, -1).toString('base64') } },
  { name: 'invalid encoding', patch: { base64: '?'.repeat(png.toString('base64').length) } },
])('rejects $name before presenting any image', async ({ patch }) => {
  const f = fixture(); f.call.mockImplementation(async (_method, p) => ({ ...f.chunk(p), ...patch } as ReturnType<typeof f.chunk>));
  await expect(readGeneratedMedia(f.api, identity, f.ref, new AbortController().signal)).rejects.toThrow(/图片分块/);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it('rejects a complete response with a different hash or declared image format', async () => {
  const changed = new Uint8Array(png); changed[changed.length - 1] ^= 1;
  const f = fixture(changed), original = reference(png);
  f.call.mockImplementation(async (_method, p) => ({ ...f.chunk(p), mediaId: original.mediaId }));
  await expect(readGeneratedMedia(f.api, identity, original, new AbortController().signal)).rejects.toThrow('内容校验失败');
  const second = fixture(), jpeg = { ...second.ref, mimeType: 'image/jpeg' as const };
  second.call.mockImplementation(async (_method, p) => ({ ...second.chunk(p), mimeType: 'image/jpeg' }));
  await expect(readGeneratedMedia(second.api, identity, jpeg, new AbortController().signal)).rejects.toThrow('格式与已记录');
});

it('stops between chunks after cancellation and never reads a replacement thread implicitly', async () => {
  const f = fixture(padded(400000)), controller = new AbortController();
  f.call.mockImplementation(async (_method, p) => { controller.abort(); return f.chunk(p); });
  await expect(readGeneratedMedia(f.api, identity, f.ref, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.call).toHaveBeenCalledOnce();
});

it('does not fetch malformed or oversized references and keeps a server media failure local to that item', () => {
  const f = fixture();
  const view = render(<MessageMedia api={f.api} {...identity} item={item({ ...f.ref, size: GENERATED_MEDIA_BYTES + 1 })} />);
  expect(screen.getByText(/身份、格式或大小无效/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: '预览图片' })).toBeNull();
  view.rerender(<MessageMedia api={f.api} {...identity} item={{ ...item(), generatedMedia: undefined, generatedMediaError: '生成图片超过 8 MiB，无法预览。' }} />);
  expect(screen.getByText(/超过 8 MiB/)).toBeTruthy();
  expect(f.call).not.toHaveBeenCalled();
});

it('previews and downloads an image on demand from its exact thread, turn and item', async () => {
  const f = fixture();
  render(<Messages api={f.api} threadId={identity.threadId} turns={[{ id: identity.turnId, status: 'completed', items: [item()] }]} loading={false} complete onMore={vi.fn()} />);
  expect(f.call).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '预览图片' }));
  await screen.findByRole('img', { name: '生成的图片' });
  expect(f.call).toHaveBeenCalledWith('thread/media/read', { ...identity, mediaId: f.ref.mediaId, offset: 0, length: png.length }, expect.any(AbortSignal));
  expect(screen.getByRole('link', { name: '下载 生成的图片.png' }).getAttribute('href')).toBe('blob:generated-image');
  fireEvent.click(screen.getByRole('button', { name: '收起媒体' }));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:generated-image');
});

it('renders generated media inside a read-only search window with the same identity checks', async () => {
  const f = fixture(), hit = { turnId: identity.turnId, itemId: identity.itemId, snippet: 'generated', snippetMatchRange: { start: 0, end: 9 }, turnCursor: 'window' };
  f.call.mockImplementation(async (method, p) => {
    if (method === 'thread/media/read') return f.chunk(p);
    return (method === 'thread/searchOccurrences' ? { data: [hit], nextCursor: null }
      : { partial: true, complete: false, turns: [{ id: identity.turnId, status: 'completed', items: [item()] }] }) as unknown as ReturnType<typeof f.chunk>;
  });
  render(<HistoryTools api={f.api} threadId={identity.threadId} epoch="fixture" turns={[]} onClose={vi.fn()} onLocate={vi.fn()} />);
  fireEvent.change(screen.getByRole('searchbox', { name: '搜索当前会话' }), { target: { value: 'generated' } });
  fireEvent.click(await screen.findByRole('button', { name: /generated/ }));
  fireEvent.click(await screen.findByRole('button', { name: '预览图片' }));
  await screen.findByRole('img');
  expect(f.call).toHaveBeenCalledWith('thread/media/read', { ...identity, mediaId: f.ref.mediaId, offset: 0, length: png.length }, expect.any(AbortSignal));
  expect(f.call.mock.calls.some(([method]) => method === 'thread/history')).toBe(false);
});

it.each(['threadId', 'turnId', 'itemId'] as const)('discards an in-flight image after its %s changes', async key => {
  const f = fixture(); let finish!: (value: ReturnType<typeof f.chunk>) => void;
  f.call.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const props = { api: f.api, threadId: identity.threadId, turnId: identity.turnId, item: item() };
  const view = render(<MessageMedia {...props} />);
  fireEvent.click(screen.getByRole('button', { name: '预览图片' }));
  const next = key === 'itemId' ? { ...props, item: { ...props.item, id: 'other' } } : { ...props, [key]: 'other' };
  view.rerender(<MessageMedia {...next} />);
  await act(async () => finish(f.chunk({ offset: 0, length: png.length })));
  expect(screen.queryByRole('img')).toBeNull();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '预览图片' }).hasAttribute('disabled')).toBe(false);
});

it('releases preview capacity after browser decode failure or unmount', async () => {
  const f = fixture(), view = render(<MessageMedia api={f.api} {...identity} item={item()} />);
  fireEvent.click(screen.getByRole('button', { name: '预览图片' }));
  fireEvent.error(await screen.findByRole('img'));
  expect(screen.getByRole('alert').textContent).toMatch(/图片无法解码/);
  expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: '预览图片' }));
  await screen.findByRole('img'); view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  const reservations = Array.from({ length: 8 }, () => reserveGeneratedMedia(png.length));
  try { expect(() => reserveGeneratedMedia(png.length)).toThrow(/容量上限/); }
  finally { reservations.forEach(value => value.release()); }
});

it('bounds simultaneous retained bytes and decoded pixels, and releasing a preview restores capacity', () => {
  const reservations = Array.from({ length: 4 }, () => reserveGeneratedMedia(GENERATED_MEDIA_BYTES));
  try { expect(() => reserveGeneratedMedia(1)).toThrow(/容量上限/); }
  finally { reservations.forEach(value => { value.release(); value.release(); }); }
  const bytes = new Uint8Array(png); new DataView(bytes.buffer).setUint32(16, 5000); new DataView(bytes.buffer).setUint32(20, 5000);
  const first = reserveGeneratedMedia(bytes.length), second = reserveGeneratedMedia(bytes.length);
  try {
    expect(first.decoded(bytes)).toBe('image/png');
    expect(() => second.decoded(bytes)).toThrow(/尺寸已达上限/);
    first.release(); expect(second.decoded(bytes)).toBe('image/png');
  } finally { first.release(); second.release(); }
});

it('keeps many large image references intact through live updates and reconnect history without exhausting text budgets', () => {
  const ref = reference(padded(GENERATED_MEDIA_BYTES));
  let turns: Turn[] = [];
  for (let index = 0; index < 50; index++) {
    const turnId = `turn-${index}`, generated = { ...item(ref), id: `image-${index}` };
    turns = applyNotification(turns, 'item/completed', { turnId, item: generated }).turns;
    turns = applyNotification(turns, 'turn/completed', { turnId, turn: { id: turnId, status: 'completed' } }).turns;
  }
  const page = checkedPage({ turns, timeline: [], turnsComplete: true, timelineComplete: true, complete: true, nextCursor: null, historyVersion: 1, activeRealtimeSessionAtPageStart: null }, new Set());
  const restored = mergeHistory([], page.turns, new Set());
  expect(() => boundedCombined(restored, page.timeline)).not.toThrow();
  expect(JSON.stringify(restored).length).toBeLessThan(30_000);
  expect(restored.map(turn => turn.items[0]?.generatedMedia)).toEqual(Array.from({ length: 50 }, () => ref));
});
