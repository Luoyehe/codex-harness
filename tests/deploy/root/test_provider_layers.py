"""Host policy fixtures require actual Linux root ownership; all paths relocate."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy.common import DeployError, Layout, fsync_directory
from deploy.provider_layers import ensure_mount_targets, read_host_layers


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "Real Linux root host-policy fixture")
class ProviderHostFilesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="provider-host-layers-")
        self.addCleanup(self.temp.cleanup)
        self.layout = Layout("fixture", Path(self.temp.name))
        self.folder = self.layout.root / "etc/codex"

    def test_missing_mount_targets_create_only_empty_files_and_keep_other_host_content(self):
        self.folder.mkdir(parents=True)
        existing = self.folder / "managed_config.toml"
        existing.write_text('developer_instructions = "Keep global policy"\n')
        existing.chmod(0o644)
        before = existing.read_bytes()
        documents, manifest = read_host_layers(self.layout, 1)
        ensure_mount_targets(self.layout, manifest)
        self.assertEqual((self.folder / "config.toml").read_bytes(), b"")
        self.assertEqual((self.folder / "requirements.toml").read_bytes(), b"")
        self.assertEqual(existing.read_bytes(), before)
        self.assertEqual(documents["managed_config.toml"]["developer_instructions"], "Keep global policy")

    def test_existing_files_never_overwritten_and_content_drift_changes_manifest(self):
        self.folder.mkdir(parents=True)
        path = self.folder / "config.toml"
        path.write_text('model_instructions_file = "./policy.md"\n')
        path.chmod(0o644)
        before = path.read_bytes()
        _, manifest = read_host_layers(self.layout, 1)
        ensure_mount_targets(self.layout, manifest)
        self.assertEqual(path.read_bytes(), before)
        path.write_text('model_instructions_file = "./changed.md"\n')
        _, changed = read_host_layers(self.layout, 1)
        self.assertNotEqual(manifest["files"]["config.toml"], changed["files"]["config.toml"])

    def test_target_appearing_after_preflight_is_not_replaced(self):
        _, manifest = read_host_layers(self.layout, 1)
        self.folder.mkdir(parents=True)
        path = self.folder / "config.toml"
        path.write_text('model = "concurrent administrator"\n')
        with self.assertRaises(DeployError):
            ensure_mount_targets(self.layout, manifest)
        self.assertEqual(path.read_text(), 'model = "concurrent administrator"\n')

    def test_interrupted_mount_file_sync_is_repeated_for_the_existing_target(self):
        target = self.folder / "config.toml"
        original = os.fsync
        calls = []
        def fail(fd):
            info = os.fstat(fd)
            if target.exists() and (info.st_dev, info.st_ino) == (target.stat().st_dev, target.stat().st_ino):
                calls.append("file")
                raise OSError("Injected host mount file sync failure")
            return original(fd)
        for attempt in range(2):
            _, manifest = read_host_layers(self.layout, 1)
            with self.subTest(attempt=attempt), patch("deploy.provider_layers.os.fsync", side_effect=fail), self.assertRaises(OSError):
                ensure_mount_targets(self.layout, manifest, worker_gid=1)
        self.assertEqual(calls, ["file", "file"])
        before = target.stat()
        _, manifest = read_host_layers(self.layout, 1)
        ensure_mount_targets(self.layout, manifest, worker_gid=1)
        after = target.stat()
        self.assertEqual((after.st_mode, after.st_uid, after.st_gid), (before.st_mode, before.st_uid, before.st_gid))
        self.assertEqual(target.read_bytes(), b"")

    def test_interrupted_mount_directory_parent_sync_is_repeated_without_mode_changes(self):
        def fail(path, **kwargs):
            if path == self.folder.parent:
                raise OSError("Injected host mount directory sync failure")
            return fsync_directory(path, **kwargs)
        for attempt in range(2):
            _, manifest = read_host_layers(self.layout, 1)
            with self.subTest(attempt=attempt), patch("deploy.common.fsync_directory", side_effect=fail), self.assertRaises(OSError):
                ensure_mount_targets(self.layout, manifest)
            self.assertFalse((self.folder / "config.toml").exists())

    def test_root_private_policy_is_not_copied_into_native_readable_generation(self):
        self.folder.mkdir(parents=True)
        path = self.folder / "config.toml"
        path.write_text('private_setting = "fixture"\n')
        path.chmod(0o600)
        with self.assertRaises(DeployError) as caught:
            read_host_layers(self.layout, 65534)
        self.assertEqual(caught.exception.code, "configuration_conflict")
        path.chmod(0o640)
        os.chown(path, 0, 65534)
        self.assertEqual(read_host_layers(self.layout, 65534)[0]["config.toml"]["private_setting"], "fixture")

    def test_symlink_hardlink_and_native_writable_policy_are_rejected(self):
        self.folder.mkdir(parents=True)
        path = self.folder / "config.toml"
        path.write_text('model = "fixture"\n')
        path.chmod(0o644)
        for defect in ("writable", "owner", "hardlink", "symlink"):
            other = self.layout.root / "other.toml"
            if defect == "writable":
                path.chmod(0o666)
            elif defect == "owner":
                os.chown(path, 65534, 65534)
            elif defect == "hardlink":
                os.link(path, other)
            else:
                path.rename(other); path.symlink_to(other)
            with self.subTest(defect=defect), self.assertRaises(DeployError):
                read_host_layers(self.layout, 65534)
            if defect == "writable":
                path.chmod(0o644)
            elif defect == "owner":
                os.chown(path, 0, 0)
            elif defect == "hardlink":
                other.unlink()
            else:
                path.unlink(); other.rename(path)


if __name__ == "__main__":
    unittest.main()
