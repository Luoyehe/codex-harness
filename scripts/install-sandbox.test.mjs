import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourcePath = fileURLToPath(new URL("../deploy/install-sandbox.sh", import.meta.url));
const source = readFileSync(sourcePath, "utf8");
const options = { skip: process.platform === "win32" ? "Linux Bash required for isolated package/profile command fixtures" : false };
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

function fixture(settings = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "install-sandbox-"));
  const bin = path.join(root, "bin"), home = path.join(root, "service-home"), workspace = path.join(home, "workspace"), codexHome = path.join(home, ".codex");
  const bwrap = path.join(bin, "bwrap"), target = path.join(root, "etc/bwrap-userns-restrict"), extra = path.join(root, "share/bwrap-userns-restrict");
  const restriction = path.join(root, "restriction"), events = path.join(root, "events"), cwd = path.join(root, "cwd");
  for (const directory of [bin, workspace, codexHome, path.dirname(target), path.dirname(extra)]) mkdirSync(directory, { recursive: true });
  writeFileSync(events, "");
  writeFileSync(restriction, String(settings.restriction ?? 1) + "\n");
  const profile = "# distribution fixture\nprofile bwrap-userns-restrict {}\n";
  if (settings.extra !== false) writeFileSync(extra, profile);
  if (settings.target === "distribution") writeFileSync(target, profile);
  else if (settings.target === "custom") writeFileSync(target, "# administrator custom policy\n");
  const executable = (name, body) => writeFileSync(path.join(bin, name), "#!/bin/sh\nset -eu\n" + body + "\n", { mode: 0o755 });
  if (settings.bwrap !== false) executable("bwrap", "exit 0");
  executable("uname", "printf 'Linux\\n'");
  executable("id", 'if [ "$#" = 1 ] && [ "$1" = -u ]; then printf "0\\n"; elif [ "$1" = -u ]; then printf "' + (settings.rootUser ? "0" : "995") + '\\n"; else exit 1; fi');
  executable("getent", "printf '%s\\n' " + quote("fixture-user:x:995:987::" + home + ":/usr/sbin/nologin"));
  executable("dpkg-query", `case "$2" in
${quote(bwrap)}) printf 'bubblewrap: %s\\n' "$2" ;;
${quote(extra)}) [ -f "$2" ] && printf 'apparmor-profiles: %s\\n' "$2" ;;
${quote(target)}) ${settings.packagedTarget ? "printf 'apparmor: %s\\n' \"$2\"" : "exit 1"} ;;
*) exit 1 ;;
esac`);
  executable("dpkg", settings.modifiedExtra ? 'if [ "$2" = apparmor-profiles ]; then printf "??5??????  %s\\n" ' + quote(extra) + '; exit 1; fi' : "exit 0");
  executable("apt-get", `printf 'apt:%s\\n' "$*" >> ${quote(events)}
${settings.aptFails ? "exit 9" : ""}
case "$*" in
*install*bubblewrap*) printf '#!/bin/sh\\nexit 0\\n' > ${quote(bwrap)}; chmod 755 ${quote(bwrap)} ;;
*install*apparmor-profiles*) ${settings.profileUnavailable ? ":" : "printf '%s' " + quote(profile) + " > " + quote(extra)} ;;
esac`);
  executable("apparmor_parser", `printf 'parser:%s\\n' "$*" >> ${quote(events)}
exit ${settings.parserFails ? 12 : 0}`);
  executable("runuser", `printf 'runuser:%s\\n' "$*" >> ${quote(events)}
[ "$1" = -u ] && [ "$2" = fixture-user ] && [ "$3" = -- ]
shift 3
exec "$@"`);
  executable("codex", `printf 'cli:%s\\n' "$*" >> ${quote(events)}
pwd > ${quote(cwd)}
[ "$HOME" = ${quote(home)} ] && [ "$CODEX_HOME" = ${quote(codexHome)} ]
[ "\${FIXTURE_SECRET+x}" != x ]
exit ${settings.sandboxFails ? 23 : 0}`);
  let isolated = source;
  for (const [original, replacement] of [["/usr/bin/bwrap", bwrap], ["/proc/sys/kernel/apparmor_restrict_unprivileged_userns", restriction], ["/etc/apparmor.d/bwrap-userns-restrict", target], ["/usr/share/apparmor/extra-profiles/bwrap-userns-restrict", extra]]) isolated = isolated.replaceAll(original, replacement);
  const script = path.join(root, "install-sandbox.sh");
  writeFileSync(script, isolated);
  return {
    root, target, extra, restriction, events, cwd, workspace,
    run(overrides = {}) {
      return spawnSync("bash", [script], { cwd: root, encoding: "utf8", timeout: 10000,
        env: { ...process.env, PATH: bin + ":/usr/bin:/bin", RUN_USER: "fixture-user", CODEX_HOME: codexHome, CODEX_WORKSPACE: workspace, CODEX_BIN: path.join(bin, "codex"), ALLOW_ROOT_SERVICE: "0", FIXTURE_SECRET: "do-not-forward", ...overrides } });
    },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

test("sandbox helper fixes the pinned CLI form and never disables global enforcement", () => {
  assert.ok(source.includes('sandbox -c \'sandbox_mode="read-only"\' -- /usr/bin/true'));
  assert.doesNotMatch(source, /(?:sysctl\s+-w|apparmor_restrict_unprivileged_userns\s*=\s*0|systemctl\s+(?:reload|stop|disable)\s+apparmor|danger-full-access|--no-sandbox)/);
  assert.match(source, /apparmor_parser -r "\$PROFILE_TO_LOAD"/);
  assert.match(source, /env -i HOME=/);
});

test("distribution profile installation is scoped, repeatable, and followed by the service-user probe", options, () => {
  const f = fixture();
  try {
    for (let i = 0; i < 2; i++) {
      const result = f.run();
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.match(result.stdout, /SANDBOX-PREFLIGHT-PASS/);
    }
    assert.equal(readFileSync(f.target, "utf8"), readFileSync(f.extra, "utf8"));
    assert.equal(readFileSync(f.restriction, "utf8"), "1\n");
    assert.equal(readFileSync(f.cwd, "utf8").trim(), f.workspace);
    const events = readFileSync(f.events, "utf8");
    assert.equal(events.split("parser:-r ").length - 1, 2);
    assert.ok(events.includes('cli:sandbox -c sandbox_mode="read-only" -- /usr/bin/true'));
    assert.ok(events.includes("runuser:-u fixture-user -- env -i"));
    assert.ok(!events.includes("apt:"));
  } finally { f.cleanup(); }
});

test("missing distribution prerequisites install only required packages", options, () => {
  const f = fixture({ bwrap: false, extra: false });
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const events = readFileSync(f.events, "utf8");
    assert.ok(events.includes("install -y --no-install-recommends bubblewrap"));
    assert.ok(events.includes("install -y --no-install-recommends apparmor-profiles"));
    assert.ok(!events.includes("apparmor-utils"));
  } finally { f.cleanup(); }
});

