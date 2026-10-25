import { afterEach, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { auditGitObjects, auditSource, scanFiles, scanStream } from '../../scripts/release-audit.mjs';

const fixtures: string[] = [];
function fixture(): string { const parent = path.resolve('.work/tooling-audit'); mkdirSync(parent, { recursive: true }); const root = mkdtempSync(path.join(parent, 'case-')); fixtures.push(root); return root; }
function put(root: string, name: string, content: string | Buffer): void { const file = path.join(root, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content); }
function git(root: string, args: string[], input?: string): string { return execFileSync('git', args, { cwd: root, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('scans ordinary source and redacts every secret/private-path diagnostic', async () => {
  const root = fixture(); const token = ['sk', ''].join('-') + 'a'.repeat(48);
  const key = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
  const privateHome = ['C:', 'Users', 'private-fixture'].join('\\');
  put(root, 'src/config.txt', ['ordinary line', token, key, privateHome, ''].join('\n'));
  const report = await scanFiles(root, ['src/config.txt']);
  expect(report.status).toBe('blocked');
  expect(report.findings).toEqual(expect.arrayContaining([
    { path: 'src/config.txt', line: 2, rule: 'api-token' },
    { path: 'src/config.txt', line: 3, rule: 'private-key' },
    { path: 'src/config.txt', line: 4, rule: 'windows-private-home' },
  ]));
  const output = JSON.stringify(report); expect(output).not.toContain(token); expect(output).not.toContain(key); expect(output).not.toContain('private-fixture');
});

test('reads a large binary file completely and catches a token crossing a stream chunk', async () => {
  const root = fixture(); const token = ['gh', 'p_'].join('') + 'B'.repeat(40);
  const prefix = Buffer.alloc(10 * 1024 * 1024 + 65533, 0);
  put(root, 'large.data', Buffer.concat([prefix, Buffer.from('\n' + token)]));
  const report = await scanFiles(root, ['large.data']);
  expect(report.status).toBe('blocked'); expect(report.scannedBytes).toBe(prefix.length + token.length + 1); expect(report.skipped).toEqual([]);
  expect(report.findings).toContainEqual({ path: 'large.data', line: 2, rule: 'github-token' });
});

test('a secret split across independently delivered chunks preserves its line number', async () => {
  const report = { findings: [], scannedBytes: 0, scannedFiles: 0 };
  await scanStream(Readable.from([Buffer.from('one\ntwo\ns'), Buffer.from('k-' + 'Q'.repeat(30))]), 'split.txt', report);
  expect(report.findings).toEqual([{ path: 'split.txt', line: 3, rule: 'api-token' }]); expect(report.scannedFiles).toBe(1);
});

test.each(['le', 'be'])('UTF-16 %s credentials are detected across every byte alignment and chunk boundary', async (order) => {
  const token = ['sk', ''].join('-') + 'U'.repeat(32);
  const value = '\ufeffheading\n' + ' '.repeat(3000) + token + '\nend';
  const encoded = Buffer.from(value, 'utf16le'); if (order === 'be') encoded.swap16();
  for (const prefix of [Buffer.alloc(0), Buffer.from([0x01])]) {
    const bytes = Buffer.concat([prefix, encoded]);
    for (const width of [1, 3, 17, 4095, bytes.length]) {
      const report = { findings: [], scannedBytes: 0, scannedFiles: 0 };
      const chunks = Array.from({ length: Math.ceil(bytes.length / width) }, (_, index) => bytes.subarray(index * width, (index + 1) * width));
      await scanStream(Readable.from(chunks), 'encoded.txt', report);
      expect(report.findings).toContainEqual({ path: 'encoded.txt', line: 2, rule: 'api-token' });
      expect(report.scannedBytes).toBe(bytes.length); expect(report.scannedFiles).toBe(1);
      expect(JSON.stringify(report)).not.toContain(token);
    }
  }
});

test('source and Git blobs scan BOM-less UTF-16 text in both byte orders', async () => {
  const root = fixture(); git(root, ['init', '-q']);
  const token = ['gh', 'p_'].join('') + 'R'.repeat(40);
  put(root, 'little.txt', Buffer.from('heading\n' + token, 'utf16le'));
  put(root, 'big.txt', Buffer.from('heading\n' + token, 'utf16le').swap16());
  git(root, ['add', 'little.txt', 'big.txt']);
  for (const report of [await auditSource(root), await auditGitObjects(root)]) {
    expect(report.status).toBe('blocked'); expect(report.unreadable).toEqual([]);
    expect(report.findings.filter((finding: { rule: string }) => finding.rule === 'github-token')).toHaveLength(2);
    expect(JSON.stringify(report)).not.toContain(token);
  }
});

test('harmless UTF-16 and odd binary bytes remain readable without inventing findings', async () => {
  const root = fixture();
  put(root, 'little.txt', Buffer.from('\ufeff普通说明\nNo credentials here.', 'utf16le'));
  put(root, 'big.txt', Buffer.from('\ufeff普通说明\nNo credentials here.', 'utf16le').swap16());
  put(root, 'short.bin', Buffer.from([0xff]));
  const report = await scanFiles(root, ['little.txt', 'big.txt', 'short.bin']);
  expect(report.status).toBe('clean'); expect(report.scannedFiles).toBe(3);
});

test.each([
  ['literal secret', 'api_key=', ' ', '"' + 'A'.repeat(32) + '"', 'secret-layout-overflow'],
  ['key separator', 'api_key', '\n', '="' + 'A'.repeat(32) + '"', 'secret-layout-overflow'],
  ['bearer', 'Bearer', '\t', 'B'.repeat(32), 'bearer-layout-overflow'],
  ['private path', 'Q:', '/', 'Users/private-fixture', 'path-layout-overflow'],
])('long %s layout cannot hide a match across chunk boundaries', async (_name, prefix, space, suffix, rule) => {
  const input = 'header\n' + prefix + space.repeat(4096) + suffix;
  for (const width of [input.length, 17, 1024, 4096]) {
    const chunks = Array.from({ length: Math.ceil(input.length / width) }, (_, index) => Buffer.from(input.slice(index * width, (index + 1) * width)));
    const report = { findings: [], scannedBytes: 0, scannedFiles: 0 };
    await scanStream(Readable.from(chunks), 'layout.txt', report);
    expect(report.findings).toContainEqual({ path: 'layout.txt', line: 2, rule });
    expect(report.scannedBytes).toBe(Buffer.byteLength(input));
  }
});

test('failed reads and nonregular entries are incomplete, never clean or size-skipped', async () => {
  const root = fixture(); put(root, 'blocked.txt', 'unreadable content'); mkdirSync(path.join(root, 'directory'));
  const report = await scanFiles(root, ['blocked.txt', 'missing.txt', 'directory'], { open: () => new Readable({ read() { this.destroy(Object.assign(new Error('do not expose this content'), { code: 'EACCES' })); } }) });
  expect(report.status).toBe('incomplete'); expect(report.unreadable).toHaveLength(3); expect(report.scannedFiles).toBe(0);
  expect(JSON.stringify(report)).not.toContain('do not expose'); expect(report.skipped).toEqual([]);
});

test('private files and generated residuals block release even when contents look harmless', async () => {
  const root = fixture(); const names = ['deploy/__pycache__/cache.pyc', '.env', 'reference/runtime/package.json', 'session.sqlite-wal'];
  for (const name of names) put(root, name, 'harmless');
  const report = await scanFiles(root, names); expect(report.status).toBe('blocked'); expect(report.artifacts.map((finding: { path: string }) => finding.path).sort()).toEqual(names.sort());
});

test.each(['sqlite-journal', 'sqlite3-journal'])('SQLite %s rollback sidecars block source and historical trees', async (suffix) => {
  const root = fixture(); git(root, ['init', '-q']);
  const name = 'state/gateway.' + suffix; put(root, name, 'harmless rollback page fixture'); git(root, ['add', name]); git(root, ['write-tree']);
  const source = await auditSource(root); const history = await auditGitObjects(root);
  expect(source.status).toBe('blocked'); expect(source.artifacts).toContainEqual({ path: name, line: 1, rule: 'generated-artifact' });
  expect(history.status).toBe('blocked'); expect(history.artifacts).toHaveLength(1); expect(history.unreadable).toEqual([]);
  expect(JSON.stringify(history)).not.toContain(name);
});

test('the source inventory includes forced tracked ignored files, excludes ignored runtime, and handles deletion', async () => {
  const root = fixture(); git(root, ['init', '-q']); put(root, '.gitignore', '.work/\nreference/runtime/\n'); put(root, 'safe.txt', 'safe'); put(root, 'deleted.txt', 'removed');
  git(root, ['add', '.gitignore', 'safe.txt', 'deleted.txt']); rmSync(path.join(root, 'deleted.txt'));
  put(root, 'reference/runtime/private.txt', ['sk', ''].join('-') + 'X'.repeat(30));
  expect((await auditSource(root)).status).toBe('clean');
  put(root, '.work/accidental.txt', 'temporary'); git(root, ['add', '-f', '.work/accidental.txt']);
  const report = await auditSource(root); expect(report.status).toBe('blocked'); expect(report.artifacts).toContainEqual({ path: '.work/accidental.txt', line: 1, rule: 'generated-artifact' });
});

test('history mode finds a dangling blob outside all refs without printing its bytes', async () => {
  const root = fixture(); git(root, ['init', '-q']); const token = ['sk', ''].join('-') + 'Z'.repeat(32);
  const id = git(root, ['hash-object', '-w', '--stdin'], token).trim();
  const report = await auditGitObjects(root); expect(report.status).toBe('blocked'); expect(report.findings).toContainEqual({ path: `git-object/${id}`, line: 1, rule: 'api-token' }); expect(JSON.stringify(report)).not.toContain(token);
});

test('history scans full paths in dangling and shared subtrees without disclosing names', async () => {
  const root = fixture(); git(root, ['init', '-q']);
  const blob = git(root, ['hash-object', '-w', '--stdin'], 'harmless').trim();
  const tree = (entries: string[]) => git(root, ['mktree', '-z'], entries.join('\0') + '\0').trim();
  const leaf = tree([`100644 blob ${blob}\tfixture.txt`]);
  const shared = tree([`040000 tree ${leaf}\truntime`]);
  tree([`040000 tree ${shared}\ta-safe`, `040000 tree ${shared}\treference`]);
  const report = await auditGitObjects(root);
  expect(report.status).toBe('blocked'); expect(report.skipped).toEqual([]); expect(report.unreadable).toEqual([]);
  expect(report.artifacts).toContainEqual({ path: `git-object/${shared}`, line: 1, rule: 'private-or-generated-tree-entry' });
  expect(JSON.stringify(report)).not.toContain('fixture.txt');
  expect(JSON.stringify(report)).not.toContain('a-safe');
});

test('history handles raw tab/newline tree names without quoted-name policy bypass', async () => {
  const root = fixture(); git(root, ['init', '-q']);
  const blob = git(root, ['hash-object', '-w', '--stdin'], 'harmless').trim();
  const id = git(root, ['mktree', '-z'], `100644 blob ${blob}\todd\tline\nfixture.key\0`).trim();
  const report = await auditGitObjects(root);
  expect(report.status).toBe('blocked'); expect(report.unreadable).toEqual([]);
  expect(report.artifacts).toContainEqual({ path: `git-object/${id}`, line: 1, rule: 'private-or-generated-tree-entry' });
  expect(JSON.stringify(report)).not.toContain('fixture.key');
});

test('harmless nested history remains clean even when one tree has several parents', async () => {
  const root = fixture(); git(root, ['init', '-q']);
  const blob = git(root, ['hash-object', '-w', '--stdin'], 'ordinary').trim();
  const shared = git(root, ['mktree', '-z'], `100644 blob ${blob}\tdescription.txt\0`).trim();
  git(root, ['mktree', '-z'], `040000 tree ${shared}\tsrc\0`);
  git(root, ['mktree', '-z'], `040000 tree ${shared}\tdocs\0`);
  const report = await auditGitObjects(root);
  expect(report.status).toBe('clean'); expect(report.scannedFiles).toBe(4); expect(report.skipped).toEqual([]);
});

test('history cannot report clean when an ordinary tree member is absent', async () => {
  const root = fixture(); git(root, ['init', '-q']);
  git(root, ['mktree', '--missing', '-z'], `100644 blob ${'1'.repeat(40)}\tmissing.txt\0`);
  const report = await auditGitObjects(root);
  expect(report.status).toBe('incomplete'); expect(report.unreadable).toContainEqual({ path: 'git-objects', line: 1, rule: 'unreadable', code: 'GIT_TREE_TRAVERSAL_FAILED' });
});
