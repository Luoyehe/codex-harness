import { useEffect, useRef, useState } from 'react';
import { useResource } from '../hooks/useResource';
import type { Api } from '../lib/api';
import { downloadBlob } from '../lib/download';
import { MEDIA_BYTES, mediaBytes } from '../lib/media';
import { message } from '../lib/types';

type SourceFile = { attachmentId: string; name: string; mimeType: string; size: number };
const method = 'thread/queue/handoff/candidates';
export function QueueHandoffOriginals({ api, threadId, handoffId, count, scope }: {
  api: Api; threadId: string; handoffId: string; count: number; scope: string;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const owner = JSON.stringify([scope, threadId, handoffId]), current = useRef(owner), request = useRef<AbortController | null>(null);
  current.current = owner;
  useEffect(() => () => { request.current?.abort(); request.current = null; }, [owner]);
  const list = useResource(owner, signal => api.call<{ data: SourceFile[] }>(method, { threadId, handoffId }, signal), open);
  async function download(file: SourceFile) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller; setBusy(file.attachmentId); setError('');
    try {
      const response = await api.call<SourceFile & { base64: string }>(method, { threadId, handoffId, attachmentId: file.attachmentId }, controller.signal);
      if (controller.signal.aborted || current.current !== owner) return;
      if (response.attachmentId !== file.attachmentId || response.name !== file.name || response.mimeType !== file.mimeType ||
          response.size !== file.size || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MEDIA_BYTES ||
          typeof response.base64 !== 'string' || response.base64.length !== Math.ceil(file.size / 3) * 4) throw new Error('候选原件的编号或大小与所选记录不符。');
      const bytes = mediaBytes(response.base64);
      if (bytes.length !== file.size) throw new Error('候选原件的下载内容不完整。');
      downloadBlob(new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }), file.name);
    } catch (cause) { if (!controller.signal.aborted && current.current === owner) setError(message(cause)); }
    finally { if (request.current === controller) { request.current = null; setBusy(''); } }
  }
  return <div className="stack">
    <p className="small muted">另保留 {count} 个待核对的原上传文件，可下载比对。移除此副本后，没有其他引用的候选文件可被清理。</p>
    <button type="button" className="button small" aria-expanded={open} onClick={() => {
      if (open) { request.current?.abort(); request.current = null; setBusy(''); setError(''); }
      setOpen(!open);
    }}>{open ? '收起候选原件' : '查看候选原件'}</button>
    {open && list.loading && <span role="status">正在读取候选原件…</span>}
    {open && list.error && <p role="alert">{list.error} <button type="button" className="button small" onClick={list.refresh}>重新读取</button></p>}
    {open && list.data && <ul>{list.data.data.map(file => <li key={file.attachmentId}>
      <span>{file.name}（{file.size.toLocaleString()} 字节）</span>{' '}
      <button type="button" className="button small" disabled={!!busy} onClick={() => void download(file)}>
        {busy === file.attachmentId ? '正在下载…' : '下载原文件'}
      </button>
    </li>)}</ul>}
    {open && error && <p role="alert">{error}</p>}
  </div>;
}
