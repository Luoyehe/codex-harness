// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useLayoutEffect, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDraftSnapshot, draftChanged, emptyDraft, readDraft, writeDraft } from '../lib/drafts';
import { useDraft } from '../hooks/useDraft';
import { Api } from '../lib/api';
import { acknowledgeOperation, createOperation, listOperations, reconcileOperation, updateOperation } from '../lib/operations';
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const attachment = { attachmentId: 'file', name: 'a.txt', size: 1, mimeType: 'text/plain' };
function draftFields(draft: ReturnType<typeof useDraft>) {
  const { key, revision, text, options, attachments, references, extraContext, outputSchema, updatedAt } = draft;
  return { key, revision, text, options, attachments, references, extraContext, outputSchema, updatedAt };
}
function editEveryField(draft: ReturnType<typeof useDraft>) {
  draft.setText('changed and then restored');
  draft.setText('submitted A');
  draft.setOptions({ model: 'new-model', approvalPolicy: 'never' });
  draft.setAttachments([attachment, { ...attachment, attachmentId: 'new-file' }]);
  draft.setReferences([{ type: 'skill', projectId: 'p', skillId: 'a'.repeat(64), label: 'new skill' }]);
  draft.setExtraContext([{ label: 'new note', text: 'new context' }]);
  draft.setOutputSchema('{"type":"object"}');
}
function rejectDraftWrites() {
  const original = Storage.prototype.setItem;
  return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (this === sessionStorage && key.startsWith('harness.draft.v1.'))
      throw new DOMException('quota', 'QuotaExceededError');
    original.call(this, key, value);
  });
}
describe('bounded document-local drafts', () => {
  it('retains input dispatched from the first DOM commit before passive draft loading', async () => {
    writeDraft({ ...emptyDraft('a'), text: 'stored A' });
    rejectDraftWrites();
    function FirstCommitInput() {
      const draft = useDraft('a'), input = useRef<HTMLTextAreaElement>(null);
      useLayoutEffect(() => {
        expect(input.current?.isConnected).toBe(true);
        // Use the DOM input path here; fireEvent nests a synchronous act inside
        // this first layout commit before the surrounding async act can finish.
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
          .call(input.current!, 'first exposed input B');
        input.current!.dispatchEvent(new Event('input', { bubbles: true }));
      }, []);
      return <>
        <textarea ref={input} aria-label="First commit draft" value={draft.text} onChange={event => draft.setText(event.target.value)} />
        <p role="alert">{draft.error}</p>
      </>;
    }
    await act(async () => { render(<FirstCommitInput />); });
    expect(screen.getByRole('textbox')).toHaveProperty('value', 'first exposed input B');
    expect(screen.getByRole('alert').textContent).toContain('草稿保存失败');
    expect(readDraft('a').text).toBe('stored A');
  });
  it.each(['HTTP', 'reconciliation'] as const)('preserves every newer memory-only field and warning after %s acceptance', async (delivery) => {
    writeDraft({ ...emptyDraft('a'), text: 'submitted A' });
    const submitted = readDraft('a'), view = renderHook(() => useDraft('a'));
    let finish!: (value: unknown) => void;
    const fetcher = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', fetcher);
    const sending = new Api().beginMutation('turn/start', { threadId: 'a', text: submitted.text });
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    rejectDraftWrites();
    act(() => editEveryField(view.result.current));
    const newer = draftFields(view.result.current), warning = view.result.current.error;
    expect(newer.revision).not.toBe(submitted.revision);
    expect(warning).toContain('草稿保存失败');
    await act(async () => {
      if (delivery === 'reconciliation')
        await reconcileOperation(sending.operationId, { state: 'accepted' });
      finish({ ok: true, status: 200, json: async () => ({ ok: true, result: { turn: { id: 'turn' } } }) });
      await sending.result;
    });
    expect(draftFields(view.result.current)).toEqual(newer);
    expect(view.result.current.error).toBe(warning);
    expect(readDraft('a').text).toBe('');
    expect((await listOperations()).find(op => op.id === sending.operationId)?.state).toBe('accepted');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('preserves a newer volatile draft when acknowledgement retries previously failed accepted cleanup', async () => {
    const submitted = { ...emptyDraft('a'), text: 'submitted A' };
    writeDraft(submitted);
    const view = renderHook(() => useDraft('a'));
    const operation = await createOperation('turn/start', { threadId: 'a', draftKey: 'a', draftRevision: submitted.revision });
    const removal = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    await expect(updateOperation(operation.id, 'accepted')).rejects.toThrow('storage unavailable');
    removal.mockRestore();
    rejectDraftWrites();
    act(() => editEveryField(view.result.current));
    const newer = draftFields(view.result.current), warning = view.result.current.error;
    await act(async () => acknowledgeOperation(operation.id));
    expect(draftFields(view.result.current)).toEqual(newer);
    expect(view.result.current.error).toBe(warning);
    expect(await listOperations()).toEqual([]);
  });
  it('retains a draft rejected by the real aggregate capacity limit when an earlier snapshot is cleared', () => {
    for (let i = 0; i < 10; i++) writeDraft({ ...emptyDraft('filler-' + i), text: 'x'.repeat(95000) });
    const submitted = { ...emptyDraft('a'), text: 'submitted A' };
    writeDraft(submitted);
    const view = renderHook(() => useDraft('a')), text = 'B'.repeat(60000);
    act(() => view.result.current.setText(text));
    const warning = view.result.current.error;
    expect(warning).toContain('容量上限');
    act(() => clearDraftSnapshot('a', submitted.revision));
    expect(view.result.current.text).toBe(text);
    expect(view.result.current.error).toBe(warning);
  });
  it('keeps volatile fields and their warning on generic same-key refresh notifications', () => {
    writeDraft({ ...emptyDraft('a'), text: 'submitted A' });
    const view = renderHook(() => useDraft('a'));
    rejectDraftWrites();
    act(() => editEveryField(view.result.current));
    const newer = draftFields(view.result.current), warning = view.result.current.error;
    act(() => draftChanged('a'));
    expect(draftFields(view.result.current)).toEqual(newer);
    expect(view.result.current.error).toBe(warning);
  });
  it('resumes refresh and exact-revision cleanup after the volatile draft is successfully saved', () => {
    const view = renderHook(() => useDraft('a')), failure = rejectDraftWrites();
    act(() => editEveryField(view.result.current));
    expect(view.result.current.error).toContain('草稿保存失败');
    failure.mockRestore();
    act(() => view.result.current.setText('saved after recovery'));
    expect(view.result.current.error).toBe('');
    const replacement = { ...readDraft('a'), revision: crypto.randomUUID(), text: 'explicit replacement' };
    writeDraft(replacement);
    act(() => draftChanged('a'));
    expect(draftFields(view.result.current)).toEqual(replacement);
    act(() => clearDraftSnapshot('a', replacement.revision));
    expect(view.result.current).toMatchObject({ text: '', options: {}, attachments: [], references: [], extraContext: [], outputSchema: '', error: '' });
  });
  it('retains current memory on a same-key read failure but isolates failed new-key and ABA loads', () => {
    writeDraft({ ...emptyDraft('a'), text: 'private A', attachments: [attachment] });
    const view = renderHook(({ key }) => useDraft(key), { initialProps: { key: 'a' } });
    const before = draftFields(view.result.current);
    const original = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      if (this === sessionStorage && key.startsWith('harness.draft.v1.')) throw new Error('read unavailable');
      return original.call(this, key);
    });
    act(() => draftChanged('a'));
    expect(draftFields(view.result.current)).toEqual(before);
    expect(view.result.current.error).toContain('read unavailable');
    view.rerender({ key: 'b' });
    expect(view.result.current).toMatchObject({ key: 'b', text: '', attachments: [] });
    view.rerender({ key: 'a' });
    expect(view.result.current).toMatchObject({ key: 'a', text: '', attachments: [] });
  });
  it.each(['saved', 'write-failed', 'read-failed'] as const)('merges old-instance attachment removal into a reopened volatile draft when old storage is %s', (outcome) => {
    writeDraft({ ...emptyDraft('a'), text: 'stored A', attachments: [attachment] });
    const old = renderHook(() => useDraft('a')), remove = old.result.current.removeAttachment;
    old.unmount();
    const view = renderHook(() => useDraft('a'));
    const originalSet = Storage.prototype.setItem, originalGet = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (this === sessionStorage && key.startsWith('harness.draft.v1.') &&
        (outcome === 'write-failed' || JSON.parse(value).text !== 'stored A')) throw new DOMException('quota');
      originalSet.call(this, key, value);
    });
    act(() => editEveryField(view.result.current));
    const newer = draftFields(view.result.current);
    if (outcome === 'read-failed') vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      if (this === sessionStorage && key === 'harness.draft.v1.a') throw new Error('read unavailable');
      return originalGet.call(this, key);
    });
    act(() => remove('file'));
    const { revision: _revision, updatedAt: _time, ...fields } = newer;
    expect(view.result.current).toMatchObject({ ...fields, attachments: [{ ...attachment, attachmentId: 'new-file' }] });
    expect(view.result.current.attachments).toHaveLength(1);
    expect(view.result.current.error).toContain('保存失败');
  });
  it('ignores ordinary setters from an earlier visit, including after returning to the same draft', () => {
    writeDraft({ ...emptyDraft('a'), text: 'A', options: { model: 'model-a' } });
    writeDraft({ ...emptyDraft('b'), text: 'B', options: { model: 'model-b' } });
    const view = renderHook(({ key }) => useDraft(key), { initialProps: { key: 'a' } });
    const stale = view.result.current;
    const invokeStale = () => {
      stale.setText('stale text');
      stale.setOptions({ model: 'stale model' });
      stale.setAttachments([
        { attachmentId: 'stale', name: 'stale.txt', size: 1, mimeType: 'text/plain' },
      ]);
      stale.setReferences([
        { type: 'skill', projectId: 'p', skillId: 'a'.repeat(64), label: 'stale skill' },
      ]);
      stale.setExtraContext([{ label: 'stale note', text: 'stale context' }]);
      stale.setOutputSchema('{"type":"object"}');
    };
    const originalA = readDraft('a'),
      originalB = readDraft('b');
    view.rerender({ key: 'b' });
    act(invokeStale);
    expect(readDraft('a')).toEqual(originalA);
    expect(readDraft('b')).toEqual(originalB);
    expect(view.result.current.text).toBe('B');
    view.rerender({ key: 'a' });
    const currentVisit = view.result.current;
    act(() => currentVisit.setText('new A'));
    const latestA = readDraft('a');
    act(invokeStale);
    expect(readDraft('a')).toEqual(latestA);
    expect(view.result.current.text).toBe('new A');
    act(() => currentVisit.setOptions({ model: 'new model' }));
    expect(view.result.current.options.model).toBe('new model');
    expect(view.result.current.text).toBe('new A');
  });
  it('rejects an old empty-draft insertion after A to B to A navigation', () => {
    const view = renderHook(({ key }) => useDraft(key), { initialProps: { key: 'a' } });
    const insert = view.result.current.insertTextIfEmpty;
    view.rerender({ key: 'b' });
    view.rerender({ key: 'a' });
    act(() => expect(insert('old prediction')).toBe(false));
    expect(view.result.current.text).toBe('');
    act(() => expect(view.result.current.insertTextIfEmpty('current prediction')).toBe(true));
    expect(readDraft('a').text).toBe('current prediction');
  });
  it('rejects ordinary writes after unmount while still applying original-draft attachment removal', () => {
    const attachment = { attachmentId: 'file', name: 'a.txt', size: 1, mimeType: 'text/plain' };
    writeDraft({ ...emptyDraft('a'), text: 'A', attachments: [attachment] });
    const view = renderHook(() => useDraft('a')),
      stale = view.result.current,
      before = readDraft('a');
    view.unmount();
    act(() => {
      stale.setText('stale');
      stale.setOptions({ model: 'stale' });
      stale.setAttachments([]);
      stale.setReferences([]);
      stale.setExtraContext([]);
      stale.setOutputSchema('{}');
    });
    expect(readDraft('a')).toEqual(before);
    act(() => stale.removeAttachment('file'));
    expect(readDraft('a')).toMatchObject({ text: 'A', attachments: [] });
    const empty = renderHook(() => useDraft('empty')),
      insert = empty.result.current.insertTextIfEmpty;
    empty.unmount();
    act(() => expect(insert('stale prediction')).toBe(false));
    expect(readDraft('empty').text).toBe('');
  });
  it('merges a deletion from an unmounted instance into the latest reopened draft', () => {
    const attachment = { attachmentId: 'file', name: 'a.txt', size: 1, mimeType: 'text/plain' };
    writeDraft({ ...emptyDraft('a'), text: 'old A', attachments: [attachment] });
    const old = renderHook(() => useDraft('a')),
      remove = old.result.current.removeAttachment;
    old.unmount();
    const current = renderHook(() => useDraft('a'));
    act(() => current.result.current.setText('new A after reopening'));
    act(() => remove('file'));
    expect(readDraft('a')).toMatchObject({ text: 'new A after reopening', attachments: [] });
    expect(current.result.current.text).toBe('new A after reopening');
    expect(current.result.current.attachments).toEqual([]);
  });
  it('merges an original-visit deletion into unsaved memory after returning to A', () => {
    const attachment = { attachmentId: 'file', name: 'a.txt', size: 1, mimeType: 'text/plain' };
    writeDraft({ ...emptyDraft('a'), text: 'stored A', attachments: [attachment] });
    const view = renderHook(({ key }) => useDraft(key), { initialProps: { key: 'a' } }),
      remove = view.result.current.removeAttachment;
    view.rerender({ key: 'b' });
    view.rerender({ key: 'a' });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    act(() => view.result.current.setText('latest A in memory'));
    act(() => remove('file'));
    expect(view.result.current.text).toBe('latest A in memory');
    expect(view.result.current.attachments).toEqual([]);
    expect(view.result.current.error).toContain('原草稿保存失败');
    expect(readDraft('a')).toMatchObject({ text: 'stored A', attachments: [attachment] });
  });
  it('does not reload an unsaved current draft when an old draft attachment is deleted', () => {
    writeDraft({
      ...emptyDraft('a'),
      text: 'A',
      attachments: [{ attachmentId: 'file', name: 'a.txt', size: 1, mimeType: 'text/plain' }],
    });
    const view = renderHook(({ key }) => useDraft(key), { initialProps: { key: 'a' } });
    const removeFromA = view.result.current.removeAttachment;
    view.rerender({ key: 'b' });
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === 'harness.draft.v1.b') throw new DOMException('quota');
      return original.call(this, key, value);
    });
    act(() => view.result.current.setText('B in memory only'));
    act(() => removeFromA('file'));
    expect(readDraft('a')).toMatchObject({ text: 'A', attachments: [] });
    expect(view.result.current.text).toBe('B in memory only');
    expect(view.result.current.error).toContain('草稿保存失败');
  });
  it('recovers text, options and uploaded ids independently for each project', () => {
    const a = {
      ...emptyDraft('new:a'),
      text: 'unfinished a',
      options: { model: 'custom' },
      attachments: [{ attachmentId: 'opaque', name: 'note.txt', size: 10, mimeType: 'text/plain' }],
    };
    writeDraft(a);
    writeDraft({ ...emptyDraft('new:b'), text: 'unfinished b' });
    expect(readDraft('new:a')).toEqual(a);
    expect(readDraft('new:b').text).toBe('unfinished b');
    expect(JSON.stringify(readDraft('new:a'))).not.toMatch(/base64|apiKey/);
  });
  it('cannot clear a newly edited draft using an older accepted receipt', () => {
    const old = { ...emptyDraft('a'), text: 'sent text' };
    writeDraft(old);
    const next = { ...old, revision: crypto.randomUUID(), text: 'new text' };
    writeDraft(next);
    clearDraftSnapshot('a', old.revision);
    expect(readDraft('a').text).toBe('new text');
    clearDraftSnapshot('a', next.revision);
    expect(readDraft('a').text).toBe('');
  });
  it('keeps next-turn option edits made while the previous send was pending', async () => {
    writeDraft({ ...emptyDraft('a'), text: 'same text', options: { model: 'model-a' } });
    let finish!: (response: unknown) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const { result } = renderHook(() => useDraft('a'));
    const pending = new Api().mutate('turn/start', {
      threadId: 'a',
      text: 'same text',
      options: { model: 'model-a' },
    });
    act(() => result.current.setOptions({ model: 'model-b', approvalPolicy: 'never' }));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    await act(async () => {
      finish({ ok: true, json: async () => ({ ok: true, result: { turn: { id: 't' } } }) });
      await pending;
    });
    expect(readDraft('a').text).toBe('same text');
    expect(result.current.options).toEqual({ model: 'model-b', approvalPolicy: 'never' });
  });
  it('leaves the typed text visible when persistent saving fails', () => {
    const { result } = renderHook(() => useDraft('new:a'));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    act(() => result.current.setText('must remain visible'));
    expect(result.current.text).toBe('must remain visible');
    expect(result.current.error).toContain('草稿保存失败');
  });
  it('rejects capacity growth without deleting another unhandled draft', () => {
    for (let i = 0; i < 50; i++) writeDraft({ ...emptyDraft(`new:${i}`), text: `draft ${i}` });
    expect(() => writeDraft(emptyDraft('new:51'))).toThrow('容量上限');
    expect(readDraft('new:0').text).toBe('draft 0');
  });
});
