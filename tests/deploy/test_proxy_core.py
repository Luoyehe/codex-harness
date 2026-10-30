"""Offline official-metadata/ZIP/publication tests; root ownership is tested separately."""
import copy
import contextlib
import hashlib
import io
import json
import os
import stat
import socket
import tempfile
import threading
import types
import unittest
import urllib.error
import urllib.request
import warnings
import zipfile
from pathlib import Path
from unittest.mock import Mock, patch

from deploy.common import DeployError, Layout
from deploy import proxy_core as core


def archive(entries=None):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as value:
        for name, data in entries or [("xray", b"offline executable fixture"), ("geoip.dat", b"geoip fixture"), ("geosite.dat", b"geosite fixture")]:
            if isinstance(name, str):
                info = zipfile.ZipInfo(name)
                # Preserve hostile raw names on Windows instead of letting the
                # fixture writer normalize backslashes before the reader sees them.
                info.filename = info.orig_filename = name
            else:
                info = name
            value.writestr(info, data)
    return output.getvalue()


def release(data, *, digest=True):
    sha = hashlib.sha256(data).hexdigest()
    asset = {"name": core.ASSETS["x64"], "size": len(data), "state": "uploaded", "browser_download_url": core.DOWNLOAD + "/v26.10.1/" + core.ASSETS["x64"]}
    if digest:
        asset["digest"] = "sha256:" + sha
    return {"tag_name": "v26.10.1", "draft": False, "prerelease": False, "published_at": "2026-10-01T00:00:00Z", "assets": [asset]}


class LoopbackPeer:
    """Real local socket peer shared by Linux-only deadline checks."""
    def __init__(self, handler):
        self.handler, self.stop = handler, threading.Event()
        self.listener = socket.socket(); self.listener.bind(("127.0.0.1", 0)); self.listener.listen(4)
        self.listener.settimeout(0.05); self.port = self.listener.getsockname()[1]
        self.errors, self.current, self.accepted = [], None, 0

    def __enter__(self):
        def serve():
            while not self.stop.is_set():
                try: connection, _ = self.listener.accept()
                except socket.timeout: continue
                except OSError: break
                self.current = connection; self.accepted += 1; connection.settimeout(2)
                try: self.handler(connection, self.accepted, self.stop)
                except OSError: pass  # Client cancellation is expected in timeout cases.
                except BaseException as error: self.errors.append(repr(error))
                finally: connection.close(); self.current = None
        self.thread = threading.Thread(target=serve, daemon=True); self.thread.start()
        return self

    def __exit__(self, *_):
        self.stop.set(); self.listener.close()
        if self.current is not None:
            try: self.current.shutdown(socket.SHUT_RDWR)
            except OSError: pass
        self.thread.join(3)
        if self.thread.is_alive() or self.errors: raise AssertionError("Local peer did not cleanly stop: " + repr(self.errors))

    @staticmethod
    def headers(connection):
        data = b""
        while b"\r\n\r\n" not in data and len(data) < 8192:
            block = connection.recv(1024)
            if not block: break
            data += block
        return data


