import { expect, test, vi } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, unlinkSync, renameSync, linkSync, symlinkSync, utimesSync, truncateSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Attachments } from '../../src/runtime/attachments.js';
import { LIMITS, object } from '../../src/runtime/types.js';
import { attachmentMediaType } from '../../src/core/attachment-media.js';

const parent = path.resolve('.work/attachment-tests'); mkdirSync(parent, { recursive: true });
function setup() { const home = mkdtempSync(path.join(parent, 'run-')); const storage = new Attachments(home); const dir = path.join(home, 'attachments'); return { home, storage, dir }; }
const upload = (storage: Attachments, text = 'file data') => object(storage.upload({ name: 'a.txt', mimeType: 'text/plain', base64: Buffer.from(text).toString('base64') }, 'client')).attachmentId as string;

test('confirmed deletion releases only its own references and copied attachments survive restart', () => {
  const { storage, home, dir } = setup(), first = upload(storage), second = upload(storage, 'second');
  const prepared = storage.prepare([first, second], 'source'); prepared.pin(); prepared.settle(true);
  const copy = storage.reserveCopy('source'); storage.finishCopy(copy, 'partial-fork', [path.join(dir, first)]);
  expect(() => storage.readHistory({ threadId: 'partial-fork', path: path.join(dir, second) })).toThrow('retained attachment');
  storage.releaseThread('source'); expect(existsSync(path.join(dir, second))).toBe(false);
  const restored = new Attachments(home); expect(restored.readHistory({ threadId: 'partial-fork', path: path.join(dir, first) })).toMatchObject({ attachmentId: first });
  restored.releaseThread('partial-fork'); expect(existsSync(path.join(dir, first))).toBe(false); expect(() => upload(restored)).not.toThrow();
});
test('unknown copy persists a byte reservation until complete startup reconciliation proves target references', () => {
  const { storage, home, dir } = setup(), id = upload(storage), filename = path.join(dir, id);
  const prepared = storage.prepare([id], 'source'); prepared.pin(); prepared.settle(true); storage.reserveCopy('source'); storage.releaseThread('source');
  let restored = new Attachments(home); restored.gc(Date.now() + 1); expect(existsSync(filename)).toBe(true);
  restored.reconcile({ threadIds: ['target', 'compressed'], references: [{ threadId: 'target', paths: [filename] }], unresolvedThreadIds: ['compressed'] });
  restored.releaseThread('target'); expect(existsSync(filename)).toBe(true);
  restored = new Attachments(home); restored.reconcile({ threadIds: ['target'], references: [{ threadId: 'target', paths: [filename] }], unresolvedThreadIds: [] });
  expect(restored.readHistory({ threadId: 'target', path: filename })).toMatchObject({ attachmentId: id }); restored.releaseThread('target'); expect(existsSync(filename)).toBe(false);
});
test('incomplete startup inventory preserves legacy copy candidates until all histories are verified', () => {
  const { storage, home, dir } = setup(), orphan = upload(storage), retained = upload(storage), fresh = upload(storage);
  for (const [id, thread] of [[orphan, 'deleted'], [retained, 'compressed']] as const) { const prepared = storage.prepare([id], thread); prepared.pin(); prepared.settle(true); }
  const legacyIndex = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'));
  legacyIndex.version = 2; delete legacyIndex.legacyOwners; writeFileSync(path.join(dir, 'index.json'), JSON.stringify(legacyIndex));
  const restored = new Attachments(home); restored.reconcile({ threadIds: ['compressed'], references: [], unresolvedThreadIds: ['compressed'] });
  expect(existsSync(path.join(dir, orphan))).toBe(true); restored.releaseThread('deleted'); restored.gc(Date.now() + 1); expect(existsSync(path.join(dir, orphan))).toBe(true); expect(existsSync(path.join(dir, fresh))).toBe(true); expect(restored.readHistory({ threadId: 'compressed', path: path.join(dir, retained) })).toMatchObject({ attachmentId: retained });
  const again = new Attachments(home); again.reconcile({ threadIds: ['compressed'], references: [{ threadId: 'compressed', paths: [path.join(dir, retained)] }], unresolvedThreadIds: [] });
  expect(existsSync(path.join(dir, orphan))).toBe(false); expect(existsSync(path.join(dir, retained))).toBe(true);
});

