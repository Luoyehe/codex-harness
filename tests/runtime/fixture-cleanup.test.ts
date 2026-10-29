import { expect, test } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { RuntimeService } from '../../src/runtime/service.js';
import { withFixtureCleanup, type FixtureCleanup } from './fixture-cleanup.js';

async function resources() {
  const parent = path.resolve('.work/fixture-cleanup-tests'); mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(path.join(parent, 'case-'));
  const server = createServer((_request, response) => response.end('local fixture'));
  let child: ChildProcessWithoutNullStreams | undefined, closed: Promise<unknown> | undefined;
  const closeServer = async () => {
    if (!server.listening) return;
    const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections(); await stopped;
  };
  const closeChild = async () => { if (child && child.exitCode === null && child.signalCode === null) child.kill(); await closed; };
  return { home, server, child: () => child, closeServer, closeChild,
    async acquire(defer: FixtureCleanup, afterChild?: () => void, afterServer?: () => void) {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      defer(async () => { await closeServer(); afterServer?.(); });
      child = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n');setTimeout(()=>process.exit(99),15000);setInterval(()=>{},1000)"], {
        cwd: home, env: { HOME: home, USERPROFILE: home, TEMP: home, TMP: home, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
        windowsHide: true, stdio: 'pipe',
      });
      closed = once(child, 'close'); void closed.catch(() => {});
      defer(async () => { await closeChild(); afterChild?.(); });
      await Promise.race([once(child.stdout, 'data'), closed.then(() => { throw new Error('Fixture child exited before readiness'); })]);
      expect(child.pid).toBeGreaterThan(0);
    },
    async fallback() { try { await closeChild(); } finally { await closeServer(); } },
  };
}

test('setup write failure closes already acquired listener and child', async () => {
  const owned = await resources(); let failure: unknown;
  try {
    const rejected = await withFixtureCleanup(async defer => {
      await owned.acquire(defer);
      try { writeFileSync(path.join(owned.home, 'missing-parent', 'config.json'), '{}'); }
      catch (error) { failure = error; throw error; }
    }).catch(error => error);
    expect(rejected).toBe(failure); expect(rejected).toMatchObject({ code: 'ENOENT' });
    expect(owned.server.listening).toBe(false);
    expect(owned.child()!.exitCode !== null || owned.child()!.signalCode !== null).toBe(true);
  } finally { await owned.fallback(); }
});

test('failed native startup closes resources acquired before RuntimeService.create', async () => {
  const owned = await resources(); let failure: unknown, started = false;
  try {
    const rejected = await withFixtureCleanup(async defer => {
      await owned.acquire(defer);
      try {
        const runtime = await RuntimeService.create({ bin: path.join(owned.home, 'missing-executable'), home: owned.home, workerHome: owned.home, cwd: owned.home, env: {} });
        started = true; defer(() => runtime.close());
      } catch (error) { failure = error; throw error; }
    }).catch(error => error);
    expect(started).toBe(false); expect(failure).toBeInstanceOf(Error); expect(rejected).toBe(failure);
    expect(owned.server.listening).toBe(false);
    expect(owned.child()!.exitCode !== null || owned.child()!.signalCode !== null).toBe(true);
  } finally { await owned.fallback(); }
});

test('a failing diagnostic disposer cannot skip listener or child cleanup', async () => {
  const owned = await resources(); let failure: unknown;
  try {
    const rejected = await withFixtureCleanup(async defer => {
      await owned.acquire(defer);
      defer(() => {
        try { writeFileSync(path.join(owned.home, 'missing-parent', 'diagnostic.json'), '{}'); }
        catch (error) { failure = error; throw error; }
      });
    }).catch(error => error);
    expect(failure).toMatchObject({ code: 'ENOENT' });
    expect(rejected).toBeInstanceOf(AggregateError); expect(rejected.errors).toEqual([failure]);
    expect(owned.server.listening).toBe(false);
    expect(owned.child()!.exitCode !== null || owned.child()!.signalCode !== null).toBe(true);
  } finally { await owned.fallback(); }
});

test('one teardown failure does not skip an independent listener or child acknowledgement', async () => {
  const owned = await resources(), failure = new Error('injected child cleanup failure');
  try {
    const rejected = await withFixtureCleanup(async defer => { await owned.acquire(defer, () => { throw failure; }); }).catch(error => error);
    expect(owned.server.listening).toBe(false);
    expect(owned.child()!.exitCode !== null || owned.child()!.signalCode !== null).toBe(true);
    expect(rejected).toBeInstanceOf(AggregateError); expect(rejected.errors).toEqual([failure]);
  } finally { await owned.fallback(); }
});

test('body and independent teardown failures retain every original error after resources stop', async () => {
  const owned = await resources(), body = new Error('body'), child = new Error('child cleanup'), server = new Error('server cleanup');
  try {
    const rejected = await withFixtureCleanup(async defer => {
      await owned.acquire(defer, () => { throw child; }, () => { throw server; }); throw body;
    }).catch(error => error);
    expect(owned.server.listening).toBe(false);
    expect(owned.child()!.exitCode !== null || owned.child()!.signalCode !== null).toBe(true);
    expect(rejected).toBeInstanceOf(AggregateError); expect(rejected.errors).toEqual([body, child, server]); expect(rejected.cause).toBe(body);
  } finally { await owned.fallback(); }
});

test('successful work returns only after resource cleanup and preserves its result', async () => {
  const owned = await resources(), result = { fixture: true };
  try {
    expect(await withFixtureCleanup(async defer => { await owned.acquire(defer); return result; })).toBe(result);
    expect(owned.server.listening).toBe(false);
    expect(owned.child()!.exitCode !== null || owned.child()!.signalCode !== null).toBe(true);
  } finally { await owned.fallback(); }
});

test('a thrown undefined still runs cleanup and remains a rejection', async () => {
  let cleaned = false;
  const outcome = await withFixtureCleanup(async defer => { defer(() => { cleaned = true; }); throw undefined; })
    .then(() => ({ rejected: false }), error => ({ rejected: true, error }));
  expect(outcome).toEqual({ rejected: true, error: undefined }); expect(cleaned).toBe(true);
});
