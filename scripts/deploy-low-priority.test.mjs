import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const deploy = fileURLToPath(new URL("../deploy/", import.meta.url));
const sh = { skip: process.platform === "win32" ? "POSIX Bash fixtures required" : false };
function extract(file, name) {
  const text = readFileSync(path.join(deploy, file), "utf8");
  const start = new RegExp(`^([ \\t]*)${name}\\(\\) \\{`, "m").exec(text);
  assert.ok(start, name); return text.slice(start.index, text.indexOf("\n" + start[1] + "}", start.index) + start[1].length + 2);
}
function scratch(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return { dir, clean: () => rmSync(dir, { recursive: true, force: true }) };
}
function edgeEnvInspector() {
  const source = readFileSync(path.join(deploy, "setup-edge.sh"), "utf8");
  const marker = `EDGE_ENV_STATE="$(python3 -I - "$ENV_FILE" <<'PY'\n`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, "edge environment inspector start");
  const body = start + marker.length;
  const end = source.indexOf("\nPY\n", body);
  assert.ok(end > body, "edge environment inspector end");
  return source.slice(body, end) + "\n";
}
function inspectEdgeEnv(file, prefix = "") {
  return spawnSync("python3", ["-I", "-", file], { input: prefix + edgeEnvInspector(), encoding: "utf8", timeout: 5000,
    env: { ...process.env, RUN_USER: "" } });
}

for (const state of ["ready", "starting", "blocked", "invalid", "transport-failed"]) test(`installer requires actual backend readiness (${state})`, sh, () => {
  const source = readFileSync(path.join(deploy, "install.sh"), "utf8");
  const block = source.slice(source.indexOf("# --- 7. restart + health check"), source.indexOf("# --- 8. remote access wizard"));
  const payload = state === "invalid" ? "not-json" : JSON.stringify({ ok: true, codexState: state });
  const script = `set -euo pipefail\nsystemctl() { :; }\nsleep() { :; }\nlog() { :; }\nrun_as_service() { echo SMOKE_REACHED; }\ncurl() { printf '%s' '${payload}'; return ${state === "transport-failed" ? 22 : 0}; }\n${block}\n`;
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 10000,
    env: { ...process.env, SUDO: "", SERVICE_NAME: "fixture", PORT: "1", CODEX_BIN: "unused-fixture", INSTALL_DIR: "/unused-fixture" } });
  assert.equal(result.status === 0, state === "ready", result.stdout + result.stderr);
  assert.equal(result.stdout.includes("SMOKE_REACHED"), state === "ready", result.stdout + result.stderr);
});

test("custom reasoning prompt applies its displayed fallback when Enter is pressed", sh, () => {
  const source = readFileSync(path.join(deploy, "providers/custom-openai/setup.sh"), "utf8");
  const block = source.slice(source.indexOf('if [ -n "$EFFORTS_DETECTED" ]; then'), source.indexOf("# Persist the selected authentication state"))
    .replaceAll('[ -t 0 ]', 'true');
  assert.ok(block.includes("DEFAULT_SUGGEST"));
  const result = spawnSync("bash", ["-c", `set -eu\nlog() { :; }\ndie() { echo "$*" >&2; exit 19; }\n${block}\nprintf '%s' "$EFFORT"\n`], {
    encoding: "utf8", input: "\n", timeout: 5000,
    env: { ...process.env, EFFORTS_DETECTED: "low high", EFFORT: "medium", CUSTOM_EFFORT: "", MODEL: "fixture" },
  });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, "low");
});

test("runtime publication uses one global lock and no-replace descriptor commit", () => {
  const installer = readFileSync(path.join(deploy, "install-runtime.sh"), "utf8");
  const bridge = readFileSync(path.join(deploy, "update_candidate.py"), "utf8");
  assert.match(installer, /runtime-lock/);
  assert.match(installer, /flock 9/);
  assert.match(installer, /publish-runtime/);
  assert.doesNotMatch(installer, /mv -T|mv .*\$target/);
  assert.match(bridge, /renameat2/);
  assert.match(bridge, /RENAME_NOREPLACE|os\.fsencode\(destination\), 1/);
  assert.match(bridge, /concurrent runtime publication has different content/);
});

