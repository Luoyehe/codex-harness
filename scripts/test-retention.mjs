import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const allowedParents = new Set(['test-homes', 'go-test-runs']);
function owned(directory) {
  const absolute = path.resolve(directory), parent = path.dirname(absolute);
  const rootTemporary = process.platform !== 'win32' && parent === realpathSync('/tmp') && /^harness-test-root-[A-Za-z0-9]+$/.test(path.basename(absolute));
  if (!rootTemporary && (!allowedParents.has(path.basename(parent)) || path.basename(path.dirname(parent)) !== '.work' || !/^run-[A-Za-z0-9]+$/.test(path.basename(absolute)))) throw Error('Unrecognized test workspace');
  if (realpathSync(parent) !== parent || realpathSync(absolute) !== absolute || !lstatSync(absolute).isDirectory() || lstatSync(absolute).isSymbolicLink()) throw Error('Test workspace must be an ordinary local directory');
  if (rootTemporary && lstatSync(absolute).uid !== process.getuid()) throw Error('Test workspace owner changed');
  return absolute;
}
export function beginTestWorkspace(directory) {
  const target = owned(directory);
  writeFileSync(path.join(target, 'run.json'), JSON.stringify({ schemaVersion: 1, kind: 'isolated-test-workspace', pid: process.pid, status: 'running', startedAt: Date.now() }) + '\n', { flag: 'wx' });
}
export function finishTestWorkspace(directory, passed) {
  if (!existsSync(directory)) return;
  const target = owned(directory), marker = path.join(target, 'run.json');
  if (lstatSync(marker).isSymbolicLink() || lstatSync(marker).size > 4096) throw Error('Invalid test workspace ownership record');
  const record = JSON.parse(readFileSync(marker, 'utf8'));
  if (record.kind !== 'isolated-test-workspace' || record.pid !== process.pid || record.status !== 'running') throw Error('Test workspace ownership changed');
  writeFileSync(marker, JSON.stringify({ ...record, status: passed ? 'passed' : 'failed', completedAt: Date.now() }) + '\n');
  if (passed) {
    // Only this run's dedicated directory is removed, after all children exited.
    rmSync(target, { recursive: true });
  }
  const parent = path.dirname(target), completed = [];
  const namePattern = path.basename(target).startsWith('harness-test-root-') ? /^harness-test-root-[A-Za-z0-9]+$/ : /^run-[A-Za-z0-9]+$/;
  for (const item of readdirSync(parent, { withFileTypes: true })) {
    if (!item.isDirectory() || item.isSymbolicLink() || !namePattern.test(item.name)) continue;
    const candidate = path.join(parent, item.name), file = path.join(candidate, 'run.json');
    if (process.getuid && lstatSync(candidate).uid !== process.getuid()) continue;
    if (!existsSync(file) || lstatSync(file).isSymbolicLink() || lstatSync(file).size > 4096) continue;
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      if (value.kind === 'isolated-test-workspace' && ['passed', 'failed'].includes(value.status) && Number.isFinite(value.completedAt)) completed.push({ candidate, completedAt: value.completedAt });
    } catch { /* Unrecognized diagnostics are retained for inspection. */ }
  }
  // Keep three finalized diagnostic workspaces; active/unknown/old unmarked
  // directories never qualify. Per-case reports are stored separately.
  for (const value of completed.sort((a, b) => b.completedAt - a.completedAt).slice(3)) {
    rmSync(owned(value.candidate), { recursive: true });
  }
}
