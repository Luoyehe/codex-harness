import { DeliveryError, type JsonObject, type JsonValue } from './types.js';

type Slot = { ordinal: number; attachmentId: string };
export type QueueImageSubmission = {
  operationId: string; threadId: string; method: 'add' | 'update'; clientUserMessageId?: string; queuedSubmissionId?: string; slots: Slot[];
};
export type QueueImageProof = { ordinal: number; mimeType: string; sha256: string; bytes: number };
type Receipt = { threadId: string; queuedSubmissionId: string; clientUserMessageId: string; images: QueueImageProof[] };
export type QueueImageBinding = QueueImageProof & { threadId: string; queuedSubmissionId: string; attachmentId: string };
export type QueueImageCandidate = { threadId: string; mimeType: string; sha256: string; attachmentIds: string[] };
const pendingLimit = 128, bindingLimit = 1024;
const supported = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && v.isWellFormed() && !/[\x00-\x1f]/.test(v);
const ordinal = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) < 8192;
const validProof = (v: QueueImageProof) => ordinal(v.ordinal) && supported.has(v.mimeType) && typeof v.sha256 === 'string' &&
  /^[0-9a-f]{64}$/.test(v.sha256) && Number.isSafeInteger(v.bytes) && v.bytes > 0 && v.bytes <= 4 * 1024 * 1024;
function invalid(): never { throw new DeliveryError('attachment_storage', '原生队列图片与原附件的对应记录无法核验。'); }
function capacity(): never { throw new DeliveryError('attachment_capacity', '队列图片的待核对空间已满，请先处理现有待办。'); }
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
function submission(v: QueueImageSubmission): boolean {
  return record(v) && id(v.operationId) && id(v.threadId) &&
    (v.method === 'add' ? id(v.clientUserMessageId) && v.queuedSubmissionId === undefined : v.method === 'update' && id(v.queuedSubmissionId)) &&
    (v.clientUserMessageId === undefined || id(v.clientUserMessageId)) && Array.isArray(v.slots) && v.slots.length <= 128 &&
    v.slots.every(s => record(s) && ordinal(s.ordinal) && id(s.attachmentId)) && new Set(v.slots.map(s => s.ordinal)).size === v.slots.length;
}

function copySubmission(row: QueueImageSubmission): QueueImageSubmission {
  return { operationId: row.operationId, method: row.method, threadId: row.threadId,
    ...(row.clientUserMessageId === undefined ? {} : { clientUserMessageId: row.clientUserMessageId }),
    ...(row.queuedSubmissionId === undefined ? {} : { queuedSubmissionId: row.queuedSubmissionId }),
    slots: row.slots.map(({ ordinal, attachmentId }) => ({ ordinal, attachmentId })) };
}

/** Immutable image identity evidence from a specific native queue mutation.
 * The attachment index atomically publishes json() with its owners and files. */
export class QueueImageBindings {
  private pending = new Map<string, QueueImageSubmission>();
  private confirmed: QueueImageBinding[] = [];
  private candidates: QueueImageCandidate[] = [];

