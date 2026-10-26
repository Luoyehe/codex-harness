import { expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractArchive, prepareCiNative, validatePackageMetadata } from '../../scripts/prepare-ci-native.mjs';

const packages = [
  { platform: 'linux', version: '0.164.0-linux-x64', integrity: 'sha512-XLAoaWsGOT2khzl+P4FYDPTkzAr9W0VFXFaVkqlFdkM0soa1gH/4S0wSD57Ek3HHwkirAEGz2/Mwehseh+l5Mg==' },
  { platform: 'win32', version: '0.164.0-win32-x64', integrity: 'sha512-urWPhwh9YavuoAPIkmVYKBTtd5OtGVL4Ki0Fb28dhK/Mz6Pt4LSy+gbRrZFz5+RXrw9ubvXuXDCcd8beYcWhDg==' },
];

test.each(packages)('accepts the exact npm scoped-package filename for $platform', value => {
  const filename = `openai-codex-${value.version}.tgz`;
  const entry = { name: '@openai/codex', version: value.version, integrity: value.integrity, filename };
  expect(validatePackageMetadata([entry], value.platform, 'x64')).toEqual({ filename, integrity: value.integrity });
  for (const changed of [
    { name: 'codex' }, { version: '0.164.0' }, { integrity: 'sha512-other' },
    { filename: `codex-${value.version}.tgz` }, { filename: `../${filename}` }, { filename: `openai-codex-wrong.tgz` },
  ]) expect(() => validatePackageMetadata([{ ...entry, ...changed }], value.platform, 'x64')).toThrow();
  expect(() => validatePackageMetadata([entry, entry], value.platform, 'x64')).toThrow();
  expect(() => validatePackageMetadata([entry], value.platform, 'arm64')).toThrow();
});

test('empty, malformed and unsupported platform packs cannot prepare an independent runtime', () => {
  for (const pack of [null, {}, [], [null]]) expect(() => validatePackageMetadata(pack, 'linux', 'x64')).toThrow();
  for (const platform of ['darwin', '__proto__', 'constructor']) expect(() => validatePackageMetadata([], platform, 'x64')).toThrow();
});

test('extracts a real archive from its native working directory without passing a drive-qualified archive to tar', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ci native archive with spaces-'));
  try {
    const source = path.join(directory, 'source'), target = path.join(directory, 'target');
    mkdirSync(path.join(source, 'package'), { recursive: true }); mkdirSync(target);
    writeFileSync(path.join(source, 'package', 'fixture.txt'), 'archive extraction fixture');
    execFileSync('tar', ['-czf', '../target/fixture.tgz', 'package'], { cwd: source, windowsHide: true });
    extractArchive(target, 'fixture.tgz');
    expect(readFileSync(path.join(target, 'package', 'fixture.txt'), 'utf8')).toBe('archive extraction fixture');
    for (const filename of ['../fixture.tgz', '..\\fixture.tgz', 'D:\\fixture.tgz', '/fixture.tgz', 'host:fixture.tgz'])
      expect(() => extractArchive(target, filename)).toThrow('Expected an archive basename');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('archive integrity failure prevents extraction and writing the CI environment', () => {
  const pin = packages.find(value => value.platform === process.platform)!;
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
