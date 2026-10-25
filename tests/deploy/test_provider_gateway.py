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


class GatewayProviderTests(unittest.TestCase):
    def setUp(self):
        self.current = {"kind": "responses", "revision": "a" * 32, "apiKey": "previous-secret", "models": []}
        self.params = {"kind": "chatgpt-gateway", "expectedRevision": "a" * 32, "baseUrl": "https://gateway.invalid/backend-api/codex/",
                       "gatewayOAuth": {"authorizationUrl": "https://login.invalid/authorize", "tokenUrl": "https://login.invalid/token", "clientId": "public-fixture", "cookieName": "auth-openid"},
                       "confirmGatewayCredentials": True}

    def test_new_or_changed_targets_require_explicit_credential_confirmation(self):
        for confirmation in (None, False, "true", 1):
            value = copy.deepcopy(self.params)
            if confirmation is None: value.pop("confirmGatewayCredentials")
            else: value["confirmGatewayCredentials"] = confirmation
            with self.assertRaises(DeployError): validate_provider(value, self.current)
        selected = validate_provider(self.params, self.current)
        unchanged = {**self.params, "expectedRevision": selected["revision"], "model": "model-fixture"}
        unchanged.pop("confirmGatewayCredentials")
        self.assertEqual(validate_provider(unchanged, selected)["model"], "model-fixture")
        for field in ("authorizationUrl", "tokenUrl", "clientId", "cookieName", "redirectPort"):
            changed = copy.deepcopy(unchanged)
            changed["gatewayOAuth"][field] = 43217 if field == "redirectPort" else "changed" if field in ("clientId", "cookieName") else "https://other.invalid/"
            with self.subTest(field=field), self.assertRaises(DeployError) as caught: validate_provider(changed, selected)
            self.assertEqual(caught.exception.code, "confirmation_required")

    def test_https_cookie_and_port_contract_rejects_unreviewed_extensions(self):
        credential_url = "https://" + ":".join(("user", "pass")) + "@gateway.invalid/v1"
        cases = [("baseUrl", value) for value in ("http://gateway.invalid/v1", credential_url, "https://gateway.invalid/v1?secret=x", "https://gateway.invalid/v1#fragment")]
        for key, value in cases:
            with self.subTest(value=value), self.assertRaises(DeployError): validate_provider({**self.params, key: value}, self.current)
        for key, value in (("cookieName", "a=b"), ("cookieName", "a;b"), ("cookieName", "a\nb"), ("redirectPort", 0), ("redirectPort", True), ("redirectPort", 65536), ("delivery", {"kind": "header", "name": "Authorization"}), ("clientSecret", "not-accepted")):
            changed = copy.deepcopy(self.params); changed["gatewayOAuth"][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(DeployError): validate_provider(changed, self.current)
        for field in ("apiKey", "allowInsecureHttp"):
            with self.assertRaises(DeployError): validate_provider({**self.params, field: "" if field == "apiKey" else False}, self.current)

    def test_complete_required_policy_contains_no_previous_credentials(self):
        selected = validate_provider(self.params, self.current)
        self.assertNotIn("apiKey", selected)
        self.assertFalse(redacted(selected)["hasApiKey"])
        defaults, required = provider_documents(selected, Layout("fixture"))
        self.assertEqual(required["allowed_login_methods"], ["chatgpt"])
        self.assertEqual(required["chatgpt_base_url"], "https://chatgpt.com/backend-api/")
        definition = required["model_providers"]["harness_chatgpt_gateway"]
        self.assertTrue(definition["requires_openai_auth"])
        self.assertEqual(definition["gateway_oauth"]["delivery"], {"kind": "cookie", "name": "auth-openid"})
        self.assertNotIn("env_key", definition)
        self.assertEqual(tomllib.loads(native_config(selected).decode())["model_providers"], required["model_providers"])
        self.assertNotIn("previous-secret", json.dumps([defaults, required, redacted(selected)]))
        for field, value in (("base_url", "https://other.invalid/v1"), ("http_headers", {"x-injected": "bad"})):
            host = {"config.toml": {}, "managed_config.toml": {}, "requirements.toml": {"model_providers": {"harness_chatgpt_gateway": {**definition, field: value}}}}
            with self.assertRaises(DeployError): compose_layers(defaults, required, host)

    def test_switch_clears_credentials_and_gateway_fields_cannot_leak_to_other_kinds(self):
        selected = validate_provider(self.params, self.current)
        with tempfile.TemporaryDirectory() as name:
            layout = Layout("fixture", Path(name)); store = ProviderStore(layout, 0)
            # Pure generation serialization; native ownership is tested on Linux separately.
            with patch("deploy.provider.mkdir", side_effect=lambda p, *a: p.mkdir(parents=True, exist_ok=True)), patch("deploy.provider.atomic_write", side_effect=lambda p, b, **kw: p.write_bytes(b)), patch("deploy.provider.write_json", side_effect=lambda p, v, **kw: p.write_text(json.dumps(v))), patch("deploy.provider_layers.generation_layers", return_value=({}, {})):
                generation = store.prepare(selected, layered=True)
            native = json.loads((store.root / generation / "native-env.json").read_text())
            self.assertEqual(native, {"HARNESS_PROVIDER_API_KEY": ""})
            self.assertNotIn("previous-secret", (store.root / generation / "provider.env").read_text())
        with self.assertRaises(DeployError): validate_provider({**self.params, "kind": "chatgpt"}, self.current)

    def test_native_catalog_refresh_never_makes_a_root_gateway_request(self):
        selected = validate_provider(self.params, self.current)
        fake = type("ProviderFixture", (), {"providers": type("StoreFixture", (), {"read": lambda _: selected})()})()
        with patch("deploy.catalog.fetch_ids", side_effect=AssertionError("native discovery only")):
            answer = Manager.refresh_models(fake, {"expectedRevision": selected["revision"]})
        self.assertEqual(answer["source"], "native")
        self.assertFalse(answer["applied"])


if __name__ == "__main__": unittest.main()
