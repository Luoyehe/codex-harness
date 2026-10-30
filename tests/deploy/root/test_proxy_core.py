"""Actual root filesystem checks in an isolated tree; HTTP remains offline."""
import hashlib
import http.client
import io
import json
import os
import stat
import signal
import sys
import tempfile
import time
import unittest
import zipfile
import urllib.request
from pathlib import Path
from unittest.mock import patch

from deploy.common import DeployError, Layout, exclusive
from deploy import proxy_core as core
from tests.deploy.test_proxy_core import LoopbackPeer


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "Requires real Linux root ownership fixtures")
class ProxyCoreRootTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.layout = Layout("fixture", Path(self.temp.name))
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            for name in core.FILES:
                archive.writestr(name, (name + " offline fixture").encode())
        data = output.getvalue(); identity = hashlib.sha256(data).hexdigest()
        version = "26.10.1"; asset = core.ASSETS[core.architecture()]
        value = {"tag_name": "v" + version, "draft": False, "prerelease": False, "published_at": "2026-10-01T00:00:00Z",
                 "assets": [{"name": asset, "size": len(data), "state": "uploaded", "digest": "sha256:" + identity,
                             "browser_download_url": core.DOWNLOAD + "/v" + version + "/" + asset}]}
        with patch.object(core, "_fetch", side_effect=[json.dumps(value).encode(), data]):
            self.record = core.prepare_core(self.layout, version)
        self.directory = core.core_path(self.layout, identity)
        self.assertEqual(core.verify_core(self.layout, identity), self.record)

    def verify(self):
        return core.verify_core(self.layout, self.record["core"])

    def test_published_files_are_root_owned_exact_modes_single_links(self):
        for name, mode in {**core.FILES, "manifest.json": 0o644}.items():
            info = (self.directory / name).stat()
            self.assertEqual(info.st_uid, 0); self.assertEqual(info.st_nlink, 1)
            self.assertEqual(stat.S_IMODE(info.st_mode), mode)
        self.assertEqual(stat.S_IMODE(self.directory.stat().st_mode), 0o755)

    def test_wrong_owner_group_write_execute_bits_and_hardlinks_are_rejected(self):
        target = self.directory / "xray"
        for mode in (0o777, 0o775, 0o644, 0o4755):
            target.chmod(mode)
            with self.subTest(mode=mode), self.assertRaises(DeployError): self.verify()
        target.chmod(0o755)
        os.chown(target, 65534, 65534)
        with self.assertRaises(DeployError): self.verify()
        os.chown(target, 0, 0)
        link = self.layout.root / "link"; os.link(target, link)
        with self.assertRaises(DeployError): self.verify()
        link.unlink(); self.assertEqual(self.verify(), self.record)

    def test_symlink_fifo_directory_and_unsafe_ancestor_fail_closed(self):
        target = self.directory / "geoip.dat"; original = target.read_bytes(); target.unlink()
        outside = self.layout.root / "outside"; outside.write_bytes(original)
        target.symlink_to(outside)
        with self.assertRaises((DeployError, OSError)): self.verify()
        target.unlink(); os.mkfifo(target)
        with self.assertRaises(DeployError): self.verify()
        target.unlink(); target.mkdir()
        with self.assertRaises(DeployError): self.verify()
        target.rmdir(); target.write_bytes(original); target.chmod(0o644)
        self.directory.parent.chmod(0o777)
        with self.assertRaises(DeployError): self.verify()
        self.directory.parent.chmod(0o755)
        os.chown(self.directory.parent, 65534, 65534)
        with self.assertRaises(DeployError): self.verify()
        os.chown(self.directory.parent, 0, 0)
        self.assertEqual(self.verify(), self.record)

    def test_manifest_owner_and_unknown_extra_files_are_not_loose_reuse(self):
        manifest = self.directory / "manifest.json"
        os.chown(manifest, 65534, 65534)
        with self.assertRaises(DeployError): self.verify()
        os.chown(manifest, 0, 0)
        (self.directory / "untracked").write_bytes(b"extra")
        with self.assertRaises(DeployError): self.verify()


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "Real Linux timer and isolated local sockets")
class ProxyDownloadDeadlineRootTests(unittest.TestCase):
    def test_total_download_deadline_bounds_headers_body_and_redirect_with_cleanup(self):
        initial = core.DOWNLOAD + "/v26.10.1/" + core.ASSETS["x64"]
        redirected = "https://release-assets.githubusercontent.com/github-production-release-asset/fixture"
        for phase in ("headers", "body", "redirect"):
            def serve(connection, count, stop):
                LoopbackPeer.headers(connection)
                if phase == "redirect" and count == 1:
                    stop.wait(0.1)
                    connection.sendall(("HTTP/1.1 302 Found\r\nLocation: " + redirected + "\r\nContent-Length: 0\r\n\r\n").encode())
                    return
                if phase == "body":
                    connection.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n")
                    piece = b"a"
                else:
                    connection.sendall(b"HTTP/1.1 200 OK\r\n")
                    piece = b"X-Fixture: slowly\r\n"
                for _ in range(100):
                    if stop.wait(0.02): return
                    connection.sendall(piece)
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as directory, LoopbackPeer(serve) as peer:
                responses = []; connections = []
                class LocalHTTPS(urllib.request.HTTPSHandler):
                    def https_open(self, request):
                        def connect(_host, timeout=30, **_):
                            connection = http.client.HTTPConnection("127.0.0.1", peer.port, timeout=timeout)
                            connections.append(connection); return connection
                        response = self.do_open(connect, request)
                        responses.append(response); return response
                build = urllib.request.build_opener
                previous = signal.getsignal(signal.SIGALRM)
                started = time.monotonic()
                with patch.object(core, "DOWNLOAD_TIMEOUT", 0.25), patch.object(core.urllib.request, "build_opener", side_effect=lambda *handlers: build(*handlers, LocalHTTPS())), patch.object(core.signal, "setitimer", wraps=signal.setitimer) as timer, self.assertRaises(DeployError) as error:
                    with exclusive(Path(directory) / "management.lock"):
                        core._fetch(initial, 1024, None, asset=True)
                self.assertEqual(error.exception.code, "download_timeout")
                self.assertLess(time.monotonic() - started, 1.0)
                self.assertEqual(sum(call.args[1] > 0 for call in timer.call_args_list), 1)
                self.assertEqual(peer.accepted, 2 if phase == "redirect" else 1)
                self.assertTrue(all(response.closed for response in responses))
                self.assertTrue(all(connection.sock is None for connection in connections))
                self.assertIs(signal.getsignal(signal.SIGALRM), previous)
                self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))
                with exclusive(Path(directory) / "management.lock"): pass

    def test_preexisting_real_alarm_is_not_replaced_or_delayed(self):
        previous = signal.getsignal(signal.SIGALRM)
        handler = lambda *_: None
        signal.signal(signal.SIGALRM, handler); signal.setitimer(signal.ITIMER_REAL, 2, 0.5)
        try:
            with self.assertRaisesRegex(DeployError, "existing alarm"):
                with core.network_deadline(0.1, "timeout", "message"): self.fail("Unexpected admission")
            remaining, interval = signal.getitimer(signal.ITIMER_REAL)
            self.assertGreater(remaining, 1); self.assertLessEqual(remaining, 2)
            self.assertEqual(interval, 0.5); self.assertIs(signal.getsignal(signal.SIGALRM), handler)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0); signal.signal(signal.SIGALRM, previous)


if __name__ == "__main__":
    unittest.main()
