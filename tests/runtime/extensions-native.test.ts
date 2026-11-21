import { expectNativeClosed } from './process-identity.js';
import { expect, test } from 'vitest';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { RuntimeService } from '../../src/runtime/service.js';
import { nativeTestEnvironment } from '../fixtures/native-env.js';
import { object, type JsonObject, type JsonValue } from '../../src/runtime/types.js';
import { withFixtureCleanup } from './fixture-cleanup.js';

const bin = process.env.HARNESS_TEST_CODEX_BIN ?? path.resolve('reference/runtime/codex-0.169.0/package/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
// Each scenario verifies several real CLI round trips and native-identity helper processes.
// Keep each operation's own deadline and allow a minute for the complete sequence.
const scenarioTimeout = 60_000;

test('official CLI updates isolated user configuration with version conflicts, resolves skill toggles, and reports capabilities without inference', () => withFixtureCleanup(async defer => {
  const parent = path.resolve('.work/extensions-native'); mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(path.join(parent, 'home-')); const codex = path.join(home, 'codex'); const project = path.join(home, 'project'); const temp = path.join(home, 'tmp');
  [codex, project, temp].forEach(folder => mkdirSync(folder));
  execFileSync('git', ['init', '--quiet', project], { windowsHide: true });
  writeFileSync(path.join(project, 'CLAUDE.md'), '# Isolated import fixture\nPreserve instruction content as user-reviewed source.\n');
  const skills = path.join(project, '.agents', 'skills', 'fixture'); mkdirSync(skills, { recursive: true });
  writeFileSync(path.join(skills, 'SKILL.md'), '---\nname: fixture\ndescription: Isolated extension acceptance fixture.\n---\nNever call an external tool in this fixture.\n');
  const marketplace = path.join(project, 'test-marketplace'); const plugin = path.join(marketplace, 'plugins', 'local-fixture');
  mkdirSync(path.join(marketplace, '.agents', 'plugins'), { recursive: true }); mkdirSync(path.join(plugin, '.codex-plugin'), { recursive: true }); mkdirSync(path.join(plugin, 'skills', 'local-fixture'), { recursive: true });
  writeFileSync(path.join(marketplace, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: 'test-marketplace', interface: { displayName: 'Isolated fixture marketplace' }, plugins: [{ name: 'local-fixture', source: { source: 'local', path: './plugins/local-fixture' } }] }));
  writeFileSync(path.join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'local-fixture', version: '1.0.0', description: 'Isolated harmless plugin', skills: './skills/' }));
  writeFileSync(path.join(plugin, 'skills', 'local-fixture', 'SKILL.md'), '---\nname: local-fixture\ndescription: Harmless test skill.\n---\nOnly a local protocol acceptance fixture.\n');
  let modelRequests = 0;
  const deny = createServer((req, res) => { if (req.url?.endsWith('/responses')) modelRequests++; req.resume(); res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"isolated fixture denies network"}'); });
  deny.on('connect', (_req, socket) => { socket.end('HTTP/1.1 503 Denied\r\nContent-Length: 0\r\n\r\n'); });
  let runtime: RuntimeService | undefined;
    await new Promise<void>(resolve => deny.listen(0, '127.0.0.1', resolve)); const url = 'http://127.0.0.1:'+(deny.address() as AddressInfo).port;
    defer(async () => { const closed = new Promise<void>((resolve, reject) => deny.close(error => error ? reject(error) : resolve())); deny.closeAllConnections(); await closed; });
    defer(() => { if (runtime) expectNativeClosed(runtime.native); });
    defer(() => runtime?.close());
    const catalog = path.join(home, 'models.json'); writeFileSync(catalog, readFileSync('tests/runtime/fixture-model-catalog.json'));
    writeFileSync(path.join(codex, 'config.toml'), ['model = "harness-loopback-fixture"', 'model_provider = "fixture"', `model_catalog_json = ${JSON.stringify(catalog)}`, 'model_reasoning_effort = "low"', 'check_for_update_on_startup = false', '[model_providers.fixture]', 'name = "Local fixture"', `base_url = "${url}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false', 'supports_websockets = false', 'request_max_retries = 0'].join('\n'));
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, CODEX_HOME: codex, TEMP: temp, TMP: temp, HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url, NO_PROXY: '127.0.0.1,localhost' };
    for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATH']) if (process.env[key]) env[key] = process.env[key];
    expect(execFileSync(bin, ['--version'], { env, windowsHide: true, encoding: 'utf8' }).trim()).toBe('codex-cli 0.169.0');
    runtime = await RuntimeService.create({ bin, home: codex, workerHome: home, cwd: project, env, dev: true });
    const context = { clientId: 'extensions', operationId: '00000000-0000-0000-0000-000000000001', beforeWrite: () => {} };
    expect(await runtime.call('account/gatewayOAuth/read', {}, context)).toMatchObject({ required: false, status: null });
    const verification = object(await runtime.call('userVerification/status', {}, context));
    expect(verification).toHaveProperty('unavailableReason'); expect(verification).toHaveProperty('credentialId');
    const before = object(await runtime.call('settings/read', { cwd: project }, context)); expect(before.userVersion).toEqual(expect.any(String));
    const written = object(await runtime.call('settings/write', { expectedVersion: before.userVersion!, changes: [{ key: 'model_reasoning_effort', value: 'high' }] }, context)); expect(written.status).toBe('ok');
    const after = object(await runtime.call('settings/read', { cwd: project }, context)); expect(object(after.config).model_reasoning_effort).toBe('high'); expect(after.userVersion).not.toBe(before.userVersion);
    await expect(runtime.call('settings/write', { expectedVersion: before.userVersion!, changes: [{ key: 'model_reasoning_effort', value: 'low' }] }, context)).rejects.toMatchObject({ code: 'native_error', delivery: 'not_sent' });
    const mcpBefore = object(await runtime.call('mcp/config/read', { cwd: project }, context));
    await runtime.call('mcp/config/write', { cwd: project, expectedVersion: mcpBefore.userVersion!, name: 'isolated_disabled', change: { type: 'upsert', transport: 'stdio', command: 'never-start-this-fixture', enabled: false, env: { FIXTURE_ONLY: 'preserved-local-secret' } } }, context);
    const mcpSaved = object(await runtime.call('mcp/config/read', { cwd: project }, context)); expect(mcpSaved.servers).toMatchObject([{ name: 'isolated_disabled', enabled: false, hasEnv: true }]); expect(JSON.stringify(mcpSaved)).not.toContain('preserved-local-secret');
    await runtime.call('mcp/config/write', { cwd: project, expectedVersion: mcpSaved.userVersion!, name: 'isolated_disabled', change: { type: 'upsert', transport: 'stdio', args: ['changed'] } }, context);
    expect(readFileSync(path.join(codex, 'config.toml'), 'utf8')).toContain('preserved-local-secret');
    await expect(runtime.call('mcp/config/write', { cwd: project, expectedVersion: mcpSaved.userVersion!, name: 'isolated_disabled', change: { type: 'remove' } }, context)).rejects.toMatchObject({ code: 'config_conflict', delivery: 'not_sent' });
    const mcpCurrent = object(await runtime.call('mcp/config/read', { cwd: project }, context));
    await runtime.call('mcp/config/write', { cwd: project, expectedVersion: mcpCurrent.userVersion!, name: 'isolated_disabled', change: { type: 'remove' } }, context);
    const list = object(await runtime.call('skills/list', { cwd: project, forceReload: true }, context));
    const skill = (list.data as JsonValue[]).flatMap(entry => object(entry).skills as JsonValue[]).map(value => object(value)).find(entry => entry.name === 'fixture'); expect(skill).toBeTruthy();
    expect(object(await runtime.call('skills/read', { cwd: project, skillId: skill!.skillId! }, context)).text).toContain('Isolated extension acceptance fixture');
    const nestedProject = path.join(project, 'nested'); mkdirSync(nestedProject);
    const nestedSkills = object(await runtime.call('skills/list', { cwd: nestedProject, forceReload: true }, context));
    const ancestorSkill = (nestedSkills.data as JsonValue[]).flatMap(entry => object(entry).skills as JsonValue[]).map(value => object(value)).find(entry => entry.name === 'fixture');
    expect(ancestorSkill?.path).toBe(path.join(skills, 'SKILL.md'));
    expect(object(await runtime.call('skills/read', { cwd: nestedProject, skillId: ancestorSkill!.skillId! }, context)).text).toContain('Isolated extension acceptance fixture');
    await runtime.call('skills/extraRoots/set', { roots: [path.join(project, '.agents', 'skills')], confirm: true }, context);
    expect(await runtime.call('skills/extraRoots/read', {}, context)).toMatchObject({ roots: [path.join(project, '.agents', 'skills')], persistence: 'current_runtime' });
    await runtime.call('skills/extraRoots/set', { roots: [], confirm: true }, context);
    expect(await runtime.call('skills/config/write', { cwd: project, skillId: skill!.skillId!, enabled: false }, context)).toEqual({ effectiveEnabled: false });
    const refreshed = object(await runtime.call('skills/list', { cwd: project, forceReload: true }, context));
    expect((refreshed.data as JsonValue[]).flatMap(entry => object(entry).skills as JsonValue[]).find(value => object(value).name === 'fixture')).toMatchObject({ enabled: false });
    expect(await runtime.call('hooks/list', { cwd: project }, context)).toHaveProperty('data');
    expect(await runtime.call('plugin/installed', { cwd: project }, context)).toHaveProperty('marketplaces');
    expect(await runtime.call('marketplace/add', { cwd: project, source: { type: 'project', path: 'test-marketplace' } }, context)).toMatchObject({ marketplaceName: 'test-marketplace' });
    const shown = object(await runtime.call('plugin/read', { cwd: project, pluginId: 'local-fixture@test-marketplace' }, context));
    const pluginSkills = object(shown.plugin).skills as JsonValue[]; expect(pluginSkills.length).toBeGreaterThan(0);
    expect(await runtime.call('plugin/skill/read', { cwd: project, pluginId: 'local-fixture@test-marketplace', skillName: object(pluginSkills[0]).name! }, context)).toMatchObject({ contents: expect.stringContaining('Only a local protocol acceptance fixture.') });
    expect(await runtime.call('plugin/share/preview', { cwd: project, pluginId: 'local-fixture@test-marketplace' }, context)).toMatchObject({ pluginId: 'local-fixture@test-marketplace', files: expect.any(Array), previewHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(object(object(shown.plugin).summary)).toMatchObject({ installed: false });
    expect(await runtime.call('plugin/install', { cwd: project, pluginId: 'local-fixture@test-marketplace', previewHash: shown.previewHash! }, context)).toMatchObject({ pluginId: 'local-fixture@test-marketplace', authPolicy: expect.any(String) });
    const installed = object(await runtime.call('plugin/installed', { cwd: project }, context));
    expect((installed.marketplaces as JsonValue[]).flatMap(row => object(row).plugins as JsonValue[]).some(row => object(row).id === 'local-fixture@test-marketplace' && object(row).installed === true)).toBe(true);
    expect(await runtime.call('plugin/skill/read', { cwd: project, pluginId: 'local-fixture@test-marketplace', skillName: object(pluginSkills[0]).name! }, context)).toMatchObject({ contents: expect.stringContaining('Only a local protocol acceptance fixture.') });
    await runtime.call('plugin/uninstall', { cwd: project, pluginId: 'local-fixture@test-marketplace' }, context);
    expect(object(object(object(await runtime.call('plugin/read', { cwd: project, pluginId: 'local-fixture@test-marketplace' }, context)).plugin).summary).installed).toBe(false);
    expect(await runtime.call('marketplace/remove', { cwd: project, marketplaceName: 'test-marketplace' }, context)).toMatchObject({ marketplaceName: 'test-marketplace' });
    expect(await runtime.call('experimentalFeature/list', { limit: 100 }, context)).toHaveProperty('data');
    expect(await runtime.call('memory/status', {}, context)).toHaveProperty('v2Ready');
    expect(await runtime.call('memory/reset', { confirm: true }, context)).toEqual({});
    expect(await runtime.call('configRequirements/read', {}, context)).toHaveProperty('requirements');
    expect(await runtime.call('server/diagnostics', {}, context)).toHaveProperty('gauges');
    const preview = object(await runtime.call('import/preview', { cwd: project }, context));
    const importItem = (preview.items as JsonValue[]).map(value => object(value)).find(value => value.itemType === 'AGENTS_MD'); expect(importItem).toBeTruthy();
    const imported = object(await runtime.call('import/apply', { cwd: project, previewHash: preview.previewHash!, itemIds: [importItem!.itemId!], confirm: true }, context));
    expect(imported.completed).toBe(true); expect(readFileSync(path.join(project, 'AGENTS.md'), 'utf8')).toContain('Isolated import fixture');
    expect(object(await runtime.call('import/history', { cwd: project }, context)).data).toEqual(expect.arrayContaining([expect.objectContaining({ importId: imported.importId })]));
    mkdirSync(path.join(project, '.codex'), { recursive: true }); writeFileSync(path.join(project, '.codex', 'config.toml'), 'model_reasoning_effort = "low"\n');
    const trustBefore = object(await runtime.call('project/trust/read', { cwd: project }, context));
    expect(trustBefore.configuredTrust).toBeNull();
    await runtime.call('project/trust/write', { cwd: project, expectedVersion: trustBefore.userVersion!, trustLevel: 'trusted', confirm: true }, context);
    const trusted = object(await runtime.call('project/trust/read', { cwd: project }, context)); expect(trusted.configuredTrust).toBe('trusted');
    expect(object(object(await runtime.call('settings/read', { cwd: project }, context)).config).model_reasoning_effort).toBe('low');
    await runtime.call('project/trust/write', { cwd: project, expectedVersion: trusted.userVersion!, trustLevel: 'untrusted', confirm: true }, context);
    expect(object(object(await runtime.call('settings/read', { cwd: project }, context)).config).model_reasoning_effort).toBe('high');
    const feedbackThread = object(object(await runtime.native.call('thread/start', { cwd: project })).thread);
    const feedback = object(await runtime.call('feedback/save', { cwd: project, threadId: feedbackThread.id!, classification: 'bug', reason: 'Isolated local feedback fixture', includeLogs: false, confirm: true }, context));
    expect(feedback.saved).toBe(true); expect(readFileSync(path.join(project, String(feedback.path))).subarray(0, 2).toString()).toBe('PK');
    await expect(runtime.call('feedback/save', { cwd: project, threadId: feedbackThread.id!, classification: 'bug', includeLogs: false, confirm: true }, context)).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(await runtime.call('rollout/compress', { confirm: true }, context)).toEqual({ triggered: true, completionConfirmed: false });
    expect(modelRequests).toBe(0);
}), scenarioTimeout);

test('custom MCP changes preserve native TOML and reload the selected literal server', async () => {
  const { nativeTestEnvironment } = await import('../fixtures/native-env.js');
  const parent = path.resolve('.work/extensions-native');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'mcp-source-')), home = path.join(root, 'codex');
  const env = nativeTestEnvironment({ home: root, codexHome: home, temporary: path.join(root, 'tmp') });
  const file = path.join(home, 'config.toml'), name = 'work.区域 "a"\\leaf';
  const other = '  personal = {command="echo", enabled=false, env={ # keep sibling\r\n    DOC_LANG="zh_CN", # regional operator\r\n  },},\r\n';
  const date = 'stamp=0000-01-01, # native temporal value';
  const secret = '  KEEP="fixture-private", # retained credential setting';
  const raw = '\ufeffcheck_for_update_on_startup=false\r\nmcp_servers={\r\n' + other +
    '  ' + JSON.stringify(name) + '={command="echo", enabled=false, ' + date + '\r\n  env={\r\n' + secret + '\r\n  },},\r\n}\r\n';
  writeFileSync(file, raw);
  const service = await RuntimeService.create({ bin, home, workerHome: root, cwd: root, env, dev: true });
  const ctx = { clientId: 'source-preserving-mcp', beforeWrite: () => {} };
  const read = async () => object(await service.call('mcp/config/read', { cwd: root }, ctx));
  const rawRead = async () => {
    const layers = object(await service.native.call('config/read', { cwd: root, includeLayers: true })).layers as JsonValue[];
    const user = layers.map(layer => object(layer)).find(layer => object(layer.name).type === 'user' && object(layer.name).profile === null)!;
    return object(object(user.config).mcp_servers ?? {});
  };
  const change = async (server: string, edit: Record<string, JsonValue>, version?: JsonValue) => service.call('mcp/config/write',
    { cwd: root, name: server, expectedVersion: version ?? (await read()).userVersion!, change: edit }, ctx);
  const source = () => readFileSync(file, 'utf8');
  try {
    const beforeNote = (await read()).userVersion!;
    writeFileSync(file, raw + '# operator added this note\r\n');
    await expect(change(name, { type: 'remove' }, beforeNote)).rejects.toMatchObject({ code: 'config_conflict', delivery: 'not_sent' });
    expect(source()).toBe(raw + '# operator added this note\r\n');
    const firstVersion = (await read()).userVersion!;
    await change(name, { type: 'upsert', transport: 'stdio', args: ['changed'] }, firstVersion);
    const firstSave = source();
    expect(firstSave).toContain(other); expect(firstSave).toContain(date); expect(firstSave).toContain(secret);
    expect(firstSave.charCodeAt(0)).toBe(0xfeff); expect(firstSave.replaceAll('\r\n', '')).not.toContain('\n');
    const target = object((await rawRead())[name]);
    expect(target.stamp).toEqual({ '$__toml_private_datetime': '0000-01-01' });
    expect(target.args).toEqual(['changed']);
    expect(JSON.stringify(await read())).not.toContain('fixture-private');
    await expect(change(name, { type: 'remove' }, firstVersion)).rejects.toMatchObject({ code: 'config_conflict', delivery: 'not_sent' });
    expect(source()).toBe(firstSave);
    await change(name, { type: 'upsert', transport: 'http', url: 'http://127.0.0.1:9', enabled: false });
    const converted = object((await rawRead())[name]);
    expect(converted).toMatchObject({ url: 'http://127.0.0.1:9/', enabled: false, stamp: target.stamp });
    for (const old of ['command', 'args', 'env']) expect(converted).not.toHaveProperty(old);
    expect(source()).toContain(other);
    await change(name, { type: 'remove' });
    expect(Object.keys(await rawRead())).toEqual(['personal']); expect(source()).toContain(other);
    await change(name, { type: 'upsert', transport: 'stdio', command: 'echo', enabled: false });
    expect((await rawRead())[name]).toEqual({ command: 'echo', enabled: false }); expect(source()).toContain(other);
    await change('toString', { type: 'upsert', transport: 'stdio', command: 'echo', enabled: false });
    await change('toString', { type: 'remove' });
    expect(Object.keys(await rawRead())).toEqual(expect.arrayContaining(['personal', name]));
    expect(Object.keys(await rawRead())).not.toContain('toString');
  } finally { await service.close(); expectNativeClosed(service.native); }
}, scenarioTimeout);

test('locates disabled user MCP servers with colliding display names through the pinned CLI', async () => {
  const parent = path.resolve('.work/extensions-native'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'mcp-names-')), home = path.join(root, 'codex');
  const env = nativeTestEnvironment({ home: root, codexHome: home, temporary: path.join(root, 'tmp') });
  env.HARNESS_PROVIDER_KEY_DEFAULT = 'lilac';
  env.HARNESS_PROVIDER_API_KEY = 'amber';
  writeFileSync(path.join(home, 'config.toml'), [
    'check_for_update_on_startup=false', '[mcp_servers.notes-lilac]', 'command="first-local"', 'enabled=false',
    '[mcp_servers.notes-amber]', 'command="second-local"', 'enabled=false',
  ].join('\n'));
  const runtime = await RuntimeService.create({ bin: process.env.HARNESS_TEST_CODEX_BIN!, home, workerHome: root, cwd: root, env, dev: true });
  const context = { clientId: 'mcp-names', beforeWrite: () => {} };
  const read = async () => object(await runtime.call('mcp/config/read', { cwd: root }, context));
  const update = (params: JsonObject) => runtime.call('mcp/config/write', { ...params, cwd: root }, context);
  const privateServers = async () => {
    const state = object(await runtime.native.call('config/read', { cwd: root, includeLayers: true }));
    const user = (state.layers as JsonObject[]).find(layer => object(layer.name).type === 'user')!;
    return object(object(user.config).mcp_servers);
  };
  try {
    const before = await read(), rows = before.servers as JsonObject[];
    expect(rows.map(row => row.name)).toEqual(['notes-[redacted]', 'notes-[redacted]']);
    expect(JSON.stringify(before)).not.toMatch(/lilac|amber/);
    const first = rows.find(row => row.command === 'first-local')!.id!, second = rows.find(row => row.command === 'second-local')!.id!;
    expect(new Set([first, second]).size).toBe(2);
    const change = { type: 'upsert', transport: 'stdio', command: 'changed-local', enabled: false };
    await expect(update({ name: 'notes-lilac', createOnly: true, expectedVersion: before.userVersion!, change }))
      .rejects.toMatchObject({ code: 'config_conflict', delivery: 'not_sent' });
    await expect(update({ name: 'notes-[redacted]', expectedVersion: before.userVersion!, change: { type: 'remove' } }))
      .rejects.toMatchObject({ code: 'config_conflict', delivery: 'not_sent' });
    await update({ id: first, expectedVersion: before.userVersion!, change });
    expect(await privateServers()).toMatchObject({ 'notes-lilac': { command: 'changed-local', enabled: false },
      'notes-amber': { command: 'second-local', enabled: false } });
    await expect(update({ id: second, expectedVersion: before.userVersion!, change: { type: 'remove' } }))
      .rejects.toMatchObject({ code: 'config_conflict', delivery: 'not_sent' });
    await update({ id: second, expectedVersion: (await read()).userVersion!, change: { type: 'remove' } });
    expect(Object.keys(await privateServers())).toEqual(['notes-lilac']);
    await update({ name: 'new-local', createOnly: true, expectedVersion: (await read()).userVersion!, change });
    await update({ name: 'new-local', expectedVersion: (await read()).userVersion!, change: { type: 'remove' } });
    expect(Object.keys(await privateServers())).toEqual(['notes-lilac']);
  } finally { await runtime.close(); expectNativeClosed(runtime.native); }
}, scenarioTimeout);

test('cold-reloads MCP environment forwarding, header helpers and HTTP-only settings after selective edits', async () => {
  const parent = path.resolve('.work/extensions-native'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'mcp-fields-')), home = path.join(root, 'codex');
  const env = nativeTestEnvironment({ home: root, codexHome: home, temporary: path.join(root, 'tmp') });
  const options = { bin: process.env.HARNESS_TEST_CODEX_BIN!, home, workerHome: root, cwd: root, env, dev: true };
  writeFileSync(path.join(home, 'config.toml'), [
    'check_for_update_on_startup=false', '[mcp_servers.stdio]', 'command="inert-fixture"', 'enabled=false',
    'env_vars=["PLAIN_LABEL", {name="STRUCTURED_LABEL", source="local"}]', 'args=["old"]',
    '[mcp_servers.http]', 'url="http://127.0.0.1:9/mcp"', 'enabled=false', 'http_headers_helper="inert-header-fixture"',
    'http_headers={ X="fixed-label" }', 'env_http_headers={ Y="HEADER_LABEL" }', 'bearer_token_env_var="BEARER_LABEL"',
    'auth="oauth"', 'oauth={client_id="local-client",client_secret="preserved-label"}', 'oauth_resource="http://127.0.0.1:9/resource"',
    'scopes=["read"]', 'required=false', 'future_setting="unrelated"',
    '[mcp_servers.convert_http]', 'enabled=false', 'url="http://127.0.0.1:9/mcp"', 'http_headers_helper="inert-header-fixture"',
    'auth="oauth"', 'oauth={client_id="client",client_secret="preserved-label"}', 'oauth_resource="http://127.0.0.1:9/resource"',
    'scopes=["read"]', 'required=false', 'future_setting="unrelated"',
    '[mcp_servers.convert_stdio]', 'enabled=false', 'command="inert-fixture"', 'args=["old"]', 'cwd="."',
    'env={OLD="local"}', 'env_vars=[{name="STRUCTURED_LABEL",source="local"}]', 'future_setting="unrelated"', '',
  ].join('\n'));
  let runtime = await RuntimeService.create(options);
  const context = { clientId: 'mcp-fields', beforeWrite: () => {} };
  const read = async () => object(await runtime.call('mcp/config/read', { cwd: root }, context));
  const nativeRows = async () => {
    const state = object(await runtime.native.call('config/read', { cwd: root, includeLayers: true }));
    const layer = (state.layers as JsonObject[]).find(row => object(row.name).type === 'user')!;
    return { private: object(object(layer.config).mcp_servers), effective: object(object(state.config).mcp_servers) };
  };
  const save = async (name: string, change: JsonObject) => {
    const snapshot = await read(), row = (snapshot.servers as JsonObject[]).find(s => s.name === name)!;
    await runtime.call('mcp/config/write', { cwd: root, expectedVersion: snapshot.userVersion!, id: row.id!, change }, context);
  };
  const restart = async () => { await runtime.close(); runtime = await RuntimeService.create(options); };
  try {
    const before = await read(), original = await nativeRows();
    expect((before.servers as JsonObject[]).find(s => s.name === 'stdio')).toMatchObject({ hasEnv: true, hasForwardedEnv: true });
    expect((before.servers as JsonObject[]).find(s => s.name === 'http')).toMatchObject({ hasHttpHeaders: true, hasHeaderHelper: true });
    expect(JSON.stringify(before)).not.toMatch(/PLAIN_LABEL|STRUCTURED_LABEL|inert-header-fixture|preserved-label|HEADER_LABEL|BEARER_LABEL/);
    await save('stdio', { type: 'upsert', transport: 'stdio', args: ['new'] });
    await save('http', { type: 'upsert', transport: 'http', url: 'http://127.0.0.1:9/changed' });
    await restart();
    const changed = (await nativeRows()).private;
    expect(changed.stdio).toEqual({ ...object(original.private.stdio), args: ['new'] });
    expect(changed.http).toEqual({ ...object(original.private.http), url: 'http://127.0.0.1:9/changed' });
    await save('stdio', { type: 'upsert', transport: 'stdio', clearSecrets: true });
    await save('http', { type: 'upsert', transport: 'http', clearSecrets: true });
    for (const cold of [false, true]) {
      if (cold) await restart();
      const rows = await nativeRows();
      expect(object(rows.private.stdio)).not.toHaveProperty('env_vars');
      expect(object(rows.effective.stdio).env_vars ?? []).toEqual([]);
      const http = object(rows.private.http);
      for (const key of ['http_headers_helper', 'http_headers', 'env_http_headers', 'bearer_token_env_var'])
        expect(http).not.toHaveProperty(key);
      expect(http.oauth).toEqual(object(original.private.http).oauth);
      expect((await read()).servers).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'stdio', hasEnv: false, hasForwardedEnv: false }),
        expect.objectContaining({ name: 'http', hasHttpHeaders: false, hasHeaderHelper: false, hasEnvHttpHeaders: false, hasBearerTokenEnvVar: false }),
      ]));
    }
    await save('convert_http', { type: 'upsert', transport: 'stdio', command: 'new-inert-fixture' });
    await save('convert_stdio', { type: 'upsert', transport: 'http', url: 'http://127.0.0.1:9/new' });
    await restart();
    const converted = (await nativeRows()).private;
    expect(converted.convert_http).toEqual({ enabled: false, command: 'new-inert-fixture', scopes: ['read'], required: false, future_setting: 'unrelated' });
    expect(converted.convert_stdio).toEqual({ enabled: false, url: 'http://127.0.0.1:9/new', future_setting: 'unrelated' });
    for (const explicit of [true, false]) {
      await save('stdio', { type: 'upsert', transport: 'stdio', enabled: explicit });
      expect(object((await nativeRows()).private.stdio).enabled).toBe(explicit);
      await save('stdio', { type: 'upsert', transport: 'stdio', enabled: null });
      await restart();
      expect(object((await nativeRows()).private.stdio)).not.toHaveProperty('enabled');
      expect((await read()).servers).toContainEqual(expect.objectContaining({ name: 'stdio', enabled: true, hasEnabledOverride: false }));
    }
  } finally { await runtime.close(); expectNativeClosed(runtime.native); }
}, scenarioTimeout);
