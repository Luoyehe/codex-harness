"""Host policy fixtures require actual Linux root ownership; all paths relocate."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

from deploy.common import DeployError, Layout
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
