"""Official Xray distributions; no proxy protocol or inherited network credentials."""
from __future__ import annotations

import ctypes
import errno
import hashlib
import io
import json
import os
import re
import shutil
import signal
import stat
import sys
import threading
import urllib.error
import urllib.request
import uuid
import zipfile
import zlib
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit

from .build import architecture
from .common import DeployError, Layout, canonical, fsync_directory, require
from .dns_caddy_build import validate_download_proxy
from .safe_fs import bounded_names, stable_identity

API = "https://api.github.com/repos/XTLS/Xray-core/releases"
DOWNLOAD = "https://github.com/XTLS/Xray-core/releases/download"
HEX = re.compile(r"[0-9a-f]{64}\Z")
VERSION = re.compile(r"[0-9]{1,4}(?:\.[0-9]{1,3}){2}\Z")
ASSETS = {"x64": "Xray-linux-64.zip", "arm64": "Xray-linux-arm64-v8a.zip"}
FILES = {"xray": 0o755, "geoip.dat": 0o644, "geosite.dat": 0o644}
MAX_ARCHIVE = 128 * 1024**2
MAX_FILE = 256 * 1024**2
MAX_EXPANDED = 512 * 1024**2
DOWNLOAD_TIMEOUT = 300


@contextmanager
def network_deadline(seconds, code, message):
    # Deployment network operations run synchronously on Linux's main thread.
    # A socket timeout alone cannot bound DNS, TLS or a peer dripping headers.
    require(sys.platform == "linux" and hasattr(signal, "setitimer") and threading.current_thread() is threading.main_thread(),
            "Proxy network operations require the Linux manager main thread", "unsupported_platform")
    require(0 < seconds <= 300, "Invalid proxy network deadline")
    require(signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0),
            "Proxy network operation cannot replace an existing alarm", "deadline_conflict")
    previous = signal.getsignal(signal.SIGALRM)
    def expired(signum, frame):
        raise DeployError(code, message)
    signal.signal(signal.SIGALRM, expired)
    try:
        signal.setitimer(signal.ITIMER_REAL, seconds)
        yield
    finally:
        try:
            signal.setitimer(signal.ITIMER_REAL, 0)
        finally:
            signal.signal(signal.SIGALRM, previous)


def _version(value: str) -> str:
    require(isinstance(value, str), "Invalid Xray version")
    value = value.removeprefix("v")
    require(bool(VERSION.fullmatch(value)), "Xray version must be an exact release version")
    return value


def core_path(layout: Layout, identity: str) -> Path:
    require(isinstance(identity, str) and HEX.fullmatch(identity), "Invalid proxy core identity", "integrity")
    require(layout.root.is_absolute() and ".." not in layout.root.parts, "Invalid proxy core root", "integrity")
    return layout.root / "opt/codex-harness-proxy" / layout.instance / "cores" / identity


def _root_owner(info) -> bool:
    return os.name != "posix" or info.st_uid == 0


def _require_root() -> None:
    require(os.name != "posix" or os.geteuid() == 0, "Proxy core preparation requires root", "permission_denied")


def _chain(layout: Layout, directory: Path, *, create: bool = False) -> None:
    require(directory.is_relative_to(layout.root), "Proxy core path left managed root", "integrity")
    chain = [layout.root]
    for part in directory.relative_to(layout.root).parts:
        chain.append(chain[-1] / part)
    for current in chain:
        if create and current != layout.root:
            try:
                current.mkdir(mode=0o755)
                os.chmod(current, 0o755)
            except FileExistsError:
                pass
        info = current.lstat()
        require(stat.S_ISDIR(info.st_mode) and not current.is_symlink() and
                not getattr(info, "st_file_attributes", 0) & 0x400 and _root_owner(info) and
                (os.name != "posix" or not info.st_mode & 0o022), "Unsafe proxy core directory", "integrity")
        if create:
            fsync_directory(current)
            if current != layout.root:
                fsync_directory(current.parent)


