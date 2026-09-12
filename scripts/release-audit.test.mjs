import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const audit = fileURLToPath(new URL("./release-audit.mjs", import.meta.url));

test("release audit fails closed when a large file cannot be scanned", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-harness-audit-"));
  try {
    const fake = "sk-" + "z".repeat(24);
    writeFileSync(join(dir, "large.txt"), "x".repeat(5 * 1024 * 1024) + fake);
    const run = spawnSync(process.execPath, [audit, dir], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /SKIP-LARGE large.txt/);
    assert.match(run.stderr, /Audit incomplete/);
    assert.doesNotMatch(run.stdout + run.stderr, new RegExp(fake));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("release audit detects but never echoes a credential", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-harness-audit-"));
  try {
    const fake = "sk-" + "a".repeat(24);
    writeFileSync(join(dir, "fixture.txt"), `token = "${fake}"\n`);
    const run = spawnSync(process.execPath, [audit, dir], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /fixture\.txt:1 \[(?:sk-key|assign-secret)\]/);
    assert.doesNotMatch(run.stdout + run.stderr, new RegExp(fake));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AUDIT_EXTRA is literal and invalid regex text cannot crash the audit", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-harness-audit-"));
  try {
    writeFileSync(join(dir, "fixture.txt"), "literal[value\n");
    const run = spawnSync(process.execPath, [audit, dir], {
      encoding: "utf8",
      env: { ...process.env, AUDIT_EXTRA: "literal[value" },
    });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /\[audit-extra\]/);
    assert.doesNotMatch(run.stdout + run.stderr, /literal\[value/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release audit permits dynamic secret loading but catches a literal assignment", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-harness-audit-"));
  try {
    writeFileSync(join(dir, "dynamic.sh"), 'API_KEY="$(read_secret)"\n');
    let run = spawnSync(process.execPath, [audit, dir], { encoding: "utf8" });
    assert.equal(run.status, 0);

    const fake = "this-is-" + "a-committed-credential";
    writeFileSync(join(dir, "literal.txt"), `api_key = "${fake}"\n`);
    run = spawnSync(process.execPath, [audit, dir], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /literal\.txt:1 \[assign-secret\]/);
    assert.doesNotMatch(run.stdout + run.stderr, new RegExp(fake));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
