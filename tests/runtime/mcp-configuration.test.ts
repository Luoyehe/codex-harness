import { describe, expect, it } from 'vitest';
import { McpConfiguration } from '../../src/runtime/mcp-configuration.js';
import { DeliveryError, object, type JsonObject, type JsonValue } from '../../src/runtime/types.js';
function setup(editorAvailable: boolean | 'read-only' = true, reloadFails = false) {
  let version = 'first'; let servers: JsonObject = { first: { command: 'node', args: ['server.mjs'], env: { PRIVATE: 'first-secret' }, startup_timeout_sec: 10 }, second: { url: 'https://example.invalid/mcp', http_headers: { Authorization: 'Bearer second-secret' }, enabled: false } };
  const calls: JsonObject[] = [];
  const config = new McpConfiguration(async () => ({ config: { mcp_servers: { ...servers, inherited: { command: 'safe' } } }, origins: {}, layers: [{ name: { type: 'user', file: '/native/config.toml', profile: null }, version, config: { mcp_servers: structuredClone(servers) }, disabledReason: null }] }),
    async () => {
      if (editorAvailable === 'read-only') throw new DeliveryError('permission_denied', 'Writer is unavailable');
      return editorAvailable ? { userConfigEdits: 1, fileVersion: version + '-bytes' } : {};
    });
  const write = async (method: string, params: JsonValue): Promise<JsonValue> => {
    const p = object(params); calls.push(p);
    if (method === 'harness/mcp/user-edit') {
      expect(p.expectedVersion).toBe(version + '-bytes');
      const name = String(p.name);
      if (p.changes === null) delete servers[name];
      else {
        const row = object(servers[name] ?? {});
        for (const [key, value] of Object.entries(object(p.changes))) {
          if (value === null) delete row[key]; else row[key] = value;
        }
        servers[name] = row;
      }
      version += '+';
      return { fileVersion: version + '-bytes' };
    }
    expect(method).toBe('config/batchWrite');
    if (reloadFails) throw new Error('Synthetic reload failure');
    expect(p).toEqual({ expectedVersion: version, edits: [], reloadUserConfig: true });
    return { status: 'ok', version, filePath: '/native/config.toml', overriddenMetadata: null };
  };
  const update = (name: string, change: JsonObject, expectedVersion = editorAvailable === true ? version + '|' + version + '-bytes' : version) => config.write({ cwd: '/project', name, expectedVersion, change }, '/project', write);
  return { config, update, calls, servers: () => servers };
}
describe('per-server MCP configuration preserves unrelated credentials', () => {
  it('binds inherited switch writes to the observed TOML bytes and rejects intervening comment edits', async () => {
    const servers = { inherited: { command: 'echo' } };
    let fileVersion = 'original-file', flagsVersion = 'flags-before', enabled = true;
    const config = new McpConfiguration(async () => ({ config: { mcp_servers: servers }, origins: {}, layers: [
      { name: { type: 'user', file: '/user/config.toml', profile: null }, version: 'native-user-version', config: {}, disabledReason: null },
      { name: { type: 'system', file: '/etc/codex/config.toml' }, version: 'system-version', config: { mcp_servers: servers }, disabledReason: null },
    ] }), async () => ({ fileVersion, version: flagsVersion, flags: { inherited: enabled } }));
    const request = async () => ({ cwd: '/project', name: 'inherited', expectedVersion: object(await config.read('/project')).userVersion!, change: { type: 'inherit', enabled: false } });
    const old = await request();
    fileVersion = 'edited-file';
    let writes = 0;
    const write = async (_method: string, input: JsonValue) => {
      writes++;
      expect(object(input).expectedVersion).toBe('edited-file');
      enabled = false; flagsVersion = 'flags-after';
      return { written: true, version: flagsVersion, filePath: '/user/switches.json', effective: enabled };
    };
    await expect(config.write(old, '/project', write)).rejects.toMatchObject({ code: 'config_conflict' });
    expect(writes).toBe(0);
    await expect(config.write(await request(), '/project', write)).resolves.toMatchObject({ status: 'ok', effective: false });
    expect(writes).toBe(1);
  });
  it('reads safe fields and presence without secret values, and keeps other servers and omitted secrets on edit', async () => {
    const f = setup(); const visible = await f.config.read('/project');
    expect(JSON.stringify(visible)).not.toContain('first-secret'); expect(JSON.stringify(visible)).not.toContain('second-secret'); expect(visible).toMatchObject({ userVersion: 'first|first-bytes', inheritedServers: ['inherited'], servers: [{ name: 'first', hasEnv: true }, { name: 'second', hasHttpHeaders: true }] });
    await f.update('first', { type: 'upsert', transport: 'stdio', args: ['new.mjs'], enabled: false });
    expect(f.calls[0]?.changes).toEqual({ args: ['new.mjs'], enabled: false });
    expect(JSON.stringify(f.calls)).not.toContain('first-secret');
    expect(f.servers()).toMatchObject({ first: { env: { PRIVATE: 'first-secret' }, args: ['new.mjs'], startup_timeout_sec: 10, enabled: false }, second: { http_headers: { Authorization: 'Bearer second-secret' } } });
  });
  it('rejects stale revisions before any write and only clears secrets on explicit action or transport change', async () => {
    const f = setup(); await expect(f.update('first', { type: 'upsert', transport: 'stdio' }, 'old')).rejects.toMatchObject({ code: 'config_conflict' }); expect(f.calls).toHaveLength(0);
    await f.update('first', { type: 'upsert', transport: 'stdio', clearSecrets: true }); expect(object(f.servers().first).env).toBeUndefined();
    await f.update('second', { type: 'upsert', transport: 'stdio', command: 'python', args: [] }); expect(object(f.servers().second)).toEqual({ enabled: false, command: 'python', args: [] });
  });
  it('reads through older controls and leaves every byte alone when they cannot perform a lossless write', async () => {
    const f = setup(false);
    expect(object(await f.config.read('/project')).servers).toHaveLength(2);
    await expect(f.update('first', { type: 'remove' })).rejects.toMatchObject({ code: 'control_update_required', delivery: 'not_sent' });
    expect(f.calls).toHaveLength(0);
  });
  it('reads native metadata when write-capable controls are unavailable', async () => {
    const f = setup('read-only');
    expect(await f.config.read('/project')).toMatchObject({ userVersion: 'first', servers: [{ name: 'first' }, { name: 'second' }] });
    await expect(f.update('first', { type: 'remove' })).rejects.toMatchObject({ code: 'permission_denied', delivery: 'not_sent' });
    expect(f.calls).toHaveLength(0);
  });
  it('reports an unknown outcome if official reload fails after the private write', async () => {
    const f = setup(true, true);
    await expect(f.update('first', { type: 'upsert', transport: 'stdio', enabled: false })).rejects.toMatchObject({ code: 'config_readback_unknown', delivery: 'unknown' });
    expect(f.calls).toHaveLength(2);
    expect(object(f.servers().first).enabled).toBe(false);
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
