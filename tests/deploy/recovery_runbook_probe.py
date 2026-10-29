"""Execute RECOVERY.md file-operation blocks only inside a private mount fixture.

Not an automatically collected test: host service/account operations are replaced,
while the documented tar, cp, ownership, SQLite and recovery-file work is real.
"""
from __future__ import annotations

import contextlib
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import types
from unittest.mock import patch


MOUNTS = ("/etc", "/opt/codex-harness", "/var/lib/codex-harness-instances",
          "/var/cache/codex-harness", "/usr/lib/codex-harness")


def namespace_guard() -> Path:
    assert sys.platform == "linux" and os.geteuid() == 0
    assert os.readlink("/proc/self/ns/mnt") != os.readlink("/proc/1/ns/mnt"), "Never execute against the host mount namespace"
    mounts = {line.split()[4]: line.split(" - ", 1)[1].split()[0]
              for line in Path("/proc/self/mountinfo").read_text().splitlines()}
    assert all(mounts.get(path) == "tmpfs" for path in MOUNTS), "Every managed root must be a disposable tmpfs mount"
    base = Path(os.environ["RUNBOOK_PROBE_ROOT"]).resolve()
    assert base.parent == Path("/var/lib") and re.fullmatch(r"crtest-recovery-runbook-[0-9a-f]{12}", base.name)
    assert Path("/etc/.harness-recovery-test-namespace").read_text().strip() == base.name
    return base


BASE = namespace_guard()
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from deploy.common import DeployError, Layout, atomic_write, digest, mkdir, read_json, write_json
from deploy.manager import Manager
from deploy.ownership import ROLES
from deploy.safe_fs import inspect_tree
from deploy.service_lifecycle import read_record, uninstall_services
from deploy.units import render_edge_units, render_units, sudo_rule


DOCUMENT = Path(__file__).resolve().parents[2] / "deploy/RECOVERY.md"
TEXT = DOCUMENT.read_text(encoding="utf-8")
BLOCKS = re.findall(r"python3 -B - <<'PY'\n(.*?)\nPY", TEXT, re.S)
assert len(BLOCKS) == 2, "Expected the exact backup and restore runbook blocks"
TAR_CREATE = re.search(r"^tar --create .*?(?=^\(cd )", TEXT, re.M | re.S).group().replace("\\\n", " ")
TAR_EXTRACT = re.search(r"^   tar --extract .*?--sparse", TEXT, re.M | re.S).group().replace("\\\n", " ").strip()


class FixtureSystem:
    current = None

    def __new__(cls):
        return cls.current

    def state(self, unit):
        active = unit in self.active
        return {"LoadState": "loaded" if (self.layout.units / unit).exists() else "not-found",
                "ActiveState": "active" if active else "inactive", "SubState": "running" if active else "dead",
                "MainPID": "123" if active else "0", "ControlPID": "0", "stopped": not active}

    def stop(self, units):
        self.events.append("simulated-stop")
        self.active.difference_update(units)

    def reload(self):
        self.events.append("simulated-reload")

    def start(self, units):
        raise AssertionError("Runbook must not start services")

    def enable(self, units):
        raise AssertionError("Runbook must not enable services")

    def instance_units(self, layout):
        return [layout.unit(role) for role in ROLES]

    def no_instance_processes(self, layout, config):
        assert not self.active
        self.events.append("simulated-process-check")


IDENTITIES = {"gateway": {"uid": 22001, "gid": 22001}, "worker": {"uid": 22002, "gid": 22002}}
ORIGINAL_INIT = Manager.__init__


def fixture_manager_init(self, layout, system=None, worker_gid=None):
    ORIGINAL_INIT(self, layout, system or FixtureSystem.current, worker_gid=22002)


def command_stub(argv, **kwargs):
    system = FixtureSystem.current
    if "is-enabled" in argv:
        enabled = argv[-1] in system.enabled
        return types.SimpleNamespace(stdout="enabled\n" if enabled else "disabled\n", returncode=0 if enabled else 1)
    if "disable" in argv:
        system.enabled.difference_update(argv[2:])
        for unit in argv[2:]:
            (system.layout.units / "multi-user.target.wants" / unit).unlink(missing_ok=True)
    assert argv[0] in ("/usr/bin/systemctl", "/usr/sbin/visudo")
    system.events.append("simulated-" + argv[1])
    return types.SimpleNamespace(stdout="", returncode=0)


def retained_file(path: Path, content: bytes, *, mode=0o600, uid=22002, gid=22002):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    os.chmod(path, mode)
    os.chown(path, uid, gid)


def data_inventory(layout):
    selected = [layout.state / "worker/retained.txt", layout.state / "worker/executable",
                layout.state / "worker/relative-link", layout.state / "gateway/auth.sqlite",
                layout.state / "gateway/auth.sqlite-wal", layout.state / "gateway/auth.sqlite-shm"]
    result = {}
    for path in selected:
        info = path.lstat()
        result[str(path.relative_to(layout.state))] = {"uid": info.st_uid, "gid": info.st_gid, "mode": info.st_mode & 0o777,
            "target": os.readlink(path) if path.is_symlink() else None,
            "sha256": None if path.is_symlink() else hashlib.sha256(path.read_bytes()).hexdigest()}
    return result


