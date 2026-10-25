"""Pure system-layer composition and host-file preservation checks."""
import datetime
import os
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy.common import DeployError, Layout
from deploy.provider import ProviderStore, require_provider_layer
from deploy.provider_layers import HOST_NAMES, compose_layers, equivalent, provider_documents, serialize_toml
from deploy.units import render_units, sudo_rule
from deploy.cli import parser


class ProviderLayerCompositionTests(unittest.TestCase):
    def setUp(self):
        self.provider = {"name": "Harness Responses", "base_url": "https://provider.invalid/v1", "wire_api": "responses", "env_key": "HARNESS_PROVIDER_API_KEY"}
        self.defaults = {"model": "fixture-model", "model_provider": "harness_responses", "model_providers": {"harness_responses": self.provider}}
        self.required = {"model_provider": "harness_responses", "model_providers": {"harness_responses": self.provider}}
        self.host = {name: {} for name in HOST_NAMES}

    def test_unrelated_host_tables_and_relative_references_survive_semantic_roundtrip(self):
        self.host["config.toml"] = {"model_instructions_file": "instructions/policy.md", "skills": {"config": [{"path": "./skills/example", "enabled": True}]},
                                    "mcp_servers": {"host": {"command": "./bin/local-tool", "args": ["literal space", "quoted\"value"]}}}
        self.host["requirements.toml"] = {"allowed_approval_policies": ["on-request"], "network": {"allowed_domains": ["example.invalid"]}}
        self.host["managed_config.toml"] = {"developer_instructions": "Retained global policy"}
        result = compose_layers(self.defaults, self.required, self.host)
        config = tomllib.loads(result["system-config.toml"].decode())
        self.assertEqual(config["model_instructions_file"], "instructions/policy.md")
        self.assertEqual(config["skills"], self.host["config.toml"]["skills"])
        self.assertEqual(config["mcp_servers"], self.host["config.toml"]["mcp_servers"])
        required = tomllib.loads(result["requirements.toml"].decode())
        self.assertEqual(required["network"], self.host["requirements.toml"]["network"])
        self.assertEqual(set(result), {"system-config.toml", "requirements.toml"})

    def test_host_provider_selection_and_full_definition_conflicts_are_explicit(self):
        for name in HOST_NAMES:
            for conflict in ({"model_provider": "host-provider"},
                             {"model_providers": {"harness_responses": {**self.provider, "http_headers": {"x-host": "required"}}}}):
                host = {**self.host, name: conflict}
                with self.subTest(name=name, conflict=conflict), self.assertRaises(DeployError) as caught:
                    compose_layers(self.defaults, self.required, host)
                self.assertEqual(caught.exception.code, "configuration_conflict")

    def test_host_catalog_constraints_and_managed_defaults_are_not_weakened(self):
        required = {**self.required, "model_catalog_json": "/instance/catalog.json"}
        for name, conflict in (("requirements.toml", {"model_catalog_json": "/host/catalog.json"}),
                               ("managed_config.toml", {"model": "host-required-model"}),
                               ("config.toml", {"model": "host-default-model"})):
            with self.subTest(name=name), self.assertRaises(DeployError):
                compose_layers(self.defaults, required, {**self.host, name: conflict})

    def test_matching_constraints_are_idempotent_and_inputs_unchanged(self):
        host = {"config.toml": self.defaults, "requirements.toml": self.required, "managed_config.toml": {}}
        first = compose_layers(self.defaults, self.required, host)
        second = compose_layers(self.defaults, self.required, host)
        self.assertEqual(first, second)
        self.assertEqual(tomllib.loads(first["requirements.toml"].decode()), self.required)

    def test_toml_scalar_array_table_types_roundtrip_without_relocating_paths(self):
        source = {"quoted.key": {"string": "new\nline\\path", "array": [{"enabled": True}, {"number": 1}]}, "empty": {},
                  "date": datetime.date(2025, 1, 2), "time": datetime.time(3, 4, 5),
                  "instant": datetime.datetime(2025, 1, 2, 3, 4, 5, tzinfo=datetime.timezone.utc),
                  "float": 1.5, "nan": float("nan"), "positive": float("inf"), "negative": -float("inf")}
        self.assertTrue(equivalent(source, tomllib.loads(serialize_toml(source).decode())))

    def test_complete_provider_definition_is_mandatory(self):
        for required in ({}, {"model_provider": "harness_responses"}, {"model_provider": "harness_responses", "model_providers": {}}):
            with self.assertRaises(DeployError):
                compose_layers(self.defaults, required, self.host)

    def test_chatgpt_complete_custom_provider_pins_auth_and_websocket_route(self):
        defaults, required = provider_documents({"kind": "chatgpt", "revision": "a" * 32}, Layout("fixture"))
        self.assertEqual(required["model_provider"], "harness_chatgpt")
        self.assertEqual(required["allowed_login_methods"], ["chatgpt"])
        self.assertEqual(required["chatgpt_base_url"], "https://chatgpt.com/backend-api/")
        self.assertEqual(required["model_providers"]["harness_chatgpt"], {
            "name": "OpenAI", "base_url": "https://chatgpt.com/backend-api/codex", "wire_api": "responses",
            "requires_openai_auth": True, "supports_websockets": True})
        self.assertEqual(defaults["model_providers"], required["model_providers"])

    def test_required_provider_contains_only_credential_environment_name(self):
        defaults, required = provider_documents({"kind": "responses", "revision": "a" * 32,
            "baseUrl": "https://provider.invalid/v1", "model": "fixture", "apiKey": "secret-fixture"}, Layout("fixture"))
        data = compose_layers(defaults, required, self.host)
        self.assertNotIn(b"secret-fixture", b"".join(data.values()))
        self.assertEqual(required["model_providers"]["harness_responses"]["env_key"], "HARNESS_PROVIDER_API_KEY")

    def test_layered_units_preserve_host_directory_and_invoke_separate_fixed_check(self):
        layout = Layout("fixture")
        config = {"origin": "http://127.0.0.1:3300", "port": 3300, "workerGid": 123, "providerConfigLayer": "system-v1"}
        units = render_units(layout, config, "vendor/codex")
        worker, check = units[layout.unit("worker")], units[layout.unit("config-check")]
        self.assertIn(f"ExecStartPre=+/usr/bin/systemctl start {layout.unit('config-check')}", worker)
        self.assertIn("/system-config.toml:/etc/codex/config.toml", worker.replace("\\", "/"))
        self.assertIn("/requirements.toml:/etc/codex/requirements.toml", worker.replace("\\", "/"))
        self.assertNotIn("TemporaryFileSystem", worker)
        self.assertNotIn("/worker/codex/config.toml", worker.replace("\\", "/"))
        self.assertIn(f"ExecStart={layout.control}/manage config-check", check)
        self.assertIn("User=root", check)
        self.assertNotIn("BindReadOnlyPaths", check)
        self.assertNotIn("RemainAfterExit", check)
        self.assertNotIn("config-check", sudo_rule(layout))
        legacy = render_units(layout, {**config, "providerConfigLayer": None}, "vendor/codex")
        self.assertNotIn(layout.unit("config-check"), legacy)
        self.assertIn("/worker/codex/config.toml", legacy[layout.unit("worker")].replace("\\", "/"))

    def test_operator_layer_commands_expose_only_fixed_modes(self):
        self.assertEqual(parser().parse_args(["config-layer-migrate"]).command, "config-layer-migrate")
        self.assertEqual(parser().parse_args(["config-layer-rollback"]).command, "config-layer-rollback")
        self.assertEqual(parser().parse_args(["config-layer-recover", "--target", "candidate"]).target, "candidate")
        with patch("sys.stderr"), self.assertRaises(SystemExit):
            parser().parse_args(["config-layer-migrate", "--path", "/tmp/arbitrary"])

    def test_all_managed_kinds_require_their_compatible_configuration_layer(self):
        for kind in ("chatgpt", "responses", "zhipu-coding"):
            require_provider_layer({"kind": kind}, layered=False)
        for kind in ("chatgpt-gateway", "bedrock-runtime", "bedrock-mantle", "unrecognized-future-provider"):
            with self.subTest(kind=kind), self.assertRaises(DeployError) as caught:
                require_provider_layer({"kind": kind}, layered=False)
            self.assertEqual(caught.exception.code, "configuration_conflict")
        for kind in ("chatgpt", "responses", "zhipu-coding", "chatgpt-gateway", "bedrock-runtime", "bedrock-mantle"):
            require_provider_layer({"kind": kind}, layered=True)

    def test_advanced_legacy_preparation_never_creates_a_generation(self):
        for kind in ("chatgpt-gateway", "bedrock-runtime", "bedrock-mantle"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as folder:
                store = ProviderStore(Layout("fixture", Path(folder)), 0)
                with self.assertRaises(DeployError) as caught:
                    store.prepare({"kind": kind, "revision": "a" * 32}, layered=False)
                self.assertEqual(caught.exception.code, "configuration_conflict")
                self.assertFalse(store.root.exists())


if __name__ == "__main__":
    unittest.main()
