"""Real Linux ownership and DNS generation checks; no host services or network."""
import errno
import hashlib
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from deploy.common import DeployError, Layout, digest, mkdir, write_json
from deploy.dns_caddy_build import (PROVIDER_PINS, dns_caddy_path, provision_dns_caddy, recipe, source_material,
                                    verify_dns_caddy_generations)


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "Requires real Linux root ownership fixtures")
class DnsCaddyBuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.layout = Layout("fixture", Path(self.temp.name))
        mkdir(self.layout.control / "edge/caddy", 0o755)
        mkdir(self.layout.work, 0o755)
        self.assert_root_chain(self.layout.control / "edge/caddy")
        self.assert_root_chain(self.layout.work)

    def assert_root_chain(self, path):
        for directory in (path, *path.parents):
            info = directory.lstat()
            self.assertTrue(stat.S_ISDIR(info.st_mode), directory)
            self.assertEqual(info.st_uid, 0, directory)
            self.assertEqual(info.st_mode & 0o022, 0, directory)
            if directory == self.layout.root:
                return
        self.fail("Fixture path must stay inside its temporary root")

    def generation(self, value=None, provider="alidns"):
        value = recipe("amd64") if value is None else value
        revision = digest(value)
        root = self.layout.control / "edge/caddy/dns" / revision
        mkdir(root, 0o755)
        binary = root / "caddy"
        binary.write_bytes(b"fixture executable")
        binary.chmod(0o755)
        sha = hashlib.sha256(binary.read_bytes()).hexdigest()
        write_json(root / "manifest.json", {"format": 1, "recipe": value, "sha256": sha})
        metadata = {"dnsBinaryRevision": revision, "dnsBinarySha256": sha, "dnsProvider": provider}
        self.assert_root_chain(root)
        for path in (binary, root / "manifest.json"):
            info = path.lstat()
            self.assertTrue(stat.S_ISREG(info.st_mode), path)
            self.assertEqual(info.st_uid, 0, path)
            self.assertEqual(info.st_nlink, 1, path)
            self.assertEqual(info.st_mode & 0o022, 0, path)
        # Every corruption starts from a generation accepted by the real checks.
        self.assertEqual(dns_caddy_path(self.layout, metadata), binary)
        verify_dns_caddy_generations(self.layout)
        return root, metadata

    def test_initial_install_accepts_only_exact_pinned_user_owned_recipe(self):
        original = source_material()
        package = self.layout.root / "ordinary-checkout/deploy"
        source = package / "caddy_dns_source"
        mkdir(source, 0o755)
        for name, data in original.items():
            (source / name).write_bytes(data)
        for path in (package.parent, package, source, *(source / name for name in original)):
            os.chown(path, 65534, 65534)
            self.assertEqual((path.stat().st_uid, path.stat().st_gid), (65534, 65534))
        with patch("deploy.dns_caddy_build.__file__", str(package / "dns_caddy_build.py")):
            self.assertEqual(source_material(), original)
            (source / "main.go").write_bytes(original["main.go"] + b"// changed\n")
            self.assertEqual((source / "main.go").stat().st_uid, 65534)
            with self.assertRaisesRegex(DeployError, "differs from reviewed recipe"):
                source_material()

    def test_existing_binary_reuse_checks_manifest_and_selection(self):
        root, metadata = self.generation()
        manager = SimpleNamespace(layout=self.layout, config={}, system=Mock())
        with patch("deploy.dns_caddy_build.architecture", return_value="x64"):
            self.assertEqual(provision_dns_caddy(manager), {key: value for key, value in metadata.items() if key != "dnsProvider"})
        manager.system.isolated.assert_not_called()
        self.assertEqual(dns_caddy_path(self.layout, metadata), root / "caddy")
        with self.assertRaisesRegex(DeployError, "selection changed"):
            dns_caddy_path(self.layout, {**metadata, "dnsBinarySha256": "0" * 64})

    def test_changed_binary_or_recipe_is_rejected(self):
        root, metadata = self.generation()
        (root / "caddy").write_bytes(b"changed executable")
        with self.assertRaisesRegex(DeployError, "binary changed"):
            dns_caddy_path(self.layout, metadata)
        record = json.loads((root / "manifest.json").read_text())
        record["recipe"]["providers"]["alidns"]["version"] = "v9.9.9"
        write_json(root / "manifest.json", record)
        with self.assertRaisesRegex(DeployError, "recipe binding"):
            verify_dns_caddy_generations(self.layout)

    def test_selected_provider_is_bound_to_each_retained_generation(self):
        current = recipe("amd64")
        legacy = {key: value for key, value in current.items() if key != "providers"}
        legacy.update(format=1, provider="alidns", providerVersion="1.0.29")
        old_root, old_metadata = self.generation(legacy)
        root, metadata = self.generation(current)
        verify_dns_caddy_generations(self.layout)
        self.assertEqual(dns_caddy_path(self.layout, old_metadata), old_root / "caddy")
        for name in PROVIDER_PINS:
            self.assertEqual(dns_caddy_path(self.layout, {**metadata, "dnsProvider": name}), root / "caddy")
        for chosen in ("cloudflare", "tencentcloud", None):
            with self.subTest(chosen=chosen), self.assertRaisesRegex(DeployError, "absent from this Caddy generation"):
                dns_caddy_path(self.layout, {**old_metadata, "dnsProvider": chosen})
        subset = {**current, "providers": {"cloudflare": current["providers"]["cloudflare"]}}
        _, selected = self.generation(subset, "cloudflare")
        with self.assertRaisesRegex(DeployError, "absent from this Caddy generation"):
            dns_caddy_path(self.layout, {**selected, "dnsProvider": "alidns"})

    def test_extra_entries_and_unselected_corrupt_generations_fail_closed(self):
        root, metadata = self.generation()
        (root / "other").write_text("unexpected")
        with self.assertRaisesRegex(DeployError, "generation entry"):
            verify_dns_caddy_generations(self.layout)
        (root / "other").unlink()
        other = root.parent / ("0" * 64)
        mkdir(other, 0o755)
        self.assert_root_chain(other)
        self.assertEqual(dns_caddy_path(self.layout, metadata), root / "caddy")
        with self.assertRaisesRegex(DeployError, "generation entry"):
            verify_dns_caddy_generations(self.layout)

    def test_symlinked_generation_file_is_rejected(self):
        root, metadata = self.generation()
        outside = self.layout.root / "outside"
        outside.write_bytes((root / "caddy").read_bytes())
        outside.chmod(0o755)
        (root / "caddy").unlink()
        (root / "caddy").symlink_to(outside)
        self.assertTrue((root / "caddy").is_symlink())
        self.assert_root_chain(root)
        with self.assertRaises(OSError) as caught:
            dns_caddy_path(self.layout, metadata)
        self.assertEqual(caught.exception.errno, errno.ELOOP)
        self.assertEqual(caught.exception.filename, str(root / "caddy"))

    def test_build_failure_does_not_publish_generation(self):
        manager = SimpleNamespace(layout=self.layout, config={"buildUid": 999, "buildGid": 999}, system=Mock())
        manager.system.isolated.side_effect = DeployError("candidate_failed", "fixture fetch failure")

        def fake_extract(archive, destination, strip):
            mkdir(destination / "bin", 0o755)
            (destination / "bin/go").write_bytes(b"fixture go")
            (destination / "bin/go").chmod(0o755)

        def fake_workspace(builder, path, gib):
            mkdir(path, 0o755, builder.uid, builder.gid)
            image = path.with_suffix(".ext4")
            image.write_bytes(b"retained image")
            return image

        # Only external download/toolchain/mount work is substituted. Ownership
        # setup and generation verification use the actual filesystem operations.
        with patch("deploy.dns_caddy_build.architecture", return_value="x64"), \
             patch("deploy.dns_caddy_build._download_go"), \
             patch("deploy.dns_caddy_build.extract_tar", side_effect=fake_extract), \
             patch("deploy.dns_caddy_build.Builder.bounded_workspace", new=fake_workspace):
            with self.assertRaisesRegex(DeployError, "fixture fetch failure"):
                provision_dns_caddy(manager)
        self.assertEqual(manager.system.isolated.call_count, 3)
        for call in manager.system.isolated.call_args_list:
            self.assertTrue(call.args[1].startswith("dns-fetch-"))
        self.assertFalse((self.layout.control / "edge/caddy/dns").exists())
        images = list(self.layout.work.glob("dns-build-*/work.ext4"))
        self.assertEqual(len(images), 1)
        self.assertEqual(images[0].read_bytes(), b"retained image")
        for name in ("work", "work/tmp", "work/output"):
            info = (images[0].parent / name).stat()
            self.assertEqual((info.st_uid, info.st_gid), (999, 999))


if __name__ == "__main__":
    unittest.main()
