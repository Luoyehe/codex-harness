import path from 'node:path';
import { access, lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createNativeProject, resolveNativeProject, type LaunchConfig } from './native-launch.js';
import { DeliveryError, string, type JsonObject } from './types.js';

export function projectDirectory(value: unknown): string {
  const directory = string(value, 'directory', 320);
  if (Array.from(directory).length > 80 || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(directory) || /[ .]$/.test(directory) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(directory))
    throw new DeliveryError('invalid_project_directory', '目录名应为 1–80 个字母、数字、空格、点、下划线或短横线，不能包含路径。');
  return directory;
}

export async function resolveProject(config: LaunchConfig, requested: string): Promise<JsonObject> {
  if (config.launcher) return resolveNativeProject(config, requested);
  try {
    const resolved = await realpath(requested), info = await stat(resolved);
    if (!info.isDirectory()) throw new DeliveryError('project_not_directory', '所选路径不是目录。');
    await access(resolved, constants.R_OK | (process.platform === 'win32' ? 0 : constants.X_OK));
    return { path: resolved, name: path.basename(resolved) || resolved };
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new DeliveryError('project_not_found', '此目录不存在。请使用“新建项目”，或填写已有目录。');
    if (code === 'EACCES' || code === 'EPERM') throw new DeliveryError('project_permission_denied', '项目执行账号无法访问此目录或其父目录。请选择可访问目录，或使用“新建项目”。');
    throw new DeliveryError('project_unavailable', '无法读取项目目录，请检查路径和执行账号权限。');
  }
}

export async function createProject(config: LaunchConfig, nativeHome: string, requested: unknown, beforeWrite: () => void): Promise<JsonObject> {
  const directory = projectDirectory(requested);
  beforeWrite();
  if (config.launcher) return createNativeProject(config, directory);
  const root = path.join(nativeHome, 'projects');
  let created = false, rootReady = false;
  try {
    await mkdir(root, { mode: 0o700, recursive: true });
    if ((await lstat(root)).isSymbolicLink()) throw new DeliveryError('project_root_unavailable', '默认项目目录不可用，请联系服务器管理员。');
    rootReady = true;
    const project = path.join(root, directory);
    await mkdir(project, { mode: 0o700 }); created = true;
    return { path: await realpath(project), name: directory };
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (!rootReady && (code === 'EEXIST' || code === 'ENOTDIR' || code === 'ELOOP')) throw new DeliveryError('project_root_unavailable', '默认项目目录被文件或无效链接占用，请联系服务器管理员。');
    if (!created && code === 'EEXIST') throw new DeliveryError('project_exists', '同名目录已存在，请换一个目录名，或使用“添加已有目录”。');
    if (!created && (code === 'EACCES' || code === 'EPERM')) throw new DeliveryError('project_permission_denied', '默认项目目录不可写，请检查实例的项目目录权限。');
    throw new DeliveryError('project_creation_failed', '项目创建结果尚未确认，请检查默认项目目录后再操作。', 'unknown');
  }
}
