import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from './snapshot.mjs';

const pins = {
  linux: ['0.164.0-linux-x64', 'sha512-XLAoaWsGOT2khzl+P4FYDPTkzAr9W0VFXFaVkqlFdkM0soa1gH/4S0wSD57Ek3HHwkirAEGz2/Mwehseh+l5Mg=='],
  win32: ['0.164.0-win32-x64', 'sha512-urWPhwh9YavuoAPIkmVYKBTtd5OtGVL4Ki0Fb28dhK/Mz6Pt4LSy+gbRrZFz5+RXrw9ubvXuXDCcd8beYcWhDg=='],
};
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

export function prepareCiNative(base = root, env = process.env) {
  const directory = path.join(base, 'reference/runtime/ci-codex');
  mkdirSync(directory, { recursive: true });
  const entry = validatePackageMetadata(JSON.parse(readFileSync(path.join(directory, 'pack.json'), 'utf8')));
  const archive = path.join(directory, entry.filename);
  if ('sha512-' + createHash('sha512').update(readFileSync(archive)).digest('base64') !== entry.integrity) throw Error('Official CLI archive integrity mismatch');
  extractArchive(directory, entry.filename);
  const binaries = [];
  function visit(folder) {
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, item.name);
      if (item.isDirectory()) visit(file);
      else if (item.isFile() && item.name === (process.platform === 'win32' ? 'codex.exe' : 'codex')) binaries.push(file);
    }
  }
  visit(path.join(directory, 'package/vendor'));
  if (binaries.length !== 1 || !env.GITHUB_ENV) throw Error('Expected exactly one independent binary and a CI environment file');
  appendFileSync(env.GITHUB_ENV, `HARNESS_TEST_CODEX_BIN=${binaries[0]}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepareCiNative();
