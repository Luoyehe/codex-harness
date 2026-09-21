import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function finalizer(name, parameters) {
  const source = readFileSync(new URL(name, import.meta.url), "utf8");
  const body = source.match(/\} finally \{\r?\n([\s\S]*)\}\s*$/)?.[1];
  assert.ok(body, `${name} cleanup missing`);
  return new AsyncFunction(...Object.keys(parameters), body)(...Object.values(parameters));
}

test("smoke cleanup cannot delete its fixture after an unconfirmed Windows tree stop", async () => {
  let removed = false;
  await assert.rejects(finalizer("./gateway-smoke.mjs", {
    gateway: { pid: 123, exitCode: null, signalCode: null },
    process: { platform: "win32" }, spawnSync: () => ({ status: 5 }),
    rmSync: () => { removed = true; }, scratch: "synthetic-fixture",
    stopOfflineChild: async () => { throw new Error("offline process cleanup unconfirmed"); },
  }), /cleanup|stop/i);
  assert.equal(removed, false);
});

test("defaults cleanup cannot delete its fixture before forced termination is confirmed", async () => {
  let removed = false;
  const scratch = path.join(tmpdir(), "harness-default-reset-synthetic");
  await assert.rejects(finalizer("./defaults-integration.mjs", {
    pending: new Map(), clearTimeout() {},
    child: { exitCode: null, signalCode: null, kill: () => false },
    once: async () => {}, setTimeout: callback => { callback(); },
    server: { closeAllConnections() {}, close() {} }, assert, path, tmpdir, scratch,
    rmSync: () => { removed = true; },
    stopOfflineChild: async () => { throw new Error("offline process cleanup unconfirmed"); },
  }), /cleanup|stop/i);
  assert.equal(removed, false);
});

for (const name of ["gateway-smoke.mjs", "defaults-integration.mjs"]) {
  test(`${name} emits its final success only after confirmed cleanup and fixture removal`, async () => {
    const calls = [];
    await finalizer(`./${name}`, {
      gateway: {}, child: {}, pending: new Map(), clearTimeout() {},
      server: { closeAllConnections() {}, close() {} }, assert, path, tmpdir,
      scratch: path.join(tmpdir(), "harness-default-reset-synthetic"),
      passed: true, report: { passed: true }, console: { log: () => calls.push("passed") },
      stopOfflineChild: async () => { calls.push("stopped"); },
      rmSync: () => calls.push("removed"),
    });
    assert.deepEqual(calls, ["stopped", "removed", "passed"]);
  });
}