test("update executes candidate work only in the isolated runner and publishes one validated payload", () => {
  const source = readFileSync(path.join(deploy, "manage.sh"), "utf8");
  const update = source.slice(source.indexOf("do_update() {"), source.indexOf("\nmenu() {"));
  assert.doesNotMatch(update, /bash "\$stage\//);
  assert.doesNotMatch(update, /source "\$stage|\. "\$stage/);
  assert.doesNotMatch(update, /\(\s*cd "\$stage"[\s\S]*pnpm/);
  assert.doesNotMatch(update, /node "?\$stage|node scripts\/release-audit/);
  assert.match(update, /update_candidate\.py" version "\$stage"/);
  assert.match(update, /test-candidate\.sh" \\\n\s*"\$stage" "\$candidate_version" "\$validated" "\$REPO_ROOT" "\$runtime_seed"/);
  assert.doesNotMatch(update, /install -d[^\n]*\$exchange|update_candidate\.py" materialize\s/);
  assert.match(update, /cp -a "\$validated\/artifacts\/\$item"/);
  assert.match(update, /publish-runtime \\\n\s*"\$validated\/runtime"/);
  assert.match(update, /bash "\$trusted_apply\/register-service\.sh"/);
  assert.match(update, /REGISTER_ASSET_DIR="\$validated\/service"/);
  assert.match(update, /remove-runtime/);
  assert.ok(update.indexOf("test-candidate.sh") < update.indexOf('applying=1'));
  assert.ok(update.indexOf("publish-runtime") > update.indexOf('applying=1'));
});

test("root management isolates every trusted Python helper invocation", () => {
  const source = readFileSync(path.join(deploy, "manage.sh"), "utf8");
  assert.doesNotMatch(source, /python3 "\$SCRIPT_DIR\/(?:runtime_paths|lifecycle|safe_delete)\.py"/);
  assert.doesNotMatch(source, /run_as_service python3 "\$SCRIPT_DIR\/safe_delete\.py"/);
  for (const helper of ["runtime_paths.py", "lifecycle.py", "safe_delete.py", "trusted_paths.py", "update_candidate.py"])
    assert.ok(source.includes(`python3 -I "$SCRIPT_DIR/${helper}`) || source.includes(`python3 -I "$trusted_apply/${helper}`), helper);
});

test("NodeSource installation selects the newly installed node instead of an older PATH entry", sh, () => {
  const f = scratch("harness-node-selection-");
  try {
    const oldBin = path.join(f.dir, "old"), aptBin = path.join(f.dir, "apt");
    for (const [directory, version] of [[oldBin, 20], [aptBin, 22]]) {
      mkdirSync(directory);
      writeFileSync(path.join(directory, "node"), `#!/bin/sh\nif [ "$1" = -p ]; then echo ${version}; else echo v${version}.0.0; fi\n`, { mode: 0o755 });
    }
    const source = readFileSync(path.join(deploy, "install.sh"), "utf8");
    const start = source.indexOf("if command -v node >/dev/null 2>&1; then");
    const block = source.slice(start, source.indexOf('if [ -z "${TOOLS_BIN_DIR:-}" ]', start)).replaceAll('"/usr/bin"', JSON.stringify(aptBin));
    const script = `set -eu\nlog() { :; }\ninstall_node() { :; }\npython3() { printf '%s\\n' "$4"; }\n${block}\nprintf '%s' "$NODE_BIN"\n`;
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5000,
      env: { ...process.env, PATH: `${oldBin}:/usr/bin:/bin`, SCRIPT_DIR: "/unused-fixture", NODE_BIN: "", NODE_BIN_DIR: "" } });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, path.join(aptBin, "node"));
  } finally { f.clean(); }
});

test("installer refuses device login when the service cannot be stopped", sh, () => {
  const definition = extract("install.sh", "configure_provider").replaceAll("if [ -t 0 ]; then", "if true; then");
  const script = `set -eu\nlog() { :; }\nsystemctl() { return 17; }\nrun_as_service() { case "$*" in *login*) echo UNEXPECTED_LOGIN ;; esac; }\n${definition}\nconfigure_provider\n`;
  const result = spawnSync("bash", ["-c", script], { input: "y\n", encoding: "utf8", timeout: 5000,
    env: { ...process.env, PROVIDER: "openai", SUDO: "", SERVICE_NAME: "fixture", ENV_FILE: "/unused-fixture.env", INSTALL_DIR: "/unused-fixture", CODEX_BIN: "fixture-cli" } });
  assert.notEqual(result.status, 0); assert.ok(!result.stdout.includes("UNEXPECTED_LOGIN"), result.stdout);
});

for (const fixture of [
  { name: "an unknown explicit provider", provider: "unknown", setupStatus: 0 },
  { name: "a selected Zhipu provider without a key", provider: "zhipu", setupStatus: 0 },
  { name: "a failed Zhipu setup", provider: "zhipu", key: "fixture-key", setupStatus: 17 },
  { name: "a failed OpenAI setup", provider: "openai", setupStatus: 17 },
  { name: "a failed custom setup", provider: "custom", setupStatus: 17 },
]) test(`installer fails for ${fixture.name}`, sh, () => {
  const definition = extract("install.sh", "configure_provider");
  const script = `set -eu\nlog() { :; }\ngrep() { return 1; }\nrun_as_service() { return "$FIXTURE_SETUP_STATUS"; }\nsystemctl() { :; }\n${definition}\nconfigure_provider\nprintf 'UNEXPECTED_SUCCESS\\n'\n`;
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5000, env: { ...process.env,
    PROVIDER: fixture.provider, ZHIPU_KEY: fixture.key ?? "", FIXTURE_SETUP_STATUS: String(fixture.setupStatus),
    ENV_FILE: "/unused-fixture.env", INSTALL_DIR: "/unused-fixture", SERVICE_NAME: "fixture", CODEX_BIN: "fixture-cli", SUDO: "" } });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.ok(!result.stdout.includes("UNEXPECTED_SUCCESS"), result.stdout);
});

test("installer still permits an explicit provider skip", sh, () => {
  const definition = extract("install.sh", "configure_provider");
  const result = spawnSync("bash", ["-c", `set -eu\nlog() { :; }\n${definition}\nconfigure_provider\n`], {
    encoding: "utf8", timeout: 5000, env: { ...process.env, PROVIDER: "skip" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("installer cannot report completion after edge setup fails", sh, () => {
  const source = readFileSync(path.join(deploy, "install.sh"), "utf8");
  const block = source.slice(source.indexOf("# --- 8. remote access wizard"));
  const script = `set -eu\nlog() { :; }\nbash() { return 17; }\n${block}\n`;
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5000, env: { ...process.env,
    SKIP_EDGE_SETUP: "0", EDGE: "invalid", PORT: "8080", SERVICE_NAME: "fixture", GATEWAY_ENV_FILE: "/unused-gateway.env",
    GATEWAY_CONTROL_HOME: "/unused-control", INSTALL_DIR: "/unused-install", COMMAND_PATH: "/unused-command" } });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.ok(!result.stdout.includes("安装完成"), result.stdout);
});

for (const [name, env] of [
  ["PROVIDER", { PROVIDER: "none", EDGE: "none" }],
  ["EDGE even when edge setup is skipped", { PROVIDER: "skip", EDGE: "invalid", SKIP_EDGE_SETUP: "1" }],
]) test(`installer rejects invalid explicit ${name} before mutation`, sh, () => {
  const source = readFileSync(path.join(deploy, "install.sh"), "utf8");
  const start = source.indexOf("# --- input contract");
  const block = source.slice(start, source.indexOf('INSTALL_DIR="${INSTALL_DIR:-$REPO_ROOT}"', start));
  const result = spawnSync("bash", ["-c", `set -eu\n${block}\nprintf 'UNEXPECTED_SUCCESS\\n'\n`], {
    encoding: "utf8", timeout: 5000, env: { ...process.env, ...env },
  });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.ok(!result.stdout.includes("UNEXPECTED_SUCCESS"), result.stdout);
});

for (const operation of ["reset", "uninstall"]) test(`${operation} stops before any deletion when service shutdown fails`, sh, () => {
  const f = scratch("harness-stop-refusal-");
  try {
    const unit = path.join(f.dir, "fixture.service"); writeFileSync(unit, "fixture\n");
    const definition = extract("manage.sh", operation === "reset" ? "do_reinstall" : "do_uninstall");
    const command = operation === "reset" ? "do_reinstall full" : "do_uninstall";
    // No system command or privilege change runs. Any old unsafe continuation
    // is recorded by harmless shell functions, never a filesystem deletion.
    const script = `set -eu\nneed_root() { :; }\nassert_instance_checkout() { :; }\nlog() { :; }\ndie() { echo "$*" >&2; exit 19; }\nrun_as_service() { if [ "$3" = prepare ]; then echo fixture-identity; else echo UNEXPECTED_DELETE; fi; }\npython3() { if [ "$2" = prepare ]; then echo fixture-identity; elif [ "$2" = delete ]; then echo UNEXPECTED_DELETE; fi; }\nbash() { echo UNEXPECTED_EDGE; }\nsystemctl() { return 17; }\nrm() { echo UNEXPECTED_DELETE; }\nrmdir() { :; }\ndo_install() { echo UNEXPECTED_INSTALL; }\n${definition}\n${command}\n`;
    const result = spawnSync("bash", ["-c", script], { input: "yes\nyes\n", encoding: "utf8", timeout: 5000,
      env: { ...process.env, UNIT_FILE: unit, REPO_ROOT: f.dir, SCRIPT_DIR: deploy, SERVICE_NAME: "fixture", SERVICE_HOME: f.dir,
        CODEX_HOME: path.join(f.dir, "home"), ENV_FILE: path.join(f.dir, "secrets.env"), GATEWAY_ENV_FILE: path.join(f.dir, "gateway.env"), PORT: "8080" } });
    assert.notEqual(result.status, 0); assert.ok(!/UNEXPECTED_(DELETE|INSTALL|EDGE)/.test(result.stdout), result.stdout);
    assert.equal(readFileSync(unit, "utf8"), "fixture\n");
  } finally { f.clean(); }
});

test("failed edge rollback retains its private recovery copies and reports incomplete recovery", sh, () => {
  const f = scratch("harness-edge-rollback-");
  try {
    const backup = path.join(f.dir, "backup"); mkdirSync(backup); writeFileSync(path.join(backup, "Caddyfile"), "original\n");
    const definition = extract("setup-edge.sh", "rollback").replaceAll("/etc/systemd/system/", f.dir + "/units/");
    const script = `set -eu\nlog() { echo "$*"; }\ncp() { return 17; }\npython3() { return 17; }\nsystemctl_do() { return 17; }\nwait_authelia() { return 17; }\n${definition}\nrollback 23\n`;
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5000, env: { ...process.env,
      RB_DIR: backup, TMPD: "", CADDY_FILE: path.join(f.dir, "Caddyfile"), AUTHELIA_DIR: path.join(f.dir, "auth"),
      AUTH_DROPIN: path.join(f.dir, "dropin/config"), AUTH_INITIAL: path.join(f.dir, "initial"), EDGE_STATE: path.join(f.dir, "edge.json"),
      SCRIPT_DIR: deploy, CODEX_HOME: f.dir, ENV_FILE: path.join(f.dir, "gateway.env"), AUTHELIA_UNIT: "fixture-auth", GATEWAY_UNIT: "fixture",
      RB_NEW_CADDY: "0", RB_NEW_AUTH_CONF: "1", RB_NEW_AUTH_USERS: "1", RB_NEW_AUTH_UNIT: "1", RB_NEW_AUTH_DROPIN: "1",
      RB_NEW_AUTH_INITIAL: "1", RB_NEW_EDGE_STATE: "1", AUTH_UNIT_CREATED: "0", AUTH_RUNTIME_TOUCHED: "1", GATEWAY_RUNTIME_TOUCHED: "1", RB_AUTH_WAS_ENABLED: "1", RB_AUTH_WAS_ACTIVE: "1" } });
    assert.equal(result.status, 23); assert.ok(existsSync(path.join(backup, "Caddyfile")), result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /恢复未完成|回滚未完成/);
  } finally { f.clean(); }
});

test("failed edge disable rollback retains its private recovery copies", sh, () => {
  const f = scratch("harness-edge-disable-");
  try {
    const backup = path.join(f.dir, "backup"); mkdirSync(backup); writeFileSync(path.join(backup, "Caddyfile"), "original\n");
    const definition = extract("setup-edge.sh", "cleanup_disable").replaceAll("/etc/systemd/system/", f.dir + "/units/");
    const script = `set -eu\nlog() { echo "$*"; }\ncp() { return 17; }\npython3() { return 17; }\nsystemctl_do() { return 17; }\n${definition}\ntrap cleanup_disable EXIT\nexit 23\n`;
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5000, env: { ...process.env,
      DISABLE_BACKUP: backup, CADDY_FILE: path.join(f.dir, "Caddyfile"), SCRIPT_DIR: deploy, CODEX_HOME: f.dir, ENV_FILE: path.join(f.dir, "gateway.env"),
      EDGE_STATE: path.join(f.dir, "edge.json"), DISABLE_EDGE_STATE_CHANGED: "0", DISABLE_EDGE_STATE_EXISTED: "0",
      DISABLE_CADDY_CHANGED: "1", DISABLE_ENV_CHANGED: "1", DISABLE_AUTH_CHANGED: "1", DISABLE_AUTH_ENABLED: "1", DISABLE_AUTH_ACTIVE: "1", AUTHELIA_UNIT: "fixture-auth", GATEWAY_UNIT: "fixture" } });
    assert.equal(result.status, 23); assert.ok(existsSync(path.join(backup, "Caddyfile")), result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /恢复未完成|回滚未完成/);
  } finally { f.clean(); }
});

