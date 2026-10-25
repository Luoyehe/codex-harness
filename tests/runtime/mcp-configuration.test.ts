import { describe, expect, it } from 'vitest';
import { McpConfiguration } from '../../src/runtime/mcp-configuration.js';
import { object, type JsonObject, type JsonValue } from '../../src/runtime/types.js';
function setup() {
  let version = 'first'; let servers: JsonObject = { first: { command: 'node', args: ['server.mjs'], env: { PRIVATE: 'first-secret' }, startup_timeout_sec: 10 }, second: { url: 'https://example.invalid/mcp', http_headers: { Authorization: 'Bearer second-secret' }, enabled: false } };
  const calls: JsonObject[] = [];
  const config = new McpConfiguration(async () => ({ config: { mcp_servers: { ...servers, inherited: { command: 'safe' } } }, origins: {}, layers: [{ name: { type: 'user', file: '/native/config.toml', profile: null }, version, config: { mcp_servers: structuredClone(servers) }, disabledReason: null }] }));
  const write = async (_method: string, params: JsonValue): Promise<JsonValue> => { const p = object(params); calls.push(p); expect(p.expectedVersion).toBe(version); servers = object(object((p.edits as JsonValue[])[0]).value); version += '+'; return { status: 'ok', version, filePath: '/native/config.toml', overriddenMetadata: null }; };
  const update = (name: string, change: JsonObject, expectedVersion = version) => config.write({ cwd: '/project', name, expectedVersion, change }, '/project', write);
  return { config, update, calls, servers: () => servers };
}
describe('per-server MCP configuration preserves unrelated credentials', () => {
  it('reads safe fields and presence without secret values, and keeps other servers and omitted secrets on edit', async () => {
    const f = setup(); const visible = await f.config.read('/project');
    expect(JSON.stringify(visible)).not.toContain('first-secret'); expect(JSON.stringify(visible)).not.toContain('second-secret'); expect(visible).toMatchObject({ userVersion: 'first', inheritedServers: ['inherited'], servers: [{ name: 'first', hasEnv: true }, { name: 'second', hasHttpHeaders: true }] });
    await f.update('first', { type: 'upsert', transport: 'stdio', args: ['new.mjs'], enabled: false });
    expect(f.servers()).toMatchObject({ first: { env: { PRIVATE: 'first-secret' }, args: ['new.mjs'], startup_timeout_sec: 10, enabled: false }, second: { http_headers: { Authorization: 'Bearer second-secret' } } });
  });
  it('rejects stale revisions before any write and only clears secrets on explicit action or transport change', async () => {
    const f = setup(); await expect(f.update('first', { type: 'upsert', transport: 'stdio' }, 'old')).rejects.toMatchObject({ code: 'config_conflict' }); expect(f.calls).toHaveLength(0);
    await f.update('first', { type: 'upsert', transport: 'stdio', clearSecrets: true }); expect(object(f.servers().first).env).toBeUndefined();
    await f.update('second', { type: 'upsert', transport: 'stdio', command: 'python', args: [] }); expect(object(f.servers().second)).toEqual({ enabled: false, command: 'python', args: [] });
  });
  it('validates transport-specific fields, headers, environment maps and hidden sentinel values', async () => {
    const f = setup();
    for (const change of [
      { type: 'upsert', transport: 'http', url: 'file:///secrets' },
      { type: 'upsert', transport: 'http', url: 'https://' + ['user', 'secret'].join(':') + '@example.invalid/mcp' },
      { type: 'upsert', transport: 'http', command: 'unexpected' },
      { type: 'upsert', transport: 'http', url: 'https://example.invalid', httpHeaders: { X: 'one\r\nInjected: yes' } },
      { type: 'upsert', transport: 'stdio', env: { SECRET: '[redacted]' } },
      { type: 'upsert', transport: 'stdio', env: { 'INVALID=NAME': 'x' } },
      { type: 'upsert', transport: 'stdio', args: ['bad\0arg'] },
    ]) await expect(f.update('first', change)).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(f.calls).toHaveLength(0);
  });
  it('removes only a named user-layer server and rejects nonexistent or inherited names', async () => {
    const f = setup(); await expect(f.update('inherited', { type: 'remove' })).rejects.toMatchObject({ code: 'mcp_missing' });
    await f.update('first', { type: 'remove' }); expect(Object.keys(f.servers())).toEqual(['second']);
    expect(JSON.stringify(f.servers())).toContain('second-secret');
  });
});
