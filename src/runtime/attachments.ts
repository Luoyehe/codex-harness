import { candidateSource, handoffContent, handoffFile, handoffIdentity, handoffKey, handoffLimit, handoffMetadata, handoffReceipt, imageProofs, loadHandoffs, publicHandoff, type QueueHandoff } from './queue-handoff-store.js';
import { QueueImageBindings, type QueueImageProof } from './queue-image-bindings.js';
import { attachmentMediaType, visionReferenceGuidance } from '../core/attachment-media.js';
import { createHash, randomUUID } from 'node:crypto';
import { constants, mkdirSync, writeFileSync, renameSync, unlinkSync, lstatSync, openSync, closeSync, fsyncSync, fstatSync, fchmodSync, readSync, opendirSync, chmodSync, chownSync, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { contextSource } from './input-context.js';
import { DeliveryError, jsonBytes, LIMITS, object, onlyKeys, string, type JsonObject, type JsonValue } from './types.js';

interface Identity { dev: string; ino: string; birthtimeNs: string; mtimeNs: string }
interface Attachment { attachmentId: string; fileName?: string; name: string; mimeType: string; size: number; owner: string; created: number; threads: string[]; identity: Identity; sha256: string; state: 'live' | 'deleting'; referencesUnverified?: boolean; legacyCopyScan?: number; legacyQueueImage?: true; queueOrigin?: { threadId: string; queuedSubmissionId: string; ordinal: number } }
interface PinGroup { pending: Set<symbol>; retained: boolean }
interface CopyReservation { id: string; source: string; firstScan?: number }
export interface PreparedAttachments { input: JsonValue[]; pin: () => void; settle: (retain: boolean) => void }
const INDEX_LIMIT = 2 * 1024 * 1024;
const DIRECTORY_LIMIT = LIMITS.attachments + 32;
const MAX_AGE = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const audioFormats: Record<string, string> = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/vnd.wave': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'audio/webm': 'webm', 'audio/ogg': 'ogg' };
const audioMimes: Record<string, string> = { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', webm: 'audio/webm', ogg: 'audio/ogg' };
const mediaSuffixes: Record<string, string> = { ...audioFormats, 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov' };

const fault = (message: string): DeliveryError => new DeliveryError('attachment_storage', message);
const identity = (stat: BigIntStats): Identity => ({ dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs), mtimeNs: String(stat.mtimeNs) });
const sameFile = (a: Identity, b: Identity): boolean => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
const sameContents = (a: Identity, b: Identity): boolean => sameFile(a, b) && a.mtimeNs === b.mtimeNs;
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** The index is supervisor-private; only immutable data files are readable by the native UID. */
export class Attachments {
  private entries = new Map<string, Attachment>();
  private pins = new Map<Attachment, Map<string, PinGroup>>();
  private scanGeneration = 0;
  private unresolvedSince = new Map<string, number>();
  private handoffs = new Map<string, QueueHandoff>();
  private imageBindings = new QueueImageBindings();
  private handoffNeedsSync = false;
  private copies = new Map<string, CopyReservation>();
  private readonly dir: string;
  private readonly dirIdentity: Identity;
  constructor(home: string, private readonly group?: number) {
    this.dir = path.join(home, 'attachments'); mkdirSync(this.dir, { recursive: true, mode: group === undefined ? 0o700 : 0o2750 });
    const stat = lstatSync(this.dir, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== BigInt(process.getuid()))) throw fault('Unsafe attachment directory');
    this.dirIdentity = identity(stat);
    if (group !== undefined) chownSync(this.dir, Number(stat.uid), group);
    chmodSync(this.dir, group === undefined ? 0o700 : 0o2750);
    let source: Buffer | undefined;
    try { source = this.readFile('index.json', INDEX_LIMIT).bytes; } catch (error) { if (!absent(error)) throw error; }
    if (source) {
      const index = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source)));
      if (![2, 3, 4, 5, 6].includes(Number(index.version)) || !Array.isArray(index.entries) || index.entries.length > LIMITS.attachments) throw fault('Invalid attachment index');
      if (index.ownershipScan !== undefined) {
        const scan = object(index.ownershipScan);
        if (!Number.isSafeInteger(scan.generation) || Number(scan.generation) < 0 || !Array.isArray(scan.unresolvedSince) || scan.unresolvedSince.length > 10000)
          throw fault('Invalid attachment ownership inventory');
        this.scanGeneration = Number(scan.generation);
        for (const row of scan.unresolvedSince) {
          if (!Array.isArray(row) || row.length !== 2 || !Number.isSafeInteger(row[1]) || Number(row[1]) < 1 || Number(row[1]) > this.scanGeneration)
            throw fault('Invalid unresolved attachment ownership source');
          const id = string(row[0], 'unresolved thread', 256);
          if (this.unresolvedSince.has(id)) throw fault('Duplicate unresolved attachment source');
          this.unresolvedSince.set(id, Number(row[1]));
        }
      }
      if (index.version === 6) this.imageBindings = new QueueImageBindings(index.queueImageBindings);
      if (Number(index.version) >= 5) this.handoffs = loadHandoffs(index.queueHandoffs);
      if (index.version !== 2) {
        if (!Array.isArray(index.copies) || index.copies.length > 128) throw fault('Invalid attachment copy index');
        for (const value of index.copies) { const copy = object(value); if (typeof copy.id !== 'string' || !UUID.test(copy.id) || this.copies.has(copy.id) || typeof copy.source !== 'string' || copy.source.length > 256) throw fault('Invalid attachment copy reservation'); if (copy.firstScan !== undefined && (!Number.isSafeInteger(copy.firstScan) || Number(copy.firstScan) < 1 || Number(copy.firstScan) > this.scanGeneration)) throw fault('Invalid attachment copy inventory');
          this.copies.set(copy.id, { id: copy.id, source: copy.source, ...(typeof copy.firstScan === 'number' ? { firstScan: copy.firstScan } : {}) }); }
      }
      const migrateImages = Number(index.version) < 6 || !Array.isArray(object(index.queueImageBindings).candidates);
      for (const value of index.entries) {
        const item = object(value); const id = string(item.attachmentId, 'attachmentId'); const stored = object(item.identity);
        if (!UUID.test(id) || this.entries.has(id) || typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > LIMITS.attachmentBytes || !Array.isArray(item.threads) || item.threads.length > 256 || !item.threads.every(thread => typeof thread === 'string' && thread.length <= 4096) || typeof item.owner !== 'string' || typeof item.created !== 'number' || !Number.isFinite(item.created) || (item.state !== 'live' && item.state !== 'deleting') || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) || !['dev', 'ino', 'birthtimeNs', 'mtimeNs'].every(key => typeof stored[key] === 'string' && /^\d{1,30}$/.test(stored[key] as string))) throw fault('Invalid attachment metadata');
        string(item.name, 'name', 256); string(item.mimeType, 'mimeType', 128); string(item.owner, 'owner', 256);
        if (item.fileName !== undefined && (!mediaSuffixes[String(item.mimeType).split(';')[0]!.toLowerCase()] || item.fileName !== `${id}.${mediaSuffixes[String(item.mimeType).split(';')[0]!.toLowerCase()]}`)) throw fault('Invalid attachment data filename');
        if (item.referencesUnverified !== undefined && typeof item.referencesUnverified !== 'boolean') throw fault('Invalid attachment reconciliation state');
        if (item.legacyCopyScan !== undefined && (!Number.isSafeInteger(item.legacyCopyScan) || Number(item.legacyCopyScan) < 0 || Number(item.legacyCopyScan) > this.scanGeneration)) throw fault('Invalid legacy attachment ownership generation');
        if (item.queueOrigin !== undefined) {
          const origin = object(item.queueOrigin);
          handoffIdentity(origin.threadId, 'threadId'); handoffIdentity(origin.queuedSubmissionId, 'queuedSubmissionId');
          if (!Number.isSafeInteger(origin.ordinal) || Number(origin.ordinal) < 0 || Number(origin.ordinal) >= 8192) throw fault('Invalid native queue image origin');
        }
        const entry = value as unknown as Attachment; this.entries.set(id, entry);
        if (entry.state === 'live') {
          const bytes = this.readEntry(entry);
          if (!entry.fileName) entry.mimeType = attachmentMediaType(bytes, entry.mimeType);
          if (migrateImages && entry.mimeType.startsWith('image/') && entry.threads.length) entry.legacyQueueImage = true;
          // v2 had no copy reservations. v3 records named owners and individual
          // copy tokens; its old blanket unverified flag is ambiguous only when
          // the last owner has already gone. New uploads never inherit this guard.
          if ((index.version === 2 && (entry.threads.length > 0 || entry.referencesUnverified)) ||
              ((index.version === 3 || index.legacyOwners === true) && !entry.threads.length && entry.referencesUnverified)) entry.legacyCopyScan = 0;
          if (entry.legacyQueueImage !== undefined && entry.legacyQueueImage !== true) throw fault('Invalid native queue migration state');
        }
      }
    }
    for (const row of [...this.handoffs.values()]) {
      if (row.discarding) { this.discardQueueHandoff(row.threadId, row.id); continue; }
      if (row.candidateIds?.some(id => this.entries.get(id)?.state !== 'live')) throw fault('排队副本待核对的原始图片无法验证。');
      if (row.state === 'restored') { this.removeHandoffFile(row); continue; }
      if (row.attachmentIds.some(id => this.entries.get(id)?.state !== 'live')) throw fault('排队副本引用的附件无效。');
      this.readHandoff(row);
    }
    this.gc();
  }
  private checkDirectory(): void {
    const stat = lstatSync(this.dir, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameFile(this.dirIdentity, identity(stat))) throw fault('Attachment directory was replaced');
  }
  private file(name: string): string { this.checkDirectory(); return path.join(this.dir, name); }
  /** Never read through a path after checking it. Nonblocking open also rejects FIFO substitution without hanging. */
  private readFile(name: string, max: number, expected?: Attachment): { bytes: Buffer; stat: BigIntStats } {
    const file = this.file(name); const before = lstatSync(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(max)) throw fault('Unsafe attachment file');
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = fstatSync(fd, { bigint: true }); const opened = identity(stat);
      if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(max) || !sameContents(identity(before), opened) || (expected && (stat.size !== BigInt(expected.size) || !sameContents(expected.identity, opened)))) throw fault('Attachment file changed');
      const bytes = Buffer.alloc(Number(stat.size)); let offset = 0;
      while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) throw fault('Attachment became shorter during read'); offset += count; }
      const extra = Buffer.alloc(1); if (readSync(fd, extra, 0, 1, offset) !== 0) throw fault('Attachment grew during read');
      const after = fstatSync(fd, { bigint: true }); const current = lstatSync(file, { bigint: true });
      if (after.size !== stat.size || after.nlink !== 1n || after.ctimeNs !== stat.ctimeNs || !sameContents(opened, identity(after)) || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || !sameContents(opened, identity(current))) throw fault('Attachment changed during read');
      this.checkDirectory();
      if (expected && createHash('sha256').update(bytes).digest('hex') !== expected.sha256) throw fault('Attachment content changed');
      return { bytes, stat };
    } finally { closeSync(fd); }
  }
  private dataName(item: Attachment): string { return item.fileName ?? item.attachmentId; }
  private readEntry(item: Attachment): Buffer { return this.readFile(this.dataName(item), LIMITS.attachmentBytes, item).bytes; }
  /** opendir caps both allocation and work; every physical data/orphan file counts toward quota. */
  private scan(): Map<string, BigIntStats> {
    this.checkDirectory(); const directory = opendirSync(this.dir, { bufferSize: 16 }); const files = new Map<string, BigIntStats>(); let count = 0;
    try {
      for (;;) {
        const entry = directory.readSync(); if (!entry) break;
        if (++count > DIRECTORY_LIMIT) throw new DeliveryError('capacity', 'Attachment directory entry budget exhausted');
        const stat = lstatSync(this.file(entry.name), { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw fault('Unsafe entry in attachment directory');
        if (entry.name === 'index.json') { if (stat.size > BigInt(INDEX_LIMIT)) throw fault('Attachment index exceeds budget'); continue; }
        files.set(entry.name, stat);
      }
    } finally { directory.closeSync(); }
    this.checkDirectory(); return files;
  }
  private usage(files = this.scan()): { bytes: number; count: number } {
    let bytes = 0; let count = 0; const names = new Map([...this.entries.values()].map(entry => [this.dataName(entry), entry]));
    for (const [name, stat] of files) { bytes += Number(stat.size); count++; if (names.has(name)) bytes += Math.max(0, names.get(name)!.size - Number(stat.size)); }
    for (const entry of this.entries.values()) if (!files.has(this.dataName(entry))) { bytes += entry.size; count++; }
    if (!Number.isSafeInteger(bytes) || bytes > LIMITS.attachmentTotal || count > LIMITS.attachments) throw new DeliveryError('capacity', 'Attachment physical storage budget exhausted');
    return { bytes, count };
  }
  private save(handoffs = this.handoffs, imageBindings = this.imageBindings): void {
    const target = this.file('index.json'); const temp = this.file(`index-${randomUUID()}.tmp`);
    try {
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600);
      try { writeFileSync(fd, jsonBytes({ version: 6, queueImageBindings: imageBindings.json(), queueHandoffs: [...handoffs.values()], ownershipScan: { generation: this.scanGeneration, unresolvedSince: [...this.unresolvedSince] }, entries: [...this.entries.values()], copies: [...this.copies.values()] }, INDEX_LIMIT)); fsyncSync(fd); } finally { closeSync(fd); }
      this.checkDirectory(); renameSync(temp, target); this.syncDirectory();
    } finally { try { unlinkSync(temp); } catch {} }
  }
  private handoffProtects(entry: Attachment, threadId?: string): boolean {
    return this.imageBindings.pendingAttachments(threadId).includes(entry.attachmentId) || [...this.handoffs.values()].some(row =>
      !row.discarding && (row.state !== 'restored' && (threadId === undefined || row.threadId === threadId) && row.attachmentIds.includes(entry.attachmentId) ||
        (threadId === undefined || candidateSource(row) === threadId) && row.candidateIds?.includes(entry.attachmentId)));
  }
  private referenceCount(entry: Attachment, threads: string[], additional?: string): number {
    const owners = new Set(threads);
    if (additional) owners.add(additional);
    for (const row of this.handoffs.values()) {
      if (row.state === 'restoring' && row.attachmentIds.includes(entry.attachmentId)) owners.add(row.threadId);
    }
    return owners.size;
  }
  private ownsReference(entry: Attachment, threadId: string): boolean {
    return entry.threads.includes(threadId) || this.handoffProtects(entry, threadId);
  }
  private readHandoffPayload(row: QueueHandoff): JsonValue {
    const source = this.readFile(handoffFile(row.id), LIMITS.attachmentBytes);
    if ((process.getuid && (source.stat.uid !== BigInt(process.getuid()) || (source.stat.mode & 0o077n) !== 0n)) ||
        createHash('sha256').update(source.bytes).digest('hex') !== (row.payloadDigest ?? row.digest))
      throw fault('排队副本的权限或摘要已变化。');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes)) as JsonValue;
  }
  private readHandoff(row: QueueHandoff): JsonValue[] {
    const payload = this.readHandoffPayload(row);
    if (Array.isArray(payload) && payload.length && !row.payloadDigest) return payload;
    const stored = object(payload);
    if (stored.version !== (row.metadataProvider ? 2 : 1) || !Array.isArray(stored.input) || !Array.isArray(stored.inline)) throw fault('排队副本缺少原始输入。');
    for (const position of stored.inline) {
      const item = object(position);
      if (typeof item.index !== 'number' || !Number.isSafeInteger(item.index) || typeof item.attachmentId !== 'string' ||
          !row.attachmentIds.includes(item.attachmentId)) throw fault('排队图片与原操作不符。');
      const entry = this.entries.get(item.attachmentId), image = object(stored.input[item.index]);
      if (!entry || entry.state !== 'live' || image.type !== 'image' || image.url !== null) throw fault('排队图片与原操作不符。');
      image.url = 'data:' + entry.mimeType + ';base64,' + this.readEntry(entry).toString('base64');
    }
    const metadata = handoffMetadata(stored.metadata);
    if (!!metadata !== !!row.metadataProvider || (row.metadataProvider && stored.provider !== row.metadataProvider)) throw fault('排队副本的供应商元数据不符。');
    if (handoffReceipt(handoffContent(stored.input).digest, metadata) !== row.digest) throw fault('恢复的排队输入与原始摘要不符。');
    return stored.input;
  }
  private queuedImage(item: JsonObject): { mimeType: string; sha256: string; bytes: number; data?: Buffer } | undefined {
    const supported = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
    if (item.type === 'harnessInlineImageDigest' && typeof item.mimeType === 'string' && supported.includes(item.mimeType) &&
        typeof item.bytes === 'number' && Number.isSafeInteger(item.bytes) && item.bytes > 0 && item.bytes <= LIMITS.attachmentBytes &&
        typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256)) return { mimeType: item.mimeType, sha256: item.sha256, bytes: item.bytes };
    if (item.type !== 'image' || typeof item.url !== 'string' || !item.url.startsWith('data:')) return;
    const comma = item.url.indexOf(','), mimeType = item.url.slice(5, comma - 7);
    if (!supported.includes(mimeType) || item.url.slice(0, comma) !== 'data:' + mimeType + ';base64') return;
    const encoded = item.url.slice(comma + 1);
    if (!encoded.length || encoded.length > Math.ceil(LIMITS.attachmentBytes / 3) * 4) return;
    const data = Buffer.from(encoded, 'base64');
    if (data.length > LIMITS.attachmentBytes || data.toString('base64') !== encoded || attachmentMediaType(data, '') !== mimeType) return;
    return { mimeType, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length, data };
  }
  private exactQueuedImages(threadId: string, proof: { mimeType: string; bytes: number; sha256: string }): Attachment[] {
    return [...this.entries.values()].filter(row => row.state === 'live' && this.ownsReference(row, threadId) &&
      row.mimeType === proof.mimeType && row.size === proof.bytes && row.sha256 === proof.sha256);
  }
  resolveQueuedImageDigest(threadId: string, item: JsonObject): string | undefined {
    const proof = this.queuedImage(item);
    if (!proof) return;
    const matches = this.exactQueuedImages(threadId, proof);
    if (matches.length === 1) { this.readEntry(matches[0]!); return matches[0]!.attachmentId; }
  }
  resolveQueuedNativeImage(threadId: string, item: JsonObject): string | undefined {
    return this.resolveQueuedImageDigest(threadId, item);
  }
  resolveOriginalQueuedImage(threadId: string, queuedId: string, ordinal: number, item: JsonObject): string | undefined {
    const proof = this.queuedImage(item);
    if (!proof) return;
    const binding = this.imageBindings.lookup(threadId, queuedId, ordinal, proof.sha256, proof.mimeType, proof.bytes);
    if (binding) {
      const original = this.entries.get(binding);
      if (!original || original.state !== 'live' || !this.ownsReference(original, threadId)) throw fault('此排队槽位的原附件不可用。');
      this.readEntry(original); return binding;
    }
    const matches = this.exactQueuedImages(threadId, proof);
    const saved = matches.find(entry => entry.queueOrigin?.threadId === threadId && entry.queueOrigin.queuedSubmissionId === queuedId && entry.queueOrigin.ordinal === ordinal);
    const source = saved ?? (matches.length === 1 && !matches[0]!.queueOrigin ? matches[0] : undefined);
    if (source) { this.readEntry(source); return source.attachmentId; }
  }
  private nativeQueueCopy(threadId: string, queuedId: string, ordinal: number, item: JsonObject): Attachment {
    handoffIdentity(threadId, 'threadId'); handoffIdentity(queuedId, 'queuedSubmissionId');
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= 8192) throw fault('排队图片槽位无效。');
    const proof = this.queuedImage(item);
    if (!proof?.data) throw new DeliveryError('queue_image_unverified', '此排队图片缺少可验证的原生保存字节。');
    const existing = this.exactQueuedImages(threadId, proof).find(entry => entry.queueOrigin?.threadId === threadId &&
      entry.queueOrigin.queuedSubmissionId === queuedId && entry.queueOrigin.ordinal === ordinal);
    if (existing) { this.readEntry(existing); return existing; }
    const origin = { threadId, queuedSubmissionId: queuedId, ordinal };
    const upload = object(this.upload({ name: '原生队列保存版-' + (ordinal + 1) + '.' + mediaSuffixes[proof.mimeType],
      mimeType: proof.mimeType, base64: proof.data.toString('base64') }, 'native-queue', origin));
    return this.get(upload.attachmentId);
  }
  /** Only an explicit save/edit after a native reread can create this scoped derivative. */
  materializeNativeQueuedImage(threadId: string, queuedId: string, ordinal: number, item: JsonObject): string {
    return this.resolveOriginalQueuedImage(threadId, queuedId, ordinal, item) ?? this.nativeQueueCopy(threadId, queuedId, ordinal, item).attachmentId;
  }
  beginQueueImageWrite(threadId: string, method: 'thread/queue/add' | 'thread/queue/update', params: JsonObject, operationId?: string): string | undefined {
    this.confirmHandoffPublication();
    if (!Array.isArray(params.input)) return;
    const slots: { ordinal: number; attachmentId: string }[] = [];
    for (const [ordinal, raw] of params.input.entries()) {
      const item = object(raw);
      if (item.type !== 'localImage' || typeof item.path !== 'string') continue;
      const entry = [...this.entries.values()].find(candidate => candidate.state === 'live' && this.ownsReference(candidate, threadId) &&
        candidate.mimeType.startsWith('image/') && this.file(this.dataName(candidate)) === item.path);
      if (entry) { this.readEntry(entry); slots.push({ ordinal, attachmentId: entry.attachmentId }); }
    }
    if (!slots.length && !(method === 'thread/queue/update' && this.imageBindings.aliases().some(row => row.threadId === threadId && row.queuedSubmissionId === params.queuedSubmissionId))) return;
    const id = operationId ?? randomUUID();
    const next = new QueueImageBindings(this.imageBindings.json());
    next.begin({ operationId: id, threadId, method: method === 'thread/queue/add' ? 'add' : 'update', slots,
      ...(typeof params.clientUserMessageId === 'string' ? { clientUserMessageId: params.clientUserMessageId } : {}),
      ...(method === 'thread/queue/update' ? { queuedSubmissionId: string(params.queuedSubmissionId, 'queuedSubmissionId', 256) } : {}) });
    this.publishHandoffs(this.handoffs, next); return id;
  }
  confirmQueueImageWrite(threadId: string, token: string | undefined, submission: JsonObject): void {
    if (!token) return;
    this.confirmHandoffPublication();
    if (!Array.isArray(submission.input)) throw fault('缺少原生排队图片回执。');
    const images: QueueImageProof[] = [];
    for (const [ordinal, value] of submission.input.entries()) {
      const proof = this.queuedImage(object(value));
      if (proof) images.push({ ordinal, sha256: proof.sha256, bytes: proof.bytes, mimeType: proof.mimeType });
    }
    const next = new QueueImageBindings(this.imageBindings.json());
    next.confirm(token, { threadId, queuedSubmissionId: string(submission.id, 'queuedSubmissionId', 256),
      clientUserMessageId: string(submission.clientUserMessageId, 'clientUserMessageId', 256), images });
    this.publishHandoffs(this.handoffs, next);
  }
  cancelQueueImageWrite(threadId: string, token: string | undefined): void {
    if (!token || this.imageBindings.pendingThread(token) !== threadId) return;
    const next = new QueueImageBindings(this.imageBindings.json()); next.notSent(token); this.publishHandoffs(this.handoffs, next);
  }
  retireQueueImageBindings(threadId: string, queuedId: string): void {
    if (!this.imageBindings.aliases().some(row => row.threadId === threadId && row.queuedSubmissionId === queuedId) && !this.imageBindings.hasPendingFor(threadId, queuedId)) return;
    const next = new QueueImageBindings(this.imageBindings.json()); next.remove(threadId, queuedId); this.publishHandoffs(this.handoffs, next);
  }
  private confirmHandoffPublication(): void {
    if (this.handoffNeedsSync) { this.syncDirectory(); this.handoffNeedsSync = false; }
  }
  private publishHandoffs(next: Map<string, QueueHandoff>, bindings = this.imageBindings): void {
    try { this.save(next, bindings); }
    catch (error) {
      // rename can have completed even when directory fsync failed. Follow the published
      // identity in this process and require the caller to reconcile before another write.
      try {
        const disk = object(JSON.parse(this.readFile('index.json', INDEX_LIMIT).bytes.toString()));
        if (Number(disk.version) >= 5) {
          this.handoffs = loadHandoffs(disk.queueHandoffs); this.imageBindings = new QueueImageBindings(disk.queueImageBindings); this.handoffNeedsSync = true;
        }
      } catch (readError) { if (!absent(readError)) throw readError; }
      throw error;
    }
    this.handoffs = next; this.imageBindings = bindings; this.handoffNeedsSync = false;
  }
  private replaceHandoff(row: QueueHandoff): void {
    const next = new Map(this.handoffs); next.set(row.id, row); this.publishHandoffs(next);
  }
  private handoff(threadId: string, id: string): QueueHandoff {
    this.confirmHandoffPublication();
    handoffIdentity(threadId, 'threadId'); handoffKey(id);
    const row = this.handoffs.get(id);
    if (!row || row.threadId !== threadId) throw new DeliveryError('not_found', '此会话没有这份排队副本。');
    return row;
  }
  private handoffAttachments(threadId: string, input: JsonValue[]): string[] {
    // Opaque native references and structured extra context may include managed paths in
    // nested text fields. Pin such paths too, without re-creating or exposing their text.
    const found = new Set<string>(), prefixes = new Set([this.dir + path.sep, JSON.stringify(this.dir + path.sep).slice(1, -1)]);
    const visit = (value: JsonValue): void => {
      if (typeof value === 'string') {
        for (const prefix of prefixes) {
          let at = value.indexOf(prefix);
          while (at >= 0) {
            const start = at + prefix.length, name = value.slice(start, start + 36);
            if (UUID.test(name)) {
              const entry = this.entries.get(name);
              if (!entry || entry.state !== 'live' || !this.ownsReference(entry, threadId))
                throw new DeliveryError('attachment_unavailable', '原排队输入包含未绑定到此会话的附件。');
              found.add(name);
            }
            at = value.indexOf(prefix, start);
          }
        }
      } else if (value !== null && typeof value === 'object') {
        for (const part of Object.values(value)) visit(part);
      }
    };
    visit(input);
    for (const id of found) this.readEntry(this.entries.get(id)!);
    return [...found];
  }
  saveQueueHandoff(threadId: string, queuedSubmissionId: string, input: JsonValue[], metadataValue?: JsonValue, provider?: string): JsonObject {
    this.confirmHandoffPublication();
    handoffIdentity(threadId, 'threadId'); handoffIdentity(queuedSubmissionId, 'queuedSubmissionId');
    const original = handoffContent(input), metadata = handoffMetadata(metadataValue), digest = handoffReceipt(original.digest, metadata);
    if (metadata) handoffIdentity(provider, 'native metadata provider');
    const prior = [...this.handoffs.values()].find(row => row.threadId === threadId && row.queuedSubmissionId === queuedSubmissionId && row.digest === digest);
    if (prior) {
      if (metadata && prior.metadataProvider !== provider) throw new DeliveryError('handoff_provider_mismatch', '原生客户端元数据绑定另一供应商，请在原供应商中核对。');
      if (prior.discarding) throw new DeliveryError('handoff_unconfirmed', '正在清理这份副本，请先完成清理。');
      if (prior.state !== 'restored') this.readHandoff(prior);
      return publicHandoff(prior);
    }
    if (this.handoffs.size >= handoffLimit) throw new DeliveryError('capacity', '排队副本容量已满，请先核对并清理旧副本。');
    const ids = new Set(this.handoffAttachments(threadId, input));
    const inline: JsonObject[] = [], restoreSlots: { ordinal: number; attachmentId: string }[] = [];
    let nativeSavedImages = 0;
    const compact = input.map((value, ordinal) => {
      const item = object(value);
      if (item.type === 'localImage') {
        if ([...ids].some(id => { const entry = this.entries.get(id)!; return !!entry.queueOrigin && this.file(this.dataName(entry)) === item.path; })) nativeSavedImages++;
        return value;
      }
      const proof = this.queuedImage(item);
      if (!proof?.data) return value;
      const restoredId = this.materializeNativeQueuedImage(threadId, queuedSubmissionId, ordinal, item);
      const restored = this.get(restoredId);
      if (restored.queueOrigin) nativeSavedImages++;
      // Native may transcode. The derivative reconstructs the exact original queue
      // input, while the acknowledged upload remains the source for future dispatch.
      const encoded = restored.sha256 === proof.sha256 && restored.mimeType === proof.mimeType && restored.size === proof.bytes
        ? restored : this.nativeQueueCopy(threadId, queuedSubmissionId, ordinal, item);
      ids.add(encoded.attachmentId); ids.add(restoredId);
      inline.push({ index: ordinal, attachmentId: encoded.attachmentId });
      restoreSlots.push({ ordinal, attachmentId: restoredId });
      return { ...item, url: null };
    });
    const candidateIds = nativeSavedImages ? [...this.entries.values()].filter(entry => entry.state === 'live' && !entry.queueOrigin &&
      entry.mimeType.startsWith('image/') && entry.threads.includes(threadId) && !ids.has(entry.attachmentId)).map(entry => entry.attachmentId) : [];
    // Keep a full-size managed image once; reconstruct the original data URL with
    // its exact bytes and verify the canonical digest before allowing native dispatch.
    const bytes = metadata || inline.length ? Buffer.from(jsonBytes({ version: metadata ? 2 : 1, input: compact, inline,
      ...(metadata ? { provider: provider!, metadata } : {}) }, LIMITS.attachmentBytes)) : original.bytes;
    if (bytes.length > LIMITS.attachmentBytes) throw new DeliveryError('capacity', '单个排队副本超出保存上限，原队列保留。');
    const usage = this.usage();
    if (this.handoffs.size >= handoffLimit || usage.count + 1 > LIMITS.attachments || usage.bytes + bytes.length > LIMITS.attachmentTotal)
      throw new DeliveryError('capacity', '排队副本容量已满，请先核对并清理旧副本，原队列保留。');
    const row: QueueHandoff = { id: randomUUID(), threadId, queuedSubmissionId, digest, state: 'saved', attachmentIds: [...ids],
      ...(restoreSlots.length ? { restoreSlots } : {}), ...(nativeSavedImages ? { nativeSavedImages, candidateIds, candidateThreadId: threadId } : {}),
      ...(metadata ? { metadataProvider: provider! } : {}),
      ...(inline.length || metadata ? { payloadDigest: createHash('sha256').update(bytes).digest('hex') } : {}) };
    const name = this.file(handoffFile(row.id)), fd = openSync(name, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    this.syncDirectory();
    this.replaceHandoff(row);
    return publicHandoff(row);
  }
  listQueueHandoffs(threadId: string): JsonObject[] {
    this.confirmHandoffPublication();
    handoffIdentity(threadId, 'threadId');
    return [...this.handoffs.values()].filter(row => row.threadId === threadId).map(publicHandoff);
  }
  movedQueueHandoffSources(threadId: string): JsonObject[] {
    this.confirmHandoffPublication(); handoffIdentity(threadId, 'threadId');
    return [...this.handoffs.values()].filter(row => !row.discarding && row.candidateIds?.length &&
      row.threadId !== threadId && candidateSource(row) === threadId)
      .map(row => ({ id: row.id, queuedSubmissionId: row.queuedSubmissionId, count: row.candidateIds!.length }));
  }
  queueHandoffCandidates(threadId: string, id: string, attachmentId?: string): JsonValue {
    this.confirmHandoffPublication(); handoffIdentity(threadId, 'threadId'); handoffKey(id);
    const row = this.handoffs.get(id);
    if (!row || row.discarding || !row.candidateIds?.length || candidateSource(row) !== threadId)
      throw new DeliveryError('not_found', '当前源会话中没有这组原上传候选。');
    if (attachmentId !== undefined) {
      if (!row.candidateIds.includes(attachmentId)) throw new DeliveryError('not_found', '所选文件不属于这份副本的候选原件。');
      return this.read({ threadId, attachmentId });
    }
    return { data: row.candidateIds.map(key => this.public(this.get(key, threadId))) };
  }
  queueHandoffInput(threadId: string, id: string): JsonValue[] {
    const row = this.handoff(threadId, id);
    if (row.discarding || row.state !== 'ready') throw new DeliveryError('handoff_unconfirmed', '尚无可恢复的原排队删除证明，或恢复已经提交。');
    for (const key of row.attachmentIds) this.readEntry(this.entries.get(key)!);
    return this.readHandoff(row);
  }
  queueHandoffRestoreInput(threadId: string, id: string): JsonValue[] {
    const row = this.handoff(threadId, id), input = this.queueHandoffInput(threadId, id);
    for (const { ordinal, attachmentId } of row.restoreSlots ?? []) {
      const item = object(input[ordinal]), entry = this.get(attachmentId);
      if (item.type !== 'image' || !row.attachmentIds.includes(attachmentId)) throw fault('排队图片与恢复槽位不符。');
      input[ordinal] = { ...this.nativeInput(entry, true), ...(item.detail !== undefined ? { detail: item.detail } : {}) };
    }
    return input;
  }
  queueHandoffMetadata(threadId: string, id: string, provider: string): JsonObject | undefined {
    const row = this.handoff(threadId, id);
    if (row.state !== 'ready' || row.discarding) throw new DeliveryError('handoff_unconfirmed', '这份排队副本尚未确认可恢复。');
    if (!row.metadataProvider) return;
    if (provider !== row.metadataProvider) throw new DeliveryError('handoff_provider_mismatch', '这份待办包含原提供方的私有客户端元数据，只能恢复到原供应商。');
    const stored = object(this.readHandoffPayload(row));
    const metadata = handoffMetadata(stored.metadata);
    if (stored.provider !== provider || !metadata) throw fault('排队副本的供应商元数据不符。');
    return metadata;
  }
  queueHandoffMatches(threadId: string, queuedSubmissionId: string, input: JsonValue[], metadata?: JsonValue): boolean {
    this.confirmHandoffPublication();
    const saved = [...this.handoffs.values()].filter(row => !row.discarding && row.threadId === threadId && row.queuedSubmissionId === queuedSubmissionId && row.state === 'saved');
    if (!saved.length) return false;
    const digest = handoffReceipt(handoffContent(input).digest, handoffMetadata(metadata));
    return saved.some(row => row.digest === digest);
  }
  markQueueHandoffRemoved(threadId: string, queuedSubmissionId: string, originalInput: JsonValue[], metadata?: JsonValue): void {
    this.confirmHandoffPublication();
    const saved = [...this.handoffs.values()].filter(row => !row.discarding && row.state === 'saved' && row.threadId === threadId && row.queuedSubmissionId === queuedSubmissionId);
    if (!saved.length) return;
    const digest = handoffReceipt(handoffContent(originalInput).digest, handoffMetadata(metadata)), row = saved.find(item => item.digest === digest);
    if (row) this.replaceHandoff({ ...row, state: 'ready' });
  }
  beginQueueHandoffRestore(threadId: string, id: string, operationId: string): void {
    handoffKey(operationId);
    const row = this.handoff(threadId, id);
    if (row.state !== 'ready' || row.operationId === operationId)
      throw new DeliveryError('handoff_unconfirmed', '这份副本的恢复已登记，或原排队操作尚未确认移除；请核对原回执。');
    this.queueHandoffInput(threadId, id);
    for (const key of row.attachmentIds) {
      const entry = this.entries.get(key)!;
      if (this.referenceCount(entry, entry.threads, threadId) > 256)
        throw new DeliveryError('capacity', '附件会话引用已满，原副本保留，尚未提交恢复。');
    }
    this.replaceHandoff({ ...row, state: 'restoring', operationId });
  }
  settleQueueHandoffRestore(threadId: string, id: string, operationId: string, outcome: 'accepted' | 'not_sent'): void {
    handoffKey(operationId);
    const row = this.handoff(threadId, id);
    const state = outcome === 'accepted' ? 'restored' : 'ready';
    if (!['accepted', 'not_sent'].includes(outcome) || row.operationId !== operationId || !['restoring', state].includes(row.state))
      throw new DeliveryError('handoff_unconfirmed', '恢复回执与这份副本登记的操作不一致。');
    if (state === row.state) { if (state === 'restored') this.removeHandoffFile(row); return; }
    if (state === 'ready') { this.replaceHandoff({ ...row, state }); return; }
    // Publish the new native ownership and the end of the local guard together.
    const added: Attachment[] = [];
    try {
      for (const key of row.attachmentIds) {
        const entry = this.entries.get(key)!;
        if (!entry.threads.includes(threadId)) {
          if (entry.threads.length >= 256) throw new DeliveryError('capacity', '附件会话引用已满，已保留排队恢复副本。');
          entry.threads.push(threadId); added.push(entry);
        }
      }
      this.replaceHandoff({ ...row, state });
    } catch (error) {
      if (this.handoffs.get(id)?.state !== state) for (const entry of added) entry.threads = entry.threads.filter(key => key !== threadId);
      throw error;
    }
    this.removeHandoffFile(row);
  }
  private removeHandoffFile(row: QueueHandoff): void {
    try { this.readHandoffPayload(row); unlinkSync(this.file(handoffFile(row.id))); this.syncDirectory(); }
    catch (error) { if (!absent(error)) throw error; }
  }
  discardQueueHandoff(threadId: string, id: string): void {
    this.confirmHandoffPublication();
    handoffIdentity(threadId, 'threadId'); handoffKey(id);
    if (!this.handoffs.has(id)) return;
    const row = this.handoff(threadId, id);
    if (row.state === 'restoring') throw new DeliveryError('handoff_unconfirmed', '恢复结果未确定，请先查询恢复回执。');
    if (!row.discarding) this.replaceHandoff({ ...row, discarding: true });
    this.removeHandoffFile(row);
    for (const key of new Set([...row.attachmentIds, ...row.candidateIds ?? []])) {
      const entry = this.entries.get(key);
      if (entry && !entry.threads.length && !entry.referencesUnverified && !this.handoffProtects(entry)) {
        entry.state = 'deleting'; this.save(); this.finishDelete(entry);
      }
    }
    const next = new Map(this.handoffs); next.delete(id); this.publishHandoffs(next);
  }
  moveReadyQueueHandoffs(sourceThreadId: string, targetThreadId: string, ids: string[], targetProvider?: string): void {
    this.confirmHandoffPublication();
    handoffIdentity(sourceThreadId, 'sourceThreadId'); handoffIdentity(targetThreadId, 'targetThreadId');
    if (sourceThreadId === targetThreadId || !Array.isArray(ids) || ids.length > handoffLimit || new Set(ids).size !== ids.length)
      throw new DeliveryError('invalid_params', '转换目标或副本选择无效。');
    const next = new Map(this.handoffs);
    let moved = false;
    for (const id of ids) {
      const row = next.get(handoffKey(id));
      if (row?.metadataProvider && row.metadataProvider !== targetProvider)
        throw new DeliveryError('handoff_provider_mismatch', '所选待办含供应商私有客户端元数据，只可保留在原供应商。已保留原副本。');
      if (row && !row.discarding && row.threadId === targetThreadId && row.movedFrom === sourceThreadId) continue;
      if (!row || row.discarding || row.threadId !== sourceThreadId || row.state !== 'ready' ||
          [...next.values()].some(other => other.threadId === targetThreadId && other.queuedSubmissionId === row.queuedSubmissionId && other.digest === row.digest))
        throw new DeliveryError('handoff_unconfirmed', '所选副本与原会话、恢复状态或目标会话不符，已保留原绑定。');
      next.set(id, { ...row, ...(row.candidateIds?.length ? { candidateThreadId: candidateSource(row) } : {}),
        threadId: targetThreadId, movedFrom: sourceThreadId }); moved = true;
    }
    if (moved) this.publishHandoffs(next);
  }
  private syncDirectory(): void { if (process.platform !== 'win32') { const fd = openSync(this.dir, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); try { fsyncSync(fd); } finally { closeSync(fd); } } }
  private public(item: Attachment): JsonObject { return { attachmentId: item.attachmentId, name: item.name, mimeType: item.mimeType, size: item.size }; }
  get root(): string { return this.dir; }
  get activeImageDigests(): string {
    const hashes = new Set([...this.entries.values()].filter(row => row.state === 'live' && row.mimeType.startsWith('image/')).map(row => row.sha256));
    for (const alias of this.imageBindings.aliases()) hashes.add(alias.sha256);
    for (const candidate of this.imageBindings.candidateOrigins()) hashes.add(candidate.sha256);
    // The private inventory covers at most 128 uploads, 1024 acknowledged
    // aliases and 128 candidate digests. The helper never receives file names.
    return Buffer.from([...hashes].sort().join(''), 'hex').toString('base64');
  }
  get needsReconciliation(): boolean { return this.copies.size > 0 || [...this.entries.values()].some(entry => entry.threads.length > 0 || entry.referencesUnverified === true); }
  protectUnverifiedReferences(): void {
    const changed = [...this.entries.values()].filter(entry => entry.threads.length && !entry.referencesUnverified);
    for (const entry of changed) entry.referencesUnverified = true;
    try { if (changed.length) this.save(); } catch (error) { for (const entry of changed) delete entry.referencesUnverified; throw error; }
  }
  hasThread(threadId: string): boolean { return [...this.entries.values()].some(entry => entry.state === 'live' && entry.threads.includes(threadId)); }
  /** Durable guard precedes native fork/copy: an unknown outcome cannot free its bytes. */
  reserveCopy(source: string): string | undefined {
    const entries = [...this.entries.values()].filter(entry => entry.state === 'live' && entry.threads.includes(source));
    if (!entries.length) return undefined;
    if (this.copies.size >= 128 || entries.some(entry => this.referenceCount(entry, entry.threads) >= 256)) throw new DeliveryError('capacity', '附件复制等待核对的数量已达上限，请先重启运行时完成核对。');
    const id = randomUUID(), marker = 'copy:' + id;
    this.copies.set(id, { id, source }); for (const entry of entries) entry.threads.push(marker);
    try { this.save(); } catch (error) { this.copies.delete(id); for (const entry of entries) entry.threads = entry.threads.filter(value => value !== marker); throw error; }
    return id;
  }
  finishCopy(id: string | undefined, target?: string, paths: string[] = [], images?: JsonValue): void {
    if (!id || !this.copies.has(id)) return;
    const copy = this.copies.get(id)!, marker = 'copy:' + id, previous = new Map<Attachment, string[]>(); const verified = new Set(paths), pictures = imageProofs(images);
    for (const entry of this.entries.values()) if (entry.threads.includes(marker)) {
      previous.set(entry, [...entry.threads]); entry.threads = entry.threads.filter(value => value !== marker);
      if (target && (pictures.has(entry.mimeType + ':' + entry.sha256) || this.referenceNames(entry).some(name => verified.has(path.join(this.dir, name)))) && !entry.threads.includes(target)) entry.threads.push(target);
    }
    this.copies.delete(id);
    try { this.save(); } catch (error) { this.copies.set(id, copy); for (const [entry, threads] of previous) entry.threads = threads; throw error; }
  }
  /** Called only after permanent native deletion is positively confirmed. */
  releaseThread(threadId: string): void {
    const releasedSources = new Set<Attachment>();
    for (const row of [...this.handoffs.values()]) {
      if (row.threadId !== threadId && candidateSource(row) === threadId && row.candidateIds?.length) {
        for (const key of row.candidateIds) { const entry = this.entries.get(key); if (entry) releasedSources.add(entry); }
        this.replaceHandoff({ ...row, candidateIds: [] });
      }
      // An uncertain accepted request still needs its owner proof even after a native deletion.
      if (row.threadId === threadId && row.state !== 'restoring') this.discardQueueHandoff(threadId, row.id);
    }
    const bindings = new QueueImageBindings(this.imageBindings.json()); bindings.releaseThread(threadId);
    this.publishHandoffs(this.handoffs, bindings);
    const previous = new Map<Attachment, string[]>();
    for (const entry of this.entries.values()) if (entry.threads.includes(threadId) && !this.pins.get(entry)?.get(threadId)?.pending.size) { previous.set(entry, entry.threads); entry.threads = entry.threads.filter(id => id !== threadId); }
    if (!previous.size && !releasedSources.size) return;
    try { this.save(); } catch (error) { for (const [entry, threads] of previous) entry.threads = threads; throw error; }
    for (const entry of new Set([...previous.keys(), ...releasedSources])) if (!entry.threads.length && !entry.referencesUnverified && !this.handoffProtects(entry)) { entry.state = 'deleting'; this.save(); this.finishDelete(entry); }
  }
  /** Startup-only proof from a complete bounded rollout directory inventory.
   * Compressed/changed histories keep their old refs, and unresolved copies
   * retain their durable guards until every potential target is inspected. */
  reconcile(value: JsonObject): void {
    if (!Array.isArray(value.threadIds) || value.threadIds.length > 10000 || !Array.isArray(value.unresolvedThreadIds) || !Array.isArray(value.references)) throw fault('Invalid attachment reconciliation proof');
    const present = new Set(value.threadIds.map(id => string(id, 'history thread', 256))), unresolved = new Set(value.unresolvedThreadIds.map(id => string(id, 'unresolved history thread', 256)));
    if ([...unresolved].some(id => !present.has(id))) throw fault('Invalid unresolved history identity');
    const refs = new Map<string, Set<string>>(), pictures = new Map<string, Set<string>>(), imageOwners = new Map<string, Set<string>>(); let count = 0;
    const unmatchedQueue = new Set<string>(), aliases = this.imageBindings.aliases();
    const nextBindings = new QueueImageBindings(this.imageBindings.json());
    const candidatesFull = new Set<string>();
    for (const row of value.references) {
      const record = object(row), id = string(record.threadId, 'history thread', 256);
      if (!present.has(id) || unresolved.has(id) || !Array.isArray(record.paths) || record.paths.length > 128 || pictures.has(id))
        throw fault('Invalid attachment history reference');
      const hashes = imageProofs(record.images); pictures.set(id, hashes);
      if (record.unmatchedQueuedImage !== undefined && typeof record.unmatchedQueuedImage !== 'boolean') throw fault('Invalid native image proof');
      const known = new Set([...this.entries.values()].filter(entry => entry.state === 'live' && entry.threads.includes(id)).map(entry => entry.mimeType + ':' + entry.sha256));
      for (const alias of aliases) if (alias.threadId === id) known.add(alias.mimeType + ':' + alias.sha256);
      const inQueue = imageProofs(record.queuedImages);
      const unknownQueue = new Set([...imageProofs(record.unmatchedQueuedImages), ...[...inQueue].filter(digest => !known.has(digest))]);
      const unknownHistory = new Set([...imageProofs(record.unmatchedHistoryImages), ...[...hashes].filter(digest => !known.has(digest))]);
      const owned = [...this.entries.values()].filter(entry => entry.state === 'live' && !entry.queueOrigin && entry.threads.includes(id) && entry.mimeType.startsWith('image/'));
      const migrate = (digests: Set<string>, candidates: Attachment[]) => {
        if (!digests.size || !candidates.length) return;
        const proofs = [...digests].map(digest => { const [mimeType, sha256] = digest.split(':'); return { mimeType: mimeType!, sha256: sha256! }; });
        if (!nextBindings.observeCandidates(id, proofs, candidates.map(entry => entry.attachmentId))) candidatesFull.add(id);
        for (const digest of digests) hashes.add(digest);
      };
      migrate(unknownQueue, owned);
      migrate(unknownHistory, owned.filter(entry => entry.legacyQueueImage || this.imageBindings.pendingAttachments(id).includes(entry.attachmentId)));
      if (record.unmatchedQueuedImage === true || unknownQueue.size || candidatesFull.has(id)) unmatchedQueue.add(id);
      for (const hash of hashes) { const owners = imageOwners.get(hash) ?? new Set<string>(); owners.add(id); imageOwners.set(hash, owners); }
      count += hashes.size + record.paths.length;
      if (count > 32768) throw fault('Attachment reference budget exceeded');
      for (const file of record.paths) {
        const filename = string(file, 'attachment path', 4096); const ids = refs.get(filename) ?? new Set<string>(); ids.add(id); refs.set(filename, ids);
      }
    }
    const oldGeneration = this.scanGeneration, oldUnresolved = this.unresolvedSince;
    const generation = oldGeneration + 1;
    const sourceSince = new Map([...unresolved].map(id => [id, oldUnresolved.get(id) ?? generation]));
    const earliestUnresolved = Math.min(Infinity, ...sourceSince.values());
    const oldLegacyScan = new Map([...this.entries.values()].map(entry => [entry, entry.legacyCopyScan]));
    const pendingCopies = new Map([...this.copies].map(([id, copy]) => [id, { ...copy, firstScan: copy.firstScan ?? generation }]));
    const oldUnverified = new Map([...this.entries.values()].map(entry => [entry, entry.referencesUnverified === true])), oldCopies = new Map(this.copies), previous = new Map<Attachment, string[]>(), replacements = new Map<Attachment, string[]>();
    const ambiguousCopies = new Set<string>();
    nextBindings.pruneCandidates(row => unresolved.has(row.threadId) || !!pictures.get(row.threadId)?.has(row.mimeType + ':' + row.sha256));
    const retention = new Map<string, Set<string>>();
    for (const row of nextBindings.candidateOrigins()) {
      for (const aid of row.attachmentIds) {
        const held = retention.get(aid) ?? new Set<string>(); held.add(row.threadId); retention.set(aid, held);
      }
    }
    const oldMigration = new Map([...this.entries.values()].map(entry => [entry, entry.legacyQueueImage]));

    for (const entry of this.entries.values()) {
      previous.set(entry, [...entry.threads]); const found = new Set(this.referenceNames(entry).flatMap(name => [...(refs.get(path.join(this.dir, name)) ?? [])]));
      const digest = entry.mimeType + ':' + entry.sha256;
      for (const id of entry.threads) {
        if (pictures.get(id)?.has(digest) || entry.mimeType.startsWith('image/') && unmatchedQueue.has(id) || retention.get(entry.attachmentId)?.has(id) ||
            this.imageBindings.pendingAttachments(id).includes(entry.attachmentId)) found.add(id);
      }
      for (const alias of aliases) if (alias.attachmentId === entry.attachmentId && entry.threads.includes(alias.threadId) &&
          pictures.get(alias.threadId)?.has(alias.mimeType + ':' + alias.sha256)) found.add(alias.threadId);
      // A lost fork receipt leaves no trusted destination identity. Its reservation
      // can retain the original bytes, but a matching image alone cannot grant access.
      const maybeCopied = this.copies.size > 0 && [...(imageOwners.get(digest) ?? [])].some(id => !entry.threads.includes(id));
      const retained = entry.threads.filter(id => {
        if (unresolved.has(id)) return true;
        if (id.startsWith('copy:') && this.copies.has(id.slice(5)) && maybeCopied) { ambiguousCopies.add(id.slice(5)); return true; }
        const copy = id.startsWith('copy:') ? pendingCopies.get(id.slice(5)) : undefined;
        if (copy && earliestUnresolved <= copy.firstScan) { ambiguousCopies.add(copy.id); return true; }
        return false;
      });
      const next = [...new Set([...retained, ...found])]; if (this.referenceCount(entry, next) > 256) throw fault('Attachment reference capacity exhausted'); replacements.set(entry, next);
    }
    for (const [entry, threads] of replacements) {
      entry.threads = threads;
      const cutoff = entry.legacyCopyScan === 0 ? generation : entry.legacyCopyScan;
      entry.referencesUnverified = cutoff !== undefined && earliestUnresolved <= cutoff;
      if (entry.referencesUnverified) entry.legacyCopyScan = cutoff!;
      else delete entry.legacyCopyScan;
    }
    this.copies = new Map([...pendingCopies].filter(([id]) => ambiguousCopies.has(id)));
    // Keep only unreadable sources that existed during the first inventory after
    // a genuinely ambiguous copy. Later unrelated failures cannot renew a guard.
    if (this.copies.size || [...this.entries.values()].some(entry => entry.legacyCopyScan !== undefined)) {
      const cutoff = Math.max(0, ...[...this.copies.values()].map(copy => copy.firstScan ?? 0),
        ...[...this.entries.values()].map(entry => entry.legacyCopyScan ?? 0));
      this.scanGeneration = generation;
      this.unresolvedSince = new Map([...sourceSince].filter(([, first]) => first <= cutoff));
    } else {
      this.scanGeneration = 0; this.unresolvedSince = new Map();
    }
    for (const entry of this.entries.values()) {
      if (entry.legacyQueueImage && !entry.threads.some(id => unresolved.has(id) || candidatesFull.has(id))) delete entry.legacyQueueImage;
    }
    nextBindings.pruneConfirmed(alias => unresolved.has(alias.threadId) || unmatchedQueue.has(alias.threadId) ||
      !!pictures.get(alias.threadId)?.has(alias.mimeType + ':' + alias.sha256));
    try { this.publishHandoffs(this.handoffs, nextBindings); } catch (error) { this.scanGeneration = oldGeneration; this.unresolvedSince = oldUnresolved; this.copies = oldCopies; for (const [entry, threads] of previous) { entry.threads = threads; entry.referencesUnverified = oldUnverified.get(entry) === true; if (oldMigration.get(entry)) entry.legacyQueueImage = true; const priorScan = oldLegacyScan.get(entry); if (priorScan === undefined) delete entry.legacyCopyScan; else entry.legacyCopyScan = priorScan; } throw error; }
    for (const entry of previous.keys()) if (!entry.threads.length && !entry.referencesUnverified && !this.handoffProtects(entry) && (previous.get(entry)!.length || oldUnverified.get(entry))) { entry.state = 'deleting'; this.save(); this.finishDelete(entry); }
  }
  upload(params: JsonObject, clientId: string, queueOrigin?: NonNullable<Attachment['queueOrigin']>): JsonValue {
    const name = string(params.name, 'name', 256); let mimeType = string(params.mimeType ?? '', 'mimeType', 128, true).trim() || 'application/octet-stream'; string(clientId, 'clientId', 256);
    const mediaType = mimeType.split(';')[0]!.trim().toLowerCase(); let audio: string | undefined = audioFormats[mediaType];
    if (!audio && mediaType === 'application/octet-stream') audio = /\.(wav|mp3|m4a|webm|ogg)$/i.exec(name)?.[1]?.toLowerCase();
    if (audio) mimeType = audioMimes[audio]!;
    const base64 = string(params.base64, 'base64', 6 * 1024 * 1024, true);
    // Buffer's decoder is permissive. Round-trip the already bounded input to
    // reject malformed/noncanonical encodings without a size-dependent RegExp stack.
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.toString('base64') !== base64) throw new DeliveryError('invalid_params', 'Invalid base64');
    const usage = this.usage();
    if (bytes.length > LIMITS.attachmentBytes || usage.bytes + bytes.length > LIMITS.attachmentTotal || usage.count >= LIMITS.attachments) throw new DeliveryError('capacity', 'Attachment capacity exhausted');
    mimeType = attachmentMediaType(bytes, mimeType);
    if (mimeType.startsWith('audio/') && !audioFormats[mimeType]) throw new DeliveryError('unsupported_audio_format', 'Use wav, mp3, m4a, webm or ogg audio');
    const suffix = mediaSuffixes[mimeType.split(';')[0]!.toLowerCase()];
    const attachmentId = randomUUID(), fileName = suffix ? `${attachmentId}.${suffix}` : undefined; const file = this.file(fileName ?? attachmentId);
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), this.group === undefined ? 0o600 : 0o640);
    let stat: BigIntStats;
    try { writeFileSync(fd, bytes); fchmodSync(fd, this.group === undefined ? 0o600 : 0o640); fsyncSync(fd); stat = fstatSync(fd, { bigint: true }); if (this.group !== undefined && stat.gid !== BigInt(this.group)) throw fault('Attachment read group was not inherited'); } finally { closeSync(fd); }
    const entry: Attachment = { attachmentId, ...(fileName ? { fileName } : {}), name, mimeType, size: bytes.length, owner: clientId, created: Date.now(), threads: queueOrigin ? [queueOrigin.threadId] : [], ...(queueOrigin ? { queueOrigin } : {}), identity: identity(stat), sha256: createHash('sha256').update(bytes).digest('hex'), state: 'live' };
    this.entries.set(attachmentId, entry);
    try { this.save(); } catch (error) {
      // A failed index commit never hides physical bytes from accounting. Restart discovers the orphan.
      entry.state = 'deleting'; try { this.save(); this.finishDelete(entry); } catch {} throw error;
    }
    return this.public(entry);
  }
  private get(id: unknown, threadId?: JsonValue): Attachment {
    const entry = this.entries.get(string(id, 'attachmentId'));
    if (!entry || entry.state !== 'live' || (threadId !== undefined && (typeof threadId !== 'string' || !this.ownsReference(entry, threadId)))) throw new DeliveryError('not_found', 'Attachment not found for this context');
    return entry;
  }
  private requireCandidateScope(item: Attachment, threadId?: JsonValue): void {
    const protectedSource = [...this.handoffs.values()].some(row => !row.discarding && row.candidateIds?.includes(item.attachmentId));
    if (protectedSource && (typeof threadId !== 'string' || !this.ownsReference(item, threadId)))
      throw new DeliveryError('not_found', '请从保留该原上传文件的会话中读取。');
  }
  read(params: JsonObject): JsonValue {
    const item = this.get(params.attachmentId, params.threadId);
    this.requireCandidateScope(item, params.threadId);
    return { ...this.public(item), base64: this.readEntry(item).toString('base64') };
  }
  readHistory(params: JsonObject): JsonValue {
    onlyKeys(params, ['threadId', 'path']);
    const threadId = string(params.threadId, 'threadId', 256), filename = string(params.path, 'history attachment path', 4096);
    const entry = [...this.entries.values()].find(item => item.state === 'live' && this.ownsReference(item, threadId) && this.referenceNames(item).some(name => path.join(this.dir, name) === filename));
    if (!entry) throw new DeliveryError('not_found', 'This path is not a retained attachment of this thread');
    return { ...this.public(entry), base64: this.readEntry(entry).toString('base64') };
  }
  private finishDelete(item: Attachment): boolean {
    const file = this.file(this.dataName(item));
    for (const name of this.referenceNames(item).slice(1)) {
      try {
        if (createHash('sha256').update(this.readFile(name, LIMITS.attachmentBytes).bytes).digest('hex') !== item.sha256) throw fault('Stored visual reference changed');
        unlinkSync(this.file(name));
      } catch (error) { if (!absent(error)) throw error; }
    }
    try {
      const stat = lstatSync(file, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || !sameFile(item.identity, identity(stat))) throw fault('Attachment pending deletion was replaced');
      try { unlinkSync(file); } catch (error) { if (!absent(error)) return false; }
    } catch (error) { if (!absent(error)) throw error; }
    this.syncDirectory(); this.entries.delete(item.attachmentId);
    try { this.save(); } catch (error) { this.entries.set(item.attachmentId, item); throw error; }
    return true;
  }
  remove(params: JsonObject): JsonValue {
    const item = this.get(params.attachmentId);
    if (item.threads.length || item.referencesUnverified || this.handoffProtects(item)) throw new DeliveryError('attachment_in_use', 'Attachment is retained by thread history');
    item.state = 'deleting'; try { this.save(); } catch (error) { item.state = 'live'; throw error; }
    if (!this.finishDelete(item)) throw new DeliveryError('attachment_delete_pending', 'Attachment deletion is pending; its storage remains reserved', 'unknown');
    return {};
  }
  private nativeInput(entry: Attachment, preparing = false): JsonObject {
    const video = ['video/mp4', 'video/quicktime'].includes(entry.mimeType);
    const file = preparing && video ? this.mediaReferencePath(entry) : path.join(this.dir, this.dataName(entry));
    if (entry.mimeType.startsWith('image/')) return { type: 'localImage', path: file };
    if (entry.mimeType.startsWith('audio/')) {
      if (entry.fileName) return { type: 'localAudio', path: file };
      if (preparing) throw new DeliveryError('audio_reupload_required', 'Upload this older audio attachment again so the native CLI can recognize its format');
    }
    return { type: 'text', text: `Attached file ${JSON.stringify(entry.name)} is available at ${JSON.stringify(file)}.`, text_elements: [] };
  }
  /** Only substitute immutable managed upload paths, never arbitrary native images. */
  toolReference(item: JsonObject): JsonObject | undefined {
    if (item.type !== 'localImage' || typeof item.path !== 'string') return;
    const entry = [...this.entries.values()].find(row => row.state === 'live' && path.join(this.dir, this.dataName(row)) === item.path);
    if (!entry) return;
    if (!['image/jpeg', 'image/png'].includes(entry.mimeType)) throw new DeliveryError('tool_image_format', '本站允许通过工具引用传递 JPEG 和 PNG，请选择支持该图片格式的模型或更换文件。');
    const file = this.mediaReferencePath(entry);
    return { type: 'text', text: `Attached file ${JSON.stringify(entry.name)} is available at ${JSON.stringify(file)}.` + visionReferenceGuidance, text_elements: [] };
  }
  private mediaReferencePath(entry: Attachment): string {
    if (entry.fileName) return this.file(entry.fileName);
    // Existing transcripts and queued references must retain their original
    // bare path. A verified sibling supplies the format to extension-based tools.
    const alias = entry.attachmentId + '.' + mediaSuffixes[entry.mimeType];
    const bytes = this.readEntry(entry);
    const files = this.scan();
    if (!files.has(alias)) {
      const usage = this.usage(files);
      if (usage.bytes + bytes.length > LIMITS.attachmentTotal || usage.count >= LIMITS.attachments) throw new DeliveryError('capacity', '媒体格式兼容副本超过附件存储容量。');
    }
    try {
      const fd = openSync(this.file(alias), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), this.group === undefined ? 0o600 : 0o640);
      try {
        writeFileSync(fd, bytes); fchmodSync(fd, this.group === undefined ? 0o600 : 0o640); fsyncSync(fd);
        if (this.group !== undefined && fstatSync(fd).gid !== this.group) throw fault('Attachment read group was not inherited');
      } catch (error) { unlinkSync(this.file(alias)); throw error; } finally { closeSync(fd); }
      this.syncDirectory();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!this.readFile(alias, LIMITS.attachmentBytes).bytes.equals(bytes)) throw fault('Stored visual reference changed');
    return this.file(alias);
  }
  private referenceNames(entry: Attachment): string[] {
    const names = [this.dataName(entry)];
    if (!entry.fileName && ['image/png', 'image/jpeg', 'video/quicktime', 'video/mp4'].includes(entry.mimeType)) names.push(entry.attachmentId + '.' + mediaSuffixes[entry.mimeType]);
    return names;
  }
  private queueReferences(threadId: string): Map<string, Attachment> {
    const references = new Map<string, Attachment>();
    for (const entry of this.entries.values()) {
      if (entry.state !== 'live' || !this.ownsReference(entry, threadId)) continue;
      for (const name of this.referenceNames(entry)) {
        const file = this.file(name);
        const original = `Attached file ${JSON.stringify(entry.name)} is available at ${JSON.stringify(file)}.`;
        references.set(original, entry);
        if (['image/png', 'image/jpeg'].includes(entry.mimeType)) references.set(original + visionReferenceGuidance, entry);
      }
    }
    return references;
  }
  /** Saved native queue rows cannot change representation during start/resume. */
  queueMediaEvidence(input: JsonValue[], threadId: string): JsonValue[] {
    const references = this.queueReferences(threadId);
    return input.map(value => {
      const item = object(value);
      if (item.type === 'image' || item.type === 'localImage') return { type: 'harnessQueuedNativeImage' };
      const entry = item.type === 'text' && typeof item.text === 'string' ? references.get(item.text) : undefined;
      if (!entry) return value;
      if (['image/jpeg', 'image/png'].includes(entry.mimeType)) return { type: 'harnessQueuedImageReference' };
      if (['video/quicktime', 'video/mp4'].includes(entry.mimeType) && !entry.fileName &&
          item.text === this.nativeInput(entry).text) return { type: 'harnessQueuedLegacyVideo' };
      return value;
    });
  }
  async compactQueuedInput(input: JsonValue[], threadId: string, queuedId: string,
    readImage: (slot: number, marker: JsonObject) => Promise<JsonObject>, beforeMaterialize?: () => void): Promise<JsonValue[]> {
    const result: JsonValue[] = [];
    for (const [slot, value] of input.entries()) {
      const item = object(value);
      if (item.type !== 'harnessInlineImageDigest') { result.push(value); continue; }
      let id = this.resolveOriginalQueuedImage(threadId, queuedId, slot, item) ?? this.resolveQueuedImageDigest(threadId, item);
      if (!id && beforeMaterialize) {
        const verified = await readImage(slot, item);
        if (verified.mimeType !== item.mimeType || verified.sha256 !== item.sha256 || verified.bytes !== item.bytes || typeof verified.base64 !== 'string')
          throw new DeliveryError('queue_changed', '原生队列中的图片已变化，请刷新。');
        beforeMaterialize();
        id = this.materializeNativeQueuedImage(threadId, queuedId, slot, { type: 'image', url: `data:${verified.mimeType};base64,${verified.base64}` });
      }
      if (!id) throw new DeliveryError('queue_image_unverified', '此图暂无法对应原上传。可明确保存待办副本，以原生队列中实际保留的图片继续。');
      result.push({ ...this.nativeInput(this.get(id), true), ...(item.detail !== undefined ? { detail: item.detail } : {}) });
    }
    return result;
  }
  /** Only an explicit queue edit or restore may change stored media. Preserve
   * user text, structured reference/context rows and their original order. */
  rerouteQueueInput(input: JsonValue[], threadId: string, queuedId?: string, beforeMaterialize?: () => void): JsonValue[] {
    const references = this.queueReferences(threadId);
    return input.map((value, slot) => {
      const item = object(value);
      let inline = item.type === 'image' ? (queuedId ? this.resolveOriginalQueuedImage(threadId, queuedId, slot, item) : undefined) ?? this.resolveQueuedNativeImage(threadId, item) : undefined;
      if (!inline && item.type === 'image' && typeof item.url === 'string' && /^data:image\/(?:png|jpeg|gif|webp);base64,/.test(item.url) && queuedId && beforeMaterialize) {
        beforeMaterialize(); inline = this.materializeNativeQueuedImage(threadId, queuedId, slot, item);
      }
      if (inline) return { ...this.nativeInput(this.get(inline), true), ...(item.detail !== undefined ? { detail: item.detail } : {}) };
      const entry = item.type === 'text' && typeof item.text === 'string' ? references.get(item.text) : undefined;
      if (!entry || !['image/png', 'image/jpeg', 'video/quicktime', 'video/mp4'].includes(entry.mimeType)) return value;
      const replacement = this.nativeInput(entry, true);
      return replacement.type === item.type && replacement.text === item.text ? value : replacement;
    });
  }
  describeInput(input: JsonValue, threadId: string, queuedId?: string): { text: string; attachmentIds: string[]; attachments: JsonObject[]; retainedInput: JsonValue[]; retainedAttachments: JsonValue[]; retainedReferences: JsonValue[]; retainedExtras: JsonValue[]; retainedLegacyContext: JsonValue[]; hasOpaqueInput: boolean } {
    if (!Array.isArray(input)) throw new DeliveryError('invalid_native_response', 'Queued input must be an array');
    const text: string[] = [], attachmentIds: string[] = [], attachments: JsonObject[] = [], retainedInput: JsonValue[] = [], retainedAttachments: JsonValue[] = [], retainedReferences: JsonValue[] = [], retainedExtras: JsonValue[] = [], retainedLegacyContext: JsonValue[] = []; let hasOpaqueInput = false;
    const candidates = [...this.entries.values()].filter(entry => entry.state === 'live' && this.ownsReference(entry, threadId))
      .map(entry => ({ entry, native: this.nativeInput(entry) }));
    for (const [text, entry] of this.queueReferences(threadId)) candidates.push({ entry, native: { type: 'text', text } });
    for (const [slot, item] of input.entries()) {
      const value = object(item); const match = candidates.find(({ native }) => value.type === native.type && (value.type === 'localImage' || value.type === 'localAudio' ? value.path === native.path : value.text === native.text));
      const inline = value.type === 'image' ? (queuedId ? this.resolveOriginalQueuedImage(threadId, queuedId, slot, value) : undefined) ?? this.resolveQueuedNativeImage(threadId, value) : undefined;
      const attached = match?.entry ?? (inline ? this.get(inline) : undefined);
      if (attached) { attachmentIds.push(attached.attachmentId); attachments.push(this.public(attached)); retainedInput.push(item); retainedAttachments.push(item); }
      else if (contextSource(value) || value.type === 'skill' || value.type === 'mention') {
        retainedInput.push(item); const source = contextSource(value);
        (source === 'extra' ? retainedExtras : source === 'legacy' ? retainedLegacyContext : retainedReferences).push(item); hasOpaqueInput = true;
      }
      else if (value.type === 'text') text.push(string(value.text, 'queued text', 1024 * 1024, true));
      else { retainedInput.push(item); retainedAttachments.push(item); hasOpaqueInput = true; }
    }
    return { text: text.join('\n'), attachmentIds, attachments, retainedInput, retainedAttachments, retainedReferences, retainedExtras, retainedLegacyContext, hasOpaqueInput };
  }
  prepare(ids: JsonValue | undefined, threadId: string): PreparedAttachments {
    if (ids === undefined) return { input: [], pin: () => {}, settle: () => {} };
    if (!Array.isArray(ids) || ids.length > 8 || new Set(ids).size !== ids.length) throw new DeliveryError('invalid_params', 'At most eight distinct attachments are allowed');
    const entries = ids.map(id => this.get(id));
    for (const entry of entries) { this.requireCandidateScope(entry, threadId); this.readEntry(entry); }
    const input: JsonValue[] = entries.map(entry => this.nativeInput(entry, true));
    const token = Symbol('attachment pin'); let pinned = false; let settled = false;
    const groups: { entry: Attachment; group: PinGroup }[] = [];
    return { input, pin: () => {
      if (pinned || settled) throw fault('Attachment preparation was already consumed');
      for (const entry of entries) { if (entry.state !== 'live') throw fault('Attachment was removed before send'); this.requireCandidateScope(entry, threadId); this.readEntry(entry); }
      const newlyPinned = entries.filter(entry => !entry.threads.includes(threadId));
      if (newlyPinned.some(entry => this.referenceCount(entry, entry.threads, threadId) > 256)) throw new DeliveryError('capacity', 'Attachment reference capacity exhausted');
      for (const entry of entries) {
        let byThread = this.pins.get(entry); if (!byThread) { byThread = new Map(); this.pins.set(entry, byThread); }
        let group = byThread.get(threadId); if (!group) { group = { pending: new Set(), retained: entry.threads.includes(threadId) }; byThread.set(threadId, group); }
        group.pending.add(token); groups.push({ entry, group });
      }
      for (const entry of newlyPinned) entry.threads.push(threadId);
      try { this.save(); pinned = true; } catch (error) {
        for (const entry of newlyPinned) entry.threads = entry.threads.filter(id => id !== threadId);
        for (const { entry, group } of groups) { group.pending.delete(token); if (!group.pending.size) { this.pins.get(entry)?.delete(threadId); if (!this.pins.get(entry)?.size) this.pins.delete(entry); } }
        groups.length = 0; throw error;
      }
    }, settle: retain => {
      if (!pinned || settled) return; settled = true;
      const removed: Attachment[] = [];
      for (const { entry, group } of groups) {
        group.pending.delete(token); if (retain) group.retained = true;
        if (!group.pending.size) {
          if (!group.retained) { entry.threads = entry.threads.filter(id => id !== threadId); removed.push(entry); }
          this.pins.get(entry)?.delete(threadId); if (!this.pins.get(entry)?.size) this.pins.delete(entry);
        }
      }
      if (removed.length) try { this.save(); } catch (error) {
        // A failed rollback conservatively retains its reservation, including when rename already committed.
        for (const entry of removed) if (!entry.threads.includes(threadId)) entry.threads.push(threadId);
        throw error;
      }
    } };
  }
  gc(now = Date.now()): void {
    const files = this.scan();
    for (const item of this.entries.values()) if (item.state === 'live' && item.threads.length === 0 && !item.referencesUnverified && !this.handoffProtects(item) && now - item.created > MAX_AGE) {
      item.state = 'deleting'; try { this.save(); } catch (error) { item.state = 'live'; throw error; }
    }
    for (const item of [...this.entries.values()]) if (item.state === 'deleting') this.finishDelete(item);
    const names = new Set([...this.entries.values()].flatMap(entry => this.referenceNames(entry)));
    for (const row of this.handoffs.values()) if (row.state !== 'restored') names.add(handoffFile(row.id));
    for (const [name, stat] of files) if (!names.has(name) && (UUID.test(name.replace(/\.(wav|mp3|m4a|webm|ogg|jpg|png|gif|webp|mp4|mov)$/, '')) || /^queue-handoff-[0-9a-f-]{36}\.json$/.test(name) || /^index-[0-9a-f-]{36}\.tmp$/.test(name)) && now - Number(stat.mtimeMs) > MAX_AGE) {
      const file = this.file(name); let current: BigIntStats; try { current = lstatSync(file, { bigint: true }); } catch (error) { if (absent(error)) continue; throw error; }
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || !sameContents(identity(stat), identity(current))) throw fault('Attachment orphan changed during collection');
      try { unlinkSync(file); } catch { /* Still present, so the next scan and every admission continue charging it. */ }
    }
    this.syncDirectory(); this.usage();
  }
}
