// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { McpContent, McpMediaProvider } from '../components/McpContent';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const picture = (data = png, mimeType = 'image/png') => ({ type: 'image', mimeType, data });
function pngHeader(width: number, height: number) {
  const bytes = new Uint8Array(24),
    view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  view.setUint32(8, 13);
  bytes.set([73, 72, 68, 82], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return btoa(String.fromCharCode(...bytes));
}
beforeEach(() => {
  let next = 0;
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => `blob:mcp-${++next}`);
      static revokeObjectURL = vi.fn();
    },
  );
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('does not create image or audio sources until a separate preview action', () => {
  const { container } = render(
    <McpContent
      content={[picture(), { type: 'audio', mimeType: 'audio/wav', data: btoa('RIFF0000WAVE') }]}
    />,
  );
  expect(container.querySelector('img,audio')).toBeNull();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '预览 MCP 图片 1' }));
  expect(screen.getByRole('img').getAttribute('src')).toBe('blob:mcp-1');
  expect(URL.createObjectURL).toHaveBeenCalledOnce();
});
it('rejects an oversized compact PNG header before creating a source and keeps sibling text visible', () => {
  const { container } = render(
    <McpContent
      content={[picture(pngHeader(12000, 12000)), { type: 'text', text: 'retained result text' }]}
    />,
  );
  expect(container.querySelector('img')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '预览 MCP 图片 1' }));
  expect(screen.getByRole('alert').textContent).toMatch(/图片格式或尺寸/);
  expect(container.querySelector('img')).toBeNull();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(screen.getByText('retained result text')).toBeTruthy();
});

it.each([
  {
    name: 'MIME/signature mismatch',
    value: picture(png, 'image/jpeg'),
    error: /类型与文件内容不匹配/,
  },
  {
    name: 'HTML disguised as PNG',
    value: picture(btoa('<html>not an image</html>')),
    error: /图片格式或尺寸/,
  },
  { name: 'SVG', value: picture(btoa('<svg/>'), 'image/svg+xml'), error: /类型不支持/ },
  { name: 'invalid Base64 characters', value: picture('@@@@'), error: /编码无效/ },
  { name: 'invalid Base64 padding', value: picture(png + '='), error: /编码无效/ },
  { name: 'empty bytes', value: picture(''), error: /内容为空/ },
  {
    name: 'data URL instead of Base64',
    value: picture('data:image/png;base64,' + png),
    error: /有效 Base64/,
  },
  { name: 'encoded byte cap', value: picture('A'.repeat(1_400_004)), error: /1,400,000/ },
  { name: 'zero dimension', value: picture(pngHeader(0, 1)), error: /图片格式或尺寸/ },
  { name: 'side dimension cap', value: picture(pngHeader(16385, 1)), error: /图片格式或尺寸/ },
  { name: 'pixel cap', value: picture(pngHeader(10000, 4001)), error: /图片格式或尺寸/ },
  {
    name: 'audio MIME/signature mismatch',
    value: { type: 'audio', mimeType: 'audio/ogg', data: btoa('RIFF0000WAVE') },
    error: /类型与文件内容不匹配/,
  },
])('rejects $name without creating a media URL or altering the result', ({ value, error }) => {
  const content = [value, { type: 'text', text: 'keep this body' }],
    original = JSON.stringify(content);
  const { container } = render(<McpContent content={content} />);
  fireEvent.click(screen.getByRole('button', { name: /^(预览|加载) MCP/ }));
  expect(screen.getByRole('alert').textContent).toMatch(error);
  expect(container.querySelector('img,audio')).toBeNull();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(JSON.stringify(content)).toBe(original);
  expect(screen.getByText('keep this body')).toBeTruthy();
});

