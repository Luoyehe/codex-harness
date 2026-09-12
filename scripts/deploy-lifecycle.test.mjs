import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const deploy = fileURLToPath(new URL("../deploy/", import.meta.url));
const python = process.env.CODEX_TEST_PYTHON || "python3";
const pythonAvailable = spawnSync(python, ["-c", "import sys; assert sys.version_info >= (3,11)"], { windowsHide: true }).status === 0;
const pyOptions = { skip: pythonAvailable ? false : "Python 3.11+ required for deployment behavior tests" };
const bashAvailable = process.platform !== "win32" && spawnSync("bash", ["--version"]).status === 0;
const shOptions = { skip: bashAvailable ? false : "Linux Bash required for isolated command fixtures" };

function runPython(code, args = []) {
  const result = spawnSync(python, ["-c", code, ...args], {
    encoding: "utf8", windowsHide: true, timeout: 10000,
    env: { ...process.env, PYTHONPATH: deploy, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("management provider status reads quoted TOML root keys semantically", pyOptions, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "deploy-provider-status-"));
  try {
    const file = path.join(dir, "config.toml");
    for (const [source, expected] of [
      ['"model_provider" = "custom"\n', "custom（自定义 OpenAI 兼容 API）"],
      ["'model_provider' = 'ZAI'\n", "zhipu（智谱 Coding Plan）"],
      ['model_provider = "custom"\n', "custom（自定义 OpenAI 兼容 API）"],
      ['instructions = """\nmodel_provider = "ZAI"\n"""\n', "openai（原生默认模式）"],
      ["", "openai（原生默认模式）"],
    ]) {
      writeFileSync(file, source);
      const result = runPython("from lifecycle import provider_label; import sys; print(provider_label(sys.argv[1]))", [file]).trim();
      assert.equal(result, expected);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("uninstall rejects retained data below or equal to the deletion root", pyOptions, () => {
  runPython(`from lifecycle import guard_delete
from pathlib import Path
import tempfile
root = str(Path(tempfile.gettempdir()) / "deployment-guard-fixture")
for value in (root, root + "/state", root + "/nested/../secrets.env"):
    try: guard_delete(root, {"retained": value})
    except ValueError: pass
    else: raise AssertionError(value)
assert guard_delete(root, {"state": root + "-data"}) == str(Path(root).resolve())
`);
});

const sites = `# unrelated comment
unrelated.example.com { respond ok }
# codex-harness:begin instance-a a.example.com:443
https://a.example.com:443 {
  forward_auth 127.0.0.1:9091 { uri /authelia/api/authz/forward-auth }
  reverse_proxy 127.0.0.1:18410 { flush_interval -1 }
}
# codex-harness:end instance-a a.example.com:443
# codex-harness:begin instance-b b.example.com:443
https://b.example.com:443 {
  forward_auth 127.0.0.1:9091 { uri /authelia/api/authz/forward-auth }
  reverse_proxy 127.0.0.1:18411 { flush_interval -1 }
}
# codex-harness:end instance-b b.example.com:443
`;

test("edge removal preserves other instances and shared authentication references", pyOptions, () => {
  runPython(`from lifecycle import edit_edge, edge_hosts
import sys
text = sys.argv[1]
result = edit_edge(text, "instance-a", "18410")
assert "a.example.com" not in result
assert "b.example.com" in result and "unrelated.example.com" in result
assert edge_hosts(result, auth="127.0.0.1:9091") == ["b.example.com:443"]
assert edit_edge(text, "new-local-only", "18412") == text
assert edge_hosts(text, "instance-a", "18410") == ["a.example.com:443"]
`, [sites]);
});

test("legacy markers are adopted only by the matching gateway upstream", pyOptions, () => {
  runPython(`from lifecycle import edit_edge
import sys
text = sys.argv[1].replace("instance-a ", "").replace("instance-b ", "")
result = edit_edge(text, "instance-a", "18410")
assert "a.example.com" not in result and "b.example.com" in result
`, [sites]);
});

test("edge edits reject marker corruption and host takeover without touching the file", pyOptions, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "deploy-markers-"));
  try {
    const file = path.join(dir, "Caddyfile");
    writeFileSync(file, sites);
    const replacement = path.join(dir, "replacement");
    writeFileSync(replacement, "replacement must not be published\n");
    const rejected = spawnSync(python, [path.join(deploy, "lifecycle.py"), "upsert", file, "instance-b", "18411", "a.example.com:443", replacement], {
      encoding: "utf8", timeout: 10000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    assert.notEqual(rejected.status, 0);
    runPython(`from lifecycle import edit_edge, blocks
import sys
text = sys.argv[1]
try: edit_edge(text, "instance-b", "18411", "a.example.com:443", "replacement")
except ValueError: pass
else: raise AssertionError("allowed takeover")
for broken in ("# codex-harness:begin x h:443\\n", "# codex-harness:end x h:443\\n", "# codex-harness:begin x h:443\\n# codex-harness:begin x h:443\\n"):
    try: blocks(broken)
    except ValueError: pass
    else: raise AssertionError("accepted corrupt markers")
`, [sites]);
    assert.equal(readFileSync(file, "utf8"), sites);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("domain additions preserve existing authentication settings and are idempotent", pyOptions, () => {
  runPython(`from lifecycle import sync_cookies
config = "session:\\n  secret: keep-this-value\\n  cookies:\\n    - domain: old.example.com\\n      authelia_url: https://old.example.com/authelia/\\n  expiration: 1h\\n\\nstorage:\\n  encryption_key: preserved\\n"
result = sync_cookies(config, ["new.example.com:8443"], True)
assert "domain: old.example.com" in result
assert "domain: new.example.com" in result
assert "https://new.example.com:8443/authelia/" in result
assert "  expiration: 1h" in result and "encryption_key: preserved" in result
assert sync_cookies(result, ["new.example.com:8443"], True) == result
try: sync_cookies(config, ["new.example.com:443"], False)
except ValueError: pass
else: raise AssertionError("external auth config was accepted without domain coverage")
assert sync_cookies(config, ["sub.old.example.com:443"], False, ["https://old.example.com/authelia/"]) == config
`);
});

test("npm tool directory discovery rejects unsafe, writable and non-root path chains", pyOptions, () => {
  runPython(`from runtime_paths import resolve_tools_bin, trusted_tools_bin, require_root_owned
from pathlib import Path
from types import SimpleNamespace
import stat
def safe(path): return SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | 0o755)
expected = str(Path("/opt/custom-npm/bin").resolve())
assert resolve_tools_bin(prefix_fn=lambda: "/opt/custom-npm", stat_fn=safe) == expected
assert resolve_tools_bin("/opt/custom-npm/bin", prefix_fn=lambda: (_ for _ in ()).throw(AssertionError("npm should not run")), stat_fn=safe) == expected
for invalid in ("relative/bin", "/opt/custom tools/bin", "/opt/custom:tools/bin", "/opt/tools/not-bin"):
    try: trusted_tools_bin(invalid, stat_fn=safe)
    except ValueError: pass
    else: raise AssertionError("unsafe tools path accepted")
for uid, mode in ((1000, 0o755), (0, 0o775), (0, 0o777), (0, 0o1777)):
    def unsafe(path):
        return SimpleNamespace(st_uid=uid, st_mode=stat.S_IFDIR | mode) if path.name == "custom-npm" else safe(path)
    try: trusted_tools_bin("/opt/custom-npm/bin", stat_fn=unsafe)
    except ValueError: pass
    else: raise AssertionError("untrusted directory ancestor accepted")
def missing(path):
    if path.name == "bin": raise FileNotFoundError()
    return safe(path)
assert trusted_tools_bin("/opt/custom-npm/bin", allow_missing=True, stat_fn=missing) == expected
try: trusted_tools_bin("/opt/custom-npm/bin", stat_fn=missing)
except ValueError: pass
else: raise AssertionError("missing installed bin accepted")
for uid, mode in ((1000, 0o755), (0, 0o775), (0, 0o666)):
    try: require_root_owned(Path("/opt/tool.js"), lambda path: SimpleNamespace(st_uid=uid, st_mode=stat.S_IFREG | mode), directory=False)
    except ValueError: pass
    else: raise AssertionError("untrusted executable target accepted")
`);
});

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "deploy-command-fixture-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const command = (name, text) => {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/usr/bin/env bash\n${text}\n`);
    chmodSync(file, 0o755);
  };
  return { dir, command, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_LOG: path.join(dir, "calls") } };
}

test("public edge verification rejects missing auth, 502 and transport failure without writes", shOptions, () => {
  const f = fixture();
  try {
    f.command("curl", 'if [ "${FIXTURE_CODE}" = transport ]; then exit 7; fi\nprintf "HTTP/1.1 %s Test\\r\\nLocation: https://edge.example.com/authelia/\\r\\n\\r\\n\\n%s" "$FIXTURE_CODE" "$FIXTURE_CODE"');
    for (const [code, success] of [["302", true], ["401", true], ["200", false], ["502", false], ["transport", false]]) {
      const result = spawnSync("bash", [path.join(deploy, "verify-login.sh")], {
        encoding: "utf8", timeout: 10000, env: { ...f.env, EDGE_URL: "https://edge.example.com", FIXTURE_CODE: code },
      });
      assert.equal(result.status === 0, success, `${code}: ${result.stdout}\n${result.stderr}`);
    }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("server verification asserts SPA content and never starts production turns by default", shOptions, () => {
  const f = fixture();
  try {
    f.command("curl", 'printf "curl %s\\n" "$*" >> "$FIXTURE_LOG"\ncase "$*" in *healthz*) printf \'{"ok":true,"codexState":"ready"}\' ;; *) read -r header; [ "$header" = "Authorization: Bearer fixture-private-token" ] || exit 22; printf "%s" "$FIXTURE_SPA" ;; esac');
    f.command("node", 'printf "%s\\n" "$*" >> "$FIXTURE_LOG"');
    const run = (html) => spawnSync("bash", [path.join(deploy, "verify-server.sh")], {
      encoding: "utf8", timeout: 10000, env: { ...f.env, GATEWAY_TOKEN: "fixture-private-token", HARNESS_ALLOW_PAID_TESTS: "0", EDGE_URL: "", FIXTURE_SPA: html },
    });
    assert.equal(run('<html><div id="root"></div></html>').status, 0);
    const calls = readFileSync(f.env.FIXTURE_LOG, "utf8");
    assert.ok(calls.includes("verify-ws.mjs") && calls.includes("verify-threads.mjs"));
    assert.ok(!calls.includes("verify-full.mjs") && !calls.includes("verify-mcp-tools.mjs"));
    assert.ok(!calls.includes("fixture-private-token"), "bootstrap credential leaked into curl argv");
    assert.notEqual(run("not an app").status, 0);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("service registration binds custom instance identity and immutable CLI without real system writes", shOptions, () => {
  const f = fixture();
  try {
    f.command("id", 'case "$1" in -u) if [ "$#" -eq 1 ]; then echo 0; else echo 1000; fi ;; -gn) echo fixture ;; *) echo fixture ;; esac');
    f.command("getent", 'echo "fixture:x:1000:1000::/var/lib/fixture:/usr/sbin/nologin"');
    f.command("runuser", 'exit 0');
    f.command("visudo", 'exit 0');
    // The permission decision is exercised above. Relocate this filesystem
    // boundary so the integration fixture never needs a root-owned /opt tree.
    f.command("python3", 'case "$1" in */runtime_paths.py) [ "${FIXTURE_BAD_TOOLS:-0}" != 1 ] || exit 73; printf "%s\\n" "$FIXTURE_TOOLS_BIN" ;; *) exit 91 ;; esac');
    f.command("install", 'printf "install %s\\n" "$*" >> "$FIXTURE_LOG"\n[ "$1" != -d ] || exit 0\nargs=("$@"); count=${#args[@]}; target=${args[count-1]}; source=${args[count-2]}; mkdir -p "$FIXTURE_CAPTURE$(dirname "$target")"; cp "$source" "$FIXTURE_CAPTURE$target"');
    const service = `codex-fixture-${process.pid}`;
    const cli = "/usr/local/lib/codex-harness/codex/0.149.0/node_modules/.bin/codex";
    // register-service copies only this helper from the source tree.
    mkdirSync(path.join(f.dir, "deploy"));
    writeFileSync(path.join(f.dir, "deploy", "privileged-helper.sh"), "fixture helper\n");
    const toolsBin = path.join(f.dir, "custom-npm", "bin");
    const nodePath = path.join(f.dir, "private-node", "bin", "node");
    mkdirSync(toolsBin, { recursive: true });
    mkdirSync(path.dirname(nodePath), { recursive: true });
    writeFileSync(nodePath, "#!/bin/sh\nexit 97\n");
    chmodSync(nodePath, 0o755);
    writeFileSync(path.join(toolsBin, "zai-mcp-server"), "#!/bin/sh\nexit 97\n");
    chmodSync(path.join(toolsBin, "zai-mcp-server"), 0o755);
    writeFileSync(path.join(f.dir, "deploy", "manage.sh"), 'printf "%s\\n" "$TOOLS_BIN_DIR" "$NODE_BIN" "$PATH"; command -v zai-mcp-server\n');
    const capture = path.join(f.dir, "capture");
    const result = spawnSync("bash", [path.join(deploy, "register-service.sh")], {
      encoding: "utf8", timeout: 10000,
      env: { ...f.env, FIXTURE_CAPTURE: capture, FIXTURE_TOOLS_BIN: toolsBin, SERVICE_NAME: service, RUN_USER: "fixture", INSTALL_DIR: f.dir,
        CODEX_HOME: `${f.dir}/state`, CODEX_WORKSPACE: `${f.dir}/workspace`, ENV_FILE: `${f.dir}/state/secrets.env`, CODEX_BIN: cli,
        NODE_BIN: nodePath, PORT: "18410", BIN_DIR: "/usr/local/bin" },
    });
    assert.equal(result.status, 0, result.stderr);
    const wrapper = readFileSync(`${capture}/usr/local/bin/codex-harness-${service}`, "utf8");
    assert.ok(wrapper.includes(`export SERVICE_NAME=${service}`));
    assert.ok(wrapper.includes("export BIN_DIR=/usr/local/bin"));
    assert.ok(wrapper.includes(`export NODE_BIN=${nodePath}`));
    assert.ok(wrapper.includes(`export TOOLS_BIN_DIR=${toolsBin}`));
    assert.ok(!wrapper.includes("$PATH"), "wrapper must not persist or inherit an ambient executable search path");
    const unit = readFileSync(`${capture}/etc/systemd/system/${service}.service`, "utf8");
    assert.ok(unit.includes(`ExecStart=/usr/bin/env CODEX_BIN=${cli}`));
    assert.ok(unit.includes(`CODEX_HARNESS_ADMIN_HELPER=/usr/local/libexec/codex-harness-admin-${service}`));
    assert.ok(unit.includes(`Environment=NODE_BIN=${nodePath}\nEnvironment=TOOLS_BIN_DIR=${toolsBin}\n`));
    const unitPath = unit.match(/^Environment=PATH=(.+)$/m)[1];
    assert.ok(unitPath.includes(`:${toolsBin}:`));
    const wrapped = spawnSync("bash", [`${capture}/usr/local/bin/codex-harness-${service}`, "provider", "openai"], {
      encoding: "utf8", timeout: 10000, env: f.env,
    });
    assert.equal(wrapped.status, 0, wrapped.stderr);
    assert.equal(wrapped.stdout, `${toolsBin}\n${nodePath}\n${unitPath}\n${toolsBin}/zai-mcp-server\n`);
    const grant = readFileSync(`${capture}/etc/sudoers.d/codex-harness-${service}`, "utf8");
    assert.equal(grant, `fixture ALL=(root) NOPASSWD: /usr/local/libexec/codex-harness-admin-${service} restart-service, /usr/local/libexec/codex-harness-admin-${service} recent-logs\n`);
    assert.ok(!grant.includes("journalctl") && !grant.includes("*"), "sudo grants must not expose arbitrary journal arguments");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("privileged helper restricts journal access to one configured unit and fixed 300-line argv", shOptions, () => {
  const f = fixture();
  try {
    const service = "fixture-journal-instance";
    const configDir = path.join(f.dir, "config");
    mkdirSync(configDir);
    const config = path.join(configDir, `${service}.conf`);
    writeFileSync(config, `SERVICE_NAME=${service}\n`);
    const helper = path.join(f.dir, `codex-harness-admin-${service}`);
    // Substitute filesystem/command boundaries only: run the real dispatch and
    // owner/mode/instance/argv guards without root or writes under /etc.
    const source = readFileSync(path.join(deploy, "privileged-helper.sh"), "utf8")
      .replace("PATH=/usr/sbin:/usr/bin:/sbin:/bin", `PATH="${path.join(f.dir, "bin")}:$PATH"`)
      .replaceAll("/etc/codex-harness/", `${configDir}/`);
    writeFileSync(helper, source);
    f.command("id", 'echo "${FIXTURE_UID:-0}"');
    f.command("stat", 'case "$2" in %u) echo "${FIXTURE_OWNER:-0}" ;; %a) echo "${FIXTURE_MODE:-600}" ;; *) exit 1 ;; esac');
    f.command("journalctl", 'printf "journalctl\\n" >> "$FIXTURE_LOG"; printf "arg:%s\\n" "$@" >> "$FIXTURE_LOG"; printf "fixture journal line\\n"');
    f.command("systemctl", 'printf "systemctl\\n" >> "$FIXTURE_LOG"; printf "arg:%s\\n" "$@" >> "$FIXTURE_LOG"');
    const run = (args, env = {}) => spawnSync("bash", [helper, ...args], {
      encoding: "utf8", timeout: 10000, env: { ...f.env, GATEWAY_UNIT: "must-not-select-another-unit", ...env },
    });
    const logs = run(["recent-logs"]);
    assert.equal(logs.status, 0, logs.stderr);
    assert.equal(logs.stdout, "fixture journal line\n");
    const expectedCalls = `journalctl\narg:--unit\narg:${service}.service\narg:--lines\narg:300\narg:--no-pager\narg:--output\narg:short\n`;
    assert.equal(readFileSync(f.env.FIXTURE_LOG, "utf8"), expectedCalls);
    for (const args of [[], ["recent-logs", "--unit", "other.service"], ["recent-logs", "300"], ["restart-service", "ignored"], ["unsupported"]]) {
      assert.notEqual(run(args).status, 0, `accepted extra or unsupported arguments: ${JSON.stringify(args)}`);
    }
    for (const env of [{ FIXTURE_UID: "1000" }, { FIXTURE_OWNER: "1000" }, { FIXTURE_MODE: "644" }]) {
      assert.notEqual(run(["recent-logs"], env).status, 0, `accepted unsafe permissions: ${JSON.stringify(env)}`);
    }
    for (const content of ["SERVICE_NAME=another-instance\n", `SERVICE_NAME=${service}\nEXTRA=bad\n`, "SERVICE_NAME=-unsafe\n", "SERVICE_NAME=foo;bad\n"]) {
      writeFileSync(config, content);
      assert.notEqual(run(["recent-logs"]).status, 0, "accepted invalid or mismatched instance config");
    }
    assert.equal(readFileSync(f.env.FIXTURE_LOG, "utf8"), expectedCalls, "rejected invocation must never reach a privileged command");
    writeFileSync(config, `SERVICE_NAME=${service}\n`);
    assert.equal(run(["restart-service"]).status, 0);
    assert.equal(readFileSync(f.env.FIXTURE_LOG, "utf8"), `${expectedCalls}systemctl\narg:restart\narg:--\narg:${service}.service\n`);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("direct service registration rejects any root service UID before writing system files", shOptions, () => {
  const f = fixture();
  try {
    // The administrator is root; the requested service account also resolves
    // to UID 0, including aliases whose account name is not literally root.
    f.command("id", 'echo 0');
    f.command("install", 'printf "UNEXPECTED_WRITE\\n" >> "$FIXTURE_LOG"; exit 97');
    for (const user of ["root", "root-alias", "0"]) {
      const result = spawnSync("bash", [path.join(deploy, "register-service.sh")], {
        encoding: "utf8", timeout: 10000,
        env: { ...f.env, SERVICE_NAME: "isolated-fixture", RUN_USER: user, ALLOW_ROOT_SERVICE: "1", INSTALL_DIR: f.dir,
          CODEX_HOME: `${f.dir}/state`, CODEX_WORKSPACE: `${f.dir}/workspace`, ENV_FILE: `${f.dir}/secrets.env`, CODEX_BIN: `${f.dir}/cli` },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unprivileged RUN_USER/);
      assert.match(result.stderr, /no longer bypasses/);
      assert.ok(!existsSync(f.env.FIXTURE_LOG));
    }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("direct management recovers custom Node/tools paths for provider scripts without reading secrets", shOptions, () => {
  const f = fixture();
  try {
    const repo = path.join(f.dir, "repo");
    const unitDir = path.join(f.dir, "units");
    const home = path.join(f.dir, "home");
    const toolsBin = path.join(f.dir, "custom-npm", "bin");
    const nodeBin = path.join(f.dir, "private-node", "bin");
    for (const directory of [path.join(repo, "deploy/providers/openai"), unitDir, home, toolsBin, nodeBin]) mkdirSync(directory, { recursive: true });
    for (const executable of [path.join(toolsBin, "zai-mcp-server"), path.join(nodeBin, "node")]) {
      writeFileSync(executable, "#!/bin/sh\nexit 97\n"); chmodSync(executable, 0o755);
    }
    const source = readFileSync(path.join(deploy, "manage.sh"), "utf8").replaceAll("/etc/systemd/system/", `${unitDir}/`);
    writeFileSync(path.join(repo, "deploy/manage.sh"), source);
    writeFileSync(path.join(unitDir, "fixture-path.service"), `User=fixture\nWorkingDirectory=${repo}/apps/gateway\nEnvironment=CODEX_HOME=${home}\nEnvironment=ENV_FILE=${home}/secrets.env\nEnvironment=NODE_BIN=${nodeBin}/node\nEnvironment=TOOLS_BIN_DIR=${toolsBin}\n`);
    writeFileSync(path.join(repo, "deploy/providers/openai/setup.sh"), 'printf "%s\\n" "$TOOLS_BIN_DIR" "$PATH" > "$FIXTURE_SERVICE_ENV"\ncommand -v node >> "$FIXTURE_SERVICE_ENV"\ncommand -v zai-mcp-server >> "$FIXTURE_SERVICE_ENV"\n');
    f.command("id", 'case "$1" in -u) echo 0 ;; -un) echo operator ;; *) echo fixture ;; esac');
    f.command("getent", 'printf "fixture:x:1000:1000::%s:/usr/sbin/nologin\\n" "$FIXTURE_HOME"');
    f.command("python3", 'case "$1" in */runtime_paths.py) printf "%s\\n" "$FIXTURE_TOOLS_BIN" ;; */lifecycle.py) echo openai ;; *) exit 91 ;; esac');
    f.command("runuser", 'while [ "$1" != -- ]; do shift; done; shift; exec "$@"');
    f.command("systemctl", 'printf "systemctl %s\\n" "$*" >> "$FIXTURE_LOG"');
    const capture = path.join(f.dir, "service-env");
    const result = spawnSync("bash", [path.join(repo, "deploy/manage.sh"), "provider", "openai"], {
      encoding: "utf8", timeout: 10000,
      env: { ...f.env, NODE_BIN: "", TOOLS_BIN_DIR: "", SERVICE_NAME: "fixture-path", FIXTURE_HOME: home,
        FIXTURE_TOOLS_BIN: toolsBin, FIXTURE_SERVICE_ENV: capture },
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = readFileSync(capture, "utf8").trim().split("\n");
    assert.equal(lines[0], toolsBin);
    assert.ok(lines[1].startsWith(`${nodeBin}:${toolsBin}:`));
    assert.equal(lines[2], `${nodeBin}/node`);
    assert.equal(lines[3], `${toolsBin}/zai-mcp-server`);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("installer sandbox preflight is after state creation and fails before service registration", shOptions, () => {
  const source = readFileSync(path.join(deploy, "install.sh"), "utf8");
  const start = source.indexOf("# Validate the actual non-root sandbox");
  const end = source.indexOf('\nif [ ! -f "$ENV_FILE"', start);
  assert.ok(start > source.indexOf('ensure_service_directory "$CODEX_WORKSPACE"'));
  assert.ok(end > start && end < source.indexOf('UNIT_FILE="$EXISTING_UNIT"'));
  const f = fixture();
  try {
    writeFileSync(path.join(f.dir, "install-sandbox.sh"), 'printf "%s\\n" "$RUN_USER" "$CODEX_HOME" "$CODEX_WORKSPACE" "$CODEX_BIN" "$PATH" "$ALLOW_ROOT_SERVICE" > "$FIXTURE_LOG"\nexit "$FIXTURE_SANDBOX_STATUS"\n');
    const runner = path.join(f.dir, "preflight.sh");
    writeFileSync(runner, `set -euo pipefail\n${source.slice(start, end)}\nprintf 'registration-reached\\n'\n`);
    for (const [code, legacy] of [[0, "0"], [75, "0"], [0, "1"]]) {
      const result = spawnSync("bash", [runner], { encoding: "utf8", timeout: 10000,
        env: { ...f.env, SUDO: "", SCRIPT_DIR: f.dir, RUN_USER: "fixture", CODEX_HOME: `${f.dir}/home`,
          CODEX_WORKSPACE: `${f.dir}/workspace`, CODEX_BIN: `${f.dir}/private-cli`, ALLOW_ROOT_SERVICE: legacy, FIXTURE_SANDBOX_STATUS: String(code) } });
      assert.equal(result.status, code, result.stderr);
      assert.equal(result.stdout.includes("registration-reached"), code === 0);
      assert.equal(readFileSync(f.env.FIXTURE_LOG, "utf8"), `fixture\n${f.dir}/home\n${f.dir}/workspace\n${f.dir}/private-cli\n${f.env.PATH}\n${legacy}\n`);
    }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("update failure unwinds its real Bash transaction scope and restores artifacts and system files", shOptions, () => {
  const artifactPaths = ["node_modules", "apps/gateway/node_modules", "apps/web/node_modules", "apps/gateway/dist", "apps/web/dist"];
  const manageSource = readFileSync(path.join(deploy, "manage.sh"), "utf8");
  const start = manageSource.indexOf("do_update() {");
  const end = manageSource.indexOf("\nmenu() {", start);
  assert.ok(start >= 0 && end > start, "real update function must be available to the fixture");
  const realUpdate = manageSource.slice(start, end);
  // Keep the production function, including its local variables, nested
  // scopes, EXIT trap and errexit behavior. Only relocate its system-file
  // allowlist into the test directory; no /etc or service operations are real.
  const isolatedUpdate = realUpdate.replace(/local -a system_files=\([\s\S]*?\n      \)/, 'local -a system_files=("$FIXTURE_SYSTEM/existing" "$FIXTURE_SYSTEM/introduced")');
  assert.notEqual(isolatedUpdate, realUpdate, "system-file boundary substitution must match before executing");
  for (const scenario of [
    { failure: "register", code: 75, active: "1", rollbackFails: false },
    { failure: "register", code: 76, active: "0", rollbackFails: false },
    { failure: "health", code: 54, active: "1", rollbackFails: false },
    { failure: "typecheck", code: 53, active: "1", rollbackFails: false },
    { failure: "smoke", code: 52, active: "1", rollbackFails: false },
    { failure: "register", code: 75, active: "1", rollbackFails: true },
    { failure: "none", code: 0, active: "1", rollbackFails: false },
  ]) {
    const f = fixture();
    try {
      const repo = path.join(f.dir, "repo");
      const candidate = path.join(f.dir, "candidate");
      const system = path.join(f.dir, "system");
      const stages = path.join(f.dir, "stages");
      for (const dir of [path.join(repo, ".git"), path.join(repo, "deploy"), path.join(candidate, "deploy"), system, stages]) mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(repo, ".git", "head"), "old-ref\n");
      writeFileSync(path.join(system, "existing"), "old-system\n");
      for (const item of artifactPaths) {
        for (const [root, value] of [[repo, "old"], [candidate, "new"]]) {
          mkdirSync(path.join(root, item), { recursive: true });
          writeFileSync(path.join(root, item, "marker"), `${value}:${item}\n`);
        }
      }
      writeFileSync(path.join(candidate, "deploy", "install.sh"), 'CODEX_VERSION="0.149.0"\n');
      writeFileSync(path.join(candidate, "deploy", "install-runtime.sh"), 'printf "%s\\n" "$FIXTURE_CLI"\n');
      writeFileSync(path.join(repo, "deploy", "register-service.sh"), String.raw`set -eu
printf 'register\n' >> "$FIXTURE_LOG"
[ "$TOOLS_BIN_DIR" = /opt/fixture-tools/bin ] || exit 89
[ "$NODE_BIN" = /opt/fixture-node/bin/node ] || exit 89
[ "$(cat "$INSTALL_DIR/apps/gateway/dist/marker")" = 'new:apps/gateway/dist' ] || exit 88
printf 'new-system\n' > "$FIXTURE_SYSTEM/existing"
printf 'introduced-system\n' > "$FIXTURE_SYSTEM/introduced"
if [ "$FIXTURE_FAIL_STAGE" = register ]; then exit "$FIXTURE_FAIL_CODE"; fi
`);
      f.command("flock", "exit 0");
      f.command("git", String.raw`repo=$2
shift 2
printf 'git %s\n' "$*" >> "$FIXTURE_LOG"
case "$1" in
  fetch|status|merge-base) exit 0 ;;
  rev-parse) if [ "$2" = HEAD ]; then cat "$repo/.git/head"; else printf 'new-ref\n'; fi ;;
  --no-pager|log) printf 'fixture update\n' ;;
  worktree) if [ "$2" = add ]; then cp -a "$FIXTURE_CANDIDATE" "$4"; fi ;;
  merge) printf 'new-ref\n' > "$repo/.git/head" ;;
  reset) if [ "$FIXTURE_ROLLBACK_FAIL" = 1 ]; then exit 67; fi; printf 'old-ref\n' > "$repo/.git/head" ;;
  *) printf 'unexpected git command\n' >&2; exit 90 ;;
esac`);
      f.command("pnpm", String.raw`printf 'pnpm %s\n' "$*" >> "$FIXTURE_LOG"
if [ "$1" = "$FIXTURE_FAIL_STAGE" ]; then exit "$FIXTURE_FAIL_CODE"; fi`);
      f.command("node", String.raw`printf 'node %s\n' "$*" >> "$FIXTURE_LOG"
case "$1" in *gateway-smoke.mjs) if [ "$FIXTURE_FAIL_STAGE" = smoke ]; then exit "$FIXTURE_FAIL_CODE"; fi ;; esac`);
      f.command("systemctl", String.raw`printf 'systemctl %s\n' "$*" >> "$FIXTURE_LOG"
if [ "$1" = is-active ] && [ "$FIXTURE_ACTIVE" = 0 ]; then exit 3; fi`);
      const runner = path.join(f.dir, "run-update.sh");
      writeFileSync(runner, String.raw`set -euo pipefail
REPO_ROOT=$FIXTURE_REPO
SCRIPT_DIR=$REPO_ROOT/deploy
SERVICE_NAME=fixture-update-only
SERVICE_USER=fixture
SERVICE_HOME=$FIXTURE_REPO/home
UNIT_FILE=$FIXTURE_SYSTEM/existing
ENV_FILE=$FIXTURE_REPO/fixture.env
PORT=18499
UPDATE=yes
need_root() { :; }
assert_instance_checkout() { :; }
log() { printf '[manage] %s\n' "$*"; }
die() { printf '[manage] ERROR: %s\n' "$*" >&2; exit 1; }
health_after_update() {
  printf 'health\n' >> "$FIXTURE_LOG"
  if [ "$FIXTURE_FAIL_STAGE" = health ] && [ ! -f "$FIXTURE_HEALTH_FAILED" ]; then
    touch "$FIXTURE_HEALTH_FAILED"
    return "$FIXTURE_FAIL_CODE"
  fi
}
` + isolatedUpdate + "\n# Deliberately not in an if/|| list: failures must really unwind the function.\ndo_update\nprintf 'UPDATE_RETURNED\\n'\n");
      const result = spawnSync("bash", [runner], {
        encoding: "utf8", timeout: 10000,
        env: {
          ...f.env, FIXTURE_REPO: repo, FIXTURE_CANDIDATE: candidate, FIXTURE_SYSTEM: system, TMPDIR: stages,
          TOOLS_BIN_DIR: "/opt/fixture-tools/bin", NODE_BIN: "/opt/fixture-node/bin/node",
          FIXTURE_CLI: path.join(f.dir, "fixture-cli"), FIXTURE_HEALTH_FAILED: path.join(f.dir, "health-failed"),
          FIXTURE_FAIL_STAGE: scenario.failure, FIXTURE_FAIL_CODE: String(scenario.code),
          FIXTURE_ACTIVE: scenario.active, FIXTURE_ROLLBACK_FAIL: scenario.rollbackFails ? "1" : "0",
        },
      });
      const context = `${JSON.stringify(scenario)}\n${result.stdout}\n${result.stderr}`;
      assert.equal(result.status, scenario.code, context);
      assert.ok(!result.stderr.includes("unbound variable"), context);
      assert.equal(result.stdout.includes("UPDATE_RETURNED"), scenario.failure === "none", context);
      const calls = readFileSync(f.env.FIXTURE_LOG, "utf8");
      const publishing = ["register", "health"].includes(scenario.failure);
      const expectedArtifact = scenario.failure === "none" ? "new" : "old";
      for (const item of artifactPaths) assert.equal(readFileSync(path.join(repo, item, "marker"), "utf8"), `${expectedArtifact}:${item}\n`, context);
      assert.equal(readFileSync(path.join(system, "existing"), "utf8"), `${scenario.failure === "none" ? "new" : "old"}-system\n`, context);
      assert.equal(existsSync(path.join(system, "introduced")), scenario.failure === "none", context);
      assert.equal(readFileSync(path.join(repo, ".git", "head"), "utf8"), scenario.failure === "none" || scenario.rollbackFails ? "new-ref\n" : "old-ref\n", context);
      if (publishing) {
        assert.match(calls, /git reset --hard old-ref/, context);
        assert.match(calls, /systemctl daemon-reload/, context);
        if (scenario.active === "1") assert.match(calls, /systemctl restart fixture-update-only\nhealth/, context);
        else assert.ok(!calls.includes("systemctl restart"), context);
      } else if (scenario.failure !== "none") {
        assert.ok(!calls.includes("git merge --ff-only") && !calls.includes("systemctl stop") && !calls.includes("register\n"), context);
      }
      if (scenario.failure === "typecheck") {
        assert.ok(!calls.includes("pnpm test") && !calls.includes("pnpm build") && !calls.includes("release-audit.mjs"), context);
      }
      const remainingStages = readdirSync(stages);
      if (scenario.rollbackFails) {
        assert.equal(remainingStages.length, 1, context);
        assert.match(result.stdout, /自动恢复未完成/, context);
        const snapshot = path.join(stages, remainingStages[0], "previous");
        assert.equal(readFileSync(path.join(snapshot, "artifacts", "apps/gateway/dist/marker"), "utf8"), "old:apps/gateway/dist\n", context);
        assert.equal(readFileSync(`${snapshot}/system${system}/existing`, "utf8"), "old-system\n", context);
      } else {
        assert.deepEqual(remainingStages, [], context);
      }
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test("edge rollback follows the active provider generation and preserves newer credentials", { skip: process.platform !== "linux" || !pythonAvailable }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "deploy-provider-lock-"));
  try {
    const providers = path.join(dir, "providers");
    for (const generation of ["generation-one", "generation-two"]) mkdirSync(path.join(providers, ".versions", generation), { recursive: true });
    writeFileSync(path.join(providers, ".versions/generation-one", "secrets.env"), "API_KEY=older-fixture\nTRUSTED_HOSTS=old.example.com\nGATEWAY_HTTPS=true\n");
    writeFileSync(path.join(providers, ".versions/generation-two", "secrets.env"), "API_KEY=newer-fixture\nTRUSTED_HOSTS=new.example.com\nGATEWAY_HTTPS=true\n");
    const active = path.join(providers, ".active");
    const envFile = path.join(dir, "secrets.env");
    symlinkSync(".versions/generation-one", active, "dir");
    symlinkSync("providers/.active/secrets.env", envFile);
    const snapshot = path.join(dir, "edge-snapshot.json");
    const run = (action, value) => spawnSync(python, [path.join(deploy, "edge_env.py"), dir, envFile, action, value], {
      encoding: "utf8", timeout: 10000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    assert.equal(run("snapshot", snapshot).status, 0);
    assert.equal(run("set", "intermediate.example.com").status, 0);
    unlinkSync(active); symlinkSync(".versions/generation-two", active, "dir");
    const restored = run("restore", snapshot);
    assert.equal(restored.status, 0, restored.stderr);
    assert.ok(lstatSync(envFile).isSymbolicLink());
    assert.equal(readFileSync(envFile, "utf8"), "API_KEY=newer-fixture\nTRUSTED_HOSTS=old.example.com\nGATEWAY_HTTPS=true\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI install publishes a verified version once and leaves global CLI unchanged", shOptions, () => {
  const f = fixture();
  try {
    f.command("id", 'echo 0');
    // Substitute the root ownership boundary so this fixture also runs as
    // nobody; every remaining operation stays in the temporary runtime tree.
    f.command("install", 'test "$1" = -d; target="${@: -1}"; mkdir -p -- "$target"; chmod 755 "$target"');
    f.command("codex", 'echo global-cli-unchanged');
    f.command("npm", 'printf "npm %s\\n" "$*" >> "$FIXTURE_LOG"\nwhile [ "$#" -gt 0 ]; do case "$1" in --prefix) shift; prefix=$1 ;; @openai/codex@*) version=${1##*@} ;; esac; shift; done\nmkdir -p "$prefix/node_modules/.bin"\nprintf \'#!/usr/bin/env bash\\necho "codex-cli %s"\\n\' "$version" > "$prefix/node_modules/.bin/codex"\nchmod 755 "$prefix/node_modules/.bin/codex"');
    const base = path.join(f.dir, "runtimes");
    const run = () => spawnSync("bash", [path.join(deploy, "install-runtime.sh"), "0.149.0"], {
      encoding: "utf8", timeout: 10000, env: { ...f.env, CODEX_RUNTIME_ROOT: base },
    });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout.trim(), `${base}/0.149.0/node_modules/.bin/codex`);
    assert.equal(run().status, 0);
    assert.equal(readFileSync(f.env.FIXTURE_LOG, "utf8").trim().split("\n").length, 1);
    assert.ok(readFileSync(path.join(f.dir, "bin", "codex"), "utf8").includes("global-cli-unchanged"));
    writeFileSync(`${base}/0.149.0/node_modules/.bin/codex`, '#!/usr/bin/env bash\necho "codex-cli wrong-version"\n');
    assert.notEqual(run().status, 0, "a corrupt existing runtime must not be accepted");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
