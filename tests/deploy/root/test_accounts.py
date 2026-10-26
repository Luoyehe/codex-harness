"""Root-owned account bootstrap and recovery publication checks."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from deploy.accounts import bootstrap, configure_account, verify_bootstrap, write_bootstrap
from deploy.common import DeployError, Layout, mkdir, read_json


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "Real Linux root ownership fixture")
class AccountPublicationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.layout = Layout("fixture", Path(self.temporary.name))
        mkdir(self.layout.config)
        self.manager = SimpleNamespace(layout=self.layout, config={"gatewayGid": 1},
                                       require_recovered_transactions=Mock(), require_service_ownership=Mock())

    def tearDown(self):
        self.temporary.cleanup()

    def test_setup_publishes_private_hash_and_existing_account_is_not_overwritten(self):
        with patch("deploy.accounts.account_request", return_value=({"authenticationMode": "account", "initialized": False}, None)), \
             patch("deploy.accounts.verify_account_login"):
            result = configure_account(self.manager, "admin", "synthetic-password")
        self.assertTrue(result["loginVerified"])
        target = self.layout.config / "auth-bootstrap.json"
        self.assertEqual(target.stat().st_mode & 0o777, 0o640)
        self.assertEqual((target.stat().st_uid, target.stat().st_gid), (0, 1))
        original = target.read_bytes()
        self.assertNotIn(b"synthetic-password", original)
        self.assertTrue(verify_bootstrap(self.layout, self.manager.config))
        with patch("deploy.accounts.account_request", return_value=({"authenticationMode": "account", "initialized": True}, None)), self.assertRaises(DeployError):
            configure_account(self.manager, "admin", "replacement-password")
        self.assertEqual(target.read_bytes(), original)

    def test_unconfirmed_reset_keeps_new_revision_and_reports_pending_without_automatic_retry(self):
        old = bootstrap("admin", "synthetic-old-password")
        write_bootstrap(self.layout, self.manager.config, old)
        with patch("deploy.accounts.verify_account_login", side_effect=DeployError("account_verification", "Offline")) as login:
            result = configure_account(self.manager, "operator", "synthetic-new-password", reset=True)
        new = read_json(self.layout.config / "auth-bootstrap.json")
        self.assertFalse(result["loginVerified"])
        self.assertNotEqual(new["revision"], old["revision"])
        self.assertEqual(new["username"], "operator")
        login.assert_called_once()

    def test_bootstrap_symlink_or_wrong_owner_never_gets_replaced(self):
        value = bootstrap("admin", "synthetic-password")
        target = self.layout.config / "auth-bootstrap.json"
        elsewhere = self.layout.config / "unrelated"
        elsewhere.write_bytes(b"preserved")
        target.symlink_to(elsewhere)
        with self.assertRaises(DeployError):
            write_bootstrap(self.layout, self.manager.config, value)
        self.assertEqual(elsewhere.read_bytes(), b"preserved")
        target.unlink()
        write_bootstrap(self.layout, self.manager.config, value)
        target.chmod(0o644)
        with self.assertRaises(DeployError):
            verify_bootstrap(self.layout, self.manager.config)
        with self.assertRaises(DeployError):
            write_bootstrap(self.layout, self.manager.config, value)


if __name__ == "__main__":
    unittest.main()
