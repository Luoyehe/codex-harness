import { expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RuntimeService } from '../../src/runtime/service.js';
import { object, type RuntimeEvent } from '../../src/runtime/types.js';
import { nativeTestEnvironment } from '../fixtures/native-env.js';

test('official CLI process workflows preserve real terminal input, output caps, exit codes and descendant cleanup', async () => {
  const parent = path.resolve('.work/process-native'); mkdirSync(parent, { recursive: true }); const workerHome = mkdtempSync(path.join(parent, 'home-')), home = path.join(workerHome, 'codex'), tmp = path.join(workerHome, 'tmp'); mkdirSync(home); mkdirSync(tmp); writeFileSync(path.join(home, 'config.toml'), 'check_for_update_on_startup = false\n');
  const env = nativeTestEnvironment({ home: workerHome, codexHome: home, temporary: tmp });
  const bin = process.env.HARNESS_TEST_CODEX_BIN ?? path.resolve('reference/runtime/codex-0.164.0/package/vendor/x86_64-pc-windows-msvc/bin/codex.exe'); const runtime = await RuntimeService.create({ bin, home, workerHome, cwd: workerHome, env, dev: true }); const events: RuntimeEvent[] = []; runtime.on('event', event => events.push(event)); const context = { clientId: 'process-native', eventChannelId: 'owner', beforeWrite: () => {} }; const pid = runtime.native.processId; const childFile = path.join(workerHome, 'child.json'); let childPid: number | undefined;
  try {
    const fixture = path.join(workerHome, 'root.mjs'); writeFileSync(fixture, "import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true,windowsHide:true});writeFileSync(process.argv[2],JSON.stringify({child:child.pid}));child.unref();process.stdout.write('x'.repeat(4096));setTimeout(()=>process.exit(7),100);");
    const spawned = object(await runtime.call('process/spawn', { cwd: workerHome, command: [process.execPath, fixture, childFile], outputBytesCap: 1024 }, context));
    const read = () => runtime.call('process/read', { processHandle: spawned.processHandle! }, context);
    await expect.poll(async () => object(await read()).status, { timeout: 10000 }).toBe('exited'); const output = object(await read()); expect(output.exitCode).toBe(7); expect(output.stdoutCapReached).toBe(true); expect(Buffer.from(String(output.stdoutBase64), 'base64')).toHaveLength(1024);
    childPid = JSON.parse(readFileSync(childFile, 'utf8')).child; expect(() => process.kill(childPid!, 0)).toThrow(); await expect(runtime.call('process/read', { processHandle: spawned.processHandle! }, { ...context, eventChannelId: 'foreign' })).rejects.toMatchObject({ code: 'not_found' });
    const terminalFile = path.join(workerHome, 'terminal.mjs'); writeFileSync(terminalFile, "import {createInterface} from 'node:readline';console.log('TTY='+process.stdin.isTTY+':'+process.stdout.isTTY);createInterface({input:process.stdin}).on('line',line=>{console.log('INPUT='+line);if(line==='done')process.exit(3);});");
    const terminal = object(await runtime.call('process/spawn', { cwd: workerHome, command: [process.execPath, terminalFile], tty: true, size: { rows: 24, cols: 80 } }, context));
    const text = async () => Buffer.from(String(object(await runtime.call('process/read', { processHandle: terminal.processHandle! }, context)).stdoutBase64), 'base64').toString('utf8');
    await expect.poll(text, { timeout: 10000 }).toContain('TTY=true:true'); await runtime.call('process/resizePty', { processHandle: terminal.processHandle!, size: { rows: 30, cols: 100 } }, context); await runtime.call('process/writeStdin', { processHandle: terminal.processHandle!, deltaBase64: Buffer.from('done\r\n').toString('base64') }, context);
    await expect.poll(async () => object(await runtime.call('process/read', { processHandle: terminal.processHandle! }, context)).exitCode, { timeout: 10000 }).toBe(3); expect(await text()).toContain('INPUT=done');
    const sleeping = object(await runtime.call('process/spawn', { cwd: workerHome, command: [process.execPath, '-e', 'setInterval(()=>{},1000)'], timeoutMs: 100 }, context)); await expect.poll(async () => object(await runtime.call('process/read', { processHandle: sleeping.processHandle! }, context)).status, { timeout: 10000 }).toBe('exited'); expect(object(await runtime.call('process/read', { processHandle: sleeping.processHandle! }, context)).timedOut).toBe(true);
    const toClose = object(await runtime.call('process/spawn', { cwd: workerHome, command: [process.execPath, '-e', 'setInterval(()=>{},1000)'] }, context)); await runtime.clientDisconnected(context.clientId, context.eventChannelId); expect(object(object(runtime.status()).activity).processes).toBe(0); await expect(runtime.call('process/read', { processHandle: toClose.processHandle! }, context)).rejects.toMatchObject({ code: 'not_found' }); expect(runtime.native.connected).toBe(true);
    expect(events.some(event => event.type === 'process' && event.eventChannelId === context.eventChannelId && object(event.data).clientId === context.clientId)).toBe(true);
  } finally { await runtime.close(); if (pid) expect(() => process.kill(pid, 0)).toThrow(); if (childPid) expect(() => process.kill(childPid!, 0)).toThrow(); }
}, 30000);
