import { buildTool } from '../deploy/build_tool.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function cleanBuildDirectory(base) {
  const directory = path.join(realpathSync(base), 'dist');
  if (existsSync(directory)) {
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory) throw Error('Build output must be an ordinary local dist directory');
    rmSync(directory, { recursive: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = fileURLToPath(new URL('..', import.meta.url));
  try {
    cleanBuildDirectory(base);
    const compiler = buildTool(base, 'tsc');
    const result = spawnSync(process.execPath, [compiler, '-p', 'tsconfig.server.json'], { cwd: base, stdio: 'inherit', windowsHide: true });
    if (result.error || result.status !== 0) { cleanBuildDirectory(base); process.exitCode = result.status || 1; }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
