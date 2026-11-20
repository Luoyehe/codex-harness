import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RuntimeService } from '../../dist/src/runtime/service.js';
import { receiptResult } from '../../dist/src/gateway/receipt-result.js';
import { nativePrerequisite } from '../../scripts/select-tests.mjs';
import { nativeTestEnvironment } from './native-env.ts';

const root = process.argv[2];
assert.equal(process.platform, 'linux');
assert.equal(process.getuid(), 0);
assert.equal(readFileSync('/etc/codex/harness-private-fixture', 'utf8'), root);
const prerequisite = nativePrerequisite();
assert.equal(prerequisite.status, 'ready', prerequisite.reason);
const home = path.join(root, 'codex'), temp = path.join(root, 'tmp');
mkdirSync(home); mkdirSync(temp);
const file = path.join(home, 'config.toml');
writeFileSync(file, 'check_for_update_on_startup=false\n[mcp_servers.localcompanion]\ncommand="/bin/true"\n');
const config = { bin: prerequisite.binary, home, workerHome: root, cwd: root, dev: true,
  env: nativeTestEnvironment({ home: root, codexHome: home, temporary: temp }) };
const context = { clientId: 'owner', eventChannelId: 'native', beforeWrite() {} };
let service = await RuntimeService.create(config);
const read = async () => service.call('mcp/config/read', { cwd: root }, context);
const row = info => info.inheritedDetails.find(server => server.name === 'systemfixture');
try {
  for (const enabled of [false, true, false, null]) {
    const before = await read(), previous = row(before).effectiveEnabled, desired = enabled ?? true;
    const receipt = await service.call('mcp/config/write', { cwd: root, name: 'systemfixture', expectedVersion: before.userVersion, change: { type: 'inherit', enabled } }, context);
    assert.equal(receiptResult('mcp/config/write', receipt).status, 'ok');
    const pending = row(await read());
    assert.equal(pending.enabled, desired);
    assert.equal(pending.effectiveEnabled, previous);
    assert.equal(pending.overridden, enabled !== null);
    assert.equal(pending.restartRequired, previous !== desired);
    await service.native.call('config/batchWrite', { edits: [{ keyPath: 'model_reasoning_effort', value: 'low', mergeStrategy: 'replace' }], reloadUserConfig: true });
    assert.match(readFileSync(file, 'utf8'), /localcompanion/);
    assert.doesNotMatch(readFileSync(file, 'utf8'), /systemfixture|SYSTEM_FIXTURE_PRIVATE/);
    assert.doesNotMatch(readFileSync(path.join(home, 'harness-mcp-enabled.json'), 'utf8'), /SYSTEM_FIXTURE_PRIVATE/);
    await service.close(); service = await RuntimeService.create(config);
    const refreshed = row(await read());
    assert.equal(refreshed.enabled, desired);
    assert.equal(refreshed.effectiveEnabled, desired);
    assert.equal(refreshed.overridden, enabled !== null);
    assert.equal(refreshed.restartRequired, false);
    const server = (await service.native.call('config/read', { cwd: root })).config.mcp_servers.systemfixture;
    assert.equal(server.command, '/bin/true');
    assert.equal(server.env.FIXTURE_KEY, 'SYSTEM_FIXTURE_PRIVATE');
    assert.equal(server.enabled, desired);
  }
} finally { await service.close(); }
