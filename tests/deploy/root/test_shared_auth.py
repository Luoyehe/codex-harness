"""Isolated real UID/file lifecycle; no account, network or provider calls."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy.common import DeployError, Layout, atomic_write, mkdir, read_json
from deploy.shared_auth import DIRECTORY, Store, handoff, status, verify


class PowerLoss(BaseException):
    pass


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "Real Linux UID/rename durability fixture")
class SharedAuthenticationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="shared-auth-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.layout = Layout("fixture", self.root)
        self.config = {"workerUid": 65534, "workerGid": 65534}
        mkdir(self.layout.state)
        self.homes = {}
        for mode in ("native", "root"):
            uid = 65534 if mode == "native" else 0
            parent = self.layout.state / ("worker" if mode == "native" else "worker-root")
            mkdir(parent, 0o750 if uid else 0o700, uid, uid)
            mkdir(parent / "codex", 0o750 if uid else 0o700, uid, uid)
            self.homes[mode] = parent / "codex"
            atomic_write(parent / "codex/config.toml", ("# private " + mode).encode(), 0o600, uid, uid)
        # Permit the actual nobody child to traverse only this disposable fixture.
        for path in [self.layout.state, *self.layout.state.parents]:
            if path == self.root or self.root in path.parents:
                path.chmod(0o755)
        self.counter = 0

    def transfer(self, mode, *, transaction=None):
        self.counter += 1
        result = handoff(self.layout, self.config, mode, transaction or f"{self.counter:032x}")
        self.config.update(executionMode=mode, rootAllowed=True, executionGeneration="a" * 32)
        return result

    def credential(self, mode, value):
        uid = 65534 if mode == "native" else 0
        atomic_write(self.homes[mode] / "auth.json", json.dumps({"fixture": value}).encode(), 0o600, uid, uid)

    def value(self, mode):
        return read_json(self.homes[mode] / "auth.json")["fixture"]

    def actual_identity(self, mode, action, value=""):
        # Mirrors official FileAuthStorage save(truncate/create0600) and unlink;
        # this tests OS access, not a real OAuth exchange or upstream token refresh.
        script = "import os,pathlib,json;os.umask(0o077);"
        if mode == "native":
            script += "os.setgroups([65534]);os.setgid(65534);os.setuid(65534);"
        script += "p=pathlib.Path(" + repr(str(self.homes[mode] / "auth.json")) + ");"
        script += "p.unlink()" if action == "logout" else "p.write_text(json.dumps({'fixture':" + repr(value) + "}))"
        result = subprocess.run([sys.executable, "-I", "-B", "-c", script], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_both_real_uids_consume_one_login_refresh_logout_and_login_again(self):
        self.actual_identity("native", "save", "login")
        original_inode = (self.homes["native"] / "auth.json").stat().st_ino
        original_mtime = (self.homes["native"] / "auth.json").stat().st_mtime_ns
        self.transfer("root")
        self.assertEqual(self.value("root"), "login")
        self.assertEqual((self.homes["root"] / "auth.json").stat().st_ino, original_inode)
        self.assertEqual((self.homes["root"] / "auth.json").stat().st_mtime_ns, original_mtime)
        self.assertFalse((self.homes["native"] / "auth.json").exists())
        self.actual_identity("root", "save", "rotated")
        self.transfer("native")
        self.assertEqual(self.value("native"), "rotated")
        self.actual_identity("native", "logout")
        self.transfer("root")
        self.assertFalse((self.homes["root"] / "auth.json").exists())
        self.actual_identity("root", "save", "second-login")
        self.transfer("native")
        self.assertEqual(self.value("native"), "second-login")
        self.assertEqual((self.homes["native"] / "config.toml").read_text(), "# private native")
        self.assertEqual((self.homes["root"] / "config.toml").read_text(), "# private root")
        self.assertTrue(verify(self.layout, self.config)["shared"])

    def test_inactive_login_is_archived_even_when_current_mode_is_logged_out(self):
        self.credential("root", "other-account")
        result = self.transfer("root")
        self.assertEqual(result["archivedLegacyModes"], ["root"])
        self.assertFalse(result["automaticRestore"])
        retained = self.layout.state / DIRECTORY / "legacy-root.auth.json"
        self.assertEqual(read_json(retained)["fixture"], "other-account")
        self.assertEqual((retained.stat().st_uid, retained.stat().st_gid, retained.stat().st_mode & 0o777), (0, 0, 0o600))
        for mode in ("native", "root", "native"):
            self.transfer(mode)
            self.assertFalse((self.homes[mode] / "auth.json").exists())
        # Prove the ordinary identity cannot read the retained old account.
        code = "import os,pathlib;os.setgroups([65534]);os.setgid(65534);os.setuid(65534);pathlib.Path(" + repr(str(retained)) + ").read_bytes()"
        child = subprocess.run([sys.executable, "-I", "-B", "-c", code], capture_output=True, timeout=10)
        self.assertNotEqual(child.returncode, 0)
        self.assertIn(b"PermissionError", child.stderr)

    def test_crash_after_each_rename_can_complete_or_compensate_without_copying(self):
        from deploy.shared_auth import rename_absent
        for crash_at in (1, 2):
            for target in ("root", "native"):
                with self.subTest(crash_at=crash_at, target=target):
                    self.credential("native", "latest")
                    self.transfer("native")
                    calls = 0
                    def crash(*args):
                        nonlocal calls
                        rename_absent(*args)
                        calls += 1
                        if calls == crash_at:
                            raise PowerLoss()
                    transaction = "f" * 32
                    with patch("deploy.shared_auth.rename_absent", side_effect=crash), self.assertRaises(PowerLoss):
                        handoff(self.layout, self.config, "root", transaction)
                    with self.assertRaises(DeployError):
                        verify(self.layout, self.config)
                    self.transfer(target, transaction=transaction)
                    self.assertEqual(self.value(target), "latest")
                    self.assertFalse((self.homes["native" if target == "root" else "root"] / "auth.json").exists())
                    self.transfer("native")

    def test_crash_after_legacy_archive_recovers_same_private_backup(self):
        from deploy.shared_auth import rename_absent
        self.credential("native", "selected")
        self.credential("root", "retained")
        def crash(*args):
            rename_absent(*args)
            raise PowerLoss()
        with patch("deploy.shared_auth.rename_absent", side_effect=crash), self.assertRaises(PowerLoss):
            handoff(self.layout, self.config, "root", "a" * 32)
        self.transfer("root", transaction="a" * 32)
        self.assertEqual(self.value("root"), "selected")
        self.assertEqual(read_json(self.layout.state / DIRECTORY / "legacy-root.auth.json")["fixture"], "retained")

    def test_other_transaction_cannot_claim_pending_transfer(self):
        self.credential("native", "selected")
        self.transfer("native")
        with patch.object(Store, "move", side_effect=PowerLoss()), self.assertRaises(PowerLoss):
            handoff(self.layout, self.config, "root", "a" * 32)
        self.assertEqual(status(self.layout, self.config)["ready"], False)
        with self.assertRaisesRegex(DeployError, "Another authentication transfer"):
            handoff(self.layout, self.config, "root", "b" * 32)
        self.assertEqual(self.value("native"), "selected")
        self.transfer("native", transaction="a" * 32)
        self.assertEqual(status(self.layout, self.config)["ready"], True)

    def test_old_recovery_does_not_require_publishing_to_failed_candidate_home(self):
        from deploy.shared_auth import rename_absent
        self.credential("native", "selected")
        self.transfer("native")
        def crash(*args):
            rename_absent(*args)
            raise PowerLoss()
        with patch("deploy.shared_auth.rename_absent", side_effect=crash), self.assertRaises(PowerLoss):
            handoff(self.layout, self.config, "root", "a" * 32)
        original = Store.move
        def reject_candidate(store, source, name, target, destination, identity):
            if target == store.homes["root"]:
                raise OSError("fixture candidate filesystem cannot publish")
            return original(store, source, name, target, destination, identity)
        with patch.object(Store, "move", new=reject_candidate):
            self.transfer("native", transaction="a" * 32)
        self.assertEqual(self.value("native"), "selected")
        self.assertFalse((self.homes["root"] / "auth.json").exists())

    def test_replaced_pending_inode_and_unexpected_inactive_login_fail_closed(self):
        self.credential("native", "selected")
        self.transfer("native")
        with patch.object(Store, "move", side_effect=PowerLoss()), self.assertRaises(PowerLoss):
            handoff(self.layout, self.config, "root", "a" * 32)
        self.credential("native", "replacement")
        with self.assertRaisesRegex(DeployError, "ambiguous or was replaced"):
            handoff(self.layout, self.config, "root", "a" * 32)
        self.assertEqual(self.value("native"), "replacement")
        self.assertFalse((self.homes["root"] / "auth.json").exists())

    def test_unexpected_inactive_login_is_not_silently_overwritten(self):
        self.credential("native", "selected")
        self.transfer("native")
        self.credential("root", "unexpected")
        with self.assertRaisesRegex(DeployError, "Inactive authentication"):
            self.transfer("root")
        self.assertEqual(self.value("native"), "selected")
        self.assertEqual(self.value("root"), "unexpected")

    def test_symlink_or_hardlink_credentials_are_rejected_without_touching_target(self):
        external = self.root / "external"
        atomic_write(external, b"outside", 0o600, 65534, 65534)
        path = self.homes["native"] / "auth.json"
        for linked in ("symlink", "hardlink"):
            with self.subTest(linked=linked):
                os.symlink(external, path) if linked == "symlink" else os.link(external, path)
                with self.assertRaises(DeployError):
                    self.transfer("root")
                self.assertEqual(external.read_bytes(), b"outside")
                path.unlink()

    def test_no_secret_bytes_are_written_to_state_or_public_result(self):
        self.credential("native", "secret-marker-selected")
        self.credential("root", "secret-marker-retained")
        result = self.transfer("root")
        state_bytes = (self.layout.state / DIRECTORY / "state.json").read_bytes()
        self.assertNotIn(b"secret-marker", state_bytes)
        self.assertNotIn("secret-marker", json.dumps(result))
