import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const deploy = fileURLToPath(new URL("../deploy/", import.meta.url));
const python = process.env.CODEX_TEST_PYTHON || "python3";
const linux = { skip: process.platform !== "linux" && "Linux deployment semantics required" };

test("updater's actual trusted bundle passes the real registration entry before stopping service", linux, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "registration-bundle-"));
  try {
    const manage = readFileSync(path.join(deploy, "manage.sh"), "utf8");
    const copies = [...manage.matchAll(/install -o root -g root -m \d+ "\$SCRIPT_DIR\/([\w.-]+)" "\$trusted_apply\/\1"/g)];
    assert.ok(copies.length > 0);
    for (const [, name] of copies) copyFileSync(path.join(deploy, name), path.join(dir, name));
    const check = 'bash "$trusted_apply/register-service.sh" --check-dependencies';
    assert.ok(manage.indexOf(check) > manage.indexOf(copies.at(-1)[0]));
    assert.ok(manage.indexOf(check) < manage.indexOf("      applying=1"));
    const invoke = () => spawnSync("bash", [path.join(dir, "register-service.sh"), "--check-dependencies"], {
      encoding: "utf8", timeout: 10000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    let result = invoke();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(existsSync(path.join(dir, "__pycache__")), false);
    for (const name of ["service_registration.py", "trusted_paths.py", "runtime_paths.py", "update_candidate.py"]) {
      renameSync(path.join(dir, name), path.join(dir, `${name}.held`));
      try {
        result = invoke();
        assert.notEqual(result.status, 0, `missing ${name} unexpectedly passed`);
        assert.match(result.stderr, /ModuleNotFoundError/);
      } finally { renameSync(path.join(dir, `${name}.held`), path.join(dir, name)); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("uninstall permits exact systemd masks but preserves failures for unknown aliases and replaced masks", linux, () => {
  const result = spawnSync(python, ["-c", String.raw`
import os,tempfile
from pathlib import Path
from unittest.mock import patch
import lifecycle
with tempfile.TemporaryDirectory() as directory:
    base=Path(directory); tree=base/'program'; tree.mkdir(); home=base/'home'; home.mkdir(); units=base/'units'; units.mkdir()
    (home/'webui-projects.json').write_text('{"projects":[]}')
    args=[str(tree),str(home),str(home/'secrets.env'),str(base/'workspace'),'current',str(units)]
    ordinary=units/'ordinary.service'; ordinary.write_text('[Service]\nExecStart=/usr/bin/true\n')
    assert lifecycle.guard_uninstall(*args)==str(tree)
    mask=units/'unrelated.service'; mask.symlink_to('/dev/null')
    real_identity=lifecycle.file_identity
    def owned(path):
        value=real_identity(path)
        return (*value[:3],0,*value[4:]) if Path(path)==mask and value else value
    # The suite is deliberately unprivileged; model only the mask's root UID.
    with patch.object(lifecycle,'file_identity',side_effect=owned):
        assert lifecycle.guard_uninstall(*args)==str(tree)
    def rejected():
        try: lifecycle.guard_uninstall(*args)
        except (ValueError,OSError,RuntimeError): pass
        else: raise AssertionError('unknown or unsafe unit was ignored')
    def unowned(path):
        value=real_identity(path)
        return (*value[:3],10001,*value[4:]) if Path(path)==mask and value else value
    with patch.object(lifecycle,'file_identity',side_effect=unowned): rejected()
    for target in ('/dev/zero',str(base/'missing')):
        mask.unlink(); mask.symlink_to(target)
        with patch.object(lifecycle,'file_identity',side_effect=owned): rejected()
    mask.unlink(); os.mkfifo(mask,0o600); rejected(); mask.unlink()
    mask.symlink_to('/dev/null')
    real_readlink=os.readlink
    def replace_after_read(path,*args,**kwargs):
        value=real_readlink(path,*args,**kwargs)
        if Path(path)==mask:
            mask.unlink(); mask.write_text('WorkingDirectory='+str(tree)+'/apps/gateway\n')
        return value
    with patch.object(lifecycle,'file_identity',side_effect=owned), patch.object(lifecycle.os,'readlink',side_effect=replace_after_read):
        rejected()
    # Ordinary unit symlinks still participate in the retention inventory.
    mask.unlink(); mask.symlink_to(ordinary)
    with patch.object(lifecycle,'file_identity',side_effect=owned):
        assert lifecycle.guard_uninstall(*args)==str(tree)
`], {
    encoding: "utf8", timeout: 10000,
    env: { ...process.env, PYTHONPATH: deploy, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
