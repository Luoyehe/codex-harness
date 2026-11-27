import { existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const allowedParents = new Set(['test-homes', 'go-test-runs']);
function owned(directory) {
  const absolute = path.resolve(directory), parent = path.dirname(absolute);
  const rootTemporary = parent === realpathSync('/tmp') && /^harness-test-root-[A-Za-z0-9]+$/.test(path.basename(absolute));
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

/** Retain six finished reports per outcome, including failures, across local runs. */
export function withTestReport(base, kind, execute) {
  if (!['vitest', 'python'].includes(kind)) throw Error('Invalid report kind');
  const root = realpathSync(base);
  for (const dir of [path.join(root, '.work'), path.join(root, '.work/test-results')]) {
    try { mkdirSync(dir); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (realpathSync(dir) !== dir || !lstatSync(dir).isDirectory()) throw Error('Unrecognized report directory');
  }
  const parent = path.join(root, '.work/test-results');
  const directory = mkdtempSync(path.join(parent, kind === 'vitest' ? 'run-' : 'python-'));
  const report = kind === 'vitest' ? 'vitest.json' : 'cases.json';
  const marker = { kind: 'harness-test-report-v1', report, owner: path.basename(directory), pid: process.pid };
  const active = path.join(directory, 'running.json');
  writeFileSync(active, JSON.stringify(marker), { flag: 'wx' });
  let outcome = 'failed';
  try {
    const result = execute(path.join(directory, report));
    outcome = result.status === 'passed' ? 'passed' : 'failed';
    return result;
  } finally {
    writeFileSync(active, JSON.stringify({ ...marker, outcome, completedAt: Date.now() }));
    renameSync(active, path.join(directory, 'complete.json'));
    const completed = [];
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^(?:run|python)-[a-zA-Z0-9]+$/.test(entry.name)) continue;
      const candidate = path.join(parent, entry.name);
      try {
        const filename = path.join(candidate, 'complete.json'), info = lstatSync(filename);
        if (!info.isFile() || info.nlink !== 1 || info.size > 4096 || (process.getuid && info.uid !== process.getuid())) continue;
        const saved = JSON.parse(readFileSync(filename, 'utf8'));
        if (saved.kind !== marker.kind || saved.owner !== entry.name || saved.outcome !== outcome ||
            !Number.isSafeInteger(saved.completedAt) || !['vitest.json', 'cases.json'].includes(saved.report)) continue;
        if (readdirSync(candidate).some(name => name !== 'complete.json' && name !== saved.report)) continue;
        completed.push({ candidate, time: saved.completedAt });
      } catch { /* Another collector may already have removed this finalized report. */ }
    }
    completed.sort((a, b) => Number(b.candidate === directory) - Number(a.candidate === directory) || b.time - a.time || b.candidate.localeCompare(a.candidate));
    for (const old of completed.slice(6)) {
      if (old.candidate !== directory) rmSync(old.candidate, { recursive: true, force: true });
    }
  }
}
