import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const source = readFileSync(new URL("../deploy/setup-edge.sh", import.meta.url), "utf8");
const bash = process.env.CODEX_TEST_BASH || "bash";
const shell = { skip: process.platform === "win32" ? "POSIX Bash filesystem fixture required" : false };
function definition(name) {
  const start = source.indexOf(`\n${name}() {`) + 1;
  assert.ok(start > 0, name);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}
const startupBegin = source.indexOf('  AUTH_RUNTIME_TOUCHED=1\n  systemctl_do enable');
const startup = source.slice(startupBegin, source.indexOf('\nelse\n  [ -n "$AUTHELIA_BIN"', startupBegin));
const discovery = source.slice(source.indexOf("# --- 4. Authelia"), source.indexOf("# Upgrade hardening"));

test("edge records a possible database-binding startup before dispatch, after enable/reset", () => {
  assert.ok(startupBegin > 0);
  assert.ok(startup.indexOf("AUTH_START_ATTEMPTED=1") > startup.indexOf("systemctl_do reset-failed"));
  assert.ok(startup.indexOf("AUTH_START_ATTEMPTED=1") < startup.indexOf("systemctl_do restart"));
  assert.match(startup, /SERVICE_MGR.*systemd/);
});

function fixture(existing = false) {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-edge-auth-rollback-"));
  chmodSync(dir, 0o700);
  const auth = path.join(dir, "auth"), units = path.join(dir, "units"), backup = path.join(dir, "backup");
  const dropin = path.join(units, "fixture-auth.service.d", "codex-harness-hardening.conf");
  for (const item of [auth, units, backup, path.dirname(dropin)]) mkdirSync(item, { recursive: true, mode: 0o700 });
  const current = {
    "configuration.yml": "storage:\n  encryption_key: synthetic-private-storage-key\n# candidate cookies\n",
    "users_database.yml": "users: synthetic-private-user-hash\n",
    "initial-password": "synthetic-private-initial-password\n",
  };
  for (const [name, data] of Object.entries(current)) writeFileSync(path.join(auth, name), data, { mode: 0o600 });
  const unit = path.join(units, "fixture-auth.service");
  writeFileSync(unit, "Description=Authelia authentication for codex-harness\n# candidate unit\n");
  writeFileSync(dropin, "# candidate hardening\n");
  writeFileSync(path.join(dir, "Caddyfile"), "# candidate edge\n");
  writeFileSync(path.join(backup, "Caddyfile"), "# original edge\n");
  if (existing) {
    writeFileSync(path.join(backup, "configuration.yml"), current["configuration.yml"].replace("candidate", "original"));
    writeFileSync(path.join(backup, "users_database.yml"), "original users\n");
    writeFileSync(path.join(backup, "initial-password"), "original password\n");
    writeFileSync(path.join(backup, "authelia.service"), "# original unit\n");
    writeFileSync(path.join(backup, "authelia-hardening.conf"), "# original hardening\n");
  }
  const flags = existing ? "0" : "1";
  const env = {
    ...process.env, FIXTURE_DIR: dir, AUTHELIA_DIR: auth, AUTHELIA_STATE_DIR: path.join(dir, "state"),
    AUTHELIA_UNIT: "fixture-auth", GATEWAY_UNIT: "fixture-gateway", SERVICE_MGR: "systemd", DOMAIN: "fixture.example.com",
    RB_DIR: backup, TMPD: "", CADDY_FILE: path.join(dir, "Caddyfile"), AUTH_DROPIN: dropin,
    AUTH_INITIAL: path.join(auth, "initial-password"), EDGE_STATE: path.join(dir, "edge.json"),
    CODEX_HOME: dir, ENV_FILE: path.join(dir, "gateway.env"), SCRIPT_DIR: "/fixture/deploy",
    RB_NEW_CADDY: "0", RB_NEW_AUTH_CONF: flags, RB_NEW_AUTH_USERS: flags, RB_NEW_AUTH_UNIT: flags,
    RB_NEW_AUTH_DROPIN: flags, RB_NEW_AUTH_INITIAL: flags, RB_NEW_EDGE_STATE: "1", AUTH_UNIT_CREATED: flags,
    AUTH_RUNTIME_TOUCHED: "0", AUTH_START_ATTEMPTED: "0", GATEWAY_RUNTIME_TOUCHED: "0",
    RB_AUTH_WAS_ACTIVE: existing ? "1" : "0", RB_AUTH_WAS_ENABLED: existing ? "1" : "0",
    FAIL_AT: "caddy", STOP_MODE: "ok", FAIL_RESTORE: "0", HEALTH_FAIL: "0",
  };
  // All system commands are strict doubles; cp/rm and the actual rollback body
  // operate only on this fixture. The state bytes stand in for an initialized
  // SQLite file, whose real startup key-binding is an Authelia contract.
  const prelude = `set -euo pipefail
umask 077
log() { printf '%s\\n' "$*"; }
wait_authelia() { [ "$HEALTH_FAIL" != 1 ]; }
python3() { [ "$2" = /fixture/deploy/edge_env.py ]; }
cp() {
  if [ "$FAIL_RESTORE" = 1 ] && [[ "$*" == *"$RB_DIR/configuration.yml"* ]]; then return 19; fi
  command cp "$@"
}
systemctl() {
  [ "$1" = is-active ] || return 97
  case "$STOP_MODE" in
    inactive) printf 'inactive\\n'; return 3 ;;
    failed) printf 'failed\\n'; return 3 ;;
    unknown) printf 'unknown\\n'; return 4 ;;
    active) printf 'active\\n'; return 0 ;;
    unavailable) return 1 ;;
    *) return 97 ;;
  esac
}
systemctl_do() {
  printf '%s\\n' "$*" >> "$FIXTURE_DIR/actions"
  case "$*" in
    "stop fixture-auth")
      # Stopping must precede every identity restore/removal.
      cmp -s "$AUTHELIA_DIR/configuration.yml" "$FIXTURE_DIR/candidate-config" || return 96
      [ "$STOP_MODE" = ok ] ;;
    "enable fixture-auth") [ "$FAIL_AT" != enable ] ;;
    "reset-failed fixture-auth"|"disable fixture-auth"|daemon-reload) return 0 ;;
    "restart fixture-auth")
      if [ -e "$FIXTURE_DIR/bound-config" ]; then
        # Existing-identity rollback is allowed to restore its original cookies.
        grep -q 'encryption_key: synthetic-private-storage-key' "$AUTHELIA_DIR/configuration.yml"
      else
        command cp "$AUTHELIA_DIR/configuration.yml" "$FIXTURE_DIR/bound-config"
        printf 'opaque-existing-database-must-survive' > "$FIXTURE_DIR/db.sqlite3"
      fi
      [ "$FAIL_AT" != start ] ;;
    "reload caddy"|"restart caddy")
      if [ "$FAIL_AT" = caddy ] && [ ! -e "$FIXTURE_DIR/fault-consumed" ]; then
        [ "$1" != restart ] || : > "$FIXTURE_DIR/fault-consumed"
        return 17
      fi ;;
    "restart fixture-gateway")
      if [ "$FAIL_AT" = gateway ] && [ ! -e "$FIXTURE_DIR/fault-consumed" ]; then
        : > "$FIXTURE_DIR/fault-consumed"; return 17
      fi ;;
    *) return 97 ;;
  esac
}
${definition("rollback").replaceAll("/etc/systemd/system/", units + "/")}
${definition("cleanup_edge_transaction")}
trap cleanup_edge_transaction EXIT
`;
  writeFileSync(path.join(dir, "candidate-config"), current["configuration.yml"]);
  return {
    dir, auth, unit, dropin, backup, current,
    run(overrides = {}) {
      return spawnSync(bash, ["-c", prelude + startup + `
systemctl_do reload caddy || systemctl_do restart caddy
GATEWAY_RUNTIME_TOUCHED=1
systemctl_do restart "$GATEWAY_UNIT"
`], { env: { ...env, ...overrides }, encoding: "utf8", timeout: 5000 });
    },
    retry() {
      return spawnSync(bash, ["-c", `set -euo pipefail
log() { :; }
authelia() { return 0; }
random_hex() { echo UNEXPECTED_KEY_ROTATION >&2; return 99; }
wait_authelia() { return 0; }
systemctl_do() {
  case "$*" in
    "enable fixture-auth"|"reset-failed fixture-auth") return 0 ;;
    "restart fixture-auth") cmp -s "$AUTHELIA_DIR/configuration.yml" "$FIXTURE_DIR/bound-config" ;;
    *) return 97 ;;
  esac
}
${discovery}
[ "$FRESH_AUTHELIA" = 0 ]
${startup}
`], { env, encoding: "utf8", timeout: 5000 });
    },
    actions: () => readFileSync(path.join(dir, "actions"), "utf8").trim().split("\n"),
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

for (const failing of ["caddy", "gateway", "start", "health"]) {
  test(`fresh identity survives ${failing} failure and retry reuses its database key`, shell, () => {
    const f = fixture();
    try {
      const result = f.run({ FAIL_AT: failing, HEALTH_FAIL: failing === "health" ? "1" : "0" });
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      for (const [name, data] of Object.entries(f.current)) {
        assert.equal(readFileSync(path.join(f.auth, name), "utf8"), data);
        assert.equal(readFileSync(path.join(f.backup, "started-auth", name), "utf8"), data);
      }
      assert.ok(existsSync(f.unit) && existsSync(f.dropin));
      assert.equal(statSync(path.join(f.backup, "started-auth")).mode & 0o777, 0o700);
      const state = readFileSync(path.join(f.dir, "db.sqlite3"));
      const retry = f.retry();
      assert.equal(retry.status, 0, retry.stdout + retry.stderr);
      assert.equal(readFileSync(path.join(f.auth, "configuration.yml"), "utf8"), f.current["configuration.yml"]);
      assert.deepEqual(readFileSync(path.join(f.dir, "db.sqlite3")), state);
      assert.equal(readFileSync(path.join(f.dir, "Caddyfile"), "utf8"), "# original edge\n");
      const actions = f.actions();
      assert.ok(actions.indexOf("stop fixture-auth") < actions.indexOf("disable fixture-auth"));
      assert.match(result.stdout, /首次启动的 Authelia 已停止并禁用/);
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private/);
    } finally { f.close(); }
  });
}

test("failure before the first start removes unused new identity and unit", shell, () => {
  const f = fixture();
  try {
    const result = f.run({ FAIL_AT: "enable" });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(path.join(f.dir, "db.sqlite3")), false);
    assert.equal(existsSync(path.join(f.auth, "configuration.yml")), false);
    assert.equal(existsSync(f.unit), false);
    assert.equal(existsSync(f.backup), false);
  } finally { f.close(); }
});

