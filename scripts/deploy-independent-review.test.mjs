import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const deploy = fileURLToPath(new URL("../deploy/", import.meta.url));
const providers = path.join(deploy, "providers");
const python = process.env.CODEX_TEST_PYTHON || "python3";
const available = spawnSync(python, ["-c", "import tomllib"], { windowsHide: true }).status === 0;
const py = { skip: !available && "Python 3.11+ required" };
const linux = { skip: !available || process.platform !== "linux" ? "Linux descriptor and identity tests" : false };
const env = { ...process.env, PYTHONPATH: deploy + path.delimiter + providers, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" };
function run(code, args = []) {
  const result = spawnSync(python, ["-c", code, ...args], { env, encoding: "utf8", timeout: 15000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout;
}

test("R02 deletion rejects final/ancestor aliases and confirmation swaps, and never follows nested links", linux, () => {
  run(`import os,tempfile
from pathlib import Path
from safe_delete import prepare,delete,unlink_file
assert os.geteuid()!=0, 'run data-deletion fixtures as an unprivileged user'
with tempfile.TemporaryDirectory() as directory:
    base=Path(directory); external=base/'external'; external.mkdir()
    sentinel=external/'keep'; sentinel.write_text('retained')
    target=base/'data'; target.symlink_to(external,target_is_directory=True)
    try: prepare(str(target),'data')
    except OSError: pass
    else: raise AssertionError('final symlink accepted')
    target.unlink(); target.mkdir(); token=prepare(str(target),'data')
    target.rename(base/'old-data'); target.symlink_to(external,target_is_directory=True)
    try: delete(str(target),'data',token)
    except (OSError,ValueError): pass
    else: raise AssertionError('post-confirmation target swap accepted')
    target.unlink(); target.mkdir()
    parent=base/'parent'; parent.mkdir(); child=parent/'child'; child.mkdir()
    token=prepare(str(child),'data'); parent.rename(base/'old-parent'); parent.symlink_to(external,target_is_directory=True)
    try: delete(str(child),'data',token)
    except (OSError,ValueError): pass
    else: raise AssertionError('post-confirmation ancestor swap accepted')
    (target/'nested').symlink_to(external,target_is_directory=True)
    (target/'file').write_text('remove')
    delete(str(target),'data',prepare(str(target),'data'))
    assert not target.exists() and sentinel.read_text()=='retained'
    alias=base/'env-alias'; alias.symlink_to(sentinel)
    unlink_file(str(alias)); assert sentinel.read_text()=='retained' and not alias.is_symlink()
`);
});

test("R02 data cleanup refuses root even for apparently safe subdirectories", linux, () => {
  run(`from unittest.mock import patch
from safe_delete import prepare
with patch('os.geteuid',return_value=0):
    try: prepare('/var/lib/example-data','data')
    except ValueError as error: assert 'unprivileged' in str(error)
    else: raise AssertionError('root data cleanup accepted')
`);
});

test("R03 uninstall inventories extra projects, aliases, other instances and corrupt registries", py, () => {
  run(`import json,tempfile,os
from pathlib import Path
from lifecycle import guard_uninstall
with tempfile.TemporaryDirectory() as directory:
    base=Path(directory); tree=base/'program'; tree.mkdir(); home=base/'home'; home.mkdir(); units=base/'units'; units.mkdir()
    workspace=base/'workspace'; workspace.mkdir(); registry=home/'webui-projects.json'
    args=[str(tree),str(home),str(home/'secrets.env'),str(workspace),'current',str(units)]
    def rejected():
        try: guard_uninstall(*args)
        except (ValueError,OSError): pass
        else: raise AssertionError('unsafe uninstall accepted')
    registry.write_text(json.dumps({'projects':[{'path':str(tree/'extra-project')}]}),encoding='utf-8'); rejected()
    if os.name!='nt':
        alias=base/'program-alias'; alias.symlink_to(tree,target_is_directory=True)
        registry.write_text(json.dumps({'projects':[{'path':str(alias/'extra-project')}]}),encoding='utf-8'); rejected()
    registry.write_text('{"projects":[]}',encoding='utf-8'); assert guard_uninstall(*args)==str(tree.resolve())
    try: guard_uninstall(*args,str(tree/'control'))
    except ValueError: pass
    else: raise AssertionError('current control directory would be removed')
    other=base/'other-home'; other.mkdir(); (other/'webui-projects.json').write_text('{"projects":[]}',encoding='utf-8')
    unit=units/'other.service'
    unit.write_text('WorkingDirectory='+str(tree)+'/apps/gateway\\nEnvironment=CODEX_HOME='+str(other)+'\\nEnvironment=ENV_FILE='+str(other/'secrets.env')+'\\nEnvironment=CODEX_WORKSPACE='+str(workspace)+'\\n',encoding='utf-8'); rejected()
    unit.write_text(unit.read_text().replace(str(tree)+'/apps/gateway',str(base/'other-program')+'/apps/gateway'),encoding='utf-8')
    (other/'webui-projects.json').write_text(json.dumps({'projects':[{'path':str(tree/'other-project')}]}),encoding='utf-8'); rejected()
    (other/'webui-projects.json').write_text('{broken',encoding='utf-8'); rejected()
    unit.unlink()
    for invalid in ('{broken', '[]', '{}', '{"projects":null}', '{"projects":[{}]}'):
        registry.write_text(invalid,encoding='utf-8'); rejected()
    registry.unlink(); rejected()
`);
});

test("R12 failed Zhipu refresh preserves active generation, including a newer catalog", linux, () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "zhipu-refresh-review-"));
  try {
    const home = path.join(fixture, "home"), bin = path.join(fixture, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "curl"), "#!/bin/sh\nexit 22\n", { mode: 0o700 });
    const invoke = extra => spawnSync("bash", [path.join(providers, "zhipu-coding-plan/setup.sh")], {
      env: { ...env, PATH: bin + path.delimiter + env.PATH, CODEX_HOME: home, ENV_FILE: path.join(home, "secrets.env"),
        ZHIPU_KEY: "fixture-key", ZHIPU_MODEL: "glm-5.3", PROBE_REASONING: "0", ZHIPU_SYNC_CATALOG: "0", ...extra },
      encoding: "utf8", timeout: 30000,
    });
    const first = invoke({});
    assert.equal(first.status, 0, first.stderr + first.stdout);
    const catalogPath = path.join(home, "providers/zhipu/models.json");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    catalog.models.push({ ...catalog.models[0], slug: "newer-known-model", display_name: "newer-known-model" });
    writeFileSync(catalogPath, JSON.stringify(catalog));
    const active = realpathSync(path.join(home, "providers/.active"));
    const configBefore = readFileSync(path.join(home, "config.toml"), "utf8");
    const secretBefore = readFileSync(path.join(home, "secrets.env"), "utf8");
    const catalogBefore = readFileSync(catalogPath, "utf8");
    const failed = invoke({ ZHIPU_SYNC_CATALOG: "1", ZHIPU_KEY: "must-not-replace" });
    assert.notEqual(failed.status, 0, failed.stdout);
    assert.equal(realpathSync(path.join(home, "providers/.active")), active);
    assert.equal(readFileSync(path.join(home, "config.toml"), "utf8"), configBefore);
    assert.equal(readFileSync(path.join(home, "secrets.env"), "utf8"), secretBefore);
    assert.equal(readFileSync(catalogPath, "utf8"), catalogBefore);
    assert.ok(!failed.stdout.includes('"restartRequired":true'));
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("R01 worker environment excludes gateway credentials and fixed-runtime overrides", linux, () => {
  run(`import tempfile
from pathlib import Path
from worker_launcher import worker_environment
with tempfile.TemporaryDirectory() as directory:
    file=Path(directory)/'worker.env'
    file.write_text('GATEWAY_TOKEN=private-fixture\\nGATEWAY_CONTROL_HOME=/control\\nCODEX_HARNESS_ADMIN_HELPER=/helper\\nNODE_OPTIONS=--inspect\\nCODEX_BIN=/untrusted\\nZ_AI_API_KEY=worker-fixture\\nHTTPS_PROXY=http://proxy.example.com:8080\\n',encoding='utf-8')
    config={'RUN_HOME':'/worker','SERVICE_PATH':'/usr/bin:/bin','ENV_FILE':str(file),'CODEX_HOME':'/worker/data','CODEX_WORKSPACE':'/worker/projects','CODEX_BIN':'/fixed/codex'}
    result=worker_environment(config)
    assert result['Z_AI_API_KEY']=='worker-fixture' and result['CODEX_BIN']=='/fixed/codex'
    assert result['HTTPS_PROXY']=='http://proxy.example.com:8080'
    assert result['CODEX_HARNESS_WORKER']=='1' and result['GATEWAY_EXTERNAL_RESTART']=='1'
    for key in ('GATEWAY_TOKEN','GATEWAY_CONTROL_HOME','CODEX_HARNESS_ADMIN_HELPER','NODE_OPTIONS'):
        assert key not in result
`);
});

test("R01 server verification reads only control state and exports it to WS checks", { skip: process.platform !== "linux" }, () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "verify-control-review-"));
  try {
    const bin = path.join(fixture, "bin"), home = path.join(fixture, "home");
    const worker = path.join(fixture, "worker"), control = path.join(home, ".codex-harness-control");
    for (const directory of [bin, worker, control]) mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(worker, "gateway-token"), "worker-token-must-not-be-read-00000000\n", { mode: 0o600 });
    writeFileSync(path.join(control, "gateway-token"), "control-fixture-00000000000000000\n", { mode: 0o600 });
    writeFileSync(path.join(bin, "curl"), `#!/bin/sh
case "$*" in
  *healthz*) printf '%s\\n' '{"codexState":"ready"}' ;;
  *) IFS= read -r header; [ "$header" = 'Authorization: Bearer control-fixture-00000000000000000' ] || exit 22
     printf '%s\\n' '<div id="root"></div>' ;;
esac
`, { mode: 0o700 });
    writeFileSync(path.join(bin, "node"), `#!/bin/sh
[ "$GATEWAY_CONTROL_HOME" = "$EXPECTED_CONTROL_HOME" ] || exit 18
case "$1" in
  *ws-token.mjs) [ -n "$GATEWAY_TOKEN" ] || [ -r "$GATEWAY_CONTROL_HOME/gateway-token" ] ;;
esac
`, { mode: 0o700 });
    const invoke = extra => spawnSync("bash", [path.join(deploy, "verify-server.sh")], {
      env: { ...env, PATH: bin + path.delimiter + env.PATH, HOME: home, CODEX_HOME: worker,
        SERVICE_NAME: "codex-harness-verification-test-no-unit", GATEWAY_CONTROL_HOME: "", GATEWAY_TOKEN: "",
        EXPECTED_CONTROL_HOME: control, HARNESS_ALLOW_PAID_TESTS: "0", EDGE_URL: "", ...extra },
      encoding: "utf8", timeout: 15000,
    });
    for (const extra of [{}, { GATEWAY_CONTROL_HOME: control }]) {
      const result = invoke(extra);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.match(result.stdout, /ALL SERVER CHECKS PASSED/);
    }
    rmSync(path.join(control, "gateway-token"));
    const missing = invoke({});
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /no readable control-plane token/);
    assert.doesNotMatch(missing.stdout + missing.stderr, /worker-token-must-not-be-read/);
    const explicitToken = invoke({ GATEWAY_TOKEN: "control-fixture-00000000000000000" });
    assert.equal(explicitToken.status, 0, explicitToken.stderr + explicitToken.stdout);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
