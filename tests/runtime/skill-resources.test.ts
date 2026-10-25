import { beforeEach, expect, test, vi } from 'vitest';
import { workspaceRequest } from '../../src/runtime/workspace.js';
import { previewProjectPlugin, readSkillResource, resolveProjectDirectory } from '../../src/runtime/skill-resources.js';
const fixture = vi.hoisted(() => ({ result: {} as Record<string, unknown>, calls: [] as unknown[][] }));
vi.mock('../../src/runtime/workspace.js', async original => ({ ...await original<typeof import('../../src/runtime/workspace.js')>(), runWorkspace: vi.fn(async (...args: unknown[]) => { fixture.calls.push(args); return fixture.result; }) }));
const root = { path: '/registered/project' };
const config = { bin: '/native', cwd: '/', env: {} };
const context = { clientId: 'fixture', beforeWrite: vi.fn() };
beforeEach(() => { fixture.calls = []; context.beforeWrite.mockClear(); });

test('skill resource validates exact bounded response and never consumes a write boundary', async () => {
  const path = '/native/codex/skills/example/SKILL.md';
  fixture.result = { path, text: 'skill', bytes: 5, revision: 'a'.repeat(64) };
  await expect(readSkillResource(config, root, { path, name: 'example' }, context)).resolves.toEqual(fixture.result);
  expect(fixture.calls[0]?.slice(1, 4)).toEqual([root, 'resource/skill/read', { path }]);
  expect(context.beforeWrite).not.toHaveBeenCalled();
  for (const changed of [{ path: '/other/SKILL.md' }, { bytes: 1 }, { text: 'x\0y', bytes: 3 }, { revision: 'bad' }, { text: 'x'.repeat(512 * 1024 + 1) }]) {
    fixture.result = { path, text: 'skill', bytes: 5, revision: 'a'.repeat(64), ...changed };
    await expect(readSkillResource(config, root, { path }, context)).rejects.toThrow();
  }
});

test('resource envelopes reject arbitrary resources, root lists and mutation identity', () => {
  for (const path of ['/native/auth.json', '/native/../SKILL.md', '/native/.git/SKILL.md', 'relative/SKILL.md']) expect(() => workspaceRequest(root, 'resource/skill/read', { path }, context)).toThrow();
  expect(() => workspaceRequest(root, 'resource/skill/read', { path: '/native/skills/a/SKILL.md', allowedRoots: ['/'] }, context)).toThrow();
  expect(workspaceRequest(root, 'resource/skill/read', { path: '/native/skills/a/SKILL.md' }, { ...context, operationId: '00000000-0000-0000-0000-000000000000' })).not.toHaveProperty('operationId');
});

test('project directory preflight requires exact canonical scoped path and integer identity', async () => {
  fixture.result = { path: '/registered/project/marketplace', device: 1, inode: 2 };
  await expect(resolveProjectDirectory(config, root, 'marketplace', context)).resolves.toEqual(fixture.result);
  for (const result of [{ path: '/outside', device: 1, inode: 2 }, { path: '/registered/project/marketplace', device: 1, inode: -1 }]) {
    fixture.result = result;
    await expect(resolveProjectDirectory(config, root, 'marketplace', context)).rejects.toThrow();
  }
  for (const path of ['../outside', '/absolute', 'a\\b']) expect(() => workspaceRequest(root, 'resource/directory/resolve', { path }, context)).toThrow();
});

test('plugin preview validates unique bounded relative inventory and total bytes', async () => {
  const valid = { path: '/registered/project/plugin', revision: 'a'.repeat(64), files: [{ path: 'skills/example/SKILL.md', bytes: 5, sha256: 'b'.repeat(64) }], totalBytes: 5 };
  fixture.result = valid;
  await expect(previewProjectPlugin(config, root, 'plugin', context)).resolves.toEqual(valid);
  for (const changed of [{ totalBytes: 6 }, { path: '/outside' }, { files: [...valid.files, ...valid.files], totalBytes: 10 }, { files: [{ ...valid.files[0], path: '../outside' }] }, { files: [{ ...valid.files[0], bytes: 2 * 1024 * 1024 + 1 }] }]) {
    fixture.result = { ...valid, ...changed };
    await expect(previewProjectPlugin(config, root, 'plugin', context)).rejects.toThrow();
  }
});