test("legacy SPA shell entry cannot report success for an unauthenticated gateway", sh, () => {
  const f = scratch("harness-spa-entry-");
  try {
    const bin = path.join(f.dir, "bin"); mkdirSync(bin);
    writeFileSync(path.join(bin, "curl"), '#!/bin/sh\nprintf "Unauthorized\\n"\nexit 22\n', { mode: 0o755 });
    writeFileSync(path.join(bin, "journalctl"), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(path.join(bin, "node"), '#!/bin/sh\nexit 23\n', { mode: 0o755 });
    const result = spawnSync("bash", [path.join(deploy, "verify-spa.sh")], { encoding: "utf8", timeout: 5000,
      env: { ...process.env, PATH: bin + ":/usr/bin:/bin", PORT: "1", SERVICE_NAME: "fixture", GATEWAY_TOKEN: "synthetic-only", GATEWAY_CONTROL_HOME: f.dir } });
    assert.notEqual(result.status, 0);
  } finally { f.clean(); }
});

test("an external Authelia must pass live health before the edge is reloaded", sh, () => {
  const f = scratch("harness-external-health-");
  try {
    const source = readFileSync(path.join(deploy, "setup-edge.sh"), "utf8");
    const block = source.slice(source.indexOf("COOKIE_OWNER=external"), source.indexOf("# --- 6.5 register"))
      .replaceAll("/etc/systemd/system/", f.dir + "/units/");
    const script = `set -eu\nlog() { :; }\ndie() { echo "$*" >&2; exit 19; }\npython3() { case "$2" in auth-hosts) echo app.example.com:443 ;; esac; }\nauth_cli() { :; }\ncaddy() { :; }\nwait_authelia() { echo HEALTH_FAILED; return 17; }\nrollback() { exit 23; }\nsystemctl_do() { echo UNEXPECTED_RELOAD; }\n${block}\n`;
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5000,
      env: { ...process.env, SCRIPT_DIR: deploy, CADDY_FILE: path.join(f.dir, "Caddyfile"), AUTHELIA_DIR: f.dir, AUTHELIA_BIN: "/bin/true", AUTHELIA_UNIT: "fixture", AUTHELIA_ADDR: "127.0.0.1:1", AUTHELIA_CANONICAL_URL: "", AUTHELIA_POLICY_REVIEWED: "1", FRESH_AUTHELIA: "0", SERVICE_MGR: "systemd" } });
    assert.notEqual(result.status, 0); assert.match(result.stdout, /HEALTH_FAILED/); assert.ok(!result.stdout.includes("UNEXPECTED_RELOAD"));
  } finally { f.clean(); }
});