  constructor(raw?: JsonValue) {
    if (raw === undefined) return;
    if (!record(raw) || raw.version !== 1 || !Array.isArray(raw.pending) || !Array.isArray(raw.confirmed) ||
        raw.pending.length > pendingLimit || raw.confirmed.length > bindingLimit) invalid();
    for (const value of raw.pending) {
      const row = value as unknown as QueueImageSubmission;
      if (!submission(row) || this.pending.has(row.operationId)) invalid();
      this.pending.set(row.operationId, copySubmission(row));
    }
    if (raw.candidates !== undefined) {
      if (!Array.isArray(raw.candidates) || raw.candidates.length > pendingLimit) invalid();
      for (const value of raw.candidates) {
        const row = value as unknown as QueueImageCandidate;
        if (!record(row) || !Array.isArray(row.attachmentIds) || !row.attachmentIds.length ||
            this.candidates.some(entry => entry.threadId === row.threadId && entry.mimeType === row.mimeType && entry.sha256 === row.sha256)) invalid();
        if (!this.observeCandidates(row.threadId, [row], row.attachmentIds)) invalid();
      }
    }
    const seen = new Set<string>();
    for (const value of raw.confirmed) {
      const row = value as unknown as QueueImageBinding;
      if (!record(row) || !validProof(row) || !id(row.threadId) || !id(row.queuedSubmissionId) || !id(row.attachmentId)) invalid();
      const key = JSON.stringify([row.threadId, row.queuedSubmissionId, row.ordinal]);
      if (seen.has(key)) invalid();
      seen.add(key); this.confirmed.push({ threadId: row.threadId, queuedSubmissionId: row.queuedSubmissionId, ordinal: row.ordinal,
        attachmentId: row.attachmentId, sha256: row.sha256, mimeType: row.mimeType, bytes: row.bytes });
    }
  }
  json(): JsonObject { return { version: 1, pending: structuredClone([...this.pending.values()]), confirmed: structuredClone(this.confirmed), candidates: structuredClone(this.candidates) }; }
  /** These ambiguous references only preserve existing files. lookup() never sees them. */
  observeCandidates(threadId: string, proofs: { mimeType: string; sha256: string }[], attachmentIds: string[]): boolean {
    if (!id(threadId) || !Array.isArray(proofs) || proofs.length > pendingLimit || !Array.isArray(attachmentIds) ||
        attachmentIds.length > 128 || !attachmentIds.every(id) ||
        !proofs.every(row => record(row) && supported.has(row.mimeType) && typeof row.sha256 === 'string' && /^[0-9a-f]{64}$/.test(row.sha256))) invalid();
    if (!attachmentIds.length) return true;
    const ids = [...new Set(attachmentIds)], keys = new Set(this.candidates.filter(row => row.threadId === threadId).map(row => row.mimeType + ':' + row.sha256));
    const added: QueueImageCandidate[] = [];
    for (const { mimeType, sha256 } of proofs) {
      const key = mimeType + ':' + sha256;
      if (!keys.has(key)) { keys.add(key); added.push({ threadId, mimeType, sha256, attachmentIds: [...ids] }); }
    }
    if (added.length + this.candidates.length > pendingLimit) return false;
    this.candidates.push(...added);
    return true;
  }
  candidateOrigins(): QueueImageCandidate[] { return structuredClone(this.candidates); }
  pruneCandidates(keep: (row: QueueImageCandidate) => boolean): void {
    this.candidates = this.candidates.filter(row => keep(structuredClone(row)));
  }
  begin(row: QueueImageSubmission): void {
    if (!submission(row) || this.pending.has(row.operationId)) invalid();
    if (this.hasPendingFor(row.threadId, row.queuedSubmissionId, row.clientUserMessageId))
      throw new DeliveryError('queue_image_pending', '同一待办的图片仍在核对中，请先核对原操作。');
    const reservations = [...this.pending.values(), row];
    const replaces = new Set(reservations.filter(entry => entry.method === 'update')
      .map(entry => JSON.stringify([entry.threadId, entry.queuedSubmissionId])));
    const retained = this.confirmed.filter(entry => !replaces.has(JSON.stringify([entry.threadId, entry.queuedSubmissionId]))).length;
    if (this.pending.size >= pendingLimit || retained + reservations.reduce((count, entry) => count + entry.slots.length, 0) > bindingLimit) capacity();
    this.pending.set(row.operationId, copySubmission(row));
  }
  confirm(operationId: string, receipt: Receipt): void {
    const pending = this.pending.get(operationId);
    if (!pending || !id(receipt.queuedSubmissionId) || !id(receipt.clientUserMessageId) ||
        pending.threadId !== receipt.threadId || pending.method === 'update' && pending.queuedSubmissionId !== receipt.queuedSubmissionId ||
        pending.clientUserMessageId !== undefined && pending.clientUserMessageId !== receipt.clientUserMessageId ||
        !Array.isArray(receipt.images) || receipt.images.length > 128 || !receipt.images.every(row => record(row) && validProof(row))) invalid();
    const proofs = new Map(receipt.images.map(row => [row.ordinal, row]));
    if (proofs.size !== receipt.images.length) invalid();
    const next = this.confirmed.filter(row => row.threadId !== receipt.threadId || row.queuedSubmissionId !== receipt.queuedSubmissionId);
    if (next.length + pending.slots.length > bindingLimit) capacity();
    for (const slot of pending.slots) {
      const proof = proofs.get(slot.ordinal);
      if (!proof) invalid();
      next.push({ ordinal: proof.ordinal, sha256: proof.sha256, mimeType: proof.mimeType, bytes: proof.bytes,
        threadId: receipt.threadId, queuedSubmissionId: receipt.queuedSubmissionId, attachmentId: slot.attachmentId });
    }
    this.confirmed = next; this.pending.delete(operationId);
  }
  notSent(operationId: string): void { this.pending.delete(operationId); }
  lookup(threadId: string, queuedSubmissionId: string, position: number, sha256: string, mimeType: string, bytes: number): string | undefined {
    return this.confirmed.find(row => row.threadId === threadId && row.queuedSubmissionId === queuedSubmissionId && row.ordinal === position &&
      row.sha256 === sha256 && row.mimeType === mimeType && row.bytes === bytes)?.attachmentId;
  }
  pendingAttachments(threadId?: string): string[] {
    return [...new Set([...this.pending.values()].filter(row => threadId === undefined || row.threadId === threadId)
      .flatMap(row => row.slots.map(slot => slot.attachmentId)))];
  }
  pendingThread(operationId: string): string | undefined { return this.pending.get(operationId)?.threadId; }
  pruneConfirmed(keep: (alias: QueueImageBinding) => boolean): void { this.confirmed = this.confirmed.filter(row => keep({ ...row })); }
  aliases(): QueueImageBinding[] { return structuredClone(this.confirmed); }
  hasPendingFor(threadId: string, queuedSubmissionId?: string, clientUserMessageId?: string): boolean {
    return [...this.pending.values()].some(row => row.threadId === threadId &&
      (queuedSubmissionId === undefined && clientUserMessageId === undefined ||
       queuedSubmissionId !== undefined && row.queuedSubmissionId === queuedSubmissionId ||
       clientUserMessageId !== undefined && row.clientUserMessageId === clientUserMessageId));
  }
  remove(threadId: string, queuedSubmissionId: string): void {
    this.confirmed = this.confirmed.filter(row => row.threadId !== threadId || row.queuedSubmissionId !== queuedSubmissionId);
    for (const [operation, row] of this.pending) if (row.threadId === threadId && row.queuedSubmissionId === queuedSubmissionId) this.pending.delete(operation);
  }
  releaseThread(threadId: string): void {
    this.candidates = this.candidates.filter(row => row.threadId !== threadId);
    this.confirmed = this.confirmed.filter(row => row.threadId !== threadId);
    for (const [operation, row] of this.pending) if (row.threadId === threadId) this.pending.delete(operation);
  }
}
