"""Linux descriptor/ownership checks in temporary paths; no host services."""
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy import common
from deploy.common import DeployError, durable_directory, mkdir
from deploy.install_recovery import root_lock
from deploy.workspace_store import private_directory


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "Real Linux root descriptor fixture")
class DirectoryDescriptorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_restrictive_umask_only_normalizes_new_directories(self):
        shared = self.root / "shared"
        shared.mkdir(mode=0o750)
        old = os.umask(0o077)
        try:
            mkdir(shared / "new/private", 0o700)
        finally:
            os.umask(old)
        self.assertEqual(stat.S_IMODE(shared.stat().st_mode), 0o750)
        self.assertEqual(stat.S_IMODE((shared / "new").stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE((shared / "new/private").stat().st_mode), 0o700)

    def test_interrupted_shared_creation_retry_requires_explicit_operator_mode_repair(self):
        shared = self.root / "shared"
        lock = shared / "instance.lock"
        original = os.fchmod
        def fail(fd, mode):
            if shared.exists() and os.fstat(fd).st_ino == shared.stat().st_ino:
                raise OSError("Injected interruption before shared-directory chmod")
            return original(fd, mode)
        old = os.umask(0o077)
        try:
            with patch("deploy.install.trusted_ancestors"), patch("deploy.common.os.fchmod", side_effect=fail), self.assertRaises(OSError):
                with root_lock(lock, shared_root=self.root):
                    self.fail("Initialization must not enter after failed mode publication")
        finally:
            os.umask(old)
        self.assertEqual(stat.S_IMODE(shared.stat().st_mode), 0o700)
        with patch("deploy.install.trusted_ancestors"), self.assertRaisesRegex(DeployError, "Shared service directory"):
            with root_lock(lock, shared_root=self.root):
                self.fail("A retained restrictive directory must not be silently accepted")
        self.assertFalse(lock.exists())
        self.assertEqual(stat.S_IMODE(shared.stat().st_mode), 0o700)
        shared.chmod(0o755)  # Explicit operator repair of the diagnosed container.
        with patch("deploy.install.trusted_ancestors"):
            with root_lock(lock, shared_root=self.root):
                self.assertTrue(lock.exists())

    def test_shared_policy_checks_group_and_other_traversal_without_changing_existing_modes(self):
        shared = self.root / "shared"
        shared.mkdir()
        for mode in (0o700, 0o701, 0o750):
            shared.chmod(mode)
            with self.subTest(mode=oct(mode)), patch("deploy.common.os.fchmod") as chmod, self.assertRaises(DeployError):
                durable_directory(shared, create=True, shared_root=self.root)
            chmod.assert_not_called()
            self.assertEqual(stat.S_IMODE(shared.stat().st_mode), mode)

    def test_symlink_ancestor_and_final_symlink_never_change_external_metadata(self):
        external = self.root / "external"
        external.mkdir(mode=0o750)
        link = self.root / "link"
        link.symlink_to(external, target_is_directory=True)
        before = external.stat()
        for target in (link, link / "child"):
            with self.subTest(target=target), self.assertRaises(DeployError):
                mkdir(target, 0o700, 65534, 65534)
        after = external.stat()
        self.assertEqual((after.st_mode, after.st_uid, after.st_gid), (before.st_mode, before.st_uid, before.st_gid))
        self.assertEqual(list(external.iterdir()), [])

    def test_directory_replaced_with_symlink_between_create_and_open_is_rejected(self):
        external = self.root / "external"
        external.mkdir(mode=0o750)
        target = self.root / "collection"
        original = os.mkdir
        def replace(name, mode=0o777, *, dir_fd=None):
            original(name, mode, dir_fd=dir_fd)
            if name == target.name:
                target.rmdir()
                target.symlink_to(external, target_is_directory=True)
        with patch("deploy.common.os.mkdir", side_effect=replace), self.assertRaises(DeployError):
            mkdir(target / "private", 0o700, 65534, 65534)
        self.assertEqual(stat.S_IMODE(external.stat().st_mode), 0o750)
        self.assertEqual(list(external.iterdir()), [])

    def test_initialization_lock_parent_failure_blocks_lock_and_preserves_shared_mode(self):
        shared = self.root / "shared"
        shared.mkdir(mode=0o750)
        lock = shared / "instance.lock"
        original = common.fsync_directory
        def fail(path, **kwargs):
            if path == self.root:
                raise OSError("Injected initialization parent failure")
            return original(path, **kwargs)
        # Only the host ancestry policy above this temporary fixture is replaced.
        with patch("deploy.install.trusted_ancestors"), patch("deploy.common.fsync_directory", side_effect=fail), self.assertRaises(OSError):
            with root_lock(lock):
                self.fail("Lock body must not run before directory publication")
        self.assertFalse(lock.exists())
        self.assertEqual(stat.S_IMODE(shared.stat().st_mode), 0o750)
        with patch("deploy.install.trusted_ancestors"):
            with root_lock(lock):
                self.assertTrue(lock.exists())
        self.assertEqual(stat.S_IMODE(shared.stat().st_mode), 0o750)

    def test_private_directory_parent_failure_closes_fd_and_existing_retry_syncs_again(self):
        parent = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, parent)
        original_sync, original_open = os.fsync, os.open
        opened = []
        def opening(*args, **kwargs):
            fd = original_open(*args, **kwargs)
            opened.append(fd)
            return fd
        def fail(fd):
            if fd == parent:
                raise OSError("Injected private collection publication failure")
            return original_sync(fd)
        for attempt in range(2):
            with self.subTest(attempt=attempt), patch("deploy.workspace_store.os.open", side_effect=opening), \
                 patch("deploy.workspace_store.os.fsync", side_effect=fail), self.assertRaises(OSError):
                private_directory(parent, "private", create=True)
            with self.assertRaises(OSError):
                os.fstat(opened[-1])
        fd = private_directory(parent, "private", create=True)
        os.close(fd)


if __name__ == "__main__":
    unittest.main()