test('v3 named and new uploads collect independently while an unrelated rollout stays unreadable across cold starts', () => {
  const { storage, home, dir } = setup(), used = upload(storage, 'used'), canceled = upload(storage, 'cancelled'), uncertain = upload(storage, 'unreadable');
  for (const [id, scope] of [[used, 'known'], [canceled, 'known'], [uncertain, 'bad']] as const) {
    const pin = storage.prepare([id], scope); pin.pin(); pin.settle(true);
  }
  const index = path.join(dir, 'index.json'), v3 = JSON.parse(readFileSync(index, 'utf8'));
  writeFileSync(index, JSON.stringify({ version: 3, entries: v3.entries, copies: [] }));
  const proof = { threadIds: ['known', 'bad'], unresolvedThreadIds: ['bad'], references: [{ threadId: 'known', paths: [path.join(dir, used)] }] };
  const upgrade = new Attachments(home); upgrade.protectUnverifiedReferences(); upgrade.reconcile(proof);
  expect(existsSync(path.join(dir, canceled))).toBe(false);
  expect(upgrade.readHistory({ threadId: 'bad', path: path.join(dir, uncertain) })).toMatchObject({ attachmentId: uncertain });
  const recent = upload(upgrade), pin = upgrade.prepare([recent], 'known'); pin.pin(); pin.settle(true);
  const second = new Attachments(home); second.protectUnverifiedReferences(); second.reconcile(proof);
  expect(existsSync(path.join(dir, recent))).toBe(false); expect(existsSync(path.join(dir, uncertain))).toBe(true);
  expect(existsSync(path.join(dir, used))).toBe(true);
});

test('legacy untracked and reservation-protected copies keep only the original unreadable cohort, even after failed reads and restarts', () => {
  const { storage, home, dir } = setup();
  const old = upload(storage), fresh = upload(storage), source = upload(storage);
  for (const [id, scope] of [[old, 'gone'], [source, 'source']] as const) {
    const held = storage.prepare([id], scope); held.pin(); held.settle(true);
  }
  const index = path.join(dir, 'index.json'), v2 = JSON.parse(readFileSync(index, 'utf8'));
  writeFileSync(index, JSON.stringify({ version: 2, entries: v2.entries }));
  const first = new Attachments(home);
  const held = first.prepare([fresh], 'source'); held.pin(); held.settle(true);
  expect(first.reserveCopy('source')).toBeTruthy();
  const proof = (unknown: string[]) => ({ threadIds: ['source', ...unknown], unresolvedThreadIds: unknown, references: [{ threadId: 'source', paths: [path.join(dir, source)] }] });
  first.reconcile(proof(['still-unreadable']));
  expect(existsSync(path.join(dir, old))).toBe(true);
  expect(existsSync(path.join(dir, fresh))).toBe(true);
  const cold = new Attachments(home); cold.protectUnverifiedReferences(); cold.reconcile(proof(['still-unreadable', 'later']));
  expect(existsSync(path.join(dir, old))).toBe(true);
  const last = new Attachments(home); last.reconcile(proof(['later']));
  expect(existsSync(path.join(dir, old))).toBe(false); expect(existsSync(path.join(dir, fresh))).toBe(false);
  expect(last.readHistory({ threadId: 'source', path: path.join(dir, source) })).toMatchObject({ attachmentId: source });
  expect(JSON.parse(readFileSync(index, 'utf8')).copies).toEqual([]);
});

