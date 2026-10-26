// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MessageMedia } from '../components/MessageMedia';
import { Messages } from '../components/Messages';
import { RpcError, type Api } from '../lib/api';
import { externalMediaUrl, mediaBytes, mediaMime, projectMediaPath } from '../lib/media';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const image = {
  type: 'userMessage',
  id: 'item',
  content: [{ type: 'localImage', path: '/native/attachments/one' }],
};
beforeEach(() => {
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:fixture');
      static revokeObjectURL = vi.fn();
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
test('history attachments are read only on demand and release object URLs on context change', async () => {
  const call = vi.fn().mockResolvedValue({ name: 'one.png', size: atob(png).length, base64: png });
  const api = { call } as unknown as Api,
    view = render(<MessageMedia api={api} threadId="one" item={image} />);
  expect(call).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '预览图片' }));
  await screen.findByRole('img', { name: '附加图片' });
  expect(call).toHaveBeenCalledWith(
    'attachment/history/read',
    { threadId: 'one', path: '/native/attachments/one' },
    expect.any(AbortSignal),
  );
  view.rerender(<MessageMedia api={api} threadId="two" item={image} />);
  await waitFor(() => expect(screen.queryByRole('img')).toBeNull());
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fixture');
});
test('project media reads metadata then downloads the exact version; paths outside the project never reach download', async () => {
  const revision = 'a'.repeat(64),
    call = vi.fn().mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'attachment/history/read')
        throw new RpcError('not indexed', 'not_found', 'not_sent');
      return method === 'workspace/metadata'
        ? { path: params.path, kind: 'file', bytes: atob(png).length, revision }
        : { path: params.path, bytes: atob(png).length, revision, base64: png };
    });
  const api = { call } as unknown as Api,
    project = { id: 'project', name: 'Project', cwd: '/workspace' };
  const view = render(
    <MessageMedia
      api={api}
      threadId="one"
      project={project}
      item={{ type: 'imageView', id: 'view', path: '/workspace/result.png' }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '预览图片' }));
  await screen.findByRole('img');
  expect(call).toHaveBeenCalledWith(
    'workspace/download',
    { projectId: 'project', path: 'result.png', expectedRevision: revision },
    expect.any(AbortSignal),
  );
  call.mockClear();
  view.rerender(
    <MessageMedia
      api={api}
      threadId="one"
      project={project}
      item={{ type: 'imageView', id: 'view', path: '/secrets/result.png' }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '预览图片' }));
  await screen.findByText(/不会读取其他服务器路径/);
  expect(call.mock.calls.map((args) => args[0])).toEqual(['attachment/history/read']);
});
test('external media remains a deliberate link with no automatic image fetch and rejects credential URLs', () => {
  const call = vi.fn();
  render(
    <MessageMedia
      api={{ call } as unknown as Api}
      threadId="one"
      item={{
        id: 'remote',
        type: 'userMessage',
        content: [{ type: 'image', url: 'https://images.example/view?token=private' }],
      }}
    />,
  );
  expect(screen.queryByRole('img')).toBeNull();
  expect(screen.getByRole('link').getAttribute('rel')).toBe('noreferrer');
  expect(call).not.toHaveBeenCalled();
  expect(
    externalMediaUrl('https://' + ['user', 'secret'].join(':') + '@images.example/a'),
  ).toBeUndefined();
  expect(externalMediaUrl('http://images.example/a')).toBeUndefined();
});
test('unsafe media signatures, excessive image dimensions and escaping project paths are rejected', () => {
  expect(mediaMime(mediaBytes(png), 'image')).toBe('image/png');
  for (const raw of ['<svg onload="alert(1)"></svg>', '<html>html</html>'])
    expect(() =>
      mediaMime(
        Uint8Array.from(raw, (char) => char.charCodeAt(0)),
        'image',
      ),
    ).toThrow();
  const giant = mediaBytes(png);
  new DataView(giant.buffer).setUint32(16, 100000);
  expect(() => mediaMime(giant, 'image')).toThrow();
  expect(() => mediaBytes('a'.repeat(6 * 1024 * 1024))).toThrow();
  expect(projectMediaPath('/workspace', '/workspace/../secret')).toBeUndefined();
  expect(projectMediaPath('/workspace', '/workspace-other/a')).toBeUndefined();
});

test('an empty retained file remains downloadable without treating it as playable media', async () => {
  const call = vi.fn().mockResolvedValue({ name: 'empty.txt', size: 0, base64: '' });
  render(
    <MessageMedia
      api={{ call } as unknown as Api}
      threadId="thread"
      item={{
        id: 'file',
        type: 'userMessage',
        content: [
          { type: 'text', text: 'Attached file "empty.txt" is available at "/attachments/empty".' },
        ],
      }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '读取附件' }));
  expect(await screen.findByRole('link', { name: '下载 empty.txt' })).toBeTruthy();
  expect(() => mediaBytes('')).toThrow();
  expect(mediaBytes('', true)).toHaveLength(0);
});
test('an old read completing after thread switch cannot show media in the new thread', async () => {
  let finish!: (value: unknown) => void;
  const call = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    ),
    api = { call } as unknown as Api;
  const view = render(<MessageMedia api={api} threadId="old" item={image} />);
  fireEvent.click(screen.getByRole('button', { name: '预览图片' }));
  view.rerender(<MessageMedia api={api} threadId="new" item={image} />);
  finish({ name: 'one.png', size: atob(png).length, base64: png });
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '预览图片' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  expect(screen.queryByRole('img')).toBeNull();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
test('hook prompt fragments display source and text without interpreting markup as authorization', () => {
  Element.prototype.scrollIntoView = vi.fn();
  render(
    <Messages
      turns={[
        {
          id: 'turn',
          status: 'completed',
          items: [
            {
              id: 'hook',
              type: 'hookPrompt',
              fragments: [{ hookRunId: 'run-one', text: '<script>execute</script>' }],
            },
          ],
        },
      ]}
      loading={false}
      complete
      onMore={() => {}}
    />,
  );
  expect(screen.getByText(/不构成执行授权/)).toBeTruthy();
  expect(screen.getByText('来源：run-one')).toBeTruthy();
  expect(screen.getByText('<script>execute</script>')).toBeTruthy();
});
