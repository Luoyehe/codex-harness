import { expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { snapshot } from '../../scripts/snapshot.mjs';
import { publishRelease, verifiedChecks, releaseTitle } from '../../scripts/publish-release.mjs';

const sha = 'a'.repeat(40);
const success = (workflow: string) => ({ id: 1, run_number: 1, run_attempt: 1, head_sha: sha, head_branch: 'main', event: 'push', path: `.github/workflows/${workflow}`, status: 'completed', conclusion: 'success', html_url: 'https://github.com/Luoyehe/codex-harness/actions/runs/1' });
test('release requires the latest exact main push checks, never a green PR or older failed retry', () => {
  for (const override of [{ head_sha: 'b'.repeat(40) }, { event: 'pull_request' }, { head_branch: 'topic' }, { path: '.github/workflows/other.yml' }, { conclusion: 'failure' }, { status: 'in_progress' }])
    expect(() => verifiedChecks({ workflow_runs: [{ ...success('affected.yml'), ...override }] }, 'affected.yml', sha)).toThrow();
  expect(() => verifiedChecks({ workflow_runs: [success('affected.yml'), { ...success('affected.yml'), run_attempt: 2, conclusion: 'failure' }] }, 'affected.yml', sha)).toThrow();
  expect(verifiedChecks({ workflow_runs: [success('affected.yml')] }, 'affected.yml', sha)).toMatchObject({ head: sha });
});
test('publication is withheld until both workflow results and version match, with no retry after uncertain POST', async () => {
  mkdirSync('.work/release-publish-tests', { recursive: true }); const base = mkdtempSync(path.resolve('.work/release-publish-tests/run-'));
  try {
    mkdirSync(path.join(base, 'verification/reports'), { recursive: true });
    writeFileSync(path.join(base, 'package.json'), '{"version":"2.4.0"}'); writeFileSync(path.join(base, 'verification/reports/release-v2.4.0.md'), 'Reviewed release fixture.');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: base, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const save = (name: string, body: string) => { const file = path.join(base, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, body); };
    const commit = () => { git('add', '.'); git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'test fixture'); return git('rev-parse', 'HEAD'); };
    git('init', '-q'); save('.gitignore', '.work/\n'); save('tests/core/example.test.ts', '// inert inventory fixture\n');
    const baseline = commit(), source = snapshot(base);
    const auth = JSON.stringify({ schemaVersion: 1, kind: 'explicit-user-release-closeout', auditRoundsWaived: true,
      sourceDigest: source.digest, sourceFiles: source.files, baseCommit: baseline, version: '2.4.0', approvedAt: '2025-01-01T00:00:00Z',
      userInstruction: 'Synthetic scope for this publication unit test.', auditWaiverInstruction: 'Synthetic waiver for unit test inputs only.',
      repairsReviewed: true, unresolvedBlockers: [], scopes: ['full-tests'] });
    save('verification/audit-evidence/release-closeout/authorization.json', auth);
    const sha = commit();
    const coverage = { status: 'passed', mode: 'authorized-full', head: sha, sourceDigest: source.digest, files: 1, cases: 1,
      targets: ['linux', 'linux-root'], authorizationSha256: createHash('sha256').update(auth).digest('hex'), coverageGaps: [] };
    const proof = '.work/release-coverage/1/reconciled.json';
    save(proof, JSON.stringify(coverage));
    const env = { GITHUB_REPOSITORY: 'Luoyehe/codex-harness', GITHUB_SHA: sha, GITHUB_REF_NAME: 'v2.4.0', GH_TOKEN: 'synthetic' };
    let currentTag = sha, annotated = false;
    const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (options?.method === 'POST') throw Error('Unknown POST outcome');
      if (String(url).includes('/git/ref/tags/')) return Response.json({ ref: 'refs/tags/v2.4.0', object: annotated ? { type: 'tag', sha: 'c'.repeat(40) } : { type: 'commit', sha: currentTag } });
      if (String(url).includes('/git/tags/')) return Response.json({ sha: 'c'.repeat(40), object: { type: 'commit', sha: currentTag } });
      return Response.json({ workflow_runs: [{ ...success(String(url).includes('affected.yml') ? 'affected.yml' : 'security.yml'), head_sha: sha }] });
    });
    await expect(publishRelease(base, { ...env, GITHUB_REF_NAME: 'v2.4.1' }, fetcher)).rejects.toThrow('version disagree'); expect(fetcher).not.toHaveBeenCalled();
    await expect(publishRelease(base, env, fetcher)).rejects.toThrow('Unknown POST outcome'); expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    currentTag = 'b'.repeat(40); fetcher.mockClear();
    await expect(publishRelease(base, env, fetcher)).rejects.toThrow('no longer points');
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
    annotated = true; currentTag = sha; fetcher.mockClear();
    await expect(publishRelease(base, env, fetcher)).rejects.toThrow('Unknown POST outcome'); expect(fetcher).toHaveBeenCalledTimes(5);
    for (const invalid of [{ mode: 'targeted' }, { authorizationSha256: '0'.repeat(64) }, { files: 2 }, { targets: ['linux'] }, { coverageGaps: ['unverified-case'] }]) {
      save(proof, JSON.stringify({ ...coverage, ...invalid })); fetcher.mockClear();
      await expect(publishRelease(base, env, fetcher)).rejects.toThrow('coverage evidence');
      expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
    }
    expect(releaseTitle('v2.4.0', '# 会话恢复和移动端改进')).toBe('v2.4.0 · 会话恢复和移动端改进');
    const blocked = vi.fn(async () => Response.json({ workflow_runs: [] })); await expect(publishRelease(base, env, blocked)).rejects.toThrow('not successful'); expect(blocked).toHaveBeenCalledTimes(1);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
