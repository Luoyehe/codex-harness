import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, snapshot } from './snapshot.mjs';

const contractPath = 'reference/BUILTIN-MCP-CONTRACT.json';
const names = ['web-search-prime', 'web-reader', 'zread', 'zai-mcp-server'];
const docPages = ['search-mcp-server', 'reader-mcp-server', 'zread-mcp-server', 'vision-mcp-server'];
const registry = 'https://registry.npmjs.org/@z_ai/mcp-server/';
const sha = value => createHash('sha256').update(value).digest('hex');
const stable = value => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
export function validateContract(contract) {
  if (contract?.schemaVersion !== 1 || contract.providerKind !== 'zhipu-coding' || contract.region !== 'CN' ||
      contract.credential !== 'same-enabled-provider-api-key' || contract.browserOAuth !== false ||
      !Array.isArray(contract.servers) || contract.servers.length !== names.length) throw Error('Invalid builtin MCP contract');
  contract.servers.forEach((row, index) => {
    if (row.name !== names[index] || row.documentation !== `https://docs.bigmodel.cn/cn/coding-plan/mcp/${docPages[index]}`)
      throw Error('Only the four managed CN MCP documentation sources are allowed');
    if (index < 3) {
      if (row.transport !== 'streamable-http' || row.authorization !== 'Bearer' ||
          row.url !== `https://open.bigmodel.cn/api/mcp/${['web_search_prime', 'web_reader', 'zread'][index]}/mcp`) throw Error('Invalid managed HTTP contract');
    } else if (row.transport !== 'stdio' || row.package !== '@z_ai/mcp-server' || !stable(row.version) ||
        !/^sha512-[A-Za-z0-9+/]{86}==$/.test(row.integrity) || row.keyEnvironment !== 'Z_AI_API_KEY' || row.modeEnvironment !== 'Z_AI_MODE' || row.mode !== 'ZHIPU')
      throw Error('Invalid managed vision contract');
  });
  return contract;
}

// No MCP endpoint, credentials, local configuration or user-defined server is read.
// A redirect is a review event; it never expands the fixed public source allowlist.
export async function officialRead(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json, text/html', 'User-Agent': 'codex-harness-builtin-mcp-check' },
    credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (response.status !== 200) { await response.body?.cancel(); return { status: response.status, body: '' }; }
  if (!response.body) throw Error('Empty official response');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength; if (size > 4 * 1024 * 1024) throw Error('Official response exceeds budget'); chunks.push(chunk);
  }
  return { status: response.status, body: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) };
}

