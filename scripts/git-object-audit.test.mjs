import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const audit = fileURLToPath(new URL("./git-object-audit.sh", import.meta.url));
const hasBash = process.platform !== "win32"
  && spawnSync("bash", ["--version"], { windowsHide: true }).status === 0;
const options = { skip: !hasBash && "POSIX Bash required" };
const gitOptions = {
  skip: (!hasBash || spawnSync("git", ["--version"], { windowsHide: true }).status !== 0)
    && "POSIX Bash and Git required",
};

test("git object audit reads the original blob even when a replacement hides its contents", {
  skip: spawnSync("git", ["--version"], { windowsHide: true }).status !== 0 && "Git required",
}, () => {
  const root = mkdtempSync(join(tmpdir(), "codex-harness-replace-audit-"));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "absent-config") });
  const git = (args, input) => {
    const run = spawnSync("git", args, { cwd: root, env, input, encoding: "utf8", windowsHide: true, timeout: 5000 });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  try {
    git(["init", "--quiet", "--template="]);
    const secret = "sk-" + "r".repeat(24);
    const original = git(["hash-object", "-w", "--stdin"], secret);
    const replacement = git(["hash-object", "-w", "--stdin"], "safe replacement");
    git(["replace", original, replacement]);
    assert.equal(git(["cat-file", "blob", original]), "safe replacement", "fixture must actually mask the original blob");
    // Execute the exact blob-read invocation from the real shell audit, even
    // on Windows where Bash is unavailable. No existing repository is used.
    const source = readFileSync(audit, "utf8");
    const invocation = source.match(/if ! git ([^\n]+cat-file blob|cat-file blob) "\$blob"/);
    assert.ok(invocation, "audit blob read command missing");
    assert.equal(git([...invocation[1].trim().split(/\s+/), original]), secret);
    if (hasBash) {
      const run = spawnSync("bash", [audit, root], { env, encoding: "utf8", timeout: 5000 });
      assert.equal(run.status, 1);
      assert.match(run.stdout, /HIT blob/);
      assert.ok(!`${run.stdout}${run.stderr}`.includes(secret));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("git object audit reads original historical paths despite replacement refs", gitOptions, () => {
  const root = mkdtempSync(join(tmpdir(), "codex-harness-path-replace-audit-"));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "absent-config"),
    GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.com" };
  for (const key of Object.keys(env)) if (/^GIT_/.test(key) && !Object.hasOwn({
    GIT_CONFIG_NOSYSTEM: 1, GIT_CONFIG_GLOBAL: 1, GIT_AUTHOR_NAME: 1, GIT_AUTHOR_EMAIL: 1,
    GIT_COMMITTER_NAME: 1, GIT_COMMITTER_EMAIL: 1,
  }, key)) delete env[key];
  const git = (args, input) => {
    const run = spawnSync("git", args, { cwd: root, env, input, encoding: "utf8", windowsHide: true, timeout: 5000 });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  try {
    git(["init", "--quiet", "--template="]);
    const token = ["github", "pat", "11" + "a".repeat(40)].join("_");
    const hiddenPath = token + ".txt";
    writeFileSync(join(root, hiddenPath), "safe fixture\n");
    git(["add", "--", hiddenPath]);
    const original = git(["commit-tree", git(["write-tree"])], "original\n");
    git(["update-ref", "refs/heads/main", original]);
    rmSync(join(root, hiddenPath));
    writeFileSync(join(root, "safe.txt"), "safe fixture\n");
    git(["add", "-A"]);
    const replacement = git(["commit-tree", git(["write-tree"])], "replacement\n");
    git(["replace", original, replacement]);
    assert.ok(!git(["rev-list", "--objects", "--all"]).includes(hiddenPath), "fixture replacement did not hide the path");
    assert.ok(git(["--no-replace-objects", "rev-list", "--objects", "--all"]).includes(hiddenPath));
    const run = spawnSync("bash", [audit, root], { env, encoding: "utf8", timeout: 5000 });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /HIT reachable-path path=<redacted-path>/);
    assert.doesNotMatch(run.stdout + run.stderr, new RegExp(token));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codex-harness-object-audit-"));
  const bin = join(root, "bin");
  const repo = join(root, "repo");
  mkdirSync(bin);
  mkdirSync(repo);
  const git = join(bin, "git");
  writeFileSync(git, `#!/bin/sh
[ "$1" != --no-replace-objects ] || shift
case "$1:$2" in
  rev-parse:--git-dir) exit 0 ;;
  cat-file:--batch-all-objects)
    [ "\${FAIL_STAGE:-}" = enumerate ] && exit 7
    if [ "\${FAIL_STAGE:-}" = oversized ]; then printf 'blob abcdef 60000000\n'; else printf 'blob abcdef 128\n'; fi
    ;;
  cat-file:blob)
    [ "\${FAIL_STAGE:-}" = read ] && exit 8
    if [ "\${FAIL_STAGE:-}" = hit ]; then
      printf 'api_key = "sk-%s"\n' 'aaaaaaaaaaaaaaaaaaaaaaaa'
    elif [ "\${FAIL_STAGE:-}" = extra-hit ]; then
      printf 'safe synthetic private marker\n'
    elif [ "\${FAIL_STAGE:-}" = fine-grained-hit ]; then
      printf 'github_pat_%s\n' '11aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    else
      printf 'safe fixture\n'
    fi
    ;;
  rev-list:--objects)
    if [ "\${FAIL_STAGE:-}" = path-hit ]; then
      printf 'abcdef sk-%s.txt\n' 'aaaaaaaaaaaaaaaaaaaaaaaa'
    else
      printf 'abcdef fixture.txt\n'
    fi
    ;;
  *) exit 9 ;;
esac
`, "utf8");
  chmodSync(git, 0o700);
  return { root, repo, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` } };
}

test("git object audit fails when object enumeration, boundedness, or blob reads fail", options, () => {
  const value = fixture();
  try {
    for (const stage of ["enumerate", "oversized", "read"]) {
      const run = spawnSync("bash", [audit, value.repo], {
        encoding: "utf8", timeout: 5000, env: { ...value.env, FAIL_STAGE: stage },
      });
      assert.notEqual(run.status, 0, `${stage} unexpectedly succeeded`);
      assert.doesNotMatch(run.stdout, /OBJECT-AUDIT-OK/);
      assert.match(run.stderr, /OBJECT-AUDIT-FAILED|READ-FAILED|SKIP-LARGE/);
    }
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("git object audit reports only redacted hit metadata", options, () => {
  const value = fixture();
  try {
    const secret = "sk-" + "a".repeat(24);
    const run = spawnSync("bash", [audit, value.repo], {
      encoding: "utf8", timeout: 5000, env: { ...value.env, FAIL_STAGE: "hit" },
    });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /HIT blob abcdef path=<redacted-path> lines=1/);
    assert.doesNotMatch(run.stdout + run.stderr, new RegExp(secret));
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("git object audit detects a fine-grained GitHub token without echoing it", options, () => {
  const value = fixture();
  try {
    const token = ["github", "pat", "11" + "a".repeat(40)].join("_");
    const run = spawnSync("bash", [audit, value.repo], {
      encoding: "utf8", timeout: 5000, env: { ...value.env, FAIL_STAGE: "fine-grained-hit" },
    });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /HIT blob abcdef path=<redacted-path> lines=1/);
    assert.doesNotMatch(run.stdout + run.stderr, new RegExp(token));
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("git object audit redacts a credential-shaped reachable path", options, () => {
  const value = fixture();
  try {
    const secretPath = `sk-${"a".repeat(24)}.txt`;
    const run = spawnSync("bash", [audit, value.repo], {
      encoding: "utf8", timeout: 5000, env: { ...value.env, FAIL_STAGE: "path-hit" },
    });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /HIT reachable-path path=<redacted-path>/);
    assert.doesNotMatch(run.stdout, /HIT blob/);
    assert.doesNotMatch(run.stdout + run.stderr, new RegExp(secretPath));
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("git object audit trims pipe-delimited AUDIT_EXTRA literals like the tree audit", options, () => {
  const value = fixture();
  try {
    const run = spawnSync("bash", [audit, value.repo], {
      encoding: "utf8", timeout: 5000,
      env: { ...value.env, FAIL_STAGE: "extra-hit", AUDIT_EXTRA: "  private marker  " },
    });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /HIT blob abcdef path=<redacted-path> lines=1/);
    assert.doesNotMatch(run.stdout + run.stderr, /private marker/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});
