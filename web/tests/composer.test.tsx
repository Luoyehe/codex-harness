// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Api } from '../lib/api';
import { Composer } from '../components/Composer';
import { useDraft } from '../hooks/useDraft';
import { emptyDraft, readDraft, writeDraft } from '../lib/drafts';
afterEach(cleanup);
describe('composer keyboard ownership', () => {
  it('keeps only current environment controls and draft callbacks across repeated navigation', async () => {
    sessionStorage.clear();
    for (const id of ['a', 'b', 'c'])
      writeDraft({ ...emptyDraft(id), text: `unsent ${id}`, options: { model: `model-${id}` } });
    let finishOldRead!: (value: unknown) => void;
    const call = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOldRead = resolve;
          }),
      )
      .mockResolvedValue({
        data: [
          {
            environmentId: 'current',
            name: 'Current worker',
            endpoint: 'wss://current.invalid',
            selectionReady: true,
          },
        ],
      });
    const api = { call } as unknown as Api;
    function Harness({ id }: { id: string }) {
      const draft = useDraft(id);
      return (
        <Composer
          api={api}
          contextKey={id}
          value={draft.text}
          onChange={draft.setText}
          onSend={async () => false}
          onStop={() => {}}
          busy={false}
          disabled={false}
          active={false}
          options={draft.options}
          onOptions={draft.setOptions}
          models={[]}
          defaults={undefined}
          defaultsLoading={false}
          notice=""
          onReferences={draft.setReferences}
          onExtraContext={draft.setExtraContext}
          onOutputSchema={draft.setOutputSchema}
        />
      );
    }
    const view = render(<Harness id="a" />);
    fireEvent.click(screen.getByRole('button', { name: '对话设置' }));
    fireEvent.click(screen.getByText('执行环境 · 本机项目', { selector: 'summary' }));
    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    const oldPicker = view.container.querySelector('.environment-picker')!;
    for (const id of ['b', 'c', 'a', 'b']) {
      view.rerender(<Harness id={id} />);
      expect(view.container.querySelectorAll('.environment-picker')).toHaveLength(1);
      expect(screen.getAllByRole('button', { name: '引用与输出格式', hidden: true })).toHaveLength(1);
      expect(
        (screen.getByRole('textbox', { name: '给 Codex 的消息' }) as HTMLTextAreaElement).value,
      ).toBe(`unsent ${id}`);
    }
    expect(oldPicker.isConnected).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '对话设置' }));
    fireEvent.click(screen.getByText('执行环境 · 本机项目', { selector: 'summary' }));
    const current = await screen.findByRole('checkbox', { name: /Current worker/ });
    await act(async () =>
      finishOldRead({
        data: [
          {
            environmentId: 'old',
            name: 'Old worker',
            endpoint: 'wss://old.invalid',
            selectionReady: true,
          },
        ],
      }),
    );
    expect(screen.queryByRole('checkbox', { name: /Old worker/ })).toBeNull();
    fireEvent.click(current);
    expect(readDraft('b')).toMatchObject({
      text: 'unsent b',
      options: { model: 'model-b', environments: ['current'] },
    });
    expect(readDraft('a')).toMatchObject({ text: 'unsent a', options: { model: 'model-a' } });
    expect(readDraft('c')).toMatchObject({ text: 'unsent c', options: { model: 'model-c' } });
    expect(
      (screen.getByRole('textbox', { name: '给 Codex 的消息' }) as HTMLTextAreaElement).value,
    ).toBe('unsent b');
  });
  it('applies a late attachment deletion to its original draft without replacing either draft text', async () => {
    sessionStorage.clear();
    const attachment = { attachmentId: 'a-file', name: 'a.txt', mimeType: 'text/plain', size: 1 };
    writeDraft({
      ...emptyDraft('a'),
      text: 'unsent A',
      attachments: [attachment],
      options: { model: 'A-model' },
    });
    writeDraft({ ...emptyDraft('b'), text: 'unsent B' });
    let finish!: () => void;
    const api = {
      mutate: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    } as unknown as Api;
    function Harness({ id }: { id: string }) {
      const draft = useDraft(id);
      return (
        <Composer
          api={api}
          contextKey={id}
          value={draft.text}
          onChange={draft.setText}
          savedAttachments={draft.attachments}
          onAttachmentsChange={draft.setAttachments}
          onAttachmentRemoved={draft.removeAttachment}
          onSend={async () => false}
          onStop={() => {}}
          busy={false}
          disabled={false}
          active={false}
          options={draft.options}
          onOptions={draft.setOptions}
          models={[]}
          defaults={undefined}
          defaultsLoading={false}
          notice=""
        />
      );
    }
    const view = render(<Harness id="a" />);
    fireEvent.click(screen.getByRole('button', { name: '移除 a.txt' }));
    fireEvent.change(screen.getByRole('textbox', { name: '给 Codex 的消息' }), {
      target: { value: 'edited A during deletion' },
    });
    view.rerender(<Harness id="b" />);
    const before = readDraft('b');
    await act(async () => finish());
    expect(readDraft('a')).toMatchObject({
      text: 'edited A during deletion',
      options: { model: 'A-model' },
      attachments: [],
    });
    expect(readDraft('b')).toEqual(before);
    expect(
      (screen.getByRole('textbox', { name: '给 Codex 的消息' }) as HTMLTextAreaElement).value,
    ).toBe('unsent B');
    view.rerender(<Harness id="a" />);
    expect(
      (screen.getByRole('textbox', { name: '给 Codex 的消息' }) as HTMLTextAreaElement).value,
    ).toBe('edited A during deletion');
    expect(screen.queryByRole('button', { name: '移除 a.txt' })).toBeNull();
  });
  it('leaves IME confirmation and keyCode 229 to the input method', () => {
    const send = vi.fn().mockResolvedValue(false);
    render(
      <Composer
        api={{ mutate: vi.fn() } as unknown as Api}
        value="待发送草稿"
        onChange={vi.fn()}
        onSend={send}
        onStop={vi.fn()}
        busy={false}
        disabled={false}
        active={false}
        options={{}}
        onOptions={vi.fn()}
        models={[]}
        defaults={undefined}
        defaultsLoading={false}
        notice=""
        contextKey="a"
      />,
    );
    const input = screen.getByRole('textbox', { name: '给 Codex 的消息' });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(send).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(send).toHaveBeenCalledOnce();
    expect((input as HTMLTextAreaElement).value).toBe('待发送草稿');
  });
  it('never sends when recovery or history synchronization has disabled admission', () => {
    const send = vi.fn();
    render(
      <Composer
        api={{} as Api}
        value="preserve me"
        onChange={vi.fn()}
        onSend={send}
        onStop={vi.fn()}
        busy={false}
        disabled
        active={false}
        options={{}}
        onOptions={vi.fn()}
        models={[]}
        defaults={undefined}
        defaultsLoading={true}
        notice="同步历史中"
        contextKey="a"
      />,
    );
    fireEvent.keyDown(screen.getByRole('textbox', { name: '给 Codex 的消息' }), { key: 'Enter' });
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('同步历史中');
  });
  it('announces the first upload before any attachment exists and retains a failed draft', async () => {
    let rejectUpload!: (e: Error) => void;
    const pending = new Promise((_, reject) => {
        rejectUpload = reject;
      }),
      mutate = vi.fn().mockReturnValue(pending);
    render(
      <Composer
        api={{ mutate } as unknown as Api}
        value="keep this draft"
        onChange={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
        busy={false}
        disabled={false}
        active={false}
        options={{}}
        onOptions={vi.fn()}
        models={[]}
        defaults={undefined}
        defaultsLoading={false}
        notice=""
        contextKey="a"
      />,
    );
    const file = new File(['a'], 'note.txt', { type: 'text/plain' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([97]).buffer });
    fireEvent.change(screen.getByLabelText('选择附件'), { target: { files: [file] } });
    await waitFor(() => expect(mutate).toHaveBeenCalledOnce());
    expect(screen.getByText('正在上传 1 个附件…')).toBeTruthy();
    await act(async () => rejectUpload(new Error('upload unavailable')));
    await screen.findByText('upload unavailable');
    expect(
      (screen.getByRole('textbox', { name: '给 Codex 的消息' }) as HTMLTextAreaElement).value,
    ).toBe('keep this draft');
  });
});
