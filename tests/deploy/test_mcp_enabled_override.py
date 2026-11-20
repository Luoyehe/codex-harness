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
