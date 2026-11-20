import { expect, test, vi } from 'vitest';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Attachments } from '../../src/runtime/attachments.js';
import { handoffFile, handoffLimit } from '../../src/runtime/queue-handoff-store.js';
import { LIMITS, type JsonValue } from '../../src/runtime/types.js';

const parent = path.resolve('.work/attachment-tests');
function setup() {
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(path.join(parent, 'handoff-'));
  const assets = new Attachments(home), bytes = Buffer.from([0, 1, 3, 8, 255]);
  const up = assets.upload({ name: 'evidence.bin', mimeType: 'application/octet-stream', base64: bytes.toString('base64') }, 'owner') as { attachmentId: string };
  const held = assets.prepare([up.attachmentId], 'thread');
  held.pin(); held.settle(true);
  const file = path.join(assets.root, up.attachmentId);
  const input: JsonValue[] = [{ type: 'text', text: 'Edited?', text_elements: [] }, ...held.input,
    { type: 'text', text: '不可编辑引用', text_elements: [{ byteRange: { start: 0, end: 18 }, placeholder: 'reference' }] },
    { type: 'text', text: '附加上下文\nLine two', text_elements: [{ byteRange: { start: 0, end: 12 }, placeholder: 'extra' }] },
    { type: 'mention', name: '原生实体', path: 'plugin://fixture' }];
  return { home, assets, input, id: up.attachmentId, file, bytes };
}
const noNativeReferences = { threadIds: ['thread'], unresolvedThreadIds: [], references: [] };

