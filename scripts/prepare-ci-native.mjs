import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from './snapshot.mjs';

const pins = {
  linux: ['0.169.0-linux-x64', 'sha512-o05NyAOCDygSPRo1yinzxvkRSdmsZyBD9E7mbpmjRanSfM8lypqWtQgEo4XfNkwhuCR2aFu8mlGOsQGFXVbVww=='],
  win32: ['0.169.0-win32-x64', 'sha512-nC+McFU8xRNL9tk3IhxcKdhcyOElwF/HhPO+gzSQCY7yjh3XdzSajX+MYWcHUVHWRHajfwn3/WgJYJK2wS+XWg=='],
};
/** @param {unknown} pack @param {string} platform @param {string} arch */
export function validatePackageMetadata(pack, platform = process.platform, arch = process.arch) {
  const pin = Object.hasOwn(pins, platform) ? pins[platform] : undefined;
  if (!pin || arch !== 'x64') throw Error('CI native preparation requires a supported x64 runner');
  if (!Array.isArray(pack) || pack.length !== 1) throw Error('Expected exactly one packed official CLI package');
  const entry = pack[0];
  // npm flattens @scope/name to scope-name when choosing the archive filename.
  // An exact name also excludes unexpected sibling files and path traversal.
  if (!entry || entry.name !== '@openai/codex' || entry.version !== pin[0] || entry.integrity !== pin[1] ||
      entry.filename !== `openai-codex-${pin[0]}.tgz`) throw Error('Official CLI package metadata mismatch');
  return { filename: entry.filename, integrity: pin[1] };
}

export function extractArchive(directory, filename) {
  if (typeof filename !== 'string' || !filename || path.posix.basename(filename) !== filename || path.win32.basename(filename) !== filename || /[:\x00-\x1f]/u.test(filename)) throw Error('Expected an archive basename');
  // Git Bash may put GNU tar before the Windows bsdtar executable. GNU tar
  // treats the colon in an absolute D:\\... archive as a remote-host delimiter.
  // A verified basename and native process cwd work with both implementations.
  execFileSync('tar', ['-xzf', filename], { cwd: directory, stdio: 'inherit', windowsHide: true });
}

export function nativePreparationDirectory(base) {
  const resolved = path.resolve(base);
  if (/[\r\n]/.test(resolved)) throw Error('Invalid native preparation path');
  let current = path.parse(resolved).root;
  const parents = resolved.slice(current.length).split(path.sep).filter(Boolean);
  for (const component of [...parents, 'reference', 'runtime', 'ci-codex']) {
    current = path.join(current, component);
    try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Native preparation requires ordinary directories');
  }
  return current;
}

export function prepareCiNative(base = root, env = process.env) {
  if (!env.GITHUB_ENV) throw Error('Expected a CI environment file');
  const directory = nativePreparationDirectory(base);
  const packFile = path.join(directory, 'pack.json'), metadata = lstatSync(packFile);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 65536) throw Error('Invalid native package metadata file');
  const entry = validatePackageMetadata(JSON.parse(readFileSync(packFile, 'utf8')));
  const archive = path.join(directory, entry.filename);
  const info = lstatSync(archive);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024 * 1024) throw Error('Invalid native archive file');
  const bytes = readFileSync(archive);
  if (bytes.length > 256 * 1024 * 1024 || 'sha512-' + createHash('sha512').update(bytes).digest('base64') !== entry.integrity) throw Error('Official CLI archive integrity mismatch');
  const extracted = mkdtempSync(path.join(directory, 'prepare-'));
  // Extract the bytes that were actually verified into a fresh private tree.
  // Reusing package/ could follow a previously substituted directory or file.
  writeFileSync(path.join(extracted, entry.filename), bytes, { flag: 'wx', mode: 0o600 });
  extractArchive(extracted, entry.filename);
  const binaries = [];
  function visit(folder) {
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, item.name);
      if (item.isDirectory()) visit(file);
      else if (item.isFile() && item.name === (process.platform === 'win32' ? 'codex.exe' : 'codex')) binaries.push(file);
    }
  }
  visit(path.join(extracted, 'package/vendor'));
  if (binaries.length !== 1 || !env.GITHUB_ENV) throw Error('Expected exactly one independent binary and a CI environment file');
  appendFileSync(env.GITHUB_ENV, `HARNESS_TEST_CODEX_BIN=${binaries[0]}\n`);
  return binaries[0];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepareCiNative();
