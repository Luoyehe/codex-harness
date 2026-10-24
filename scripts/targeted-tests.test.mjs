import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { planTargetedTests } from "./targeted-tests.mjs";

test("ordinary source edits select related tests without whole-suite fallback", () => {
  const changes = ["apps/web/src/components/Composer.tsx", "apps/gateway/src/control.ts"];
  const plan = planTargetedTests(changes, Object.fromEntries(changes.map(name => [name, ""])));
  assert.equal(plan.blocked.length, 0);
  assert.deepEqual(plan.commands, [
    { app: "gateway", args: ["exec", "vitest", "related", "--run", "--passWithNoTests=false", "src/control.ts"] },
    { app: "web", args: ["exec", "vitest", "related", "--run", "--passWithNoTests=false", "src/components/Composer.tsx"] },
  ]);
});

test("changed test files execute themselves and changed fixtures use related tests", () => {
  const changes = ["apps/web/test/sidebar.test.tsx", "apps/web/test/fixtures.ts", "scripts/workflow-contracts.test.mjs"];
  const plan = planTargetedTests(changes, Object.fromEntries(changes.map(name => [name, ""])));
  assert.equal(plan.blocked.length, 0);
  assert.deepEqual(plan.commands, [
    { app: "web", args: ["exec", "vitest", "run", "test/sidebar.test.tsx"] },
    { app: "web", args: ["exec", "vitest", "related", "--run", "--passWithNoTests=false", "test/fixtures.ts"] },
    { app: null, args: ["--test", "scripts/workflow-contracts.test.mjs"] },
  ]);
});

