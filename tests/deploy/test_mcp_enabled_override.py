import json
import os
from pathlib import Path
import tempfile
import tomllib
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

    def test_old_dotted_inline_and_escaped_section_survive_repeated_launch(self):
        inputs = {
            "dotted-inline": b'model = "fixture"\nmcp_servers.web-reader = { enabled = false }\n',
            "escaped-section": b'model = "fixture"\n[mcp_servers."web\\u002dreader"]\nenabled = false\n',
        }
        self.system.write_bytes(b'[mcp_servers.web-reader]\ncommand = "local-fixture"\n')
        stored = {"@unassigned:web-reader": False}
        for spelling, original in inputs.items():
            for partially_migrated in (False, True):
                with self.subTest(spelling=spelling, partially_migrated=partially_migrated):
                    home = self.root / f"{spelling}-{partially_migrated}"
                    home.mkdir(mode=0o700)
                    config = home / "config.toml"
                    sidecar = home / switches.STORE
                    config.write_bytes(original)
                    if partially_migrated:
                        sidecar.write_bytes(b'{"@unassigned:web-reader": false}\n')
                    previous = None
                    for _ in range(2):
                        self.assertEqual(switches.launch_arguments(home, system=self.system), [])
                        self.assertEqual(tomllib.loads(config.read_text()), {"model": "fixture"})
                        self.assertEqual(json.loads(sidecar.read_bytes()), stored)
                        snapshot = [(p.stat().st_ino, p.stat().st_mtime_ns, p.read_bytes()) for p in (config, sidecar)]
                        if previous is not None:
                            self.assertEqual(snapshot, previous)
                        previous = snapshot

    def test_escaped_components_comments_and_unrelated_values_are_preserved(self):
        prefix = (
            b'model = "keep" # root setting\r\n'
            b'number = nan\r\n'
            b"example = '''\r\n"
            b'["looks\\invalid".server]\r\nenabled = true\r\n'
            b"'''\r\n"
        )
        suffix = b'[mcp_servers.personal]\r\ncommand = "keep" # unrelated server\r\n'
        section = (b'["mcp\\u005fservers"."one.with\\u002edot"] # header\r\n'
                   b'# comment between fields\r\n'
                   b'"enabl\\u0065d" = false # switch\r\n')
        config = self.home / "config.toml"
        config.write_bytes(prefix + section + suffix)
        expected = prefix + b'# header\r\n# comment between fields\r\n# switch\r\n' + suffix
        for _ in range(2):
            arguments = switches.launch_arguments(self.home, system=self.system)
            self.assertEqual(arguments, ["-c", 'mcp_servers={"one.with.dot" = {enabled = false}}'])
            self.assertEqual(config.read_bytes(), expected)
            self.assertEqual(json.loads((self.home / switches.STORE).read_bytes()), {"one.with.dot": False})

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
        self.manager.providers.select(self.manager.providers.prepare(old))
        path.write_text(json.dumps({"web-reader": True, "zai-mcp-server": False, "custom": True}))
        from deploy.mcp_switch_owners import capture_origins
        capture_origins(self.layout)
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

    def old_plan(self):
        from deploy.provider import validate_provider
        initial = self.manager.providers.read()
        old = validate_provider({"expectedRevision": initial["revision"], "kind": "zhipu-coding", "apiKey": "offline"}, initial)
        self.manager.providers.select(self.manager.providers.prepare(old))
        return old

    def legacy_home(self, name, fmt, flags):
        home = self.root / name
        home.mkdir(mode=0o700)
        if fmt == "json":
            (home / switches.STORE).write_text(json.dumps(flags))
        else:
            (home / "config.toml").write_text('model="preserved"\n' + "".join(
                f'[mcp_servers."{service}"]\nenabled={str(value).lower()}\n' for service, value in flags.items()))
        return home

    def test_cold_and_visited_json_and_toml_migrate_against_the_original_generation(self):
        from deploy.mcp_switch_owners import ORIGINS
        self.old_plan()
        flags = {"web-reader": True, "web-search-prime": True, "zread": True, "zai-mcp-server": False}
        homes = {(fmt, visit): self.legacy_home(fmt + str(visit), fmt, flags)
                 for fmt in ("json", "toml") for visit in (True, False)}
        from deploy.mcp_switch_owners import capture_origins
        capture_origins(self.layout)
        for (_, visit), home in homes.items():
            if visit:
                self.assertEqual(self.launched(home), flags)
        other = self.add_plan()
        baseline = (self.providers / ORIGINS).read_bytes()
        self.change(providerId="default", enabled=False)
        for home in homes.values():
            self.assertEqual(self.launched(home), {})
            self.assertEqual(self.state(home)["unassigned"], {})
        self.change(providerId="default", enabled=True)
        self.assertEqual((self.providers / ORIGINS).read_bytes(), baseline)
        for (fmt, _), home in homes.items():
            self.assertEqual(self.launched(home), flags)
            self.assertFalse(any(other in key for key in json.loads((home / switches.STORE).read_text())))
            if fmt == "toml":
                self.assertEqual((home / "config.toml").read_text(), 'model="preserved"\n')

    def test_early_display_only_sdk_suffixes_and_native_toml_respect_old_owner(self):
        from deploy import mcp_switch_owners
        from deploy.provider_registry import change
        old = self.old_plan()
        registry = change({"expectedRevision": old["revision"], "providerId": "new", "kind": "zhipu-coding", "apiKey": "second"}, old)
        self.manager.providers.select(self.manager.providers.prepare(registry))
        second = registry["connections"][-1]["id"]
        flags = {"web-reader": True, "web-reader-" + second: False, "zai-mcp-server-" + second: False}
        homes = [self.legacy_home(fmt, fmt, flags) for fmt in ("json", "toml")]
        mcp_switch_owners.publish(self.layout)  # Installed original registry at control takeover.
        self.change(providerId="default", enabled=False)
        for home in homes:
            self.assertEqual(self.launched(home), {"web-reader": False, "zai-mcp-server": False})
        self.change(providerId="default", enabled=True)
        for home in homes:
            self.assertEqual(self.launched(home), flags)

    def test_cold_legacy_files_survive_rollback_and_saved_profile_or_retire_with_deleted_owner(self):
        from unittest.mock import patch
        self.old_plan()
        flags = {"web-reader": True, "zai-mcp-server": False}
        rollback = self.legacy_home("rollback", "toml", flags)
        archived = self.legacy_home("archived", "json", flags)
        retired = self.legacy_home("retired", "toml", flags)
        self.add_plan()
        profile = self.change(saveProfileName="original")["profiles"][0]["id"]
        launches = []
        def health():
            launches.append(self.launched(rollback))
            if len(launches) == 1:
                raise RuntimeError("offline failed health check")
        with patch.object(self.manager, "healthy", side_effect=health), self.assertRaises(RuntimeError):
            self.change(removeProviderId="default")
        self.assertEqual(launches, [{}, flags])
        self.change(removeProviderId="default")
        self.assertEqual(self.launched(archived), {})
        self.change(profileId=profile)
        self.assertEqual(self.launched(archived), flags)
        self.change(removeProviderId="default")
        self.change(deleteProfileId=profile)
        self.assertEqual(self.launched(retired), {})
        self.assertEqual(self.state(retired)["unassigned"], {})
        self.assertNotIn("web-reader", (retired / "config.toml").read_text())

    def test_late_same_name_import_is_retained_for_explicit_recovery_only(self):
        from deploy import mcp_switch_owners
        self.old_plan()
        mcp_switch_owners.publish(self.layout)
        self.add_plan()
        self.change(providerId="default", enabled=False)
        for fmt in ("json", "toml"):
            home = self.legacy_home(fmt, fmt, {"web-reader": True})
            self.assertEqual(self.launched(home), {})
            before = self.state(home)
            self.assertEqual(before["unassigned"], {"web-reader": True})
            self.assertEqual(self.launched(home), {})
            self.assertEqual(before, self.state(home))
            import tomllib
            settings = tomllib.loads((home / "config.toml").read_text()) if fmt == "toml" else None
            params = {"name": "web-reader", "enabled": True, "expectedVersion": switches.version(settings) if settings is not None else None,
                      "expectedFlags": before["version"], "legacyName": "web-reader"}
            for bad in ({"name": "zread"}, {"enabled": False}, {"legacyName": "zread"}):
                with self.assertRaises(DeployError):
                    switches.apply(home, {**params, **bad}, system=self.system, providers=self.providers)
            result = switches.apply(home, params, system=self.system, providers=self.providers)
            self.assertEqual(result["unassigned"], {})
            self.assertEqual(self.launched(home), {"web-reader": True})
            self.assertEqual(self.state(home)["unassigned"], {})

    def test_conflicting_owner_history_or_collected_generation_does_not_authorize_a_guess(self):
        from deploy import mcp_switch_owners
        self.old_plan()
        home = self.legacy_home("before-upgrade", "toml", {"web-reader": True})
        self.add_plan()
        self.change(providerId="default", enabled=False)
        # Simulate upgrading an installation that already reassigned this name
        # under old controls. The managed transaction records and generations stay.
        (self.providers / mcp_switch_owners.ORIGINS).unlink()
        mcp_switch_owners.publish(self.layout)
        self.assertEqual(self.launched(home), {})
        self.assertEqual(self.state(home)["unassigned"], {"web-reader": True})

    def test_archive_at_capacity_can_be_discarded_without_a_matching_server(self):
        from deploy import mcp_switch_owners
        self.old_plan()
        self.add_plan()
        home = self.legacy_home("late", "json", {"web-reader": False})
        path = home / switches.STORE
        self.change(providerId="default", enabled=False)
        unknown = {"web-reader-" + format(number, "032x"): True for number in range(128)}
        path.write_text(json.dumps(unknown))
        self.assertEqual(self.launched(home), {})
        self.assertEqual(self.state(home)["unassigned"], unknown)
        self.set_flag("web-reader", True, home)
        state = self.state(home)
        original = next(iter(unknown))
        args = {"name": original, "enabled": True, "expectedVersion": None,
                "expectedFlags": state["version"], "discardLegacy": True}
        wrong = {**args, "enabled": False}
        with self.assertRaises(DeployError):
            switches.apply(home, wrong, system=self.system, providers=self.providers)
        saved = switches.apply(home, args, system=self.system, providers=self.providers)
        self.assertNotIn(original, saved["unassigned"])
        self.assertEqual(self.launched(home), {"web-reader": True})
        with self.assertRaises(DeployError):
            switches.apply(home, args, system=self.system, providers=self.providers)

    def test_old_interrupted_candidate_is_considered_before_recovery_starts_a_cold_home(self):
        from unittest.mock import patch
        from deploy import mcp_switch_owners
        from deploy.common import write_json
        from deploy.provider_registry import change
        old = self.old_plan()
        second = change({"expectedRevision": old["revision"], "providerId": "new", "kind": "zhipu-coding", "apiKey": "new"}, old)
        candidate = change({"expectedRevision": second["revision"], "providerId": "default", "enabled": False}, second)
        store = self.manager.providers
        store.select(store.prepare(candidate))
        home = self.legacy_home("candidate-home", "toml", {"web-reader": True})
        tx = self.layout.state / "transactions" / ("a" * 32)
        tx.mkdir(parents=True)
        write_json(tx / "state.json", {"kind": "provider", "phase": "selected", "old": old["revision"], "candidate": candidate["revision"]})
        self.assertFalse((self.providers / mcp_switch_owners.ORIGINS).exists())
        observed = []
        with patch.object(self.manager, "recover_control"), patch.object(self.manager, "healthy", side_effect=lambda: observed.append(self.launched(home))):
            self.manager.repair()
        self.assertEqual(observed, [{}])
        self.assertEqual(self.state(home)["unassigned"], {"web-reader": True})
        self.assertEqual(self.launched(home), {})