def _read(path: Path, limit: int, mode: int) -> bytes:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    try:
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 < before.st_size <= limit and
                not path.is_symlink() and _root_owner(before) and
                (os.name != "posix" or stat.S_IMODE(before.st_mode) == mode), "Unsafe proxy core file", "integrity")
        chunks, size = [], 0
        while data := os.read(descriptor, min(1024**2, limit + 1 - size)):
            size += len(data)
            require(size <= limit, "Proxy core file exceeds budget", "budget")
            chunks.append(data)
        after, current = os.fstat(descriptor), path.lstat()
        left, right = stable_identity(after), stable_identity(current)
        if os.name != "posix":
            left, right = left[:-1], right[:-1]
        require(stable_identity(before) == stable_identity(after) and left == right,
                "Proxy core changed during verification", "integrity")
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def _json(data: bytes):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "Duplicate distribution metadata field", "integrity")
            result[key] = value
        return result
    try:
        return json.loads(data, object_pairs_hook=unique)
    except (ValueError, UnicodeError) as exc:
        raise DeployError("integrity", "Invalid distribution metadata") from exc


def verify_core(layout: Layout, identity: str) -> dict:
    directory = core_path(layout, identity)
    _chain(layout, directory)
    require(set(bounded_names(directory, 5)) == {*FILES, "manifest.json"}, "Unexpected proxy core entries", "integrity")
    record = _json(_read(directory / "manifest.json", 16384, 0o644))
    require(isinstance(record, dict) and set(record) == {"format", "core", "archiveSha256", "version", "architecture", "asset", "files"} and
            type(record["format"]) is int and record["format"] == 1 and record["core"] == identity and
            record["archiveSha256"] == identity and isinstance(record["version"], str) and VERSION.fullmatch(record["version"]) and
            record["architecture"] == architecture() and record["asset"] == ASSETS.get(record["architecture"]) and
            isinstance(record["files"], dict) and set(record["files"]) == set(FILES), "Invalid proxy core manifest", "integrity")
    for name, mode in FILES.items():
        expected = record["files"][name]
        require(isinstance(expected, dict) and set(expected) == {"sha256", "bytes"} and
                isinstance(expected["sha256"], str) and HEX.fullmatch(expected["sha256"]) and
                type(expected["bytes"]) is int and 0 < expected["bytes"] <= MAX_FILE, "Invalid proxy core file metadata", "integrity")
        data = _read(directory / name, MAX_FILE, mode)
        require(len(data) == expected["bytes"] and hashlib.sha256(data).hexdigest() == expected["sha256"], "Proxy core content changed", "integrity")
    return record


def _official_url(url: str, initial: str, *, asset: bool) -> bool:
    try:
        parsed = urlsplit(url)
        if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443) or parsed.fragment:
            return False
        if url == initial:
            return True
        return asset and parsed.hostname in {"release-assets.githubusercontent.com", "objects.githubusercontent.com"} and (
            parsed.path.startswith("/github-production-release-asset/") or parsed.path.startswith("/github-production-release-asset-2e65be/"))
    except ValueError:
        return False


class _Redirect(urllib.request.HTTPRedirectHandler):
    max_redirections = 5
    max_repeats = 2

    def __init__(self, initial: str, asset: bool):
        self.initial, self.asset = initial, asset

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        require(_official_url(newurl, self.initial, asset=self.asset), "Untrusted Xray distribution redirect", "integrity")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _fetch(url: str, limit: int, proxy: str | None, *, asset: bool = False) -> bytes:
    proxy = validate_download_proxy(proxy)
    require(url.startswith(DOWNLOAD + "/") if asset else url.startswith(API + "/"), "Untrusted Xray distribution origin", "integrity")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": proxy, "https": proxy} if proxy else {}), _Redirect(url, asset))
    request = urllib.request.Request(url, headers={"User-Agent": "codex-harness-proxy-core", "Accept": "application/octet-stream" if asset else "application/vnd.github+json"})
    chunks, size = [], 0
    try:
        with network_deadline(DOWNLOAD_TIMEOUT, "download_timeout", "Official Xray download deadline exceeded"):
            with opener.open(request, timeout=30) as response:
                require(_official_url(response.url, url, asset=asset), "Untrusted Xray distribution response", "integrity")
                while data := response.read(min(1024**2, limit + 1 - size)):
                    size += len(data)
                    require(size <= limit, "Xray download exceeds budget", "budget")
                    chunks.append(data)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        # Redirect URLs may contain temporary signed credentials; never return them.
        raise DeployError("download_failed", "Official Xray download failed") from exc
    require(size > 0, "Empty Xray distribution response", "integrity")
    return b"".join(chunks)


