import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function compatibilityReport(pinned, registry, release) {
  if (!/^\d+\.\d+\.\d+$/.test(pinned) || !/^\d+\.\d+\.\d+$/.test(registry?.version) || !/^rust-v\d+\.\d+\.\d+$/.test(release?.tag_name) || release.draft !== false || release.prerelease !== false)
    throw Error('Official upstream did not return a valid stable version');
  const github = release.tag_name.slice(6);
  return { pinned, npm: registry.version, github, status: registry.version === pinned && github === pinned ? 'current' : 'review-required', note: 'Detection only. A version change requires protocol regeneration, security review and native compatibility tests before changing the pinned runtime.' };
}
async function official(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'codex-harness-compatibility-check' }, signal: AbortSignal.timeout(20000), redirect: 'error' });
  if (!response.ok) throw Error(`Official metadata unavailable (${response.status})`);
  const text = await response.text(); if (text.length > 2 * 1024 * 1024) throw Error('Upstream metadata too large'); return JSON.parse(text);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const [npm, github] = await Promise.all([official('https://registry.npmjs.org/@openai/codex/latest'), official('https://api.github.com/repos/openai/codex/releases/latest')]);
    const report = compatibilityReport(pkg.codexVersion, npm, github);
    mkdirSync(path.join(root, '.work'), { recursive: true }); writeFileSync(path.join(root, '.work/compatibility.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report)); if (report.status !== 'current') process.exitCode = 1;
  } catch (error) { console.error('Compatibility could not be established: ' + error.message); process.exitCode = 1; }
}
