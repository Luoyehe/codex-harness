"""HTTPS configuration checks run without elevated privileges."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from deploy.cli import parser
from deploy.common import DeployError, Layout, mkdir, write_json
from deploy.https import browser_origin, https_revision, read_https, render_caddy, setup_https, stage_tls_ca
from deploy.units import render_edge_units


class HttpsConfigurationTests(unittest.TestCase):
    def test_ca_input_with_a_private_key_is_rejected_before_creating_public_files(self):
        with tempfile.TemporaryDirectory() as folder:
            layout = Layout("fixture", Path(folder))
            for label in (b"PRIVATE KEY", b"RSA PRIVATE KEY", b"EC PRIVATE KEY", b"ENCRYPTED PRIVATE KEY"):
                combined = b"-----BEGIN CERTIFICATE-----\ncertificate\n-----END CERTIFICATE-----\n-----BEGIN " + label + b"-----\nsecret"
                with self.subTest(label=label), self.assertRaisesRegex(DeployError, "only public certificates"):
                    stage_tls_ca(layout, combined)
                self.assertFalse(layout.config.exists())

    def test_legacy_renderer_remains_available_for_exact_recovery_validation(self):
        text = render_caddy("work.example.invalid", "auth.example.invalid", 3000, 9091)
        self.assertIn("admin off", text)
        self.assertIn("forward_auth", text)
        self.assertNotIn("/api/*", text)

    def test_builtin_https_requires_only_application_hostname_and_no_identity_service(self):
        text = render_caddy("work.example.invalid", None, 3000, 9091)
        self.assertIn("admin off", text)
        self.assertIn("reverse_proxy 127.0.0.1:3000", text)
        self.assertNotIn("forward_auth", text)
        self.assertNotIn("9091", text)
        self.assertNotIn("/api/*", text)
        self.assertIn("request_header -Remote-User", text)
        layout = Layout("fixture")
        units = render_edge_units(layout, builtin=True)
        self.assertEqual(set(units), {layout.unit("caddy")})
        self.assertIn("After=" + layout.unit("gateway"), units[layout.unit("caddy")])

    def test_internal_and_provided_tls_use_explicit_ports_and_paths(self):
        internal = render_caddy("work.example.test", "auth.example.test", 3000, 9091, tls="internal", http_port=18080, https_port=18443)
        self.assertIn("tls internal", internal)
        self.assertIn("skip_install_trust", internal)
        self.assertIn("https://work.example.test:18443", internal)
        self.assertIn("http_port 18080", internal)
        provided = render_caddy("work.example.test", "auth.example.test", 3000, 9091, tls="provided",
                                certificate="/etc/harness/certificate.pem", private_key="/etc/harness/private-key.pem")
        self.assertIn("tls /etc/harness/certificate.pem /etc/harness/private-key.pem", provided)
        with self.assertRaises(DeployError):
            render_caddy("work.example.test", "auth.example.test", 3000, 9091, tls="provided", certificate="/tmp/cert\nmalicious", private_key="/tmp/key")

    def test_explicit_public_origin_keeps_internal_listener_and_public_redirect_separate(self):
        text = render_caddy("work.example.test", None, 3000, 9091, tls="internal", http_port=18080,
                            https_port=18443, public_origin="https://work.example.test")
        self.assertIn("https://work.example.test:18443", text)
        self.assertIn("http://work.example.test:18080", text)
        self.assertIn("auto_https disable_redirects", text)
        self.assertIn("redir https://work.example.test{uri} 308", text)
        for value in ("https://other.example.test", "http://work.example.test", "https://work.example.test/path"):
            with self.subTest(value=value), self.assertRaises(DeployError):
                browser_origin("work.example.test", 18443, value)
        self.assertEqual(browser_origin("work.example.test", 18443, "https://WORK.example.test:443/"),
                         "https://work.example.test")

    def test_new_direct_redirect_keeps_nonstandard_browser_tls_port(self):
        text = render_caddy("work.example.test", None, 3000, 9091, tls="internal", http_port=18080,
                            https_port=18443, explicit_redirect=True)
        self.assertIn("auto_https disable_redirects", text)
        self.assertIn("redir https://work.example.test:18443{uri} 308", text)

    def test_explicit_migration_requires_origin_and_metadata_revision_and_is_operator_only(self):
        required = ["https-migrate", "--host", "public.example.test", "--expected-origin", "https://old.example.test",
                    "--expected-https-revision", "a" * 64]
        args = parser().parse_args(required + ["--public-origin", "https://public.example.test", "--https-port", "18443",
                                             "--tls", "provided", "--tls-ca-certificate", "/root/public-ca.pem"])
        self.assertEqual(args.command, "https-migrate")
        self.assertEqual(args.expected_https_revision, "a" * 64)
        self.assertEqual(args.tls_ca_certificate, Path("/root/public-ca.pem"))
        self.assertEqual(parser().parse_args(["https-read"]).command, "https-read")
        for values in (required[:-2], ["https", "--host", "public.example.test", "--expected-origin", "https://old.example.test"]):
            with patch("sys.stderr"), self.assertRaises(SystemExit):
                parser().parse_args(values)
        from deploy.manager import validate_request
        for method in ("https-read", "https-migrate", "https/read", "https/migrate"):
            with self.subTest(method=method), self.assertRaises(DeployError):
                validate_request({"method": method, "params": {}})


class HttpsMigrationBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.layout = Layout("fixture", Path(self.temp.name))
        mkdir(self.layout.config)
        self.metadata = {"host": "local.example.test", "tls": "internal", "httpPort": 18081, "httpsPort": 18443,
                         "authentication": "builtin", "phase": "active"}
        write_json(self.layout.config / "https.json", self.metadata)
        self.manager = SimpleNamespace(layout=self.layout, config={"port": 3300, "origin": "https://local.example.test:18443"},
                                       require_recovered_transactions=Mock(), require_service_ownership=Mock())
        # Ownership is exercised by the Linux root metadata fixtures.
        reader = patch("deploy.https.read_https_metadata", return_value=self.metadata)
        self.metadata_reader = reader.start()
        self.addCleanup(reader.stop)

    def test_read_revision_binds_all_metadata_without_exposing_tls_material(self):
        result = read_https(self.manager)
        self.metadata_reader.assert_called_once_with(self.layout)
        self.assertEqual(result["origin"], self.manager.config["origin"])
        self.assertEqual(result["httpsRevision"], https_revision(self.metadata))
        reordered = dict(reversed(list(self.metadata.items())))
        self.assertEqual(https_revision(reordered), result["httpsRevision"])
        for field in ("tls", "host", "httpPort", "httpsPort", "tlsRevision", "privateKeySha256", "tlsCaRevision", "phase"):
            self.assertNotEqual(https_revision({**self.metadata, field: "different"}), result["httpsRevision"])
        self.assertNotIn("privateKeySha256", result["settings"])

    def test_default_https_rejects_each_address_or_mode_change_before_credentials_or_staging(self):
        values = {"host": "local.example.test", "tls": "internal", "http_port": 18081, "https_port": 18443}
        for change in ({"host": "public.example.test"}, {"tls": "acme"}, {"http_port": 80}, {"https_port": 443},
                       {"public_origin": "https://local.example.test"}):
            with self.subTest(change=change):
                self.metadata_reader.reset_mock()
                with self.assertRaisesRegex(DeployError, "explicit migration") as error:
                    setup_https(self.manager, **{**values, **change})
                self.assertEqual(error.exception.code, "identity_conflict")
                self.metadata_reader.assert_called_once_with(self.layout)
        self.assertEqual(list(self.layout.config.iterdir()), [self.layout.config / "https.json"])

    def test_stale_origin_revision_or_missing_binding_reject_before_credentials_or_staging(self):
        current = {"expected_origin": self.manager.config["origin"], "expected_https_revision": https_revision(self.metadata)}
        changes = (({"expected_origin": "https://wrong.example.test"}, "conflict", "configuration changed"),
                   ({"expected_https_revision": "0" * 64}, "conflict", "configuration changed"),
                   ({"expected_origin": None}, "invalid_input", "requires the current origin and HTTPS revision"),
                   ({"expected_https_revision": None}, "invalid_input", "requires the current origin and HTTPS revision"))
        for change, code, message in changes:
            with self.subTest(change=change):
                self.metadata_reader.reset_mock()
                with self.assertRaisesRegex(DeployError, message) as error:
                    setup_https(self.manager, host="public.example.test", **{**current, **change})
                self.assertEqual(error.exception.code, code)
                self.metadata_reader.assert_called_once_with(self.layout)
        self.assertEqual(list(self.layout.config.iterdir()), [self.layout.config / "https.json"])


if __name__ == "__main__":
    unittest.main()
