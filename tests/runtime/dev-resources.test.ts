import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
const enumeration = vi.hoisted(() => ({ largestArray: 0, reads: 0, live: new Set<object>(), failAt: 0 }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual,
    readdir: async (directory: Parameters<typeof actual.readdir>[0]) => { const names = await actual.readdir(directory); enumeration.largestArray = Math.max(enumeration.largestArray, names.length); return names; },
    opendir: async (directory: Parameters<typeof actual.opendir>[0], options?: Parameters<typeof actual.opendir>[1]) => {
      const handle = await actual.opendir(directory, options); enumeration.live.add(handle);
      return new Proxy(handle, { get(target, key) {
        if (key === 'read') return async () => { if (++enumeration.reads === enumeration.failAt) throw new Error('Injected directory read failure'); return target.read(); };
        if (key === 'close') return async () => { try { await target.close(); } finally { enumeration.live.delete(target); } };
        return Reflect.get(target, key);
      } });
    },
  };
});
import { devResource } from '../../src/runtime/dev-resources.js';
beforeEach(() => { enumeration.largestArray = enumeration.reads = enumeration.failAt = 0; });
afterEach(() => { expect(enumeration.live.size).toBe(0); });
function fixture() { const parent = path.resolve('.work/dev-resources'); mkdirSync(parent, { recursive: true }); return mkdtempSync(path.join(parent, 'case-')); }
test('explicit development resources reject escaped roots and linked directories, and change inventory hashes with content', async () => {
  const parent = path.resolve('.work/dev-resources'); mkdirSync(parent, { recursive: true }); const root = mkdtempSync(path.join(parent, 'case-'));
  const plugin = path.join(root, 'plugin'); mkdirSync(plugin); writeFileSync(path.join(plugin, 'file.txt'), 'first');
  const preview = await devResource(root, 'resource/plugin/preview', { path: 'plugin' }, []); expect(preview.files).toMatchObject([{ path: 'file.txt', bytes: 5 }]);
  writeFileSync(path.join(plugin, 'file.txt'), 'second'); expect((await devResource(root, 'resource/plugin/preview', { path: 'plugin' }, [])).revision).not.toBe(preview.revision);
  await expect(devResource(root, 'resource/directory/resolve', { path: '../outside' }, [])).rejects.toHaveProperty('code', 'resource_scope');
  const outside = mkdtempSync(path.join(parent, 'outside-')); symlinkSync(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(devResource(root, 'resource/directory/resolve', { path: 'link' }, [])).rejects.toHaveProperty('code', 'resource_scope');
  writeFileSync(path.join(outside, 'SKILL.md'), 'private'); await expect(devResource(root, 'resource/skill/read', { path: path.join(outside, 'SKILL.md') }, [])).rejects.toHaveProperty('code', 'resource_scope');
});

test('oversized plugin directories stop enumeration at the combined file and directory budget', async () => {
  const root = fixture(), plugin = path.join(root, 'plugin'); mkdirSync(plugin);
  for (let index = 0; index < 2048; index++) writeFileSync(path.join(plugin, `file-${index}`), '');
  await expect(devResource(root, 'resource/plugin/preview', { path: 'plugin' }, [])).rejects.toHaveProperty('code', 'capacity');
  // At most 512 files and 1024 directories (including the root) can belong to
  // a valid preview. One additional entry is enough to prove it is oversized.
  expect(enumeration.largestArray).toBeLessThanOrEqual(1536);
  expect(enumeration.reads).toBeLessThanOrEqual(1536);
});

test('directory read failures close the handle and ordinary traversal remains deterministic', async () => {
  const root = fixture(), plugin = path.join(root, 'plugin'); mkdirSync(plugin);
  mkdirSync(path.join(plugin, 'nested')); writeFileSync(path.join(plugin, 'z.txt'), 'last'); writeFileSync(path.join(plugin, 'a.txt'), 'first'); writeFileSync(path.join(plugin, 'nested', 'file.txt'), 'middle');
  enumeration.failAt = 2;
  await expect(devResource(root, 'resource/plugin/preview', { path: 'plugin' }, [])).rejects.toThrow('Injected directory read failure');
  expect(enumeration.live.size).toBe(0); enumeration.failAt = 0;
  const preview = await devResource(root, 'resource/plugin/preview', { path: 'plugin' }, []);
  expect(preview.files).toMatchObject([{ path: 'a.txt', bytes: 5 }, { path: 'nested/file.txt', bytes: 6 }, { path: 'z.txt', bytes: 4 }]);
  expect(preview.totalBytes).toBe(15);
  expect(await devResource(root, 'resource/plugin/preview', { path: 'plugin' }, [])).toEqual(preview);
});

test('ordinary skill reads preserve content and revisions while rejecting oversized files', async () => {
  const root = fixture(), filename = path.join(root, 'SKILL.md'); writeFileSync(filename, 'Skill document.');
  const first = await devResource(root, 'resource/skill/read', { path: filename }, []);
  expect(first).toMatchObject({ path: filename, text: 'Skill document.', bytes: 15, revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(await devResource(root, 'resource/skill/read', { path: filename }, [])).toEqual(first);
  writeFileSync(filename, 'Changed skill.'); expect((await devResource(root, 'resource/skill/read', { path: filename }, [])).revision).not.toBe(first.revision);
  writeFileSync(filename, Buffer.alloc(512 * 1024 + 1));
  await expect(devResource(root, 'resource/skill/read', { path: filename }, [])).rejects.toHaveProperty('code', 'resource_scope');
});

test('special files are rejected without starving unrelated filesystem work in an isolated process', () => {
  const root = fixture();
  for (const name of ['regular', 'home', 'tmp', 'special-0', 'special-1', 'special-2', 'special-3']) mkdirSync(path.join(root, name));
  writeFileSync(path.join(root, 'regular', 'SKILL.md'), 'ordinary skill'); writeFileSync(path.join(root, 'marker.txt'), 'responsive');
  for (let index = 0; index < 4; index++) {
    const filename = path.join(root, `special-${index}`, 'SKILL.md');
    // POSIX exercises the blocking FIFO case; Windows uses a non-regular
    // directory because its filesystem does not provide POSIX FIFOs.
    if (process.platform === 'win32') mkdirSync(filename);
    else execFileSync('mkfifo', ['--', filename], { timeout: 2000 });
  }
  for (const name of ['types', 'dev-resources']) writeFileSync(path.join(root, `${name}.js`), stripTypeScriptTypes(readFileSync(new URL(`../../src/runtime/${name}.ts`, import.meta.url), 'utf8'), { mode: 'transform' }));
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  const env: NodeJS.ProcessEnv = { HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TMPDIR: path.join(root, 'tmp'), UV_THREADPOOL_SIZE: '4' };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
  const output = execFileSync(process.execPath, [path.resolve('tests/runtime/dev-resources-special-file-fixture.mjs'), path.join(root, 'dev-resources.js')], { cwd: root, env, timeout: 3000, killSignal: 'SIGKILL', maxBuffer: 4096, encoding: 'utf8', windowsHide: true });
  const result = JSON.parse(output); expect(result).toMatchObject({ baseline: 'ordinary skill', unrelatedFile: 'responsive' });
  expect(result.reads).toHaveLength(4); expect(result.reads.every((read: { rejected: boolean; code: string }) => read.rejected && (process.platform === 'win32' ? ['resource_scope', 'EISDIR'].includes(read.code) : read.code === 'resource_scope'))).toBe(true);
});
