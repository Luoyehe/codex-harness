"""Read-only port preflight with synthetic proc tables and no real listeners."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

from deploy.common import DeployError, Layout
from deploy.ports import require_edge_ports_available, require_ports_available


class HttpsPortTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.proc = Path(self.temp.name)
        (self.proc / "net").mkdir()
        for name in ("tcp", "tcp6", "udp", "udp6"):
            (self.proc / "net" / name).write_text("sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n")

    def listener(self, name, port, inode="123", state=None):
        state = state or ("0A" if name.startswith("tcp") else "07")
        with (self.proc / "net" / name).open("a") as output:
            output.write(f"0: 00000000:{port:04X} 00000000:0000 {state} 00000000:00000000 00:00000000 00000000 0 0 {inode}\n")

    def test_unused_ports_and_unrelated_connections_pass(self):
        self.listener("tcp", 443, state="01")
        self.listener("tcp6", 9999)
        require_ports_available(tcp_ports=(80, 443), udp_ports=(443,), proc_root=self.proc)

    def test_tcp_ipv6_and_quic_conflicts_are_rejected(self):
        for name in ("tcp", "tcp6", "udp", "udp6"):
            with self.subTest(name=name):
                self.listener(name, 443)
                with self.assertRaisesRegex(DeployError, "Port 443"):
                    require_ports_available(tcp_ports=(80, 443), udp_ports=(443,), proc_root=self.proc)
                path = self.proc / "net" / name
                path.write_text(path.read_text().splitlines()[0] + "\n")

    def test_only_socket_inodes_held_by_the_allowed_process_are_reusable(self):
        self.listener("tcp", 443, inode="123")
        entries = MagicMock()
        entries.__enter__.return_value = iter([SimpleNamespace(path="fixture-fd")])
        with patch("deploy.ports.os.scandir", return_value=entries), patch("deploy.ports.os.readlink", return_value="socket:[123]"):
            require_ports_available(tcp_ports=(443,), allowed_pid=42, proc_root=self.proc)
        entries.__enter__.return_value = iter([SimpleNamespace(path="fixture-fd")])
        with patch("deploy.ports.os.scandir", return_value=entries), patch("deploy.ports.os.readlink", return_value="socket:[999]"), self.assertRaises(DeployError):
            require_ports_available(tcp_ports=(443,), allowed_pid=42, proc_root=self.proc)

    def test_unknown_listener_table_or_owner_fails_closed(self):
        (self.proc / "net/tcp").write_text("unexpected\n")
        with self.assertRaises(DeployError):
            require_ports_available(tcp_ports=(443,), proc_root=self.proc)
        with self.assertRaises(DeployError):
            require_ports_available(tcp_ports=(443,), allowed_pid=42, proc_root=self.proc)

    def test_edge_owner_is_bound_to_a_stable_managed_caddy_pid(self):
        state = {"ActiveState": "active", "SubState": "running", "MainPID": "42", "ControlPID": "0", "stopped": False}
        manager = SimpleNamespace(layout=Layout("fixture"), system=SimpleNamespace(state=Mock(return_value=state)))
        with patch("deploy.ports.require_ports_available") as inspect:
            require_edge_ports_available(manager, http_port=80, https_port=443)
            inspect.assert_called_once_with(tcp_ports=(80, 443), udp_ports=(443,), allowed_pid=42)
        manager.system.state.side_effect = [state, {**state, "MainPID": "43"}]
        with patch("deploy.ports.require_ports_available"), self.assertRaises(DeployError):
            require_edge_ports_available(manager, http_port=80, https_port=443)


if __name__ == "__main__":
    unittest.main()
