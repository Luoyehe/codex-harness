import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/codex-compat.yml", import.meta.url), "utf8");
const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const protocolTsconfig = JSON.parse(readFileSync(new URL("../protocol/tsconfig.json", import.meta.url), "utf8"));
const issueScript = workflow.match(/          script: \|\r?\n([\s\S]+)$/)?.[1]
  .replace(/^            /gm, "")
  .replaceAll("${{ steps.versions.outputs.pinned }}", "1.0.0")
  .replaceAll("${{ steps.versions.outputs.latest }}", "1.1.0")
  .replaceAll("${{ steps.candidate.outcome }}", "success");
assert.ok(issueScript, "compatibility issue script missing");
const executeIssueScript = new (Object.getPrototypeOf(async function () {}).constructor)("github", "context", issueScript);

test("compatibility watch serializes issue reconciliation", () => {
  assert.match(workflow, /concurrency:\r?\n\s+group: codex-compat-\$\{\{ github\.repository \}\}\r?\n\s+cancel-in-progress: false/);
});

for (const scenario of ["later-page", "same-title-pull-request"]) {
  test(`compatibility watch updates the existing issue (${scenario})`, async () => {
    const title = "Codex compatibility review: 1.0.0 → 1.1.0";
    const first = scenario === "later-page"
      ? Array.from({ length: 100 }, (_, number) => ({ number, title: `unrelated ${number}` }))
      : [{ number: 1, title, pull_request: { url: "synthetic" } }];
    const issue = { number: 200, title };
    const writes = [];
    const listForRepo = async () => ({ data: first });
    const github = { rest: { issues: {
      listForRepo,
      update: async value => { writes.push({ kind: "update", ...value }); },
      create: async value => { writes.push({ kind: "create", ...value }); },
    } }, paginate: async (endpoint, params) => {
      assert.equal(endpoint, listForRepo);
      assert.equal(params.state, "open");
      return [...first, issue];
    } };
    await executeIssueScript(github, { repo: { owner: "fixture", repo: "fixture" } });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].kind, "update");
    assert.equal(writes[0].issue_number, issue.number);
  });
}

test("Windows CI executes the real repository unit and type checks with frozen dependencies", () => {
  const job = ci.match(/\n  windows:\r?\n([\s\S]*?)(?=\n  [a-z]+:|$)/)?.[1];
  assert.ok(job);
  assert.match(job, /runs-on: windows-latest/);
  for (const command of ["pnpm install --frozen-lockfile", "pnpm typecheck", "pnpm test"]) assert.ok(job.includes(`run: ${command}`));
  assert.match(job, /CODEX_TEST_PYTHON: python/);
  assert.match(job, /import sys,tomllib; assert sys\.version_info >= \(3, 11\)/);
  assert.doesNotMatch(job, /test:smoke|test:defaults|CODEX_BIN|continue-on-error/);
  const originalActions = ci.slice(0, ci.indexOf("\n  windows:")).match(/uses: (?:actions\/checkout|actions\/setup-node)@[a-f0-9]{40}/g);
  for (const action of originalActions) assert.ok(job.includes(action), "Windows must reuse reviewed action pins");
});

test("Linux release CI audits the complete Git history as well as the checked-out tree", () => {
  const job = ci.match(/\n  check:\r?\n([\s\S]*?)(?=\n  [a-z]+:|$)/)?.[1];
  assert.ok(job);
  const checkout = job.match(/- uses: actions\/checkout@[a-f0-9]{40}[^]*?\n\s+- uses:/)?.[0];
  assert.ok(checkout);
  assert.match(checkout, /fetch-depth: 0/);
  assert.match(job, /node scripts\/release-audit\.mjs \./);
  assert.match(job, /bash scripts\/git-object-audit\.sh \./);
  assert.match(job, /pnpm audit --audit-level moderate/);
});

test("protocol typecheck includes generated root envelopes as well as nested v2 types", () => {
  assert.ok(protocolTsconfig.include.includes("*.ts"));
  assert.ok(protocolTsconfig.include.includes("v2/**/*.ts"));
});

const hasBash = process.platform !== "win32" && spawnSync("bash", ["--version"]).status === 0;
for (const status of [0, 1, 2]) {
  test(`CI CRLF detection preserves git grep status ${status}`, { skip: !hasBash && "POSIX Bash required" }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "harness-ci-grep-"));
    try {
      const git = path.join(dir, "git");
      writeFileSync(git, `#!/bin/sh\nexit ${status}\n`);
      chmodSync(git, 0o700);
      const block = ci.match(/- name: Reject CRLF[^\n]*\r?\n\s+shell: bash\r?\n\s+run: \|\r?\n((?:          [^\n]*\r?\n)+)/)?.[1];
      assert.ok(block);
      const run = spawnSync("bash", ["-c", block.replace(/^          /gm, "")], {
        cwd: dir, encoding: "utf8", timeout: 3000,
        env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` },
      });
      assert.equal(run.status, status === 1 ? 0 : status === 0 ? 1 : status);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
