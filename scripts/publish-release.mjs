import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { committedAuthorization, committedSource } from './release-preflight.mjs';
import { testInventory } from './select-tests.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function verifiedChecks(value, workflow, sha) {
  if (!Array.isArray(value?.workflow_runs)) throw Error('Incomplete release check evidence');
  const runs = value.workflow_runs.filter(run => run.head_sha === sha && run.head_branch === 'main' && run.event === 'push' && run.path === `.github/workflows/${workflow}`);
  runs.sort((a, b) => Number(b.run_number) - Number(a.run_number) || Number(b.run_attempt) - Number(a.run_attempt));
  const latest = runs[0];
  if (!latest || latest.status !== 'completed' || latest.conclusion !== 'success') throw Error(`Latest ${workflow} check for the release commit is not successful`);
  return { id: latest.id, url: latest.html_url, head: sha };
}

export function verifiedCoverage(coverage, { head, digest, files, authorization }) {
  if (coverage.status !== 'passed' || coverage.mode !== 'authorized-full' || coverage.head !== head ||
      coverage.sourceDigest !== digest || coverage.authorizationSha256 !== authorization ||
      coverage.files !== files || files < 1 || !Number.isSafeInteger(coverage.cases) || coverage.cases < files ||
      !Array.isArray(coverage.coverageGaps) || coverage.coverageGaps.length ||
      JSON.stringify(coverage.targets) !== JSON.stringify(['linux', 'linux-root']))
    throw Error('Full coverage evidence does not match this release');
}
export function releaseTitle(tag, notes) {
  const heading = /^# (.+)$/m.exec(notes)?.[1]?.trim();
  return heading ? (heading.includes(tag) ? heading : tag + ' · ' + heading).slice(0, 180) : tag;
}
export async function publishRelease(base, env = process.env, fetcher = fetch, checksOnly = false) {
  const { GITHUB_REPOSITORY: repository, GITHUB_SHA: sha, GITHUB_REF_NAME: tag, GH_TOKEN: token } = env;
  if (repository !== 'Luoyehe/codex-harness' || !/^[a-f0-9]{40}$/.test(sha ?? '') || !/^v\d+\.\d+\.\d+$/.test(tag ?? '') || !token) throw Error('Invalid release identity');
  const version = JSON.parse(readFileSync(path.join(base, 'package.json'), 'utf8')).version;
  if (tag !== `v${version}`) throw Error('Release tag and package version disagree');
  const notes = readFileSync(path.join(base, `verification/reports/release-${tag}.md`), 'utf8');
  if (!notes.trim() || Buffer.byteLength(notes) > 65536) throw Error('Missing or oversized reviewed release notes');
  const api = async (suffix, method = 'GET', body) => {
    const response = await fetcher(`https://api.github.com/repos/${repository}/${suffix}`, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) { await response.body?.cancel(); throw Error(`GitHub release API returned ${response.status}`); }
    const parts = []; let bytes = 0;
    for await (const part of response.body ?? []) { bytes += part.byteLength; if (bytes > 2 * 1024 * 1024) throw Error('Release API response exceeds budget'); parts.push(part); }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  };
  const evidence = [];
  for (const workflow of ['affected.yml', 'security.yml']) {
    const runs = await api(`actions/workflows/${workflow}/runs?branch=main&event=push&head_sha=${sha}&per_page=20`);
    evidence.push(verifiedChecks(runs, workflow, sha));
  }
  const runId = evidence[0].id;
  if (!Number.isSafeInteger(runId) || runId < 1) throw Error('Invalid reviewed workflow run ID');
  if (checksOnly) return { runId };
  const actualHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: base, encoding: 'utf8' }).trim();
  if (actualHead !== sha) throw Error('Release checkout is not the checked commit');
  const current = committedSource(base, sha);
  const authorizationPath = 'verification/audit-evidence/release-closeout/authorization.json';
  for (const name of [authorizationPath, `verification/reports/release-${tag}.md`]) {
    const checked = execFileSync('git', ['show', `${sha}:${name}`], { cwd: base, maxBuffer: 65537 });
    if (!checked.equals(readFileSync(path.join(base, name)))) throw Error('Reviewed release evidence differs from the checked commit');
  }
  const checksum = createHash('sha256').update(readFileSync(path.join(base, authorizationPath))).digest('hex');
  const auth = committedAuthorization(base, sha, checksum);
  const coverage = JSON.parse(readFileSync(path.join(base, '.work', 'release-coverage', String(runId), 'reconciled.json'), 'utf8'));
  verifiedCoverage(coverage, { head: sha, digest: current.digest, files: testInventory(base).length, authorization: auth.sha256 });
  // GitHub ignores target_commitish for an existing tag. Resolve the live tag
  // as close to POST as possible, including bounded annotated-tag chains.
  const reference = await api(`git/ref/tags/${encodeURIComponent(tag)}`);
  if (reference.ref !== `refs/tags/${tag}`) throw Error('Release tag reference identity mismatch');
  let object = reference.object;
  const seen = new Set();
  while (object?.type === 'tag') {
    if (!/^[a-f0-9]{40}$/.test(object.sha ?? '') || seen.has(object.sha) || seen.size >= 8) throw Error('Invalid annotated release tag');
    seen.add(object.sha);
    const annotated = await api(`git/tags/${object.sha}`);
    if (annotated.sha !== object.sha) throw Error('Annotated release tag identity mismatch');
    object = annotated.object;
  }
  if (object?.type !== 'commit' || object.sha !== sha) throw Error('Release tag no longer points to the checked commit');
  // Publish only this exact, already checked tag. Never update an existing release
  // or retry a POST whose outcome is unknown; GitHub rejects duplicate tag releases.
  const result = await api('releases', 'POST', { tag_name: tag, target_commitish: sha, name: releaseTitle(tag, notes), body: notes, draft: false, prerelease: false });
  if (result.tag_name !== tag || result.draft !== false || typeof result.html_url !== 'string') throw Error('Release publication result needs inspection');
  return { tag, sha, url: result.html_url, checks: evidence };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const checksOnly = process.argv[2] === '--checks';
    const result = await publishRelease(fileURLToPath(new URL('..', import.meta.url)), process.env, fetch, checksOnly);
    if (checksOnly) appendFileSync(process.env.GITHUB_OUTPUT, 'run=' + result.runId + '\n');
    console.log(JSON.stringify(result));
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
