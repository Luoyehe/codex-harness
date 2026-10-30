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
from deploy.common import DeployError, digest, read_json, write_json
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
        code = "import fcntl,sys; f=open(sys.argv[1],'a+b'); fcntl.flock(f,fcntl.LOCK_EX); print('locked',flush=True); sys.stdin.read()"
        child = subprocess.Popen([sys.executable, "-I", "-B", "-c", code, str(lock)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "locked")
            lock.chmod(0o600)
            with self.assertRaises(DeployError) as raised:
                self.perform()
            self.assertEqual(raised.exception.code, "busy")
            self.assertEqual(self.system.events, [])
            self.assertTrue(self.source.exists())
        finally:
            child.stdin.close()
            child.wait(timeout=5)
            child.stdout.close()

    def test_retained_image_is_never_archived(self):
        (self.source / "build.ext4").write_bytes(b"uncertain image")
        with self.assertRaisesRegex(DeployError, "image"):
            self.perform()
        self.assertEqual(self.system.events, [])
        self.assertTrue(self.source.exists())


if __name__ == "__main__":
    unittest.main()
