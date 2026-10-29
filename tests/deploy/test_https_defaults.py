"""High listener defaults and preservation of explicitly retained HTTPS ports."""
import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from deploy.cli import parser
from deploy.common import DeployError, Layout, mkdir, write_json
from deploy.https import browser_origin, caddy_configuration, render_caddy, setup_https


class HttpsDefaultTests(unittest.TestCase):
    def commands(self):
        return (["https", "--host", "work.example.test"],
                ["https-migrate", "--host", "work.example.test", "--expected-origin", "https://old.example.test",
                 "--expected-https-revision", "a" * 64])

    def test_cli_defaults_use_high_ports_and_matching_browser_origin(self):
        for command in self.commands():
            with self.subTest(command=command[0]):
                args = parser().parse_args(command)
                self.assertEqual((args.http_port, args.https_port), (18081, 18443))
                self.assertEqual(browser_origin(args.host, args.https_port, args.public_origin),
                                 "https://work.example.test:18443")

    def test_explicit_standard_ports_and_translated_public_origin_remain_available(self):
        for command in self.commands():
            with self.subTest(command=command[0]):
                args = parser().parse_args(command + ["--http-port", "80", "--https-port", "443"])
                self.assertEqual((args.http_port, args.https_port), (80, 443))
                self.assertEqual(browser_origin(args.host, args.https_port), "https://work.example.test")
                translated = parser().parse_args(command + ["--public-origin", "https://work.example.test"])
                self.assertEqual(translated.https_port, 18443)
                self.assertEqual(browser_origin(translated.host, translated.https_port, translated.public_origin),
                                 "https://work.example.test")

    def test_command_help_explains_listener_defaults_and_browser_origin(self):
        for command in ("https", "https-migrate"):
            with self.subTest(command=command), redirect_stdout(io.StringIO()) as output, self.assertRaises(SystemExit) as exit:
                parser().parse_args([command, "--help"])
            self.assertEqual(exit.exception.code, 0)
            text = " ".join(output.getvalue().split())
            self.assertIn("Caddy HTTP listener port (default: 18081)", text)
            self.assertIn("Caddy HTTPS listener port (default: 18443)", text)
            self.assertIn("defaults to https://HOST:HTTPS_PORT", text)

    def test_renderer_defaults_and_new_metadata_redirect_keep_high_https_port(self):
        text = render_caddy("work.example.test", None, 3300, 9091, tls="internal", explicit_redirect=True)
        self.assertIn("http_port 18081\n", text)
        self.assertIn("https_port 18443\n", text)
        self.assertIn("https://work.example.test:18443 {", text)
        self.assertIn("http://work.example.test:18081 {", text)
        self.assertIn("redir https://work.example.test:18443{uri} 308", text)
        metadata = {"host": "work.example.test", "httpPort": 18081, "httpsPort": 18443, "tls": "internal",
                    "authentication": "builtin", "redirectPolicy": "origin-v1"}
        self.assertEqual(caddy_configuration(Layout("fixture"), {"port": 3300}, metadata), text)

    def test_retained_standard_ports_and_legacy_redirect_bytes_remain_unchanged(self):
        metadata = {"host": "work.example.test", "authHost": "auth.example.test", "authPort": 9091,
                    "httpPort": 80, "httpsPort": 443, "tls": "internal"}
        text = caddy_configuration(Layout("fixture"), {"port": 3300}, metadata)
        self.assertIn("http_port 80\n", text)
        self.assertIn("https_port 443\n", text)
        self.assertIn("https://work.example.test {", text)
        self.assertIn("https://auth.example.test {", text)
        self.assertNotIn("18443", text)
        self.assertNotIn("18081", text)
        self.assertNotIn("auto_https disable_redirects", text)
        self.assertNotIn("redir ", text)

    def test_setup_defaults_reach_only_high_port_preflight_without_mutation(self):
        with tempfile.TemporaryDirectory() as folder:
            layout = Layout("fixture", Path(folder))
            manager = SimpleNamespace(layout=layout, config={"port": 3300, "origin": "http://127.0.0.1:3300"},
                                      require_recovered_transactions=Mock(), require_service_ownership=Mock())
            with patch("deploy.ports.require_edge_ports_available", side_effect=RuntimeError("stop before side effects")) as preflight:
                with self.assertRaisesRegex(RuntimeError, "stop before side effects"):
                    setup_https(manager, host="work.example.test", tls="internal")
                preflight.assert_called_once_with(manager, http_port=18081, https_port=18443)
            self.assertEqual(list(Path(folder).iterdir()), [])

    def test_default_invocation_does_not_migrate_retained_standard_ports(self):
        with tempfile.TemporaryDirectory() as folder:
            layout = Layout("fixture", Path(folder))
            mkdir(layout.config)
            metadata = {"host": "work.example.test", "httpPort": 80, "httpsPort": 443,
                        "tls": "internal", "authentication": "builtin", "phase": "active"}
            write_json(layout.config / "https.json", metadata)
            before = (layout.config / "https.json").read_bytes()
            manager = SimpleNamespace(layout=layout, config={"port": 3300, "origin": "https://work.example.test"},
                                      require_recovered_transactions=Mock(), require_service_ownership=Mock())
            with patch("deploy.https.read_https_metadata", return_value=metadata) as reader, \
                 patch("deploy.ports.require_edge_ports_available", side_effect=RuntimeError("stop before side effects")) as preflight:
                with self.assertRaisesRegex(DeployError, "explicit migration"):
                    setup_https(manager, host="work.example.test", tls="internal")
                reader.assert_called_once_with(layout)
                reader.reset_mock()
                preflight.assert_not_called()
                with self.assertRaisesRegex(RuntimeError, "stop before side effects"):
                    setup_https(manager, host="work.example.test", tls="internal", http_port=80, https_port=443)
                reader.assert_called_once_with(layout)
                preflight.assert_called_once_with(manager, http_port=80, https_port=443)
            self.assertEqual((layout.config / "https.json").read_bytes(), before)
            self.assertEqual(list(layout.config.iterdir()), [layout.config / "https.json"])


if __name__ == "__main__":
    unittest.main()