const vitest = fileURLToPath(new URL("../apps/gateway/node_modules/vitest/vitest.mjs", import.meta.url));
test("real Vitest related rejects an uncovered source without executing unrelated tests", { skip: !existsSync(vitest) }, () => {
  const directory = mkdtempSync(path.join(tmpdir(), "harness-targeted-empty-"));
  try {
    writeFileSync(path.join(directory, "uncovered.ts"), "export const untested = true;\n");
    writeFileSync(path.join(directory, "unrelated.test.ts"), 'throw new Error("UNRELATED_TEST_MUST_NOT_EXECUTE");\n');
    const plan = planTargetedTests(["apps/gateway/src/uncovered.ts"], { "apps/gateway/src/uncovered.ts": "" });
    const args = plan.commands[0].args.slice(2, -1);
    const result = spawnSync(process.execPath, [vitest, ...args, "uncovered.ts"], {
      cwd: directory, encoding: "utf8", timeout: 15000, windowsHide: true,
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /No test files found/);
    assert.doesNotMatch(result.stdout + result.stderr, /UNRELATED_TEST_MUST_NOT_EXECUTE/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("deployment fixture references select transitive Node wrappers without running paid verifiers", () => {
  const plan = planTargetedTests(["deploy/shared.py"], {
    "deploy/shared.py": "",
    "deploy/install.sh": "python shared.py",
    "scripts/install.test.py": "read install.sh",
    "scripts/install.test.mjs": "spawn install.test.py",
    "deploy/verify-provider.mjs": "shared.py",
    "scripts/unrelated.test.mjs": "",
  });
  assert.equal(plan.blocked.length, 0);
  assert.deepEqual(plan.commands, [{ app: null, args: ["--test", "scripts/install.test.mjs"] }]);
});

test("unknown, deleted, unsafe and dependency changes block rather than silently passing", () => {
  for (const name of ["unknown.file", "pnpm-lock.yaml", "../deploy/install.sh", "apps\\web\\src\\App.tsx", "deploy/uncovered.py"]) {
    const plan = planTargetedTests([name], { [name]: "" });
    assert.equal(plan.blocked.length, 1, name);
    assert.equal(plan.commands.length, 0, name);
  }
  assert.equal(planTargetedTests(["apps/gateway/src/control.ts"], {}).blocked.length, 1);
});

test("documentation-only changes are explicit and do not run tests", () => {
  const plan = planTargetedTests(["README.md", "deploy/README.md", "AGENTS.md", "LICENSE"], {});
  assert.equal(plan.blocked.length, 0);
  assert.equal(plan.commands.length, 0);
  assert.equal(plan.notes.length, 4);
});

test("style changes select interactive surface regressions and require visual review", () => {
  const plan = planTargetedTests(["apps/web/src/styles.css"], { "apps/web/src/styles.css": "" });
  assert.equal(plan.blocked.length, 0);
  assert.ok(plan.commands[0].args.includes("test/composer-send.test.tsx"));
  assert.match(plan.notes[0], /browser layout and keyboard/);
});

test("protocol changes select focused gateway and web contracts, not pnpm test", () => {
  const plan = planTargetedTests(["protocol/v2/TurnStartParams.ts"], { "protocol/v2/TurnStartParams.ts": "" });
  assert.equal(plan.blocked.length, 0);
  assert.equal(plan.commands.length, 2);
  assert.ok(plan.commands.every(command => command.args[0] === "exec" && command.args[1] === "vitest" && command.args[2] === "run" && command.args.length > 3));
  assert.match(plan.notes[0], /typecheck and a build/);
  assert.deepEqual(plan.requiredNativeChecks, ["cli-defaults", "cli-defaults-idle", "cli-mcp", "cli-smoke"]);
  assert.ok(plan.commands[0].args.includes("test/history-pagination.test.ts"));
  assert.ok(plan.commands[1].args.includes("test/cli-0164-items.test.tsx"));
});

test("generated protocol removals and new UI components retain their affected checks", () => {
  const component = "apps/web/src/components/Dialog.tsx";
  const plan = planTargetedTests(["protocol/v2/ThreadRollbackParams.ts", component], { [component]: "" });
  assert.equal(plan.blocked.length, 0);
  assert.ok(plan.commands.some(command => command.app === "web" && command.args.includes("src/components/Dialog.tsx")));
  assert.ok(plan.requiredNativeChecks.includes("cli-smoke"));
  assert.equal(planTargetedTests(["protocol/tsconfig.json"], { "protocol/tsconfig.json": "" }).blocked.length, 1);
});

test("default resolver and native idle regression changes require their real CLI checks", () => {
  const resolver = "apps/gateway/src/turn-defaults.ts";
  const idle = "scripts/defaults-idle-integration.mjs";
  const plan = planTargetedTests([resolver], { [resolver]: "" });
  assert.equal(plan.blocked.length, 0);
  assert.deepEqual(plan.requiredNativeChecks, ["cli-defaults", "cli-defaults-idle"]);
  assert.ok(plan.commands[0].args.includes("src/turn-defaults.ts"));
  assert.deepEqual(planTargetedTests([idle], { [idle]: "" }).requiredNativeChecks, ["cli-defaults-idle"]);
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(manifest.scripts["test:defaults"], /node scripts\/defaults-idle-integration\.mjs/);
});

test("native integration and privileged fixture changes select explicit required checks", () => {
  const names = ["scripts/mcp-config-integration.mjs", "scripts/systemd-candidate-isolation.test.sh"];
  const plan = planTargetedTests(names, Object.fromEntries(names.map(name => [name, ""])));
  assert.equal(plan.blocked.length, 0);
  assert.deepEqual(plan.requiredNativeChecks, ["cli-mcp", "systemd-candidate"]);
  const dependency = planTargetedTests(["deploy/test-candidate.sh"], {
    "deploy/test-candidate.sh": "", "scripts/systemd-candidate-isolation.test.sh": "test-candidate.sh",
  });
  assert.equal(dependency.blocked.length, 0);
  assert.deepEqual(dependency.requiredNativeChecks, ["systemd-candidate"]);
});

test("dependency changes accept explicit reviewed test files, never malformed coverage or an implicit full suite", () => {
  const inventory = { "pnpm-lock.yaml": "", "apps/web/test/components.test.tsx": "", "scripts/targeted-tests.test.mjs": "" };
  const reviewed = ["apps/web/test/components.test.tsx", "scripts/targeted-tests.test.mjs"];
  const plan = planTargetedTests(["pnpm-lock.yaml", "deleted-config.json"], inventory, reviewed);
  assert.equal(plan.blocked.length, 0);
  assert.equal(plan.commands.length, 2);
  assert.match(plan.notes.join("\n"), /Manual test coverage supplied for:.*pnpm-lock.yaml.*deleted-config.json/);
  for (const invalid of ["missing.test.mjs", "pnpm-lock.yaml", "../test.test.mjs", "--test"]) {
    assert.ok(planTargetedTests(["pnpm-lock.yaml"], inventory, [invalid]).blocked.length);
  }
  assert.ok(planTargetedTests(["../unsafe"], inventory, reviewed).blocked.length);
  assert.deepEqual(planTargetedTests(["protocol/v2/Turn.ts"], inventory, reviewed).requiredNativeChecks,
    ["cli-defaults", "cli-defaults-idle", "cli-mcp", "cli-smoke"]);
});

test("CLI review override prints its coverage while dry-run never runs native fixtures", () => {
  const script = fileURLToPath(new URL("./targeted-tests.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--plan", "--reviewed-tests", "scripts/targeted-tests.test.mjs",
    "--files", "pnpm-lock.yaml", "scripts/systemd-candidate-isolation.test.sh"], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.blocked.length, 0);
  assert.deepEqual(plan.requiredNativeChecks, ["systemd-candidate"]);
  assert.match(plan.notes.join("\n"), /reviewer assertion/);
  assert.doesNotMatch(result.stdout, /SYSTEMD-CANDIDATE-ISOLATION-PASS|TAP version/);
});

test("native checks fail before execution without explicit isolated prerequisites", { skip: process.platform !== "linux" }, () => {
  const script = fileURLToPath(new URL("./targeted-tests.mjs", import.meta.url));
  for (const [name, message] of [["scripts/mcp-config-integration.mjs", /require CODEX_BIN/],
    ["scripts/systemd-candidate-isolation.test.sh", /requires an isolated Linux\/systemd host/]]) {
    const result = spawnSync(process.execPath, [script, "--files", name], {
      encoding: "utf8", env: { ...process.env, CODEX_BIN: "", HARNESS_ALLOW_SYSTEMD_FIXTURE: "" }, windowsHide: true,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stdout, /SYSTEMD-CANDIDATE-ISOLATION-PASS|TAP version/);
  }
});

test("selector rejects missing or injected Git base without executing any tests", () => {
  const script = fileURLToPath(new URL("./targeted-tests.mjs", import.meta.url));
  for (const base of ["", "0".repeat(40), "HEAD;echo injected", "-h"]) {
    const result = spawnSync(process.execPath, [script, "--base", base], { encoding: "utf8", windowsHide: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /real base commit SHA/);
    assert.doesNotMatch(result.stdout, /TAP version|vitest|RUN /);
  }
});

test("deployment CLI documentation and service example agree with the current strict pin", () => {
  const install = readFileSync(new URL("../deploy/install.sh", import.meta.url), "utf8");
  const pin = install.match(/^CODEX_VERSION="([0-9]+\.[0-9]+\.[0-9]+)"/m)?.[1];
  assert.ok(pin);
  for (const name of ["README.md", "providers/openai/README.md", "codex-harness.service.example"]) {
    assert.ok(readFileSync(new URL(`../deploy/${name}`, import.meta.url), "utf8").includes(pin), name);
  }
});
