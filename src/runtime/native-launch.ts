import { execFile } from 'node:child_process';
import path from 'node:path';
import { lstatSync } from 'node:fs';
import { DeliveryError, jsonBytes, object, string, type JsonObject } from './types.js';

export interface NativeLauncher { path: string; user: string }
export interface LaunchConfig { bin: string; env: NodeJS.ProcessEnv; cwd: string; args?: string[]; launcher?: NativeLauncher }
export function validateLauncher(launcher: NativeLauncher): void {
  if (process.platform !== 'linux' || !path.isAbsolute(launcher.path) || !/^ch-[a-z0-9][a-z0-9-]*-worker$/.test(launcher.user)) throw new Error('Invalid native identity launcher');
  for (let entry = launcher.path;; entry = path.dirname(entry)) {
    const stat = lstatSync(entry);
    if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || (entry === launcher.path ? !stat.isFile() || (stat.mode & 0o111) === 0 : !stat.isDirectory())) throw new Error('Native launcher must be root-owned and immutable to runtime identities');
    if (entry === path.dirname(entry)) break;
  }
}
export function nativeCommand(config: LaunchConfig, mode: 'app-server' | 'version' | 'resolve-project' | 'workspace'): { bin: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string } {
  // The supervisor may lack access to the selected project. Only the native identity resolves/enters it.
  if (config.launcher) return { bin: '/usr/bin/sudo', args: ['-n', '-u', config.launcher.user, '--', config.launcher.path, mode], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, cwd: '/' };
  if (mode === 'resolve-project' || mode === 'workspace') throw new Error('Native workspace checks require an identity launcher');
  return { bin: config.bin, args: mode === 'version' ? ['--version'] : config.args ?? ['app-server', '--listen', 'stdio://'], env: config.env, cwd: config.cwd };
}
export async function runNativeHelper(config: LaunchConfig, mode: 'version' | 'resolve-project', input?: JsonObject): Promise<string> {
  const body = input === undefined ? '' : jsonBytes(input, 4096); const command = nativeCommand(config, mode);
  return new Promise((resolve, reject) => {
    const child = execFile(command.bin, command.args, { cwd: command.cwd, env: command.env, windowsHide: true, timeout: 10000, maxBuffer: 8192, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(new DeliveryError(mode === 'resolve-project' ? 'project_unavailable' : 'native_launch_failed', mode === 'resolve-project' ? 'Native identity cannot access this project directory' : 'Native version probe failed'));
      else resolve(stdout);
    });
    child.stdin?.on('error', () => {}); child.stdin?.end(body);
  });
}
export async function resolveNativeProject(config: LaunchConfig, requested: string): Promise<JsonObject> {
  const response = object(JSON.parse(await runNativeHelper(config, 'resolve-project', { path: requested })));
  const resolved = string(response.path, 'project.path'); const name = string(response.name, 'project.name', 4096);
  if (!path.isAbsolute(resolved)) throw new DeliveryError('project_unavailable', 'Native project resolver returned an invalid path');
  return { path: resolved, name };
}
