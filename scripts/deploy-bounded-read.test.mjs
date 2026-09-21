import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const deploy = fileURLToPath(new URL("../deploy/", import.meta.url));
const python = process.env.CODEX_TEST_PYTHON || "python3";
const available = spawnSync(python, ["-c", "import tomllib"], { windowsHide: true }).status === 0;
const py = { skip: !available && "Python 3.11+ required" };

test("deployment control-file reads are regular, bounded, stable, and optionally symlink-aware", py, () => {
  const directory = mkdtempSync(path.join(tmpdir(), "harness-bounded-read-"));
  try {
    const script = String.raw`
import os,sys
from pathlib import Path
from unittest.mock import patch
from bounded_read import read_text_bounded

base=Path(sys.argv[1]); source=base/'source'; source.write_text('fixture',encoding='utf-8')
assert read_text_bounded(source,7)=='fixture'
try: read_text_bounded(source,6)
except ValueError as error: assert 'limit' in str(error)
else: raise AssertionError('oversized file accepted')
assert read_text_bounded(base/'missing',8,missing_ok=True)==''

if os.name!='nt':
    alias=base/'alias'; alias.symlink_to(source)
    try: read_text_bounded(alias,8)
    except OSError: pass
    else: raise AssertionError('unexpected final symlink accepted')
    assert read_text_bounded(alias,8,nofollow=False)=='fixture'
    fifo=base/'fifo'; os.mkfifo(fifo)
    try: read_text_bounded(fifo,8)
    except ValueError: pass
    else: raise AssertionError('non-regular control file accepted')

actual=source.stat()
changed=os.stat_result((actual.st_mode,actual.st_ino,actual.st_dev,actual.st_nlink,
                        actual.st_uid,actual.st_gid,actual.st_size,actual.st_atime,
                        actual.st_mtime+1,actual.st_ctime))
with patch('bounded_read.os.fstat',side_effect=[actual,changed]):
    try: read_text_bounded(source,8)
    except ValueError as error: assert 'changed' in str(error)
    else: raise AssertionError('mutated snapshot accepted')
`;
    const result = spawnSync(python, ["-c", script, directory], {
      cwd: deploy,
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
      env: { ...process.env, PYTHONPATH: deploy, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("edge helpers consume bounded snapshots and policy files", py, () => {
  const checks = String.raw`
from pathlib import Path
from edge_auth import MAX_AUTHELIA_CONFIGURATION_BYTES
from edge_env import MAX_EDGE_SNAPSHOT_BYTES,MAX_WORKER_PAYLOAD_BYTES,WORKER_TIMEOUT_SECONDS
from lifecycle import MAX_EDGE_CONFIG_BYTES,MAX_PROVIDER_CONFIG_BYTES
assert 0 < MAX_EDGE_SNAPSHOT_BYTES < MAX_PROVIDER_CONFIG_BYTES <= MAX_EDGE_CONFIG_BYTES
assert MAX_AUTHELIA_CONFIGURATION_BYTES == MAX_EDGE_CONFIG_BYTES
assert MAX_EDGE_SNAPSHOT_BYTES < MAX_WORKER_PAYLOAD_BYTES <= MAX_PROVIDER_CONFIG_BYTES
assert 0 < WORKER_TIMEOUT_SECONDS <= 30
`;
  const result = spawnSync(python, ["-c", checks], {
    cwd: deploy,
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
    env: { ...process.env, PYTHONPATH: deploy, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("edge text publication refuses stale and concurrently introduced path identities", py, () => {
  const directory = mkdtempSync(path.join(tmpdir(), "harness-edge-cas-"));
  try {
    const checks = String.raw`
from pathlib import Path
import sys
from lifecycle import atomic_text,file_identity
base=Path(sys.argv[1]); target=base/'Caddyfile'
atomic_text(target,'first')
expected=file_identity(target)
target.write_text('external-change',encoding='utf-8')
try: atomic_text(target,'stale-overwrite',expected)
except RuntimeError: pass
else: raise AssertionError('stale configuration was overwritten')
assert target.read_text()=='external-change'
missing=base/'new-config'; absent=file_identity(missing)
missing.write_text('concurrent',encoding='utf-8')
try: atomic_text(missing,'overwrite',absent)
except RuntimeError: pass
else: raise AssertionError('concurrently introduced file was overwritten')
assert missing.read_text()=='concurrent'
`;
    const result = spawnSync(python, ["-c", checks, directory], {
      cwd: deploy, encoding: "utf8", timeout: 10000, windowsHide: true,
      env: { ...process.env, PYTHONPATH: deploy, PYTHONDONTWRITEBYTECODE: "1" },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