test('audio uses a fixed native-recognized suffix while opaque IDs, identity checks and retained history survive restart', () => {
  const { storage, home, dir } = setup(); const audio = object(storage.upload({ name: '../chosen.wav', mimeType: 'audio/wav', base64: 'YQ==' }, 'client'));
  const prepared = storage.prepare([audio.attachmentId!], 'thread'), native = object(prepared.input[0]); expect(native).toEqual({ type: 'localAudio', path: path.join(dir, `${audio.attachmentId}.wav`) });
  expect(fs.readdirSync(dir).sort()).toEqual([`${audio.attachmentId}.wav`, 'index.json'].sort()); expect(audio).not.toHaveProperty('fileName'); prepared.pin(); prepared.settle(true);
  const restored = new Attachments(home); expect(restored.describeInput(prepared.input, 'thread')).toMatchObject({ attachmentIds: [audio.attachmentId], hasOpaqueInput: false, attachments: [audio] });
  expect(restored.readHistory({ threadId: 'thread', path: native.path! })).toMatchObject({ attachmentId: audio.attachmentId, base64: 'YQ==' });
  expect(() => restored.readHistory({ threadId: 'other', path: native.path! })).toThrow('retained attachment');
});
test('unsupported audio is refused and new audio rollback removes its exact suffixed storage', () => {
  const { storage, dir } = setup(); expect(() => storage.upload({ name: 'record.flac', mimeType: 'audio/flac', base64: 'YQ==' }, 'client')).toThrow('Use wav, mp3'); expect(fs.readdirSync(dir)).toEqual([]);
  const uploaded = object(storage.upload({ name: 'record.MP3', base64: 'YQ==' }, 'client')); expect(uploaded.mimeType).toBe('audio/mpeg');
  const prepared = storage.prepare([uploaded.attachmentId!], 'thread'); prepared.pin(); prepared.settle(false); storage.remove({ attachmentId: uploaded.attachmentId! }); expect(fs.readdirSync(dir)).toEqual(['index.json']);
});
test('legacy extensionless audio remains readable but must be reuploaded before native audio transmission', () => {
  const { storage, home, dir } = setup(); const attachmentId = upload(storage); const file = path.join(dir, 'index.json'), data = JSON.parse(readFileSync(file, 'utf8')); data.entries[0].mimeType = 'audio/wav'; writeFileSync(file, JSON.stringify(data));
  const legacy = new Attachments(home); expect(legacy.read({ attachmentId })).toMatchObject({ mimeType: 'audio/wav' }); expect(() => legacy.prepare([attachmentId], 'thread')).toThrow('Upload this older audio');
  data.entries[0].fileName = '../escape.wav'; writeFileSync(file, JSON.stringify(data)); expect(() => new Attachments(home)).toThrow('data filename');
});

test.each([
  ['image/jpeg', 'jpeg'], ['video/mp4', 'm4v'], ['video/x-msvideo', 'avi'], ['video/x-ms-wmv', 'wmv'],
])('a historical %s index reopens its exact suffixed file and keeps thread ownership', (mimeType, suffix) => {
  const { storage, home, dir } = setup(), id = upload(storage);
  const index = path.join(dir, 'index.json'), record = JSON.parse(readFileSync(index, 'utf8'));
  const name = id + '.' + suffix;
  renameSync(path.join(dir, id), path.join(dir, name));
  Object.assign(record.entries[0], { fileName: name, mimeType, threads: ['owner'] });
  writeFileSync(index, JSON.stringify(record));
  const restored = new Attachments(home);
  expect(restored.read({ attachmentId: id })).toMatchObject({ mimeType, base64: Buffer.from('file data').toString('base64') });
  expect(() => restored.remove({ attachmentId: id })).toThrow('retained by thread history');
  record.entries[0].fileName = id + '.exe';
  writeFileSync(index, JSON.stringify(record));
  expect(() => new Attachments(home)).toThrow('data filename');
});

