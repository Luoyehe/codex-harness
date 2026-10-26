import type { Api } from './api';
import { object } from './types';

export type ArchivePreview = {
  generation: number;
  nextGeneration: number;
  digest: string;
  bytes: number;
  receipts: number;
  retirements: number;
  blocked: string[];
  exportId: string;
  lastRotation?: { generation: number; archivedDigest: string };
};
export type RotationIntent = Pick<
  ArchivePreview,
  'generation' | 'nextGeneration' | 'digest' | 'exportId'
>;
export const rotationKey = 'harness.receipt-rotation.v1';
export function checkedPreview(value: unknown): ArchivePreview {
  const data = object(value);
  if (
    !Number.isSafeInteger(data.generation) ||
    Number(data.generation) < 0 ||
    !Number.isSafeInteger(data.nextGeneration) ||
    Number(data.nextGeneration) <= Number(data.generation) ||
    Number(data.nextGeneration) > 0xffffffffffff ||
    !Number.isSafeInteger(data.bytes) ||
    Number(data.bytes) < 0 ||
    !Number.isSafeInteger(data.receipts) ||
    Number(data.receipts) < 0 ||
    !Number.isSafeInteger(data.retirements) ||
    Number(data.retirements) < 0 ||
    !/^[a-f0-9]{64}$/.test(String(data.digest)) ||
    typeof data.exportId !== 'string' ||
    !data.exportId ||
    data.exportId.length > 256 ||
    !Array.isArray(data.blocked) ||
    data.blocked.some((item) => typeof item !== 'string')
  )
    throw new Error('回执归档预览格式无效，未开始维护。');
  return data as ArchivePreview;
}
export function readRotation(): RotationIntent | undefined {
  const raw = sessionStorage.getItem(rotationKey);
  if (!raw) return;
  const value = object(JSON.parse(raw));
  if (
    !Number.isSafeInteger(value.generation) ||
    Number(value.generation) < 0 ||
    !Number.isSafeInteger(value.nextGeneration) ||
    Number(value.nextGeneration) <= Number(value.generation) ||
    Number(value.nextGeneration) > 0xffffffffffff ||
    typeof value.exportId !== 'string' ||
    !value.exportId ||
    value.exportId.length > 256 ||
    !/^[a-f0-9]{64}$/.test(String(value.digest))
  )
    throw new Error('维护恢复记录损坏。请保留浏览器记录并人工核对服务代际，不能再次提交轮换。');
  return value as RotationIntent;
}
export function rotationConfirmed(preview: ArchivePreview, intent: RotationIntent): boolean {
  return (
    preview.generation === intent.nextGeneration &&
    preview.lastRotation?.generation === intent.nextGeneration &&
    preview.lastRotation.archivedDigest === intent.digest
  );
}
export async function receiptArchive(
  api: Api,
  preview: ArchivePreview,
  signal: AbortSignal,
  progress: (loaded: number) => void,
): Promise<Blob> {
  if (preview.bytes > 128 * 1024 * 1024)
    throw new Error(
      '归档超过浏览器 128 MiB 校验上限。请使用受控离线维护完整导出；本次不会截断或轮换。',
    );
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  do {
    const chunk = await api.call(
      'operation/maintenance/chunk',
      { exportId: preview.exportId, digest: preview.digest, offset, limit: 524288 },
      signal,
    );
    if (
      chunk.digest !== preview.digest ||
      chunk.offset !== offset ||
      chunk.totalBytes !== preview.bytes ||
      typeof chunk.base64 !== 'string' ||
      chunk.base64.length > 699052
    )
      throw new Error('归档分片身份或容量不匹配，未允许轮换。');
    const binary = atob(chunk.base64),
      bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const next = offset + bytes.length;
    if (
      next > preview.bytes ||
      bytes.length > 524288 ||
      (next < preview.bytes && (!bytes.length || chunk.nextOffset !== next)) ||
      (next === preview.bytes && chunk.nextOffset !== null)
    )
      throw new Error('归档分片不连续或结束标记无效，未允许轮换。');
    chunks.push(bytes);
    offset = next;
    progress(offset);
  } while (offset < preview.bytes);
  if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
  const blob = new Blob(chunks, { type: 'application/json' });
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  const digest = Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (digest !== preview.digest) throw new Error('完整归档 SHA-256 不匹配，未允许轮换。');
  return blob;
}