test("Authelia health requires its UP payload, not just an HTTP 200", sh, () => {
  const definition = extract("setup-edge.sh", "wait_authelia");
  for (const healthy of [true, false]) {
    const script = `set -eu\nsystemctl() { return 0; }\ncurl() { printf '%s' '${healthy ? '{"status":"UP"}' : '{}'}'; }\nsleep() { :; }\n${definition}\nwait_authelia\n`;
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5000,
      env: { ...process.env, SERVICE_MGR: "systemd", AUTHELIA_UNIT: "fixture", AUTHELIA_ADDR: "127.0.0.1:1" } });
    assert.equal(result.status === 0, healthy);
  }
});

test("systemd mode cannot silently succeed when systemctl is unavailable", sh, () => {
  const script = `set -eu\nlog() { :; }\ncommand() { return 1; }\n${extract("setup-edge.sh", "systemctl_do")}\nsystemctl_do restart fixture\n`;
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5000, env: { ...process.env, SERVICE_MGR: "systemd" } });
  assert.notEqual(result.status, 0);
});

test("server verification rejects an invalid port before any authenticated request", sh, () => {
  const f = scratch("harness-verify-port-");
  try {
    const bin = path.join(f.dir, "bin");
    const marker = path.join(f.dir, "curl-called");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "curl"), '#!/bin/sh\nprintf called > "$FIXTURE_CURL_MARKER"\nexit 22\n', { mode: 0o755 });
    writeFileSync(path.join(bin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(path.join(bin, "journalctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const result = spawnSync("bash", [path.join(deploy, "verify-server.sh")], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        PATH: bin + ":/usr/bin:/bin",
        PORT: "8080" + "@" + "attacker.invalid",
        SERVICE_NAME: "fixture",
        GATEWAY_TOKEN: "synthetic-only",
        GATEWAY_CONTROL_HOME: f.dir,
        FIXTURE_CURL_MARKER: marker,
      },
    });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(marker), false, result.stdout + result.stderr);
  } finally { f.clean(); }
});

