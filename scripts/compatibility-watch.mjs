import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function compatibilityReport(pinned, registry, release) {
  if (!/^\d+\.\d+\.\d+$/.test(pinned) || !/^\d+\.\d+\.\d+$/.test(registry?.version) || !/^rust-v\d+\.\d+\.\d+$/.test(release?.tag_name) || release.draft !== false || release.prerelease !== false)
    throw Error('Official upstream did not return a valid stable version');
  const github = release.tag_name.slice(6);
  return { pinned, npm: registry.version, github, status: registry.version === pinned && github === pinned ? 'current' : 'review-required', note: 'Detection only. A version change requires protocol regeneration, security review and native compatibility tests before changing the pinned runtime.' };
}
export async function official(url, { fetcher = fetch, token = '' } = {}) {
  const target = new URL(url);
  if (!['registry.npmjs.org', 'api.github.com'].includes(target.hostname) || target.protocol !== 'https:' || target.username || target.password) throw Error('Unapproved metadata source');
  const headers = { Accept: 'application/json', 'User-Agent': 'codex-harness-compatibility-check' };
  if (target.hostname === 'api.github.com' && token) headers.Authorization = `Bearer ${token}`;
  const response = await fetcher(url, { headers, signal: AbortSignal.timeout(20000), redirect: 'error' });
  if (!response.ok) {
    const limited = response.status === 429 || response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0';
    const retry = response.headers.get('retry-after') ?? response.headers.get('x-ratelimit-reset');
    throw Object.assign(Error(limited ? 'Official metadata rate-limited; retry after the indicated reset' : `Official metadata unavailable (${response.status})`), {
      code: limited ? 'upstream-rate-limited' : 'upstream-unavailable', ...(retry && /^\d{1,12}$/.test(retry) ? { retryAfter: retry } : {}),
    });
  }
  let length = 0; const chunks = [];
  for await (const chunk of response.body ?? []) { length += chunk.length; if (length > 2 * 1024 * 1024) throw Error('Upstream metadata too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const [npm, github] = await Promise.all([official('https://registry.npmjs.org/@openai/codex/latest'), official('https://api.github.com/repos/openai/codex/releases/latest', { token: process.env.HARNESS_COMPATIBILITY_GITHUB_TOKEN ?? '' })]);
    const report = compatibilityReport(pkg.codexVersion, npm, github);
    mkdirSync(path.join(root, '.work'), { recursive: true }); writeFileSync(path.join(root, '.work/compatibility.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report)); if (report.status !== 'current') process.exitCode = 1;
  } catch (error) {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const report = { status: 'unverified', code: ['upstream-rate-limited', 'upstream-unavailable'].includes(error.code) ? error.code : 'metadata-check-failed', ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) };
    mkdirSync(path.join(root, '.work'), { recursive: true }); writeFileSync(path.join(root, '.work/compatibility.json'), JSON.stringify(report, null, 2) + '\n');
    console.error('Compatibility could not be established: ' + report.code); process.exitCode = 1;
  }
}