test('history media reads only exact indexed paths retained by the requested thread', () => {
  const { storage, dir } = setup(), id = upload(storage), filename = path.join(dir, id);
  expect(() => storage.readHistory({ path: filename, threadId: 'thread' })).toThrow('not a retained attachment');
  const prepared = storage.prepare([id], 'thread'); prepared.pin(); prepared.settle(true);
  expect(storage.readHistory({ path: filename, threadId: 'thread' })).toMatchObject({ attachmentId: id, base64: Buffer.from('file data').toString('base64') });
  for (const params of [{ path: filename, threadId: 'other' }, { path: path.join(dir, '..', id), threadId: 'thread' }, { path: path.join(dir, 'index.json'), threadId: 'thread' }]) expect(() => storage.readHistory(params)).toThrow('not a retained attachment');
});

test('uploads and restores the complete 4 MiB boundary with every Base64 padding length', () => {
  const { home, storage } = setup();
  for (const size of [LIMITS.attachmentBytes - 2, LIMITS.attachmentBytes - 1, LIMITS.attachmentBytes]) {
    const base64 = Buffer.alloc(size, 97).toString('base64');
    const item = object(storage.upload({ name: `size-${size}.bin`, base64 }, 'client'));
    expect(item.size).toBe(size); expect(object(new Attachments(home).read({ attachmentId: item.attachmentId! })).base64).toBe(base64);
  }
});

test('malformed, noncanonical and oversized Base64 never writes an attachment', () => {
  const { storage, dir } = setup();
  for (const base64 of ['YQ', 'Y Q==', 'YQ===', 'YR==', 'YQ==\n', '-w==', 'AA=A', 'A'.repeat(4 * 1024 * 1024) + '!===']) {
    expect(() => storage.upload({ name: 'invalid.bin', base64 }, 'client')).toThrow('Invalid base64');
    expect(fs.readdirSync(dir)).toEqual([]);
  }
  expect(() => storage.upload({ name: 'large.bin', base64: Buffer.alloc(LIMITS.attachmentBytes + 1).toString('base64') }, 'client')).toThrow('capacity');
  expect(fs.readdirSync(dir)).toEqual([]);
  expect(object(storage.upload({ name: 'empty.bin', base64: '' }, 'client')).size).toBe(0);
});

test('restart preserves file identity, digest and thread pins', () => {
  const { home, storage } = setup(); const attachmentId = upload(storage); storage.prepare([attachmentId], 'thread').pin(); const restored = new Attachments(home);
  expect(object(restored.read({ attachmentId, threadId: 'thread' })).base64).toBe(Buffer.from('file data').toString('base64'));
  expect(() => restored.remove({ attachmentId })).toThrow('retained');
});

test('rejected reservations release only their own uncommitted thread references', () => {
  const { home, storage } = setup(); const attachmentId = upload(storage);
  const first = storage.prepare([attachmentId], 'same'), second = storage.prepare([attachmentId], 'same');
  first.pin(); second.pin(); first.settle(false);
  expect(() => storage.remove({ attachmentId })).toThrow('retained');
  second.settle(false); expect(JSON.parse(readFileSync(path.join(home, 'attachments/index.json'), 'utf8')).entries[0].threads).toEqual([]);
  const rejected = storage.prepare([attachmentId], 'rejected'), accepted = storage.prepare([attachmentId], 'accepted');
  rejected.pin(); accepted.pin(); accepted.settle(true); rejected.settle(false);
  const priorReference = storage.prepare([attachmentId], 'accepted'); priorReference.pin(); priorReference.settle(false);
  expect(JSON.parse(readFileSync(path.join(home, 'attachments/index.json'), 'utf8')).entries[0].threads).toEqual(['accepted']);
  expect(() => new Attachments(home).remove({ attachmentId })).toThrow('retained');
});

test('an overlapping accepted or unknown reservation prevents another rejection from unpinning it', () => {
  const { home, storage } = setup(); const attachmentId = upload(storage);
  const rejected = storage.prepare([attachmentId], 'same'), uncertain = storage.prepare([attachmentId], 'same');
  rejected.pin(); uncertain.pin(); uncertain.settle(true); rejected.settle(false);
  expect(() => new Attachments(home).remove({ attachmentId })).toThrow('retained');
});