test("existing custom profile is untouched and never auto-loaded; the live preflight decides success", options, () => {
  for (const sandboxFails of [false, true]) {
    const f = fixture({ target: "custom", sandboxFails });
    try {
      const original = readFileSync(f.target, "utf8");
      const result = f.run();
      assert.equal(result.status === 0, !sandboxFails, result.stderr + result.stdout);
      assert.equal(readFileSync(f.target, "utf8"), original);
      assert.ok(!readFileSync(f.events, "utf8").includes("parser:"));
      assert.match(result.stdout, /custom\/modified.*preserved/);
      if (sandboxFails) assert.ok(!result.stdout.includes("SANDBOX-PREFLIGHT-PASS"));
    } finally { f.cleanup(); }
  }
});

test("missing/modified distribution profiles and parser failures stop before any successful probe", options, () => {
  for (const settings of [{ extra: false, profileUnavailable: true }, { modifiedExtra: true }, { parserFails: true }, { bwrap: false, aptFails: true }]) {
    const f = fixture(settings);
    try {
      const result = f.run();
      assert.notEqual(result.status, 0);
      assert.ok(!result.stdout.includes("SANDBOX-PREFLIGHT-PASS"));
      assert.ok(!readFileSync(f.events, "utf8").includes("cli:"));
      assert.match(result.stderr, /ERROR:/);
      assert.equal(readFileSync(f.restriction, "utf8"), "1\n");
    } finally { f.cleanup(); }
  }
});

test("a sandbox failure remains failure and prints a non-inference reproduction", options, () => {
  const f = fixture({ sandboxFails: true });
  try {
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.ok(!result.stdout.includes("SANDBOX-PREFLIGHT-PASS"));
    assert.match(result.stderr, /Reproduce without inference:/);
    assert.match(result.stderr, /journalctl -k/);
  } finally { f.cleanup(); }
});

test("unrestricted hosts do not modify profiles but still require the read-only sandbox probe", options, () => {
  const f = fixture({ restriction: 0, extra: false });
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.ok(!existsSync(f.target));
    assert.ok(!readFileSync(f.events, "utf8").includes("parser:"));
    assert.ok(readFileSync(f.events, "utf8").includes("cli:"));
  } finally { f.cleanup(); }
});

test("root service UID is rejected before side effects even with the legacy escape hatch", options, () => {
  const f = fixture({ rootUser: true });
  try {
    for (const bypass of ["0", "1"]) {
      const rejected = f.run({ ALLOW_ROOT_SERVICE: bypass });
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /RUN_USER must be non-root/);
      assert.match(rejected.stderr, /no longer bypasses/);
      assert.ok(!rejected.stdout.includes("SANDBOX-PREFLIGHT-SKIPPED"));
      assert.ok(!rejected.stdout.includes("SANDBOX-PREFLIGHT-PASS"));
    }
    assert.equal(readFileSync(f.events, "utf8"), "");
  } finally { f.cleanup(); }
});
