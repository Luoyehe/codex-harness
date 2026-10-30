"""Execute the generated management bootstrap across control recovery barriers."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from deploy.common import Layout
from deploy.install import write_control_launchers


class ProxyBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.layout = Layout("fixture", Path(self.folder.name))
        module = self.layout.control / "deploy"
        module.mkdir(parents=True)
        (module / "__init__.py").write_text("", encoding="utf-8")
        # Only the downstream helper is substituted. The generated launcher is
        # executed unmodified by an isolated Python child, including its argv,
        # journal parsing and import barrier. Root/cgroup admission belongs to
        # the real helpers and their separate tests.
        (module / "cli.py").write_text(
            "import json, sys\n"
            "def helper_main(instance):\n"
            "    print(json.dumps({'instance': instance, 'args': sys.argv[1:]}))\n",
            encoding="utf-8",
        )
        write_control_launchers(self.layout, self.layout.control)
        self.record = self.layout.control.parent / ".fixture-control-transactions" / ("a" * 32) / "state.json"
        self.record.parent.mkdir(parents=True)

    def invoke(self, *args):
        result = subprocess.run(
            [sys.executable, "-I", str(self.layout.control / "manage"), *args],
            capture_output=True, timeout=10,
        )
        self.assertEqual(result.stderr, b"")
        self.assertEqual(list(self.layout.control.rglob("*.pyc")), [])
        return result

    def test_service_preflights_reach_helpers_during_each_pending_phase(self):
        for phase in ("prepared", "stopped", "installed", "recovering"):
            self.record.write_text(json.dumps({"phase": phase}), encoding="utf-8")
            for method in ("config-check", "proxy-core-check", "proxy-routes-start", "proxy-ready"):
                with self.subTest(phase=phase, method=method):
                    result = self.invoke(method)
                    self.assertEqual(result.returncode, 0)
                    self.assertEqual(json.loads(result.stdout), {"instance": "fixture", "args": [method]})

    def test_pending_control_still_blocks_rpc_execute_and_nonexact_helpers(self):
        self.record.write_text('{"phase":"installed"}', encoding="utf-8")
        for args in (("rpc",), ("execute", "b" * 32), (), ("proxy-ready-other",),
                     *((method, "extra") for method in (
                         "config-check", "proxy-core-check", "proxy-routes-start", "proxy-ready"))):
            with self.subTest(args=args):
                result = self.invoke(*args)
                self.assertEqual(result.returncode, 75)
                self.assertEqual(result.stdout, b"")

    def test_corrupt_record_blocks_management_but_not_fixed_service_preflight(self):
        for raw in ("not JSON", "[]", '{"phase":null}'):
            self.record.write_text(raw, encoding="utf-8")
            with self.subTest(raw=raw):
                blocked = self.invoke("rpc")
                self.assertEqual(blocked.returncode, 75)
                self.assertEqual(blocked.stdout, b"")
                self.assertEqual(self.invoke("proxy-core-check").returncode, 0)

    def test_all_records_must_be_terminal_before_management_can_enter(self):
        other = self.record.parent.parent / ("b" * 32) / "state.json"
        other.parent.mkdir()
        self.record.write_text('{"phase":"committed"}', encoding="utf-8")
        other.write_text('{"phase":"installed"}', encoding="utf-8")
        self.assertEqual(self.invoke("rpc").returncode, 75)
        other.write_text('{"phase":"recovered"}', encoding="utf-8")
        for args in (("rpc",), ("execute", "c" * 32)):
            with self.subTest(args=args):
                result = self.invoke(*args)
                self.assertEqual(result.returncode, 0)
                self.assertEqual(json.loads(result.stdout), {"instance": "fixture", "args": list(args)})
