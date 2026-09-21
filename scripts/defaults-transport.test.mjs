import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import test from "node:test";

const source = readFileSync(new URL("./defaults-integration.mjs", import.meta.url), "utf8");
const block = source.match(/const pending = ([\s\S]*?)\nresolver = new TurnDefaults/);
assert.ok(block, "real defaults RPC block missing");

for (const target of ["child", "stdin", "stdout", "stderr"]) {
  test(`defaults RPC rejects pending and future calls on ${target} failure without an uncaught error`, async t => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const { rpc, pending } = new Function("child", "createInterface", `const pending = ${block[1]}; return {rpc,pending};`)(child, createInterface);
    t.after(() => {
      for (const item of pending.values()) clearTimeout(item.timer);
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    });
    const result = rpc("initialize", {});
    const rejected = assert.rejects(result, /transport|closed/i);
    assert.doesNotThrow(() => (target === "child" ? child : child[target]).emit("error", new Error("synthetic transport failure")));
    await Promise.race([rejected, new Promise((_, reject) => setTimeout(() => reject(new Error("pending RPC did not reject promptly")), 100))]);
    assert.equal(pending.size, 0);
    await assert.rejects(rpc("must-not-send", {}), /transport|closed/i);
  });
}