it('keeps only one preview across results, ignores double loads and releases on switch, close and unmount', () => {
  const first = [picture()],
    second = [{ type: 'audio', mimeType: 'audio/wav', data: btoa('RIFF0000WAVE') }];
  const view = render(
    <McpMediaProvider scope="session">
      <section aria-label="first result">
        <McpContent content={first} />
      </section>
      <section aria-label="second result">
        <McpContent content={second} />
      </section>
    </McpMediaProvider>,
  );
  const a = within(screen.getByRole('region', { name: 'first result' })),
    b = within(screen.getByRole('region', { name: 'second result' }));
  const firstLoad = a.getByRole('button', { name: '预览 MCP 图片 1' });
  act(() => {
    fireEvent.click(firstLoad);
    fireEvent.click(firstLoad);
  });
  expect(URL.createObjectURL).toHaveBeenCalledOnce();
  expect(screen.getAllByRole('img')).toHaveLength(1);
  fireEvent.click(b.getByRole('button', { name: '加载 MCP 音频 1' }));
  expect(screen.queryByRole('img')).toBeNull();
  expect(view.container.querySelectorAll('img,audio')).toHaveLength(1);
  const audio = view.container.querySelector('audio')!;
  expect(audio.getAttribute('preload')).toBe('none');
  expect(audio.autoplay).toBe(false);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mcp-1');
  fireEvent.click(b.getByRole('button', { name: '收起 MCP 音频 1' }));
  expect(view.container.querySelector('audio')).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mcp-2');
  expect(audio.hasAttribute('src')).toBe(false);
  expect(audio.pause).toHaveBeenCalledOnce();
  expect(audio.load).toHaveBeenCalledOnce();
  fireEvent.click(a.getByRole('button', { name: '预览 MCP 图片 1' }));
  view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
  expect(URL.revokeObjectURL).toHaveBeenLastCalledWith('blob:mcp-3');
});

it('keeps valid previews and non-media content usable when a different item is rejected', () => {
  const resource = vi.fn(),
    content = [
      picture(),
      picture(pngHeader(12000, 12000)),
      { type: 'text', text: 'plain text' },
      { type: 'resource', resource: { uri: 'ui://document', text: '<b>resource text</b>' } },
      { type: 'resource_link', uri: 'https://example.invalid/resource', title: 'Resource' },
      { uri: 'file:///blob', blob: 'AA==', mimeType: 'application/octet-stream' },
    ];
  render(<McpContent content={content} onResource={resource} />);
  fireEvent.click(screen.getByRole('button', { name: '预览 MCP 图片 1' }));
  fireEvent.click(screen.getByRole('button', { name: '预览 MCP 图片 2' }));
  expect(screen.getByRole('alert').textContent).toMatch(/图片格式或尺寸/);
  expect(screen.getByRole('img').getAttribute('src')).toBe('blob:mcp-1');
  expect(URL.createObjectURL).toHaveBeenCalledOnce();
  expect(screen.getByText('plain text')).toBeTruthy();
  expect(screen.getByText('<b>resource text</b>')).toBeTruthy();
  expect(screen.getByText(/二进制资源/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '通过此 MCP 服务读取资源' }));
  expect(resource).toHaveBeenCalledWith('https://example.invalid/resource');
  expect(screen.getByRole('link').getAttribute('href')).toBe('https://example.invalid/resource');
});

it.each(['identity', 'content', 'reorder', 'bytes', 'scope', 'connection'] as const)(
  'releases changed %s ownership and never restores the old preview after A-to-B-to-A',
  (field) => {
    const item = picture(),
      items: unknown[] = [item, { type: 'text', text: 'other' }],
      scope = {},
      replacement = {};
    const initial = { content: items, identity: 'first', scope, enabled: true };
    const tree = (props: typeof initial) => (
      <McpMediaProvider scope={props.scope} enabled={props.enabled}>
        <McpContent content={props.content} identity={props.identity} />
      </McpMediaProvider>
    );
    const view = render(tree(initial));
    fireEvent.click(screen.getByRole('button', { name: '预览 MCP 图片 1' }));
    const changed = { ...initial };
    if (field === 'identity') changed.identity = 'second';
    if (field === 'content') changed.content = [...items];
    if (field === 'reorder') items.reverse();
    if (field === 'bytes') item.data = 'AAAA';
    if (field === 'scope') changed.scope = replacement;
    if (field === 'connection') changed.enabled = false;
    view.rerender(tree(changed));
    expect(screen.queryByRole('img')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mcp-1');
    if (field === 'reorder') items.reverse();
    if (field === 'bytes') item.data = png;
    view.rerender(tree(initial));
    expect(screen.queryByRole('img')).toBeNull();
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '预览 MCP 图片 1' }));
    expect(screen.getByRole('img').getAttribute('src')).toBe('blob:mcp-2');
  },
);