test('replaced regular files, hard links, modified bytes and oversized content are rejected before exposing content', () => {
  for (const mutation of ['replace', 'hardlink', 'inplace', 'oversize']) {
    const { home, storage, dir } = setup(); const attachmentId = upload(storage); const file = path.join(dir, attachmentId);
    if (mutation === 'replace') { renameSync(file, path.join(dir, 'saved')); writeFileSync(file, 'file data'); }
    else if (mutation === 'hardlink') linkSync(file, path.join(dir, 'alias'));
    else if (mutation === 'inplace') { const modified = fs.statSync(file).mtime; writeFileSync(file, 'evil data'); utimesSync(file, modified, modified); }
    else truncateSync(file, LIMITS.attachmentBytes + 1);
    expect(() => storage.read({ attachmentId })).toThrow(); expect(() => storage.prepare([attachmentId], 't')).toThrow(); expect(() => new Attachments(home)).toThrow();
  }
});

test('a pathname swapped after lstat is rejected by opened file identity', () => {
  const { storage, dir } = setup(); const attachmentId = upload(storage); const file = path.join(dir, attachmentId); const saved = path.join(dir, 'saved');
  const original = fs.openSync; let swapped = false;
  const spy = vi.spyOn(fs, 'openSync').mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === file && !swapped) { swapped = true; renameSync(file, saved); writeFileSync(file, 'file data'); }
    return original(...args);
  }) as typeof fs.openSync);
  syncBuiltinESMExports();
  try { expect(() => storage.read({ attachmentId })).toThrow('changed'); expect(swapped).toBe(true); } finally { spy.mockRestore(); syncBuiltinESMExports(); }
});

test('read growth is bounded and a replaced directory is rejected', () => {
  const { storage, dir } = setup(); const attachmentId = upload(storage); const file = path.join(dir, attachmentId); const original = fs.readSync; let changed = false;
  const spy = vi.spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    if (!changed) { changed = true; truncateSync(file, LIMITS.attachmentBytes * 2); }
    return original(...args);
  }) as typeof fs.readSync);
  syncBuiltinESMExports();
  try { expect(() => storage.read({ attachmentId })).toThrow('grew'); } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  renameSync(dir, `${dir}-saved`); mkdirSync(dir); expect(() => storage.read({ attachmentId })).toThrow('directory was replaced');
});

test('orphans and pending files consume physical byte and count quotas across restart', () => {
  const { home, storage, dir } = setup(); const orphan = path.join(dir, randomUUID()); writeFileSync(orphan, ''); truncateSync(orphan, LIMITS.attachmentTotal);
  expect(() => upload(storage)).toThrow('capacity'); const restored = new Attachments(home); expect(() => upload(restored)).toThrow('capacity');
  unlinkSync(orphan); for (let i = 0; i < LIMITS.attachments; i++) writeFileSync(path.join(dir, randomUUID()), '');
  expect(() => upload(restored)).toThrow('capacity'); expect(() => upload(new Attachments(home))).toThrow('capacity');
});

test('directory iteration fails at a fixed entry budget without materializing an unbounded listing', () => {
  const { storage, dir } = setup(); for (let i = 0; i < LIMITS.attachments + 33; i++) writeFileSync(path.join(dir, String(i)), '');
  expect(() => storage.gc()).toThrow('directory entry budget');
});

test.skipIf(process.platform === 'win32')('symlink and FIFO substitutions never follow or block', () => {
  for (const mutation of ['symlink', 'fifo']) {
    const { storage, dir } = setup(); const attachmentId = upload(storage); const file = path.join(dir, attachmentId); unlinkSync(file);
    if (mutation === 'symlink') { const target = path.join(dir, 'secret'); writeFileSync(target, 'secret'); symlinkSync(target, file); }
    else execFileSync('mkfifo', [file]);
    expect(() => storage.read({ attachmentId })).toThrow('Unsafe');
  }
});

