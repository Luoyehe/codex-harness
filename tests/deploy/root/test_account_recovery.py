"""Authentication compatibility during failed application activation and repair."""
import os
import sys
import unittest
from unittest.mock import patch

from deploy.common import DeployError, digest, mkdir, read_json, write_json
from deploy.manager import Manager
from deploy.safe_fs import inspect_tree
from tests.deploy import test_install_recovery as recovery_fixture


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "Real Linux root ownership fixture")
class AccountRecoveryTests(unittest.TestCase):
    def setUp(self):
        fixture = recovery_fixture.InstallationRecoveryTests("test_prepare_retry_completes_enable_then_preserves_later_disabled_state")
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.layout, self.manager, self.system = fixture.layout, fixture.manager, fixture.system
        # Use full real release manifests; only system/process execution is fake.
        self.manager.verify_release = Manager.verify_release.__get__(self.manager)
        self.started = []
        original = self.system.start
        def start(units):
            self.started.append(self.manager.selected())
            original(units)
        self.system.start = start

    def release(self, name, accounts):
        staging = self.layout.app / "releases" / ("staged-" + name)
        mkdir(staging / "app")
        package = {"name": name}
        if accounts:
            package["harnessAuthentication"] = "account-v1"
        write_json(staging / "app/package.json", package, mode=0o644)
        manifest = inspect_tree(staging, root_owned=True)
        identity = digest(manifest)
        staging.rename(staging.parent / identity)
        mkdir(self.layout.config / "manifests")
        write_json(self.layout.config / "manifests" / (identity + ".json"), manifest)
        return identity

    def initial(self, accounts):
        old = self.release("previous", accounts)
        self.manager.select(old)
        write_json(self.layout.config / "installation.json", {"format": 1, "phase": "complete", "release": old})
        self.system.active = set(self.manager.service_units)
        return old

    def journal(self):
        return next((self.layout.state / "transactions").glob("*/state.json"))

    def test_failed_account_candidate_retains_selected_tree_and_stopped_services_instead_of_legacy_restore(self):
        old = self.initial(False)
        candidate = self.release("candidate", True)
        with patch.object(self.manager, "healthy", side_effect=DeployError("health", "Injected startup failure")), self.assertRaises(DeployError) as caught:
            self.manager.activate(candidate)
        self.assertEqual(caught.exception.code, "authentication_downgrade")
        self.assertIn("Services remain stopped", str(caught.exception))
        self.assertEqual(self.manager.selected(), candidate)
        self.assertEqual(self.system.active, set())
        self.assertEqual(self.started, [candidate])
        self.assertEqual(read_json(self.journal())["phase"], "selected")
        self.assertTrue((self.layout.app / "releases" / old).exists())
        self.assertFalse((self.layout.state / "gateway/auth.sqlite").exists())

    def test_repair_rejects_legacy_auth_restore_after_interrupting_account_candidate(self):
        self.initial(False)
        candidate = self.release("candidate", True)
        with patch.object(self.manager, "healthy", side_effect=KeyboardInterrupt()), self.assertRaises(KeyboardInterrupt):
            self.manager.activate(candidate)
        before = self.journal().read_bytes()
        with self.assertRaises(DeployError) as caught:
            self.manager.repair()
        self.assertEqual(caught.exception.code, "authentication_downgrade")
        self.assertEqual(self.manager.selected(), candidate)
        self.assertEqual(self.started, [candidate])
        self.assertEqual(self.system.active, set())
        self.assertEqual(self.journal().read_bytes(), before)

    def test_compatible_account_candidate_failure_restores_prior_account_release(self):
        old = self.initial(True)
        candidate = self.release("candidate", True)
        with patch.object(self.manager, "healthy", side_effect=[DeployError("health", "Injected startup failure"), None]), self.assertRaises(DeployError):
            self.manager.activate(candidate)
        self.assertEqual(self.manager.selected(), old)
        self.assertEqual(self.started, [candidate, old])
        self.assertEqual(self.system.active, set(self.manager.service_units))
        self.assertEqual(read_json(self.journal())["phase"], "recovered")

    def test_compatible_account_repair_restores_prior_account_release(self):
        old = self.initial(True)
        candidate = self.release("candidate", True)
        with patch.object(self.manager, "healthy", side_effect=KeyboardInterrupt()), self.assertRaises(KeyboardInterrupt):
            self.manager.activate(candidate)
        result = self.manager.repair()
        self.assertEqual(result, {"repaired": True, "recoveredTransactions": 1})
        self.assertEqual(self.manager.selected(), old)
        self.assertEqual(self.started, [candidate, old])
        self.assertEqual(read_json(self.journal())["phase"], "recovered")

    def test_explicit_candidate_repair_finishes_blocked_legacy_to_account_upgrade(self):
        old = self.initial(False)
        candidate = self.release("candidate", True)
        with patch.object(self.manager, "healthy", side_effect=KeyboardInterrupt()), self.assertRaises(KeyboardInterrupt):
            self.manager.activate(candidate)
        result = self.manager.repair(target="candidate")
        self.assertEqual(result["target"], "candidate")
        self.assertEqual(self.manager.selected(), candidate)
        self.assertEqual(self.manager.selected("previous"), old)
        self.assertEqual(self.started, [candidate, candidate])
        self.assertEqual(read_json(self.journal())["phase"], "committed")

    def test_candidate_repair_health_failure_stops_and_retries_same_candidate_only(self):
        self.initial(False)
        candidate = self.release("candidate", True)
        with patch.object(self.manager, "healthy", side_effect=KeyboardInterrupt()), self.assertRaises(KeyboardInterrupt):
            self.manager.activate(candidate)
        with patch.object(self.manager, "healthy", side_effect=DeployError("health", "Still unavailable")), self.assertRaises(DeployError):
            self.manager.repair(target="candidate")
        self.assertEqual(self.system.active, set())
        self.assertEqual(self.manager.selected(), candidate)
        self.assertEqual(read_json(self.journal())["phase"], "selected")
        self.manager.repair(target="candidate")
        self.assertEqual(read_json(self.journal())["phase"], "committed")
        self.assertEqual(self.started, [candidate, candidate, candidate])

    def test_candidate_repair_can_resume_after_selection_record_interruption(self):
        self.initial(False)
        candidate = self.release("candidate", True)
        with patch.object(self.manager, "healthy", side_effect=KeyboardInterrupt()), self.assertRaises(KeyboardInterrupt):
            self.manager.activate(candidate)
        def interrupted_write(path, value, **kwargs):
            write_json(path, value, **kwargs)
            if value.get("phase") == "selected":
                raise KeyboardInterrupt()
        with patch("deploy.manager.write_json", side_effect=interrupted_write), self.assertRaises(KeyboardInterrupt):
            self.manager.repair(target="candidate")
        self.assertEqual(self.system.active, set())
        self.manager.repair(target="candidate")
        self.assertEqual(read_json(self.journal())["phase"], "committed")
        self.assertEqual(self.manager.selected(), candidate)

    def test_missing_candidate_file_rejects_candidate_repair_before_stop(self):
        self.initial(False)
        candidate = self.release("candidate", True)
        with patch.object(self.manager, "healthy", side_effect=KeyboardInterrupt()), self.assertRaises(KeyboardInterrupt):
            self.manager.activate(candidate)
        (self.layout.app / "releases" / candidate / "app/package.json").unlink()
        before = self.journal().read_bytes()
        self.system.events.clear()
        with self.assertRaises(DeployError):
            self.manager.repair(target="candidate")
        self.assertEqual(self.system.events, [])
        self.assertEqual(self.journal().read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
