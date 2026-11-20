import json
import os
from pathlib import Path
import tempfile
import unittest

from deploy import mcp_enabled_override as switches
from deploy.common import DeployError


@unittest.skipUnless(os.name == "posix", "native MCP launcher filesystem")
class McpEnabledOverrides(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.home = self.root / "codex"
        self.home.mkdir(mode=0o700)
        self.system = self.root / "system.toml"
        self.system.write_text('[mcp_servers."one.with.dot"]\ncommand="tool"\n[mcp_servers.zai-other]\nurl="https://example.invalid/mcp"\n')

    def test_instance_isolation_stale_version_unrelated_servers_and_restore(self):
        other = self.root / "other"; other.mkdir(mode=0o700)
        args = {"name": "one.with.dot", "enabled": False, "expectedVersion": None, "expectedFlags": switches.read(self.home, system=self.system)["version"]}
        saved = switches.apply(self.home, args, system=self.system)
        self.assertEqual(json.loads((self.home / switches.STORE).read_text()), {"one.with.dot": False})
        self.assertEqual(switches.read(other)["flags"], {})
        self.assertEqual(switches.launch_arguments(self.home, system=self.system), ['-c', 'mcp_servers={"one.with.dot" = {enabled = false}}'])
        with self.assertRaises(DeployError): switches.apply(self.home, {**args, "name": "zai-other"}, system=self.system)
        switches.apply(self.home, {**args, "expectedFlags": saved["version"], "enabled": None}, system=self.system)
        self.assertEqual(switches.launch_arguments(self.home, system=self.system), [])

    def test_legacy_switches_migrate_without_rewriting_other_fields_and_disappearing_system_servers_do_not_break_startup(self):
        cfg = self.home / "config.toml"
        cfg.write_text('# local settings\nmodel = "my-model"\n[mcp_servers.zai-other]\nenabled = false\n[mcp_servers.personal]\ncommand = "keep"\n')
        flags = switches.launch_arguments(self.home, system=self.system)
        self.assertEqual(flags, ['-c', 'mcp_servers={"zai-other" = {enabled = false}}'])
        self.assertEqual(cfg.read_text(), '# local settings\nmodel = "my-model"\n[mcp_servers.personal]\ncommand = "keep"\n')
        self.assertEqual(switches.launch_arguments(self.home, system=self.system), flags)
        self.system.write_text('')
        self.assertEqual(switches.launch_arguments(self.home, system=self.system), [])
        self.assertEqual(switches.read(self.home, system=self.system)["flags"], {})
        self.assertEqual(json.loads((self.home / switches.STORE).read_text()), {"zai-other": False})

    def test_a_reassigned_system_display_name_does_not_inherit_the_other_providers_boolean(self):
        def write_provider(identity):
            self.system.write_text('[mcp_servers.vision]\ncommand="/opt/native"\nargs=["zai-server", "' + identity + '"]\n')
        write_provider("default")
        old = switches.read(self.home, system=self.system)
        override = {"name": "vision", "enabled": False, "expectedVersion": None, "expectedFlags": old["version"]}
        switches.apply(self.home, override, system=self.system)
        selected = switches.read(self.home, system=self.system)
        write_provider("b" * 32)
        self.assertEqual(switches.launch_arguments(self.home, system=self.system), [])
        self.assertNotEqual(selected["version"], switches.read(self.home, system=self.system)["version"])
        with self.assertRaises(DeployError): switches.apply(self.home, {**override, "expectedFlags": selected["version"]}, system=self.system)
        write_provider("default")
        self.assertEqual(switches.launch_arguments(self.home, system=self.system), ["-c", 'mcp_servers={"vision" = {enabled = false}}'])


@unittest.skipUnless(os.name == "posix", "native provider control filesystem")
class ManagedSwitchLifecycle(unittest.TestCase):
    def setUp(self):
        from unittest.mock import Mock, patch
        from deploy.common import Layout, write_json
        from deploy.manager import Manager
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.layout = Layout("fixture", self.root)
        self.layout.config.mkdir(parents=True)
        write_json(self.layout.config / "instance.json", {"origin": "http://127.0.0.1:3300", "port": 3300})
        if os.geteuid():
            self.enterContext(patch("os.fchown"))
        self.manager = Manager(self.layout, Mock(), worker_gid=os.getgid())
        for method in ("require_service_ownership", "refresh_main_units", "healthy"):
            self.enterContext(patch.object(self.manager, method))
        store = self.manager.providers
        self.providers = store.root
        self.system = store.root / "current/config.toml"
        store.select(store.prepare({"kind": "chatgpt", "revision": "a" * 32, "models": []}))
        self.home = self.root / "native-home"
        self.home.mkdir(mode=0o700)

    def change(self, **params):
        return self.manager.provider_change({"expectedRevision": self.manager.providers.read()["revision"], **params})

    def add_plan(self):
        return self.change(providerId="new", kind="zhipu-coding", apiKey="offline-fixture")["connections"][-1]["id"]

    def state(self, home=None):
        return switches.read(home or self.home, system=self.system, providers=self.providers)

    def set_flag(self, name, value, home=None):
        home = home or self.home
        flags = self.state(home)
        return switches.apply(home, {"name": name, "enabled": value, "expectedVersion": None,
                                     "expectedFlags": flags["version"]}, system=self.system, providers=self.providers)

    def launched(self, home=None):
        import tomllib
        args = switches.launch_arguments(home or self.home, system=self.system, providers=self.providers)
        return {name: row["enabled"] for name, row in tomllib.loads(args[1] if args else "").get("mcp_servers", {}).items()}

    def test_all_four_settings_follow_their_owner_through_repeated_alias_changes(self):
        first = self.add_plan()
        second = self.add_plan()
        originals = {"web-reader": True, "web-search-prime": True, "zread": True, "zai-mcp-server": False}
        for name, flag in originals.items():
            self.set_flag(name, not flag)
            self.set_flag(name + "-" + second, flag)
        stale = self.state()["version"]
        for _ in range(2):
            self.change(providerId=first, enabled=False)
            self.assertEqual(self.launched(), originals)
            self.assertEqual(self.state()["flags"], originals)
            with self.assertRaises(DeployError):
                switches.apply(self.home, {"name": "web-reader", "enabled": False, "expectedVersion": None,
                                           "expectedFlags": stale}, system=self.system, providers=self.providers)
            self.change(providerId=first, enabled=True)
            self.assertEqual(self.launched(), {**{name: not flag for name, flag in originals.items()},
                                               **{name + "-" + second: flag for name, flag in originals.items()}})
        self.assertEqual(set(self.state()["codingPlanHttpDefaults"]), {name + suffix for name in originals if name != "zai-mcp-server" for suffix in ("", "-" + second)})
        self.change(providerId=first, enabled=False)
        self.set_flag("web-reader", None)
        self.change(providerId=first, enabled=True)
        self.assertNotIn("web-reader-" + second, self.launched())

    def test_legacy_aliases_merge_conservatively_and_custom_settings_are_separate(self):
        first = self.add_plan()
        second = self.add_plan()
        self.change(providerId=first, enabled=False)
        self.system = self.root / "host-merged.toml"
        self.system.write_bytes((self.providers / "current/config.toml").read_bytes().replace(
            b'"mcp_servers" = { ', ('"mcp_servers" = { "web-reader-' + first + '" = { url="https://host.invalid", bearer_token_env_var="HARNESS_PROVIDER_KEY_' +
                                    first.upper() + '" }, ').encode()))
        old = {"web-reader@provider:" + second: True, "web-reader-" + second + "@provider:" + second: False,
               "zai-mcp-server-" + second + "@provider:" + second: False, "zread@provider:" + first: False,
               "web-reader-" + first + "@provider:" + first: True, "arbitrary@@provider:default": True}
        (self.home / switches.STORE).write_text(json.dumps(old))
        self.assertEqual(self.launched(), {"web-reader": False, "zai-mcp-server": False, "web-reader-" + first: True})
        self.assertNotIn("web-reader-" + first, self.state()["codingPlanHttpDefaults"])
        self.set_flag("web-reader", True)
        self.assertTrue(self.launched()["web-reader"])
        (self.home / "config.toml").write_text('[mcp_servers.web-reader]\nurl="https://custom.invalid/mcp"\n')
        self.assertNotIn("web-reader", self.launched())
        saved = json.loads((self.home / switches.STORE).read_text())
        self.assertEqual(len(saved), 5)
        self.assertIn("arbitrary@@provider:default", saved)

    def test_failed_candidate_launch_preserves_both_homes_and_saved_profile_retains_its_owner(self):
        from unittest.mock import patch
        second_home = self.root / "second-home"
        second_home.mkdir(mode=0o700)
        owner = self.add_plan()
        self.set_flag("web-reader", True)
        self.set_flag("zai-mcp-server", False, second_home)
        launches = []
        def health():
            launches.append((self.launched(), self.launched(second_home)))
            if len(launches) == 1:
                raise RuntimeError("fixture health failure")
        with patch.object(self.manager, "healthy", side_effect=health), self.assertRaises(RuntimeError):
            self.change(removeProviderId=owner)
        self.assertEqual(launches, [({}, {}), ({"web-reader": True}, {"zai-mcp-server": False})])
        profile = self.change(saveProfileName="restorable")["profiles"][0]["id"]
        self.change(removeProviderId=owner)
        self.assertEqual(self.launched(), {})
        self.assertEqual(self.launched(second_home), {})
        self.change(profileId=profile)
        self.assertEqual(self.launched(), {"web-reader": True})
        self.assertEqual(self.launched(second_home), {"zai-mcp-server": False})
        self.change(removeProviderId=owner)
        self.change(deleteProfileId=profile)
        for home in (self.home, second_home):
            self.state(home)
            self.assertEqual(json.loads((home / switches.STORE).read_text()), {})

    def test_interrupted_compaction_and_unconfirmed_inventory_are_retryable(self):
        from unittest.mock import patch
        from deploy import mcp_switch_owners
        owner = self.add_plan()
        inventory = self.providers / mcp_switch_owners.INVENTORY
        published = json.loads(inventory.read_text())
        key = "web-reader@provider:" + owner
        orphan = "zread@provider:" + "e" * 32
        path = self.home / switches.STORE
        path.write_text(json.dumps({key: True, orphan: True}))
        with patch.object(switches, "_save", side_effect=OSError("interrupted")), self.assertRaises(OSError):
            self.state()
        self.assertEqual(json.loads(path.read_text()), {key: True, orphan: True})
        inventory.write_text(json.dumps({**published, "active": {"f" * 32: []}}))
        self.assertEqual(self.launched(), {"web-reader": True})
        self.assertEqual(len(json.loads(path.read_text())), 2)
        # Bootstrap from an already installed generation during control update.
        inventory.unlink()
        mcp_switch_owners.publish(self.layout)
        self.assertEqual(self.state()["flags"], {"web-reader": True})
        self.assertEqual(len(json.loads(path.read_text())), 1)

    def test_verified_single_plan_migrates_plain_switches_to_default_before_registry_transition(self):
        from deploy.provider import native_config, validate_provider
        from deploy.provider_registry import change, upgrade_mcp_defaults
        old = validate_provider({"expectedRevision": "a" * 32, "kind": "zhipu-coding", "apiKey": "offline"},
                                {"revision": "a" * 32, "kind": "chatgpt", "models": []})
        self.system = self.root / "single-plan.toml"
        self.system.write_bytes(native_config(upgrade_mcp_defaults(old), self.layout))
        path = self.home / switches.STORE
        path.write_text(json.dumps({"web-reader": True, "zai-mcp-server": False, "custom": True}))
        self.assertEqual(self.launched(), {"web-reader": True, "zai-mcp-server": False})
        registry = change({"expectedRevision": old["revision"], "providerId": "new", "kind": "zhipu-coding", "apiKey": "other"}, old)
        self.system.write_bytes(native_config(upgrade_mcp_defaults(registry), self.layout))
        self.assertEqual(self.launched(), {"web-reader": True, "zai-mcp-server": False})
        self.assertTrue(json.loads(path.read_text())["custom"])

    def test_churn_and_preupgrade_full_store_recover_without_discarding_a_custom_switch(self):
        names = ("web-search-prime", "web-reader", "zread", "zai-mcp-server")
        old = {}
        for _ in range(32):
            owner = self.add_plan()
            for name in names:
                self.set_flag(name, name != "zai-mcp-server")
                old[name + "@provider:" + owner] = False
            self.change(removeProviderId=owner)
        owner = self.add_plan()
        old.popitem()
        old["custom@@provider:" + owner] = True
        path = self.home / switches.STORE
        path.write_text(json.dumps(old))
        self.assertEqual(len(old), 128)
        self.assertEqual(self.set_flag("web-reader", True)["flags"], {"web-reader": True})
        self.assertEqual(len(json.loads(path.read_text())), 2)
        self.assertIn("custom@@provider:" + owner, json.loads(path.read_text()))