def _release(version: str | None, proxy: str | None) -> dict:
    suffix = "latest" if version is None else "tags/v" + _version(version)
    value = _json(_fetch(API + "/" + suffix, 2 * 1024**2, proxy))
    require(isinstance(value, dict) and value.get("draft") is False and value.get("prerelease") is False and
            isinstance(value.get("tag_name"), str) and value["tag_name"].startswith("v") and
            isinstance(value.get("published_at"), str) and bool(value["published_at"]) and
            isinstance(value.get("assets"), list) and len(value["assets"]) <= 256, "Invalid official Xray release", "integrity")
    actual = _version(value["tag_name"])
    require(version is None or actual == _version(version), "Xray release tag mismatch", "integrity")
    return value


def latest_version(*, download_proxy: str | None = None) -> str:
    return _version(_release(None, download_proxy)["tag_name"])


def _asset(release: dict, name: str, limit: int) -> dict:
    matches = [value for value in release["assets"] if isinstance(value, dict) and value.get("name") == name]
    require(len(matches) == 1, "Official Xray release lacks a unique required asset", "integrity")
    result = matches[0]
    require(result.get("browser_download_url") == DOWNLOAD + "/" + release["tag_name"] + "/" + name and
            type(result.get("size")) is int and 0 < result["size"] <= limit and result.get("state") == "uploaded",
            "Invalid official Xray asset metadata", "integrity")
    return result


def _digest(data: bytes, name: str) -> str:
    try:
        text = data.decode("ascii")
    except UnicodeError as exc:
        raise DeployError("integrity", "Invalid official Xray digest") from exc
    matches = []
    for line in text.splitlines():
        match = re.fullmatch(r"SHA(?:2-)?256\s*=\s*([0-9a-fA-F]{64})\s*", line)
        if not match:
            match = re.fullmatch(r"SHA(?:2-)?256\(" + re.escape(name) + r"\)\s*=\s*([0-9a-fA-F]{64})\s*", line)
        if match:
            matches.append(match[1].lower())
    require(len(matches) == 1, "Official Xray digest must contain one SHA256 binding", "integrity")
    return matches[0]


def _archive_files(data: bytes) -> dict[str, bytes]:
    require(0 < len(data) <= MAX_ARCHIVE, "Xray archive exceeds budget", "budget")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            require(0 < len(entries) <= 64, "Xray archive entry budget exceeded", "budget")
            seen, expanded = set(), 0
            for entry in entries:
                name = entry.filename
                parts = name.removesuffix("/").split("/")
                require(name and len(name) <= 240 and not any(part in {"", ".", ".."} for part in parts) and
                        not any(char in name for char in "\\:\x00") and not any(ord(char) < 32 for char in name) and
                        entry.orig_filename == name and name.removesuffix("/").casefold() not in seen,
                        "Unsafe or duplicate Xray ZIP path", "integrity")
                seen.add(name.removesuffix("/").casefold())
                mode = entry.external_attr >> 16
                require(stat.S_IFMT(mode) in (0, stat.S_IFDIR if entry.is_dir() else stat.S_IFREG) and
                        not entry.flag_bits & 1 and entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED),
                        "Unsupported Xray ZIP entry", "integrity")
                expanded += entry.file_size
                require(0 <= entry.file_size <= MAX_FILE and expanded <= MAX_EXPANDED, "Xray expanded archive exceeds budget", "budget")
            require(all(name in seen and not archive.getinfo(name).is_dir() for name in FILES),
                    "Official Xray ZIP must include xray, geoip.dat and geosite.dat; no alternative geo source is used", "integrity")
            result = {}
            for name in FILES:
                with archive.open(name) as source:
                    value = source.read(MAX_FILE + 1)
                require(0 < len(value) <= MAX_FILE and len(value) == archive.getinfo(name).file_size, "Invalid Xray archive file", "integrity")
                result[name] = value
            return result
    except (zipfile.BadZipFile, KeyError, RuntimeError, NotImplementedError, EOFError, zlib.error) as exc:
        raise DeployError("integrity", "Invalid Xray ZIP distribution") from exc


