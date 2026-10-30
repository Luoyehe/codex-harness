import path from 'node:path';
import { access, lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createNativeProject, resolveNativeProject, type LaunchConfig } from './native-launch.js';
import { DeliveryError, jsonBytes, string, type JsonObject } from './types.js';

/** Production uses Linux path syntax regardless of the supervisor test platform. */
export function projectPath(value: unknown, paths = path.posix): string {
  const requested = string(value, 'project path', 4096);
  if (/[\u0000-\u001f\u007f]/.test(requested)) throw new DeliveryError('invalid_project_directory', '项目路径不能包含控制字符。');
  const normalized = paths.normalize(requested), root = paths.parse(normalized).root;
  return normalized.length > root.length ? normalized.replace(paths === path.win32 ? /[\\/]+$/ : /\/+$/, '') : normalized;
}

export async function resolveProject(config: LaunchConfig, requested: string, nativeHome = config.cwd): Promise<JsonObject> {
  const paths = !config.launcher && process.platform === 'win32' ? path.win32 : path.posix;
  const selected = projectPath(requested, paths);
  jsonBytes({ path: selected }, 4096);
  if (config.launcher) return resolveNativeProject(config, selected);
  try {
    const target = paths.isAbsolute(selected) ? selected : path.resolve(nativeHome, 'projects', selected);
    const resolved = await realpath(target), info = await stat(resolved);
    if (!info.isDirectory()) throw new DeliveryError('project_not_directory', '所选路径不是目录。');
    await access(resolved, constants.R_OK | (process.platform === 'win32' ? 0 : constants.X_OK));
    return { path: resolved, name: path.basename(resolved) || resolved };
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new DeliveryError('project_not_found', '此目录不存在。请使用“新建项目”，或填写已有目录。');
    if (code === 'ENOTDIR') throw new DeliveryError('project_not_directory', '路径中的某一段不是目录，请检查所填路径。');
    if (code === 'EACCES' || code === 'EPERM') throw new DeliveryError('project_permission_denied', '项目执行账号无法进入或读取此目录及其父目录。请让管理员调整目录权限，或先在服务器授权、再在网页开启 ROOT 模式。');
    if (code === 'ENAMETOOLONG' || code === 'EINVAL') throw new DeliveryError('invalid_project_directory', '此路径超出系统长度限制或包含系统不支持的名称。');
    throw new DeliveryError('project_unavailable', '无法读取项目目录，请检查路径和执行账号权限。');
  }
}

export async function createProject(config: LaunchConfig, nativeHome: string, requested: unknown, beforeWrite: () => void): Promise<JsonObject> {
  const paths = !config.launcher && process.platform === 'win32' ? path.win32 : path.posix;
  const directory = projectPath(requested, paths), absolute = paths.isAbsolute(directory);
  if (absolute && directory === paths.parse(directory).root) throw new DeliveryError('invalid_project_directory', '根目录已存在，不能作为新项目创建。');
  // The fixed helper reads at most 4096 bytes, including JSON syntax/escaping.
  jsonBytes({ directory }, 4096);
  beforeWrite();
  if (config.launcher) return createNativeProject(config, directory);
  const root = path.join(nativeHome, 'projects');
  const project = absolute ? directory : path.resolve(root, directory);
  let created = false, rootReady = absolute, checkingParent = false;
  try {
    if (!absolute) {
      await mkdir(root, { mode: 0o700, recursive: true });
      if ((await lstat(root)).isSymbolicLink()) throw new DeliveryError('project_root_unavailable', '默认项目目录不可用，请联系服务器管理员。');
      rootReady = true;
    }
    checkingParent = true;
    if (!(await stat(path.dirname(project))).isDirectory()) throw new DeliveryError('project_parent_unavailable', '父路径不是目录，无法创建项目。');
    if (process.platform !== 'win32') await access(path.dirname(project), constants.X_OK);
    checkingParent = false;
    await mkdir(project, { mode: 0o700 }); created = true;
    const resolved = await realpath(project);
    return { path: resolved, name: path.basename(resolved) || resolved };
  } catch (error) {
    if (created) throw new DeliveryError('project_creation_failed', '项目目录可能已经创建，但确认未完成。请检查所填路径后再操作。', 'unknown');
    if (error instanceof DeliveryError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (!rootReady && (code === 'EEXIST' || code === 'ENOTDIR' || code === 'ELOOP')) throw new DeliveryError('project_root_unavailable', '默认项目目录被文件或无效链接占用，请联系服务器管理员。');
    if (code === 'EEXIST') throw new DeliveryError('project_exists', '此路径已存在，请填写其他新路径，或使用“添加已有目录”。');
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new DeliveryError('project_parent_unavailable', '父目录不存在或父路径不是目录，请先创建正确的父目录。');
    if (code === 'EACCES' || code === 'EPERM') throw new DeliveryError('project_permission_denied', (checkingParent ? '项目执行账号无法进入父目录。' : '父目录对项目执行账号不可写。') + '请让管理员调整目录权限，或先在服务器授权、再在网页开启 ROOT 模式。');
    if (code === 'EROFS') throw new DeliveryError('project_read_only', '父目录所在文件系统为只读，无法创建项目；切换 ROOT 模式不能改变只读挂载。');
    if (code === 'ENAMETOOLONG' || code === 'EINVAL') throw new DeliveryError('invalid_project_directory', '此路径超出系统长度限制或包含系统不支持的名称。');
    throw new DeliveryError('project_creation_failed', '项目创建结果尚未确认，请检查所填路径后再操作。', 'unknown');
  }
}
