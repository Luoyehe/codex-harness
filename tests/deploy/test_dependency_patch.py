"""An approved patch is an immutable input and a verified installed package."""
import hashlib
import os
import shutil
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy.build import dependency_input, pack_source
from deploy.common import DeployError, Layout
from deploy.dependency_patch import (MAX_PATCH_BYTES, PATCH_PATH, approved_patch, bounded_file,
                                     copy_approved_patch, read_approved_patch, validate_patch_lock,
                                     verify_installed_patch)
from deploy.install import control_material


class DependencyPatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dependency-patch-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repository = Path(__file__).resolve().parents[2]

    def source(self):
        source = self.root / "source"
        source.mkdir()
        for name in ("package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"):
            (source / name).write_bytes((self.repository / name).read_bytes())
        shutil.copytree(self.repository / "patches", source / "patches")
        return source

    def test_real_patch_is_bound_to_current_lock_and_archived_source(self):
        source = self.source()
        _, lock, workspace = dependency_input(source)
        declaration = approved_patch()
        self.assertEqual(workspace["patchedDependencies"], {"picomatch@4.0.7": PATCH_PATH})
        self.assertEqual(validate_patch_lock(lock, source), {PATCH_PATH: declaration["patchSha256"]})
        archive = self.root / "source.tgz"
        pack_source(source, archive)
        with tarfile.open(archive) as stream:
            self.assertEqual(stream.extractfile(PATCH_PATH).read(), read_approved_patch(source))
        self.assertEqual(copy_approved_patch(source, self.root), {PATCH_PATH: declaration["patchSha256"]})
        self.assertEqual((self.root / PATCH_PATH).read_bytes(), (source / PATCH_PATH).read_bytes())

    def test_patch_declaration_is_in_actual_trusted_installation_and_control_update_material(self):
        # Both installation and control-generation updates consume this actual
        # material; do not merely assert that a new data filename exists.
        material = control_material(Layout("patch-fixture", self.root))
        for name in ("dependency_patch.py", "dependency_patch_contract.py"):
            data, mode = material["deploy/" + name]
            self.assertEqual(data, (self.repository / "deploy" / name).read_bytes())
            self.assertEqual(mode, 0o644)
            compile(data, name, "exec")

    def test_changed_missing_extra_or_relocated_patch_is_rejected(self):
        source = self.source()
        original = (source / PATCH_PATH).read_bytes()
        (source / PATCH_PATH).write_bytes(original + b"\n")
        with self.assertRaisesRegex(DeployError, "bytes differ"):
            read_approved_patch(source)
        (source / PATCH_PATH).write_bytes(original)
        (source / "patches/extra.patch").write_bytes(original)
        with self.assertRaisesRegex(DeployError, "Only the reviewed"):
            read_approved_patch(source)
        (source / "patches/extra.patch").unlink()
        (source / PATCH_PATH).rename(source / "patches/renamed.patch")
        with self.assertRaisesRegex(DeployError, "Only the reviewed"):
            read_approved_patch(source)

    def test_foreign_patch_mapping_or_lock_digest_never_authorizes_fetch(self):
        source = self.source()
        lock = (source / "pnpm-lock.yaml").read_text(encoding="utf-8")
        declaration = approved_patch()
        for changed in (lock.replace(declaration["lockPatchHash"], "0" * 64),
                        lock.replace("patchedDependencies:\n", "patchedDependencies:\n  other@1.0.0: " + "1" * 64 + "\n"),
                        lock + "\n'patchedDependencies': {}\n",
                        lock.replace(declaration["upstreamIntegrity"], "sha512-" + "A" * 86 + "==")):
            with self.subTest(lock=changed[:30]), self.assertRaises(DeployError):
                validate_patch_lock(changed, source)

    def test_patch_read_refuses_hardlinks_oversize_and_changed_identity(self):
        source = self.source()
        selected = source / PATCH_PATH
        os.link(selected, self.root / "another-link")
        with self.assertRaises(DeployError):
            read_approved_patch(source)
        (self.root / "another-link").unlink()
        selected.write_bytes(b"x" * (MAX_PATCH_BYTES + 1))
        with self.assertRaises(DeployError):
            read_approved_patch(source)
        selected.write_bytes(b"before")
        original = os.fstat
        calls = 0
        def changing(descriptor):
            nonlocal calls
            result = original(descriptor)
            calls += 1
            if calls == 1:
                selected.write_bytes(b"changed after open")
            return result
        with patch("deploy.dependency_patch.os.fstat", side_effect=changing), self.assertRaises(DeployError):
            bounded_file(selected, MAX_PATCH_BYTES)

    def test_linked_directory_symlink_file_and_fifo_are_rejected_before_open(self):
        source = self.source()
        selected = source / PATCH_PATH
        saved = self.root / "saved.patch"
        selected.rename(saved)
        selected.symlink_to(saved)
        with self.assertRaises(DeployError):
            read_approved_patch(source)
        selected.unlink()
        os.mkfifo(selected)
        with self.assertRaises(DeployError):
            read_approved_patch(source)
        selected.unlink()
        selected.write_bytes(saved.read_bytes())
        (source / "patches").rename(source / "actual-patches")
        (source / "patches").symlink_to(source / "actual-patches", target_is_directory=True)
        with self.assertRaises(DeployError):
            read_approved_patch(source)

    def installed(self):
        application = self.root / "application"
        package = application / "node_modules/.pnpm/picomatch@4.0.7/node_modules/picomatch"
        package.mkdir(parents=True)
        files = {"package.json": b'{"name":"picomatch","version":"4.0.7"}', "lib/parse.js": b"approved local repair"}
        for name, data in files.items():
            target = package / name
            target.parent.mkdir(exist_ok=True)
            target.write_bytes(data)
        declaration = {"patchSha256": "a" * 64, "files": {n: hashlib.sha256(b).hexdigest() for n, b in files.items()}}
        self.enterContext(patch("deploy.dependency_patch.approved_patch", return_value=declaration))
        return application, package

    def test_installed_proof_checks_full_bytes_not_only_version_or_patch_presence(self):
        application, package = self.installed()
        self.assertEqual(verify_installed_patch(application)["instances"], 1)
        (package / "lib/parse.js").write_bytes(b"original vulnerable code")
        with self.assertRaisesRegex(DeployError, "differs"):
            verify_installed_patch(application)

    def test_additional_unpatched_instance_or_unreviewed_files_are_rejected(self):
        application, package = self.installed()
        second = application / "node_modules/.pnpm/other/node_modules/picomatch"
        shutil.copytree(package, second)
        (second / "lib/parse.js").write_bytes(b"unpatched second instance")
        with self.assertRaisesRegex(DeployError, "differs"):
            verify_installed_patch(application)
        shutil.rmtree(second)
        (package / "unreviewed.js").write_bytes(b"unexpected")
        with self.assertRaisesRegex(DeployError, "unreviewed file"):
            verify_installed_patch(application)

    def test_package_local_shadow_is_verified_even_if_shared_store_copy_is_patched(self):
        application, package = self.installed()
        shadow = application / "node_modules/.pnpm/vite@8.3.5/node_modules/vite/node_modules/picomatch"
        shutil.copytree(package, shadow)
        (shadow / "lib/parse.js").write_bytes(b"vulnerable nested shadow")
        with self.assertRaisesRegex(DeployError, "differs"):
            verify_installed_patch(application)


if __name__ == "__main__":
    unittest.main()
