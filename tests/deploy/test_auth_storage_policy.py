"""Managed file-store admission does not read or mutate any credential store."""
import os
import tempfile
import unittest
from pathlib import Path

from deploy.auth_storage_policy import check_file, require_file_store, validate_document
from deploy.common import DeployError, Layout


class AuthenticationStoragePolicyTests(unittest.TestCase):
    def test_default_and_explicit_file_are_accepted(self):
        for document in ({}, {"cli_auth_credentials_store": "file"}, {"profiles": {"work": {"cli_auth_credentials_store": "file"}}}):
            validate_document(document)

    def test_nonfile_or_malformed_store_is_not_silently_overridden(self):
        for value in ("keyring", "auto", "ephemeral", "unknown", True, None):
            for document in ({"cli_auth_credentials_store": value}, {"profiles": {"work": {"cli_auth_credentials_store": value}}}):
                with self.subTest(value=value, document=document), self.assertRaises(DeployError) as error:
                    validate_document(document)
                self.assertEqual(error.exception.code, "auth_store_unsupported")
                self.assertIn("不会自动读取或迁移 keyring", str(error.exception))

    def test_instance_home_system_requirement_and_profile_are_checked_without_writes(self):
        with tempfile.TemporaryDirectory() as folder:
            layout = Layout("fixture", Path(folder))
            home = layout.state / "worker/codex"
            for path in (home / "config.toml", layout.root / "etc/codex/requirements.toml",
                         layout.config / "providers/current/system-config.toml", home.parent / ".codex/config.toml"):
                path.parent.mkdir(parents=True, exist_ok=True)
                data = b'[profiles.work]\ncli_auth_credentials_store = "keyring"\n'
                path.write_bytes(data)
                with self.assertRaises(DeployError):
                    require_file_store(layout, home, os.getuid() if os.name == "posix" else 0)
                self.assertEqual(path.read_bytes(), data)
                path.unlink()

    def test_parse_errors_do_not_echo_configuration_or_secret_content(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "config.toml"
            path.write_bytes(b'api_key = "fixture-secret-marker\n')
            with self.assertRaises(DeployError) as error:
                check_file(path, os.getuid() if os.name == "posix" else 0)
            self.assertNotIn("fixture-secret-marker", str(error.exception))

    def test_generated_layers_above_host_budget_are_read_in_full_in_both_views(self):
        with tempfile.TemporaryDirectory() as folder:
            layout = Layout("fixture", Path(folder))
            home = layout.state / "worker/codex"
            uid = os.getuid() if os.name == "posix" else 0
            padding = b"#" + b"x" * (1024 * 1024) + b"\n"
            for path in (layout.root / "etc/codex/config.toml", layout.root / "etc/codex/requirements.toml",
                         layout.config / "providers/current/system-config.toml", layout.config / "providers/current/requirements.toml"):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(padding + b'cli_auth_credentials_store = "file"\n')
                require_file_store(layout, home, uid)
                path.write_bytes(padding + b'cli_auth_credentials_store = "keyring"\n')
                with self.assertRaises(DeployError) as error:
                    require_file_store(layout, home, uid)
                self.assertEqual(error.exception.code, "auth_store_unsupported")
                path.unlink()

    @unittest.skipUnless(os.name == "posix", "POSIX file-link boundary")
    def test_symlink_config_is_rejected_without_reading_or_mutating_target(self):
        with tempfile.TemporaryDirectory() as folder:
            original = Path(folder) / "original"
            original.write_text('cli_auth_credentials_store = "file"\n')
            alias = Path(folder) / "config.toml"
            alias.symlink_to(original)
            with self.assertRaises(DeployError):
                check_file(alias, os.getuid())
            self.assertEqual(original.read_text(), 'cli_auth_credentials_store = "file"\n')
