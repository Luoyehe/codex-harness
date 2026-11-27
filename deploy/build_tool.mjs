// All build paths use the bin declared by the installed, version-pinned package.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function buildTool(base, command) {
  const name = { tsc: 'typescript', vite: 'vite' }[command];
  if (typeof name !== 'string') throw Error('Unknown build tool');
  const expected = JSON.parse(readFileSync(path.join(base, 'package.json'), 'utf8')).devDependencies?.[name];
  const modules = realpathSync(path.join(base, 'node_modules'));
  const directory = realpathSync(path.join(modules, name));
  const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
  if (!directory.startsWith(modules + path.sep) || manifest.name !== name || typeof expected !== 'string' || manifest.version !== expected)
    throw Error('Installed build tool differs from package pin: ' + name);
  const entry = typeof manifest.bin === 'string' && name === command ? manifest.bin : manifest.bin?.[command];
  if (typeof entry !== 'string' || !entry || path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..'))
    throw Error('Invalid build tool command: ' + command);
  const executable = realpathSync(path.join(directory, entry));
  if (!executable.startsWith(directory + path.sep) || !statSync(executable).isFile())
    throw Error('Build tool entry outside its package: ' + command);
  return executable;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = spawnSync(process.execPath, [buildTool(process.cwd(), process.argv[2]), ...process.argv.slice(3)],
      { stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
