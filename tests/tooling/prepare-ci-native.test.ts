import { expect, test } from 'vitest';
import { validatePackageMetadata } from '../../scripts/prepare-ci-native.mjs';

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
