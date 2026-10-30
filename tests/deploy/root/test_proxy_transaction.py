"""Root files and real Manager.verify; services, nft and upstream IO are isolated."""
import contextlib
import hashlib
import http.client
import io
import json
import os
import signal
import ssl
import subprocess
import sys
import tempfile
import time
import types
import unittest
import zipfile
from unittest.mock import patch
from pathlib import Path

from deploy import proxy_core, proxy_transaction as transaction, service_proxy
from deploy.common import DeployError, atomic_write, read_json, write_json
from tests.deploy.root import test_execution_mode as execution_fixture
from tests.deploy.root.test_config_layer import FixtureSystem, PowerLoss
from tests.deploy.test_service_proxy import vless
from tests.deploy.test_proxy_core import LoopbackPeer


class ProxySystem(FixtureSystem):
    def state(self, unit):
        value = super().state(unit)
        if unit == self.layout.unit("proxy-routes") and "proxy-routes" in self.active:
            value.update(SubState="exited", MainPID="0")
        return value

    def start(self, units):
        for role in service_proxy.PROXY_ROLES:
            if self.layout.unit(role) in units: self.active.add(role)
        super().start(units)


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "Requires real root-owned proxy transaction fixture")
class ProxyTransactionRootTests(unittest.TestCase):
    def setUp(self):
        execution_fixture.ExecutionModeRootTests.setUp(self)
        self.system = ProxySystem(self.layout); self.manager.system = self.system
        self.manager.recover_control = lambda: self.system.events.append("recover-receipts")
        self.manager.healthy = lambda: self.system.events.append("health")
        write_json(self.layout.control / "capabilities.json", {"executionMode": 1, "providerConfigLayer": "system-v1", "serviceProxy": 1}, mode=0o644)
        self.input = self.root / "node.json"; write_json(self.input, vless())
        self.cores = {version: self.core(version) for version in ("26.10.1", "26.10.2")}
        self.kernel = None
        self.stack.enter_context(patch("deploy.proxy_core.prepare_core", side_effect=lambda layout, version, **kwargs: self.cores[version]))
        self.stack.enter_context(patch.object(transaction, "prerequisites"))
        self.stack.enter_context(patch.object(transaction, "check_core_config", side_effect=lambda layout, value: service_proxy.verify_selection(layout, {"serviceProxy": value})))
        self.stack.enter_context(patch.object(transaction, "apply_routes", side_effect=self.apply))
        self.stack.enter_context(patch.object(transaction, "remove_routes", side_effect=self.remove))
        self.stack.enter_context(patch.object(service_proxy, "ready", side_effect=self.ready))
        self.stack.enter_context(patch.object(transaction, "ready", side_effect=self.ready))

    def core(self, version):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as archive:
            for name in proxy_core.FILES: archive.writestr(name, (version + name + " offline fixture").encode())
        data = stream.getvalue(); identity = hashlib.sha256(data).hexdigest(); asset = proxy_core.ASSETS[proxy_core.architecture()]
        metadata = {"tag_name": "v" + version, "draft": False, "prerelease": False, "published_at": "2026-10-01T00:00:00Z",
                    "assets": [{"name": asset, "size": len(data), "state": "uploaded", "digest": "sha256:" + identity,
                                "browser_download_url": proxy_core.DOWNLOAD + "/v" + version + "/" + asset}]}
        with patch.object(proxy_core, "_fetch", side_effect=[json.dumps(metadata).encode(), data]):
            return proxy_core.prepare_core(self.layout, version)

    def apply(self, layout, value, *, prior=None):
        self.assertFalse(self.system.active & {"worker", "gateway"})
        if self.kernel is not None:
            self.assertIn(self.kernel, [service_proxy.routing_objects(layout, row) for row in (value, prior) if row is not None])
        self.kernel = service_proxy.routing_objects(layout, value)

    def remove(self, layout, value):
        self.assertFalse(self.system.active & {"worker", "gateway"})
        if self.kernel is not None: service_proxy.verify_routes(layout, value, self.kernel)
        self.kernel = None

    def ready(self, manager, **kwargs):
        value = service_proxy.selection(manager.config)
        self.assertTrue(service_proxy.PROXY_ROLES[0] in self.system.active)
        service_proxy.verify_routes(self.layout, value, self.kernel)
        return {"enabled": True, "ready": True, "upstreamTlsVerified": bool(kwargs.get("upstream"))}

    def configure(self):
        return transaction.change(self.manager, action="configure", confirm_restart=True, input_file=self.input, version="26.10.1")

    def test_configure_update_disable_and_rollback_preserve_private_data_and_old_cores(self):
        auth = self.layout.state / "worker/codex/auth.json"; original = auth.read_bytes()
        first = self.configure(); self.assertTrue(first["changed"])
        self.assertEqual(self.system.active, {"worker", "gateway", "proxy", "proxy-routes"})
        result = transaction.change(self.manager, action="core-update", confirm_restart=True, version="26.10.2")
        self.assertEqual(result["coreVersion"], "26.10.2")
        self.assertEqual(proxy_core.verify_core(self.layout, first["core"])["version"], "26.10.1")
        transaction.change(self.manager, action="disable", confirm_restart=True)
        self.assertEqual(self.system.active, {"worker", "gateway"}); self.assertIsNone(self.kernel)
        self.assertFalse(self.manager.verify()["serviceProxy"]["enabled"])
        transaction.change(self.manager, action="rollback", confirm_restart=True)
        self.assertTrue(self.manager.verify()["serviceProxy"]["ready"])
        self.assertEqual(auth.read_bytes(), original)

    def test_core_preflight_failure_is_before_any_service_stop_or_journal(self):
        with patch.object(transaction, "check_core_config", side_effect=DeployError("candidate_failed", "Fixture core rejects config")), self.assertRaises(DeployError): self.configure()
        self.assertEqual(self.system.events, [])
        self.assertEqual(list((self.layout.state / "transactions").glob("*/state.json")), [])
        self.assertNotIn("serviceProxy", self.manager.config)

    def test_candidate_start_failure_recovers_original_no_proxy_state(self):
        original = transaction.snapshot(self.manager); self.system.fail_start = True
        with self.assertRaisesRegex(DeployError, "One-time start failure"): self.configure()
        self.assertEqual(transaction.snapshot(self.manager), original)
        self.assertEqual(self.system.active, {"worker", "gateway"}); self.assertIsNone(self.kernel)
        self.manager.require_update_ready(persist=False); self.manager.verify()

    def test_partial_publication_keeps_old_firewall_and_recovers(self):
        self.configure(); original = transaction.snapshot(self.manager); previous = self.kernel
        failed = False
        def fail(path, data, *args, **kwargs):
            nonlocal failed
            if path == transaction.paths(self.layout)["proxy"] and not failed:
                failed = True; raise OSError("fixture partial proxy publication")
            return atomic_write(path, data, *args, **kwargs)
        with patch.object(transaction, "atomic_write", side_effect=fail), self.assertRaises(OSError):
            transaction.change(self.manager, action="configure", confirm_restart=True, input_file=self.input, version="26.10.2", port=18801)
        self.assertEqual(transaction.snapshot(self.manager), original); self.assertEqual(self.kernel, previous)
        self.manager.require_update_ready(persist=False); self.manager.verify()

    def test_crash_selected_repair_candidate_uses_real_verify(self):
        observed = []
        def crash(path, value, **kwargs):
            write_json(path, value, **kwargs)
            if value.get("kind") == "service-proxy" and value.get("phase") == "selected":
                observed.append(path); raise PowerLoss()
        with patch.object(transaction, "write_json", side_effect=crash), self.assertRaises(PowerLoss): self.configure()
        with self.assertRaises(DeployError): self.manager.require_update_ready(persist=False)
        self.assertEqual(self.manager.repair(target="candidate")["direction"], "candidate")
        self.assertEqual(read_json(observed[0])["phase"], "committed")
        self.assertTrue(self.manager.verify()["serviceProxy"]["ready"])

    def test_failed_recovery_keeps_pending_barriers_and_all_services_stopped(self):
        with patch.object(self.manager, "healthy", side_effect=DeployError("health", "Fixture unhealthy")), self.assertRaises(DeployError): self.configure()
        self.assertFalse(self.system.active)
        self.assertTrue((self.layout.config / "config-layer-maintenance/worker").exists())
        with self.assertRaises(DeployError): self.manager.require_update_ready(persist=False)

    def test_originally_stopped_remains_stopped_and_mode_transaction_retains_proxy_selection(self):
        self.system.active.clear(); self.configure()
        self.assertFalse(self.system.active)
        selected = self.manager.config["serviceProxy"].copy()
        from deploy.execution_mode import change
        change(self.manager, root_allowed=True, confirm_restart=True)
        self.assertEqual(self.manager.config["serviceProxy"], selected); self.assertFalse(self.system.active)
        self.manager.verify()

    def test_terminal_publication_failure_does_not_reverse_selected_state(self):
        original = write_json; observed = []
        def fail(path, value, **kwargs):
            original(path, value, **kwargs)
            if value.get("kind") == "service-proxy" and value.get("phase") == "committed":
                observed.append(list(self.system.events)); raise OSError("fixture terminal fsync")
        with patch.object(transaction, "write_json", side_effect=fail), self.assertRaises(OSError): self.configure()
        self.assertEqual(self.system.events, observed[0])
        self.assertTrue(self.manager.verify()["serviceProxy"]["ready"]); self.manager.require_update_ready(persist=False)

    def test_rollback_refuses_nonprivate_or_unbound_previous_journal_before_stop(self):
        first = self.configure(); path = self.layout.state / "transactions" / first["transaction"] / "state.json"
        before = list(self.system.events); path.chmod(0o644)
        with self.assertRaises(DeployError): transaction.change(self.manager, action="rollback", confirm_restart=True)
        self.assertEqual(self.system.events, before); path.chmod(0o600)
        record = read_json(path); record["candidateConfig"]["port"] = 9999; write_json(path, record)
        with self.assertRaises(DeployError): transaction.change(self.manager, action="rollback", confirm_restart=True)
        self.assertEqual(self.system.events, before)

    def test_upstream_deadline_after_selection_compensates_to_previous_core_and_activity(self):
        self.configure(); before = transaction.snapshot(self.manager)
        def timeout(manager, *, upstream=False):
            if upstream: raise DeployError("proxy_timeout", "Service proxy HTTPS deadline exceeded")
            return self.ready(manager, upstream=False)
        with patch.object(transaction, "ready", side_effect=timeout), self.assertRaisesRegex(DeployError, "deadline"):
            transaction.change(self.manager, action="core-update", confirm_restart=True, version="26.10.2")
        self.assertEqual(transaction.snapshot(self.manager), before)
        self.assertEqual(self.system.active, {"worker", "gateway", "proxy", "proxy-routes"})
        self.manager.require_update_ready(persist=False); self.manager.verify()


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "Real Linux timer and local TLS fixture")
class ProxyUpstreamDeadlineRootTests(unittest.TestCase):
    def test_total_https_deadline_covers_connect_tls_and_headers_and_closes_connections(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory); certificate, key = folder / "fixture.crt", folder / "fixture.key"
            subprocess.run(["/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                            "-subj", "/CN=chatgpt.com", "-addext", "subjectAltName=DNS:chatgpt.com",
                            "-keyout", str(key), "-out", str(certificate)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            server = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); server.load_cert_chain(certificate, key)
            client = ssl.create_default_context(cafile=str(certificate))
            for phase in ("connect", "tls", "headers", "success"):
                requests = []
                def serve(connection, _count, stop):
                    requests.append(LoopbackPeer.headers(connection))
                    if phase == "connect":
                        connection.sendall(b"HTTP/1.1 200 Connection established\r\n")
                        for _ in range(100):
                            if stop.wait(0.02): return
                            connection.sendall(b"X-Fixture: slowly\r\n")
                        return
                    connection.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
                    if phase == "tls": stop.wait(2); return
                    with server.wrap_socket(connection, server_side=True) as secured:
                        requests.append(LoopbackPeer.headers(secured))
                        if phase == "success":
                            secured.sendall(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n"); return
                        secured.sendall(b"HTTP/1.1 200 OK\r\n")
                        for _ in range(100):
                            if stop.wait(0.02): return
                            secured.sendall(b"X-Fixture: slowly\r\n")
                with self.subTest(phase=phase), LoopbackPeer(serve) as peer:
                    layout = execution_fixture.Layout("fixture", folder)
                    value = {"enabled": True, "port": peer.port - 1, "core": "a" * 64, "configuration": "b" * 64}
                    system = types.SimpleNamespace(state=lambda unit: {"ActiveState": "active", "SubState": "running", "MainPID": "1", "ControlPID": "0"} if unit == layout.unit("proxy") else {"stopped": True})
                    manager = types.SimpleNamespace(layout=layout, config={"serviceProxy": value}, system=system)
                    connections = []
                    original = http.client.HTTPSConnection
                    class TrackedConnection(original):
                        def __init__(self, *args, **kwargs):
                            super().__init__(*args, **kwargs); connections.append(self)
                    previous = signal.getsignal(signal.SIGALRM); started = time.monotonic()
                    with patch.object(service_proxy, "UPSTREAM_TIMEOUT", 0.25), patch.object(service_proxy, "wait_listeners"), patch.object(service_proxy, "verify_routes", return_value=[]), patch.object(service_proxy.ssl, "create_default_context", return_value=client), patch.object(service_proxy, "http", types.SimpleNamespace(client=types.SimpleNamespace(HTTPSConnection=TrackedConnection))):
                        if phase == "success":
                            self.assertTrue(service_proxy.ready(manager, upstream=True)["upstreamTlsVerified"])
                        else:
                            with self.assertRaises(DeployError) as error: service_proxy.ready(manager, upstream=True)
                            self.assertEqual(error.exception.code, "proxy_timeout")
                    self.assertLess(time.monotonic() - started, 1)
                    self.assertEqual(len(connections), 1); self.assertIsNone(connections[0].sock)
                    self.assertTrue(requests[0].startswith(b"CONNECT chatgpt.com:443 "))
                    if phase in ("headers", "success"): self.assertTrue(requests[1].startswith(b"HEAD / "))
                    self.assertIs(signal.getsignal(signal.SIGALRM), previous)
                    self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))


if __name__ == "__main__": unittest.main()
