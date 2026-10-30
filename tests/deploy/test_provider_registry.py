import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy.catalog import parse_ids
from deploy.common import DeployError, Layout
from deploy.provider import ProviderStore, validate_catalog, validate_provider
from deploy.provider_catalogs import apply_discovery, discover, initialize
from deploy.provider_layers import provider_documents, compose_layers
from deploy.provider_registry import change, configuration, entries, environment, public_registry, runtime_registry, selected


class ProviderRegistryTests(unittest.TestCase):
    def setUp(self):
        self.current = {"kind": "chatgpt", "revision": "a" * 32, "models": []}
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.layout = Layout("fixture", Path(self.temp.name))

    def add(self, current, **values):
        return change({"expectedRevision": current["revision"], "providerId": "new", "kind": "responses",
                       "baseUrl": "https://one.invalid/v1", "apiKey": "fixture-one", **values}, current)

    def test_saving_without_a_model_is_valid_for_both_api_providers(self):
        for value in ({"kind": "responses", "baseUrl": "https://one.invalid/v1"},
                      {"kind": "zhipu-coding", "apiKey": "fixture-plan"}):
            saved = validate_provider({"expectedRevision": self.current["revision"], **value}, self.current)
            self.assertNotIn("model", saved)

    def test_multiple_enabled_connections_keep_separate_credentials_and_defaults(self):
        first = self.add(self.current, name="First")
        second = self.add(first, name="Second", baseUrl="https://two.invalid/v1", apiKey="fixture-two")
        rows = entries(second)
        self.assertEqual(len(rows), 3)
        self.assertTrue(all(row["enabled"] for row in rows))
        self.assertEqual(second["defaultProviderId"], "default")
        config = configuration(second, self.layout)
        definitions = config["model_providers"]
        self.assertEqual(len(definitions), 3)
        keys = environment(second)
        self.assertEqual(set(keys.values()), {"fixture-one", "fixture-two"})
        for definition in definitions.values():
            if definition.get("base_url") == "https://one.invalid/v1":
                self.assertEqual(keys[definition["env_key"]], "fixture-one")
            if definition.get("base_url") == "https://two.invalid/v1":
                self.assertEqual(keys[definition["env_key"]], "fixture-two")
        self.assertNotIn("fixture-one", json.dumps(public_registry(second)))

    def test_editing_a_provider_does_not_reuse_credentials_for_another_endpoint(self):
        current = self.add(self.current)
        row = entries(current)[1]
        changed = change({"expectedRevision": current["revision"], "providerId": row["id"], "kind": "responses",
                          "baseUrl": "https://different.invalid/v1"}, current)
        self.assertEqual(selected(changed, row["id"])["settings"]["apiKey"], "")
        self.assertEqual(selected(changed)["settings"]["kind"], "chatgpt")

    def test_disabled_and_removed_defaults_choose_an_enabled_alternative(self):
        current = self.add(self.current)
        custom = entries(current)[1]["id"]
        current = change({"expectedRevision": current["revision"], "defaultProviderId": custom}, current)
        self.assertEqual(current["kind"], "responses")
        current = change({"expectedRevision": current["revision"], "providerId": custom, "enabled": False}, current)
        self.assertEqual(current["defaultProviderId"], "default")
        self.assertEqual(len(configuration(current, self.layout)["model_providers"]), 1)
        with self.assertRaises(DeployError):
            change({"expectedRevision": current["revision"], "providerId": "default", "enabled": False}, current)
        current = change({"expectedRevision": current["revision"], "removeProviderId": custom}, current)
        self.assertEqual(len(entries(current)), 1)

    def test_multi_provider_policy_constrains_definitions_not_one_global_selection(self):
        current = self.add(self.current)
        defaults, required = provider_documents(current, self.layout)
        self.assertNotIn("model_provider", required)
        self.assertEqual(set(required["model_providers"]), set(defaults["model_providers"]))
        composed = compose_layers(defaults, required, {"config.toml": {}, "requirements.toml": {}, "managed_config.toml": {}})
        self.assertIn(b"harness_chatgpt", composed["requirements.toml"])
        with self.assertRaises(DeployError):
            compose_layers(defaults, required, {"config.toml": {"model_providers": {"harness_chatgpt": {"base_url": "https://other.invalid"}}}, "requirements.toml": {}, "managed_config.toml": {}})

    def test_equal_model_ids_keep_distinct_per_thread_catalog_paths_and_capabilities(self):
        current = self.add(self.current)
        first = entries(current)[1]
        first["settings"] = validate_catalog({"expectedRevision": first["settings"]["revision"], "models": [
            {"id": "same", "defaultEffort": "high", "efforts": ["high"], "inputModalities": ["text", "image"]}]}, first["settings"])
        current["connections"][1] = first
        current = self.add(current, baseUrl="https://two.invalid/v1", apiKey="fixture-two")
        second = entries(current)[2]
        second["settings"] = validate_catalog({"expectedRevision": second["settings"]["revision"], "models": [
            {"id": "same", "defaultEffort": None, "efforts": [], "inputModalities": ["text"]}]}, second["settings"])
        current["connections"][2] = second
        registry = runtime_registry(current, self.layout)
        one, two = registry["connections"][1:]
        self.assertNotEqual(one["catalogPath"], two["catalogPath"])
        self.assertNotEqual(one["modelProvider"], two["modelProvider"])
        self.assertEqual(one["models"][0]["efforts"], ["high"])
        self.assertEqual(two["models"][0]["efforts"], [])
        self.assertNotIn("model_catalog_json", configuration(current, self.layout))

    def test_generation_writes_a_bounded_public_registry_and_endpoint_keys(self):
        current = self.add(self.current)
        store = ProviderStore(self.layout, 1)
        # This ordinary fixture checks serialization. Root-owned publication
        # uses fchown and is exercised in root/test_provider_extended.py.
        with patch("deploy.provider.mkdir", side_effect=lambda path, *args, **kwargs: path.mkdir(parents=True, exist_ok=True)), \
             patch("deploy.common.os.fchown", create=True):
            store.prepare(current, layered=False)
        generation = self.layout.config / "providers" / current["revision"]
        public = json.loads((generation / "runtime.json").read_text(encoding="utf-8"))
        self.assertEqual(len(public["connections"]), 2)
        self.assertNotIn("fixture-one", json.dumps(public))
        self.assertIn("HARNESS_PROVIDER_REGISTRY_FILE=", (generation / "provider.env").read_text())

    def test_legacy_generation_rejects_enabled_secondary_advanced_providers_before_writing(self):
        for kind in ("chatgpt-gateway", "bedrock-runtime", "bedrock-mantle"):
            with self.subTest(kind=kind):
                params = {"expectedRevision": self.current["revision"], "providerId": "new", "kind": kind}
                if kind == "chatgpt-gateway":
                    params.update(baseUrl="https://gateway.invalid/v1", confirmGatewayCredentials=True,
                                  gatewayOAuth={"authorizationUrl": "https://login.invalid/authorize", "tokenUrl": "https://login.invalid/token",
                                                "clientId": "public-fixture", "cookieName": "fixture-auth"})
                else:
                    params.update(region="us-east-1", apiKey="fixture-only")
                current = change(params, self.current)
                self.assertEqual(current["kind"], "chatgpt")
                store = ProviderStore(self.layout, 1)
                before = set(self.layout.root.rglob("*"))
                with self.assertRaises(DeployError) as raised:
                    store.prepare(current, layered=False)
                self.assertEqual(raised.exception.code, "configuration_conflict")
                self.assertEqual(set(self.layout.root.rglob("*")), before)
                disabled = change({"expectedRevision": current["revision"], "providerId": entries(current)[1]["id"],
                                   "enabled": False}, current)
                with patch("deploy.provider.mkdir", side_effect=lambda path, *args, **kwargs: path.mkdir(parents=True, exist_ok=True)), \
                     patch("deploy.common.os.fchown", create=True):
                    generation = store.prepare(disabled, layered=False)
                self.assertTrue((store.root / generation / "runtime.json").exists())
                self.assertNotIn("fixture-only", (store.root / generation / "provider.env").read_text())

    def test_multiple_coding_plans_bind_each_mcp_to_its_own_key(self):
        current = self.current
        for key in ("fixture-plan-one", "fixture-plan-two"):
            current = change({"expectedRevision": current["revision"], "providerId": "new",
                              "kind": "zhipu-coding", "apiKey": key}, current)
        rows = entries(current)[1:]
        servers = configuration(current, self.layout)["mcp_servers"]
        for index, row in enumerate(rows):
            suffix = "" if index == 0 else "-" + row["id"]
            self.assertEqual(servers["zai-mcp-server" + suffix]["args"], ["zai-server", row["id"]])
            self.assertEqual(environment(current)[servers["zread" + suffix]["bearer_token_env_var"]], row["settings"]["apiKey"])

    def test_bedrock_retains_native_catalog_and_scoped_bearer_helper(self):
        current = change({"expectedRevision": self.current["revision"], "providerId": "new",
                          "kind": "bedrock-runtime", "region": "us-east-1", "apiKey": "fixture-aws"}, self.current)
        row = entries(current)[1]
        definition = configuration(current, self.layout)["model_providers"]["amazon-bedrock-runtime"]
        self.assertEqual(definition["auth"]["args"], ["bedrock-token", row["id"]])
        self.assertNotIn("wire_api", definition)
        self.assertEqual(environment(current)["AWS_REGION"], "us-east-1")
        with self.assertRaises(DeployError):
            change({"expectedRevision": current["revision"], "providerId": "new",
                    "kind": "bedrock-runtime", "region": "us-east-1", "apiKey": "fixture-other"}, current)


class ProviderDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.settings = {"kind": "zhipu-coding", "revision": "a" * 32, "baseUrl": "https://open.bigmodel.cn/api/v1",
                         "apiKey": "fixture-plan", "models": []}

    def test_codex_catalog_preserves_real_reasoning_and_media_metadata(self):
        models = parse_ids(json.dumps({"models": [{"slug": "exact-vendor-model",
            "default_reasoning_level": "max", "supported_reasoning_levels": [{"effort": "low"}, {"effort": "max"}],
            "input_modalities": ["text", "image"], "context_window": 100000, "shell_type": "unified_exec"}]}).encode())
        self.assertEqual(models[0]["efforts"], ["low", "max"])
        self.assertEqual(models[0]["inputModalities"], ["text", "image"])
        self.assertTrue(models[0]["supportsTools"])

    def test_id_only_catalog_does_not_invent_reasoning_levels(self):
        self.assertEqual(parse_ids(b'{"data":[{"id":"unknown-model"}]}'), [{"id": "unknown-model", "defaultEffort": None, "efforts": []}])

    def test_documented_zhipu_fallback_is_explicit_and_sets_a_default_when_omitted(self):
        with patch("deploy.catalog.fetch_ids", side_effect=DeployError("catalog_not_supported", "No /models")):
            result = apply_discovery(self.settings)
        self.assertEqual(result["model"], "glm-5.3")
        self.assertEqual(set(next(row["efforts"] for row in result["models"] if row["id"] == "glm-5.3")), {"low", "high", "max"})
        self.assertEqual(result["catalogSource"], "https://docs.bigmodel.cn/cn/coding-plan/tool/codex")

    def test_bad_keys_are_not_masked_by_a_static_vendor_catalog(self):
        self.settings["kind"] = "responses"
        with patch("deploy.catalog.fetch_ids", side_effect=DeployError("catalog_unauthorized", "目录授权失败")):
            result = initialize(self.settings)
            with self.assertRaises(DeployError):
                discover(self.settings)
        self.assertEqual(result["models"], [])
        self.assertEqual(result["catalogError"], "目录授权失败")

    def test_blank_saved_default_uses_the_existing_real_directory(self):
        value = apply_discovery(self.settings)
        value.pop("model")
        self.assertEqual(initialize(value)["model"], value["models"][0]["id"])

    def test_zhipu_uses_its_official_codex_catalog_not_an_unsupported_models_route(self):
        with patch("deploy.catalog.fetch_ids", side_effect=AssertionError("Coding Plan does not promise GET models")):
            result = apply_discovery(self.settings)
        self.assertEqual({row["id"] for row in result["models"]}, {"glm-5.3", "glm-5-turbo"})
        self.assertTrue(all(row["defaultEffort"] == "max" for row in result["models"]))

    def test_id_only_responses_uses_explicit_provider_tool_default_without_inventing_efforts(self):
        settings = {**self.settings, "kind": "responses", "supportsTools": True}
        with patch("deploy.catalog.fetch_ids", return_value=[{"id": "model", "defaultEffort": None, "efforts": []}]):
            result = apply_discovery(settings)
        self.assertEqual(result["models"][0]["toolsSource"], "configured")
        self.assertTrue(result["models"][0]["supportsTools"])
        self.assertEqual(result["models"][0]["efforts"], [])
        with patch("deploy.catalog.fetch_ids", return_value=[{"id": "model", "defaultEffort": None, "efforts": [], "supportsTools": False}]):
            result = apply_discovery(settings)
        self.assertFalse(result["models"][0]["supportsTools"])
        self.assertEqual(result["models"][0]["toolsSource"], "provider")


if __name__ == "__main__":
    unittest.main()
