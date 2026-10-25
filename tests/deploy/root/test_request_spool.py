"""Real root ownership and flock checks; no systemd calls or service changes."""
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

from deploy.common import DeployError, Layout, mkdir
from deploy.requests import RequestSpool


class StoppedSystem:
    def state(self, unit):
        return {"stopped": True}

    def stop(self, units):
        pass


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "Real Linux root ownership fixture")
class RootRequestSpoolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="root-request-spool-")
        self.addCleanup(self.temp.cleanup)
        self.layout = Layout("fixture", Path(self.temp.name))
        mkdir(self.layout.config, 0o700)
        mkdir(self.layout.state / "requests", 0o700)
        self.spool = RequestSpool(self.layout, StoppedSystem())
        self.request = {"method": "restart", "params": {}, "operationId": str(uuid.uuid4())}

    def test_root_private_files_use_real_independent_nonblocking_locks(self):
        with self.spool.stage(self.request) as ident:
            with self.assertRaises(DeployError) as caught:
                with self.spool.stage(self.request):
                    self.fail("admitted a second waiter")
            self.assertEqual(caught.exception.code, "busy")
            self.assertEqual(self.spool.load(ident), self.request)
            self.spool.publish(ident, {"ok": True})
            for path in (self.spool.root / ident).iterdir():
                info = path.stat()
                self.assertEqual(info.st_uid, 0)
                self.assertEqual(info.st_mode & 0o777, 0o600)
            self.assertTrue(self.spool.finish(ident)["ok"])
        self.assertEqual(list(self.spool.root.iterdir()), [])

    def test_foreign_owner_open_mode_links_and_symlinks_are_not_collectable(self):
        with self.spool.stage(self.request) as ident:
            pass
        path = self.spool.root / ident / "request.json"
        original = path.read_bytes()
        for defect in ("owner", "mode", "hardlink", "symlink"):
            with self.subTest(defect=defect):
                other = self.layout.config / "fixture-copy"
                if defect == "owner":
                    os.chown(path, 65534, 65534)
                elif defect == "mode":
                    path.chmod(0o640)
                elif defect == "hardlink":
                    os.link(path, other)
                else:
                    path.rename(other)
                    path.symlink_to(other)
                with self.assertRaises(DeployError) as caught:
                    self.spool.finish(ident)
                self.assertEqual(caught.exception.code, "recovery_required")
                self.assertEqual(path.read_bytes(), original)
                if defect == "owner":
                    os.chown(path, 0, 0)
                elif defect == "mode":
                    path.chmod(0o600)
                elif defect == "hardlink":
                    other.unlink()
                else:
                    path.unlink()
                    other.rename(path)
        self.spool.finish(ident)


if __name__ == "__main__":
    unittest.main()