def _write(path: Path, data: bytes, mode: int) -> None:
    with path.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fchmod(stream.fileno(), mode) if os.name == "posix" else os.chmod(path, mode)
        os.fsync(stream.fileno())


def _publish(source: Path, target: Path) -> None:
    if os.name == "posix":
        # Linux renameat2 is an atomic no-replace publication even if another
        # preparation publishes the same identity concurrently.
        libc = ctypes.CDLL(None, use_errno=True)
        function = getattr(libc, "renameat2", None)
        require(function is not None, "Atomic no-replace publication is unavailable", "unsupported_platform")
        function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        function.restype = ctypes.c_int
        if function(-100, os.fsencode(source), -100, os.fsencode(target), 1):
            code = ctypes.get_errno()
            if code == errno.EEXIST:
                raise FileExistsError(code, "Core generation already exists")
            raise OSError(code, "Core publication failed")
    else:
        os.rename(source, target)


def prepare_core(layout: Layout, version: str, *, download_proxy: str | None = None) -> dict:
    _require_root()
    version = _version(version)
    arch = architecture()
    require(arch in ASSETS, "Unsupported Xray architecture", "unsupported_platform")
    release = _release(version, download_proxy)
    asset = _asset(release, ASSETS[arch], MAX_ARCHIVE)
    advertised = asset.get("digest")
    if advertised is not None:
        require(isinstance(advertised, str) and re.fullmatch(r"sha256:[a-f0-9]{64}", advertised), "Invalid official Xray asset digest", "integrity")
        expected = advertised[7:]
    else:
        dgst = _asset(release, ASSETS[arch] + ".dgst", 65536)
        value = _fetch(dgst["browser_download_url"], 65536, download_proxy, asset=True)
        require(len(value) == dgst["size"], "Official Xray digest size mismatch", "integrity")
        expected = _digest(value, ASSETS[arch])
    target = core_path(layout, expected)
    _chain(layout, target.parent, create=True)
    if target.exists() or target.is_symlink():
        existing = verify_core(layout, expected)
        require(existing["version"] == version, "Existing proxy core version binding differs", "integrity")
        return existing
    require(len(bounded_names(target.parent, 65)) < 64, "Proxy core retention budget exceeded", "budget")
    archive = _fetch(asset["browser_download_url"], MAX_ARCHIVE, download_proxy, asset=True)
    require(len(archive) == asset["size"] and hashlib.sha256(archive).hexdigest() == expected, "Official Xray archive checksum mismatch", "integrity")
    files = _archive_files(archive)
    record = {"format": 1, "core": expected, "archiveSha256": expected, "version": version, "architecture": arch, "asset": ASSETS[arch],
              "files": {name: {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)} for name, data in files.items()}}
    candidate = target.parent / (".prepare-" + uuid.uuid4().hex)
    candidate.mkdir(mode=0o700)
    try:
        for name, mode in FILES.items():
            _write(candidate / name, files[name], mode)
        _write(candidate / "manifest.json", canonical(record) + b"\n", 0o644)
        os.chmod(candidate, 0o755)
        fsync_directory(candidate)
        try:
            _publish(candidate, target)
        except FileExistsError:
            require(verify_core(layout, expected) == record, "Existing proxy core differs from prepared content", "integrity")
        fsync_directory(target.parent)
        require(verify_core(layout, expected) == record, "Published proxy core changed", "integrity")
        return record
    finally:
        if candidate.exists():
            # This is our unique private candidate, never a caller-selected path.
            shutil.rmtree(candidate)
            fsync_directory(target.parent)
