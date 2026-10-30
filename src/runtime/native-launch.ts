import { execFile } from 'node:child_process';
import path from 'node:path';
import { lstatSync } from 'node:fs';
import { DeliveryError, jsonBytes, object, string, type JsonObject } from './types.js';

export interface NativeLauncher { path: string; user: string }
export interface LaunchConfig { bin: string; env: NodeJS.ProcessEnv; cwd: string; args?: string[]; launcher?: NativeLauncher; catalogProvider?: string }
export function validateLauncher(launcher: NativeLauncher): void {
  if (process.platform !== 'linux' || !path.isAbsolute(launcher.path) || !/^ch-[a-z0-9][a-z0-9-]*-worker$/.test(launcher.user)) throw new Error('Invalid native identity launcher');
  for (let entry = launcher.path;; entry = path.dirname(entry)) {
    const stat = lstatSync(entry);
    if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || (entry === launcher.path ? !stat.isFile() || (stat.mode & 0o111) === 0 : !stat.isDirectory())) throw new Error('Native launcher must be root-owned and immutable to runtime identities');
    if (entry === path.dirname(entry)) break;
  }
}
export function nativeCommand(config: LaunchConfig, mode: 'app-server' | 'version' | 'resolve-project' | 'workspace'): { bin: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string } {
  if (config.catalogProvider !== undefined && !/^[a-z0-9_-]{1,80}$/.test(config.catalogProvider)) throw new Error('Invalid catalog provider');
  // The supervisor may lack access to the selected project. Only the native identity resolves/enters it.
  if (config.launcher) return { bin: '/usr/bin/sudo', args: ['-n', '-u', config.launcher.user, '--', config.launcher.path, ...(mode === 'app-server' && config.catalogProvider ? ['catalog-server', config.catalogProvider] : [mode])], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, cwd: '/' };
  if (mode === 'resolve-project' || mode === 'workspace') throw new Error('Native workspace checks require an identity launcher');
  const args = mode === 'version' ? ['--version'] : [...(config.args ?? ['app-server', '--listen', 'stdio://']), ...(config.catalogProvider ? ['-c', 'model_provider=' + JSON.stringify(config.catalogProvider)] : [])];
  return { bin: config.bin, args, env: config.env, cwd: config.cwd };
}
export async function runNativeHelper(config: LaunchConfig, mode: 'version' | 'resolve-project', input?: JsonObject, mutating = false): Promise<string> {
  const body = input === undefined ? '' : jsonBytes(input, 4096); const command = nativeCommand(config, mode);
  return new Promise((resolve, reject) => {
    const child = execFile(command.bin, command.args, { cwd: command.cwd, env: command.env, windowsHide: true, timeout: 10000, maxBuffer: 8192, encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        if (mode === 'resolve-project') {
          try {
            const detail = object(object(JSON.parse(stdout)).error);
            if (['project_not_found', 'project_not_directory', 'project_permission_denied', 'project_exists', 'project_root_unavailable', 'invalid_project_directory', 'invalid_input'].includes(String(detail.code)) && detail.delivery === 'not_sent') {
              reject(new DeliveryError(String(detail.code), string(detail.message, 'message', 2048))); return;
            }
          } catch { /* Only the fixed helper's bounded structured errors are relayed. */ }
        }
        reject(new DeliveryError(mode === 'resolve-project' ? 'project_unavailable' : 'native_launch_failed', mode === 'resolve-project' ? '项目目录检查未完成。请使用默认项目目录，或在服务管理中检查执行账号与目录权限。' : 'Native version probe failed', mutating ? 'unknown' : 'not_sent'));
      }
      else resolve(stdout);
    });
    child.stdin?.on('error', () => {}); child.stdin?.end(body);
  });
}
export async function createNativeProject(config: LaunchConfig, directory: string): Promise<JsonObject> {
  const response = object(JSON.parse(await runNativeHelper(config, 'resolve-project', { directory }, true)));
  const resolved = string(response.path, 'project.path'), name = string(response.name, 'project.name', 128);
  if (!path.isAbsolute(resolved)) throw new DeliveryError('project_unavailable', 'Native project creation returned an invalid path', 'unknown');
  return { path: resolved, name };
}
export async function resolveNativeProject(config: LaunchConfig, requested: string): Promise<JsonObject> {
  const response = object(JSON.parse(await runNativeHelper(config, 'resolve-project', { path: requested })));
  const resolved = string(response.path, 'project.path'); const name = string(response.name, 'project.name', 4096);
  if (!path.isAbsolute(resolved)) throw new DeliveryError('project_unavailable', 'Native project resolver returned an invalid path');
  return { path: resolved, name };
}
