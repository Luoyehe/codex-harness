import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = fileURLToPath(new URL("../", import.meta.url));
const deploy = path.join(repo, "deploy");
const sh = { skip: process.platform === "win32" ? "POSIX Bash fixtures required" : false };

function shellFunction(source, name) {
  const start = source.indexOf(`${name}() {`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = source.indexOf("\n}", start);
  assert.ok(end > start, `unterminated ${name}`);
  return source.slice(start, end + 2);
}

test("service registration helper passes Linux fault-injection regression suite", {
  skip: process.platform !== "linux" ? "Linux no-follow descriptors required" : false,
}, () => {
  const result = spawnSync("python3", [path.join(repo, "scripts", "service-registration-linux.test.py")], {
    encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran 7 tests/);
});

test("installer delegates activation to the registration transaction and isolates local helpers", () => {
  const install = readFileSync(path.join(deploy, "install.sh"), "utf8");
  const register = readFileSync(path.join(deploy, "register-service.sh"), "utf8");
  assert.match(install, /REGISTER_ACTIVATE=1/);
  const registrationBlock = install.slice(
    install.indexOf('log "registering system files'),
    install.indexOf("# --- 6. model provider"),
  );
  assert.doesNotMatch(registrationBlock, /systemctl\s+(daemon-reload|enable)/);
  for (const invocation of [
    'python3 -I "$SCRIPT_DIR/runtime_paths.py"',
    'run_as_service python3 -I "$SCRIPT_DIR/service_env.py"',
  ]) assert.ok(install.includes(invocation), invocation);
  assert.ok(install.includes('service_registration.py" inspect-unit'));
  assert.doesNotMatch(install, /sed -n[^\n]*\$EXISTING_UNIT|grep[^\n]*\$EXISTING_UNIT/);
  assert.ok(register.includes('python3 -I "$SCRIPT_DIR/runtime_paths.py"'));
  assert.match(register, /case "\$GATEWAY_GROUP"/);
  assert.doesNotMatch(register, /\/etc\/systemd\/system\/\*\.service/);
  assert.doesNotMatch(register, /rm\s+-f\s+\/usr\/local\/libexec\/codex-harness-admin/);
});

test("activation and rollback cover daemon reload, enable/start, and retained recovery", () => {
  const register = readFileSync(path.join(deploy, "register-service.sh"), "utf8");
  assert.match(register, /REGISTRATION_SYSTEMD_TOUCHED=1[\s\S]*systemctl daemon-reload[\s\S]*systemctl enable/);
  assert.match(register, /systemctl stop "\$SERVICE_NAME"[\s\S]*service registration failed|service registration failed[\s\S]*systemctl stop "\$SERVICE_NAME"/);
  assert.match(register, /REGISTRATION_PRIOR_ENABLED[\s\S]*REGISTRATION_PRIOR_ACTIVE/);
  assert.match(register, /root-private recovery retained at \$REGISTRATION_TRANSACTION/);
  assert.match(register, /"\$REGISTRATION_HELPER" restore/);
});

test("daemon-reload, enable, and start faults all execute the registration rollback", sh, () => {
  const source = readFileSync(path.join(deploy, "register-service.sh"), "utf8");
  const definitions = [shellFunction(source, "activate_registration"), shellFunction(source, "rollback_registration")]
    .join("\n")
    .replaceAll("/usr/bin/systemctl", "systemctl_do")
    .replaceAll('python3 -I "$REGISTRATION_HELPER"', "registration_helper");
  for (const failing of ["daemon-reload", "enable", "start"]) {
    const script = `set -euo pipefail
FAILED=0
systemctl_do() {
  printf 'systemctl:%s\n' "$*"
  if [ "$1" = "$FAIL_COMMAND" ] && [ "$FAILED" = 0 ]; then FAILED=1; return 17; fi
}
registration_helper() { printf 'helper:%s\n' "$*"; }
${definitions}
SERVICE_NAME=fixture
REGISTRATION_HELPER=/unused/helper
REGISTRATION_TRANSACTION=/private/recovery
REGISTRATION_SYSTEMD_TOUCHED=0
REGISTRATION_PRIOR_ENABLED=0
REGISTRATION_PRIOR_ACTIVE=0
trap rollback_registration EXIT
activate_registration
trap - EXIT
`;
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8", timeout: 5000, env: { ...process.env, FAIL_COMMAND: failing },
    });
    assert.notEqual(result.status, 0, `${failing}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /helper:restore \/private\/recovery/);
    assert.match(result.stdout, /helper:discard \/private\/recovery/);
    assert.doesNotMatch(result.stderr, /rollback incomplete/);
  }
});

test("a failed rollback stop never rewrites live files and retains recovery", sh, () => {
  const source = readFileSync(path.join(deploy, "register-service.sh"), "utf8");
  const rollback = shellFunction(source, "rollback_registration")
    .replaceAll("/usr/bin/systemctl", "systemctl_do")
    .replaceAll('python3 -I "$REGISTRATION_HELPER"', "registration_helper");
  const script = `set -euo pipefail
systemctl_do() { printf 'systemctl:%s\n' "$*"; [ "$1" != stop ]; }
registration_helper() { printf 'UNEXPECTED_HELPER:%s\n' "$*"; }
${rollback}
SERVICE_NAME=fixture
REGISTRATION_HELPER=/unused/helper
REGISTRATION_TRANSACTION=/private/recovery
REGISTRATION_SYSTEMD_TOUCHED=1
REGISTRATION_PRIOR_ENABLED=1
REGISTRATION_PRIOR_ACTIVE=1
trap rollback_registration EXIT
false
`;
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5000 });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /UNEXPECTED_HELPER/);
  assert.match(result.stderr, /refusing to replace files under a live process/);
  assert.match(result.stderr, /root-private recovery retained at \/private\/recovery/);
});

test("a failed rollback stop may restore only after systemd proves the unit inactive", sh, () => {
  const source = readFileSync(path.join(deploy, "register-service.sh"), "utf8");
  const rollback = shellFunction(source, "rollback_registration")
    .replaceAll("/usr/bin/systemctl", "systemctl_do")
    .replaceAll('python3 -I "$REGISTRATION_HELPER"', "registration_helper");
  const script = `set -euo pipefail
systemctl_do() {
  case "$1" in
    stop) printf 'systemctl:%s\n' "$*"; return 1 ;;
    is-active) printf 'unknown\n'; return 4 ;;
    *) printf 'systemctl:%s\n' "$*"; return 0 ;;
  esac
}
registration_helper() { printf 'helper:%s\n' "$*"; }
${rollback}
SERVICE_NAME=fixture
REGISTRATION_HELPER=/unused/helper
REGISTRATION_TRANSACTION=/private/recovery
REGISTRATION_SYSTEMD_TOUCHED=1
REGISTRATION_PRIOR_ENABLED=0
REGISTRATION_PRIOR_ACTIVE=0
trap rollback_registration EXIT
false
`;
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5000 });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /helper:restore \/private\/recovery/);
  assert.match(result.stdout, /helper:discard \/private\/recovery/);
  assert.match(result.stderr, /systemd proves the unit is not active/);
  assert.doesNotMatch(result.stderr, /rollback incomplete/);
});
