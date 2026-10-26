// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Api } from '../lib/api';
import { AttachmentButton } from '../components/AttachmentButton';
// Header-only fixtures never enter an image decoder: jsdom and the object URL stub do not load media.
function png(width = 1, height = 1) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return btoa(String.fromCharCode(...bytes));
}
const attachment = (base64 = png(), changed: Record<string, unknown> = {}) => ({
  attachmentId: 'a',
  base64,
  size: atob(base64).length,
  mimeType: 'image/png',
  name: 'file.png',
  ...changed,
});
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  URL.createObjectURL = vi.fn().mockReturnValue('blob:preview');
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);
describe('attachment preview resource lifetime', () => {
  it('does not create a blob URL for a read that finishes after navigation', async () => {
    let resolve!: (v: unknown) => void;
    const pending = new Promise((r) => {
      resolve = r;
    });
    const view = render(
      <AttachmentButton
        api={{ call: vi.fn().mockReturnValue(pending) } as unknown as Api}
        attachmentId="a"
        name="file.png"
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    view.unmount();
    await act(async () => resolve(attachment()));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('releases a visible preview exactly once on close and unmount', async () => {
    const view = render(
      <AttachmentButton
        api={{ call: vi.fn().mockResolvedValue(attachment()) } as unknown as Api}
        attachmentId="a"
        name="file.png"
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    await screen.findByRole('dialog');
    expect(screen.getByRole('img', { name: 'file.png' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '关闭对话框' }));
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:preview');
  });
  it('keeps an oversized PNG header downloadable without exposing it to an image decoder', async () => {
    const { container } = render(
      <AttachmentButton
        api={{ call: vi.fn().mockResolvedValue(attachment(png(65535, 65535))) } as unknown as Api}
        attachmentId="a"
        name="file.png"
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    await screen.findByRole('dialog');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: '下载附件' })).toBeTruthy();
    expect(screen.getByText(/图片格式或尺寸不适合预览/)).toBeTruthy();
    expect((vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob).type).toBe(
      'application/octet-stream',
    );
  });
  it.each([
    ['pixel budget', png(7000, 7000), 'image/png'],
    ['wrong signature', btoa('not an image'), 'image/png'],
    ['declared type mismatch', png(), 'image/jpeg'],
    ['unsupported SVG', btoa('<svg/>'), 'image/svg+xml'],
  ])(
    'preserves a safe binary download when image preview rejects %s',
    async (_label, base64, mimeType) => {
      const { container } = render(
        <AttachmentButton
          api={
            { call: vi.fn().mockResolvedValue(attachment(base64, { mimeType })) } as unknown as Api
          }
          attachmentId="a"
          name="file.png"
        />,
      );
      fireEvent.click(screen.getByRole('button'));
      await screen.findByRole('dialog');
      expect(container.querySelector('img,audio,video,svg,iframe,object')).toBeNull();
      expect(screen.getByRole('link', { name: '下载附件' }).getAttribute('download')).toBe(
        'file.png',
      );
      const blob = vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob;
      expect(blob.type).toBe('application/octet-stream');
      expect(blob.size).toBe(atob(base64).length);
      expect(screen.getByText(/可下载原文件到本地查看/)).toBeTruthy();
    },
  );
  it.each([
    ['foreign identity', { attachmentId: 'foreign' }],
    ['incorrect byte count', { size: 1 }],
    ['oversized metadata', { size: 4 * 1024 * 1024 + 1 }],
    ['missing type', { mimeType: undefined }],
    ['invalid name', { name: 42 }],
    ['invalid base64', { base64: 'YQ', size: 1 }],
    ['data URL in raw bytes', { base64: 'data:image/png;base64,' + png() }],
  ] as const)(
    'rejects %s before allocating a downloadable or image URL',
    async (_label, changed) => {
      const { container } = render(
        <AttachmentButton
          api={{ call: vi.fn().mockResolvedValue(attachment(png(), changed)) } as unknown as Api}
          attachmentId="a"
          name="file.png"
        />,
      );
      fireEvent.click(screen.getByRole('button'));
      await screen.findByRole('alert');
      expect(URL.createObjectURL).not.toHaveBeenCalled();
      expect(container.querySelector('img,a')).toBeNull();
      expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false);
    },
  );
  it.each([
    ['unknown MIME', 'not-a-mime', 'application/octet-stream'],
    ['control-bearing MIME', 'image/png\ntext/html', 'application/octet-stream'],
    ['unrecognized text type', 'text/unknown type', 'application/octet-stream'],
    ['valid uncommon token characters', "application/x-test'%*~", "application/x-test'%*~"],
  ])('preserves ordinary raw download for %s', async (_label, mimeType, expectedType) => {
    const { container } = render(
      <AttachmentButton
        api={
          { call: vi.fn().mockResolvedValue(attachment('YQ==', { mimeType })) } as unknown as Api
        }
        attachmentId="a"
        name="file.png"
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    await screen.findByRole('dialog');
    expect(screen.getByRole('link', { name: '下载附件' })).toBeTruthy();
    expect(container.querySelector('img,audio,video,script,iframe,object,pre')).toBeNull();
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob;
    expect(blob.size).toBe(1);
    expect(blob.type).toBe(expectedType);
    if (expectedType === 'application/octet-stream')
      expect(screen.getByText('附件声明的类型无法安全预览，已按普通文件提供下载。')).toBeTruthy();
  });
  it.each([
    ['empty ordinary file', '', 'application/octet-stream'],
    ['empty text file', '', 'text/plain'],
    ['HTML text', btoa('<script>no execution</script>'), 'text/html; charset=utf-8'],
    ['audio download', 'YQ==', 'audio/wav'],
  ])('keeps %s as its existing non-image download workflow', async (_label, base64, mimeType) => {
    const { container } = render(
      <AttachmentButton
        api={
          {
            call: vi.fn().mockResolvedValue(attachment(base64, { mimeType, name: 'file.dat' })),
          } as unknown as Api
        }
        attachmentId="a"
        name="file.dat"
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    await screen.findByRole('dialog');
    expect(container.querySelector('img,audio,video,script,iframe,object')).toBeNull();
    expect(screen.getByRole('link', { name: '下载附件' }).getAttribute('download')).toBe(
      'file.dat',
    );
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob;
    expect(blob.size).toBe(atob(base64).length);
    expect(blob.type).toBe(mimeType.split(';')[0]);
    if (mimeType.startsWith('text/html'))
      expect(screen.getByText('<script>no execution</script>')).toBeTruthy();
  });
  it.each(['attachment', 'api'])(
    'revokes a pending %s owner without stale completion clearing the new request busy state',
    async (change) => {
      let first!: (value: unknown) => void, second!: (value: unknown) => void;
      const oldRead = new Promise((resolve) => {
          first = resolve;
        }),
        newRead = new Promise((resolve) => {
          second = resolve;
        });
      const call = vi.fn().mockReturnValueOnce(oldRead).mockReturnValueOnce(newRead),
        oldApi = { call } as unknown as Api,
        nextApi =
          change === 'api'
            ? ({ call: vi.fn().mockReturnValue(newRead) } as unknown as Api)
            : oldApi;
      const nextId = change === 'attachment' ? 'b' : 'a';
      const view = render(<AttachmentButton api={oldApi} attachmentId="a" name="old.png" />);
      fireEvent.click(screen.getByRole('button'));
      const signal = call.mock.calls[0]![2] as AbortSignal;
      view.rerender(<AttachmentButton api={nextApi} attachmentId={nextId} name="next.png" />);
      expect(signal.aborted).toBe(true);
      expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(screen.getByRole('button'));
      await act(async () => first(attachment()));
      expect(URL.createObjectURL).not.toHaveBeenCalled();
      expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
      expect(screen.queryByRole('alert')).toBeNull();
      await act(async () => second(attachment(png(), { attachmentId: nextId, name: 'next.png' })));
      await screen.findByRole('dialog', { name: 'next.png' });
      expect(URL.createObjectURL).toHaveBeenCalledOnce();
      expect(
        (screen.getByRole('button', { name: '▧ next.png' }) as HTMLButtonElement).disabled,
      ).toBe(false);
    },
  );
  it('releases a visible old owner URL and hides its preview when the attachment changes', async () => {
    const api = { call: vi.fn().mockResolvedValue(attachment()) } as unknown as Api;
    const view = render(<AttachmentButton api={api} attachmentId="a" name="file.png" />);
    fireEvent.click(screen.getByRole('button'));
    await screen.findByRole('dialog');
    view.rerender(<AttachmentButton api={api} attachmentId="b" name="next.png" />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:preview');
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });
});