test.skipIf(process.platform === 'win32')('read-only native data group never gains metadata or directory write access', () => {
  const home = mkdtempSync(path.join(parent, 'shared-')); const gid = process.getgid!(); const storage = new Attachments(home, gid); const attachmentId = upload(storage); const dir = path.join(home, 'attachments');
  expect(fs.statSync(dir).mode & 0o7777).toBe(0o2750); expect(fs.statSync(path.join(dir, attachmentId)).gid).toBe(gid);
  expect(fs.statSync(path.join(dir, attachmentId)).mode & 0o777).toBe(0o640); expect(fs.statSync(path.join(dir, 'index.json')).mode & 0o777).toBe(0o600);
});

test.skipIf(process.platform !== 'win32')('real OS unlink denial leaves a durable tombstone and quota charge until restart can delete', async () => {
  const { home, storage, dir } = setup(); const attachmentId = upload(storage); const file = path.join(dir, attachmentId);
  const script = `$stream = [IO.File]::Open('${file.replaceAll("'", "''")}', [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite); try { [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null } finally { $stream.Dispose() }`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); const exited = once(child, 'close');
  try {
    await Promise.race([once(child.stdout, 'data'), new Promise((_, reject) => setTimeout(() => reject(new Error('File lock did not start')), 5000).unref())]);
    expect(() => unlinkSync(file)).toThrow(); expect(() => storage.remove({ attachmentId })).toThrow('pending'); expect(existsSync(file)).toBe(true);
    const index = () => JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8')) as { entries: { attachmentId: string; state: string }[] };
    expect(index().entries).toMatchObject([{ attachmentId, state: 'deleting' }]); expect(() => storage.read({ attachmentId })).toThrow('not found');
    const restored = new Attachments(home); restored.gc(Date.now() + 2 * 24 * 60 * 60 * 1000); expect(index().entries).toHaveLength(1); expect(existsSync(file)).toBe(true);
    for (let i = 0; i < LIMITS.attachments - 1; i++) writeFileSync(path.join(dir, randomUUID()), '');
    expect(() => upload(restored)).toThrow('capacity');
  } finally { child.stdin.end('\n'); await exited; expect(child.exitCode).toBe(0); }
  const recovered = new Attachments(home); expect(existsSync(file)).toBe(false); expect(() => upload(recovered)).not.toThrow();
}, 15000);

test.each([['mp4', 'video/mp4'], ['mov', 'video/quicktime']])('video container bytes override empty or incorrect browser audio types for %s', (extension, mimeType) => {
  const { storage, dir } = setup();
  const bytes = readFileSync(path.join('tests/fixtures/visual-media', 'sample.' + extension));
  for (const declared of ['', 'audio/quicktime', 'audio/mp4']) {
    const uploaded = object(storage.upload({ name: '无扩展名', mimeType: declared, base64: bytes.toString('base64') }, 'user'));
    expect(uploaded.mimeType).toBe(mimeType);
    expect(readFileSync(path.join(dir, uploaded.attachmentId + '.' + extension))).toEqual(bytes);
  }
});

test('a classic unbranded QuickTime file uses the track handler to distinguish video, audio and unidentified bytes', () => {
  const movie = readFileSync('tests/fixtures/visual-media/sample-classic.mov');
  expect(movie.includes('ftyp')).toBe(false);
  const offset = movie.indexOf('mhlrvide');
  expect(offset).toBeGreaterThan(0);
  expect(attachmentMediaType(movie, '')).toBe('video/quicktime');
  expect(attachmentMediaType(movie, 'video/mp4')).toBe('video/quicktime');
  const sound = Buffer.from(movie);
  sound.write('soun', offset + 4);
  expect(attachmentMediaType(sound, '')).toBe('audio/quicktime');
  const unknown = Buffer.from(movie);
  unknown.fill(0, offset, offset + 4);
  expect(attachmentMediaType(unknown, '')).toBe('application/octet-stream');
});