class NetworkDeadlineContractTests(unittest.TestCase):
    def setUp(self):
        portable = patch.object(core, "sys", types.SimpleNamespace(platform="linux"))
        portable.start(); self.addCleanup(portable.stop)

    def signals(self, timer=(0.0, 0.0)):
        return types.SimpleNamespace(SIGALRM=14, ITIMER_REAL=0, getsignal=Mock(return_value=object()),
                                     getitimer=Mock(return_value=timer), signal=Mock(), setitimer=Mock())

    def test_normal_exception_and_timeout_restore_original_handler_and_disable_timer(self):
        for result in ("success", "error", "timeout"):
            signals = self.signals(); original = signals.getsignal.return_value
            with self.subTest(result=result), patch.object(core, "signal", signals):
                try:
                    with core.network_deadline(12, "fixture_timeout", "Safe deadline message"):
                        signals.setitimer.assert_called_once_with(0, 12)
                        if result == "error": raise ValueError("original error")
                        if result == "timeout": signals.signal.call_args.args[1](14, None)
                except ValueError as error: self.assertEqual((result, str(error)), ("error", "original error"))
                except DeployError as error: self.assertEqual((result, error.code), ("timeout", "fixture_timeout"))
            self.assertEqual(signals.setitimer.call_args.args, (0, 0))
            self.assertEqual(signals.signal.call_args.args, (14, original))

    def test_existing_alarm_unsupported_platform_and_nonmain_thread_never_replace_state(self):
        signals = self.signals((2.0, 0.5))
        with patch.object(core, "signal", signals), self.assertRaisesRegex(DeployError, "existing alarm"):
            with core.network_deadline(12, "timeout", "message"): self.fail("Unexpected network admission")
        signals.signal.assert_not_called(); signals.setitimer.assert_not_called()
        with patch.object(core, "signal", types.SimpleNamespace()), self.assertRaisesRegex(DeployError, "main thread"):
            with core.network_deadline(12, "timeout", "message"): self.fail("Unexpected non-Linux admission")
        with patch.object(core, "sys", types.SimpleNamespace(platform="darwin")), patch.object(core, "signal", self.signals()), self.assertRaisesRegex(DeployError, "main thread"):
            with core.network_deadline(12, "timeout", "message"): self.fail("Unexpected non-Linux admission")
        signals = self.signals()
        with patch.object(core, "signal", signals), patch.object(core.threading, "current_thread", return_value=object()), self.assertRaisesRegex(DeployError, "main thread"):
            with core.network_deadline(12, "timeout", "message"): self.fail("Unexpected worker-thread admission")
        signals.signal.assert_not_called(); signals.setitimer.assert_not_called()

    def test_timer_install_failure_still_restores_handler(self):
        signals = self.signals(); signals.setitimer.side_effect = [OSError("fixture timer installation"), None]
        with patch.object(core, "signal", signals), self.assertRaisesRegex(OSError, "installation"):
            with core.network_deadline(12, "timeout", "message"): self.fail("Unexpected admission")
        self.assertEqual(signals.signal.call_args.args, (14, signals.getsignal.return_value))


class ProxyCoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.layout = Layout("fixture", Path(self.temp.name))
        # Portable functional fixtures do not claim actual root ownership.
        for target, value in (("architecture", "x64"), ("_require_root", None), ("_root_owner", True)):
            patcher = patch.object(core, target, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def prepare(self, data=None, value=None):
        data = archive() if data is None else data
        value = release(data) if value is None else value
        def fetch(url, *_args, **_kwargs):
            if url == core.API + "/tags/v26.10.1":
                return json.dumps(value).encode()
            if url == value["assets"][0]["browser_download_url"]:
                return data
            self.fail("Unexpected download: " + url)
        with patch.object(core, "_fetch", side_effect=fetch) as request:
            result = core.prepare_core(self.layout, "26.10.1")
        return result, request

    def test_complete_prepare_binds_digest_and_strict_reuse_never_redownloads_archive(self):
        value, calls = self.prepare()
        self.assertEqual(calls.call_count, 2)
        self.assertEqual(value["core"], value["archiveSha256"])
        self.assertEqual(value["version"], "26.10.1")
        directory = core.core_path(self.layout, value["core"])
        self.assertEqual(set(path.name for path in directory.iterdir()), {*core.FILES, "manifest.json"})
        self.assertEqual(core.verify_core(self.layout, value["core"]), value)
        original = (directory / "xray").stat().st_ino
        reused, calls = self.prepare()
        self.assertEqual(value, reused)
        self.assertEqual(calls.call_count, 1)
        self.assertEqual((directory / "xray").stat().st_ino, original)
        (directory / "geoip.dat").write_bytes(b"changed")
        with self.assertRaisesRegex(DeployError, "content changed"):
            self.prepare()
        self.assertEqual((directory / "geoip.dat").read_bytes(), b"changed")

    def test_failed_publish_cleans_only_private_candidate_and_is_retryable(self):
        with patch.object(core, "_publish", side_effect=OSError("offline fixture")), self.assertRaises(OSError):
            self.prepare()
        parent = core.core_path(self.layout, "a" * 64).parent
        self.assertEqual(list(parent.iterdir()), [])
        result, _ = self.prepare()
        self.assertEqual(core.verify_core(self.layout, result["core"]), result)

    def test_retention_limit_blocks_new_download_not_verified_existing_core_reuse(self):
        result, _ = self.prepare()
        parent = core.core_path(self.layout, result["core"]).parent
        for index in range(63):
            (parent / (f"{index:064x}")).mkdir()
        self.assertEqual(len(list(parent.iterdir())), 64)
        reused, calls = self.prepare()
        self.assertEqual(reused, result)
        self.assertEqual(calls.call_count, 1)
        data = archive([("xray", b"new core"), ("geoip.dat", b"i"), ("geosite.dat", b"s")])
        with patch.object(core, "_fetch", return_value=json.dumps(release(data)).encode()) as fetch, self.assertRaisesRegex(DeployError, "retention budget"):
            core.prepare_core(self.layout, "26.10.1")
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(len(list(parent.iterdir())), 64)

    def test_atomic_publication_does_not_replace_even_an_empty_existing_directory(self):
        source, target = self.layout.root / "source", self.layout.root / "target"
        source.mkdir(); target.mkdir()
        (source / "payload").write_text("fixture")
        inode = target.stat().st_ino
        with self.assertRaises(FileExistsError):
            core._publish(source, target)
        self.assertEqual(target.stat().st_ino, inode)
        self.assertEqual(list(target.iterdir()), [])
        self.assertTrue((source / "payload").is_file())

    def test_identity_version_and_manifest_cannot_select_arbitrary_paths(self):
        for identity in (None, "a" * 63, "A" * 64, "../elsewhere"):
            with self.subTest(identity=identity), self.assertRaises(DeployError):
                core.core_path(self.layout, identity)
        for version in (None, "latest", "26.10.1/elsewhere", "v26.10.1?x", "vv26.10.1"):
            with self.subTest(version=version), self.assertRaises(DeployError):
                core._version(version)
        result, _ = self.prepare()
        file = core.core_path(self.layout, result["core"]) / "manifest.json"
        changed = copy.deepcopy(result); changed["files"]["xray"]["extra"] = True
        file.write_text(json.dumps(changed))
        with self.assertRaisesRegex(DeployError, "file metadata"):
            core.verify_core(self.layout, result["core"])

    def test_official_release_rejects_drafts_prereleases_wrong_tags_and_duplicate_assets(self):
        original = release(archive())
        for mutation in ({"draft": True}, {"prerelease": True}, {"tag_name": "v26.10.2"}, {"published_at": None}):
            with patch.object(core, "_fetch", return_value=json.dumps({**original, **mutation}).encode()), self.assertRaises(DeployError):
                core._release("26.10.1", None)
        with patch.object(core, "_fetch", return_value=json.dumps(original).encode()):
            self.assertEqual(core.latest_version(), "26.10.1")
        for mutation in ({"browser_download_url": "https://example.invalid/core.zip"}, {"size": True}, {"state": "new"}):
            changed = copy.deepcopy(original); changed["assets"][0].update(mutation)
            with self.assertRaises(DeployError):
                core._asset(changed, core.ASSETS["x64"], core.MAX_ARCHIVE)
        original["assets"] *= 2
        with self.assertRaisesRegex(DeployError, "unique"):
            core._asset(original, core.ASSETS["x64"], core.MAX_ARCHIVE)

    def test_digest_fallback_requires_exact_official_asset_and_sha256(self):
        data = archive(); value = release(data, digest=False); expected = hashlib.sha256(data).hexdigest()
        # Actual official v26.10.29 .dgst uses SHA2-256= without a filename.
        digest = ("SHA2-256= " + expected + "\n").encode()
        value["assets"].append({"name": core.ASSETS["x64"] + ".dgst", "size": len(digest), "state": "uploaded", "browser_download_url": core.DOWNLOAD + "/v26.10.1/" + core.ASSETS["x64"] + ".dgst"})
        with patch.object(core, "_fetch", side_effect=[json.dumps(value).encode(), digest, data]):
            self.assertEqual(core.prepare_core(self.layout, "v26.10.1")["core"], expected)
        for text in (expected, "SHA512= " + expected, "SHA256= " + expected + "\nSHA256= " + expected,
                     "SHA256= " + expected + "\nSHA2-256= " + expected,
                     "SHA2-256(other.zip)= " + expected):
            with self.subTest(text=text[:16]), self.assertRaises(DeployError):
                core._digest(text.encode(), core.ASSETS["x64"])
        self.assertEqual(core._digest(("SHA2-256(" + core.ASSETS["x64"] + ")= " + expected).encode(), core.ASSETS["x64"]), expected)
        self.assertEqual(core._digest(("SHA256= " + expected).encode(), core.ASSETS["x64"]), expected)
        broken = release(data); broken["assets"][0]["digest"] = "sha256:" + "0" * 64
        with self.assertRaisesRegex(DeployError, "checksum mismatch"):
            self.prepare(data, broken)

    def test_download_redirects_are_checked_before_requesting_another_host(self):
        initial = core.DOWNLOAD + "/v26.10.1/" + core.ASSETS["x64"]
        handler = core._Redirect(initial, True)
        good = "https://release-assets.githubusercontent.com/github-production-release-asset/fixture?token=temporary"
        self.assertEqual(handler.redirect_request(urllib.request.Request(initial), None, 302, "Found", {}, good).full_url, good)
        for url in ("http://release-assets.githubusercontent.com/github-production-release-asset/x", "https://example.invalid/x",
                    "https://github.com/other/core", "https://release-assets.githubusercontent.com/other/x",
                    "https://" + "user:secret@" + "release-assets.githubusercontent.com/github-production-release-asset/x"):
            with self.subTest(url=url), self.assertRaises(DeployError):
                handler.redirect_request(urllib.request.Request(initial), None, 302, "Found", {}, url)
        with self.assertRaises(DeployError):
            core._Redirect(core.API + "/latest", False).redirect_request(urllib.request.Request(core.API + "/latest"), None, 302, "Found", {}, good)

    @patch.object(core, "network_deadline", side_effect=lambda *_: contextlib.nullcontext())
    def test_download_ignores_environment_proxy_and_bounds_bytes_without_leaking_errors(self, deadline):
        url = core.API + "/latest"
        class Response(io.BytesIO):
            pass
        for proxy in (None, "http://127.0.0.1:18790"):
            response = Response(b"fixture"); response.url = url
            opener = Mock(); opener.open.return_value = response
            with patch.dict(os.environ, {"HTTPS_PROXY": "http://elsewhere.invalid:9000"}), patch.object(core.urllib.request, "build_opener", return_value=opener) as build:
                self.assertEqual(core._fetch(url, 20, proxy), b"fixture")
                self.assertEqual(build.call_args.args[0].proxies, {"http": proxy, "https": proxy} if proxy else {})
                self.assertEqual(opener.open.call_args.kwargs["timeout"], 30)
        response = Response(b"oversized"); response.url = url
        opener.open.return_value = response
        with patch.object(core.urllib.request, "build_opener", return_value=opener), self.assertRaisesRegex(DeployError, "budget"):
            core._fetch(url, 2, None)
        opener.open.side_effect = urllib.error.URLError("sensitive signed URL fixture")
        with patch.object(core.urllib.request, "build_opener", return_value=opener), self.assertRaises(DeployError) as failure:
            core._fetch(url, 20, None)
        self.assertEqual(str(failure.exception), "Official Xray download failed")
        for proxy in ("http://example.invalid:80", "http://" + "user:secret@" + "127.0.0.1:80"):
            with self.assertRaises(DeployError):
                core._fetch(url, 20, proxy)
        self.assertTrue(all(call.args == (core.DOWNLOAD_TIMEOUT, "download_timeout", "Official Xray download deadline exceeded") for call in deadline.call_args_list))

    def test_zip_rejects_path_escape_duplicates_links_special_entries_and_missing_geo(self):
        normal = [("xray", b"x"), ("geoip.dat", b"i"), ("geosite.dat", b"s")]
        for name in ("../outside", "/absolute", "C:drive", "nested\\file", "a/../b", "a//b", "XRAY"):
            with self.subTest(name=name), self.assertRaises(DeployError):
                core._archive_files(archive(normal + [(name, b"bad")]))
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            with self.assertRaises(DeployError):
                core._archive_files(archive(normal + [("xray", b"duplicate")]))
        for mode in (stat.S_IFLNK | 0o777, stat.S_IFIFO | 0o600):
            info = zipfile.ZipInfo("extra"); info.create_system = 3; info.external_attr = mode << 16
            with self.assertRaises(DeployError):
                core._archive_files(archive(normal + [(info, b"target")]))
        with self.assertRaisesRegex(DeployError, "no alternative geo source"):
            core._archive_files(archive(normal[:1]))
        with patch.object(core, "MAX_EXPANDED", 2), self.assertRaisesRegex(DeployError, "budget"):
            core._archive_files(archive(normal))
        with self.assertRaisesRegex(DeployError, "entry budget"):
            core._archive_files(archive([(str(index), b"x") for index in range(65)]))


if __name__ == "__main__":
    unittest.main()
