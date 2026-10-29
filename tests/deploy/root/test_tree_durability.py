"""Real Linux fsync descriptors; isolated files, no accounts/services/network."""
import hashlib
import io
import os
import stat
import sys
import tarfile
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import Mock, patch

from deploy.build import Builder, publish_release
from deploy.common import DeployError, Layout, digest, mkdir, write_json
from deploy.https import edge_binary
from deploy.safe_fs import durable_tree, extract_tar, inspect_tree, snapshot


def archive_bytes(name="package/bin/tool"):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        item = tarfile.TarInfo(name)
        item.mode, item.size = 0o755, len(b"runtime fixture")
        archive.addfile(item, io.BytesIO(b"runtime fixture"))
        link = tarfile.TarInfo(str(Path(name).parent / "alias"))
        link.type, link.linkname = tarfile.SYMTYPE, Path(name).name
        archive.addfile(link)
    return output.getvalue()


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "Real Linux root durability fixture")
class TreeDurabilityTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="durability-fixture-")
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.layout = Layout("fixture", self.root)

    def tree(self, path):
        mkdir(path / "nested/deep")
        mkdir(path / "empty")
        (path / "nested/deep/run").write_bytes(b"executable fixture")
        (path / "nested/deep/run").chmod(0o755)
        (path / "nested/link").symlink_to("deep/run")
        return path

    @contextmanager
    def syncing(self, fail=None):
        """Record actual open descriptors, preserving the real fsync syscall."""
        import fcntl
        actual = os.fsync
        events = []

        def sync(fd):
            path = Path(os.readlink(f"/proc/self/fd/{fd}"))
            details = os.fstat(fd)
            events.append(("sync", path, stat.S_IMODE(details.st_mode), fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE))
            if fail and fail(path):
                raise OSError("Injected durability failure")
            actual(fd)

        with patch("os.fsync", side_effect=sync):
            yield events

    def positions(self, events):
        return {value[1]: index for index, value in enumerate(events) if value[0] == "sync"}

    def test_syncs_files_read_only_then_all_directories_without_following_links(self):
        tree = self.tree(self.root / "tree")
        outside = self.root / "outside"
        outside.write_bytes(b"not in tree")
        (tree / "external").symlink_to(outside)
        (tree / "directory-link").symlink_to(self.root, target_is_directory=True)
        (tree / "dangling").symlink_to("absent")
        with self.syncing() as events:
            durable_tree(tree)
        paths = self.positions(events)
        self.assertEqual(set(paths), {tree, tree / "nested", tree / "nested/deep", tree / "nested/deep/run", tree / "empty"})
        self.assertLess(paths[tree / "nested/deep/run"], paths[tree / "nested/deep"])
        self.assertLess(paths[tree / "nested/deep"], paths[tree / "nested"])
        self.assertLess(paths[tree / "nested"], paths[tree])
        self.assertTrue(all(event[3] == os.O_RDONLY for event in events))
        self.assertEqual(next(event[2] for event in events if event[1].name == "run"), 0o755)

    def test_special_file_and_symlink_root_are_rejected(self):
        tree = self.tree(self.root / "tree")
        os.mkfifo(tree / "fifo")
        with self.assertRaises(DeployError):
            durable_tree(tree)
        (self.root / "root-link").symlink_to(tree, target_is_directory=True)
        with self.assertRaises(DeployError):
            durable_tree(self.root / "root-link")

    def test_traversal_and_fsync_errors_propagate(self):
        tree = self.tree(self.root / "tree")
        actual = os.scandir

        def listing(fd):
            if Path(os.readlink(f"/proc/self/fd/{fd}")) == tree / "nested":
                raise PermissionError("Injected enumeration failure")
            return actual(fd)

        with patch("deploy.safe_fs.os.scandir", side_effect=listing), self.assertRaises(PermissionError):
            durable_tree(tree)
        with self.syncing(lambda path: path == tree / "nested/deep") as events, self.assertRaises(OSError):
            durable_tree(tree)
        self.assertNotIn(tree, self.positions(events))

    def test_file_replaced_by_symlink_before_open_is_not_followed(self):
        tree = self.tree(self.root / "tree")
        outside = self.root / "outside"
        outside.write_bytes(b"must not sync")
        actual = os.open

        def opening(path, flags, *args, **kwargs):
            if path == "run":
                (tree / "nested/deep/run").unlink()
                (tree / "nested/deep/run").symlink_to(outside)
            return actual(path, flags, *args, **kwargs)

        with patch("deploy.safe_fs.os.open", side_effect=opening), self.syncing() as events, self.assertRaises(OSError):
            durable_tree(tree)
        self.assertNotIn(outside, self.positions(events))

    def test_snapshot_persists_final_modes_nested_entries_and_destination_parent(self):
        source = self.tree(self.root / "source")
        target = self.root / "copy"
        with self.syncing() as events:
            manifest = snapshot(source, target, producer_stopped=True)
        self.assertEqual(manifest, inspect_tree(target))
        positions = self.positions(events)
        self.assertLess(positions[target / "nested/deep/run"], positions[target / "nested/deep"])
        self.assertLess(positions[target / "nested/deep"], positions[target / "nested"])
        self.assertLess(positions[target / "nested"], positions[target])
        self.assertLess(positions[target], positions[target.parent])
        self.assertEqual(next(event[2] for event in events if event[1].name == "run"), 0o755)

    def test_extract_persists_modes_links_nested_directories_and_parent(self):
        archive = self.root / "runtime.tgz"
        archive.write_bytes(archive_bytes())
        target = self.root / "extracted"
        with self.syncing() as events:
            extract_tar(archive, target, strip=1)
        positions = self.positions(events)
        self.assertLess(positions[target / "bin/tool"], positions[target / "bin"])
        self.assertLess(positions[target / "bin"], positions[target])
        self.assertLess(positions[target], positions[target.parent])
        self.assertNotIn(target / "bin/alias", positions)
        self.assertEqual(next(event[2] for event in events if event[1].name == "tool"), 0o755)

    def test_import_flush_errors_do_not_return_success(self):
        source = self.tree(self.root / "source")
        archive = self.root / "runtime.tgz"
        archive.write_bytes(archive_bytes())
        for kind in ("snapshot", "extract"):
            target = self.root / kind
            with self.subTest(kind=kind), self.syncing(lambda path: path == target), self.assertRaises(OSError):
                if kind == "snapshot":
                    snapshot(source, target, producer_stopped=True)
                else:
                    extract_tar(archive, target)

    def release_fixture(self):
        mkdir(self.layout.app / "releases")
        mkdir(self.layout.config / "manifests")
        export = self.tree(self.root / "export")
        manifest = inspect_tree(export, root_owned=True)
        target = self.layout.app / "releases" / digest(manifest)
        return export, manifest, target, self.layout.config / "manifests" / (target.name + ".json")

    def test_release_flushes_composite_tree_and_both_rename_parents_before_manifest(self):
        export, manifest, target, record = self.release_fixture()
        with self.syncing() as events:
            def publish(path, value):
                positions = self.positions(events)
                self.assertTrue(target.exists())
                for expected in (export / "nested/deep/run", export / "nested/deep", export / "nested", export, export.parent, target.parent, self.layout.app):
                    self.assertIn(expected, positions)
                self.assertLess(positions[export], positions[target.parent])
                self.assertLess(positions[export], positions[export.parent])
                self.assertLess(positions[target.parent], positions[self.layout.app])
                write_json(path, value)
            with patch("deploy.build.write_json", side_effect=publish):
                self.assertEqual(publish_release(self.layout, export, manifest), target.name)
        self.assertTrue(record.exists())

    def test_release_fsync_failure_prevents_new_manifest_and_caller_activation(self):
        export, manifest, target, record = self.release_fixture()
        activate = Mock()
        with self.syncing(lambda path: path == export / "nested/deep"), self.assertRaises(OSError):
            release = publish_release(self.layout, export, manifest)
            activate(release)
        activate.assert_not_called()
        self.assertFalse(target.exists())
        self.assertFalse(record.exists())

    def test_existing_release_is_verified_and_flushed_before_manifest_recovery(self):
        export, manifest, target, record = self.release_fixture()
        export.rename(target)
        for failing in (True, False):
            with self.subTest(failing=failing), self.syncing(lambda path: failing and path == target / "nested/deep") as events:
                if failing:
                    with self.assertRaises(OSError):
                        publish_release(self.layout, export, manifest)
                    self.assertFalse(record.exists())
                else:
                    with patch("deploy.build.write_json", wraps=write_json) as publish:
                        self.assertEqual(publish_release(self.layout, export, manifest), target.name)
                    publish.assert_called_once()
                    self.assertIn(target / "nested/deep/run", self.positions(events))
                    self.assertLess(self.positions(events)[target], self.positions(events)[target.parent])

    def toolchain_fixture(self):
        mkdir(self.layout.config)
        builder = Builder(self.layout, Mock(), 0, 0)

        def download(url, target, *args):
            target.write_bytes(archive_bytes())
        return builder, download

    def test_toolchain_syncs_assembly_before_manifest_and_rename_parents_afterwards(self):
        builder, download = self.toolchain_fixture()
        root = self.layout.work / "toolchain"
        with patch("deploy.build.download", side_effect=download), patch("deploy.build.architecture", return_value="x64"), self.syncing() as events:
            def publish(path, value):
                assembled = next(self.layout.work.glob("tools-*/assembled"))
                positions = self.positions(events)
                self.assertIn(assembled, positions)
                self.assertIn(assembled / "node/bin/tool", positions)
                self.assertIn(self.layout.work.parent, positions)
                self.assertIn(self.layout.work.parent.parent, positions)
                self.assertFalse(root.exists())
                write_json(path, value)
            with patch("deploy.build.write_json", side_effect=publish):
                self.assertEqual(builder.toolchain(), root)
            self.assertEqual(events[-2][1], root.parent)
            self.assertEqual(events[-1][1], next(self.layout.work.glob("tools-*")))
        with self.syncing(lambda path: path == root / "node/bin"), self.assertRaises(OSError):
            builder.toolchain()

    def test_toolchain_sync_failure_prevents_manifest_and_rename(self):
        builder, download = self.toolchain_fixture()
        with patch("deploy.build.download", side_effect=download), patch("deploy.build.architecture", return_value="x64"), \
                self.syncing(lambda path: path.name == "assembled"), self.assertRaises(OSError):
            builder.toolchain()
        self.assertFalse((self.layout.config / "toolchain-manifest.json").exists())
        self.assertFalse((self.layout.work / "toolchain").exists())

    def edge_fixture(self):
        for directory in (self.layout.work, self.layout.control, self.layout.config):
            mkdir(directory)
        data = archive_bytes("caddy")
        response = io.BytesIO(data)
        response.url = "https://github.com/caddyserver/caddy/fixture"
        opener = Mock()
        opener.open.return_value = response
        return data, opener

    def test_edge_manifest_requires_durable_extracted_tree_and_container_parent(self):
        data, opener = self.edge_fixture()
        root = self.layout.control / "edge/caddy"
        with patch("deploy.https.urllib.request.build_opener", return_value=opener), \
                patch("deploy.https.architecture", return_value="x64"), \
                patch.dict("deploy.https.EDGE_HASHES", {("caddy", "amd64"): hashlib.sha256(data).hexdigest()}), self.syncing() as events:
            def publish(path, value):
                positions = self.positions(events)
                self.assertLess(positions[root / "caddy"], positions[root])
                self.assertLess(positions[root], positions[root.parent])
                self.assertLess(positions[root.parent], positions[root.parent.parent])
                write_json(path, value)
            with patch("deploy.https.write_json", side_effect=publish):
                self.assertEqual(edge_binary(self.layout, "caddy"), root / "caddy")
        with self.syncing(lambda path: path == root), self.assertRaises(OSError):
            edge_binary(self.layout, "caddy")

    def test_edge_extract_fsync_failure_does_not_publish_manifest(self):
        data, opener = self.edge_fixture()
        root = self.layout.control / "edge/caddy"
        with patch("deploy.https.urllib.request.build_opener", return_value=opener), \
                patch("deploy.https.architecture", return_value="x64"), \
                patch.dict("deploy.https.EDGE_HASHES", {("caddy", "amd64"): hashlib.sha256(data).hexdigest()}), \
                self.syncing(lambda path: path == root / "caddy"), self.assertRaises(OSError):
            edge_binary(self.layout, "caddy")
        self.assertFalse((self.layout.config / "caddy-binary.json").exists())


if __name__ == "__main__":
    unittest.main()