test('raw native references, context and attachment bytes survive queue removal, restart and a single confirmed restore', () => {
  const f = setup();
  try {
    const { id } = f.assets.saveQueueHandoff('thread', 'q', f.input) as { id: string };
    expect(f.assets.saveQueueHandoff('thread', 'q', f.input).id).toBe(id);
    expect(f.assets.listQueueHandoffs('thread')).toEqual([{ id, state: 'saved', queuedSubmissionId: 'q', attachmentCount: 1 }]);
    expect(JSON.stringify(f.assets.listQueueHandoffs('thread'))).not.toContain('不可编辑引用');
    expect(() => f.assets.queueHandoffInput('thread', id)).toThrow();
    expect(f.assets.queueHandoffMatches('thread', 'q', f.input)).toBe(true);
    const edited = [f.input[0]!, ...f.input.slice(2)];
    expect(f.assets.queueHandoffMatches('thread', 'q', edited)).toBe(false);
    f.assets.markQueueHandoffRemoved('thread', 'q', edited);
    expect(() => f.assets.queueHandoffInput('thread', id)).toThrow();
    f.assets.markQueueHandoffRemoved('thread', 'q', f.input);
    f.assets.markQueueHandoffRemoved('thread', 'q', f.input);
    const restarted = new Attachments(f.home);
    restarted.reconcile(noNativeReferences); restarted.gc(Date.now() + 172_800_000);
    expect(readFileSync(f.file)).toEqual(f.bytes);
    expect(() => restarted.remove({ attachmentId: f.id })).toThrow();
    expect(restarted.queueHandoffInput('thread', id)).toEqual(f.input);
    const copy = restarted.queueHandoffInput('thread', id); copy.length = 0;
    expect(restarted.queueHandoffInput('thread', id)).toEqual(f.input);
    const sending = randomUUID(); restarted.beginQueueHandoffRestore('thread', id, sending);
    const again = new Attachments(f.home);
    for (const attempted of [sending, randomUUID()]) expect(() => again.beginQueueHandoffRestore('thread', id, attempted)).toThrow();
    expect(() => again.discardQueueHandoff('thread', id)).toThrow();
    expect(() => again.settleQueueHandoffRestore('thread', id, randomUUID(), 'accepted')).toThrow();
    again.settleQueueHandoffRestore('thread', id, sending, 'not_sent');
    again.settleQueueHandoffRestore('thread', id, sending, 'not_sent');
    expect(() => again.beginQueueHandoffRestore('thread', id, sending)).toThrow();
    const next = randomUUID(); again.beginQueueHandoffRestore('thread', id, next);
    again.settleQueueHandoffRestore('thread', id, next, 'accepted');
    again.settleQueueHandoffRestore('thread', id, next, 'accepted');
    expect(again.listQueueHandoffs('thread')[0]).toMatchObject({ state: 'restored', operationId: next });
    expect(existsSync(path.join(again.root, handoffFile(id)))).toBe(false);
    const committed = new Attachments(f.home); committed.discardQueueHandoff('thread', id);
    expect(readFileSync(f.file)).toEqual(f.bytes);
    committed.reconcile(noNativeReferences); expect(existsSync(f.file)).toBe(false);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('a queue disappearance never substitutes for proven deletion and explicit discard releases exactly the last guard', () => {
  const f = setup();
  try {
    const first = f.assets.saveQueueHandoff('thread', 'q1', f.input).id as string;
    const second = f.assets.saveQueueHandoff('thread', 'q2', f.input).id as string;
    const restarted = new Attachments(f.home); restarted.reconcile(noNativeReferences);
    expect(() => restarted.queueHandoffInput('thread', first)).toThrow();
    expect(restarted.listQueueHandoffs('foreign')).toEqual([]);
    expect(restarted.queueHandoffMatches('foreign', 'q1', f.input)).toBe(false);
    expect(() => restarted.saveQueueHandoff('foreign', 'q1', f.input)).toThrow('未绑定');
    expect(() => restarted.discardQueueHandoff('foreign', first)).toThrow();
    restarted.discardQueueHandoff('thread', first); restarted.discardQueueHandoff('thread', first);
    expect(readFileSync(f.file)).toEqual(f.bytes);
    restarted.markQueueHandoffRemoved('foreign', 'q2', f.input);
    expect(() => restarted.queueHandoffInput('thread', second)).toThrow();
    restarted.discardQueueHandoff('thread', second);
    expect(existsSync(f.file)).toBe(false); expect(restarted.listQueueHandoffs('thread')).toEqual([]);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('rejects damaged or nonprivate raw queue data and caps the work while keeping the original queue payload untouched', () => {
  const f = setup();
  try {
    expect(() => f.assets.saveQueueHandoff('thread', 'too-large', [{ type: 'text', text: 'x'.repeat(LIMITS.attachmentBytes) }])).toThrow();
    const first = f.assets.saveQueueHandoff('thread', 'q0', f.input).id as string;
    for (let i = 1; i < handoffLimit; i++) f.assets.saveQueueHandoff('thread', 'q' + i, f.input);
    expect(() => f.assets.saveQueueHandoff('thread', 'overflow', f.input)).toThrow('容量');
    const location = path.join(f.assets.root, handoffFile(first));
    if (process.platform !== 'win32') {
      chmodSync(location, 0o644); expect(() => new Attachments(f.home)).toThrow('权限或摘要'); chmodSync(location, 0o600);
    }
    writeFileSync(location, '[]'); expect(() => new Attachments(f.home)).toThrow('权限或摘要');
    expect(readFileSync(f.file)).toEqual(f.bytes);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('only explicitly selected ready backups transfer atomically to the confirmed destination and remain there after restart', () => {
  const f = setup();
  try {
    const selected = f.assets.saveQueueHandoff('thread', 'move', f.input).id as string;
    const retained = f.assets.saveQueueHandoff('thread', 'stay', f.input).id as string;
    f.assets.markQueueHandoffRemoved('thread', 'move', f.input);
    expect(() => f.assets.moveReadyQueueHandoffs('thread', 'new', [selected, retained])).toThrow('所选副本');
    expect(f.assets.listQueueHandoffs('new')).toEqual([]);
    f.assets.moveReadyQueueHandoffs('thread', 'new', [selected]);
    const reopened = new Attachments(f.home);
    reopened.moveReadyQueueHandoffs('thread', 'new', [selected]);
    expect(reopened.listQueueHandoffs('thread').map(row => row.id)).toEqual([retained]);
    expect(() => reopened.queueHandoffInput('thread', selected)).toThrow();
    expect(() => reopened.moveReadyQueueHandoffs('wrong', 'new', [selected])).toThrow();
    reopened.releaseThread('thread');
    reopened.reconcile({ threadIds: ['new'], unresolvedThreadIds: [], references: [] });
    expect(reopened.listQueueHandoffs('thread')).toEqual([]);
    expect(reopened.queueHandoffInput('new', selected)).toEqual(f.input);
    expect(readFileSync(f.file)).toEqual(f.bytes);
    reopened.discardQueueHandoff('new', selected);
    expect(existsSync(f.file)).toBe(false);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('continues an interrupted published discard after either raw-file removal point and preserves other drafts', () => {
  for (const rawGone of [false, true]) {
    const f = setup();
    try {
      const discard = f.assets.saveQueueHandoff('thread', 'discard', f.input).id as string;
      const keep = f.assets.saveQueueHandoff('thread', 'keep', [{ type: 'text', text: 'other' }]).id as string;
      f.assets.reconcile(noNativeReferences);
      const indexPath = path.join(f.assets.root, 'index.json'), evidence = JSON.parse(readFileSync(indexPath, 'utf8'));
      const tombstone = evidence.queueHandoffs.find((row: { id: string }) => row.id === discard); tombstone.discarding = true;
      writeFileSync(indexPath, JSON.stringify(evidence));
      if (rawGone) rmSync(path.join(f.assets.root, handoffFile(discard)));
      const resumed = new Attachments(f.home);
      expect(resumed.listQueueHandoffs('thread').map(row => row.id)).toEqual([keep]);
      expect(existsSync(f.file)).toBe(false);
      expect(existsSync(path.join(resumed.root, handoffFile(discard)))).toBe(false);
      expect(existsSync(path.join(resumed.root, handoffFile(keep)))).toBe(true);
    } finally { rmSync(f.home, { recursive: true, force: true }); }
  }
});

test('reserves the destination reference slot before native dispatch and across restart until the original receipt settles', () => {
  const f = setup();
  try {
    const id = f.assets.saveQueueHandoff('thread', 'queued', f.input).id as string;
    f.assets.markQueueHandoffRemoved('thread', 'queued', f.input);
    const index = path.join(f.assets.root, 'index.json'), data = JSON.parse(readFileSync(index, 'utf8'));
    data.entries[0].threads = Array.from({ length: 256 }, (_, i) => 'existing-' + i);
    writeFileSync(index, JSON.stringify(data));
    const full = new Attachments(f.home);
    expect(() => full.beginQueueHandoffRestore('thread', id, randomUUID())).toThrow('引用已满');
    expect(full.listQueueHandoffs('thread')[0]?.state).toBe('ready');
    data.entries[0].threads.pop(); writeFileSync(index, JSON.stringify(data));
    const lastSlot = new Attachments(f.home), op = randomUUID();
    lastSlot.beginQueueHandoffRestore('thread', id, op);
    const reopened = new Attachments(f.home);
    expect(() => reopened.prepare([f.id], 'different').pin()).toThrow('capacity');
    reopened.settleQueueHandoffRestore('thread', id, op, 'accepted');
    expect(reopened.readHistory({ threadId: 'thread', path: f.file })).toMatchObject({ base64: f.bytes.toString('base64') });
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test.skipIf(process.platform === 'win32')('a retry cannot authorize native work after a published index until its directory sync succeeds', () => {
  const f = setup();
  try {
    const id = f.assets.saveQueueHandoff('thread', 'q', f.input).id as string;
    const original = fs.fsyncSync.bind(fs); let fail = true, attempts = 0;
    const sync = vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory()) {
        attempts++;
        if (fail) throw new Error('fixture directory sync');
      }
      original(fd);
    });
    syncBuiltinESMExports();
    try {
      expect(() => f.assets.markQueueHandoffRemoved('thread', 'q', f.input)).toThrow('fixture directory sync');
      expect(() => f.assets.queueHandoffInput('thread', id)).toThrow('fixture directory sync');
      expect(() => f.assets.beginQueueHandoffRestore('thread', id, randomUUID())).toThrow('fixture directory sync');
      fail = false;
      expect(f.assets.queueHandoffInput('thread', id)).toEqual(f.input); expect(attempts).toBe(4);
      expect(new Attachments(f.home).queueHandoffInput('thread', id)).toEqual(f.input);
    } finally { sync.mockRestore(); syncBuiltinESMExports(); }
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('deduplicates full-size canonical inline images without changing raw native input or authorizing a different thread', () => {
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(path.join(parent, 'full-inline-'));
  try {
    const assets = new Attachments(home), bytes = Buffer.alloc(LIMITS.attachmentBytes);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
    const base64 = bytes.toString('base64'), digest = createHash('sha256').update(bytes).digest('hex');
    const input = [{ type: 'image', url: 'data:image/png;base64,' + base64, detail: null }];
    const upload = (threadId: string) => {
      const image = assets.upload({ name: 'one.png', mimeType: 'image/png', base64 }, 'owner') as { attachmentId: string };
      const reservation = assets.prepare([image.attachmentId], threadId); reservation.pin(); reservation.settle(true); return image.attachmentId;
    };
    const a = upload('A'), duplicate = upload('A'), b = upload('B');
    expect(assets.resolveQueuedNativeImage('A', input[0]!)).toBeUndefined();
    expect(assets.resolveQueuedNativeImage('foreign', input[0]!)).toBeUndefined();
    const witness = { type: 'harnessInlineImageDigest', mimeType: 'image/png', bytes: bytes.length, sha256: digest };
    expect(assets.resolveQueuedImageDigest('A', witness)).toBeUndefined();
    for (const invalid of [{ ...witness, bytes: bytes.length - 1 }, { ...witness, mimeType: 'image/jpeg' }, { ...witness, sha256: 'a'.repeat(64) }])
      expect(assets.resolveQueuedImageDigest('A', invalid)).toBeUndefined();
    expect(assets.resolveQueuedImageDigest('foreign', witness)).toBeUndefined();
    expect(assets.activeImageDigests).toBe(Buffer.from(digest, 'hex').toString('base64'));
    const saved = assets.saveQueueHandoff('A', 'q', input);
    expect(saved).toMatchObject({ attachmentCount: 1, nativeSavedImages: 1, sourceCandidateCount: 2 });
    expect(readFileSync(path.join(assets.root, handoffFile(String(saved.id)))).length).toBeLessThan(1024);
    const proof = { mimeType: 'image/png', sha256: digest };
    assets.reconcile({ threadIds: ['A', 'foreign'], unresolvedThreadIds: [], references: [
      { threadId: 'A', paths: [], images: [proof] }, { threadId: 'foreign', paths: [], images: [proof] }] });
    for (const id of [a, duplicate]) expect(assets.readHistory({ threadId: 'A', path: path.join(assets.root, id + '.png') })).toMatchObject({ attachmentId: id });
    expect(() => assets.readHistory({ threadId: 'foreign', path: path.join(assets.root, a + '.png') })).toThrow();
    expect(existsSync(path.join(assets.root, b + '.png'))).toBe(false);
    assets.markQueueHandoffRemoved('A', 'q', input);
    expect(new Attachments(home).queueHandoffInput('A', String(saved.id))).toEqual(input);
    const sourceFiles = assets.queueHandoffCandidates('A', String(saved.id)) as { data: { attachmentId: string }[] };
    expect(sourceFiles.data.map(row => row.attachmentId)).toEqual([a, duplicate]);
    expect((assets.queueHandoffCandidates('A', String(saved.id), duplicate) as { base64: string }).base64 === base64).toBe(true);
    expect(() => assets.queueHandoffCandidates('A', String(saved.id), b)).toThrow('不属于');
    expect(() => assets.queueHandoffCandidates('foreign', String(saved.id), a)).toThrow('源会话');
    assets.moveReadyQueueHandoffs('A', 'target', [String(saved.id)]);
    assets.moveReadyQueueHandoffs('target', 'second-target', [String(saved.id)]);
    const transferred = new Attachments(home);
    expect(transferred.listQueueHandoffs('second-target')[0]?.sourceCandidateCount).toBe(0);
    expect(transferred.movedQueueHandoffSources('A')).toEqual([{ id: saved.id, queuedSubmissionId: 'q', count: 2 }]);
    expect(transferred.movedQueueHandoffSources('target')).toEqual([]);
    expect(transferred.movedQueueHandoffSources('second-target')).toEqual([]);
    expect(() => transferred.read({ attachmentId: a })).toThrow();
    expect(() => transferred.read({ threadId: 'second-target', attachmentId: a })).toThrow();
    expect(() => transferred.prepare([a], 'second-target')).toThrow();
    expect(transferred.prepare([a], 'A').input).toHaveLength(1);
    for (const thread of ['target', 'second-target']) expect(() => transferred.queueHandoffCandidates(thread, String(saved.id), a)).toThrow('源会话');
    expect((transferred.queueHandoffCandidates('A', String(saved.id), duplicate) as { base64: string }).base64 === base64).toBe(true);
    const copy = transferred.reserveCopy('A'); transferred.finishCopy(copy, 'fork', [], [proof]);
    expect(transferred.readHistory({ threadId: 'fork', path: path.join(assets.root, a + '.png') })).toMatchObject({ attachmentId: a });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('receipt, queue and ordinal bind byte-identical uploads separately and unknown writes retain only their own originals', () => {
  const f = setup();
  try {
    const source = Buffer.from('89504e470d0a1a0a0001', 'hex'), derivative = Buffer.from('89504e470d0a1a0a0203', 'hex');
    const inline = { type: 'image', url: 'data:image/png;base64,' + derivative.toString('base64'), detail: 'high' };
    const upload = (owner: string) => {
      const id = String((f.assets.upload({ name: 'duplicate.png', mimeType: 'image/png', base64: source.toString('base64') }, owner) as { attachmentId: string }).attachmentId);
      const held = f.assets.prepare([id], owner); held.pin(); held.settle(true); return { id, native: held.input[0]! };
    };
    const a = upload('a'), b = upload('a'), c = upload('c');
    const op = f.assets.beginQueueImageWrite('a', 'thread/queue/add', { input: [b.native, a.native], clientUserMessageId: 'correlated' });
    expect(op).toBeTruthy(); f.assets.cancelQueueImageWrite('c', op);
    expect(() => f.assets.confirmQueueImageWrite('a', op, { id: 'entry', clientUserMessageId: 'mismatch', input: [inline, inline] })).toThrow();
    const reopened = new Attachments(f.home);
    reopened.reconcile({ threadIds: ['a', 'c'], unresolvedThreadIds: [], references: [{ threadId: 'a', paths: [], unmatchedQueuedImage: true }] });
    expect(() => reopened.read({ threadId: 'a', attachmentId: c.id })).toThrow();
    reopened.confirmQueueImageWrite('a', op, { id: 'entry', clientUserMessageId: 'correlated', input: [inline, inline] });
    const digest = createHash('sha256').update(derivative).digest('hex');
    expect(Buffer.from(reopened.activeImageDigests, 'base64').toString('hex')).toContain(digest);
    const proof = { mimeType: 'image/png', sha256: digest };
    reopened.reconcile({ threadIds: ['a'], unresolvedThreadIds: [], references: [{ threadId: 'a', paths: [], images: [proof], queuedImages: [proof] }] });
    expect(reopened.resolveOriginalQueuedImage('a', 'entry', 0, inline)).toBe(b.id);
    expect(reopened.resolveOriginalQueuedImage('a', 'entry', 1, inline)).toBe(a.id);
    expect(reopened.resolveOriginalQueuedImage('a', 'different-entry', 1, inline)).toBeUndefined();
    expect(reopened.resolveOriginalQueuedImage('c', 'entry', 1, inline)).toBeUndefined();
    const input = [inline, inline], saved = reopened.saveQueueHandoff('a', 'entry', input);
    expect(saved.nativeSavedImages).toBeUndefined();
    reopened.markQueueHandoffRemoved('a', 'entry', input); reopened.retireQueueImageBindings('a', 'entry');
    const last = new Attachments(f.home);
    expect(last.queueHandoffInput('a', String(saved.id))).toEqual(input);
    expect(last.queueHandoffRestoreInput('a', String(saved.id))).toEqual([b.native, a.native].map(value => ({ ...value as object, detail: 'high' })));
    const update = last.beginQueueImageWrite('a', 'thread/queue/update', { input: [b.native], queuedSubmissionId: 'other' });
    last.cancelQueueImageWrite('a', update);
    expect(() => last.confirmQueueImageWrite('a', update, { id: 'other', clientUserMessageId: 'response', input: [inline] })).toThrow();
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('private Responses metadata is compared at removal and retained only for the original provider after cold start', () => {
  const f = setup();
  try {
    const metadata = { localFixturePolicy: 'private fixture value', scoped: 'opaque-ref' };
    const neutral = f.assets.saveQueueHandoff('thread', 'no-metadata', f.input, {}).id as string;
    const saved = f.assets.saveQueueHandoff('thread', 'with-metadata', f.input, metadata, 'provider-a');
    expect(saved).toMatchObject({ requiresSameProvider: true });
    const id = String(saved.id);
    expect(f.assets.queueHandoffMatches('thread', 'with-metadata', f.input, { ...metadata, scoped: 'changed' })).toBe(false);
    expect(f.assets.queueHandoffMatches('thread', 'with-metadata', f.input, metadata)).toBe(true);
    f.assets.markQueueHandoffRemoved('thread', 'with-metadata', f.input, null);
    expect(() => f.assets.queueHandoffMetadata('thread', id, 'provider-a')).toThrow('尚未');
    f.assets.markQueueHandoffRemoved('thread', 'with-metadata', f.input, metadata);
    f.assets.markQueueHandoffRemoved('thread', 'no-metadata', f.input);
    const cold = new Attachments(f.home);
    expect(JSON.stringify(cold.listQueueHandoffs('thread'))).not.toContain('private fixture value');
    expect(readFileSync(path.join(cold.root, 'index.json'), 'utf8')).not.toContain('private fixture value');
    expect(() => cold.queueHandoffMetadata('thread', id, 'provider-b')).toThrow('原供应商');
    expect(() => cold.moveReadyQueueHandoffs('thread', 'other', [neutral, id], 'provider-b')).toThrow('原供应商');
    expect(cold.listQueueHandoffs('other')).toEqual([]);
    expect(cold.queueHandoffMetadata('thread', neutral, 'provider-b')).toBeUndefined();
    const value = cold.queueHandoffMetadata('thread', id, 'provider-a')!;
    expect(value).toEqual(metadata); value.scoped = 'altered';
    cold.moveReadyQueueHandoffs('thread', 'related', [id], 'provider-a');
    expect(new Attachments(f.home).queueHandoffMetadata('related', id, 'provider-a')).toEqual(metadata);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('legacy candidates survive native automatic consumption until the exact native digest leaves history without granting a new owner', () => {
  const f = setup();
  try {
    const put = (owner: string, n: number) => {
      const image = Buffer.from('89504e470d0a1a0a0' + n, 'hex');
      const id = String((f.assets.upload({ name: 'old.png', mimeType: 'image/png', base64: image.toString('base64') }, owner) as { attachmentId: string }).attachmentId);
      const held = f.assets.prepare([id], owner); held.pin(); held.settle(true); return id;
    };
    const aid = put('scope', 4), foreign = put('elsewhere', 5);
    const index = path.join(f.assets.root, 'index.json'), legacy = JSON.parse(readFileSync(index, 'utf8'));
    delete legacy.queueImageBindings; delete legacy.queueHandoffs; legacy.version = 3; writeFileSync(index, JSON.stringify(legacy));
    const proof = { mimeType: 'image/png', sha256: 'f'.repeat(64) };
    const first = new Attachments(f.home);
    first.reconcile({ threadIds: ['scope','elsewhere'], unresolvedThreadIds: [], references: [{ threadId: 'scope', paths: [], unmatchedQueuedImage: true, unmatchedQueuedImages: [proof] }] });
    expect(Buffer.from(first.activeImageDigests, 'base64').toString('hex')).toContain(proof.sha256);
    const cold = new Attachments(f.home);
    cold.reconcile({ threadIds: ['scope'], unresolvedThreadIds: [], references: [{ threadId: 'scope', paths: [], images: [proof] }] });
    expect(cold.read({ threadId: 'scope', attachmentId: aid })).toMatchObject({ attachmentId: aid });
    expect(cold.resolveOriginalQueuedImage('scope', 'queue', 1, { type: 'harnessInlineImageDigest', ...proof, bytes: 19 })).toBeUndefined();
    expect(() => cold.read({ threadId:'elsewhere', attachmentId:aid })).toThrow();
    expect(existsSync(path.join(cold.root, foreign + '.png'))).toBe(false);
    cold.reconcile({ threadIds: ['scope'], unresolvedThreadIds: [], references: [] });
    expect(existsSync(path.join(cold.root, aid + '.png'))).toBe(false);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});
