"""Service-specific proxy policy tests; nft, network and services are substituted."""
import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from deploy.common import DeployError, Layout
from deploy import service_proxy as proxy


def selected(port=18790, enabled=True):
    return {"enabled": enabled, "port": port, "core": "a" * 64, "configuration": "b" * 64}


def vless():
    # Offline configuration data only; never a reachable node or real credential.
    return {"protocol": "vless", "tag": "untrusted-original", "settings": {"vnext": [
        {"address": "node.example.invalid", "port": 443, "users": [{"id": "00000000-0000-0000-0000-000000000001", "encryption": "none"}]}]},
        "streamSettings": {"network": "tcp", "security": "tls", "tlsSettings": {"serverName": "node.example.invalid"}}}


class ServiceProxyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.layout = Layout("fixture", Path(self.temp.name))

    def objects(self, value=None, members=()):
        rows = copy.deepcopy(proxy.routing_objects(self.layout, selected() if value is None else value))
        for row in rows:
            if "set" in row:
                row["set"]["elem"] = list(members)
        return rows

    def test_unconfigured_default_needs_no_host_tools_services_or_network(self):
        manager = SimpleNamespace(config={}, layout=self.layout, system=Mock())
        with patch.object(proxy, "run") as run, patch.object(proxy.socket, "create_connection") as connect:
            self.assertIsNone(proxy.selection({}))
            self.assertFalse(proxy.enabled({}))
            self.assertEqual(proxy.roles({}, ("worker",)), ("worker",))
            self.assertEqual(proxy.worker_unit_fields(self.layout, {}), ("", ""))
            self.assertEqual(proxy.render_proxy_units(self.layout, {}), {})
            self.assertEqual(proxy.status(manager), {"configured": False, "enabled": False, "coreVersion": None})
            self.assertEqual(proxy.ready(manager), {"enabled": False, "ready": False})
        run.assert_not_called(); connect.assert_not_called(); manager.system.state.assert_not_called()

    def test_selection_is_exact_and_disabled_retains_only_its_managed_definitions(self):
        value = selected(enabled=False)
        self.assertEqual(proxy.selection({"serviceProxy": value}), value)
        self.assertEqual(proxy.roles({"serviceProxy": value}, ("worker",)), ("worker", "proxy", "proxy-routes"))
        self.assertEqual(proxy.worker_unit_fields(self.layout, {"serviceProxy": value}), ("", ""))
        for change in ({"enabled": 1}, {"port": True}, {"port": 65535}, {"port": 1023}, {"core": "../core"},
                       {"configuration": "A" * 64}, {"user": "root"}):
            with self.subTest(change=change), self.assertRaises(DeployError):
                proxy.selection({"serviceProxy": {**value, **change}})

    def test_single_vless_import_generates_fixed_loopback_listeners_logs_and_direct_policy(self):
        original = vless()
        source = {"outbounds": [original, {"tag": "other", "protocol": "freedom"}],
                  "inbounds": [{"listen": "0.0.0.0", "port": 1}], "api": {"services": ["HandlerService"]},
                  "log": {"access": "untrusted.log"}, "routing": {"rules": [{"outboundTag": "other"}]}}
        value = proxy.configuration(source, 18790)
        self.assertEqual(value["log"], {"loglevel": "none", "access": "none", "error": "none"})
        self.assertEqual([(row["listen"], row["port"], row["protocol"]) for row in value["inbounds"]],
                         [("127.0.0.1", 18790, "dokodemo-door"), ("::1", 18790, "dokodemo-door"), ("127.0.0.1", 18791, "http")])
        self.assertEqual(value["outbounds"], [{**original, "tag": "proxy"}, {"tag": "direct", "protocol": "freedom", "settings": {}}])
        self.assertNotIn("api", value)
        rules = value["routing"]["rules"]
        self.assertEqual(rules[0]["domain"], ["domain:localhost", "domain:bigmodel.cn"])
        self.assertTrue(all(row["outboundTag"] == "direct" for row in rules))
        self.assertIn({"type": "field", "domain": ["geosite:cn"], "outboundTag": "direct"}, rules)
        self.assertEqual(source["outbounds"][0]["tag"], "untrusted-original")
        self.assertEqual(proxy.outbound({"outbound": original}), {**original, "tag": "proxy"})

    def test_import_rejects_ambiguous_or_unrelated_outbound_fields_and_invalid_ports(self):
        for value in (None, {"outbounds": []}, {"outbounds": [vless(), vless()]}, {"outbounds": [vless()] * 17},
                      {"outbound": vless(), "routing": {}}, {**vless(), "listen": "0.0.0.0"},
                      {**vless(), "protocol": "freedom"}, {**vless(), "streamSettings": []}):
            with self.subTest(value=value), self.assertRaises(DeployError):
                proxy.outbound(value)
        for port in (True, 1, 65535, "18790"):
            with self.subTest(port=port), self.assertRaises(DeployError): proxy.configuration(vless(), port)

    def test_private_input_is_bounded_ordinary_single_link_and_preserves_ownership_requirement(self):
        target = self.layout.root / "node.json"; target.write_bytes(b"{}"); target.chmod(0o600)
        if os.name == "posix" and os.geteuid() != 0:
            with self.assertRaises(DeployError): proxy.private_file(target)
        else:
            self.assertEqual(proxy.private_file(target), b"{}")
        with self.assertRaises(DeployError): proxy.private_file(target, limit=1)
        with self.assertRaises(DeployError): proxy.private_file(self.layout.root)
        linked = self.layout.root / "node-link.json"; os.link(target, linked)
        with self.assertRaises(DeployError): proxy.private_file(target)

    def test_generated_units_are_fixed_and_scope_service_cgroups_not_host_uids(self):
        config = {"serviceProxy": selected()}
        units = proxy.render_proxy_units(self.layout, config)
        self.assertEqual(set(units), {self.layout.unit("proxy"), self.layout.unit("proxy-routes")})
        core_unit = units[self.layout.unit("proxy")]
        for field in ("DynamicUser=yes", "NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes", "StandardOutput=null", "StandardError=null", "LoadCredential=proxy-config.json:"):
            self.assertIn(field, core_unit)
        self.assertNotIn("node.example.invalid", core_unit)
        self.assertNotIn("PartOf=", core_unit)
        self.assertNotIn("PartOf=", units[self.layout.unit("proxy-routes")])
        unit, service = proxy.worker_unit_fields(self.layout, config)
        self.assertIn("BindsTo=" + self.layout.unit("proxy"), unit)
        self.assertIn("NFTSet=cgroup:inet:" + proxy.table_name(self.layout) + ":workers", service)
        self.assertNotIn("uid", service.lower()); self.assertNotIn("drop-in", core_unit)

    def test_nft_redirect_is_only_reachable_through_positive_instance_cgroup_match(self):
        rows = self.objects()
        output = [row["rule"] for row in rows if row.get("rule", {}).get("chain") == "output"]
        self.assertEqual(len(output), 1)
        self.assertEqual(output[0]["expr"], [{"match": {"op": "==", "left": {"socket": {"key": "cgroupv2", "level": 2}}, "right": "@workers"}}, {"jump": {"target": "scoped"}}])
        scoped = [row["rule"] for row in rows if row.get("rule", {}).get("chain") == "scoped"]
        self.assertEqual([row["expr"][-1] for row in scoped], [{"return": None}, {"return": None}, {"redirect": {"port": 18790}}])
        self.assertEqual(proxy.verify_routes(self.layout, selected(), rows), [])

    def test_nft_handles_are_ignored_but_per_chain_rule_order_is_integrity_relevant(self):
        rows = self.objects()
        for index, row in enumerate(rows): next(iter(row.values()))["handle"] = index + 1
        rows.insert(0, {"metainfo": {"version": "fixture"}})
        self.assertEqual(proxy.verify_routes(self.layout, selected(), rows), [])
        rules = [index for index, row in enumerate(rows) if row.get("rule", {}).get("chain") == "scoped"]
        rows[rules[0]], rows[rules[-1]] = rows[rules[-1]], rows[rules[0]]
        with self.assertRaisesRegex(DeployError, "policy differs"):
            proxy.verify_routes(self.layout, selected(), rows)

    def test_nft_membership_allows_only_exact_worker_gateway_and_fixed_manage_units(self):
        members = ["system.slice/" + self.layout.unit(role) for role in ("worker", "gateway")]
        members += ["system.slice/codex-harness-fixture-manage-" + "a" * 32 + ".service"]
        self.assertEqual(proxy.verify_routes(self.layout, selected(), self.objects(members=members)), members)
        for bad in (["system.slice/ssh.service"], ["system.slice/codex-harness-other-worker.service"],
                    ["system.slice/codex-harness-fixture-manage-short.service"], ["other.slice/" + self.layout.unit("worker")],
                    ["system.slice/" + self.layout.unit("worker") + "/child"], [123], members * 12):
            with self.subTest(members=bad), self.assertRaises(DeployError):
                proxy.verify_routes(self.layout, selected(), self.objects(members=bad))

    def test_reconfigure_preserves_pid1_managed_set_and_publishes_one_checked_rule_batch(self):
        before, after = selected(18790), selected(18792)
        members = ["system.slice/" + self.layout.unit("worker")]
        with patch.object(proxy, "read_routes", side_effect=[self.objects(before, members), self.objects(after, members)]), patch.object(proxy, "run") as run:
            proxy.apply_routes(self.layout, after, prior=before)
        self.assertEqual(run.call_count, 2)
        check, apply = run.call_args_list
        self.assertEqual(check.args[0], ["/usr/sbin/nft", "--check", "-f", "-"])
        self.assertEqual(apply.args[0], ["/usr/sbin/nft", "-f", "-"])
        self.assertEqual(check.kwargs["input"], apply.kwargs["input"])
        commands = apply.kwargs["input"].splitlines()
        table = proxy.table_name(self.layout)
        self.assertEqual([row for row in commands if row.startswith("flush ")], [f"flush chain inet {table} output", f"flush chain inet {table} scoped"])
        self.assertTrue(all(not any(row.startswith(prefix) for prefix in ("delete ", "flush set ", "flush table ", "add set ", "add table ")) for row in commands))
        self.assertEqual(len([row for row in commands if row.startswith("add rule ")]), 4)
        self.assertIn(f"add rule inet {table} output socket cgroupv2 level 2 @workers jump scoped", commands)

    def test_absent_table_is_created_but_foreign_policy_or_members_are_never_repaired(self):
        with patch.object(proxy, "read_routes", side_effect=[None, self.objects()]), patch.object(proxy, "run") as run:
            proxy.apply_routes(self.layout, selected())
        commands = run.call_args.kwargs["input"].splitlines()
        self.assertEqual(len([row for row in commands if row.startswith("add table ")]), 1)
        self.assertEqual(len([row for row in commands if row.startswith("add set ")]), 1)
        self.assertEqual(len([row for row in commands if row.startswith("add chain ")]), 2)
        self.assertEqual(len([row for row in commands if row.startswith("add rule ")]), 4)
        foreign = self.objects(); foreign[0]["table"]["comment"] = "another owner"
        for rows in (foreign, self.objects(members=["system.slice/ssh.service"])):
            with patch.object(proxy, "read_routes", return_value=rows), patch.object(proxy, "run") as run, self.assertRaises(DeployError):
                proxy.apply_routes(self.layout, selected())
            run.assert_not_called()
        with patch.object(proxy, "read_routes", return_value=self.objects()), patch.object(proxy, "run") as run:
            proxy.apply_routes(self.layout, selected())
        run.assert_not_called()

    def test_read_routes_distinguishes_absence_from_failed_owned_table_inspection(self):
        failure = SimpleNamespace(returncode=1, stdout="")
        with patch.object(proxy, "run", side_effect=[failure, SimpleNamespace(stdout='{"nftables":[]}')]):
            self.assertIsNone(proxy.read_routes(self.layout))
        listed = {"nftables": [{"table": {"family": "inet", "name": proxy.table_name(self.layout)}}]}
        with patch.object(proxy, "run", side_effect=[failure, SimpleNamespace(stdout=json.dumps(listed))]), self.assertRaisesRegex(DeployError, "Cannot inspect"):
            proxy.read_routes(self.layout)

    def test_cold_listener_start_waits_boundedly_and_core_exit_fails_immediately(self):
        manager = SimpleNamespace(layout=self.layout, system=Mock())
        manager.system.state.return_value = {"ActiveState": "active", "SubState": "running", "MainPID": "1", "ControlPID": "0"}
        clock = [0.0]
        def sleep(seconds): clock[0] += seconds
        connections = [ConnectionRefusedError(), ConnectionRefusedError(), Mock(), Mock(), Mock()]
        def connect(*args, **kwargs):
            result = connections.pop(0)
            if isinstance(result, Exception): raise result
            result.__enter__ = Mock(return_value=result); result.__exit__ = Mock(return_value=False)
            return result
        with patch.object(proxy.time, "monotonic", side_effect=lambda: clock[0]), patch.object(proxy.time, "sleep", side_effect=sleep), patch.object(proxy.socket, "create_connection", side_effect=connect):
            proxy.wait_listeners(manager, selected(), timeout=1)
        self.assertAlmostEqual(clock[0], 0.2); self.assertEqual(connections, [])
        with patch.object(proxy.time, "monotonic", side_effect=lambda: clock[0]), patch.object(proxy.time, "sleep", side_effect=sleep), patch.object(proxy.socket, "create_connection", side_effect=ConnectionRefusedError()), self.assertRaisesRegex(DeployError, "timed out"):
            proxy.wait_listeners(manager, selected(), timeout=0.3)
        self.assertAlmostEqual(clock[0], 0.5)
        manager.system.state.return_value = {"ActiveState": "failed", "SubState": "failed", "MainPID": "0", "ControlPID": "0"}
        with patch.object(proxy.socket, "create_connection") as connect, self.assertRaisesRegex(DeployError, "core stopped"):
            proxy.wait_listeners(manager, selected())
        connect.assert_not_called()

    def test_helpers_reject_nonroot_or_foreign_systemd_context_before_reading_configuration(self):
        for uid, cgroup, action in ((65534, "system.slice/" + self.layout.unit("proxy-routes"), "proxy-routes-start"),
                                    (0, "system.slice/ssh.service", "proxy-routes-start"),
                                    (0, "system.slice/" + self.layout.unit("gateway"), "proxy-core-check"),
                                    (0, "system.slice/" + self.layout.unit("proxy"), "rpc")):
            with self.subTest(uid=uid, cgroup=cgroup, action=action), patch.object(proxy.os, "geteuid", return_value=uid, create=True), patch.object(proxy, "current_cgroup", return_value=cgroup), patch("deploy.manager.Manager") as manager, self.assertRaises(DeployError):
                proxy.helper(self.layout, action)
            manager.assert_not_called()

    def test_management_requires_exact_current_unit_and_pid1_membership(self):
        request = "a" * 32
        expected = "system.slice/codex-harness-fixture-manage-" + request + ".service"
        manager = SimpleNamespace(config={"serviceProxy": selected()}, layout=self.layout)
        with patch.object(proxy, "current_cgroup", return_value=expected), patch.object(proxy, "verify_routes", return_value=[expected]):
            proxy.require_management_membership(manager, request)
        for current, members in ((expected, []), ("system.slice/ssh.service", [expected])):
            with patch.object(proxy, "current_cgroup", return_value=current), patch.object(proxy, "verify_routes", return_value=members), self.assertRaises(DeployError):
                proxy.require_management_membership(manager, request)

    def test_transient_config_check_uses_real_credential_path_json_extension_and_confirms_stop(self):
        with patch("deploy.proxy_core.verify_core"), patch.object(proxy, "verify_configuration"), patch.object(proxy, "run") as run, patch("deploy.system.System") as system:
            proxy.check_core_config(self.layout, selected())
        command = run.call_args.args[0]
        unit = next(item.split("=", 1)[1] for item in command if item.startswith("--unit="))
        self.assertEqual(command[-1], "/run/credentials/" + unit + "/proxy-config.json")
        self.assertTrue(any(item.startswith("--property=LoadCredential=proxy-config.json:") for item in command))
        self.assertNotIn("%d/proxy-config", command)
        system.return_value.stop.assert_called_once_with([unit])
        with patch("deploy.proxy_core.verify_core"), patch.object(proxy, "verify_configuration"), patch.object(proxy, "run", side_effect=TimeoutError), patch("deploy.system.System") as system, self.assertRaises(TimeoutError):
            proxy.check_core_config(self.layout, selected())
        self.assertEqual(system.return_value.stop.call_count, 1)


if __name__ == "__main__":
    unittest.main()
