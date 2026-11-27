import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const pnpmVersion = '11.22.0';
export const pnpmIntegrity = 'sha512-H/hwxMYTPf2I+yr8Rt0T1H8JyXlLQ4xv20fKmMrzvBY4HuC+k6CRuOOCTPAfiJ9G19niCRD7C+GrD7W6qA3WIQ==';
export function verifyPnpmArchive(bytes) {
  if (bytes.length > 32 * 1024 * 1024 || 'sha512-' + createHash('sha512').update(bytes).digest('base64') !== pnpmIntegrity) throw Error('Pinned pnpm distribution checksum mismatch');
}
export function createPnpmDirectory(base) {
  const resolved = path.resolve(base);
  if (/[\r\n]/.test(resolved)) throw Error('Invalid pnpm output directory');
  const root = path.parse(resolved).root;
  let current = root;
  // Check every existing ancestor before creating any child: checking only the
  // leaf permits a .work symlink to redirect extraction outside the workspace.
  for (const component of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('Invalid pnpm output directory');
  }
  for (const component of ['.work', 'ci-pnpm']) {
    current = path.join(current, component);
    try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('Invalid pnpm output directory');
  }
  // Never extract into a reused package tree or overwrite a pre-existing
  // archive/launcher: any of those paths could have been replaced by a link.
  return mkdtempSync(path.join(current, 'prepare-'));
}
export async function preparePnpm(base, env = process.env) {
  if (!env.GITHUB_PATH) throw Error('Missing GitHub PATH output');
  const directory = createPnpmDirectory(base);
  const response = await fetch(`https://registry.npmjs.org/pnpm/-/pnpm-${pnpmVersion}.tgz`, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw Error('Pinned pnpm distribution unavailable');
  const chunks = []; let bytes = 0;
  for await (const part of response.body ?? []) { bytes += part.length; if (bytes > 32 * 1024 * 1024) throw Error('pnpm distribution too large'); chunks.push(part); }
  const archive = Buffer.concat(chunks, bytes); verifyPnpmArchive(archive);
  writeFileSync(path.join(directory, 'pnpm.tgz'), archive);
  execFileSync('tar', ['-xzf', 'pnpm.tgz'], { cwd: directory });
  const pkg = JSON.parse(readFileSync(path.join(directory, 'package/package.json'), 'utf8'));
  if (pkg.name !== 'pnpm' || pkg.version !== pnpmVersion || !env.GITHUB_PATH) throw Error('Prepared pnpm package identity mismatch');
  const binary = path.join(directory, 'package/bin/pnpm.cjs');
  if (execFileSync(process.execPath, [binary, '--version'], { encoding: 'utf8' }).trim() !== pnpmVersion) throw Error('Prepared pnpm runtime mismatch');
  const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(path.join(directory, 'pnpm'), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(binary)} "$@"\n`);
  chmodSync(path.join(directory, 'pnpm'), 0o755);
  appendFileSync(env.GITHUB_PATH, directory + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await preparePnpm(fileURLToPath(new URL('..', import.meta.url))); }
  catch { console.error('Pinned pnpm preparation failed'); process.exitCode = 1; }
}