export async function checkBuiltinMcp(contract, packagePin, lockText, read = officialRead) {
  validateContract(contract);
  const vision = contract.servers[3], issues = [], sources = [];
  if (packagePin !== vision.version || !lockText.includes(`'@z_ai/mcp-server@${vision.version}':\n    resolution: {integrity: ${vision.integrity}}`))
    issues.push({ source: 'local', reason: 'package-or-lock-does-not-match-reviewed-contract' });
  const requests = [...contract.servers.map(row => row.documentation), registry + vision.version, registry + 'latest'];
  const observations = await Promise.all(requests.map(async url => {
    try {
      const result = await read(url);
      if (!Number.isInteger(result.status) || typeof result.body !== 'string' || Buffer.byteLength(result.body) > 4 * 1024 * 1024) throw Error('Invalid response');
      sources.push({ url, status: result.status, sha256: sha(result.body), bytes: Buffer.byteLength(result.body) });
      return result;
    } catch { sources.push({ url, status: null, error: 'public-source-unavailable' }); return null; }
  }));
  for (let index = 0; index < 4; index++) {
    const row = contract.servers[index], response = observations[index];
    if (!response || response.status !== 200) { issues.push({ source: row.name, reason: 'documentation-unavailable' }); continue; }
    // Token checks detect drift, not the meaning of arbitrary new upstream prose.
    // The audit must still read changed documentation and review compatibility.
    const text = response.body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]*>/g, '').replace(/&quot;|&#34;/g, '"').replace(/&amp;/g, '&');
    const expected = index < 3 ? [row.url, 'Authorization', 'Bearer'] : [row.package, row.keyEnvironment, row.modeEnvironment, row.mode];
    if (expected.some(token => !text.includes(token))) issues.push({ source: row.name, reason: 'documented-configuration-changed' });
    if (/deprecated|withdrawn|已下线|已废弃|已停用|服务已停止|撤回/i.test(text)) issues.push({ source: row.name, reason: 'possible-upstream-retirement-needs-review' });
  }
  let pinned = null, latest = null;
  for (const [offset, label] of [[4, 'pinned'], [5, 'latest']]) {
    const response = observations[offset];
    if (!response || response.status !== 200) { issues.push({ source: label, reason: response?.status === 404 ? 'package-missing-or-withdrawn' : 'registry-unavailable' }); continue; }
    try {
      const value = JSON.parse(response.body);
      if (value.name !== vision.package || !stable(value.version) || typeof value.dist?.integrity !== 'string') throw Error('Invalid registry metadata');
      const summary = { version: value.version, integrity: value.dist.integrity, deprecated: Boolean(value.deprecated) };
      if (label === 'pinned') pinned = summary; else latest = summary;
      if (summary.deprecated) issues.push({ source: label, reason: 'package-deprecated' });
    } catch { issues.push({ source: label, reason: 'invalid-registry-metadata' }); }
  }
  if (pinned && (pinned.version !== vision.version || pinned.integrity !== vision.integrity)) issues.push({ source: 'pinned', reason: 'reviewed-package-integrity-changed' });
  if (latest?.version === vision.version && latest.integrity !== vision.integrity) issues.push({ source: 'latest', reason: 'reviewed-package-integrity-changed' });
  if (latest && latest.version !== vision.version) issues.push({ source: 'latest', reason: 'new-version-requires-compatibility-review' });
  const complete = observations.every(value => value?.status === 200);
  return { complete, status: !complete ? 'unavailable' : issues.length ? 'review-required' : 'current', pinned, latest,
    sources: sources.sort((a, b) => a.url.localeCompare(b.url)), issues,
    limits: ['Public documentation and package metadata only; no credential or live MCP connection/tool call.',
      'Token matching detects drift but does not replace semantic documentation review or offline renderer/stdio compatibility tests.',
      'User-defined MCP and ZAI global configuration are outside this builtin CN contract. No automatic dependency update.'] };
}

export async function builtinFreshness(base = root, read = officialRead) {
  const before = snapshot(base), checkedAt = new Date().toISOString();
  const contract = JSON.parse(readFileSync(path.join(base, contractPath), 'utf8'));
  const pkg = JSON.parse(readFileSync(path.join(base, 'package.json'), 'utf8'));
  const result = await checkBuiltinMcp(contract, pkg.dependencies['@z_ai/mcp-server'], readFileSync(path.join(base, 'pnpm-lock.yaml'), 'utf8').replaceAll('\r\n', '\n'), read);
  const files = [contractPath, 'deploy/provider.py', 'deploy/provider_registry.py', 'deploy/native_launcher.py', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];
  const hashes = files.map(name => ({ path: name, sha256: sha(readFileSync(path.join(base, name))) }));
  if (snapshot(base).digest !== before.digest) throw Error('Source changed during builtin freshness check');
  return { schemaVersion: 1, kind: 'builtin-mcp-freshness', checkedAt, completedAt: new Date().toISOString(), sourceDigest: before.digest, sourceFiles: before.files,
    files: hashes, contract, ...result };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw Error('Usage: node scripts/check-builtin-mcp.mjs (no custom targets)');
    const result = await builtinFreshness();
    const directory = path.join(root, '.work'); mkdirSync(directory, { recursive: true });
    if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory) throw Error('Unsafe evidence directory');
    const output = path.join(directory, `builtin-mcp-freshness-${randomUUID()}.json`);
    writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, status: result.status, complete: result.complete, sourceDigest: result.sourceDigest, issues: result.issues }));
    if (result.status !== 'current') process.exitCode = 1;
  } catch { console.error('Builtin MCP freshness could not be established; no successful evidence was written'); process.exitCode = 1; }
}
