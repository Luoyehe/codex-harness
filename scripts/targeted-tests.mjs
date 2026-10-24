// Ordinary edits run impacted checks. Full suites are an explicit audit-closeout
// operation, never a fallback for an unknown path or a failed selector.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const scriptName = fileURLToPath(import.meta.url);
const nodeTest = /^scripts\/[^/]+\.test\.mjs$/;
const appTest = /^apps\/(gateway|web)\/test\/.+\.test\.tsx?$/;
const docsOnly = /(?:^|\/)(?:[^/]+\.md|LICENSE)$/;
const nativeScripts = new Map([
  ["scripts/gateway-smoke.mjs", "cli-smoke"],
  ["scripts/defaults-integration.mjs", "cli-defaults"],
  ["scripts/defaults-idle-integration.mjs", "cli-defaults-idle"],
  ["scripts/mcp-config-integration.mjs", "cli-mcp"],
  ["scripts/systemd-candidate-isolation.test.sh", "systemd-candidate"],
]);

export function planTargetedTests(changes, inventory, reviewedTests = []) {
  const direct = { gateway: new Set(), web: new Set() };
  const related = { gateway: new Set(), web: new Set() };
  const scripts = new Set();
  const blocked = [];
  const unmapped = [];
  const notes = [];
  const requiredNativeChecks = new Set();
  const scriptSources = Object.keys(inventory).filter(name => /^(?:deploy|scripts)\/.+\.(?:mjs|py|sh|json|toml|example)$/.test(name));
  function selectScriptDependents(changed) {
    const visited = new Set([changed]);
    const queue = [changed];
    let found = false;
    while (queue.length) {
      const dependency = queue.shift();
      for (const consumer of scriptSources) {
        if (visited.has(consumer)) continue;
        // Test fixtures often read scripts rather than importing them. Match
        // the filename literally and walk their source consumers as well.
        if (!inventory[consumer].includes(path.posix.basename(dependency))) continue;
        visited.add(consumer);
        if (nativeScripts.has(consumer)) { requiredNativeChecks.add(nativeScripts.get(consumer)); found = true; }
        if (nodeTest.test(consumer)) { scripts.add(consumer); found = true; }
        else queue.push(consumer);
      }
    }
    return found;
  }
  for (const name of [...new Set(changes)]) {
    if (typeof name !== "string" || name.includes("\\") || name.startsWith("/") || name.split("/").includes("..") || /[\0\r\n]/.test(name)) {
      blocked.push(`Invalid changed path: ${JSON.stringify(name)}`);
      continue;
    }
    if (docsOnly.test(name)) { notes.push(`Documentation only: ${name}`); continue; }
    // Generated removals are part of a protocol upgrade too. The same adapter
    // contracts and real-CLI checks cover them after typecheck checks imports.
    if (/^protocol\/.+\.ts$/.test(name)) {
      for (const test of ["control-requests.test.ts", "control-unknown-start.test.ts", "rpc.test.ts", "turn-defaults.test.ts", "engine-mcp-routing.test.ts", "history-pagination.test.ts"]) direct.gateway.add(`test/${test}`);
      for (const test of ["store.test.ts", "validation.test.ts", "input-forms.test.tsx", "thread-history.test.ts", "cli-0164-items.test.tsx"]) direct.web.add(`test/${test}`);
      for (const check of ["cli-smoke", "cli-defaults", "cli-defaults-idle", "cli-mcp"]) requiredNativeChecks.add(check);
      notes.push("Protocol changes require typecheck and a build before the selected real-CLI checks.");
      continue;
    }
    if (!Object.hasOwn(inventory, name)) {
      unmapped.push(`Deleted or unavailable file needs an explicit test mapping: ${name}`);
      continue;
    }
    if (nativeScripts.has(name)) {
      requiredNativeChecks.add(nativeScripts.get(name));
      selectScriptDependents(name);
      continue;
    }
    if (nodeTest.test(name)) { scripts.add(name); continue; }
    const testMatch = name.match(appTest);
    if (testMatch) { direct[testMatch[1]].add(name.split("/").slice(2).join("/")); continue; }
    const appMatch = name.match(/^apps\/(gateway|web)\/(?:src|test)\/.+\.(?:ts|tsx|mts)$/);
    if (appMatch) {
      related[appMatch[1]].add(name.split("/").slice(2).join("/"));
      if (name === "apps/gateway/src/turn-defaults.ts") {
        requiredNativeChecks.add("cli-defaults");
        requiredNativeChecks.add("cli-defaults-idle");
      }
      continue;
    }
    if (/^apps\/web\/(?:src\/.+\.css|public\/.+\.(?:svg|png|jpg|jpeg|webp|ico)|index\.html)$/.test(name)) {
      for (const test of ["app-warnings.test.tsx", "components.test.tsx", "composer-send.test.tsx", "sidebar.test.tsx", "settings-management.test.tsx"]) {
        direct.web.add(`test/${test}`);
      }
      notes.push(`Visual asset/style change also requires browser layout and keyboard review: ${name}`);
      continue;
    }
    if (name === ".github/workflows/ci.yml" || name === ".github/workflows/codex-compat.yml") {
      scripts.add("scripts/workflow-contracts.test.mjs");
      scripts.add("scripts/targeted-tests.test.mjs");
      continue;
    }
    if (/^(?:deploy|scripts)\//.test(name) && selectScriptDependents(name)) continue;
    unmapped.push(`No conservative targeted mapping for ${name}. Supply reviewed test files or add a reviewed mapping.`);
  }
  for (const name of reviewedTests) {
    if (typeof name !== "string" || !Object.hasOwn(inventory, name) || name.split("/").includes("..")) {
      blocked.push(`Invalid reviewed test file: ${JSON.stringify(name)}`);
    } else if (nodeTest.test(name)) scripts.add(name);
    else {
      const match = name.match(appTest);
      if (match) direct[match[1]].add(name.split("/").slice(2).join("/"));
      else blocked.push(`Reviewed coverage must name an existing .test.mjs/.test.ts/.test.tsx file: ${name}`);
    }
  }
  if (unmapped.length && reviewedTests.length && blocked.length === 0) {
    notes.push(`Manual test coverage supplied for: ${unmapped.join("; ")}`);
    notes.push("The explicit test list is a reviewer assertion of affected coverage, not an automatically proven dependency map.");
  } else {
    blocked.push(...unmapped);
  }
  const commands = [];
  for (const app of ["gateway", "web"]) {
    if (direct[app].size) commands.push({ app, args: ["exec", "vitest", "run", ...[...direct[app]].sort()] });
    // Unlike `vitest run`, `related` defaults passWithNoTests to true. An
    // uncovered source must fail instead of silently returning a green check.
    if (related[app].size) commands.push({ app, args: ["exec", "vitest", "related", "--run", "--passWithNoTests=false", ...[...related[app]].sort()] });
  }
  if (scripts.size) commands.push({ app: null, args: ["--test", ...[...scripts].sort()] });
  return { commands, blocked, requiredNativeChecks: [...requiredNativeChecks].sort(), notes: [...new Set(notes)] };
}

function inventoryAt(directory, prefix = "", result = {}) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist", "coverage", ".vitest"].includes(item.name)) continue;
    const name = prefix + item.name;
    if (item.isDirectory()) inventoryAt(path.join(directory, item.name), name + "/", result);
    else if (item.isFile()) {
      result[name] = /\.(?:mjs|py|sh|json|toml|example)$/.test(name)
        ? readFileSync(path.join(directory, item.name), "utf8") : "";
    }
  }
  return result;
}

