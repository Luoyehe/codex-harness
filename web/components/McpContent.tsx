import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { mediaBytes, mediaMime } from '../lib/media';
import { array, message, object, safeUrl } from '../lib/types';

type Preview = { owner: object; scope: unknown; url: string };
type Previews = {
  active?: Preview;
  enabled: boolean;
  open: (owner: object, blob: Blob) => void;
  close: (owner: object, expected?: Preview) => boolean;
};
const MediaContext = createContext<Previews | undefined>(undefined);

/** One decoded preview across the current panel's resources and retained results. */
export function McpMediaProvider({
  scope,
  enabled = true,
  children,
}: {
  scope: unknown;
  enabled?: boolean;
  children: ReactNode;
}) {
  const [active, setActive] = useState<Preview>(),
    held = useRef<Preview | undefined>(undefined),
    current = useRef({ scope, enabled });
  current.current = { scope, enabled };
  const close = useCallback((owner: object, expected?: Preview) => {
    const value = held.current;
    if (!value || value.owner !== owner || (expected && value !== expected)) return false;
    held.current = undefined;
    URL.revokeObjectURL(value.url);
    setActive(undefined);
    return true;
  }, []);
  const open = useCallback(
    (owner: object, blob: Blob) => {
      if (
        !current.current.enabled ||
        current.current.scope !== scope ||
        held.current?.owner === owner
      )
        return;
      const url = URL.createObjectURL(blob);
      if (held.current) close(held.current.owner);
      const value = { owner, scope, url };
      held.current = value;
      setActive(value);
    },
    [scope, close],
  );
  useEffect(
    () => () => {
      const value = held.current;
      if (value && value.scope === scope) close(value.owner);
    },
    [scope, enabled, close],
  );
  const previews = useMemo(
    () => ({
      active: enabled && active?.scope === scope ? active : undefined,
      enabled,
      open,
      close,
    }),
    [active, scope, enabled, open, close],
  );
  return <MediaContext.Provider value={previews}>{children}</MediaContext.Provider>;
}

function McpMedia({
  content,
  identity,
  item,
  index,
  kind,
  data,
  mimeType,
}: {
  content: unknown;
  identity: unknown;
  item: unknown;
  index: number;
  kind: 'image' | 'audio';
  data: unknown;
  mimeType: unknown;
}) {
  const previews = useContext(MediaContext)!,
    owner = useMemo(() => ({}), [content, identity, item, index, kind, data, mimeType]);
  const [error, setError] = useState<{ owner: object; text: string }>();
  const preview = previews.active?.owner === owner ? previews.active : undefined;
  useEffect(
    () => () => {
      previews.close(owner);
    },
    [owner, previews.close],
  );
  const mediaRef = useCallback(
    (node: HTMLImageElement | HTMLAudioElement | null) => {
      if (!node || !preview) return;
      // StrictMode reattaches the same node after its cleanup removed the source.
      if (node.getAttribute('src') !== preview.url) node.setAttribute('src', preview.url);
      return () => {
        node.removeAttribute('src');
        if (node instanceof HTMLMediaElement) {
          node.pause();
          node.load();
        }
      };
    },
    [preview],
  );
  const load = () => {
    setError(undefined);
    try {
      const types =
        kind === 'image'
          ? ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
          : ['audio/wav', 'audio/mpeg', 'audio/ogg'];
      if (typeof mimeType !== 'string' || !types.includes(mimeType))
        throw new Error('此 MCP 媒体类型不支持预览。可下载原结果 JSON 检查内容。');
      if (typeof data !== 'string' || data.length > 1_400_000 || data.startsWith('data:'))
        throw new Error('MCP 媒体必须是有效 Base64，且不超过 1,400,000 字符。');
      const bytes = mediaBytes(data),
        detected = mediaMime(bytes, kind);
      if (detected !== mimeType)
        throw new Error('MCP 媒体声明的类型与文件内容不匹配，未加载预览。');
      previews.open(owner, new Blob([bytes as Uint8Array<ArrayBuffer>], { type: detected }));
    } catch (error) {
      setError({ owner, text: message(error) });
    }
  };
  const failed = () => {
    // A delayed error from an earlier load must not close a replacement preview.
    if (preview && previews.close(owner, preview))
      setError({ owner, text: '浏览器无法读取此媒体，已释放预览。原始结果仍保留。' });
  };
  const label = `MCP ${kind === 'image' ? '图片' : '音频'} ${index + 1}`;
  return (
    <div className="info-card stack">
      <strong>{label}</strong>
      {preview ? (
        <>
          {kind === 'image' ? (
            <img ref={mediaRef} src={preview.url} alt={label} onError={failed} />
          ) : (
            <audio ref={mediaRef} src={preview.url} controls preload="none" onError={failed} />
          )}
          <button className="button small" onClick={() => previews.close(owner, preview)}>
            收起 {label}
          </button>
        </>
      ) : (
        <button className="button small" disabled={!previews.enabled} onClick={load}>
          {kind === 'image' ? '预览' : '加载'} {label}
        </button>
      )}
      {error?.owner === owner && (
        <p className="error small" role="alert">
          {error.text}
        </p>
      )}
    </div>
  );
}

