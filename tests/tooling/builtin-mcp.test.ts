import { expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkBuiltinMcp, validateContract } from '../../scripts/check-builtin-mcp.mjs';

const contract = JSON.parse(readFileSync('reference/BUILTIN-MCP-CONTRACT.json', 'utf8'));
const vision = contract.servers[3];
const lock = `'@z_ai/mcp-server@${vision.version}':\n    resolution: {integrity: ${vision.integrity}}`;
function fixture() {
  const responses = new Map<string, { status: number; body: string }>();
  for (const server of contract.servers) responses.set(server.documentation, { status: 200, body: server.transport === 'stdio'
    ? `<p>${server.package} ${server.keyEnvironment} ${server.modeEnvironment} ${server.mode}</p>`
    : `<div>${server.url}</div> <span>Authorization</span>: Bearer YOUR_API_KEY` });
  const metadata = { name: vision.package, version: vision.version, dist: { integrity: vision.integrity } };
  const pinned = `https://registry.npmjs.org/@z_ai/mcp-server/${vision.version}`, latest = 'https://registry.npmjs.org/@z_ai/mcp-server/latest';
  for (const url of [pinned, latest]) responses.set(url, { status: 200, body: JSON.stringify(metadata) });
  const read = vi.fn(async (url: string) => { const value = responses.get(url); if (!value) throw Error('Unexpected public source'); return value; });
  return { responses, read, metadata, pinned, latest };
}

test('the builtin-only public check records six bounded sources and the exact installed pin without invoking MCP', async () => {
  const f = fixture(), result = await checkBuiltinMcp(contract, vision.version, lock, f.read);
  expect(result).toMatchObject({ complete: true, status: 'current', issues: [], pinned: { version: vision.version, deprecated: false }, latest: { version: vision.version } });
  expect(f.read).toHaveBeenCalledTimes(6);
  expect(f.read.mock.calls.every(([url]) => !url.startsWith('https://open.bigmodel.cn'))).toBe(true);
  expect(result.sources.every(source => /^[a-f0-9]{64}$/.test(source.sha256))).toBe(true);
});

test('new versions and deprecation require review without modifying the pinned dependency', async () => {
  const f = fixture(); f.responses.set(f.latest, { status: 200, body: JSON.stringify({ ...f.metadata, version: '0.2.0' }) });
  f.responses.set(f.pinned, { status: 200, body: JSON.stringify({ ...f.metadata, deprecated: 'Do not use' }) });
  const result = await checkBuiltinMcp(contract, vision.version, lock, f.read);
  expect(result.status).toBe('review-required');
  expect(result.issues).toContainEqual({ source: 'pinned', reason: 'package-deprecated' });
  expect(result.issues).toContainEqual({ source: 'latest', reason: 'new-version-requires-compatibility-review' });
  expect(contract.servers[3].version).toBe(vision.version);
});

test('missing or withdrawn pin, timeouts and redirected documents cannot report current', async () => {
  const f = fixture(); f.responses.set(f.pinned, { status: 404, body: '' }); f.responses.delete(contract.servers[0].documentation);
  f.responses.set(contract.servers[1].documentation, { status: 302, body: '' });
  const result = await checkBuiltinMcp(contract, vision.version, lock, f.read);
  expect(result).toMatchObject({ complete: false, status: 'unavailable', pinned: null });
  expect(result.issues).toContainEqual({ source: 'pinned', reason: 'package-missing-or-withdrawn' });
  expect(f.read).toHaveBeenCalledTimes(6); // No retry or redirect to a new target.
  expect(JSON.stringify(result)).not.toContain('Unexpected public source');
});

test('changed endpoint/auth/env and retirement wording produce explicit per-builtin findings', async () => {
  const f = fixture(); f.responses.set(contract.servers[0].documentation, { status: 200, body: 'Authorization Bearer https://new.invalid/mcp' });
  f.responses.set(contract.servers[3].documentation, { status: 200, body: '@z_ai/mcp-server Z_AI_API_KEY ZHIPU deprecated' });
  const result = await checkBuiltinMcp(contract, vision.version, lock, f.read);
  expect(result.status).toBe('review-required');
  expect(result.issues).toContainEqual({ source: 'web-search-prime', reason: 'documented-configuration-changed' });
  expect(result.issues).toContainEqual({ source: 'zai-mcp-server', reason: 'documented-configuration-changed' });
  expect(result.issues).toContainEqual({ source: 'zai-mcp-server', reason: 'possible-upstream-retirement-needs-review' });
});

test('wrong package, pin integrity and local lock mismatch never look like compatible current metadata', async () => {
  const f = fixture(); f.responses.set(f.pinned, { status: 200, body: JSON.stringify({ ...f.metadata, dist: { integrity: 'sha512-other' } }) });
  f.responses.set(f.latest, { status: 200, body: JSON.stringify({ ...f.metadata, name: 'other-package' }) });
  const result = await checkBuiltinMcp(contract, '0.0.1', 'different lock', f.read);
  expect(result.status).toBe('review-required');
  expect(result.issues.map(issue => issue.reason)).toEqual(expect.arrayContaining(['package-or-lock-does-not-match-reviewed-contract', 'reviewed-package-integrity-changed', 'invalid-registry-metadata']));
});

test('the fixed source allowlist rejects user servers, URL credentials and extra entries before I/O', async () => {
  for (const alter of [(c: typeof contract) => {
    const url = new URL(c.servers[0].documentation); url.username = 'fixture-user'; url.password = 'fixture-password';
    c.servers[0].documentation = url.href;
  },
    (c: typeof contract) => { c.servers.push(c.servers[0]); }, (c: typeof contract) => { c.region = 'ZAI'; }]) {
    const changed = structuredClone(contract), f = fixture(); alter(changed);
    expect(() => validateContract(changed)).toThrow();
    await expect(checkBuiltinMcp(changed, vision.version, lock, f.read)).rejects.toThrow(); expect(f.read).not.toHaveBeenCalled();
  }
});

test('the latest metadata cannot contradict the integrity of the same pinned version', async () => {
  const f = fixture(); f.responses.set(f.latest, { status: 200, body: JSON.stringify({ ...f.metadata, dist: { integrity: 'sha512-other' } }) });
  const result = await checkBuiltinMcp(contract, vision.version, lock, f.read);
  expect(result.status).toBe('review-required');
  expect(result.issues).toContainEqual({ source: 'latest', reason: 'reviewed-package-integrity-changed' });
});

test('oversized upstream metadata is bounded and records unavailability without storing the response body', async () => {
  const f = fixture(); f.responses.set(f.latest, { status: 200, body: 'x'.repeat(4 * 1024 * 1024 + 1) });
  const result = await checkBuiltinMcp(contract, vision.version, lock, f.read);
  expect(result).toMatchObject({ complete: false, status: 'unavailable', latest: null });
  expect(JSON.stringify(result).length).toBeLessThan(10000);
});
