import { useEffect, useRef, useState } from 'react';
import type { Api } from '../lib/api';
import { message } from '../lib/types';
import { downloadBlob } from '../lib/download';
import { validRevision, type FileSnapshot } from '../lib/workspace';
export function WorkspaceDownload({
  api,
  projectId,
  file,
  connected,
}: {
  api: Api;
  projectId: string;
  file: FileSnapshot;
  connected: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    owner = `${projectId}:${file.path}:${file.revision}`,
    current = useRef(owner),
    mounted = useRef(true);
  current.current = owner;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const download = async () => {
    if (busy || !connected || !validRevision(file.revision)) return;
    const expected = owner;
    setBusy(true);
    setError('');
    try {
      const result = await api.call<{
        path: string;
        revision: string;
        bytes: number;
        base64: string;
      }>('workspace/download', { projectId, path: file.path, expectedRevision: file.revision });
      if (!mounted.current || current.current !== expected) return;
      if (
        result.path !== file.path ||
        result.revision !== file.revision ||
        !Number.isSafeInteger(result.bytes) ||
        result.bytes < 0 ||
        result.bytes !== file.bytes ||
        result.bytes > 8 * 1024 * 1024 ||
        typeof result.base64 !== 'string' ||
        result.base64.length > Math.ceil(result.bytes / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.base64)
      )
        throw new Error('下载内容与选择的文件版本不匹配或超过 8 MiB。');
      const binary = atob(result.base64);
      if (binary.length !== result.bytes) throw new Error('下载文件长度不匹配。');
      const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
      downloadBlob(
        new Blob([bytes], { type: 'application/octet-stream' }),
        file.path.split('/').at(-1)!,
      );
    } catch (e) {
      if (mounted.current && current.current === expected) setError(message(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <span className="stack">
      <button
        className="button small"
        disabled={
          !connected ||
          busy ||
          file.downloadable === false ||
          file.bytes > 8 * 1024 * 1024 ||
          !validRevision(file.revision)
        }
        onClick={() => void download()}
      >
        {busy ? '正在下载…' : '下载文件'}
      </button>
      {error && (
        <span className="error small" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
