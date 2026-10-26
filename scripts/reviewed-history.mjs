import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { auditGitObjects, auditSource } from './release-audit.mjs';

// Immutable pre-rewrite objects reviewed on 2026-10-26, including every remote
// branch/tag from a complete non-shallow fetch. These contain synthetic
// negative-test inputs, generic UI placeholders, or a variable-based path.
// The raw scanner is unchanged. No exception applies to the current tree.
const reviewed = [
  ['34f712d10da2d49ded5792f88334fa3e88dd7f35', 148, 'url-credentials', 'synthetic URL rejection fixture'],
  ...[33, 36, 37, 48, 52].map(line => ['36e534c51f01c64088874bb1c2b6b41b651b3687', line, 'unix-private-home', 'synthetic ownership-path fixture']),
  ['3be2ce24dd43a73555c2b10d07111a1fe82c9454', 164, 'unix-private-home', 'generic isolated directory comment'],
  ['3be2ce24dd43a73555c2b10d07111a1fe82c9454', 187, 'unix-private-home', 'variable-based isolated runtime path'],
  ['4ab3f14b36439cb963a08830a035fb23a4b42d3f', 105, 'url-credentials', 'synthetic URL rejection fixture'],
  ['52a2424cf24886407113d0ae0e4aea295cf03b42', 192, 'url-credentials', 'synthetic URL rejection fixture'],
  ['631e00e606de5966bde41fe3628331217baf2010', 262, 'unix-private-home', 'generic project placeholder'],
  ['742ca49323da9d7b208c49345eb7d13c899fa8d4', 267, 'unix-private-home', 'generic project placeholder'],
  ['8ee502f6dbd4d9499002cb51e4b7dadac6867ecf', 9, 'url-credentials', 'synthetic URL rejection fixture'],
  ['a4ae37460e0e222db1a980f6edaffbfa73ed1c53', 468, 'unix-private-home', 'generic project placeholder'],
  ['ac2d27c7cc90c3e88f879518be4e3f2997cb0a2f', 9, 'url-credentials', 'synthetic URL rejection fixture'],
  ['c25e5f88bccdcc6eadff10fd1936423232b8052b', 324, 'unix-private-home', 'variable-based isolated runtime path'],
  ['c847c1840ebf092445a327d61731182b8bec20dc', 528, 'unix-private-home', 'generic project placeholder'],
  ['eb45e31df7703e3815d8fc9ac1beabd291dd1850', 105, 'url-credentials', 'synthetic URL rejection fixture'],
  ['fe572dd7a7b81c4a35aac7fb6b0d385e8b332a91', 36, 'literal-secret', 'explicit synthetic initial-password fixture'],
  ['feb18044be44394add8a284895502eea4065a73b', 267, 'unix-private-home', 'generic project placeholder'],
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
