"""Portable DNS recipe and build-policy checks; no network or root fixtures."""
import hashlib
import copy
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from deploy.common import DeployError, Layout, digest
from deploy.dns_caddy_build import (GO_HASHES, PROVIDER_PINS, SOURCE_HASHES, _fetch_dependencies, _go_command, _recipe_providers, dns_caddy_path,
                                    recipe, source_material, validate_download_proxy)


class DnsCaddyBuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.layout = Layout("fixture", Path(self.temp.name))

    def test_real_source_lock_and_architecture_are_recipe_inputs(self):
        files = source_material()
        self.assertEqual(set(files), {"main.go", "main_test.go", "go.mod", "go.sum"})
        self.assertEqual({name: hashlib.sha256(data).hexdigest() for name, data in files.items()}, SOURCE_HASHES)
        for pin in PROVIDER_PINS.values():
            self.assertIn((pin["module"] + " " + pin["version"]).encode(), files["go.mod"])
            self.assertIn((pin["module"] + " " + pin["version"] + " h1:").encode(), files["go.sum"])
        self.assertIn(b"github.com/caddyserver/caddy/v2 v2.11.7", files["go.mod"])
        self.assertIn(b"github.com/caddy-dns/alidns v1.0.29 h1:", files["go.sum"])
        self.assertNotEqual(digest(recipe("amd64")), digest(recipe("arm64")))
        self.assertEqual(recipe("arm64")["goArchiveSha256"], GO_HASHES["arm64"])

    def test_recipe_capabilities_are_explicit_and_legacy_remains_alidns_only(self):
        current = recipe("amd64")
        self.assertEqual(current["format"], 2)
        self.assertEqual(current["providers"], PROVIDER_PINS)
        self.assertEqual(_recipe_providers(current), set(PROVIDER_PINS))
        legacy = {key: value for key, value in current.items() if key != "providers"}
        legacy.update(format=1, provider="alidns", providerVersion="1.0.29")
        self.assertEqual(_recipe_providers(legacy), {"alidns"})
        subset = copy.deepcopy(current)
        subset["providers"] = {"cloudflare": subset["providers"]["cloudflare"]}
        self.assertEqual(_recipe_providers(subset), {"cloudflare"})
        for providers in ({}, {"dnspod": PROVIDER_PINS["tencentcloud"]},
                          {"alidns": {"module": "example.invalid/provider", "version": "v1.0.29"}},
                          {"alidns": {"module": PROVIDER_PINS["alidns"]["module"], "version": "latest"}}):
            with self.subTest(providers=providers), self.assertRaises(DeployError):
                _recipe_providers({**current, "providers": providers})

    def test_generation_revision_cannot_select_arbitrary_paths(self):
        for value in (None, "../elsewhere", "a" * 63, "A" * 64):
            with self.subTest(value=value), self.assertRaisesRegex(DeployError, "revision"):
                dns_caddy_path(self.layout, {"dnsBinaryRevision": value, "dnsBinarySha256": "0" * 64})

    def test_go_environment_is_fixed_and_build_is_offline(self):
        work = Path("/bounded/work")
        for network in (False, True):
            command = _go_command(Path("/verified/go/bin/go"), work, "arm64", "mod", "download", network=network)
            for item in ("GOTOOLCHAIN=local", "GOENV=off", "GOWORK=off", "GOVCS=*:off", "GOAUTH=off", "GOFLAGS=-mod=readonly",
                         "CGO_ENABLED=0", "GONOSUMDB=none", "GOARCH=arm64"):
                self.assertIn(item, command)
            self.assertIn("GOPROXY=https://proxy.golang.org" if network else "GOPROXY=off", command)
            self.assertIn("GOMAXPROCS=16" if network else "GOMAXPROCS=2", command)
            self.assertNotIn("direct", " ".join(command))

    def test_download_proxy_is_explicit_credential_free_loopback_only(self):
        for value in ("http://127.0.0.1:18790", "http://[::1]:18790"):
            self.assertEqual(validate_download_proxy(value), value)
        for value in ("http://proxy.example:80", "https://127.0.0.1:443", "http://" + "user:secret@" + "127.0.0.1:80",
                      "http://@127.0.0.1:80", "http://127.0.0.1", "http://127.0.0.1:80/", "http://127.0.0.1:0",
                      "http://127.0.0.1:80?secret=1", "http://127.0.0.1:80#tag", "http://127.0.0.1:80\n"):
            with self.subTest(value=value), self.assertRaises(DeployError):
                validate_download_proxy(value)
        for network in (True, False):
            command = _go_command(Path("/go"), Path("/work"), "amd64", "mod", "download", network=network,
                                  download_proxy="http://127.0.0.1:18790")
            self.assertEqual("HTTPS_PROXY=http://127.0.0.1:18790" in command, network)

    def test_fetch_retry_preserves_cache_and_uses_one_runtime_budget(self):
        manager = SimpleNamespace(layout=self.layout, system=Mock())
        manager.system.isolated.side_effect = [DeployError("candidate_failed", "network fixture"), None]
        with patch("deploy.dns_caddy_build.time.monotonic", side_effect=[100, 100, 400]):
            _fetch_dependencies(manager, "a" * 32, Path("/go"), Path("/source"), Path("/work"), "amd64", None)
        first, second = manager.system.isolated.call_args_list
        self.assertNotEqual(first.args[1], second.args[1])
        self.assertEqual(first.args[2:], second.args[2:])
        self.assertEqual((first.kwargs["timeout"], second.kwargs["timeout"]), (900, 600))

    def test_fetch_never_retries_unknown_stop_or_exhausted_budget(self):
        manager = SimpleNamespace(layout=self.layout, system=Mock())
        for code, clock_values in (("stop_unknown", [100, 100]), ("candidate_failed", [100, 100, 1001])):
            manager.system.isolated.reset_mock()
            manager.system.isolated.side_effect = DeployError(code, "fixture failure")
            with self.subTest(code=code), patch("deploy.dns_caddy_build.time.monotonic", side_effect=clock_values):
                with self.assertRaises(DeployError) as caught:
                    _fetch_dependencies(manager, "a" * 32, Path("/go"), Path("/source"), Path("/work"), "amd64", None)
            self.assertEqual(caught.exception.code, code)
            manager.system.isolated.assert_called_once()

    def test_fetch_stops_after_three_failed_attempts(self):
        manager = SimpleNamespace(layout=self.layout, system=Mock())
        manager.system.isolated.side_effect = DeployError("candidate_failed", "fixture failure")
        with patch("deploy.dns_caddy_build.time.monotonic", side_effect=[100, 100, 200, 300]):
            with self.assertRaises(DeployError):
                _fetch_dependencies(manager, "a" * 32, Path("/go"), Path("/source"), Path("/work"), "amd64", None)
        self.assertEqual(manager.system.isolated.call_count, 3)


if __name__ == "__main__":
    unittest.main()
