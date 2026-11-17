import { expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
test('installed schema consumers convert and validate both supported Zod schema forms', async () => {
  const vision = path.dirname(realpathSync('node_modules/@z_ai/mcp-server/package.json'));
  const visionRequire = createRequire(path.join(vision, 'package.json'));
  const sdkServer = visionRequire.resolve('@modelcontextprotocol/sdk/server/mcp.js');
  const sdkRequire = createRequire(sdkServer);
  const converter = await import(pathToFileURL(path.join(path.dirname(sdkServer), 'zod-json-schema-compat.js')).href);
  for (const entry of ['zod/v3', 'zod/v4']) {
    const { z } = await import(pathToFileURL(sdkRequire.resolve(entry)).href);
    const schema = z.object({ text: z.string().min(1), count: z.number().int().min(0) });
    const converted = converter.toJsonSchemaCompat(schema, { target: 'draft-7' });
    expect(converted).toMatchObject({ type: 'object', properties: { text: { type: 'string', minLength: 1 }, count: { type: 'integer', minimum: 0 } } });
    expect(converter.parseWithCompat(schema, { text: 'fixture', count: 1 })).toEqual({ text: 'fixture', count: 1 });
    expect(() => converter.parseWithCompat(schema, { text: '', count: -1 })).toThrow();
  }
});
function directory() {
  const parent = path.resolve('.work/vision-compat'); mkdirSync(parent, { recursive: true });
  return mkdtempSync(path.join(parent, 'case-'));
}
test('the pinned real vision package retains all eight stdio schemas with reviewed SDK/Zod and no network or tool calls', () => {
  const output = path.join(directory(), 'stdio.json');
  execFileSync(process.execPath, ['tests/deploy/vision_stdio_probe.mjs', root, output], { cwd: root, timeout: 40000, maxBuffer: 1024 * 1024, windowsHide: true });
  const report = JSON.parse(readFileSync(output, 'utf8'));
  const contract = JSON.parse(readFileSync('reference/BUILTIN-MCP-CONTRACT.json', 'utf8'));
  expect(report).toMatchObject({ vision: contract.servers[3].version, sdk: '1.32.2', zod: '4.6.7', toolCount: 8, networkAttempts: 0, toolCalls: 0, closed: { code: 0 } });
  expect(report.registeredSchemas).toHaveLength(8);
}, 45000);

test('the reviewed vision update retains one Bearer prefix and its documented timeout using only a substituted fetch', () => {
  const home = directory(), script = path.join(home, 'headers.mjs');
  const packageRoot = path.dirname(realpathSync('node_modules/@z_ai/mcp-server/package.json'));
  writeFileSync(script, `import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';import path from 'node:path';
const deny=()=>{throw Error('Network is forbidden');};const net=await import('node:net');net.Socket.prototype.connect=deny;
const {configurationService}=await import(pathToFileURL(path.join(${JSON.stringify(packageRoot)},'build/core/environment.js')));
const {ChatService}=await import(pathToFileURL(path.join(${JSON.stringify(packageRoot)},'build/core/chat-service.js')));
assert.equal(configurationService.getVisionConfig().timeout,600000);
assert.equal(configurationService.getVisionConfig().url,'https://open.bigmodel.cn/api/paas/v4/chat/completions');
const calls=[];globalThis.fetch=async(url,options)=>{assert.equal(url,'https://fixture.invalid/no-network');calls.push(options.headers.Authorization);return {ok:true,json:async()=>({fixture:true})};};
for(const value of ['fixture-credential','Bearer fixture-credential']) assert.deepEqual(await new ChatService({getApiKey:()=>value}).chatCompletions('https://fixture.invalid/no-network',{}),{fixture:true});
assert.deepEqual(calls,['Bearer fixture-credential','Bearer fixture-credential']);process.stdout.write('fixture-passed');`);
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, TMP: home, TEMP: home, Z_AI_API_KEY: 'fixture-local-credential', Z_AI_MODE: 'ZHIPU' };
  for (const name of ['SystemRoot', 'WINDIR', 'PATH']) if (process.env[name]) env[name] = process.env[name];
  const result = execFileSync(process.execPath, [script], { cwd: home, env, encoding: 'utf8', timeout: 10000, maxBuffer: 65536, windowsHide: true });
  expect(result).toContain('fixture-passed');
});
