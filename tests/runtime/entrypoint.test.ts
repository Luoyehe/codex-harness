import { test, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';

test('the compiled worker entrypoint executes through the activated release directory link', () => {
  const root = process.cwd(); mkdirSync(path.join(root, '.work'), { recursive: true });
  const temporary = mkdtempSync(path.join(root, '.work/entrypoint-'));
  const app = path.join(temporary, 'release/app'); mkdirSync(app, { recursive: true });
  try {
    execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, 'tsconfig.server.json'), '--outDir', path.join(app, 'dist')], { cwd: root, timeout: 30000, windowsHide: true, stdio: 'pipe' });
    copyFileSync(path.join(root, 'package.json'), path.join(app, 'package.json'));
    mkdirSync(path.join(app, 'protocol/json'), { recursive: true });
    copyFileSync(path.join(root, 'protocol/json/codex_app_server_protocol.v2.schemas.json'), path.join(app, 'protocol/json/codex_app_server_protocol.v2.schemas.json'));
    symlinkSync(path.join(temporary, 'release'), path.join(temporary, 'current'), process.platform === 'win32' ? 'junction' : 'dir');
    const env = { PATH: path.dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
    for (const release of ['release', 'current']) {
      const child = spawnSync(process.execPath, [path.join(temporary, release, 'app/dist/src/runtime/main.js')], { cwd: temporary, env, timeout: 10000, windowsHide: true, encoding: 'utf8' });
      // Deliberately missing runtime configuration must reach the startup guard,
      // with no CLI started; silently importing then exiting 0 is a broken service.
      expect(child.error).toBeUndefined(); expect(child.status).toBe(1);
      expect(child.stderr).toContain('Worker startup failed.');
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 45000);