for (const failing of [false, true]) test(`maintenance edge disable never restarts an already stopped gateway (${failing ? "rollback" : "success"})`, sh, () => {
  const f = scratch("harness-stopped-edge-");
  try {
    const units = path.join(f.dir, "units"); mkdirSync(units); writeFileSync(path.join(units, "fixture.service"), "fixture\n");
    const auth = path.join(f.dir, "authelia"); mkdirSync(auth);
    writeFileSync(path.join(auth, "configuration.yml"), "session:\n  cookies:\n    - domain: fixture.invalid\n      authelia_url: https://fixture.invalid/authelia/\n");
    const calls = path.join(f.dir, "calls");
    let block;
    if (failing) {
      block = extract("setup-edge.sh", "cleanup_disable") + "\ntrap cleanup_disable EXIT\nexit 23\n";
    } else {
      const source = readFileSync(path.join(deploy, "setup-edge.sh"), "utf8");
      block = source.slice(source.indexOf('if [ "${EDGE_ACTION:-}" = "disable" ]; then'), source.indexOf("random_hex()"));
    }
    block = block.replaceAll("/etc/systemd/system/", units + "/");
    const backup = path.join(f.dir, "backup"); mkdirSync(backup);
    const script = `set -eu\nneed_root() { :; }\nlock_edge() { :; }\nload_saved_edge_state() { :; }\nvalidate_edge_values() { :; }\ncheck_edge_paths() { :; }\ndie() { echo "$*" >&2; exit 19; }\nlog() { printf 'LOG %s\\n' "$*" >> "$FIXTURE_CALLS"; }\npython3() {\n  printf 'PYTHON %s\\n' "$*" >> "$FIXTURE_CALLS"\n  if [ "$2" = "$SCRIPT_DIR/lifecycle.py" ] && [ "$3" = guard-edge-removal ]; then command python3 "$@"; fi\n}\nsystemctl() { return 1; }\nsystemctl_do() { echo "$*"; }\n${block}\n`;
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5000, env: { ...process.env,
      TMPDIR: f.dir, EDGE_ACTION: "disable", EDGE_GATEWAY_STOPPED: "1", DISABLE_BACKUP: backup,
      CADDY_FILE: path.join(f.dir, "no-Caddyfile"), SCRIPT_DIR: deploy, CODEX_HOME: f.dir, ENV_FILE: path.join(f.dir, "gateway.env"),
      EDGE_STATE: path.join(f.dir, "edge.json"), DISABLE_EDGE_STATE_CHANGED: "0", DISABLE_EDGE_STATE_EXISTED: "0",
      DISABLE_CADDY_CHANGED: "0", DISABLE_ENV_CHANGED: "1", DISABLE_AUTH_CHANGED: "0", SERVICE_MGR: "systemd", GATEWAY_PORT: "8080",
      AUTHELIA_DIR: auth, AUTHELIA_UNIT: "fixture-auth", AUTHELIA_ADDR: "127.0.0.1:1", GATEWAY_UNIT: "fixture", FIXTURE_CALLS: calls,
      MANAGED_TLS_DIR: path.join(f.dir, "managed-tls"), CADDY_USER: "caddy" } });
    assert.equal(result.status, failing ? 23 : 0, result.stderr);
    assert.ok(!result.stdout.includes("restart fixture"), result.stdout);
    const events = readFileSync(calls, "utf8");
    if (failing) {
      assert.match(events, /edge_env\.py .* restore /, "the EXIT trap must really restore the edge environment");
      assert.equal(existsSync(backup), false, "successful rollback must finish its private snapshot cleanup");
    } else {
      assert.match(events, /lifecycle\.py guard-edge-removal /, "run the real read-only shared-portal guard");
      assert.match(events, /edge_env\.py .* snapshot /);
      assert.match(events, /edge_env\.py .* set /);
      assert.match(events, /LOG 本实例远程站点已移除/, "disable must reach its final success branch");
    }
  } finally { f.clean(); }
});

