import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { spawnOfflineChild, stopOfflineChild } from "./offline-process.mjs";

async function fixture() {
  const child = spawnOfflineChild(process.execPath, ["-e", 'process.stdin.resume();process.on("SIGTERM",()=>{});console.log("ready");'], { stdio: ["pipe", "pipe", "pipe"] });
  await once(child.stdout, "data");
  return child;
}

test("offline cleanup confirms closure after stopping its real synthetic child and is idempotent", { timeout: 10000 }, async () => {
  const child = await fixture();
  let closed = false;
  child.once("close", () => { closed = true; });
  await stopOfflineChild(child, { graceMs: 20, forceMs: 3000 });
  assert.equal(closed, true);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  await stopOfflineChild(child);
});

test("offline cleanup rejects a failed tree stop and permits a confirmed cleanup retry", { timeout: 10000 }, async t => {
  const child = await fixture();
  try {
    if (process.platform === "win32") t.mock.method(childProcess, "spawnSync", () => ({ status: 5 }));
    else t.mock.method(process, "kill", () => { throw Object.assign(new Error("synthetic denied stop"), { code: "EPERM" }); });
    syncBuiltinESMExports();
    await assert.rejects(stopOfflineChild(child, { graceMs: 20, forceMs: 1000 }), /cleanup unconfirmed/);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    await stopOfflineChild(child, { graceMs: 20, forceMs: 3000 });
  }
});

test("offline cleanup refuses foreign PIDs and tolerates a failed spawn", { timeout: 5000 }, async () => {
  await assert.rejects(stopOfflineChild({ pid: 123 }), /not owned/);
  const child = spawnOfflineChild("codex-harness-intentionally-missing-fixture-command", [], { stdio: "ignore" });
  await new Promise(resolve => child.once("close", resolve));
  assert.equal(child.pid, undefined);
  await stopOfflineChild(child);
});

test("a forced POSIX owner exit cannot claim its independently grouped workers were cleaned", {
  skip: process.platform === "win32" && "POSIX grouped supervisor contract", timeout: 5000,
}, async () => {
  const child = await fixture();
  await assert.rejects(stopOfflineChild(child, { graceMs: 20, forceMs: 2000, requireCleanExit: true }), /cleanup unconfirmed/);
  assert.equal(child.signalCode, "SIGKILL");
});

test("a clean POSIX owner exit confirms the supervised cleanup contract", {
  skip: process.platform === "win32" && "POSIX grouped supervisor contract", timeout: 5000,
}, async () => {
  const child = spawnOfflineChild(process.execPath, ["-e", 'process.stdin.resume();process.on("SIGTERM",()=>process.exit(0));console.log("ready");'], { stdio: ["pipe", "pipe", "pipe"] });
  await once(child.stdout, "data");
  await stopOfflineChild(child, { graceMs: 1000, forceMs: 1000, requireCleanExit: true });
  assert.equal(child.exitCode, 0);
});
