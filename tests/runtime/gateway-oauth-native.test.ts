import { expect, test } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RuntimeService } from '../../src/runtime/service.js';
import { object, type RuntimeEvent } from '../../src/runtime/types.js';
import { nativeTestEnvironment } from '../fixtures/native-env.js';

test('a configured gateway remains notReady until explicit login and emits no automatic authorization handoff', async () => {
  const base = path.resolve('.work/gateway-oauth-native'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'home-')), home = path.join(root, 'codex'), temp = path.join(root, 'tmp'); mkdirSync(home); mkdirSync(temp);
  const requests: string[] = []; const deny = createServer((req, res) => { requests.push(req.method + ' ' + req.url); req.resume(); res.writeHead(503); res.end(); }); deny.on('connect', (req, socket) => { requests.push('CONNECT ' + req.url); socket.end('HTTP/1.1 503 Denied\r\nContent-Length: 0\r\n\r\n'); });
  await new Promise<void>(resolve => deny.listen(0, '127.0.0.1', resolve)); const proxy = `http://127.0.0.1:${(deny.address() as AddressInfo).port}`;
  const catalog = path.join(root, 'models.json'); writeFileSync(catalog, readFileSync('tests/runtime/fixture-model-catalog.json'));
  writeFileSync(path.join(home, 'config.toml'), `check_for_update_on_startup=false\nmodel="harness-loopback-fixture"\nmodel_provider="fixture_gateway"\nmodel_catalog_json=${JSON.stringify(catalog)}\n[features]\nplugins=false\n[model_providers.fixture_gateway]\nname="Fixture gateway"\nbase_url="https://responses.invalid/v1"\nwire_api="responses"\nrequires_openai_auth=true\nsupports_websockets=false\n[model_providers.fixture_gateway.gateway_oauth]\nauthorization_url="https://login.invalid/authorize"\ntoken_url="https://login.invalid/token"\nclient_id="isolated-fixture"\n[model_providers.fixture_gateway.gateway_oauth.delivery]\nkind="cookie"\nname="fixture-auth"\n`);
  const env = { ...nativeTestEnvironment({ home: root, codexHome: home, temporary: temp }), HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, BROWSER: path.join(root, 'no-browser-fixture') };
  let runtime: RuntimeService | undefined; const events: RuntimeEvent[] = [];
  try {
    runtime = await RuntimeService.create({ bin: process.env.HARNESS_TEST_CODEX_BIN!, home, workerHome: root, cwd: root, env, dev: true }); runtime.on('event', event => events.push(event));
    const context = { clientId: 'fixture', eventChannelId: 'channel' };
    for (let index = 0; index < 3; index++) expect(await runtime.call('account/gatewayOAuth/read', {}, context)).toMatchObject({ providerId: 'fixture_gateway', required: true, status: 'notReady', error: null });
    expect(events.filter(event => event.type === 'notification' && object(event.data).method === 'account/gatewayOAuth/changed').some(event => object(object(event.data).params).status === 'started')).toBe(false);
    // The fixed CLI's plugin startup sync first uses GitHub git, then its API.
    // This account-only fixture disables that unrelated feature, not the proxy.
    // See rust-v0.164.0 codex-rs/core-plugins/src/startup_sync.rs:77-124.
    // Every attempted connection is still denied; readiness cannot contact
    // the configured provider or authorization/token endpoint.
    expect(requests.filter(request => /(?:responses|login)\.invalid/.test(request))).toEqual([]);
    expect(requests.length).toBeLessThanOrEqual(16);
    expect(requests.filter(request => !['CONNECT chatgpt.com:443', 'CONNECT api.github.com:443'].includes(request))).toEqual([]);
  } finally { await runtime?.close(); deny.closeAllConnections(); await new Promise<void>(resolve => deny.close(() => resolve())); }
}, 15000);
