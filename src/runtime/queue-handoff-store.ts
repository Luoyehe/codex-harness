import { createHash } from 'node:crypto';
import { canonical, DeliveryError, jsonBytes, LIMITS, object, string, type JsonObject, type JsonValue } from './types.js';

export type QueueHandoff = {
  id: string; threadId: string; queuedSubmissionId: string; digest: string; payloadDigest?: string; metadataProvider?: string;
  attachmentIds: string[]; restoreSlots?: { ordinal: number; attachmentId: string }[]; candidateIds?: string[]; candidateThreadId?: string; nativeSavedImages?: number; state: 'saved' | 'ready' | 'restoring' | 'restored'; operationId?: string; movedFrom?: string; discarding?: true;
};
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const handoffLimit = 32;
export const handoffFile = (id: string) => 'queue-handoff-' + id + '.json';
export function handoffIdentity(id: unknown, kind: string): string {
  const value = string(id, kind, 256);
  if (/[\x00-\x1f\x7f]/u.test(value)) throw new DeliveryError('invalid_params', '排队副本的编号无效。');
  return value;
}
export function handoffKey(id: string): string {
  if (!uuid.test(id)) throw new DeliveryError('invalid_params', '排队恢复编号无效。');
  return id;
}
export function handoffContent(input: JsonValue[]) {
  if (!Array.isArray(input) || !input.length) throw new DeliveryError('invalid_params', '原排队输入为空。');
  // Validate depth, encoding, and aggregate size before canonicalization.
  jsonBytes(input, LIMITS.frameBytes);
  const bytes = Buffer.from(canonical(input));
  return { bytes, digest: createHash('sha256').update(bytes).digest('hex') };
}
export function handoffMetadata(value?: JsonValue): JsonObject | undefined {
  if (value == null) return;
  const metadata = object(value);
  if (!Object.keys(metadata).length) return;
  jsonBytes(metadata, 1024 * 1024);
  return metadata;
}
export function handoffReceipt(contentDigest: string, metadata?: JsonObject): string {
  return metadata ? createHash('sha256').update(canonical(['queue-handoff-metadata-v1', contentDigest, metadata])).digest('hex') : contentDigest;
}
export function loadHandoffs(raw: JsonValue | undefined): Map<string, QueueHandoff> {
  const fail = () => new DeliveryError('attachment_storage', '排队副本索引无效，请保留现有文件进行核对。');
  if (!Array.isArray(raw) || raw.length > handoffLimit) throw fail();
  const rows = new Map<string, QueueHandoff>(), identities = new Set<string>();
  for (const value of raw) {
    const row = object(value);
    if (typeof row.id !== 'string' || !uuid.test(row.id) || rows.has(row.id) ||
        typeof row.digest !== 'string' || !/^[a-f0-9]{64}$/.test(row.digest) ||
        (row.payloadDigest !== undefined && (typeof row.payloadDigest !== 'string' || !/^[a-f0-9]{64}$/.test(row.payloadDigest))) ||
        !['saved', 'ready', 'restoring', 'restored'].includes(String(row.state)) ||
        !Array.isArray(row.attachmentIds) || row.attachmentIds.length > LIMITS.attachments ||
        new Set(row.attachmentIds).size !== row.attachmentIds.length ||
        row.attachmentIds.some(id => typeof id !== 'string' || !uuid.test(id)) ||
        (row.metadataProvider !== undefined && (!row.payloadDigest || handoffIdentity(row.metadataProvider, 'metadataProvider') !== row.metadataProvider)) ||
        (row.restoreSlots !== undefined && (!Array.isArray(row.restoreSlots) || row.restoreSlots.length > LIMITS.attachments ||
          row.restoreSlots.some(value => { const slot = object(value); return !Number.isSafeInteger(slot.ordinal) || Number(slot.ordinal) < 0 || Number(slot.ordinal) >= 8192 || !(row.attachmentIds as JsonValue[]).includes(slot.attachmentId ?? null); }))) ||
        (row.nativeSavedImages !== undefined && (!Number.isSafeInteger(row.nativeSavedImages) || Number(row.nativeSavedImages) < 1 || Number(row.nativeSavedImages) > LIMITS.attachments)) ||
        (row.candidateThreadId !== undefined && (!Array.isArray(row.candidateIds) || handoffIdentity(row.candidateThreadId, 'candidateThreadId') !== row.candidateThreadId)) ||
        (row.candidateIds !== undefined && (!Array.isArray(row.candidateIds) || row.candidateIds.length > LIMITS.attachments || new Set(row.candidateIds).size !== row.candidateIds.length || row.candidateIds.some(id => typeof id !== 'string' || !uuid.test(id)))) ||
        (row.operationId !== undefined && (typeof row.operationId !== 'string' || !uuid.test(row.operationId))) ||
        (['restoring', 'restored'].includes(String(row.state)) && !row.operationId) ||
        (row.discarding !== undefined && (row.discarding !== true || row.state === 'restoring')) ||
        (row.movedFrom !== undefined && (handoffIdentity(row.movedFrom, 'sourceThreadId') === row.threadId || row.state === 'saved')) ||
        (row.state === 'saved' && row.operationId !== undefined)) throw fail();
    const key = JSON.stringify([handoffIdentity(row.threadId, 'threadId'), handoffIdentity(row.queuedSubmissionId, 'queuedSubmissionId'), row.digest]);
    if (identities.has(key)) throw fail();
    identities.add(key); rows.set(row.id, row as unknown as QueueHandoff);
  }
  return rows;
}
export const candidateSource = (row: QueueHandoff): string => row.candidateThreadId ?? row.movedFrom ?? row.threadId;
export function publicHandoff(row: QueueHandoff): JsonObject {
  return { id: row.id, queuedSubmissionId: row.queuedSubmissionId, state: row.state, attachmentCount: row.attachmentIds.length,
    ...(row.metadataProvider ? { requiresSameProvider: true } : {}),
    ...(row.nativeSavedImages ? { nativeSavedImages: row.nativeSavedImages, sourceCandidateCount: candidateSource(row) === row.threadId ? row.candidateIds?.length ?? 0 : 0 } : {}),
    ...(row.operationId ? { operationId: row.operationId } : {}) };
}

export function imageProofs(images?: JsonValue): Set<string> {
  const values = new Set<string>();
  if (images === undefined) return values;
  if (!Array.isArray(images) || images.length > 1280) throw new DeliveryError('attachment_storage', '内联图片核对结果超出上限。');
  for (const image of images) {
    const row = object(image);
    if (typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256) || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(String(row.mimeType)))
      throw new DeliveryError('attachment_storage', '内联图片核对结果格式有误。');
    values.add(row.mimeType + ':' + row.sha256);
  }
  return values;
}
