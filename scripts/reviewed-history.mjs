import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { auditGitObjects, auditSource } from './release-audit.mjs';

// Immutable v1.2.1 objects reviewed on 2026-10-26. These contain synthetic
// negative-test inputs, generic UI placeholders, or a variable-based path.
// The raw scanner is unchanged. No exception applies to the current tree.
const reviewed = [
  ['0c26890096122d2fc01f62bbaa6c249add4c47c1', 100, 'url-credentials', 'synthetic URL rejection fixture'],
  ['117e20bd2f83d6abe680c2b893afb3be18a72f7b', 468, 'unix-private-home', 'generic project placeholder'],
  ['2ddd22ff19df38edbd242b7022d984d5e6e31829', 186, 'url-credentials', 'synthetic URL rejection fixture'],
  ['46823e5aa4bb3506742b7c8a19ba8ff9dbd9a668', 9, 'url-credentials', 'synthetic URL rejection fixture'],
  ...[33, 36, 37, 48, 52].map(line => ['62bbe9b46e31fb8b05f58eb4ff5d52ee5572c837', line, 'unix-private-home', 'synthetic ownership-path fixture']),
  ['643bc3984f0353adbd515c86ae6690916df6ed6e', 258, 'unix-private-home', 'variable-based isolated runtime path'],
  ['786459cc46ceed424b44e0b4b87a4d697005e7e3', 156, 'bearer-token', 'explicit synthetic control fixture token'],
  ['fe5959bcb16a2670d4b448f3ea07343db25165b3', 97, 'bearer-token', 'explicit synthetic verifier fixture token'],
];
export function reviewHistory(report, currentBlobs) {
  if (report.mode !== 'git-objects' || !['clean', 'blocked'].includes(report.status) || !Number.isSafeInteger(report.scannedFiles) || report.scannedFiles <= 0 || !Array.isArray(report.findings) || ['artifacts', 'unreadable', 'skipped'].some(key => !Array.isArray(report[key]) || report[key].length) || (report.status === 'clean') !== (report.findings.length === 0)) throw Error('History scan is incomplete or contains unreviewed artifacts');
  const allowed = new Map(reviewed.map(([id, line, rule, reason]) => [`git-object/${id}:${line}:${rule}`, { id, reason }]));
  const classified = [];
  for (const item of report.findings) {
    const matched = allowed.get(`${item.path}:${item.line}:${item.rule}`);
    if (!matched || currentBlobs.has(matched.id)) throw Error('An unreviewed finding or a current-source pattern blocks publication');
    classified.push({ ...item, classification: 'reviewed-historical-synthetic-pattern', reason: matched.reason });
  }
  return { status: classified.length ? 'passed-with-reviewed-historical-patterns' : 'clean', findings: [], reviewedFindings: classified, rawScannerStatus: report.status, scannedFiles: report.scannedFiles, skipped: [] };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  try {
    mkdirSync(path.join(root, '.work'), { recursive: true });
    const source = await auditSource(root);
    writeFileSync(path.join(root, '.work/source-security.json'), JSON.stringify(source, null, 2) + '\n');
    if (source.status !== 'clean') throw Error('Current source scan is not clean');
    const history = await auditGitObjects(root);
    writeFileSync(path.join(root, '.work/history-security-raw.json'), JSON.stringify(history, null, 2) + '\n');
    const entries = execFileSync('git', ['ls-tree', '-r', '--format=%(objectname)', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
    const result = reviewHistory(history, new Set(entries.trim().split('\n')));
    writeFileSync(path.join(root, '.work/history-security-reviewed.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } catch (error) { console.error('Security review blocked: ' + error.message); process.exitCode = 1; }
}