def setup_case(name):
    layout = Layout("runbook-" + name)
    case = BASE / ("case-" + name)
    case.mkdir(mode=0o700)
    for path in (layout.app / "releases", layout.config, layout.state / "transactions", layout.control,
                 layout.work, layout.units, Path("/etc/sudoers.d"), Path("/etc/codex")):
        mkdir(path)
    config = {"origin": "http://127.0.0.1:23300", "port": 23300, "codexRelative": "vendor/fixture/codex",
              "gatewayUid": 22001, "gatewayGid": 22001, "workerUid": 22002, "workerGid": 22002,
              "supervisorUid": 22003, "supervisorGid": 22003, "buildUid": 22004, "buildGid": 22004}
    write_json(layout.config / "instance.json", config)
    atomic_write(layout.config / "gateway-token", b"synthetic-private-fixture-token", mode=0o640, gid=22001)
    atomic_write(layout.config / "management.lock", b"")
    atomic_write(layout.control / "manage", b"#!/bin/sh\nexit 0\n", 0o755)
    atomic_write(layout.control / "native-launch", b"#!/bin/sh\nexit 0\n", 0o755)
    candidate = layout.app / ".fixture-release"
    mkdir(candidate)
    atomic_write(candidate / "payload", b"immutable synthetic release", 0o644)
    manifest = inspect_tree(candidate, root_owned=True)
    release = digest(manifest)
    os.rename(candidate, layout.app / "releases" / release)
    mkdir(layout.config / "manifests")
    write_json(layout.config / "manifests" / (release + ".json"), manifest)
    (layout.app / "current").symlink_to("releases/" + release)
    write_json(layout.config / "installation.json", {"format": 1, "phase": "complete", "release": release})
    retained_file(layout.state / "worker/retained.txt", b"original native state\n")
    retained_file(layout.state / "worker/executable", b"#!/bin/sh\nexit 0\n", mode=0o750)
    (layout.state / "worker/relative-link").symlink_to("retained.txt")
    os.lchown(layout.state / "worker/relative-link", 22002, 22002)
    database = case / "source.sqlite"
    connection = sqlite3.connect(database)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA wal_autocheckpoint=0")
    connection.execute("CREATE TABLE fixture(value TEXT)")
    connection.execute("INSERT INTO fixture VALUES ('retained sqlite value')")
    connection.commit()
    for suffix in ("", "-wal", "-shm"):
        retained_file(layout.state / ("gateway/auth.sqlite" + suffix), Path(str(database) + suffix).read_bytes(), uid=22001, gid=22001)
    connection.close()
    (Path("/etc/codex") / "config.toml").write_text("# isolated host policy\n")
    for filename, content in {**render_units(layout, config, config["codexRelative"]),
                              **render_edge_units(layout, builtin=True)}.items():
        atomic_write(layout.units / filename, content.encode(), 0o644)
    atomic_write(Path("/etc/sudoers.d") / ("codex-harness-" + layout.instance), sudo_rule(layout).encode(), 0o440)
    system = object.__new__(FixtureSystem)
    system.layout, system.events = layout, []
    system.active = {layout.unit(role) for role in ("worker", "gateway", "caddy")}
    system.enabled = {layout.unit(role) for role in ("worker", "gateway")}
    for unit in system.enabled:
        target = layout.units / "multi-user.target.wants" / unit
        target.parent.mkdir(exist_ok=True)
        target.symlink_to("../" + unit)
    FixtureSystem.current = system
    uninstall_services(Manager(layout, system))
    assert read_record(layout)[1]["phase"] == "removed"
    return layout, case, system


def assert_disabled(layout):
    assert all(not (layout.units / layout.unit(role)).exists() for role in ROLES)
    assert all((layout.units / (layout.unit(role) + ".d") / "93-codex-harness-service-lifecycle.conf").is_file() for role in ROLES)
    assert not FixtureSystem.current.active


def execute(block):
    with contextlib.redirect_stdout(io.StringIO()):
        exec(compile(block, str(DOCUMENT), "exec"), {"__name__": "__runbook__"})


