import { createHash, randomUUID } from 'node:crypto';
import { constants, mkdirSync, writeFileSync, renameSync, unlinkSync, lstatSync, openSync, closeSync, fsyncSync, fstatSync, fchmodSync, readSync, opendirSync, chmodSync, chownSync, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { isContextText } from './input-context.js';
import { DeliveryError, jsonBytes, LIMITS, object, onlyKeys, string, type JsonObject, type JsonValue } from './types.js';

interface Identity { dev: string; ino: string; birthtimeNs: string; mtimeNs: string }
interface Attachment { attachmentId: string; fileName?: string; name: string; mimeType: string; size: number; owner: string; created: number; threads: string[]; identity: Identity; sha256: string; state: 'live' | 'deleting' }
interface PinGroup { pending: Set<symbol>; retained: boolean }
export interface PreparedAttachments { input: JsonValue[]; pin: () => void; settle: (retain: boolean) => void }
const INDEX_LIMIT = 2 * 1024 * 1024;
const DIRECTORY_LIMIT = LIMITS.attachments + 32;
const MAX_AGE = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const audioFormats: Record<string, string> = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/vnd.wave': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'audio/webm': 'webm', 'audio/ogg': 'ogg' };
const audioMimes: Record<string, string> = { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', webm: 'audio/webm', ogg: 'audio/ogg' };
const fault = (message: string): DeliveryError => new DeliveryError('attachment_storage', message);
const identity = (stat: BigIntStats): Identity => ({ dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs), mtimeNs: String(stat.mtimeNs) });
const sameFile = (a: Identity, b: Identity): boolean => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
const sameContents = (a: Identity, b: Identity): boolean => sameFile(a, b) && a.mtimeNs === b.mtimeNs;
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** The index is supervisor-private; only immutable data files are readable by the native UID. */
export class Attachments {
  private entries = new Map<string, Attachment>();
  private pins = new Map<Attachment, Map<string, PinGroup>>();
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
      if (index.version !== 2 || !Array.isArray(index.entries) || index.entries.length > LIMITS.attachments) throw fault('Invalid attachment index');
      for (const value of index.entries) {
        const item = object(value); const id = string(item.attachmentId, 'attachmentId'); const stored = object(item.identity);
        if (!UUID.test(id) || this.entries.has(id) || typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > LIMITS.attachmentBytes || !Array.isArray(item.threads) || item.threads.length > 256 || !item.threads.every(thread => typeof thread === 'string' && thread.length <= 4096) || typeof item.owner !== 'string' || typeof item.created !== 'number' || !Number.isFinite(item.created) || (item.state !== 'live' && item.state !== 'deleting') || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) || !['dev', 'ino', 'birthtimeNs', 'mtimeNs'].every(key => typeof stored[key] === 'string' && /^\d{1,30}$/.test(stored[key] as string))) throw fault('Invalid attachment metadata');
        string(item.name, 'name', 256); string(item.mimeType, 'mimeType', 128); string(item.owner, 'owner', 256);
        if (item.fileName !== undefined && (!audioFormats[String(item.mimeType).split(';')[0]!.toLowerCase()] || item.fileName !== `${id}.${audioFormats[String(item.mimeType).split(';')[0]!.toLowerCase()]}`)) throw fault('Invalid attachment data filename');
        const entry = value as unknown as Attachment; this.entries.set(id, entry);
        if (entry.state === 'live') this.readEntry(entry);
      }
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
  private save(): void {
    const target = this.file('index.json'); const temp = this.file(`index-${randomUUID()}.tmp`);
    try {
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600);
      try { writeFileSync(fd, jsonBytes({ version: 2, entries: [...this.entries.values()] }, INDEX_LIMIT)); fsyncSync(fd); } finally { closeSync(fd); }
      this.checkDirectory(); renameSync(temp, target); this.syncDirectory();
    } finally { try { unlinkSync(temp); } catch {} }
  }
  private syncDirectory(): void { if (process.platform !== 'win32') { const fd = openSync(this.dir, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); try { fsyncSync(fd); } finally { closeSync(fd); } } }
  private public(item: Attachment): JsonObject { return { attachmentId: item.attachmentId, name: item.name, mimeType: item.mimeType, size: item.size }; }
  upload(params: JsonObject, clientId: string): JsonValue {
    const name = string(params.name, 'name', 256); let mimeType = string(params.mimeType ?? 'application/octet-stream', 'mimeType', 128); string(clientId, 'clientId', 256);
    const mediaType = mimeType.split(';')[0]!.trim().toLowerCase(); let audio = audioFormats[mediaType];
    if (!audio && mediaType === 'application/octet-stream') audio = /\.(wav|mp3|m4a|webm|ogg)$/i.exec(name)?.[1]?.toLowerCase();
    if (mediaType.startsWith('audio/') && !audio) throw new DeliveryError('unsupported_audio_format', 'Use wav, mp3, m4a, webm or ogg audio');
    if (audio) mimeType = audioMimes[audio]!;
    const base64 = string(params.base64, 'base64', 6 * 1024 * 1024, true);
    // Buffer's decoder is permissive. Round-trip the already bounded input to
    // reject malformed/noncanonical encodings without a size-dependent RegExp stack.
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.toString('base64') !== base64) throw new DeliveryError('invalid_params', 'Invalid base64');
    const usage = this.usage();
    if (bytes.length > LIMITS.attachmentBytes || usage.bytes + bytes.length > LIMITS.attachmentTotal || usage.count >= LIMITS.attachments) throw new DeliveryError('capacity', 'Attachment capacity exhausted');
    const attachmentId = randomUUID(), fileName = audio ? `${attachmentId}.${audio}` : undefined; const file = this.file(fileName ?? attachmentId);
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), this.group === undefined ? 0o600 : 0o640);
    let stat: BigIntStats;
    try { writeFileSync(fd, bytes); fchmodSync(fd, this.group === undefined ? 0o600 : 0o640); fsyncSync(fd); stat = fstatSync(fd, { bigint: true }); if (this.group !== undefined && stat.gid !== BigInt(this.group)) throw fault('Attachment read group was not inherited'); } finally { closeSync(fd); }
    const entry: Attachment = { attachmentId, ...(fileName ? { fileName } : {}), name, mimeType, size: bytes.length, owner: clientId, created: Date.now(), threads: [], identity: identity(stat), sha256: createHash('sha256').update(bytes).digest('hex'), state: 'live' };
    this.entries.set(attachmentId, entry);
    try { this.save(); } catch (error) {
      // A failed index commit never hides physical bytes from accounting. Restart discovers the orphan.
      entry.state = 'deleting'; try { this.save(); this.finishDelete(entry); } catch {} throw error;
    }
    return this.public(entry);
  }
  private get(id: unknown, threadId?: JsonValue): Attachment {
    const entry = this.entries.get(string(id, 'attachmentId'));
    if (!entry || entry.state !== 'live' || (threadId !== undefined && (typeof threadId !== 'string' || !entry.threads.includes(threadId)))) throw new DeliveryError('not_found', 'Attachment not found for this context');
    return entry;
  }
  read(params: JsonObject): JsonValue { const item = this.get(params.attachmentId, params.threadId); return { ...this.public(item), base64: this.readEntry(item).toString('base64') }; }
  readHistory(params: JsonObject): JsonValue {
    onlyKeys(params, ['threadId', 'path']);
    const threadId = string(params.threadId, 'threadId', 256), filename = string(params.path, 'history attachment path', 4096);
    const entry = [...this.entries.values()].find(item => item.state === 'live' && item.threads.includes(threadId) && path.join(this.dir, this.dataName(item)) === filename);
    if (!entry) throw new DeliveryError('not_found', 'This path is not a retained attachment of this thread');
    return { ...this.public(entry), base64: this.readEntry(entry).toString('base64') };
  }
  private finishDelete(item: Attachment): boolean {
    const file = this.file(this.dataName(item));
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
    if (item.threads.length) throw new DeliveryError('attachment_in_use', 'Attachment is retained by thread history');
    item.state = 'deleting'; try { this.save(); } catch (error) { item.state = 'live'; throw error; }
    if (!this.finishDelete(item)) throw new DeliveryError('attachment_delete_pending', 'Attachment deletion is pending; its storage remains reserved', 'unknown');
    return {};
  }
  private nativeInput(entry: Attachment, preparing = false): JsonObject {
    const file = path.join(this.dir, this.dataName(entry));
    if (entry.mimeType.startsWith('image/')) return { type: 'localImage', path: file };
    if (entry.mimeType.startsWith('audio/')) {
      if (entry.fileName) return { type: 'localAudio', path: file };
      if (preparing) throw new DeliveryError('audio_reupload_required', 'Upload this older audio attachment again so the native CLI can recognize its format');
    }
    return { type: 'text', text: `Attached file ${JSON.stringify(entry.name)} is available at ${JSON.stringify(file)}.`, text_elements: [] };
  }
  describeInput(input: JsonValue, threadId: string): { text: string; attachmentIds: string[]; attachments: JsonObject[]; retainedInput: JsonValue[]; retainedAttachments: JsonValue[]; retainedReferences: JsonValue[]; hasOpaqueInput: boolean } {
    if (!Array.isArray(input)) throw new DeliveryError('invalid_native_response', 'Queued input must be an array');
    const text: string[] = [], attachmentIds: string[] = [], attachments: JsonObject[] = [], retainedInput: JsonValue[] = [], retainedAttachments: JsonValue[] = [], retainedReferences: JsonValue[] = []; let hasOpaqueInput = false;
    const candidates = [...this.entries.values()].filter(entry => entry.state === 'live' && entry.threads.includes(threadId)).map(entry => ({ entry, native: this.nativeInput(entry) }));
    for (const item of input) {
      const value = object(item); const match = candidates.find(({ native }) => value.type === native.type && (value.type === 'localImage' || value.type === 'localAudio' ? value.path === native.path : value.text === native.text));
      if (match) { attachmentIds.push(match.entry.attachmentId); attachments.push(this.public(match.entry)); retainedInput.push(item); retainedAttachments.push(item); }
      else if (isContextText(value) || value.type === 'skill' || value.type === 'mention') { retainedInput.push(item); retainedReferences.push(item); hasOpaqueInput = true; }
      else if (value.type === 'text') text.push(string(value.text, 'queued text', 1024 * 1024, true));
      else { retainedInput.push(item); retainedAttachments.push(item); hasOpaqueInput = true; }
    }
    return { text: text.join('\n'), attachmentIds, attachments, retainedInput, retainedAttachments, retainedReferences, hasOpaqueInput };
  }
  prepare(ids: JsonValue | undefined, threadId: string): PreparedAttachments {
    if (ids === undefined) return { input: [], pin: () => {}, settle: () => {} };
    if (!Array.isArray(ids) || ids.length > 8 || new Set(ids).size !== ids.length) throw new DeliveryError('invalid_params', 'At most eight distinct attachments are allowed');
    const entries = ids.map(id => this.get(id)); for (const entry of entries) this.readEntry(entry);
    const input: JsonValue[] = entries.map(entry => this.nativeInput(entry, true));
    const token = Symbol('attachment pin'); let pinned = false; let settled = false;
    const groups: { entry: Attachment; group: PinGroup }[] = [];
    return { input, pin: () => {
      if (pinned || settled) throw fault('Attachment preparation was already consumed');
      for (const entry of entries) { if (entry.state !== 'live') throw fault('Attachment was removed before send'); this.readEntry(entry); }
      const newlyPinned = entries.filter(entry => !entry.threads.includes(threadId));
      if (newlyPinned.some(entry => entry.threads.length >= 256)) throw new DeliveryError('capacity', 'Attachment reference capacity exhausted');
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
    for (const item of this.entries.values()) if (item.state === 'live' && item.threads.length === 0 && now - item.created > MAX_AGE) {
      item.state = 'deleting'; try { this.save(); } catch (error) { item.state = 'live'; throw error; }
    }
    for (const item of [...this.entries.values()]) if (item.state === 'deleting') this.finishDelete(item);
    const names = new Set([...this.entries.values()].map(entry => this.dataName(entry)));
    for (const [name, stat] of files) if (!names.has(name) && (UUID.test(name.replace(/\.(wav|mp3|m4a|webm|ogg)$/, '')) || /^index-[0-9a-f-]{36}\.tmp$/.test(name)) && now - Number(stat.mtimeMs) > MAX_AGE) {
      const file = this.file(name); let current: BigIntStats; try { current = lstatSync(file, { bigint: true }); } catch (error) { if (absent(error)) continue; throw error; }
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || !sameContents(identity(stat), identity(current))) throw fault('Attachment orphan changed during collection');
      try { unlinkSync(file); } catch { /* Still present, so the next scan and every admission continue charging it. */ }
    }
    this.syncDirectory(); this.usage();
  }
}
