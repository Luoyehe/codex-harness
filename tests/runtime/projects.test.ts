import { expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createProject, resolveProject, projectDirectory } from '../../src/runtime/projects.js';
import { DeliveryError } from '../../src/runtime/types.js';

test('new projects use the managed native home and are immediately readable/writable', async () => {
  const parent = path.resolve('.work/project-tests'); await mkdir(parent, { recursive: true });
  const home = await mkdtemp(path.join(parent, 'native-')), before = vi.fn();
  const config = { bin: process.execPath, env: {}, cwd: '/' };
  const created = await createProject(config, home, '我的项目', before);
  expect(before).toHaveBeenCalledOnce(); expect(created.path).toBe(path.join(home, 'projects', '我的项目'));
  await writeFile(path.join(String(created.path), 'test.txt'), 'editable');
  expect(await readFile(path.join(String(created.path), 'test.txt'), 'utf8')).toBe('editable');
  expect(await resolveProject(config, String(created.path))).toEqual(created);
  await expect(createProject(config, home, '我的项目', before)).rejects.toMatchObject({ code: 'project_exists', delivery: 'not_sent' });
});

test('project creation validates directory names and the live owner before creating anything', async () => {
  const parent = path.resolve('.work/project-tests'); await mkdir(parent, { recursive: true });
  const home = await mkdtemp(path.join(parent, 'owner-')), config = { bin: process.execPath, env: {}, cwd: home };
  for (const name of ['..', '../outside', '/outside', 'a/b', 'a\\b', 'CON', 'name.', 'name ', 'a\nname', 'a'.repeat(81)]) expect(() => projectDirectory(name)).toThrow();
  await expect(createProject(config, home, 'project', () => { throw new DeliveryError('client_disconnected', 'gone'); })).rejects.toMatchObject({ code: 'client_disconnected' });
  await expect(stat(path.join(home, 'projects'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('existing-directory errors distinguish a missing path and an ordinary file', async () => {
  const parent = path.resolve('.work/project-tests'); await mkdir(parent, { recursive: true });
  const home = await mkdtemp(path.join(parent, 'existing-')), config = { bin: process.execPath, env: {}, cwd: home };
  await writeFile(path.join(home, 'file'), 'unchanged');
  await expect(resolveProject(config, path.join(home, 'missing'))).rejects.toMatchObject({ code: 'project_not_found', delivery: 'not_sent' });
  await expect(resolveProject(config, path.join(home, 'file'))).rejects.toMatchObject({ code: 'project_not_directory', delivery: 'not_sent' });
});

test('an occupied managed root is a definite actionable failure and never an unknown project creation', async () => {
  const parent = path.resolve('.work/project-tests'); await mkdir(parent, { recursive: true });
  const home = await mkdtemp(path.join(parent, 'occupied-')), config = { bin: process.execPath, env: {}, cwd: home };
  await writeFile(path.join(home, 'projects'), 'keep this file');
  await expect(createProject(config, home, 'new', () => {})).rejects.toMatchObject({ code: 'project_root_unavailable', delivery: 'not_sent' });
  expect(await readFile(path.join(home, 'projects'), 'utf8')).toBe('keep this file');
});
