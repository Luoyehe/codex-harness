import { expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createProject, resolveProject, projectPath } from '../../src/runtime/projects.js';
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

test('project creation validates bounded paths and the live owner before creating anything', async () => {
  const parent = path.resolve('.work/project-tests'); await mkdir(parent, { recursive: true });
  const home = await mkdtemp(path.join(parent, 'owner-')), config = { bin: process.execPath, env: {}, cwd: home };
  for (const name of ['', 'a\nname', 'a\0name', '\ud800', 'a'.repeat(4097)]) expect(() => projectPath(name)).toThrow();
  const before = vi.fn();
  await expect(createProject(config, home, '/', before)).rejects.toMatchObject({ code: 'invalid_project_directory', delivery: 'not_sent' });
  expect(before).not.toHaveBeenCalled();
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

test('relative notation and parent segments use the default projects base without restricting paths to one level', async () => {
  const parent = path.resolve('.work/project-tests'); await mkdir(parent, { recursive: true });
  const home = await mkdtemp(path.join(parent, 'relative-')), config = { bin: process.execPath, env: {}, cwd: home };
  for (const [input, name] of [['./first', 'first'], ['second/', 'second'], ['./third///', 'third']]) {
    const created = await createProject(config, home, input, () => {});
    expect(created).toEqual({ path: path.join(home, 'projects', name!), name });
    expect((await stat(String(created.path))).isDirectory()).toBe(true);
  }
  expect(await createProject(config, home, 'first/./nested/../child/', () => {})).toEqual({ path: path.join(home, 'projects', 'first', 'child'), name: 'child' });
  const sibling = await createProject(config, home, '../sibling/', () => {});
  expect(sibling).toEqual({ path: path.join(home, 'sibling'), name: 'sibling' });
  expect(await resolveProject(config, '../sibling/', home)).toEqual(sibling);
  await expect(createProject(config, home, 'missing/child', () => {})).rejects.toMatchObject({ code: 'project_parent_unavailable', delivery: 'not_sent' });
  await expect(stat(path.join(home, 'projects', 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('Linux paths keep absolute or relative meaning and permit ordinary POSIX names', () => {
  for (const [input, normalized] of [
    ['//srv///projects/../new folder///', '/srv/new folder'], ['./a/./b/../c/', 'a/c'], ['a/../../next', '../next'],
    ['/srv/CON', '/srv/CON'], ['/srv/name\\child', '/srv/name\\child'], ['name. ', 'name. '], [' ', ' '],
    ['./', '.'], ['../', '..'], ['/a/../', '/'], ['项'.repeat(100), '项'.repeat(100)],
  ]) expect(projectPath(input)).toBe(normalized);
});

test('absolute creation leaves the unused default root untouched and never recursively creates a missing parent', async () => {
  const parent = path.resolve('.work/project-tests'); await mkdir(parent, { recursive: true });
  const home = await mkdtemp(path.join(parent, 'absolute-')), config = { bin: process.execPath, env: {}, cwd: home };
  const target = path.join(home, 'absolute project');
  expect(await createProject(config, home, target, () => {})).toEqual({ path: target, name: 'absolute project' });
  await expect(stat(path.join(home, 'projects'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(createProject(config, home, path.join(home, 'absent', 'child'), () => {})).rejects.toMatchObject({ code: 'project_parent_unavailable', delivery: 'not_sent' });
  await expect(stat(path.join(home, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(path.join(home, 'file'), 'keep');
  await expect(createProject(config, home, path.join(home, 'file', 'child'), () => {})).rejects.toMatchObject({ code: 'project_parent_unavailable', delivery: 'not_sent' });
  await expect(createProject(config, home, path.join(home, 'file'), () => {})).rejects.toMatchObject({ code: 'project_exists', delivery: 'not_sent' });
  expect(await readFile(path.join(home, 'file'), 'utf8')).toBe('keep');
});

test('resolving relative existing projects is read-only even when the default projects root is absent', async () => {
  const parent = path.resolve('.work/project-tests'); await mkdir(parent, { recursive: true });
  const home = await mkdtemp(path.join(parent, 'resolve-')), config = { bin: process.execPath, env: {}, cwd: home };
  await mkdir(path.join(home, 'existing'));
  expect(await resolveProject(config, '../existing/', home)).toEqual({ path: path.join(home, 'existing'), name: 'existing' });
  await expect(resolveProject(config, 'missing', home)).rejects.toMatchObject({ code: 'project_not_found', delivery: 'not_sent' });
  await expect(stat(path.join(home, 'projects'))).rejects.toMatchObject({ code: 'ENOENT' });
});
