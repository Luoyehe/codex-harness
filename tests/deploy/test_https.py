"""HTTPS configuration checks run without elevated privileges."""
import unittest

from deploy.common import DeployError, Layout
from deploy.https import identity_configuration, render_caddy


class HttpsConfigurationTests(unittest.TestCase):
    def test_https_guards_every_gateway_path_and_preserves_identity_material(self):
        text = render_caddy("work.example.invalid", "auth.example.invalid", 3000, 9091)
        self.assertIn("admin off", text)
        self.assertIn("forward_auth", text)
        self.assertNotIn("/api/*", text)
        layout = Layout("fixture")
        keys = {"session": "fixture-session", "storage": "fixture-storage", "jwt": "fixture-jwt"}
        config = identity_configuration(layout, "work.example.invalid", "auth.example.invalid", "example.invalid", 9091, keys)
        self.assertEqual(config["access_control"]["default_policy"], "deny")
        self.assertEqual(config["storage"]["encryption_key"], "fixture-storage")
        self.assertIn("identity/db.sqlite3", config["storage"]["local"]["path"].replace("\\", "/"))

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


if __name__ == "__main__":
    unittest.main()
