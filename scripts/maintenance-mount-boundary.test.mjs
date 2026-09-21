import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const deploy = fileURLToPath(new URL("../deploy/", import.meta.url));
const python = process.env.CODEX_TEST_PYTHON || "python3";
const available = spawnSync(python, ["-c", "import tomllib"], { windowsHide: true, timeout: 10000 }).status === 0;
function run(code) {
  const result = spawnSync(python, ["-c", code], { encoding: "utf8", timeout: 15000, windowsHide: true,
    env: { ...process.env, PYTHONPATH: deploy, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" } });
  assert.equal(result.status, 0, result.stderr + result.stdout);
}

test("cleanup mount identity is mandatory and read from the pinned descriptor", { skip: !available }, () => {
  run(`from unittest.mock import mock_open,patch
from safe_delete import mount_id
with patch('builtins.open',mock_open(read_data='pos: 0\\nflags: 0100000\\nmnt_id: 42\\n')) as opened:
    assert mount_id(7)==42
    opened.assert_called_once_with('/proc/self/fdinfo/7',encoding='ascii')
for malformed in ('pos: 0\\n', 'mnt_id: unknown\\n', 'mnt_id: -1\\n'):
    with patch('builtins.open',mock_open(read_data=malformed)):
        try: mount_id(7)
        except ValueError: pass
        else: raise AssertionError('missing mount identity silently accepted')
`);
});

test("cleanup rejects same-device child mounts, target mounts and changed mount confirmation", {
  skip: !available || process.platform !== "linux" ? "Linux descriptor fixtures required" : false,
}, () => {
  // No mount syscall or elevated identity: synthetic fd mount IDs exercise
  // the boundary while the directories themselves are ordinary temp fixtures.
  run(`import json,os,tempfile
from pathlib import Path
from unittest.mock import patch
import safe_delete as cleanup
assert os.geteuid()!=0, 'run maintenance fixtures as an unprivileged account'
with tempfile.TemporaryDirectory() as directory:
    base=Path(directory); target=base/'data'; target.mkdir()
    child=target/'mounted'; child.mkdir(); sentinel=child/'keep'; sentinel.write_text('retained')
    token=cleanup.prepare(str(target),'data')
    child_inode=child.stat().st_ino
    native_mount=cleanup.mount_id
    def child_mount(fd):
        current=native_mount(fd)
        return current+100000 if os.fstat(fd).st_ino==child_inode else current
    with patch.object(cleanup,'mount_id',child_mount):
        try: cleanup.delete(str(target),'data',token)
        except ValueError as error: assert 'mounted' in str(error)
        else: raise AssertionError('same-device child mount traversed')
    assert sentinel.read_text()=='retained'
    target_inode=target.stat().st_ino
    def target_mount(fd):
        current=native_mount(fd)
        return current+100000 if os.fstat(fd).st_ino==target_inode else current
    with patch.object(cleanup,'mount_id',target_mount):
        for action in (lambda:cleanup.prepare(str(target),'data'),lambda:cleanup.delete(str(target),'data',token)):
            try: action()
            except ValueError as error: assert 'mount point' in str(error)
            else: raise AssertionError('target mount accepted')
    assert sentinel.read_text()=='retained'
    for expected in (json.dumps([row[:2] for row in json.loads(token)]),
                     json.dumps([[*row[:2],row[2]+100000] for row in json.loads(token)])):
        try: cleanup.delete(str(target),'data',expected)
        except ValueError as error: assert 'after confirmation' in str(error)
        else: raise AssertionError('unverified mount confirmation accepted')
    assert sentinel.read_text()=='retained'
    # Ordinary recursive deletion remains supported without extra privileges.
    cleanup.delete(str(target),'data',cleanup.prepare(str(target),'data'))
    assert not target.exists()
`);
});

test("cleanup preflights entry and depth budgets before removing any data", {
  skip: !available || process.platform !== "linux" ? "Linux descriptor fixtures required" : false,
}, () => {
  run(`import os,tempfile
from pathlib import Path
from unittest.mock import patch
import safe_delete as cleanup
assert os.geteuid()!=0, 'run maintenance fixtures as an unprivileged account'
with tempfile.TemporaryDirectory() as directory:
    target=Path(directory)/'data'; target.mkdir()
    one=target/'one'; two=target/'two'; one.write_text('one'); two.write_text('two')
    token=cleanup.prepare(str(target),'data')
    with patch.object(cleanup,'MAX_DELETE_ENTRIES',1):
        try: cleanup.delete(str(target),'data',token)
        except ValueError as error: assert 'entry limit' in str(error)
        else: raise AssertionError('oversized cleanup tree accepted')
    assert one.read_text()=='one' and two.read_text()=='two'
    one.unlink(); two.unlink(); child=target/'child'; child.mkdir(); grandchild=child/'grandchild'; grandchild.mkdir(); sentinel=grandchild/'keep'; sentinel.write_text('retained')
    token=cleanup.prepare(str(target),'data')
    with patch.object(cleanup,'MAX_DELETE_DEPTH',1):
        try: cleanup.delete(str(target),'data',token)
        except ValueError as error: assert 'depth limit' in str(error)
        else: raise AssertionError('over-deep cleanup tree accepted')
    assert sentinel.read_text()=='retained'
`);
});
