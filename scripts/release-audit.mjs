import { spawn, execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ownRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
// Matches are never included in diagnostics. Test credentials must be constructed
// in isolated fixtures, rather than exempting test files from these rules.
const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g],
  ['api-token', /\bsk-(?:(?:proj|svcacct|ant-api\d+)-)?[A-Za-z0-9_-]{20,}/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['literal-secret', /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|admin[_-]?token)["']?\s{0,512}[:=]\s{0,512}["'][A-Za-z0-9+/_=.\-]{24,}/gi],
  ['secret-layout-overflow', /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|admin[_-]?token)["']?(?:\s{513}|\s{0,512}[:=]\s{513})/gi],
  ['bearer-token', /\bBearer[ \t]{1,512}[A-Za-z0-9_+/.=-]{24,}/gi],
  ['bearer-layout-overflow', /\bBearer[ \t]{513}/gi],
  ['url-credentials', /https?:\/\/[^\s/:@"'<>]{1,128}:[^\s/@"'<>]{1,128}@/gi],
  ['windows-private-home', /\b[A-Z]:[\\/]{1,512}(?:Users|Documents and Settings)[\\/]{1,512}[^\\/\s"'<>]{1,80}/gi],
  ['path-layout-overflow', /\b[A-Z]:(?:[\\/]{513}|[\\/]{1,512}(?:Users|Documents and Settings)[\\/]{513})/gi],
  ['unix-private-home', /\/(?:home|Users)\/[A-Za-z0-9._-]+/g],
];
const generated = /(?:^|\/)(?:node_modules|dist|coverage|\.work|\.cache|\.pytest_cache|__pycache__)(?:\/|$)|(?:^|\/)reference\/(?:runtime|evidence)(?:\/|$)|\.(?:pyc|pyo|log|sqlite(?:3)?(?:-wal|-shm|-journal)?|tsbuildinfo)$|(?:^|\/)\.DS_Store$/i;
const privateFile = /(?:^|\/)(?:\.env(?:\..+)?|auth\.json|credentials(?:\.json)?|id_(?:rsa|ed25519|ecdsa)|[^/]+\.(?:pem|p12|pfx|key))$/i;
const safeCode = error => typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'SCAN_ERROR';
const issue = (name, rule, line = 1) => ({ path: name, line, rule });
const newReport = mode => ({ mode, status: 'incomplete', scannedFiles: 0, scannedBytes: 0, findings: [], artifacts: [], unreadable: [], skipped: [] });
const finish = report => { report.status = report.unreadable.length || report.skipped.length ? 'incomplete' : report.findings.length || report.artifacts.length ? 'blocked' : 'clean'; return report; };

export function pathFindings(name) {
  const result = [];
  if (generated.test(name)) result.push(issue(name, 'generated-artifact'));
  if (privateFile.test(name) && !/(?:^|\/)\.env\.example$/.test(name)) result.push(issue(name, 'private-file'));
  return result;
}

export function validateRelative(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0') || path.posix.isAbsolute(name) || /^[A-Za-z]:/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid repository-relative path');
  return name;
}

// Stream every byte, including binary files and long lines. A retained overlap
// exceeds the bounded prefix needed by every rule; excessive separator layouts
// are rejected explicitly before they can exceed it. No file-size cutoff.
export async function scanStream(stream, name, report) {
  let bytes = 0; let previousByte;
  const seen = new Set();
  // Scan raw bytes and both UTF-16 byte orders at both alignments. This also
  // covers BOM-less text and text embedded inside binary files. Each view has
  // its own bounded overlap and line cursor; byte accounting remains singular.
  const views = Array.from({ length: 5 }, () => ({ tail: '', line: 1 }));
  const inspect = (value, view) => {
    const text = view.tail + value;
    for (const [rule, pattern] of rules) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const line = view.line + text.slice(0, match.index).split('\n').length - 1;
        const key = `${rule}:${line}`;
        if (!seen.has(key)) { report.findings.push(issue(name, rule, line)); seen.add(key); }
      }
    }
    const boundary = Math.max(0, text.length - 2048);
    view.line += text.slice(0, boundary).split('\n').length - 1;
    view.tail = text.slice(boundary);
  };
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!buffer.length) continue;
    inspect(buffer.toString('latin1'), views[0]);
    const pairStart = bytes - (previousByte === undefined ? 0 : 1);
    const pairs = previousByte === undefined ? buffer : Buffer.concat([Buffer.from([previousByte]), buffer]);
    for (let alignment = 0; alignment < 2; alignment++) {
      const start = (alignment - pairStart % 2 + 2) % 2;
      const end = start + Math.floor((pairs.length - start) / 2) * 2;
      const words = pairs.subarray(start, end);
      inspect(words.toString('utf16le'), views[1 + alignment * 2]);
      inspect(Buffer.from(words).swap16().toString('utf16le'), views[2 + alignment * 2]);
    }
    previousByte = buffer[buffer.length - 1];
    bytes += buffer.length;
  }
  report.scannedBytes += bytes;
  report.scannedFiles++;
}

export async function scanFiles(root, names, { open = createReadStream } = {}) {
  const report = newReport('source');
  const base = await realpath(root);
  for (const name of [...new Set(names)].sort()) {
    try {
      validateRelative(name);
      report.artifacts.push(...pathFindings(name));
      let full = base;
      const segments = name.split('/');
      for (let index = 0; index < segments.length; index++) {
        full = path.join(full, segments[index]);
        const info = await lstat(full);
        if (info.isSymbolicLink() || (index < segments.length - 1 ? !info.isDirectory() : !info.isFile())) throw Object.assign(new Error(), { code: 'NON_REGULAR_PATH' });
      }
      // An open/read failure is an incomplete scan, even after earlier chunks.
      await scanStream(open(full), name, report);
    } catch (error) { report.unreadable.push({ ...issue(name, 'unreadable'), code: safeCode(error) }); }
  }
  return finish(report);
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

export async function auditSource(root = ownRoot) {
  const resolved = await realpath(root);
  if (await realpath(git(resolved, ['rev-parse', '--show-toplevel']).trim()) !== resolved) throw new Error('The scan root must be the Git repository root');
  const deleted = new Set(git(root, ['ls-files', '--deleted', '-z']).split('\0'));
  const names = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(name => name && !deleted.has(name));
  if (!names.length) throw new Error('An empty source inventory cannot pass release checks');
  return scanFiles(resolved, names);
}

// This separate mode covers reachable, reflog-only and dangling local objects.
// Object IDs replace content and historical filenames in emitted diagnostics.
export async function auditGitObjects(root = ownRoot) {
  const resolved = await realpath(root);
  if (await realpath(git(resolved, ['rev-parse', '--show-toplevel']).trim()) !== resolved) throw new Error('The scan root must be the Git repository root');
  const report = newReport('git-objects');
  const inventory = git(root, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)']).trim();
  if (!inventory) throw new Error('An empty object inventory cannot pass history checks');
  const trees = new Map(); const nestedTrees = new Set(); const objectTypes = new Map();
  let entryCount = 0;
  for (const row of inventory.split('\n')) {
    const match = /^([a-f0-9]{40,64}) (blob|commit|tag|tree)$/.exec(row.trim());
    if (!match) throw new Error('Invalid Git object inventory');
    const [, id, type] = match; const name = `git-object/${id}`;
    objectTypes.set(id, type);
    const child = spawn('git', type === 'tree' ? ['ls-tree', '-z', id] : ['cat-file', type, id], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const ended = new Promise(resolve => { child.on('error', () => resolve(false)); child.on('close', code => resolve(code === 0)); });
    try {
      if (type === 'tree') {
        // NUL framing preserves tabs/newlines and avoids Git's quoted-name
        // rendering. Keep edges so nested policies see complete path context.
        let pending = ''; const entries = [];
        for await (const chunk of child.stdout) {
          report.scannedBytes += chunk.length; pending += chunk.toString('latin1');
          let end;
          while ((end = pending.indexOf('\0')) >= 0) {
            const entry = /^([0-7]{6}) (blob|tree|commit) ([a-f0-9]{40,64})\t([^\0]+)$/.exec(pending.slice(0, end)); pending = pending.slice(end + 1);
            if (!entry || entry[4].includes('/') || entry[4] === '.' || entry[4] === '..' || ++entryCount > 1_000_000) throw new Error('Invalid or excessive Git tree inventory');
            entries.push({ name: entry[4], type: entry[2], id: entry[3], tree: entry[2] === 'tree' ? entry[3] : null });
            if (entry[2] === 'tree') nestedTrees.add(entry[3]);
          }
          if (pending.length > 1024 * 1024) throw new Error('Excessive Git tree entry');
        }
        if (pending) throw new Error('Incomplete Git tree');
        trees.set(id, entries);
        report.scannedFiles++;
      } else await scanStream(child.stdout, name, report);
      if (!(await ended)) throw Object.assign(new Error(), { code: 'GIT_OBJECT_READ_FAILED' });
    } catch (error) { child.kill(); await ended; report.unreadable.push({ ...issue(name, 'unreadable'), code: safeCode(error) }); }
  }
  // All forest roots include dangling trees, not just commit-reachable paths.
  // A shared subtree must be inspected once per prefix: it can be harmless at
  // src/ yet forbidden at reference/. Bounds fail closed rather than skip.
  const pending = [...trees.keys()].filter(id => !nestedTrees.has(id)).map(id => ({ id, prefix: '' }));
  const visited = new Set(); const reached = new Set(); const flagged = new Set();
  let traversed = 0;
  try {
    while (pending.length) {
      const { id, prefix } = pending.pop(); const key = id + '\0' + prefix;
      if (visited.has(key)) continue;
      if (++traversed > 1_000_000 || prefix.length > 65536) throw new Error('Excessive Git tree traversal');
      visited.add(key); reached.add(id);
      const entries = trees.get(id); if (!entries) throw new Error('Missing Git tree object');
      for (const entry of entries) {
        // Gitlinks reference an external repository; ordinary file/tree objects
        // must exist locally and have been scanned, including in dangling trees.
        if (entry.type !== 'commit' && objectTypes.get(entry.id) !== entry.type) throw new Error('Missing or mistyped Git tree member');
        const full = prefix + entry.name;
        if (pathFindings(full).length && !flagged.has(id)) { flagged.add(id); report.artifacts.push(issue(`git-object/${id}`, 'private-or-generated-tree-entry')); }
        if (entry.tree) pending.push({ id: entry.tree, prefix: full + '/' });
      }
    }
    if (reached.size !== trees.size) throw new Error('Unvisited Git tree object');
  } catch { report.unreadable.push({ ...issue('git-objects', 'unreadable'), code: 'GIT_TREE_TRAVERSAL_FAILED' }); }
  return finish(report);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length && !['--source', '--git-objects'].includes(args[0]))) throw new Error('Use --source or --git-objects');
    const report = args[0] === '--git-objects' ? await auditGitObjects() : await auditSource();
    process.stdout.write(JSON.stringify(report, null, 2) + '\n'); process.exitCode = report.status === 'clean' ? 0 : 1;
  } catch (error) {
    // Avoid forwarding Git/OS diagnostics, which can contain source or secrets.
    process.stderr.write(JSON.stringify({ status: 'incomplete', code: safeCode(error) }) + '\n'); process.exitCode = 1;
  }
}
