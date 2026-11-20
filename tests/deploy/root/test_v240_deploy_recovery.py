"""Offline deployment regressions run on synthetic, root-owned Linux instances."""
import hashlib
import io
import os
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from deploy import dns_archive, https
from deploy.candidate_archive import checked_mounts, unmounted
from deploy.common import DeployError, Layout, atomic_write, write_json
from deploy.diagnostic_secrets import log_result
from deploy.dns_caddy_build import fetch_suffixes
from deploy.service_proxy import require_available_ports
from deploy.system import System
from deploy.units import edge_unit_variants, render_edge_units

@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "Linux root test fixtures")
class DeployRecoveryTests(unittest.TestCase):
    def setUp(self):
        # Trust all path ancestors as the real deployment does.
        tmpdir = Path("/var/lib")
        self.temp = tempfile.TemporaryDirectory(prefix="harness-v240-check-", dir=tmpdir)
        self.addCleanup(self.temp.cleanup)
        self.layout = Layout("v240-check", Path(self.temp.name))
        self.layout.config.mkdir(parents=True)
        self.layout.work.mkdir(parents=True)
        self.layout.control.mkdir(parents=True)

    def test_plain_edge_recovers_interrupted_download_and_only_adopts_pinned_binary(self):
        binary = b"offline caddy distribution fixture\n"
        output = io.BytesIO()
        with tarfile.open(mode="w:gz", fileobj=output) as archive:
            item = tarfile.TarInfo("caddy"); item.size = len(binary); item.mode = 0o755
            archive.addfile(item, io.BytesIO(binary))
        data = output.getvalue()
        archive = self.layout.work / f"caddy_{https.CADDY_VERSION}_linux_arm64.tar.gz"
        archive.write_bytes(b"partial")
        class Interrupted(io.BytesIO):
            def read(self, size=-1):
                if self.tell():
                    raise ConnectionResetError("offline interrupted fixture")
                return super().read(size)
        interrupted = Interrupted(b"partial")
        rejected = io.BytesIO(b"wrong digest")
        stream = io.BytesIO(data)
        for response in (interrupted,rejected,stream):
            response.url = "https://github.com/caddyserver/caddy/test-asset"
        opener = Mock(); opener.open.side_effect = [interrupted,rejected,stream]
        with patch.object(https, "architecture", return_value="arm64"), patch.dict(https.EDGE_HASHES, {("caddy","arm64"): hashlib.sha256(data).hexdigest()}), \
                patch.object(https.urllib.request, "build_opener", return_value=opener):
            with self.assertRaises(ConnectionResetError): https.edge_binary(self.layout, "caddy")
            with self.assertRaisesRegex(DeployError, "hash mismatch"): https.edge_binary(self.layout, "caddy")
            target = https.edge_binary(self.layout, "caddy")
            self.assertEqual(target.read_bytes(), binary)
            self.assertEqual({path.read_bytes() for path in self.layout.work.glob("*.interrupted-*")}, {b"partial", b"wrong digest"})
            (self.layout.config / "caddy-binary.json").unlink()
            self.assertEqual(https.edge_binary(self.layout, "caddy"), target)
            self.assertEqual(opener.open.call_count, 3)
            (self.layout.config / "caddy-binary.json").unlink()
            target.write_bytes(b"independent content")
            with self.assertRaises(DeployError):
                https.edge_binary(self.layout, "caddy")
            self.assertEqual(target.read_bytes(), b"independent content")

    def test_dns_retry_units_and_loop_image_cleanup_match_producers(self):
        if not Path("/run/systemd/system").exists() or not (int(next(line for line in Path("/proc/self/status").read_text().splitlines() if line.startswith("CapEff:")).split()[1], 16) & (1 << 21)):
            self.skipTest("Real ext4 loop mount requires an isolated Linux root machine")
        build = "a"*32
        stage = self.layout.work / ("dns-build-" + build)
        stage.mkdir()
        write_json(stage / "fetch-units.json", {"format":1,"suffixes":fetch_suffixes(build),"started":fetch_suffixes(build)})
        manager = SimpleNamespace(layout=self.layout, system=System(), require_service_ownership=Mock(),
                                  require_recovered_transactions=Mock(), verify=Mock())
        units = dns_archive.producer_units(manager, build, stage)
        self.assertEqual(len(set(units)), 7)
        self.assertTrue(all(any(suffix in name for name in units) for suffix in fetch_suffixes(build)))
        mount = stage / "work"; mount.mkdir()
        image = mount.with_suffix(".ext4")
        with image.open("xb") as f: f.truncate(16*1024**2)
        image.chmod(0o600)
        subprocess.run(["/usr/sbin/mkfs.ext4", "-q", "-F", str(image)], check=True)
        subprocess.run(["/usr/bin/mount","-o","loop,nosuid,nodev",str(image),str(mount)], check=True)
        try:
            (mount / "retained-output").write_text("must survive")
            self.assertEqual(checked_mounts(stage, ("work",)), [mount])
            self.assertTrue(dns_archive.list_dns(manager)[0]["eligible"])
            self.assertTrue(os.path.ismount(mount))
            outcome = dns_archive.archive(manager, build, confirm=True)
            archived = Path(outcome["archive"])
            self.assertFalse(os.path.ismount(mount))
            self.assertTrue((archived / "work.ext4").is_file())
            self.assertEqual(subprocess.run(["/usr/sbin/debugfs", "-R", "cat /retained-output", str(archived / "work.ext4")],
                                            capture_output=True, check=True).stdout, b"must survive")
        finally:
            if os.path.ismount(mount):
                subprocess.run(["/usr/bin/umount",str(mount)],check=True)

    def test_legacy_unbound_active_dns_fetch_is_retained(self):
        build = "a" * 32
        stage = self.layout.work / ("dns-build-" + build)
        stage.mkdir()
        manager = SimpleNamespace(layout=self.layout, system=Mock(), require_service_ownership=Mock(),
                                  require_recovered_transactions=Mock(), verify=Mock())
        manager.system.state.return_value = {"stopped": False}
        historical_unit = f"codex-harness-{self.layout.instance}-dns-fetch-" + "b" * 32 + ".service"
        with patch("deploy.control_update.ControlSystem.instance_units", return_value=[historical_unit]):
            self.assertFalse(dns_archive.list_dns(manager)[0]["eligible"])
            with self.assertRaises(DeployError) as error:
                dns_archive.archive(manager, build, confirm=True)
            self.assertEqual(error.exception.code, "stop_unknown")
            self.assertTrue(stage.is_dir())
            manager.system.stop.assert_not_called()
        write_json(stage / "fetch-units.json", {"format": 1, "suffixes": fetch_suffixes(build), "started": ["wrong"]})
        with self.assertRaises(DeployError):
            dns_archive.producer_units(manager, build, stage)

    def test_privileged_launcher_verifies_ancestry_before_import(self):
        from shutil import copyfile
        root = Path(self.temp.name)
        source = root / "launcher"
        package = source / "deploy"
        package.mkdir(parents=True)
        script = source / "harness.sh"
        copyfile(Path(https.__file__).resolve().parents[1] / "harness.sh", script)
        (package / "__init__.py").touch()
        (package / "cli.py").write_text("print('loaded fixture')\n")
        def launch():
            return subprocess.run(["/bin/sh", str(script), "--help"], capture_output=True, text=True)
        good = launch()
        self.assertEqual((good.returncode, good.stdout.strip()), (0, "loaded fixture"))
        root.chmod(0o777)
        try:
            bad = launch()
            self.assertNotEqual(bad.returncode, 0)
            self.assertIn("属主或权限不可信", bad.stderr)
            self.assertNotIn("loaded fixture", bad.stdout)
        finally:
            root.chmod(0o700)

    def test_secondary_ipv6_port_can_already_be_bound(self):
        manager = SimpleNamespace(layout=self.layout,config={"port":3300})
        with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as secondary:
            secondary.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
            secondary.bind(("::1",0))
            port = secondary.getsockname()[1] - 1
            require_available_ports(manager,port)
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as required:
                required.bind(("127.0.0.1",port + 1))
                with self.assertRaises(DeployError): require_available_ports(manager,port)

    def test_public_region_short_state_and_incomplete_credential_inventory(self):
        layout = self.layout
        atomic_write(layout.config / "gateway-token", b"fixture-gateway")
        dns = layout.config / "dns" / ("a"*32)
        dns.mkdir(parents=True)
        atomic_write(dns / "credentials.env", b"HARNESS_ROUTE53_REGION=us-east-1\nHARNESS_ROUTE53_ACCESS_KEY_ID=sample-access\n", 0o600)
        providers = layout.config / "providers"; providers.mkdir()
        old = providers / ("b"*32); old.mkdir()
        write_json(old/"settings.json",{"kind":"responses","apiKey":"1","revision":"b"*32,"model":"test","models":[]})
        message = "us-east-1 status=1 ip=127.0.0.1 token=1 sample-access"
        result = log_result(layout, providers, message)
        self.assertEqual(result["text"], "us-east-1 status=1 ip=127.0.0.1 token=[redacted] [redacted]")
        (old/"settings.json").write_bytes(b"{")
        result = log_result(layout, providers, message)
        self.assertIn("b"*32, result["redactionNotice"])
        self.assertNotIn("sample-access",result["text"])

    def test_plain_edge_validator_executes_as_the_unprivileged_edge_identity(self):
        import pwd
        uid, gid = pwd.getpwnam("nobody").pw_uid, pwd.getpwnam("nobody").pw_gid
        binary = Path(self.temp.name) / "edge-test-program"
        Path(self.temp.name).chmod(0o755)
        binary.write_text("#!/bin/sh\nid -u; id -g; id -G; awk '/^NoNewPrivs:/ {print $2}' /proc/self/status\n")
        binary.chmod(0o755)
        result = https.validate_plain_caddy(self.layout, binary, Path("/dev/null"), uid, gid)
        self.assertEqual(result.stdout.splitlines(), [str(uid), str(gid), str(gid), "1"])
        with self.assertRaises(DeployError):
            https.validate_plain_caddy(self.layout, binary, Path("/dev/null"), 0, gid)

    def test_invalid_sudo_candidate_retains_existing_policy(self):
        from deploy.sudo_publish import publish
        dest = Path(self.temp.name) / "policy"
        publish(dest, b"root ALL=(root) /usr/bin/true\n")
        before = dest.read_bytes()
        with self.assertRaises(DeployError):
            publish(dest, b"this is not a valid policy\n")
        self.assertEqual(dest.read_bytes(), before)
        self.assertEqual(list(dest.parent.glob(".codex-harness-sudo-*")), [])

    def test_network_online_order_and_known_legacy_units(self):
        for unit in render_edge_units(self.layout).values():
            self.assertIn("Wants=network-online.target\n",unit)
            variants = edge_unit_variants(unit.encode())
            self.assertEqual(len(variants),2)
            self.assertTrue(any(b"Wants=network-online.target" not in item for item in variants))
