import copy
import json
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy.common import DeployError, Layout
from deploy.manager import Manager
from deploy.provider import ProviderStore, native_config, redacted, validate_provider
from deploy.provider_layers import compose_layers, provider_documents
from deploy.units import sudo_rule


class BedrockProviderTests(unittest.TestCase):
    def setUp(self):
        self.current = {"revision": "a" * 32, "kind": "responses", "baseUrl": "https://previous.invalid", "apiKey": "old-secret", "models": []}
        self.params = {"expectedRevision": "a" * 32, "kind": "bedrock-runtime", "region": "us-east-1", "apiKey": "fixture-bedrock-bearer"}

    def test_only_same_kind_and_region_can_reuse_bearer(self):
        selected = validate_provider(self.params, self.current)
        unchanged = {"expectedRevision": selected["revision"], "kind": selected["kind"], "region": selected["region"]}
        self.assertEqual(validate_provider(unchanged, selected)["apiKey"], self.params["apiKey"])
        for change in ({"kind": "bedrock-mantle"}, {"region": "eu-west-1"}, {"apiKey": ""}):
            with self.subTest(change=change), self.assertRaises(DeployError): validate_provider({**unchanged, **change}, selected)
        with self.assertRaises(DeployError): validate_provider({key: value for key, value in self.params.items() if key != "apiKey"}, self.current)

    def test_uncontrolled_endpoints_profiles_commands_and_noncommercial_partitions_rejected(self):
        for field in ("baseUrl", "allowInsecureHttp", "profile", "credentialProcess", "gatewayOAuth"):
            with self.subTest(field=field), self.assertRaises(DeployError): validate_provider({**self.params, field: "uncontrolled"}, self.current)
        for region in ("https://elsewhere", "us-east-1/../../", "US-EAST-1", "us-gov-west-1", "cn-north-1", "us-iso-east-1", "us-east-1\n"):
            with self.subTest(region=region), self.assertRaises(DeployError): validate_provider({**self.params, "region": region}, self.current)
        for token in ("", " leading", "trailing ", "line\nbreak", "nul\0", "del\x7f"):
            with self.subTest(token=token), self.assertRaises(DeployError): validate_provider({**self.params, "apiKey": token}, self.current)

    def test_complete_builtin_policy_pins_endpoint_and_fixed_native_bearer_command(self):
        for kind, native, host, searches in (("bedrock-runtime", "amazon-bedrock-runtime", "bedrock-runtime.us-east-1.amazonaws.com", ["disabled"]),
                                              ("bedrock-mantle", "amazon-bedrock", "bedrock-mantle.us-east-1.api.aws", ["disabled", "cached"])):
            selected = validate_provider({**self.params, "kind": kind}, self.current)
            layout = Layout("fixture")
            defaults, required = provider_documents(selected, layout)
            self.assertEqual(required["model_provider"], native)
            self.assertEqual(required["allowed_login_methods"], ["api"])
            self.assertEqual(required["allowed_web_search_modes"], searches)
            provider = required["model_providers"][native]
            self.assertEqual(set(provider), {"base_url", "auth"})
            self.assertEqual(provider["base_url"], f"https://{host}/openai/v1")
            self.assertEqual(provider["auth"]["command"], str(layout.control / "native-launch"))
            self.assertEqual(provider["auth"]["args"], ["bedrock-token"])
            self.assertNotIn("bedrock-token", sudo_rule(layout))
            self.assertNotIn(self.params["apiKey"], json.dumps([defaults, required, redacted(selected)]))
            self.assertTrue(redacted(selected)["hasApiKey"])
            self.assertEqual(tomllib.loads(native_config(selected, layout).decode())["model_providers"], required["model_providers"])

    def test_host_policy_cannot_be_silently_weakened_by_complete_provider(self):
        defaults, required = provider_documents(validate_provider(self.params, self.current), Layout("fixture"))
        for mutation in ({"aws": {"profile": "uncontrolled"}}, {"http_headers": {"x-host-policy": "required"}}, {"base_url": "https://other.invalid/v1"}):
            host = {"config.toml": {}, "managed_config.toml": {}, "requirements.toml": {"model_providers": {"amazon-bedrock-runtime": {**required["model_providers"]["amazon-bedrock-runtime"], **mutation}}}}
            with self.subTest(mutation=mutation), self.assertRaises(DeployError): compose_layers(defaults, required, host)

    def test_legacy_layer_rejected_before_generation_material_created(self):
        selected = validate_provider(self.params, self.current)
        with tempfile.TemporaryDirectory() as name:
            store = ProviderStore(Layout("fixture", Path(name)), 0)
            with self.assertRaises(DeployError) as caught: store.prepare(selected, layered=False)
            self.assertEqual(caught.exception.code, "configuration_conflict")
            self.assertFalse(store.root.exists())

    def test_native_catalog_refresh_uses_no_root_aws_network_call(self):
        selected = validate_provider(self.params, self.current)
        fake = type("ProviderFixture", (), {"providers": type("StoreFixture", (), {"read": lambda _: selected})()})()
        with patch("deploy.catalog.fetch_ids", side_effect=AssertionError("No AWS discovery")):
            answer = Manager.refresh_models(fake, {"expectedRevision": selected["revision"]})
        self.assertEqual(answer["source"], "native")
        self.assertFalse(answer["requiresConfirmation"])


if __name__ == "__main__": unittest.main()