for (const failure of ["hosts", "env"]) test(`EDGE=none fails closed when its ${failure} inventory cannot be read`, sh, () => {
  const f = scratch("harness-edge-none-inventory-");
  try {
    const source = readFileSync(path.join(deploy, "setup-edge.sh"), "utf8");
    const start = source.indexOf("# --- 1. choose mode");
    const block = source.slice(start, source.indexOf('[ "$EDGE" = "caddy-authelia" ]', start));
    const envFile = path.join(f.dir, "gateway.env");
    if (failure === "env") writeFileSync(envFile, "fixture\n");
    const script = `set -eu\nlog() { :; }\ndie() { echo "$*" >&2; exit 19; }\npython3() {\n  if [ "$FIXTURE_FAILURE" = hosts ] && [ "$2" != - ]; then return 1; fi\n  if [ "$FIXTURE_FAILURE" = env ] && [ "$2" = - ]; then return 1; fi\n  [ "$2" != - ] || printf 'missing\\n'\n}\nbash() { echo UNEXPECTED_DISABLE; }\nid() { echo 0; }\n${block}\nprintf 'UNEXPECTED_LOCAL_ONLY\\n'\n`;
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5000, env: { ...process.env,
      FIXTURE_FAILURE: failure, EDGE: "none", CADDY_FILE: path.join(f.dir, "Caddyfile"), EDGE_STATE: path.join(f.dir, "edge.json"),
      ENV_FILE: envFile, SCRIPT_DIR: deploy, GATEWAY_UNIT: "fixture", GATEWAY_PORT: "8080" } });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.ok(!result.stdout.includes("UNEXPECTED_LOCAL_ONLY"), result.stdout);
  } finally { f.clean(); }
});

test("EDGE=none environment inspection rejects symlinks, hard links, directories and loose modes", sh, () => {
  const f = scratch("harness-edge-env-metadata-");
  try {
    const target = path.join(f.dir, "target"); writeFileSync(target, "GATEWAY_HTTPS=false\n"); chmodSync(target, 0o600);
    const candidates = [];
    const symlink = path.join(f.dir, "symlink"); symlinkSync(target, symlink); candidates.push(symlink);
    const hardlink = path.join(f.dir, "hardlink"); linkSync(target, hardlink); candidates.push(hardlink);
    const directory = path.join(f.dir, "directory"); mkdirSync(directory); candidates.push(directory);
    const loose = path.join(f.dir, "loose"); writeFileSync(loose, "GATEWAY_HTTPS=false\n"); chmodSync(loose, 0o640); candidates.push(loose);
    for (const candidate of candidates) {
      const result = inspectEdgeEnv(candidate);
      assert.notEqual(result.status, 0, `${candidate}\n${result.stdout}\n${result.stderr}`);
    }
  } finally { f.clean(); }
});

test("EDGE=none environment inspection reads through repeated short reads", sh, () => {
  const f = scratch("harness-edge-env-short-read-");
  try {
    const file = path.join(f.dir, "gateway.env"); writeFileSync(file, "# fixture\nGATEWAY_HTTPS=false\n"); chmodSync(file, 0o600);
    const prefix = `import os\n_fixture_read = os.read\ndef _short_read(fd, count):\n    return _fixture_read(fd, min(count, 3))\nos.read = _short_read\n`;
    const result = inspectEdgeEnv(file, prefix);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "disabled");
  } finally { f.clean(); }
});

