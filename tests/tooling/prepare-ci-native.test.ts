import { expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractArchive, nativePreparationDirectory, prepareCiNative, validatePackageMetadata } from '../../scripts/prepare-ci-native.mjs';

const packages = [
  { arch: 'x64', version: '0.169.0-linux-x64', integrity: 'sha512-o05NyAOCDygSPRo1yinzxvkRSdmsZyBD9E7mbpmjRanSfM8lypqWtQgEo4XfNkwhuCR2aFu8mlGOsQGFXVbVww==' },
  { arch: 'arm64', version: '0.169.0-linux-arm64', integrity: 'sha512-NZ/DaQUpcQmxmqee7Z9uC1rzw3GhSbooawcaTe1LN5Yk+WlinUKGdTXJgClRT/9ogQEEM9TWxYzvxPfj5G/xFg==' },
];

test.each(packages)('accepts the exact npm scoped-package filename for $arch', value => {
  const filename = `openai-codex-${value.version}.tgz`;
  const entry = { name: '@openai/codex', version: value.version, integrity: value.integrity, filename };
  expect(validatePackageMetadata([entry], 'linux', value.arch)).toEqual({ filename, integrity: value.integrity });
  for (const changed of [
    { name: 'codex' }, { version: '0.169.0' }, { integrity: 'sha512-other' },
    { filename: `codex-${value.version}.tgz` }, { filename: `../${filename}` }, { filename: `openai-codex-wrong.tgz` },
  ]) expect(() => validatePackageMetadata([{ ...entry, ...changed }], 'linux', value.arch)).toThrow();
  expect(() => validatePackageMetadata([entry, entry], 'linux', value.arch)).toThrow();
  expect(() => validatePackageMetadata([entry], 'linux', value.arch === 'arm64' ? 'x64' : 'arm64')).toThrow();
});

test('empty, malformed and unsupported platform packs cannot prepare an independent runtime', () => {
  for (const pack of [null, {}, [], [null]]) expect(() => validatePackageMetadata(pack, 'linux', 'x64')).toThrow();
  for (const platform of ['darwin', '__proto__', 'constructor']) expect(() => validatePackageMetadata([], platform, 'x64')).toThrow();
});

test('native preparation rejects an ancestor directory link before creating files outside its workspace', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ci native linked archive-'));
  try {
    const outside = path.join(directory, 'outside'), base = path.join(directory, 'workspace'); mkdirSync(outside); mkdirSync(base);
    symlinkSync(outside, path.join(base, 'reference'), 'dir');
    expect(() => nativePreparationDirectory(base)).toThrow('ordinary directories');
    expect(existsSync(path.join(outside, 'runtime'))).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('extracts a real archive from its native working directory using an ordinary basename', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ci native archive with spaces-'));
  try {
    const source = path.join(directory, 'source'), target = path.join(directory, 'target');
    mkdirSync(path.join(source, 'package'), { recursive: true }); mkdirSync(target);
    writeFileSync(path.join(source, 'package', 'fixture.txt'), 'archive extraction fixture');
    execFileSync('tar', ['-czf', '../target/fixture.tgz', 'package'], { cwd: source });
    extractArchive(target, 'fixture.tgz');
    expect(readFileSync(path.join(target, 'package', 'fixture.txt'), 'utf8')).toBe('archive extraction fixture');
    for (const filename of ['../fixture.tgz', '..\\fixture.tgz', '/fixture.tgz', 'host:fixture.tgz'])
      expect(() => extractArchive(target, filename)).toThrow('Expected an archive basename');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== 'linux' || !packages.some(value => value.arch === process.arch))('archive integrity failure prevents extraction and writing the CI environment', () => {
  const pin = packages.find(value => value.arch === process.arch)!;
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ci native invalid archive-'));
  try {
    const target = path.join(directory, 'reference/runtime/ci-codex'); mkdirSync(target, { recursive: true });
    const filename = `openai-codex-${pin.version}.tgz`, environment = path.join(directory, 'environment');
    writeFileSync(path.join(target, 'pack.json'), JSON.stringify([{ name: '@openai/codex', version: pin.version, integrity: pin.integrity, filename }]));
    writeFileSync(path.join(target, filename), 'corrupted fixture'); writeFileSync(environment, 'unchanged');
    expect(() => prepareCiNative(directory, { GITHUB_ENV: environment })).toThrow('Official CLI archive integrity mismatch');
    expect(readFileSync(environment, 'utf8')).toBe('unchanged');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
