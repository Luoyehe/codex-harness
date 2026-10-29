"""Portable creation-plan and identity reservation checks; no privileged writes."""
import contextlib
import os
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy.common import DeployError, Layout
from deploy.install_recovery import CreationPlan, ensure_identities, identity_plan


class CreationPlanTests(unittest.TestCase):
    def test_changed_file_is_rejected_without_overwrite(self):
        with tempfile.TemporaryDirectory() as folder:
            layout = Layout("fixture", Path(folder))
            plan = CreationPlan(layout, {"id": "a" * 32})
            path = Path(folder) / "owned"
            uid = os.getuid() if hasattr(os, "getuid") else 0
            gid = os.getgid() if hasattr(os, "getgid") else 0
            plan.file(path, b"original", 0o600, uid, gid)
            plan.publish(path)
            path.write_bytes(b"changed")
            with self.assertRaises(DeployError): plan.publish(path)
            self.assertEqual(path.read_bytes(), b"changed")

    def test_creation_does_not_replace_foreign_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            layout = Layout("fixture", Path(folder))
            plan = CreationPlan(layout, {"id": "a" * 32})
            path = Path(folder) / "foreign"
            path.write_bytes(b"retain")
            plan.directory(path, 0o700)
            with self.assertRaises(DeployError): plan.publish(path)
            self.assertEqual(path.read_bytes(), b"retain")


class IdentityPlanTests(unittest.TestCase):
    def setUp(self):
        self.users, self.groups = [], []
        def lookup(items, field, name):
            for item in items:
                if getattr(item, field) == name: return item
            raise KeyError(name)
        self.modules = patch.dict("sys.modules", {"pwd": types.SimpleNamespace(getpwall=lambda: self.users, getpwnam=lambda name: lookup(self.users, "pw_name", name)),
                                                  "grp": types.SimpleNamespace(getgrall=lambda: self.groups, getgrnam=lambda name: lookup(self.groups, "gr_name", name))})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        self.layout = Layout("fixture", Path("/fixture"))

    def command(self, argv):
        if argv[0].endswith("groupadd"):
            self.groups.append(types.SimpleNamespace(gr_name=argv[-1], gr_gid=int(argv[argv.index("--gid") + 1]), gr_mem=[]))
        else:
            group = argv[argv.index("--gid") + 1]
            gid = int(group) if group.isdigit() else next(item.gr_gid for item in self.groups if item.gr_name == group)
            self.users.append(types.SimpleNamespace(pw_name=argv[-1], pw_uid=int(argv[argv.index("--uid") + 1]),
                              pw_gid=gid, pw_dir=argv[argv.index("--home-dir") + 1],
                              pw_shell="/usr/sbin/nologin"))

    def test_exact_reserved_ids_resume_after_groupadd_interruption(self):
        plan = identity_plan(self.layout)
        def interrupt(argv):
            self.command(argv)
            raise KeyboardInterrupt("power loss after groupadd")
        with patch("deploy.install_recovery.run", side_effect=interrupt), self.assertRaises(KeyboardInterrupt): ensure_identities(plan)
        with patch("deploy.install_recovery.run", side_effect=self.command): ensure_identities(plan)
        self.assertEqual(len(self.groups), 5)
        self.assertEqual(len(self.users), 4)
        self.assertEqual({user.pw_uid for user in self.users}, {entry["uid"] for entry in plan.values() if "uid" in entry})

    def test_existing_matching_name_does_not_authorize_a_new_install(self):
        self.groups.append(types.SimpleNamespace(gr_name="ch-fixture-worker", gr_gid=800, gr_mem=[]))
        with self.assertRaises(DeployError): identity_plan(self.layout)

    def test_reserved_id_reassigned_to_another_account_is_rejected(self):
        plan = identity_plan(self.layout)
        self.groups.append(types.SimpleNamespace(gr_name="foreign", gr_gid=plan["gateway"]["gid"], gr_mem=[]))
        with patch("deploy.install_recovery.run") as run, self.assertRaises(DeployError): ensure_identities(plan)
        run.assert_not_called()

    def test_another_unfinished_instance_keeps_its_numeric_reservations(self):
        first = identity_plan(self.layout)
        reserved = ({entry["uid"] for entry in first.values() if "uid" in entry}, {entry["gid"] for entry in first.values()})
        second = identity_plan(Layout("second", self.layout.root), reserved)
        self.assertTrue(reserved[0].isdisjoint(entry["uid"] for entry in second.values() if "uid" in entry))
        self.assertTrue(reserved[1].isdisjoint(entry["gid"] for entry in second.values()))
        with patch("deploy.install_recovery.run", side_effect=self.command):
            ensure_identities(second)
            ensure_identities(first)
        self.assertEqual(len(self.users), 8)
        self.assertEqual(len(self.groups), 10)

    def test_edge_account_allocator_respects_other_initialization_reservations(self):
        from deploy.install import ensure_account
        first = identity_plan(self.layout)
        reserved = ({entry["uid"] for entry in first.values() if "uid" in entry}, {entry["gid"] for entry in first.values()})
        with patch("deploy.install_recovery.root_lock", return_value=contextlib.nullcontext()), \
             patch("deploy.install_recovery.reserved_identities", return_value=reserved), \
             patch("deploy.install.run", side_effect=self.command):
            uid, gid = ensure_account("ch-second-edge", Path("/fixture/second/caddy"))
        self.assertNotIn(uid, reserved[0])
        self.assertNotIn(gid, reserved[1])
        with patch("deploy.install_recovery.run", side_effect=self.command): ensure_identities(first)
        self.assertEqual(len(self.users), 5)
        self.assertEqual(len(self.groups), 6)


if __name__ == "__main__": unittest.main()