for (const race of ["grow", "exchange"]) test(`EDGE=none environment inspection rejects a concurrent ${race}`, sh, () => {
  const f = scratch("harness-edge-env-race-");
  try {
    const file = path.join(f.dir, "gateway.env"); writeFileSync(file, "# fixture payload\nGATEWAY_HTTPS=false\n"); chmodSync(file, 0o600);
    const replacement = file + ".replacement"; writeFileSync(replacement, "GATEWAY_HTTPS=false\n"); chmodSync(replacement, 0o600);
    const prefix = `import os\n_fixture_read = os.read\n_fixture_first = True\ndef _racing_read(fd, count):\n    global _fixture_first\n    data = _fixture_read(fd, min(count, 3))\n    if _fixture_first and data:\n        _fixture_first = False\n        if ${JSON.stringify(race)} == "grow":\n            with open(path, "ab", buffering=0) as stream: stream.write(b"growth")\n        else:\n            os.replace(path + ".replacement", path)\n    return data\nos.read = _racing_read\n`;
    const result = inspectEdgeEnv(file, prefix);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
  } finally { f.clean(); }
});

test("EDGE=none does not ignore a stale instance edge-state file", sh, () => {
  const f = scratch("harness-edge-none-state-");
  try {
    const source = readFileSync(path.join(deploy, "setup-edge.sh"), "utf8");
    const start = source.indexOf("# --- 1. choose mode");
    const block = source.slice(start, source.indexOf('[ "$EDGE" = "caddy-authelia" ]', start));
    const state = path.join(f.dir, "edge.json"); writeFileSync(state, "{}\n");
    const script = `set -eu\nlog() { :; }\ndie() { exit 19; }\npython3() { [ "$1" != -I ] || printf 'missing\\n'; }\nbash() { echo DISABLE_CALLED; return 17; }\nid() { echo 0; }\n${block}\n`;
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5000, env: { ...process.env,
      EDGE: "none", CADDY_FILE: path.join(f.dir, "Caddyfile"), EDGE_STATE: state, ENV_FILE: path.join(f.dir, "gateway.env"),
      SCRIPT_DIR: deploy, GATEWAY_UNIT: "fixture", GATEWAY_PORT: "8080" } });
    assert.equal(result.status, 17, result.stdout + result.stderr);
    assert.match(result.stdout, /DISABLE_CALLED/);
  } finally { f.clean(); }
});

for (const rollback of [false, true]) test(`edge disable ${rollback ? "restores" : "removes"} its instance state ${rollback ? "on failure" : "on success"}`, sh, () => {
  const f = scratch("harness-edge-state-transaction-");
  try {
    const state = path.join(f.dir, "edge.json"); writeFileSync(state, "fixture-state\n");
    const auth = path.join(f.dir, "authelia"); mkdirSync(auth);
    writeFileSync(path.join(auth, "configuration.yml"), "session:\n  cookies:\n    - domain: fixture.invalid\n      authelia_url: https://fixture.invalid/authelia/\n");
    const calls = path.join(f.dir, "calls");
    const source = readFileSync(path.join(deploy, "setup-edge.sh"), "utf8");
    let block = source.slice(source.indexOf('if [ "${EDGE_ACTION:-}" = "disable" ]; then'), source.indexOf("random_hex()"));
    block = block.replaceAll("/etc/systemd/system/", path.join(f.dir, "units") + "/");
    const script = `set -eu\nneed_root() { :; }\nlock_edge() { :; }\nload_saved_edge_state() { :; }\nvalidate_edge_values() { :; }\ncheck_edge_paths() { :; }\ndie() { echo "$*" >&2; exit 19; }\nlog() {\n  printf 'LOG %s\\n' "$*" >> "$FIXTURE_CALLS"\n  if [ "$FIXTURE_ROLLBACK" = 1 ]; then\n    [ ! -e "$EDGE_STATE" ] || return 77\n    printf 'FAIL_AFTER_STATE_REMOVAL\\n' >> "$FIXTURE_CALLS"\n    return 23\n  fi\n}\npython3() {\n  printf 'PYTHON %s\\n' "$*" >> "$FIXTURE_CALLS"\n  if [ "$2" = "$SCRIPT_DIR/lifecycle.py" ] && [ "$3" = guard-edge-removal ]; then command python3 "$@"; fi\n}\nsystemctl_do() { :; }\n${block}\n`;
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5000, env: { ...process.env,
      TMPDIR: f.dir, FIXTURE_ROLLBACK: rollback ? "1" : "0", EDGE_ACTION: "disable", EDGE_GATEWAY_STOPPED: "1", SERVICE_MGR: "none",
      CADDY_FILE: path.join(f.dir, "Caddyfile"), EDGE_STATE: state, SCRIPT_DIR: deploy, CODEX_HOME: f.dir,
      ENV_FILE: path.join(f.dir, "gateway.env"), AUTHELIA_DIR: auth, AUTHELIA_UNIT: "fixture-auth", AUTHELIA_ADDR: "127.0.0.1:1", FIXTURE_CALLS: calls,
      GATEWAY_UNIT: "fixture", GATEWAY_PORT: "8080", MANAGED_TLS_DIR: path.join(f.dir, "managed-tls"), CADDY_USER: "caddy" } });
    assert.equal(result.status, rollback ? 23 : 0, result.stdout + result.stderr);
    const events = readFileSync(calls, "utf8");
    assert.match(events, /lifecycle\.py guard-edge-removal /, "run the real read-only shared-portal guard");
    assert.match(events, /edge_env\.py .* snapshot /);
    assert.match(events, /edge_env\.py .* set /);
    assert.match(events, /LOG 本实例远程站点已移除/, "failure must be injected only after the state removal branch");
    assert.equal(existsSync(state), rollback, result.stdout + result.stderr);
    if (rollback) {
      assert.match(events, /FAIL_AFTER_STATE_REMOVAL/);
      assert.match(events, /edge_env\.py .* restore /);
      assert.equal(readFileSync(state, "utf8"), "fixture-state\n");
    } else assert.doesNotMatch(events, /FAIL_AFTER_STATE_REMOVAL|edge_env\.py .* restore /);
  } finally { f.clean(); }
});

