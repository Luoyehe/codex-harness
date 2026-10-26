"""HTTPS configuration checks run without elevated privileges."""
import unittest

from deploy.common import DeployError, Layout
from deploy.https import render_caddy
from deploy.units import render_edge_units


class HttpsConfigurationTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