for (const existing of [false, true]) for (const stopMode of ["active", "unavailable"]) {
  test(`${existing ? "existing" : "fresh"} identity and recovery survive unconfirmed stop (${stopMode})`, shell, () => {
    const f = fixture(existing);
    try {
      const result = f.run({ STOP_MODE: stopMode });
      assert.notEqual(result.status, 0);
      assert.equal(readFileSync(path.join(f.auth, "configuration.yml"), "utf8"), f.current["configuration.yml"]);
      assert.match(readFileSync(f.unit, "utf8"), /candidate unit/);
      assert.ok(existsSync(f.backup));
      const actions = f.actions(), stop = actions.indexOf("stop fixture-auth");
      assert.ok(stop > 0);
      assert.ok(!actions.slice(stop + 1).some(item => /fixture-auth/.test(item)), actions.join("\n"));
      assert.match(result.stdout, /停止未获确认/);
      assert.match(result.stdout, /自动恢复未完成/);
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private/);
    } finally { f.close(); }
  });
}

for (const stopMode of ["ok", "inactive", "failed", "unknown"]) {
  test(`existing identity restores snapshots and runtime only after confirmed stop (${stopMode})`, shell, () => {
    const f = fixture(true);
    try {
      const result = f.run({ STOP_MODE: stopMode });
      assert.notEqual(result.status, 0);
      assert.match(readFileSync(path.join(f.auth, "configuration.yml"), "utf8"), /original cookies/);
      assert.equal(readFileSync(f.unit, "utf8"), "# original unit\n");
      assert.equal(readFileSync(f.dropin, "utf8"), "# original hardening\n");
      assert.equal(readFileSync(path.join(f.dir, "db.sqlite3"), "utf8"), "opaque-existing-database-must-survive");
      assert.equal(existsSync(f.backup), false);
      const actions = f.actions(), stop = actions.indexOf("stop fixture-auth");
      assert.ok(actions.lastIndexOf("restart fixture-auth") > stop);
    } finally { f.close(); }
  });
}

test("partial existing-identity restore keeps the service stopped and retains recovery", shell, () => {
  const f = fixture(true);
  try {
    const result = f.run({ FAIL_RESTORE: "1" });
    assert.notEqual(result.status, 0);
    const actions = f.actions(), stop = actions.indexOf("stop fixture-auth");
    assert.ok(!actions.slice(stop + 1).includes("restart fixture-auth"));
    assert.ok(existsSync(f.backup));
    assert.match(result.stdout, /自动恢复未完成/);
  } finally { f.close(); }
});