for (const failure of ["non-git", "fetch", "local-ref", "remote-ref"]) test(`manage update reports ${failure} inspection failure`, sh, () => {
  const f = scratch("harness-update-status-");
  try {
    if (failure !== "non-git") mkdirSync(path.join(f.dir, ".git"));
    const definition = extract("manage.sh", "do_update");
    const script = `set -eu\nneed_root() { :; }\nassert_instance_checkout() { :; }\nlog() { :; }\ndie() { exit 19; }\nflock() { :; }\ngit() {\n  case "$*" in\n    *" fetch "*) [ "$FIXTURE_FAILURE" != fetch ] ;;\n    *" rev-parse --verify HEAD"*) [ "$FIXTURE_FAILURE" != local-ref ] && echo local ;;\n    *" rev-parse --verify @{u}"*) [ "$FIXTURE_FAILURE" != remote-ref ] && echo remote ;;\n    *" rev-parse --verify origin/HEAD"*) return 1 ;;\n    *) : ;;\n  esac\n}\n${definition}\ndo_update\nprintf 'UNEXPECTED_SUCCESS\\n'\n`;
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5000, env: { ...process.env,
      FIXTURE_FAILURE: failure, REPO_ROOT: f.dir, SCRIPT_DIR: deploy } });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.ok(!result.stdout.includes("UNEXPECTED_SUCCESS"), result.stdout);
  } finally { f.clean(); }
});

for (const outcome of ["current", "cancelled"]) test(`manage update returns success when ${outcome}`, sh, () => {
  const f = scratch("harness-update-benign-");
  try {
    mkdirSync(path.join(f.dir, ".git"));
    const definition = extract("manage.sh", "do_update");
    const script = `set -eu\nneed_root() { :; }\nassert_instance_checkout() { :; }\nlog() { :; }\ndie() { exit 19; }\nflock() { :; }\ngit() {\n  case "$*" in\n    *" fetch "*) : ;;\n    *" rev-parse --verify HEAD"*) echo local ;;\n    *" rev-parse --verify @{u}"*) [ "$FIXTURE_OUTCOME" = current ] && echo local || echo remote ;;\n    *" log -1 "*) echo fixture ;;\n    *" --no-pager log "*) echo candidate ;;\n    *) : ;;\n  esac\n}\n${definition}\ndo_update\nprintf 'BENIGN_SUCCESS\\n'\n`;
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5000, env: { ...process.env,
      FIXTURE_OUTCOME: outcome, UPDATE: "n", REPO_ROOT: f.dir, SCRIPT_DIR: deploy } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /BENIGN_SUCCESS/);
  } finally { f.clean(); }
});

test("uninstall summary assigns each retained credential to its actual directory", sh, () => {
  const f = scratch("harness-uninstall-summary-");
  try {
    const definition = extract("manage.sh", "do_uninstall");
    const script = `set -eu\nneed_root() { :; }\nassert_instance_checkout() { :; }\ndie() { exit 19; }\nlog() { :; }\npython3() { [ "$2" != prepare ] || echo fixture-identity; }\n${definition}\ndo_uninstall\n`;
    const home = path.join(f.dir, "codex"), envFile = path.join(f.dir, "provider.env"), control = path.join(f.dir, "control");
    const result = spawnSync("bash", ["-c", script], { input: "no\n", encoding: "utf8", timeout: 5000, env: { ...process.env,
      REPO_ROOT: f.dir, SCRIPT_DIR: deploy, SERVICE_NAME: "fixture", SERVICE_HOME: f.dir, UNIT_FILE: path.join(f.dir, "fixture.service"),
      CODEX_HOME: home, ENV_FILE: envFile, GATEWAY_CONTROL_HOME: control, CODEX_WORKSPACE: path.join(f.dir, "workspace") } });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /codex 用户数据：.*网关 token/);
    assert.match(result.stdout, new RegExp(`服务环境文件：${envFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}（供应商 API Key`));
    assert.match(result.stdout, new RegExp(`独立管理目录：${control.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}（网关管理令牌`));
  } finally { f.clean(); }
});
