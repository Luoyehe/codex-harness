// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDraftSnapshot, emptyDraft, readDraft, writeDraft } from '../lib/drafts';
import { useDraft } from '../hooks/useDraft';
import { Api } from '../lib/api';
beforeEach(() => { sessionStorage.clear(); localStorage.clear(); }); afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('bounded document-local drafts', () => {
  it('ignores ordinary setters from an earlier visit, including after returning to the same draft', () => {
    writeDraft({ ...emptyDraft('a'), text: 'A', options: { model: 'model-a' } });
    writeDraft({ ...emptyDraft('b'), text: 'B', options: { model: 'model-b' } });
    const view = renderHook(({ key }) => useDraft(key), { initialProps: { key: 'a' } });
    const stale = view.result.current;
    const invokeStale = () => {
      stale.setText('stale text'); stale.setOptions({ model: 'stale model' });
      stale.setAttachments([{ attachmentId: 'stale', name: 'stale.txt', size: 1, mimeType: 'text/plain' }]);
      stale.setReferences([{ type: 'skill', projectId: 'p', skillId: 'a'.repeat(64), label: 'stale skill' }]);
      stale.setExtraContext([{ label: 'stale note', text: 'stale context' }]); stale.setOutputSchema('{"type":"object"}');
    };
    const originalA = readDraft('a'), originalB = readDraft('b');
    view.rerender({ key: 'b' }); act(invokeStale);
    expect(readDraft('a')).toEqual(originalA); expect(readDraft('b')).toEqual(originalB); expect(view.result.current.text).toBe('B');
    view.rerender({ key: 'a' });
    const currentVisit = view.result.current;
    act(() => currentVisit.setText('new A'));
    const latestA = readDraft('a'); act(invokeStale);
    expect(readDraft('a')).toEqual(latestA); expect(view.result.current.text).toBe('new A');
    act(() => currentVisit.setOptions({ model: 'new model' }));
    expect(view.result.current.options.model).toBe('new model'); expect(view.result.current.text).toBe('new A');
  });
  it('rejects an old empty-draft insertion after A to B to A navigation', () => {
    const view = renderHook(({ key }) => useDraft(key), { initialProps: { key: 'a' } });
    const insert = view.result.current.insertTextIfEmpty;
    view.rerender({ key: 'b' }); view.rerender({ key: 'a' });
    act(() => expect(insert('old prediction')).toBe(false));
    expect(view.result.current.text).toBe('');
    act(() => expect(view.result.current.insertTextIfEmpty('current prediction')).toBe(true));
    expect(readDraft('a').text).toBe('current prediction');
  });
  it('rejects ordinary writes after unmount while still applying original-draft attachment removal', () => {
    const attachment = { attachmentId: 'file', name: 'a.txt', size: 1, mimeType: 'text/plain' };
    writeDraft({ ...emptyDraft('a'), text: 'A', attachments: [attachment] });
    const view = renderHook(() => useDraft('a')), stale = view.result.current, before = readDraft('a');
    view.unmount();
    act(() => { stale.setText('stale'); stale.setOptions({ model: 'stale' }); stale.setAttachments([]); stale.setReferences([]); stale.setExtraContext([]); stale.setOutputSchema('{}'); });
    expect(readDraft('a')).toEqual(before);
    act(() => stale.removeAttachment('file'));
    expect(readDraft('a')).toMatchObject({ text: 'A', attachments: [] });
    const empty = renderHook(() => useDraft('empty')), insert = empty.result.current.insertTextIfEmpty;
    empty.unmount(); act(() => expect(insert('stale prediction')).toBe(false));
    expect(readDraft('empty').text).toBe('');
  });
  it('merges a deletion from an unmounted instance into the latest reopened draft', () => {
    const attachment = { attachmentId: 'file', name: 'a.txt', size: 1, mimeType: 'text/plain' };
    writeDraft({ ...emptyDraft('a'), text: 'old A', attachments: [attachment] });
    const old = renderHook(() => useDraft('a')), remove = old.result.current.removeAttachment;
    old.unmount();
    const current = renderHook(() => useDraft('a'));
    act(() => current.result.current.setText('new A after reopening'));
    act(() => remove('file'));
    expect(readDraft('a')).toMatchObject({ text: 'new A after reopening', attachments: [] });
    expect(current.result.current.text).toBe('new A after reopening'); expect(current.result.current.attachments).toEqual([]);
  });
  it('merges an original-visit deletion into unsaved memory after returning to A', () => {
    const attachment = { attachmentId: 'file', name: 'a.txt', size: 1, mimeType: 'text/plain' };
    writeDraft({ ...emptyDraft('a'), text: 'stored A', attachments: [attachment] });
    const view = renderHook(({ key }) => useDraft(key), { initialProps: { key: 'a' } }), remove = view.result.current.removeAttachment;
    view.rerender({ key: 'b' }); view.rerender({ key: 'a' });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
    act(() => view.result.current.setText('latest A in memory'));
    act(() => remove('file'));
    expect(view.result.current.text).toBe('latest A in memory'); expect(view.result.current.attachments).toEqual([]);
    expect(view.result.current.error).toContain('原草稿保存失败');
    expect(readDraft('a')).toMatchObject({ text: 'stored A', attachments: [attachment] });
  });
  it('does not reload an unsaved current draft when an old draft attachment is deleted', () => {
    writeDraft({ ...emptyDraft('a'), text: 'A', attachments: [{ attachmentId: 'file', name: 'a.txt', size: 1, mimeType: 'text/plain' }] });
    const view = renderHook(({ key }) => useDraft(key), { initialProps: { key: 'a' } });
    const removeFromA = view.result.current.removeAttachment;
    view.rerender({ key: 'b' });
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) { if (key === 'harness.draft.v1.b') throw new DOMException('quota'); return original.call(this, key, value); });
    act(() => view.result.current.setText('B in memory only'));
    act(() => removeFromA('file'));
    expect(readDraft('a')).toMatchObject({ text: 'A', attachments: [] });
    expect(view.result.current.text).toBe('B in memory only');
    expect(view.result.current.error).toContain('草稿保存失败');
  });
  it('recovers text, options and uploaded ids independently for each project', () => {
    const a = { ...emptyDraft('new:a'), text: 'unfinished a', options: { model: 'custom' }, attachments: [{ attachmentId: 'opaque', name: 'note.txt', size: 10, mimeType: 'text/plain' }] };
    writeDraft(a); writeDraft({ ...emptyDraft('new:b'), text: 'unfinished b' });
    expect(readDraft('new:a')).toEqual(a); expect(readDraft('new:b').text).toBe('unfinished b');
    expect(JSON.stringify(readDraft('new:a'))).not.toMatch(/base64|apiKey/);
  });
  it('cannot clear a newly edited draft using an older accepted receipt', () => {
    const old = { ...emptyDraft('a'), text: 'sent text' }; writeDraft(old);
    const next = { ...old, revision: crypto.randomUUID(), text: 'new text' }; writeDraft(next);
    clearDraftSnapshot('a', old.revision); expect(readDraft('a').text).toBe('new text');
    clearDraftSnapshot('a', next.revision); expect(readDraft('a').text).toBe('');
  });
  it('keeps next-turn option edits made while the previous send was pending', async () => {
    writeDraft({ ...emptyDraft('a'), text: 'same text', options: { model: 'model-a' } });
    let finish!: (response: unknown) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; })));
    const { result } = renderHook(() => useDraft('a'));
    const pending = new Api().mutate('turn/start', { threadId: 'a', text: 'same text', options: { model: 'model-a' } });
    act(() => result.current.setOptions({ model: 'model-b', approvalPolicy: 'never' }));
    await act(async () => { finish({ ok: true, json: async () => ({ ok: true, result: { turn: { id: 't' } } }) }); await pending; });
    expect(readDraft('a').text).toBe('same text'); expect(result.current.options).toEqual({ model: 'model-b', approvalPolicy: 'never' });
  });
  it('leaves the typed text visible when persistent saving fails', () => {
    const { result } = renderHook(() => useDraft('new:a'));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
    act(() => result.current.setText('must remain visible'));
    expect(result.current.text).toBe('must remain visible'); expect(result.current.error).toContain('草稿保存失败');
  });
  it('rejects capacity growth without deleting another unhandled draft', () => {
    for (let i = 0; i < 50; i++) writeDraft({ ...emptyDraft(`new:${i}`), text: `draft ${i}` });
    expect(() => writeDraft(emptyDraft('new:51'))).toThrow('容量上限'); expect(readDraft('new:0').text).toBe('draft 0');
  });
});
