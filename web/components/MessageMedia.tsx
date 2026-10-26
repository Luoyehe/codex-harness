import { useEffect, useRef, useState } from 'react';
import { RpcError, type Api } from '../lib/api';
import { message, type Item, type Project } from '../lib/types';
import { checkedSnapshot } from '../lib/workspace';
import {
  externalMediaUrl,
  MEDIA_BYTES,
  mediaBytes,
  mediaMime,
  mediaSources,
  projectMediaPath,
  type MediaSource,
} from '../lib/media';

function Preview({
  source,
  api,
  threadId,
  project,
}: {
  source: MediaSource;
  api?: Api;
  threadId?: string;
  project?: Project;
}) {
  const [loaded, setLoaded] = useState<{ url: string; name: string }>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null),
    heldUrl = useRef('');
  useEffect(() => {
    setLoaded(undefined);
    setError('');
    setBusy(false);
    return () => {
      pending.current?.abort();
      pending.current = null;
      if (heldUrl.current) URL.revokeObjectURL(heldUrl.current);
      heldUrl.current = '';
    };
  }, [api, threadId, project?.id, project?.cwd, source.path, source.inline, source.url]);
  const load = async () => {
    if (pending.current || source.unavailable) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    try {
      let encoded = source.inline,
        name = source.label,
        expectedBytes: unknown;
      if (!encoded) {
        if (!api || !threadId || !source.path) throw new Error('缺少可核对的会话媒体来源。');
        let data;
        try {
          data = await api.call(
            'attachment/history/read',
            { threadId, path: source.path },
            controller.signal,
          );
          expectedBytes = data.size;
        } catch (e) {
          if (!(e instanceof RpcError) || e.code !== 'not_found') throw e;
          const path = projectMediaPath(project?.cwd, source.path);
          if (!project || !path)
            throw new Error(
              '此路径不是会话保留的附件，也不在当前注册项目中。不会读取其他服务器路径。',
            );
          const snapshot = checkedSnapshot(
            await api.call(
              'workspace/metadata',
              { projectId: project.id, path },
              controller.signal,
            ),
            path,
          );
          if (snapshot.kind !== 'file' || !snapshot.revision || snapshot.bytes > MEDIA_BYTES)
            throw new Error('只预览 4 MiB 以内的普通文件。可在项目文件区检查原文件。');
          data = await api.call(
            'workspace/download',
            { projectId: project.id, path, expectedRevision: snapshot.revision },
            controller.signal,
          );
          if (data.path !== path || data.revision !== snapshot.revision)
            throw new Error('媒体文件版本发生变化，请重新读取。');
          expectedBytes = data.bytes;
          name = path.split('/').at(-1)!;
        }
        if (typeof data.base64 !== 'string') throw new Error('媒体响应没有提供文件内容。');
        if (
          !Number.isSafeInteger(expectedBytes) ||
          Number(expectedBytes) < 0 ||
          Number(expectedBytes) > MEDIA_BYTES
        )
          throw new Error('媒体响应字节数无效或超过预览限制。');
        encoded = data.base64;
        if (typeof data.name === 'string') name = data.name;
      }
      const bytes = mediaBytes(encoded, source.kind === 'file'),
        mime = mediaMime(bytes, source.kind);
      if (expectedBytes !== undefined && expectedBytes !== bytes.length)
        throw new Error('媒体响应的字节数不匹配。');
      if (controller.signal.aborted || pending.current !== controller) return;
      const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
      if (heldUrl.current) URL.revokeObjectURL(heldUrl.current);
      heldUrl.current = url;
      const extension = (
        {
          'image/jpeg': 'jpg',
          'image/png': 'png',
          'image/webp': 'webp',
          'image/gif': 'gif',
          'audio/wav': 'wav',
          'audio/mpeg': 'mp3',
          'audio/ogg': 'ogg',
          'audio/mp4': 'm4a',
          'audio/webm': 'webm',
        } as Record<string, string>
      )[mime];
      setLoaded({
        url,
        name: extension && !/\.[a-z0-9]{1,8}$/i.test(name) ? `${name}.${extension}` : name,
      });
    } catch (e) {
      if (!controller.signal.aborted) setError(message(e));
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  };
  const remote = source.url ? externalMediaUrl(source.url) : undefined;
  return (
    <div className="message-media">
      <strong>{source.label}</strong>
      {source.unavailable ? (
        <p className="muted small">{source.unavailable}</p>
      ) : source.url ? (
        remote ? (
          <>
            <p className="muted small">
              外部媒体来源：{new URL(remote).hostname}。页面不会自动请求此地址。
            </p>
            <a href={remote} target="_blank" rel="noreferrer">
              在新标签页打开外部媒体 ↗
            </a>
          </>
        ) : (
          <p className="muted small">外部媒体地址不受支持；仅提供 HTTPS 链接。</p>
        )
      ) : (
        <>
          {!loaded && (
            <button className="button small" disabled={busy} onClick={() => void load()}>
              {busy
                ? '正在读取媒体…'
                : source.kind === 'image'
                  ? '预览图片'
                  : source.kind === 'audio'
                    ? '加载音频'
                    : '读取附件'}
            </button>
          )}
          {loaded && (
            <>
              {source.kind === 'image' && <img src={loaded.url} alt={source.label} />}{' '}
              {source.kind === 'audio' && <audio src={loaded.url} controls preload="none" />}
              <a href={loaded.url} download={loaded.name}>
                下载 {loaded.name}
              </a>
              <button
                className="button small"
                onClick={() => {
                  if (heldUrl.current) URL.revokeObjectURL(heldUrl.current);
                  heldUrl.current = '';
                  setLoaded(undefined);
                }}
              >
                收起媒体
              </button>
            </>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="error small">
          {error}
        </p>
      )}
    </div>
  );
}
export function MessageMedia({
  item,
  api,
  threadId,
  project,
}: {
  item: Item;
  api?: Api;
  threadId?: string;
  project?: Project;
}) {
  return (
    <>
      {mediaSources(item).map((source, index) => (
        <Preview
          key={`${item.id}:${index}:${source.path ?? source.url ?? source.label}`}
          source={source}
          api={api}
          threadId={threadId}
          project={project}
        />
      ))}
    </>
  );
}
