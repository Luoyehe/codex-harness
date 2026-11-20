import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonical, DeliveryError, string, type JsonObject, type JsonValue } from './types.js';

/** Explicit HARNESS_DEV fallback. Production uses the separate native-identity helper. */
export async function devResource(cwd: string, action: string, params: JsonObject, skillRoots: string[]): Promise<JsonObject> {
  if (action === 'project/trust-roots') {
    try {
      const git = async (...args: string[]) => (await promisify(execFile)('git', ['-C', cwd, 'rev-parse', ...args], {
        env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
        timeout: 4000, maxBuffer: 8192, windowsHide: true,
      })).stdout.trim();
      const checkout = await realpath(await git('--show-toplevel')), marker = path.join(checkout, '.git'), info = await lstat(marker);
      const common = await realpath(await git('--path-format=absolute', '--git-common-dir')), metadata = await realpath(await git('--absolute-git-dir'));
      if (info.isDirectory() && marker === common && metadata === common) return { roots: [checkout] };
      if (info.isFile() && info.nlink === 1 && path.dirname(metadata) === path.join(common, 'worktrees') && path.basename(common) === '.git') {
        const backlink = path.join(metadata, 'gitdir'), stat = await lstat(backlink);
        if (stat.isFile() && stat.nlink === 1 && stat.size <= 8192 && await realpath(path.resolve(metadata, (await readFile(backlink, 'utf8')).trim())) === marker)
          return { roots: [checkout, path.dirname(common)] };
      }
    } catch { /* Absence of verified repository metadata supplies no inherited trust evidence. */ }
    return { roots: [] };
  }
  if (action === 'feedback/path') {
    const directory = path.join(cwd, '.harness-feedback');
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const dir = await lstat(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || process.getuid && (dir.uid !== process.getuid() || (dir.mode & 0o077))) throw new DeliveryError('feedback_scope', '反馈目录身份或权限无效。');
    const ignore = path.join(directory, '.gitignore');
    try { const file = await open(ignore, 'wx', 0o600); try { await file.writeFile('*\n'); await file.sync(); } finally { await file.close(); } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const file = await open(ignore, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try { const stat = await file.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 2 || await file.readFile('utf8') !== '*\n') throw new DeliveryError('feedback_scope', '反馈目录未得到版本控制排除保护。'); }
    finally { await file.close(); }
    return { directory };
  }
  const relative = (root: string, name: string): string => { const rel = path.relative(root, name); if (path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep)) throw new DeliveryError('resource_scope', 'Resource is outside its selected root'); return rel; };
  const walk = async (root: string, target: string): Promise<void> => {
    const rel = relative(root, target); if (path.resolve(await realpath(root)) !== path.resolve(root)) throw new DeliveryError('resource_scope', 'Root is not canonical');
    let current = root;
    for (const part of ['', ...rel.split(path.sep).filter(Boolean)]) { current = path.join(current, part); const info = await lstat(current); if (info.isSymbolicLink()) throw new DeliveryError('resource_scope', 'Resource links are not followed'); }
  };
  const read = async (filename: string, limit: number): Promise<{ data: Buffer; mode: number }> => {
    // Check the opened descriptor without letting a replaced FIFO wait for a writer.
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const before = await handle.stat(); if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw new DeliveryError('resource_scope', 'Resource is not a bounded ordinary file');
      const data = Buffer.alloc(before.size + 1); let length = 0;
      while (length < data.length) { const { bytesRead } = await handle.read(data, length, data.length - length, length); if (!bytesRead) break; length += bytesRead; }
      const after = await handle.stat(), named = await lstat(filename);
      if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || named.isSymbolicLink() || named.dev !== after.dev || named.ino !== after.ino) throw new DeliveryError('resource_changed', 'Resource changed while reading');
      return { data: data.subarray(0, length), mode: after.mode };
    } finally { await handle.close(); }
  };
  const digest = (value: JsonValue): string => createHash('sha256').update(canonical(value)).digest('hex');
  if (action === 'resource/skill/read') {
    const filename = string(params.path, 'skill path'); if (!path.isAbsolute(filename) || path.basename(filename) !== 'SKILL.md') throw new DeliveryError('resource_scope', 'Only catalog skill documents can be read');
    const contains = (root: string): boolean => { try { relative(root, filename); return true; } catch { return false; } };
    let root = [cwd, ...skillRoots].find(contains);
    if (!root) {
      const proof = await devResource(cwd, 'project/trust-roots', {}, []);
      const checkout = Array.isArray(proof.roots) ? proof.roots[0] : null;
      let current = path.resolve(cwd);
      for (let depth = 0; typeof checkout === 'string' && depth < 64; depth++) {
        const skills = path.join(current, '.agents', 'skills');
        if (contains(skills)) { root = skills; break; }
        if (current === checkout || path.dirname(current) === current) break;
        current = path.dirname(current);
      }
    }
    if (!root) throw new DeliveryError('resource_scope', 'Skill is outside explicit development roots'); await walk(root, filename);
    const { data, mode } = await read(filename, 512 * 1024); let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw new DeliveryError('resource_binary', 'Skill must contain UTF-8 text'); }
    if (text.includes('\0')) throw new DeliveryError('resource_binary', 'Skill cannot contain NUL bytes');
    return { path: filename, text, bytes: data.length, revision: digest({ path: filename, mode, sha256: createHash('sha256').update(data).digest('hex') }) };
  }
  const rel = string(params.path ?? '', 'relative directory', 4096, true);
  if (rel && (path.isAbsolute(rel) || rel.includes('\\') || /[\x00-\x1f\x7f:]/.test(rel) || rel.split('/').some(p => !p || ['.', '..', '.git'].includes(p)))) throw new DeliveryError('resource_scope', 'Choose a relative directory');
  const target = path.join(cwd, rel); await walk(cwd, target); const rootInfo = await lstat(target); if (!rootInfo.isDirectory()) throw new DeliveryError('resource_scope', 'Expected directory');
  if (action === 'resource/directory/resolve') return { path: target, device: rootInfo.dev, inode: rootInfo.ino };
  if (action !== 'resource/plugin/preview') throw new DeliveryError('method_not_found', 'Unknown development resource action');
  const files: JsonObject[] = [], directories: JsonValue[] = []; let total = 0, entries = 0;
  const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 16 || directories.length >= 1024) throw new DeliveryError('capacity', 'Plugin directory budget exceeded');
    const stat = await lstat(directory); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new DeliveryError('resource_scope', 'Plugin directory changed'); directories.push([prefix, stat.mode]);
    const names: string[] = [], handle = await opendir(directory, { bufferSize: 32 });
    try {
      for (;;) {
        const entry = await handle.read(); if (!entry) break;
        // A valid tree has at most 512 files + 1024 directories, including its root.
        if (++entries > 1535) throw new DeliveryError('capacity', 'Plugin entry budget exceeded');
        names.push(entry.name);
      }
    } finally { await handle.close(); }
    for (const name of names.sort()) {
      if (['.git', '.harness-workspace'].includes(name) || /[\x00-\x1f\x7f]/.test(name)) throw new DeliveryError('resource_scope', 'Plugin contains reserved metadata');
      const filename = path.join(directory, name), display = prefix ? prefix + '/' + name : name, info = await lstat(filename);
      if (info.isSymbolicLink()) throw new DeliveryError('resource_scope', 'Plugin links are not followed');
      if (info.isDirectory()) { await visit(filename, display, depth + 1); continue; }
      if (!info.isFile() || files.length >= 512 || total + info.size > 16 * 1024 * 1024) throw new DeliveryError('capacity', 'Plugin file budget exceeded');
      const { data, mode } = await read(filename, 2 * 1024 * 1024); total += data.length; files.push({ path: display, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), mode });
    }
    await walk(cwd, directory);
  };
  await visit(target, '', 0); const revision = digest({ path: target, files, directories });
  return { path: target, revision, files: files.map(({ mode: _mode, ...file }) => file), totalBytes: total };
}