def run_case(name):
    layout, case, system = setup_case(name)
    backup, stage = case / "backup", case / "stage"
    backup.mkdir(mode=0o700)
    stage.mkdir(mode=0o700)
    os.environ.update(INSTANCE=layout.instance, BACKUP=str(backup), STAGE=str(stage))
    descriptor = os.open(layout.config / "management.lock", os.O_RDWR)
    os.dup2(descriptor, 9)
    if descriptor != 9: os.close(descriptor)
    fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
    inode = (os.fstat(9).st_dev, os.fstat(9).st_ino)
    initial = data_inventory(layout)
    external = layout.units / "codex-harness-unrelated-gateway.service"
    external.write_text("unrelated service sentinel\n")
    external_hash = hashlib.sha256(external.read_bytes()).hexdigest()
    execute(BLOCKS[0])
    subprocess.run(["/bin/bash", "-euc", TAR_CREATE], check=True, capture_output=True)
    subprocess.run(["/bin/bash", "-euc", TAR_EXTRACT], check=True, capture_output=True)
    retained_file(layout.state / "worker/retained.txt", b"state changed after snapshot\n", mode=0o644, uid=0, gid=0)
    retained_file(layout.state / "worker/executable", b"changed executable", mode=0o600, uid=0, gid=0)
    (layout.state / "worker/relative-link").unlink()
    (layout.state / "worker/relative-link").symlink_to("changed-target")
    for suffix in ("", "-wal", "-shm"):
        retained_file(layout.state / ("gateway/auth.sqlite" + suffix), b"changed database bytes", mode=0o644, uid=0, gid=0)
    changed = data_inventory(layout)
    renames, original_rename = [], os.rename
    original_run = subprocess.run
    def rename(source, target, *args, **kwargs):
        renames.append((str(source), str(target)))
        original_rename(source, target, *args, **kwargs)
        if name == "renamefail" and Path(source).parent == layout.config:
            raise OSError("Injected interruption after durable intent and actual config rename")
    def command(argv, *args, **kwargs):
        if name == "copyfail" and argv[0] == "cp":
            destination = Path(argv[-1])
            destination.write_bytes(b"partial copied bytes")
            raise subprocess.CalledProcessError(91, argv)
        return original_run(argv, *args, **kwargs)
    if name == "identity":
        value = read_json(backup / "snapshot.json")
        value["identities"]["gateway"]["uid"] += 1
        write_json(backup / "snapshot.json", value)
    if name == "hostpolicy":
        Path("/etc/codex/config.toml").write_text("# different live host policy\n")
    failure = None
    try:
        with patch("os.rename", side_effect=rename), patch("subprocess.run", side_effect=command):
            execute(BLOCKS[1])
    except (DeployError, OSError, subprocess.CalledProcessError) as error:
        failure = type(error).__name__
    checkpoints = list(backup.glob("restore-progress-*.json"))
    assert (os.stat(layout.config / "management.lock").st_dev, os.stat(layout.config / "management.lock").st_ino) == inode
    assert_disabled(layout)
    assert hashlib.sha256(external.read_bytes()).hexdigest() == external_hash
    result = {"case": name, "passed": True, "lockInodePreserved": True, "serviceDefinitionsAbsent": True,
              "unrelatedServiceUnchanged": True, "renames": len(renames), "failure": failure}
    if name == "success":
        assert failure is None
        assert data_inventory(layout) == initial
        assert len(checkpoints) == 1 and read_json(checkpoints[0])["phase"] == "verified"
        assert all(action["state"] == "completed" for action in read_json(checkpoints[0])["operations"])
        connection = sqlite3.connect(layout.state / "gateway/auth.sqlite")
        assert connection.execute("SELECT value FROM fixture").fetchall() == [("retained sqlite value",)]
        connection.close()
        result.update(bytesUidGidModesSymlinkPreserved=True, sqliteAndWalReopened=True)
    elif name in ("identity", "hostpolicy"):
        assert failure == "DeployError" and not renames and not checkpoints
        assert data_inventory(layout) == changed
        result["rejectedBeforeRename"] = True
    else:
        assert failure is not None and len(checkpoints) == 1
        progress = read_json(checkpoints[0])
        assert progress["phase"] == "copying" and progress["operations"][-1]["state"] == "planned"
        pending = progress["operations"][-1]
        assert Path(pending["target"]).exists()
        assert any(path.is_dir() for path in layout.config.parent.glob('.' + layout.instance + '.before-restore-*'))
        result["pendingActionAndQuarantineRetained"] = True
    fcntl.flock(9, fcntl.LOCK_UN)
    os.close(9)
    return result


def main():
    evidence = {"documentSha256": hashlib.sha256(DOCUMENT.read_bytes()).hexdigest(),
                "probeSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                "scope": "Exact runbook Python blocks plus GNU tar/cp in private tmpfs mount namespace",
                "substitutions": ["systemd service/cgroup/process operations", "synthetic service account identity lookup"],
                "notEstablished": ["real systemd boot or lifecycle behavior", "public HTTPS", "real instance disaster recovery"],
                "cases": []}
    with contextlib.ExitStack() as stack:
        stack.enter_context(patch("deploy.control_update.ControlSystem", FixtureSystem))
        stack.enter_context(patch("deploy.service_lifecycle.identity_state", return_value=IDENTITIES))
        stack.enter_context(patch("deploy.service_lifecycle.run", side_effect=command_stub))
        stack.enter_context(patch("deploy.system.run", side_effect=AssertionError("Host system command forbidden")))
        stack.enter_context(patch.object(Manager, "__init__", fixture_manager_init))
        for name in ("success", "identity", "hostpolicy", "renamefail", "copyfail"):
            evidence["cases"].append(run_case(name))
    write_json(BASE / "result.json", evidence)
    print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    main()
