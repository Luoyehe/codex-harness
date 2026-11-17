import { expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { publishRelease, verifiedChecks } from '../../scripts/publish-release.mjs';

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
    const env = { GITHUB_REPOSITORY: 'Luoyehe/codex-harness', GITHUB_SHA: sha, GITHUB_REF_NAME: 'v2.4.0', GH_TOKEN: 'synthetic' };
    let currentTag = sha, annotated = false;
    const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (options?.method === 'POST') throw Error('Unknown POST outcome');
      if (String(url).includes('/git/ref/tags/')) return Response.json({ ref: 'refs/tags/v2.4.0', object: annotated ? { type: 'tag', sha: 'c'.repeat(40) } : { type: 'commit', sha: currentTag } });
      if (String(url).includes('/git/tags/')) return Response.json({ sha: 'c'.repeat(40), object: { type: 'commit', sha: currentTag } });
      return Response.json({ workflow_runs: [success(String(url).includes('affected.yml') ? 'affected.yml' : 'security.yml')] });
    });
    await expect(publishRelease(base, { ...env, GITHUB_REF_NAME: 'v2.4.1' }, fetcher)).rejects.toThrow('version disagree'); expect(fetcher).not.toHaveBeenCalled();
    await expect(publishRelease(base, env, fetcher)).rejects.toThrow('Unknown POST outcome'); expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    currentTag = 'b'.repeat(40); fetcher.mockClear();
    await expect(publishRelease(base, env, fetcher)).rejects.toThrow('no longer points');
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
    annotated = true; currentTag = sha; fetcher.mockClear();
    await expect(publishRelease(base, env, fetcher)).rejects.toThrow('Unknown POST outcome'); expect(fetcher).toHaveBeenCalledTimes(5);
    const blocked = vi.fn(async () => Response.json({ workflow_runs: [] })); await expect(publishRelease(base, env, blocked)).rejects.toThrow('not successful'); expect(blocked).toHaveBeenCalledTimes(1);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
