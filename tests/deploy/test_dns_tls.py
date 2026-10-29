"""DNS TLS input, redaction and deterministic edge configuration checks."""
import hashlib
import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from deploy.cli import parser
from deploy.common import DeployError, Layout
from deploy.dns_tls import (FIELDS, dns_unit_settings, read_dns_credentials,
                            validate_dns_caddy, validate_dns_selection, _environment)
from deploy.dns_providers import PROVIDERS, credential_fields
from deploy.https import render_caddy
from deploy.https_health import require_https_ready
from deploy.units import render_edge_units


class DnsTlsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.input = self.root / "credentials.json"
        self.fake_id = "isolated-fake-access-id"
        self.fake_secret = "isolated-fake-access-secret"
        self.data = {"accessKeyId": self.fake_id, "accessKeySecret": self.fake_secret}
        self.input.write_text(json.dumps(self.data), encoding="utf-8")
        self.input.chmod(0o600)

    def read(self, provider="alidns"):
        # The parser contract is unprivileged; Linux ownership is exercised by
        # real root fixtures separately. Preserve all other stat properties.
        original = os.fstat
        def owned(fd):
            value = original(fd)
            fields = {name: getattr(value, name) for name in dir(value) if name.startswith("st_")}
            fields["st_uid"] = 0
            return SimpleNamespace(**fields)
        with patch("deploy.dns_tls.os.fstat", side_effect=owned):
            return read_dns_credentials(self.input, provider)

    def test_each_provider_binds_exact_credentials_environment_and_caddy_module_without_values(self):
        all_environments = {field.environment for provider in PROVIDERS.values() for field in provider.fields}
        for name, provider in PROVIDERS.items():
            with self.subTest(provider=name):
                values = {field.name: "us-east-1" if field.kind == "region" else "isolated-fake-" + field.name for field in provider.fields}
                self.input.write_text(json.dumps(values), encoding="utf-8")
                data = self.read(name)
                environment = _environment(data, name)
                self.assertEqual(environment, {field.environment: values[field.name] for field in provider.fields})
                text = render_caddy("work.example.test", None, 3300, 9091, dns_provider=name)
                self.assertIn("dns " + name + " {", text)
                self.assertIn("disable_http_challenge", text)
                self.assertIn("disable_tlsalpn_challenge", text)
                for field in provider.fields:
                    self.assertIn(field.caddy_name + " {env." + field.environment + "}", text)
                    self.assertNotIn(values[field.name], text)
                for other in all_environments - set(environment):
                    self.assertNotIn(other, text)
                args = parser().parse_args(["https", "--host", "work.example.test", "--dns-provider", name])
                self.assertEqual(args.dns_provider, name)
                for other in PROVIDERS:
                    if other != name:
                        with self.assertRaises(DeployError):
                            _environment(data, other)

    def test_provider_specific_schemas_reject_other_credentials_missing_fields_and_injection(self):
        for name, provider in PROVIDERS.items():
            values = {field.name: "us-east-1" if field.kind == "region" else "isolated-fake-" + field.name for field in provider.fields}
            samples = [{**values, "unexpected": "ignored-secret"}, {},
                       {**values, provider.fields[0].name: "bad\nHARNESS_OTHER=credential"}]
            if name == "route53":
                samples += [{**values, "region": "https://attacker.invalid"}, {key: value for key, value in values.items() if key != "region"}]
            if name == "tencentcloud":
                samples += [{"id": "12345678", "token": "legacy-token-never-accepted"}]
            for sample in samples:
                with self.subTest(provider=name, fields=list(sample)):
                    self.input.write_text(json.dumps(sample), encoding="utf-8")
                    with self.assertRaises(DeployError) as caught:
                        self.read(name)
                    self.assertNotIn("ignored-secret", str(caught.exception))
                    self.assertNotIn("legacy-token-never-accepted", str(caught.exception))
        for name in ("dnspod", "unknown", "../alidns"):
            with self.subTest(provider=name), self.assertRaises(DeployError):
                self.read(name)

    def test_original_alidns_configuration_bytes_are_preserved_for_recovery(self):
        text = render_caddy("work.example.test", None, 3300, 9091, dns_provider="alidns")
        self.assertIn("""    tls {
        issuer acme {
            dns alidns {
                access_key_id {env.HARNESS_ALIDNS_ACCESS_KEY_ID}
                access_key_secret {env.HARNESS_ALIDNS_ACCESS_KEY_SECRET}
            }
            disable_http_challenge
            disable_tlsalpn_challenge
        }
    }
""", text)

    def test_validator_uses_only_the_selected_provider_environment(self):
        name = "cloudflare"
        self.input.write_text(json.dumps({"apiToken": "isolated-cloudflare-secret"}), encoding="utf-8")
        data = self.read(name)
        layout = Layout("fixture", self.root)
        with patch("deploy.dns_tls.dns_credentials_path", return_value=self.input), \
             patch("deploy.dns_tls._read_private", return_value=data), \
             patch("deploy.dns_tls.subprocess.run", return_value=subprocess.CompletedProcess([], 0)) as run:
            validate_dns_caddy(layout, {"dnsProvider": name}, self.root / "caddy", self.root / "Caddyfile", 101, 102)
        self.assertEqual(set(run.call_args.kwargs["env"]), {"PATH", "HOME", "LANG", *credential_fields(name).values()})
        self.assertNotIn("isolated-cloudflare-secret", " ".join(run.call_args.args[0]))
        self.assertIs(run.call_args.kwargs["stderr"], subprocess.DEVNULL)

    def test_valid_json_is_canonical_and_values_are_not_printed(self):
        with redirect_stdout(io.StringIO()) as stdout, redirect_stderr(io.StringIO()) as stderr:
            value = self.read()
        self.assertEqual(value, b"HARNESS_ALIDNS_ACCESS_KEY_ID=isolated-fake-access-id\n"
                                b"HARNESS_ALIDNS_ACCESS_KEY_SECRET=isolated-fake-access-secret\n")
        self.assertEqual(stdout.getvalue() + stderr.getvalue(), "")

    def test_duplicate_extra_missing_and_invalid_values_are_rejected_without_echo(self):
        samples = [b'{"accessKeyId":"isolated-fake-access-id","accessKeyId":"different-fake-id",'
                   b'"accessKeySecret":"isolated-fake-access-secret"}', b"[]", b"{}", b"\xff"]
        samples.append(json.dumps({**self.data, "extra": "ignored-must-not-be-accepted"}).encode())
        for value in ("", "short", "space separated secret", "new\nline-secret", "${SHELL_VALUE}",
                      'quoted"secret', "a" * 257, 123, None):
            samples.append(json.dumps({**self.data, "accessKeySecret": value}).encode())
        for sample in samples:
            with self.subTest(sample_sha256=hashlib.sha256(sample).hexdigest()):
                self.input.write_bytes(sample)
                with redirect_stdout(io.StringIO()) as stdout, redirect_stderr(io.StringIO()) as stderr:
                    with self.assertRaises(DeployError) as caught:
                        self.read()
                text = str(caught.exception) + stdout.getvalue() + stderr.getvalue()
                self.assertNotIn(self.fake_secret, text)
                self.assertNotIn(self.fake_id, text)

    def test_relative_symlink_hardlink_and_oversized_inputs_are_rejected(self):
        with self.assertRaises(DeployError):
            read_dns_credentials(Path("credentials.json"))
        with patch.object(Path, "is_symlink", return_value=True), self.assertRaises(DeployError):
            self.read()
        alias = self.root / "same-inode.json"
        os.link(self.input, alias)
        with self.assertRaises(DeployError):
            self.read()
        alias.unlink()
        self.input.write_bytes(b"x" * 4097)
        with self.assertRaises(DeployError):
            self.read()

    def test_incomplete_selection_cannot_silently_disable_dns_validation(self):
        layout = Layout("fixture", self.root)
        for metadata in ({"dnsProvider": None}, {"dnsCredentialsRevision": "a" * 32},
                         {"dnsBinarySha256": "b" * 64}):
            with self.subTest(metadata=metadata), self.assertRaises(DeployError):
                validate_dns_selection(layout, metadata)
        validate_dns_selection(layout, {"tls": "internal", "authentication": "builtin"})

    def test_dns_renderer_disables_public_port_challenges_and_contains_only_placeholders(self):
        text = render_caddy("work.example.test", None, 3300, 9091, dns_provider="alidns", explicit_redirect=True)
        self.assertIn("dns alidns {", text)
        self.assertIn("access_key_id {env.HARNESS_ALIDNS_ACCESS_KEY_ID}", text)
        self.assertIn("access_key_secret {env.HARNESS_ALIDNS_ACCESS_KEY_SECRET}", text)
        self.assertIn("disable_http_challenge", text)
        self.assertIn("disable_tlsalpn_challenge", text)
        self.assertIn("redir https://work.example.test:18443{uri} 308", text)
        self.assertNotIn(self.fake_secret, text)
        for options in ({"tls": "internal"}, {"auth_host": "auth.example.test"}, {"dns_provider": "other"}):
            args = {"auth_host": None, "dns_provider": "alidns", **options}
            with self.subTest(options=options), self.assertRaises(DeployError):
                render_caddy("work.example.test", gateway_port=3300, auth_port=9091, **args)

    def test_unit_uses_selected_binary_and_root_read_environment_file_without_values(self):
        layout = Layout("fixture", self.root)
        metadata = {"tls": "acme", "authentication": "builtin", "dnsProvider": "alidns",
                    "dnsBinaryRevision": "b" * 64, "dnsCredentialsRevision": "a" * 32}
        binary, credentials = dns_unit_settings(layout, metadata)
        unit = render_edge_units(layout, builtin=True, dns_metadata=metadata)[layout.unit("caddy")]
        self.assertIn("EnvironmentFile=" + str(credentials) + "\n", unit)
        self.assertIn("ExecStart=" + str(binary) + " run --config ", unit)
        self.assertIn("User=ch-fixture-edge\n", unit)
        self.assertNotIn(self.fake_secret, unit)
        self.assertNotIn(self.fake_id, unit)
        for field in ("dnsBinaryRevision", "dnsCredentialsRevision"):
            with self.subTest(field=field), self.assertRaises(DeployError):
                dns_unit_settings(layout, {**metadata, field: "../../outside"})

    def test_validator_supplies_credentials_only_in_environment_and_discards_child_output(self):
        data = self.read()
        layout = Layout("fixture", self.root)
        binary, config = self.root / "caddy", self.root / "Caddyfile"
        with patch("deploy.dns_tls.dns_credentials_path", return_value=self.input), \
             patch("deploy.dns_tls._read_private", return_value=data), \
             patch("deploy.dns_tls.subprocess.run", return_value=subprocess.CompletedProcess([], 1)) as run:
            with self.assertRaisesRegex(DeployError, "configuration validation failed") as caught:
                validate_dns_caddy(layout, {}, binary, config, 101, 102)
        argv = run.call_args.args[0]
        kwargs = run.call_args.kwargs
        for value in self.data.values():
            self.assertNotIn(value, " ".join(argv))
            self.assertNotIn(value, str(caught.exception))
        self.assertEqual(kwargs["env"][FIELDS["accessKeyId"]], self.fake_id)
        self.assertEqual(kwargs["env"][FIELDS["accessKeySecret"]], self.fake_secret)
        self.assertEqual(set(kwargs["env"]), {"PATH", "HOME", "LANG", *FIELDS.values()})
        self.assertEqual((kwargs["stdout"], kwargs["stderr"]), (subprocess.DEVNULL, subprocess.DEVNULL))
        self.assertEqual(argv[1:5], ["--reuid", "101", "--regid", "102"])
        self.assertTrue(kwargs["close_fds"])

    def test_dns_readiness_accepts_propagation_budget_but_each_probe_remains_short(self):
        ready = {"ready": True}
        with patch("deploy.https_health.https_health", return_value=ready) as probe:
            self.assertEqual(require_https_ready(SimpleNamespace(), timeout=300), ready)
        self.assertLessEqual(probe.call_args.kwargs["timeout"], 5.0)

    def test_cli_dns_credentials_are_file_input_and_provider_disable_is_explicit(self):
        args = parser().parse_args(["https", "--host", "work.example.test", "--dns-provider", "alidns",
                                    "--dns-credentials", str(self.input)])
        self.assertEqual(args.dns_credentials, self.input)
        self.assertEqual(args.dns_provider, "alidns")
        args = parser().parse_args(["https", "--host", "work.example.test", "--dns-provider", "none"])
        self.assertEqual(args.dns_provider, "none")
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            parser().parse_args(["https", "--host", "work.example.test", "--access-key-secret", self.fake_secret])


if __name__ == "__main__":
    unittest.main()
