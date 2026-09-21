import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const audit = fileURLToPath(new URL("./release-audit.mjs", import.meta.url));

for (const [label, content] of [
  ["later address after an allowed example", "demo@" + "example.com private@" + "fixture.invalid"],
  ["example domain as a prefix", "private@" + "example.com.fixture.invalid"],
  ["example text in the local part", "example.com@" + "fixture.invalid"],
  ["noreply substring in an unrelated domain", "private@" + "noreply.github.fixture.invalid"],
]) {
  test(`release audit detects ${label} without echoing it`, () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-harness-audit-"));
    try {
      writeFileSync(join(dir, "fixture.txt"), content);
      const run = spawnSync(process.execPath, [audit, dir], { encoding: "utf8" });
      assert.equal(run.status, 1);
      assert.match(run.stdout, /fixture\.txt:1 \[email\]/);
      assert.ok(!`${run.stdout}${run.stderr}`.includes(content));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("release audit permits exact documented example and GitHub noreply domains", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-harness-audit-"));
  try {
    writeFileSync(join(dir, "fixture.txt"), ["example.com", "example.org", "users.noreply.github.com"].map(domain => `fixture@${domain}`).join(" "));
    const run = spawnSync(process.execPath, [audit, dir], { encoding: "utf8" });
    assert.equal(run.status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

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

test("release audit fails closed when directory depth exceeds its traversal budget", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-harness-audit-"));
  try {
    let current = dir;
    for (let index = 0; index < 66; index++) {
      current = join(current, "d");
      mkdirSync(current);
    }
    const run = spawnSync(process.execPath, [audit, dir], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /TREE-BUDGET-EXCEEDED/);
    assert.match(run.stderr, /Audit incomplete/);
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

test("release audit scans built deployment output", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-harness-audit-"));
  try {
    const built = join(dir, "dist");
    mkdirSync(built);
    const fake = "sk-" + "b".repeat(24);
    writeFileSync(join(built, "bundle.js"), `const credential = "${fake}";\n`);
    const run = spawnSync(process.execPath, [audit, dir], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /dist\/bundle\.js:1 \[(?:sk-key|assign-secret)\]/);
    assert.doesNotMatch(run.stdout + run.stderr, new RegExp(fake));
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

test("release audit detects a fine-grained GitHub token without echoing it", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-harness-audit-"));
  try {
    const token = ["github", "pat", "11" + "a".repeat(40)].join("_");
    writeFileSync(join(dir, "fixture.txt"), token + "\n");
    const run = spawnSync(process.execPath, [audit, dir], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /\[github-token\]/);
    assert.doesNotMatch(run.stdout + run.stderr, new RegExp(token));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release audit fails closed without following a symbolic link", (context) => {
  const dir = mkdtempSync(join(tmpdir(), "codex-harness-audit-"));
  try {
    writeFileSync(join(dir, "target.txt"), "safe fixture\n");
    try {
      symlinkSync("target.txt", join(dir, "linked.txt"));
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        context.skip("file symbolic links are unavailable in this environment");
        return;
      }
      throw error;
    }
    const run = spawnSync(process.execPath, [audit, dir], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /UNREADABLE linked\.txt/);
    assert.match(run.stderr, /Audit incomplete/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release audit rejects a special file without trying to read it", (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX FIFO fixture required");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "codex-harness-audit-"));
  try {
    const fifo = join(dir, "fixture.fifo");
    const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    if (made.status !== 0) {
      context.skip("mkfifo is unavailable in this environment");
      return;
    }
    const run = spawnSync(process.execPath, [audit, dir], { encoding: "utf8", timeout: 2000 });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /UNREADABLE fixture\.fifo/);
    assert.match(run.stderr, /Audit incomplete/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release audit rejects environment variants but permits examples", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-harness-audit-"));
  try {
    writeFileSync(join(dir, ".env.production"), "PUBLIC_VALUE=fixture\n");
    writeFileSync(join(dir, ".env.production.example"), "PUBLIC_VALUE=fixture\n");
    const run = spawnSync(process.execPath, [audit, dir], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /JUNK \.env\.production(?:\r?\n|$)/);
    assert.doesNotMatch(run.stdout, /JUNK \.env\.production\.example/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release audit rejects private development-state directories without scanning their contents", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-harness-audit-"));
  try {
    for (const name of [".zcode", "dev-codex-home"]) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "opaque-state.json"), "private runtime state that must not be echoed\n");
    }
    const run = spawnSync(process.execPath, [audit, dir], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /JUNK \.zcode\//);
    assert.match(run.stdout, /JUNK dev-codex-home\//);
    assert.doesNotMatch(run.stdout + run.stderr, /private runtime state/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release audit rejects a credential-shaped filename without echoing it", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-harness-audit-"));
  try {
    const sensitiveName = `sk-${"p".repeat(24)}.txt`;
    writeFileSync(join(dir, sensitiveName), "safe fixture\n");
    const run = spawnSync(process.execPath, [audit, dir], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /HIT <redacted-path:[a-f0-9]{12}>:path \[sk-key\]/);
    assert.doesNotMatch(run.stdout + run.stderr, new RegExp(sensitiveName));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release audit does not reveal a sensitive directory name when traversal is denied", (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX directory permission fixture required");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "codex-harness-audit-"));
  const sensitiveName = `sk-${"d".repeat(24)}`;
  const denied = join(dir, sensitiveName);
  try {
    mkdirSync(denied, { mode: 0o700 });
    chmodSync(denied, 0o000);
    const run = spawnSync(process.execPath, [audit, dir], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /UNREADABLE <redacted-path:[a-f0-9]{12}>/);
    assert.doesNotMatch(run.stdout + run.stderr, new RegExp(sensitiveName));
  } finally {
    chmodSync(denied, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});
