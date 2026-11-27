import { afterAll, beforeAll, test, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildTool } from '../../deploy/build_tool.mjs';

const root = process.cwd();
let temporary: string;
let app: string;
beforeAll(() => {
  mkdirSync(path.join(root, '.work'), { recursive: true });
  temporary = mkdtempSync(path.join(root, '.work/entrypoint-'));
  app = path.join(temporary, 'release/app'); mkdirSync(app, { recursive: true });
  execFileSync(process.execPath, [buildTool(root, 'tsc'), '-p', path.join(root, 'tsconfig.server.json'), '--outDir', path.join(app, 'dist')], { cwd: root, timeout: 30000, stdio: 'pipe' });
  copyFileSync(path.join(root, 'package.json'), path.join(app, 'package.json'));
  mkdirSync(path.join(app, 'protocol/json'), { recursive: true });
  copyFileSync(path.join(root, 'protocol/json/codex_app_server_protocol.v2.schemas.json'), path.join(app, 'protocol/json/codex_app_server_protocol.v2.schemas.json'));
  symlinkSync(path.join(temporary, 'release'), path.join(temporary, 'current'), 'dir');
}, 45000);
afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });

test('the compiled worker entrypoint executes through the activated release directory link', () => {
  const env = { PATH: path.dirname(process.execPath) };
  for (const release of ['release', 'current']) {
    const child = spawnSync(process.execPath, [path.join(temporary, release, 'app/dist/src/runtime/main.js')], { cwd: temporary, env, timeout: 10000, encoding: 'utf8' });
    // Deliberately missing runtime configuration must reach the startup guard,
    // with no CLI started; silently importing then exiting 0 is a broken service.
    expect(child.error).toBeUndefined(); expect(child.status).toBe(1);
    expect(child.stderr).toContain('Worker startup failed.');
  }
});

test.each([
  { mask: '0002', file: 0o644, directory: 0o755 },
  { mask: '0077', file: 0o600, directory: 0o700 },
])('development worker children create native history safely under caller umask $mask', ({ mask, file, directory }) => {
  const home = realpathSync(mkdtempSync('/tmp/harness-worker-mask-'));
  try {
    const bin = path.join(home, 'probe');
    // The first native invocation runs before the app-server starts. Observe
    // its actual file and directory permissions without starting a provider.
    writeFileSync(bin, '#!/bin/sh\n: > "$HOME/rollout"\nmkdir "$HOME/sessions"\nexit 1\n', { mode: 0o700 });
    const workerHome = path.join(home, 'worker');
    const env = { PATH: '/usr/bin:/bin', HARNESS_DEV: '1', HARNESS_CODEX_BIN: bin,
      HARNESS_WORKER_HOME: workerHome, HARNESS_CODEX_HOME: path.join(home, 'codex'),
      HARNESS_WORKER_SOCKET: path.join(home, 'worker.sock') };
    const entry = path.join(app, 'dist/src/runtime/main.js');
    const child = spawnSync('/bin/sh', ['-c', 'umask "$1"; exec "$2" "$3"', 'sh', mask, process.execPath, entry],
      { cwd: home, env, timeout: 10000, encoding: 'utf8' });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(1);
    expect(statSync(path.join(workerHome, 'rollout')).mode & 0o777).toBe(file);
    expect(statSync(path.join(workerHome, 'sessions')).mode & 0o777).toBe(directory);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