it('releases failed decoder previews and allows an explicit retry without hiding sibling content', () => {
  render(<McpContent content={[picture(), { type: 'text', text: 'raw result retained' }]} />);
  fireEvent.click(screen.getByRole('button', { name: '预览 MCP 图片 1' }));
  fireEvent.error(screen.getByRole('img'));
  expect(screen.queryByRole('img')).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mcp-1');
  expect(screen.getByRole('alert').textContent).toMatch(/浏览器无法读取/);
  fireEvent.click(screen.getByRole('button', { name: '预览 MCP 图片 1' }));
  expect(screen.getByRole('img').getAttribute('src')).toBe('blob:mcp-2');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('raw result retained')).toBeTruthy();
});

it('does not let an old image error close a different result selected in the same event batch', () => {
  const { container } = render(
    <McpContent
      content={[picture(), { type: 'audio', mimeType: 'audio/ogg', data: btoa('OggS0000') }]}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '预览 MCP 图片 1' }));
  const old = screen.getByRole('img');
  act(() => {
    fireEvent.click(screen.getByRole('button', { name: '加载 MCP 音频 2' }));
    fireEvent.error(old);
  });
  expect(container.querySelector('audio')?.getAttribute('src')).toBe('blob:mcp-2');
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:mcp-2');
  expect(screen.queryByRole('alert')).toBeNull();
});

it('keeps the old valid preview if URL creation for another validated item fails', () => {
  render(<McpContent content={[picture(), picture()]} />);
  fireEvent.click(screen.getByRole('button', { name: '预览 MCP 图片 1' }));
  vi.mocked(URL.createObjectURL).mockImplementationOnce(() => {
    throw new Error('preview allocation failed');
  });
  fireEvent.click(screen.getByRole('button', { name: '预览 MCP 图片 2' }));
  expect(screen.getByRole('alert').textContent).toContain('preview allocation failed');
  expect(screen.getByRole('img').getAttribute('src')).toBe('blob:mcp-1');
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
});

it('ignores a late error from a collapsed image after reopening the same content owner', () => {
  render(<McpContent content={[picture()]} />);
  fireEvent.click(screen.getByRole('button', { name: '预览 MCP 图片 1' }));
  const old = screen.getByRole('img');
  fireEvent.click(screen.getByRole('button', { name: '收起 MCP 图片 1' }));
  expect(old.hasAttribute('src')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '预览 MCP 图片 1' }));
  fireEvent.error(old);
  expect(screen.getByRole('img').getAttribute('src')).toBe('blob:mcp-2');
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:mcp-2');
  expect(screen.queryByRole('alert')).toBeNull();
});

it('keeps a live preview usable through StrictMode ref and effect checks and revokes once on unmount', () => {
  const content = [picture()],
    view = render(
      <StrictMode>
        <McpMediaProvider scope="strict">
          <McpContent content={content} />
        </McpMediaProvider>
      </StrictMode>,
    );
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '预览 MCP 图片 1' }));
  expect(screen.getByRole('img').getAttribute('src')).toBe('blob:mcp-1');
  expect(URL.createObjectURL).toHaveBeenCalledOnce();
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:mcp-1');
});

it.each([
  ['image', 'image/png', png],
  ['image', 'image/gif', 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'],
  [
    'image',
    'image/jpeg',
    btoa(
      String.fromCharCode(
        255,
        216,
        255,
        192,
        0,
        17,
        8,
        0,
        1,
        0,
        1,
        3,
        1,
        17,
        0,
        2,
        17,
        1,
        3,
        17,
        1,
        255,
        217,
      ),
    ),
  ],
  ['image', 'image/webp', btoa('RIFF\x16\0\0\0WEBPVP8L\x0a\0\0\0\x2f\0\0\0\0\0\0\0\0\0')],
  ['audio', 'audio/wav', btoa('RIFF0000WAVE')],
  ['audio', 'audio/mpeg', btoa('ID3\0\0\0\0\0\0\0')],
  ['audio', 'audio/ogg', btoa('OggS0000')],
])('retains explicit preview support for %s %s with detected Blob MIME', (type, mimeType, data) => {
  const { container } = render(<McpContent content={[{ type, mimeType, data }]} />);
  fireEvent.click(screen.getByRole('button', { name: /^(预览|加载) MCP/ }));
  expect(URL.createObjectURL).toHaveBeenCalledOnce();
  expect((vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob).type).toBe(mimeType);
  expect(container.querySelector(type === 'image' ? 'img' : 'audio')?.getAttribute('src')).toBe(
    'blob:mcp-1',
  );
});