type ContentProps = { content: unknown; identity?: unknown; onResource?: (uri: string) => void };
function McpItems({ content, identity = content, onResource }: ContentProps) {
  const items = array<unknown>(content);
  return (
    <div className="mcp-content stack">
      {items.some((item) => ['image', 'audio'].includes(String(object(item).type))) && (
        <p className="small muted">
          媒体需单独加载；此面板同时只预览一项，加载其他项会收起当前预览。
        </p>
      )}
      {items.map((item, index) => {
        const value = object(item),
          type = String(value.type ?? 'resource');
        if (type === 'text')
          return (
            <pre className="mcp-text" key={index}>
              {String(value.text ?? '')}
            </pre>
          );
        if (type === 'image' || type === 'audio')
          return (
            <McpMedia
              key={index}
              content={content}
              identity={identity}
              item={item}
              index={index}
              kind={type}
              data={value.data}
              mimeType={value.mimeType}
            />
          );
        if (type === 'resource_link')
          return (
            <div className="info-card stack" key={index}>
              <strong>{String(value.title ?? value.name ?? '资源链接')}</strong>
              <code className="path">{String(value.uri ?? '')}</code>
              {typeof value.uri === 'string' && onResource && (
                <button className="button small" onClick={() => onResource(value.uri as string)}>
                  通过此 MCP 服务读取资源
                </button>
              )}
              {safeUrl(value.uri) && (
                <a href={safeUrl(value.uri)} target="_blank" rel="noreferrer">
                  打开资源网址 ↗
                </a>
              )}
            </div>
          );
        const resource = type === 'resource' && value.resource ? object(value.resource) : value;
        if (typeof resource.text === 'string')
          return (
            <article className="info-card stack" key={index}>
              {Boolean(resource.uri) && <code className="path">{String(resource.uri)}</code>}
              <pre className="mcp-text">{resource.text}</pre>
            </article>
          );
        if (typeof resource.blob === 'string')
          return (
            <div className="info-card" key={index}>
              <code className="path">{String(resource.uri ?? '')}</code>
              <p>
                二进制资源 · {String(resource.mimeType ?? '未知类型')} · Base64{' '}
                {resource.blob.length.toLocaleString()} 字符
              </p>
            </div>
          );
        return (
          <div className="info-card" key={index}>
            <p>{type} 内容不能安全内嵌展示。</p>
            <pre className="raw">{JSON.stringify(value, null, 2)}</pre>
          </div>
        );
      })}
    </div>
  );
}
export function McpContent(props: ContentProps) {
  const previews = useContext(MediaContext);
  return previews ? (
    <McpItems {...props} />
  ) : (
    <McpMediaProvider scope={props.content}>
      <McpItems {...props} />
    </McpMediaProvider>
  );
}
