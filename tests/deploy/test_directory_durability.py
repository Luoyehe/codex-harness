"""Directory publication ordering with real files; no service or network calls."""
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy import common
from deploy.common import DeployError, Layout, durable_directory, mkdir
from deploy.https import stage_tls, stage_tls_ca
from deploy.install_recovery import CreationPlan
from deploy.provider_lifecycle import Profiles


class DirectoryDurabilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).absolute()

    def capture(self, events, fail=None):
        original = common.fsync_directory
        def sync(path, **kwargs):
            events.append(Path(path))
            if path == fail:
                raise OSError("Injected directory publication failure")
            return original(path, **kwargs)
        return patch("deploy.common.fsync_directory", side_effect=sync)

    def test_first_hierarchy_and_existing_retry_sync_every_ancestor_bottom_up(self):
        target = self.root / "shared/collection/generation"
        expected = [target, *target.parents]
        for attempt in range(2):
            events = []
            with self.subTest(attempt=attempt), self.capture(events):
                mkdir(target, 0o700)
            self.assertEqual(events, expected)

    def test_parent_failure_is_retried_even_when_all_names_already_exist(self):
        target = self.root / "shared/collection/generation"
        failed = target.parent.parent
        events = []
        with self.capture(events, failed), self.assertRaises(OSError):
            mkdir(target, 0o700)
        self.assertTrue(target.is_dir())
        self.assertEqual(events, [target, target.parent, failed])
        with self.capture([], failed), self.assertRaises(OSError):
            mkdir(target, 0o700)
        events = []
        with self.capture(events):
            mkdir(target, 0o700)
        self.assertEqual(events, [target, *target.parents])

    def test_shared_existing_parent_metadata_is_unchanged(self):
        parent = self.root / "shared"
        parent.mkdir(mode=0o750)
        os.chmod(parent, 0o750)
        before = parent.stat()
        durable_directory(parent, create=True)
        mkdir(parent / "private", 0o700)
        after = parent.stat()
        self.assertEqual(stat.S_IMODE(after.st_mode), stat.S_IMODE(before.st_mode))
        self.assertEqual((after.st_uid, after.st_gid), (before.st_uid, before.st_gid))

    def test_sync_only_never_adopts_a_missing_path_or_traverses_parent_components(self):
        missing = self.root / "missing"
        with self.assertRaises(FileNotFoundError):
            durable_directory(missing)
        self.assertFalse(missing.exists())
        with self.assertRaises(DeployError):
            durable_directory(self.root / "missing/../outside", create=True)
        self.assertFalse(missing.exists())

    def test_tls_and_ca_generation_barriers_precede_any_file_publication(self):
        layout = Layout("fixture", self.root)
        mkdir(layout.config)
        for kind in ("tls", "tls-ca"):
            collection = layout.config / kind
            events = []
            original_sync, original_write = common.fsync_directory, common.atomic_write
            def sync(path, **kwargs):
                if path == collection and collection.exists() and list(collection.iterdir()):
                    events.append("generation-parent")
                return original_sync(path, **kwargs)
            def write(path, *args, **kwargs):
                self.assertIn("generation-parent", events)
                events.append("file")
                return original_write(path, *args, **kwargs)
            def stage():
                return stage_tls(layout, b"public fixture", b"private fixture", 0) if kind == "tls" else stage_tls_ca(layout, b"public CA fixture")
            with self.subTest(kind=kind), patch("deploy.https.ssl.SSLContext"), \
                 patch("deploy.common.os.fchown", create=True), \
                 patch("deploy.common.fsync_directory", side_effect=sync), patch("deploy.https.atomic_write", side_effect=write):
                self.assertTrue(stage())
            self.assertIn("file", events)
            with self.subTest(kind=kind, failure=True), patch("deploy.https.ssl.SSLContext"), \
                 patch("deploy.common.os.fchown", create=True), self.capture([], collection), \
                 patch("deploy.https.atomic_write") as writer, self.assertRaises(OSError):
                stage()
            writer.assert_not_called()

    def test_first_profile_parent_barrier_precedes_success_and_retries_existing_root(self):
        layout = Layout("fixture", self.root)
        mkdir(layout.config)
        profiles = Profiles(layout)
        with self.capture([], layout.config), self.assertRaises(OSError):
            profiles.save("first", {"kind": "chatgpt"})
        self.assertTrue(profiles.root.is_dir())
        self.assertEqual(list(profiles.root.iterdir()), [])
        events = []
        with self.capture(events):
            profiles.save("first", {"kind": "chatgpt"})
        self.assertIn(layout.config, events)
        self.assertEqual(len(profiles.records()), 1)

    def test_creation_plan_existing_entries_reestablish_publication_before_return(self):
        layout = Layout("fixture", self.root)
        plan = CreationPlan(layout, {"id": "a" * 32})
        uid = os.getuid() if hasattr(os, "getuid") else 0
        gid = os.getgid() if hasattr(os, "getgid") else 0
        directory = self.root / "owned"
        plan.directory(directory, 0o700, uid, gid)
        plan.publish(directory)
        file = directory / "record"
        plan.file(file, b"retained", 0o600, uid, gid)
        plan.publish(file)
        for target in (directory, file):
            events = []
            with self.subTest(target=target.name), self.capture(events, self.root), self.assertRaises(OSError):
                plan.publish(target)
            self.assertEqual(events, [directory, self.root])
            self.assertEqual(file.read_bytes(), b"retained")


if __name__ == "__main__":
    unittest.main()