function main(args) {
  const dryRun = args[0] === "--plan";
  if (dryRun) args.shift();
  const reviewedIndex = args.indexOf("--reviewed-tests");
  let reviewedTests = [];
  if (reviewedIndex >= 0) {
    const value = args[reviewedIndex + 1];
    if (value === undefined) throw new Error("--reviewed-tests requires a comma-separated list of existing test paths.");
    reviewedTests = value === "" ? [] : value.split(",");
    args.splice(reviewedIndex, 2);
  }
  let changes;
  if (args[0] === "--base" && args.length === 2) {
    const base = args[1];
    if (!/^[a-f0-9]{40,64}$/.test(base) || /^0+$/.test(base)) throw new Error("A real base commit SHA is required; no implicit all-tests fallback.");
    const result = spawnSync("git", ["diff", "--name-only", "--no-renames", "-z", base, "HEAD", "--"], { cwd: root, encoding: "utf8", windowsHide: true });
    if (result.status !== 0 || result.error) throw new Error("Cannot read changed files from the requested base commit.");
    changes = result.stdout.split("\0").filter(Boolean);
  } else if (args[0] === "--files" && args.length > 1) changes = args.slice(1);
  else throw new Error("Usage: node scripts/targeted-tests.mjs [--plan] [--reviewed-tests TEST_PATH,...] --base COMMIT_SHA | --files PATH...");
  const plan = planTargetedTests(changes, inventoryAt(root), reviewedTests);
  console.log(JSON.stringify({ changes, ...plan }, null, 2));
  if (plan.blocked.length) throw new Error("Targeted test selection is incomplete; refusing a misleading green result.");
  if (dryRun) return;
  const linuxNative = process.platform === "linux" ? plan.requiredNativeChecks : [];
  if (linuxNative.some(check => check.startsWith("cli-")) && (!process.env.CODEX_BIN || !existsSync(process.env.CODEX_BIN))) {
    throw new Error("Selected native checks require CODEX_BIN pointing to an isolated pinned CLI runtime, and a fresh pnpm build.");
  }
  if (linuxNative.includes("systemd-candidate") && (process.env.HARNESS_ALLOW_SYSTEMD_FIXTURE !== "1" || !existsSync("/run/systemd/system"))) {
    throw new Error("Selected systemd fixture requires an isolated Linux/systemd host, root or passwordless sudo, and HARNESS_ALLOW_SYSTEMD_FIXTURE=1.");
  }
  if (plan.requiredNativeChecks.length && process.platform !== "linux") {
    console.log(`NOT RUN on ${process.platform}; required Linux checks: ${plan.requiredNativeChecks.join(", ")}. CI requires the Linux job separately.`);
  }
  for (const command of plan.commands) {
    const executable = command.app ? (process.platform === "win32" ? "pnpm.cmd" : "pnpm") : process.execPath;
    const childArgs = command.app ? ["--filter", `@codex-harness/${command.app}`, ...command.args] : command.args;
    const options = { cwd: root, stdio: "inherit", windowsHide: true };
    // cmd.exe is only used for the package-manager shim on Windows. Every
    // argument must be repository-owned, simple syntax before entering it.
    if (process.platform === "win32" && command.app) {
      if (childArgs.some(arg => !/^[A-Za-z0-9_@./:=\-]+$/.test(arg))) throw new Error("Unsafe Windows package-manager argument.");
      options.shell = true;
    }
    const result = spawnSync(executable, childArgs, options);
    if (result.error || result.status !== 0) throw new Error(`Targeted test command failed (${result.status ?? "spawn error"}).`);
  }
  for (const check of linuxNative) {
    const script = [...nativeScripts].find(([, value]) => value === check)[0];
    const isSystemd = check === "systemd-candidate";
    const sudo = isSystemd && process.getuid() !== 0;
    const executable = isSystemd ? sudo ? "sudo" : "bash" : process.execPath;
    const childArgs = isSystemd ? sudo ? ["-n", "bash", script] : [script] : [script];
    const result = spawnSync(executable, childArgs, { cwd: root, stdio: "inherit", windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(`Required native check ${check} failed (${result.status ?? "spawn error"}).`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptName) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
