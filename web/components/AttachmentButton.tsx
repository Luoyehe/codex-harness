import { useEffect, useMemo, useRef, useState } from 'react';
import type { Api } from '../lib/api';
import { MEDIA_BYTES, mediaBytes, mediaMime } from '../lib/media';
import { message } from '../lib/types';
import { Dialog } from './Dialog';

type Preview = {
  owner: object;
  url: string;
  name: string;
  image: boolean;
  text?: string;
  notice?: string;
};
export function AttachmentButton({
  api,
  attachmentId,
  name,
}: {
  api: Api;
  attachmentId: string;
  name: string;
}) {
  const owner = useMemo(() => ({}), [api, attachmentId]),
    current = useRef(owner);
  current.current = owner;
  const [error, setError] = useState<{ owner: object; text: string }>(),
    [busy, setBusy] = useState<object>(),
    [preview, setPreview] = useState<Preview>();
  const pending = useRef<{ owner: object; controller: AbortController } | undefined>(undefined),
    held = useRef<{ owner: object; url: string } | undefined>(undefined);
  const release = (scope: object) => {
    if (held.current?.owner === scope) {
      URL.revokeObjectURL(held.current.url);
      held.current = undefined;
    }
  };
  useEffect(
    () => () => {
      if (pending.current?.owner === owner) {
        pending.current.controller.abort();
        pending.current = undefined;
      }
      release(owner);
    },
    [owner],
  );
  const load = async () => {
    if (pending.current?.owner === owner) return;
    const request = { owner, controller: new AbortController() };
    pending.current = request;
    setBusy(owner);
    setError(undefined);
    const owns = () =>
      current.current === owner &&
      pending.current === request &&
      !request.controller.signal.aborted;
    try {
      const result = await api.call<{
        attachmentId: string;
        base64: string;
        mimeType: string;
        name: string;
        size: number;
      }>('attachment/read', { attachmentId }, request.controller.signal);
      if (!owns()) return;
      if (
        !result ||
        result.attachmentId !== attachmentId ||
        typeof result.base64 !== 'string' ||
        result.base64.startsWith('data:') ||
        typeof result.name !== 'string' ||
        !result.name.length ||
        result.name.length > 256 ||
        result.name.includes('\0') ||
        typeof result.mimeType !== 'string' ||
        result.mimeType.length > 128 ||
        !Number.isSafeInteger(result.size) ||
        result.size < 0 ||
        result.size > MEDIA_BYTES
      )
        throw new Error('附件响应身份、类型或大小无效。');
      const declared = result.mimeType.split(';')[0]!.trim().toLowerCase();
      const mime =
        /^[a-z0-9!#$%&'*+.^_`|~-]+\/[a-z0-9!#$%&'*+.^_`|~-]+$/.test(declared) &&
        !/[\u0000-\u001f\u007f]/.test(result.mimeType)
          ? declared
          : undefined;
      const bytes = mediaBytes(result.base64, true);
      if (bytes.length !== result.size) throw new Error('附件响应的字节数不匹配。');
      let image = false,
        downloadMime = mime ?? 'application/octet-stream',
        notice: string | undefined = mime
          ? undefined
          : '附件声明的类型无法安全预览，已按普通文件提供下载。';
      if (mime?.startsWith('image/')) {
        try {
          if (mediaMime(bytes, 'image') !== mime) throw new Error('图片声明类型与文件内容不匹配。');
          image = true;
        } catch (e) {
          downloadMime = 'application/octet-stream';
          notice = `${message(e)} 可下载原文件到本地查看。`;
        }
      }
      const url = URL.createObjectURL(
        new Blob([bytes as Uint8Array<ArrayBuffer>], { type: downloadMime }),
      );
      release(owner);
      held.current = { owner, url };
      setPreview({
        owner,
        url,
        name: result.name,
        image,
        notice,
        ...(mime?.startsWith('text/')
          ? { text: new TextDecoder().decode(bytes.slice(0, 65536)) }
          : {}),
      });
    } catch (e) {
      if (owns()) setError({ owner, text: message(e) });
    } finally {
      if (pending.current === request) {
        pending.current = undefined;
        if (current.current === owner) setBusy(undefined);
      }
    }
  };
  const visible = preview?.owner === owner ? preview : undefined;
  return (
    <>
      <button
        className="attachment-download"
        disabled={busy === owner}
        title="查看已上传附件"
        onClick={() => void load()}
      >
        {busy === owner ? '读取中…' : `▧ ${name}`}
      </button>
      {error?.owner === owner && (
        <small className="error" role="alert">
          {error.text}
        </small>
      )}
      {visible && (
        <Dialog
          title={visible.name}
          onClose={() => {
            setPreview(undefined);
            release(owner);
          }}
          wide
        >
          <div className="stack">
            {visible.image ? (
              <img
                src={visible.url}
                alt={visible.name}
                style={{ maxWidth: '100%', maxHeight: '60vh', objectFit: 'contain' }}
              />
            ) : visible.text !== undefined ? (
              <>
                <pre className="raw">{visible.text}</pre>
                <p className="muted small">文本预览最多显示 64 KiB。</p>
              </>
            ) : (
              <p className="muted">{visible.notice ?? '此文件可下载到本地查看。'}</p>
            )}
            <a href={visible.url} download={visible.name} className="button primary">
              下载附件
            </a>
          </div>
        </Dialog>
      )}
    </>
  );
}
