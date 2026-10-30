"""Root filesystem/lock/lifecycle integration; service/account calls stay substituted."""
import os
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy import candidate_archive as archive
from deploy.common import DeployError, atomic_write, digest, exclusive, read_json, write_json
from deploy.install_recovery import management_lock
from deploy.manager import Manager
from deploy.safe_fs import inspect_tree
from tests.deploy.root import test_service_lifecycle as lifecycle_fixture


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "Real Linux root filesystem and locks")
class CandidateArchiveRootTests(unittest.TestCase):
    def setUp(self):
        # Trust checks deliberately reject /tmp; this layout is private and is
        # never one of the machine's real instance roots.
        self.fixture = lifecycle_fixture.ServiceLifecycleTests("test_roundtrip_restores_exact_activity_enablement_and_tls_material")
        factory = tempfile.TemporaryDirectory
        with patch("tests.deploy.root.test_service_lifecycle.tempfile.TemporaryDirectory", side_effect=lambda: factory(dir="/root")):
            self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.manager = self.fixture.manager
        self.layout = self.fixture.layout
        self.system = self.fixture.system
        self.system.instance_units = lambda _: []
        self.system.no_instance_processes = lambda *_: None
        self.candidate = "d" * 32
        self.source = self.layout.work / ("candidate-" + self.candidate)
        self.source.mkdir(parents=True)
        (self.source / "retained.txt").write_text("candidate archive fixture")
        release = self.layout.app / "releases/stage"
        release.mkdir(parents=True)
        (release / "application.txt").write_text("verified application")
        manifest = inspect_tree(release, root_owned=True)
        self.release = digest(manifest)
        release.rename(release.with_name(self.release))
        (self.layout.config / "manifests").mkdir()
        write_json(self.layout.config / "manifests" / (self.release + ".json"), manifest)
        os.symlink("releases/" + self.release, self.layout.app / "current")
        self.manager.selected = types.MethodType(Manager.selected, self.manager)
        self.manager.verify_release = types.MethodType(Manager.verify_release, self.manager)
        record = self.layout.state / "transactions" / self.candidate
        record.mkdir()
        write_json(record / "prepared.json", {"release": self.release, "manifestDigest": self.release,
                                              **{name: True for name in archive.PROBES}})
        self.fixture.stack.enter_context(patch.object(archive, "Manager", return_value=self.manager))
        self.fixture.stack.enter_context(patch.object(archive, "require_idle"))
        self.fixture.stack.enter_context(patch.object(archive, "run", return_value=types.SimpleNamespace(stdout="", returncode=0)))

    def perform(self):
        return archive.archive_candidate(self.layout, self.candidate, confirm_stop=True)

    def test_real_locks_manifest_rename_and_retained_service_restoration(self):
        original = {name: (self.layout.config / name).read_bytes() for name in ("instance.json", "gateway-token", "Caddyfile")}
        active, enabled = set(self.system.active), set(self.system.enabled)
        result = self.perform()
        self.assertTrue(result["servicesRestored"])
        self.assertTrue(Path(result["archive"]).is_dir())
        self.assertFalse(self.source.exists())
        self.assertEqual(set(self.system.active), active)
        self.assertEqual(set(self.system.enabled), enabled)
        self.assertEqual({name: (self.layout.config / name).read_bytes() for name in original}, original)
        self.assertEqual(self.manager.selected(), self.release)
        self.assertTrue(self.manager.verify_release(self.release)["integrity"])
        self.assertEqual(read_json(Path(result["inventory"]))["phase"], "complete")
        self.assertEqual(Path(result["archive"]).parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(read_json(self.fixture.journal())["phase"], "recovered")

    def test_changed_release_stops_before_removing_services(self):
        (self.layout.app / "releases" / self.release / "application.txt").write_text("tampered")
        with self.assertRaises(DeployError):
            self.perform()
        self.assertTrue(self.source.exists())
        self.assertFalse((self.layout.config / "uninstalled.json").exists())
        self.assertEqual(self.system.events, [])

    def assert_legacy_archive_restores_with_real_verification(self, *, workspace):
        self.fixture.enable_real_verification()
        old = self.fixture.install_previous_sudo(workspace=workspace)
        active, enabled = set(self.system.active), set(self.system.enabled)
        result = self.perform()
        self.assertTrue(result["servicesRestored"])
        self.assertTrue(Path(result["archive"]).is_dir())
        self.assertFalse(self.source.exists())
        self.assertEqual(self.system.active, active)
        self.assertEqual(self.system.enabled, enabled)
        self.assertEqual((self.layout.root / "etc/sudoers.d/codex-harness-lifecycle").read_bytes(), old)
        self.assertEqual(read_json(Path(result["inventory"]))["phase"], "complete")
        self.assertEqual(read_json(self.fixture.journal())["phase"], "recovered")
        with self.assertRaisesRegex(DeployError, "Fixed sudo policy changed"):
            self.manager.verify()

    def test_legacy_workspace_archive_uses_real_verification_and_restores_services(self):
        self.assert_legacy_archive_restores_with_real_verification(workspace=True)

    def test_legacy_pre_workspace_archive_uses_real_verification_and_restores_services(self):
        self.assert_legacy_archive_restores_with_real_verification(workspace=False)

    def test_legacy_archive_verification_failure_keeps_pending_recovery_and_retry(self):
        self.fixture.enable_real_verification()
        old = self.fixture.install_previous_sudo()
        sudo = self.layout.root / "etc/sudoers.d/codex-harness-lifecycle"
        active = set(self.system.active)
        with patch.object(self.manager, "healthy", side_effect=lambda: sudo.write_bytes(old + b"root ALL=(ALL) NOPASSWD: ALL\n")), self.assertRaises(DeployError):
            self.perform()
        self.fixture.assert_recovery_pending()
        self.assertFalse(self.source.exists())
        inventory = archive.archive_root(self.layout) / (self.candidate + ".json")
        self.assertEqual(read_json(inventory)["phase"], "archived")
        atomic_write(sudo, old, 0o440)
        result = self.perform()
        self.assertTrue(result["servicesRestored"])
        self.assertEqual(self.system.active, active)
        self.assertEqual(read_json(inventory)["phase"], "complete")
        self.assertEqual(read_json(self.fixture.journal())["phase"], "recovered")

    def test_candidate_symlink_is_not_followed(self):
        retained = self.source.with_name("retained-real-directory")
        self.source.rename(retained)
        self.source.symlink_to(retained, target_is_directory=True)
        with self.assertRaises(DeployError):
            self.perform()
        self.assertTrue((retained / "retained.txt").exists())
        self.assertEqual(self.system.events, [])

    def test_foreign_owned_candidate_is_rejected_before_service_removal(self):
        os.chown(self.source, 65534, 65534)
        with self.assertRaises(DeployError) as raised:
            self.perform()
        self.assertEqual(raised.exception.code, "unsafe_path")
        self.assertTrue(self.source.exists())
        self.assertFalse(self.target_exists())
        self.assertEqual(self.system.events, [])

    def test_foreign_owned_preparation_is_rejected_before_service_removal(self):
        record = self.layout.state / "transactions" / self.candidate / "prepared.json"
        os.chown(record, 65534, 65534)
        with self.assertRaisesRegex(DeployError, "Unsafe service lifecycle record"):
            self.perform()
        self.assertTrue(self.source.exists())
        self.assertFalse(self.target_exists())
        self.assertEqual(self.system.events, [])

    def target_exists(self):
        return (archive.archive_root(self.layout) / self.source.name).exists()

    def test_management_lock_contention_keeps_online_fixture_untouched(self):
        lock = self.layout.config / "management.lock"
        code = ("import os,sys; sys.path.insert(0," + repr(str(Path(__file__).resolve().parents[3])) + "); "
                "from deploy.common import exclusive; os.umask(0o022)\n"
                "with exclusive(__import__('pathlib').Path(sys.argv[1])):\n print('locked',flush=True); sys.stdin.read()")
        child = subprocess.Popen([sys.executable, "-I", "-B", "-c", code, str(lock)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "locked")
            before = lock.stat()
            self.assertEqual(before.st_mode & 0o777, 0o644)
            with self.assertRaises(DeployError) as raised:
                self.perform()
            self.assertEqual(raised.exception.code, "busy")
            self.assertEqual(self.system.events, [])
            self.assertTrue(self.source.exists())
        finally:
            child.stdin.close()
            child.wait(timeout=5)
            child.stdout.close()
        self.assertTrue(self.perform()["servicesRestored"])
        self.assertEqual((lock.stat().st_dev, lock.stat().st_ino, lock.stat().st_mode),
                         (before.st_dev, before.st_ino, before.st_mode))

    def test_common_exclusive_created_lock_allows_real_verified_archive(self):
        self.fixture.enable_real_verification()
        lock = self.layout.config / "management.lock"
        old_umask = os.umask(0o022)
        try:
            with exclusive(lock):
                self.assertEqual(lock.stat().st_mode & 0o777, 0o644)
        finally:
            os.umask(old_umask)
        before = lock.stat()
        result = self.perform()
        self.assertTrue(result["servicesRestored"])
        self.assertTrue(self.manager.verify()["integrity"])
        self.assertEqual(read_json(self.fixture.journal())["phase"], "recovered")
        after = lock.stat()
        self.assertEqual((after.st_dev, after.st_ino, after.st_mode, after.st_size),
                         (before.st_dev, before.st_ino, before.st_mode, 0))

    def test_management_lock_accepts_only_supported_readable_modes_without_normalizing(self):
        lock = self.layout.config / "management.lock"
        for mask, mode in ((0o077, 0o600), (0o027, 0o640), (0o022, 0o644)):
            with self.subTest(mode=oct(mode)):
                old_umask = os.umask(mask)
                try:
                    with exclusive(lock):
                        pass
                finally:
                    os.umask(old_umask)
                before = lock.stat()
                self.assertEqual(before.st_mode & 0o777, mode)
                with management_lock(self.layout):
                    self.assertEqual(lock.stat().st_ino, before.st_ino)
                self.assertEqual(lock.stat().st_mode, before.st_mode)
                lock.unlink()

    def test_unsafe_management_locks_block_before_any_archive_or_service_action(self):
        lock = self.layout.config / "management.lock"
        other = lock.with_name("fixture-other-lock")
        linked = lock.with_name("fixture-linked-lock")
        atomic_write(other, b"", 0o600)
        other_before = other.stat()
        def symlink():
            lock.unlink()
            lock.symlink_to(other)
        def fifo():
            lock.unlink()
            os.mkfifo(lock, 0o600)
        def directory():
            lock.unlink()
            lock.mkdir(mode=0o700)
        mutations = {"foreign-owner": lambda: os.chown(lock, 65534, 65534),
                     "group-writable": lambda: lock.chmod(0o660),
                     "other-writable": lambda: lock.chmod(0o646),
                     "unsupported-read-mode": lambda: lock.chmod(0o604),
                     "content": lambda: lock.write_bytes(b"foreign lock content"),
                     "hardlink": lambda: os.link(lock, linked), "symlink": symlink,
                     "fifo": fifo, "directory": directory}
        for name, mutate in mutations.items():
            with self.subTest(mutation=name):
                atomic_write(lock, b"", 0o600)
                mutate()
                with self.assertRaises((DeployError, OSError)):
                    self.perform()
                self.assertEqual(self.system.events, [])
                self.assertTrue(self.source.exists())
                self.assertFalse(self.target_exists())
                self.assertFalse((self.layout.config / "uninstalled.json").exists())
                linked.unlink(missing_ok=True)
                if lock.is_dir() and not lock.is_symlink():
                    lock.rmdir()
                else:
                    lock.unlink()
        self.assertEqual((other.stat().st_ino, other.stat().st_mode, other.read_bytes()),
                         (other_before.st_ino, other_before.st_mode, b""))

    def test_initialization_lock_still_rejects_readable_0644_without_changing_it(self):
        lock = self.layout.config.parent / ("." + self.layout.instance + "-initialize.lock")
        atomic_write(lock, b"", 0o644)
        before = lock.stat()
        with self.assertRaisesRegex(DeployError, "Unsafe initialization lock"):
            self.perform()
        self.assertEqual(self.system.events, [])
        self.assertTrue(self.source.exists())
        self.assertFalse((self.layout.config / "management.lock").exists())
        self.assertEqual((lock.stat().st_ino, lock.stat().st_mode), (before.st_ino, before.st_mode))

    def test_lock_path_replaced_during_acquisition_is_rejected(self):
        import fcntl
        lock = self.layout.config / "management.lock"
        atomic_write(lock, b"", 0o644)
        before = lock.stat()
        original = fcntl.flock
        def replace_path(descriptor, operation):
            original(descriptor, operation)
            atomic_write(lock, b"", 0o644)
        with patch.object(fcntl, "flock", side_effect=replace_path), self.assertRaisesRegex(DeployError, "Lock path changed"):
            with management_lock(self.layout):
                self.fail("Must not enter with a lock on an unlinked inode")
        self.assertNotEqual(lock.stat().st_ino, before.st_ino)
        self.assertEqual(self.system.events, [])

    def test_retained_image_is_never_archived(self):
        (self.source / "build.ext4").write_bytes(b"uncertain image")
        with self.assertRaisesRegex(DeployError, "image"):
            self.perform()
        self.assertEqual(self.system.events, [])
        self.assertTrue(self.source.exists())


if __name__ == "__main__":
    unittest.main()
