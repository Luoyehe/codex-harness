import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathFindings, validateRelative } from './release-audit.mjs';
export const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export function evidencePath(name) {
  return ['verification/audits.json', 'verification/WORKLOG.md', 'verification/RELEASE-CHECKS.md'].includes(name)
    || /^verification\/audit-evidence\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.json$/.test(name)
    || /^verification\/reports\/[A-Za-z0-9_.-]+\.md$/.test(name);
}
export function snapshot(base = root, includeNames = false) {
  const currentRoot = realpathSync(base);
  const git = args => execFileSync('git', args, { cwd: currentRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  if (realpathSync(git(['rev-parse', '--show-toplevel']).trim()) !== currentRoot) throw new Error('Snapshot root must be its own repository');
  const deleted = new Set(git(['ls-files', '--deleted', '-z']).split('\0'));
  const names = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(name => name && !deleted.has(name)))].sort();
  const files = [];
  for (const name of names) {
    validateRelative(name);
    // Only declared non-executable evidence is outside its own digest. New
    // scripts/configuration under verification remain part of the source.
    if (pathFindings(name).length || name.split('/').includes('.git'))
      throw new Error('Private or generated runtime path entered the source inventory');
    let full = currentRoot; let info;
    const segments = name.split('/');
    for (let index = 0; index < segments.length; index++) {
      full = path.join(full, segments[index]); info = lstatSync(full);
      if (info.isSymbolicLink() || (index < segments.length - 1 ? !info.isDirectory() : !info.isFile())) throw new Error('Source inventory must contain regular files');
    }
    if (evidencePath(name)) continue;
    files.push([name, info.mode & 0o111, createHash('sha256').update(readFileSync(full)).digest('hex')]);
  }
  if (!files.length) throw new Error('An empty source snapshot cannot authorize full tests');
  return { files: files.length, digest: createHash('sha256').update(JSON.stringify(files)).digest('hex'), ...(includeNames ? { names: files.map(file => file[0]) } : {}) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.stdout.write(JSON.stringify(snapshot()) + '\n');
