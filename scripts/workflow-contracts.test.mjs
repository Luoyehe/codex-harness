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
  .replaceAll("${{ steps.candidate.outcome }}", "CANDIDATE_OUTCOME")
  .replaceAll("${{ github.server_url }}", "https://github.com")
  .replaceAll("${{ github.repository }}", "fixture/fixture")
  .replaceAll("${{ github.run_id }}", "1234");
assert.ok(issueScript, "compatibility issue script missing");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const issue = (number, title) => ({
  number, title, html_url: `https://github.com/fixture/fixture/issues/${number}`,
  user: { login: "github-actions[bot]" },
});

async function runIssueScript(issues, candidate = "success") {
  const writes = [];
  const summary = [];
  const warnings = [];
  const listForRepo = async () => ({ data: issues });
  const github = { rest: { issues: {
    listForRepo,
    update: async value => {
      writes.push({ kind: "update", ...value });
      return { data: { ...issues.find(item => item.number === value.issue_number), ...value } };
    },
    create: async value => {
      writes.push({ kind: "create", ...value });
      return { data: issue(201, value.title) };
    },
  } }, paginate: async (endpoint, params) => {
    assert.equal(endpoint, listForRepo);
    assert.equal(params.state, "open");
    assert.equal(params.per_page, 100);
    return issues;
  } };
  const reporter = {
    addHeading(value) { summary.push(value); return this; },
    addRaw(value) { summary.push(value); return this; },
    addBreak() { return this; },
    addLink(label, url) { summary.push(`${label}: ${url}`); return this; },
    async write() {},
  };
  const core = { summary: reporter, warning: value => warnings.push(value) };
  const execute = new AsyncFunction("github", "context", "core", issueScript.replaceAll("CANDIDATE_OUTCOME", candidate));
  await execute(github, { repo: { owner: "fixture", repo: "fixture" } }, core);
  return { writes, summary: summary.join("\n"), warnings };
}

test("compatibility watch serializes issue reconciliation", () => {
  assert.match(workflow, /concurrency:\r?\n\s+group: codex-compat-\$\{\{ github\.repository \}\}\r?\n\s+cancel-in-progress: false/);
  assert.match(workflow, /id: candidate\r?\n\s+continue-on-error: true/);
});

for (const scenario of ["later-page", "same-title-pull-request"]) {
  test(`compatibility watch updates the existing issue (${scenario})`, async () => {
    const title = "Codex compatibility review";
    const first = scenario === "later-page"
      ? Array.from({ length: 100 }, (_, number) => ({ number, title: `unrelated ${number}` }))
      : [{ number: 1, title, pull_request: { url: "synthetic" } }];
    const { writes } = await runIssueScript([...first, issue(200, title)]);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].kind, "update");
    assert.equal(writes[0].issue_number, 200);
    assert.equal(writes[0].title, title);
  });
}

test("compatibility watch migrates the latest legacy issue and closes superseded reports", async () => {
  const { writes, summary, warnings } = await runIssueScript([
    issue(1, "Codex compatibility review: 1.0.0 → 1.0.1"),
    issue(2, "Codex compatibility review: 1.0.0 → 1.0.2"),
    issue(9, "unrelated"),
  ], "failure");
  assert.equal(writes.length, 2);
  assert.deepEqual(writes.map(({ kind, issue_number }) => [kind, issue_number]), [["update", 2], ["update", 1]]);
  assert.equal(writes[0].title, "Codex compatibility review");
  assert.match(writes[0].body, /Published version: `1\.1\.0`/);
  assert.match(writes[0].body, /Candidate protocol\/check step: `failure`/);
  assert.match(writes[0].body, /actions\/runs\/1234/);
  assert.equal(writes[1].state, "closed");
  assert.equal(writes[1].state_reason, "not_planned");
  assert.match(summary, /Candidate protocol\/check: \*\*failure\*\*/);
  assert.match(summary, /issues\/2/);
  assert.match(warnings[0], /failure.*issues\/2/);
});

test("compatibility watch reuses a stable issue and reports successful candidates", async () => {
  const { writes, summary, warnings } = await runIssueScript([
    issue(2, "Codex compatibility review: 1.0.0 → 1.0.2"),
    issue(3, "Codex compatibility review"),
  ]);
  assert.deepEqual(writes.map(({ issue_number }) => issue_number), [3, 2]);
  assert.equal(writes[1].state, "closed");
  assert.match(summary, /Candidate protocol\/check: \*\*success\*\*/);
  assert.deepEqual(warnings, []);
});

test("compatibility watch creates one rolling issue without touching human reports", async () => {
  const { writes, warnings } = await runIssueScript([
    issue(4, "Other compatibility discussion"),
    { ...issue(5, "Codex compatibility review"), user: { login: "maintainer" } },
    { ...issue(6, "Codex compatibility review: 1.0.0 → 1.0.2"), user: { login: "maintainer" } },
  ], "failure");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].kind, "create");
  assert.equal(writes[0].title, "Codex compatibility review");
  assert.equal(warnings.length, 1);
});

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
