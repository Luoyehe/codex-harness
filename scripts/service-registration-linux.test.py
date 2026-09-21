"""Linux fault-injection tests for deploy/service_registration.py."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import shutil
import stat
import tempfile
import unittest


REPO = Path(__file__).resolve().parents[1]
MODULE_PATH = REPO / "deploy" / "service_registration.py"
SPEC = importlib.util.spec_from_file_location("service_registration", MODULE_PATH)
registration = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(registration)


class InjectedFailure(RuntimeError):
    pass


class RegistrationFixture:
    def __init__(self):
        self.root = Path(tempfile.mkdtemp(prefix="codex-harness-registration-"))
        self.root.chmod(0o700)
        self.uid = os.geteuid()
        self.gid = os.getegid()
        self.gateway_uid = 65534 if self.uid == 0 else self.uid
        self.gateway_gid = 65534 if self.uid == 0 else self.gid
        self.policy = registration.Policy(
            anchor=str(self.root), trust_uid=self.uid, trust_gid=self.gid,
            recovery_root=str(self.root / "recovery"), enforce_system_layout=False,
        )
        self.service = "fixture-service"
        self.bin_dir = self.root / "bin"
        self.control_home = self.root / "control" / self.service
        self.install_dir = self.root / "install"
        self.layout = registration._layout(
            self.service, str(self.bin_dir), str(self.control_home), self.gateway_uid, self.gateway_gid, self.policy,
        )
        self.transaction = Path(registration.begin(self.service, self.policy))
        self.stage = self.transaction / "stage"
        self.candidates = {
            "unit": f"[Service]\nWorkingDirectory={self.install_dir}/apps/gateway\nEnvironment=VERSION=new\n".encode(),
            "admin-helper": b"new admin helper\n",
            "worker-launcher": b"new worker launcher\n",
            "admin.conf": b"SERVICE_NAME=fixture-service\n",
            "sudoers": b"fixture ALL=(root) NOPASSWD: fixture\n",
            "command": b"#!/bin/sh\necho new\n",
            "gateway.env": b"# gateway\nTRUSTED_HOSTS=fixture\n",
        }
        for name, payload in self.candidates.items():
            target = self.stage / name
            target.write_bytes(payload)
            target.chmod(0o600)

    def ensure_target_parents(self, *, include_control=False):
        for target, *_rest in self.layout.values():
            parent = Path(target).parent
            if parent == self.control_home and not include_control:
                continue
            parent.mkdir(parents=True, exist_ok=True)
            # Intermediate paths are trust anchors; exact control permissions
            # are applied only to the gateway-owned leaf.
            for path in [parent, *parent.parents]:
                if path == self.root.parent:
                    break
                if path.is_relative_to(self.root):
                    path.chmod(0o755)
            if parent == self.control_home:
                parent.chmod(0o700)
                os.chown(parent, self.gateway_uid, self.gateway_gid)

    def write_original(self, label, payload):
        target, _source, _action, _uid, _gid, mode, _limit, _optional = self.layout[label]
        Path(target).parent.mkdir(parents=True, exist_ok=True)
        if Path(target).parent == self.control_home:
            self.control_home.chmod(0o700)
            os.chown(self.control_home, self.gateway_uid, self.gateway_gid)
        Path(target).write_bytes(payload)
        Path(target).chmod(mode)
        if Path(target).parent == self.control_home:
            os.chown(target, self.gateway_uid, self.gateway_gid)
        return Path(target)

    def old_unit(self):
        return f"[Service]\nWorkingDirectory={self.install_dir}/apps/gateway\nEnvironment=VERSION=old\n".encode()

    def apply(self, fault=None):
        registration.apply(
            str(self.transaction), self.service, str(self.bin_dir), str(self.control_home),
            self.gateway_uid, self.gateway_gid, str(self.install_dir), self.policy, fault,
        )

    def close(self):
        shutil.rmtree(self.root, ignore_errors=True)


@unittest.skipUnless(os.name == "posix" and hasattr(os, "O_NOFOLLOW"), "Linux no-follow descriptors required")
class RegistrationTransactionTests(unittest.TestCase):
    def test_unit_alias_scan_rejects_a_hardlinked_symlink(self):
        fixture = RegistrationFixture()
        try:
            unit_dir = fixture.root / "units"
            unit_dir.mkdir()
            unit_dir.chmod(0o755)
            target = unit_dir / "real.service"
            payload = fixture.old_unit()
            target.write_bytes(payload)
            target.chmod(0o644)
            alias = unit_dir / "alias.service"
            alias.symlink_to(target.name)
            self.assertEqual(
                registration._read_unit_path(str(alias), fixture.policy, allow_link=True),
                payload,
            )

            # A second directory entry to the alias makes its name replaceable
            # without changing the referenced unit and therefore unsuitable as
            # a trusted cleanup/compatibility decision input.
            os.link(alias, unit_dir / "alias-copy.service", follow_symlinks=False)
            with self.assertRaisesRegex(ValueError, "alias is unsafe"):
                registration._read_unit_path(str(alias), fixture.policy, allow_link=True)
        finally:
            fixture.close()

    def test_installer_unit_snapshot_is_bounded_and_rejects_unsafe_names(self):
        fixture = RegistrationFixture()
        try:
            fixture.ensure_target_parents()
            unit = fixture.write_original("unit", fixture.old_unit() + b"Environment=RUN_USER=worker\n")
            unit_dir = str(unit.parent)
            result = registration.inspect_unit(fixture.service, fixture.policy, unit_dir)
            self.assertTrue(result["exists"])
            self.assertEqual(result["fields"]["RUN_USER"], "worker")

            unit.unlink()
            source = unit.with_name("source")
            source.write_bytes(fixture.old_unit())
            source.chmod(0o644)
            unit.symlink_to(source)
            with self.assertRaises((OSError, ValueError)):
                registration.inspect_unit(fixture.service, fixture.policy, unit_dir)

            unit.unlink()
            source.unlink()
            source.write_bytes(fixture.old_unit())
            source.chmod(0o644)
            os.link(source, unit)
            with self.assertRaises(ValueError):
                registration.inspect_unit(fixture.service, fixture.policy, unit_dir)

            unit.unlink()
            source.unlink()
            os.mkfifo(unit, 0o644)
            with self.assertRaises(ValueError):
                registration.inspect_unit(fixture.service, fixture.policy, unit_dir)

            unit.unlink()
            unit.write_bytes(b"x" * (registration.MAX_UNIT_BYTES + 1))
            unit.chmod(0o644)
            with self.assertRaises(ValueError):
                registration.inspect_unit(fixture.service, fixture.policy, unit_dir)
        finally:
            fixture.close()

    def test_partial_publication_rolls_back_exact_files_and_missing_control_tree(self):
        fixture = RegistrationFixture()
        try:
            fixture.ensure_target_parents()
            old_unit = fixture.old_unit()
            unit = fixture.write_original("unit", old_unit)
            helper = fixture.write_original("admin-helper", b"old helper\n")
            original_stat = unit.stat()

            def fail(event, label):
                if event == "after-publish" and label == "worker-launcher":
                    raise InjectedFailure("synthetic publication failure")

            with self.assertRaises(InjectedFailure):
                fixture.apply(fail)
            registration.restore(str(fixture.transaction), fixture.policy)
            self.assertEqual(unit.read_bytes(), old_unit)
            self.assertEqual(helper.read_bytes(), b"old helper\n")
            self.assertEqual(stat.S_IMODE(unit.stat().st_mode), 0o644)
            self.assertEqual(unit.stat().st_mtime_ns, original_stat.st_mtime_ns)
            self.assertFalse(Path(fixture.layout["worker-launcher"][0]).exists())
            self.assertFalse(fixture.control_home.exists())
            registration.discard(str(fixture.transaction), fixture.policy)
            self.assertFalse(fixture.transaction.exists())
        finally:
            fixture.close()

    def test_complete_publish_can_be_restored_after_activation_failure(self):
        fixture = RegistrationFixture()
        try:
            fixture.ensure_target_parents()
            old_unit = fixture.old_unit()
            unit = fixture.write_original("unit", old_unit)
            gateway_env = fixture.write_original("gateway.env", b"TRUSTED_HOSTS=old.example\n")
            fixture.apply()
            self.assertEqual(unit.read_bytes(), fixture.candidates["unit"])
            self.assertEqual(gateway_env.read_bytes(), b"TRUSTED_HOSTS=old.example\n")
            registration.restore(str(fixture.transaction), fixture.policy)
            self.assertEqual(unit.read_bytes(), old_unit)
            self.assertEqual(gateway_env.read_bytes(), b"TRUSTED_HOSTS=old.example\n")
            registration.discard(str(fixture.transaction), fixture.policy)
        finally:
            fixture.close()

    def test_candidate_replacement_is_detected_before_target_overwrite(self):
        fixture = RegistrationFixture()
        try:
            fixture.ensure_target_parents()
            old_unit = fixture.old_unit()
            unit = fixture.write_original("unit", old_unit)

            def replace_stage(event, label):
                if event == "before-publish" and label == "unit":
                    candidate = fixture.stage / "unit"
                    replacement = fixture.stage / "replacement"
                    replacement.write_bytes(b"attacker replacement\n")
                    replacement.chmod(0o600)
                    os.replace(replacement, candidate)

            with self.assertRaisesRegex(RuntimeError, "candidate changed"):
                fixture.apply(replace_stage)
            self.assertEqual(unit.read_bytes(), old_unit)
            registration.restore(str(fixture.transaction), fixture.policy)
            registration.discard(str(fixture.transaction), fixture.policy)
        finally:
            fixture.close()

    def test_concurrent_target_replacement_is_never_overwritten_by_rollback(self):
        fixture = RegistrationFixture()
        try:
            fixture.ensure_target_parents()
            fixture.write_original("unit", fixture.old_unit())
            helper = fixture.write_original("admin-helper", b"old helper\n")

            def replace_target(event, _label):
                if event == "after-snapshot":
                    replacement = helper.with_name("replacement")
                    replacement.write_bytes(b"external valid replacement\n")
                    replacement.chmod(0o755)
                    os.replace(replacement, helper)

            with self.assertRaisesRegex(RuntimeError, "changed before publication"):
                fixture.apply(replace_target)
            with self.assertRaisesRegex(RuntimeError, "rollback incomplete"):
                registration.restore(str(fixture.transaction), fixture.policy)
            self.assertEqual(helper.read_bytes(), b"external valid replacement\n")
            self.assertTrue(fixture.transaction.exists(), "manual recovery evidence was discarded")
        finally:
            fixture.close()

    def test_unsafe_existing_unit_types_fail_before_any_publication(self):
        for unsafe in ("symlink", "hardlink", "fifo", "oversize"):
            with self.subTest(unsafe=unsafe):
                fixture = RegistrationFixture()
                try:
                    fixture.ensure_target_parents()
                    unit = Path(fixture.layout["unit"][0])
                    helper = fixture.write_original("admin-helper", b"old helper\n")
                    if unsafe == "symlink":
                        source = unit.with_name("unit-source")
                        source.write_bytes(fixture.old_unit())
                        source.chmod(0o644)
                        unit.symlink_to(source)
                    elif unsafe == "hardlink":
                        source = unit.with_name("unit-source")
                        source.write_bytes(fixture.old_unit())
                        source.chmod(0o644)
                        os.link(source, unit)
                    elif unsafe == "fifo":
                        os.mkfifo(unit, 0o644)
                    else:
                        unit.write_bytes(b"x" * (registration.MAX_UNIT_BYTES + 1))
                        unit.chmod(0o644)
                    with self.assertRaises((OSError, RuntimeError, ValueError)):
                        fixture.apply()
                    self.assertEqual(helper.read_bytes(), b"old helper\n")
                    registration.restore(str(fixture.transaction), fixture.policy)
                    self.assertTrue(fixture.transaction.exists())
                finally:
                    fixture.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
