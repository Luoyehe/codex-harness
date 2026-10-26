import { expect, test } from 'vitest';
import { reviewHistory } from '../../scripts/reviewed-history.mjs';
const historical = { path: 'git-object/0c26890096122d2fc01f62bbaa6c249add4c47c1', line: 100, rule: 'url-credentials' };
const report = { mode: 'git-objects', status: 'blocked', scannedFiles: 8, findings: [historical], artifacts: [], unreadable: [], skipped: [] };
test('only exact reviewed immutable historical findings are classified, with raw diagnostics retained', () => {
  expect(reviewHistory(report, new Set())).toMatchObject({ status: 'passed-with-reviewed-historical-patterns', rawScannerStatus: 'blocked', reviewedFindings: [expect.objectContaining(historical)] });
  for (const changed of [{ ...historical, line: 101 }, { ...historical, rule: 'private-key' }, { ...historical, path: 'git-object/' + 'b'.repeat(40) }]) expect(() => reviewHistory({ ...report, findings: [changed] }, new Set())).toThrow();
  expect(() => reviewHistory(report, new Set([historical.path.slice(11)]))).toThrow();
});
test('unknown historical artifacts, unreadable objects, skips and partial scans never pass', () => {
  for (const key of ['artifacts', 'unreadable', 'skipped']) expect(() => reviewHistory({ ...report, [key]: [{}] }, new Set())).toThrow();
  expect(() => reviewHistory({ ...report, status: 'incomplete' }, new Set())).toThrow();
  for (const value of [-1, '8', 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => reviewHistory({ ...report, scannedFiles: value }, new Set())).toThrow();
  for (const key of ['artifacts', 'unreadable', 'skipped', 'findings']) expect(() => reviewHistory({ ...report, [key]: undefined }, new Set())).toThrow();
  expect(() => reviewHistory({ ...report, status: 'clean' }, new Set())).toThrow();
  expect(() => reviewHistory({ ...report, findings: [] }, new Set())).toThrow();
  expect(() => reviewHistory({ ...report, findings: [historical, { ...historical, line: 101 }] }, new Set())).toThrow();
});
