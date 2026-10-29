"""Certificate planning and failure guidance never perform remote validation."""
import io
import json
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest.mock import patch

from deploy.cli import main
from deploy.common import DeployError
from deploy.https_guidance import failure_guidance, https_plan
from deploy.https_health import require_https_ready
from deploy.dns_providers import PROVIDERS


class HttpsGuidanceTests(unittest.TestCase):
    def test_default_acme_keeps_high_browser_port_and_standard_validation_routes(self):
        value = https_plan(host="work.example.test")
        self.assertEqual(value["origin"], "https://work.example.test:18443")
        self.assertEqual(value["browserIngress"]["publicPort"], 18443)
        self.assertEqual(value["validation"]["requiredPublicRoutes"], "at-least-one")
        self.assertEqual([(item["publicPort"], item["localPort"]) for item in value["validation"]["publicRoutes"]],
                         [(80, 18081), (443, 18443)])
        self.assertIsNone(value["validation"]["dnsProvider"])
        self.assertIn("does not replace", value["validation"]["requirements"])
        self.assertTrue(value["renewal"]["automatic"])
        self.assertFalse(value["renewal"]["futureSuccessVerified"])

    def test_translated_browser_port_never_changes_acme_public_validation_ports(self):
        value = https_plan(host="work.example.test", http_port=8080, https_port=8443,
                           public_origin="https://work.example.test:24443")
        self.assertEqual(value["browserIngress"]["publicPort"], 24443)
        self.assertEqual(value["browserIngress"]["localTlsPort"], 8443)
        self.assertEqual([(item["publicPort"], item["localPort"]) for item in value["validation"]["publicRoutes"]],
                         [(80, 8080), (443, 8443)])

    def test_dns_plan_requires_credentials_and_txt_access_without_public_validation_routes(self):
        value = https_plan(host="cloudark.org.cn", dns_provider="alidns")
        self.assertEqual(value["origin"], "https://cloudark.org.cn:18443")
        self.assertEqual(value["validation"]["challenge"], "dns-01")
        self.assertEqual(value["validation"]["publicRoutes"], [])
        self.assertFalse(value["validation"]["dnsApiAccessVerified"])
        self.assertIn("_acme-challenge TXT", value["validation"]["requirements"])
        self.assertIn("cached certificate does not validate a new DNS key", " ".join(value["renewal"]["requirements"]))
        for field in ("configuredInstanceInspected", "networkChecksPerformed", "credentialsChecked", "certificateIssuanceProven"):
            self.assertFalse(value[field], field)

    def test_internal_and_provided_modes_explain_trust_and_renewal_ownership(self):
        internal = https_plan(host="work.example.test", tls="internal")
        provided = https_plan(host="work.example.test", tls="provided")
        self.assertIn("not public CA trust", internal["validation"]["requirements"])
        self.assertTrue(internal["renewal"]["automatic"])
        self.assertFalse(provided["renewal"]["automatic"])
        self.assertEqual(provided["renewal"]["manager"], "operator")
        self.assertEqual(internal["validation"]["publicRoutes"], [])
        self.assertEqual(provided["validation"]["publicRoutes"], [])

    def test_every_dns_plan_names_its_provider_and_exact_protected_json_schema(self):
        for name, provider in PROVIDERS.items():
            with self.subTest(provider=name):
                value = https_plan(host="work.example.test", dns_provider=name)
                selection = value["validation"]["provider"]
                self.assertEqual(selection["name"], name)
                self.assertEqual(selection["credentialFields"], [field.name for field in provider.fields])
                self.assertIn(provider.label, value["validation"]["requirements"])
                self.assertEqual(value["validation"]["publicRoutes"], [])
                self.assertFalse(value["validation"]["dnsApiAccessVerified"])
                self.assertFalse(value["renewal"]["futureSuccessVerified"])
        self.assertIn("legacy DNSPod ID/Token", https_plan(host="work.example.test", dns_provider="tencentcloud")["validation"]["provider"]["credentials"])

    def test_invalid_modes_ports_and_origin_are_rejected(self):
        for changes in ({"tls": "unknown"}, {"tls": "internal", "dns_provider": "alidns"},
                        {"dns_provider": "other"}, {"http_port": 18443}, {"http_port": 0},
                        {"https_port": 65536}, {"https_port": True}, {"host": "../unsafe"},
                        {"public_origin": "https://other.example.test:18443"}):
            with self.subTest(changes=changes), self.assertRaises(DeployError):
                https_plan(**{"host": "work.example.test", **changes})

    def test_cli_plan_needs_no_layout_root_account_or_network_and_does_not_read_saved_selection(self):
        with patch("deploy.cli.Layout", side_effect=AssertionError("instance accessed")), \
             patch("deploy.cli.require_linux", side_effect=AssertionError("platform required")), \
             patch("deploy.accounts.read_password", side_effect=AssertionError("password requested")), \
             patch("deploy.https.read_https_metadata", side_effect=AssertionError("selection read")), \
             patch("socket.create_connection", side_effect=AssertionError("network used")), \
             redirect_stdout(io.StringIO()) as output:
            main(["https-plan", "--host", "work.example.test"])
        value = json.loads(output.getvalue())
        self.assertTrue(value["planOnly"])
        self.assertEqual(value["validation"]["challenge"], "http-01-or-tls-alpn-01")
        self.assertIn("only supplied options", value["existingInstance"])

    def test_readiness_error_preserves_reason_and_selected_mode_actions(self):
        for provider, fragment in ((None, "TCP 80"), ("alidns", "DNS API credentials")):
            plan = https_plan(host="work.example.test", dns_provider=provider)
            result = {**plan, "ready": False, "tlsVerified": False, "failure": "tls_handshake_failed"}
            result["diagnostics"] = failure_guidance(result)
            with self.subTest(provider=provider), patch("deploy.https_health.https_health", return_value=result), \
                 patch("deploy.https_health.time.monotonic", side_effect=[0, 0, 0.5, 0.5]):
                with self.assertRaises(DeployError) as caught:
                    require_https_ready(SimpleNamespace(), timeout=0.25)
            self.assertIn("tls_handshake_failed", str(caught.exception))
            self.assertIn(fragment, str(caught.exception))
            self.assertIn("logs --service caddy", str(caught.exception))

    def test_failed_instance_proof_does_not_accuse_dns_or_replace_with_certificate_success(self):
        result = {**https_plan(host="work.example.test", dns_provider="alidns"),
                  "failure": "instance_proof_failed", "tlsVerified": True}
        hints = " ".join(failure_guidance(result))
        self.assertIn("reverse-proxy target", hints)
        self.assertNotIn("RAM credentials", hints)
        self.assertNotIn("CA/DNS error", hints)


if __name__ == "__main__":
    unittest.main()
