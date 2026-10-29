"""Pinned, isolated DNS-provider Caddy builds and immutable binary generations.

The DNS key never enters this workflow. Only a reviewed Go main and its complete
module lock are downloaded/built, using the existing unprivileged build identity.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
import stat
import time
import urllib.request
import uuid
from collections.abc import Callable
from pathlib import Path
from urllib.parse import urlsplit

from .build import Builder, architecture
from .common import DeployError, Layout, digest, fsync_directory, mkdir, require, write_json
from .safe_fs import bounded_names, durable_tree, extract_tar, snapshot, stable_identity
from .system import run


GO_VERSION = "1.26.10"
CADDY_VERSION = "2.11.7"
PROVIDER_PINS = {
    "alidns": {"module": "github.com/caddy-dns/alidns", "version": "v1.0.29"},
    "cloudflare": {"module": "github.com/caddy-dns/cloudflare", "version": "v0.2.4"},
    "digitalocean": {"module": "github.com/caddy-dns/digitalocean", "version": "v0.0.0-20250606074528-04bde2867106"},
    "huaweicloud": {"module": "github.com/caddy-dns/huaweicloud", "version": "v1.0.1"},
    "route53": {"module": "github.com/caddy-dns/route53", "version": "v1.6.2"},
    "tencentcloud": {"module": "github.com/caddy-dns/tencentcloud", "version": "v0.4.3"},
}
GO_HASHES = {
    "amd64": "ccfe7ae822d2c2f41f4fe7c956199967a4dac22d0ee0d2b2bfdb440aab3b20c5",
    "arm64": "3f4227ce7b206a513e794f1393adb473a07b46e94d18bd15d1c684bbb7319797",
}
SOURCE_HASHES = {
    "main.go": "70928d12028bebfa467001f2ab0b0153d460795631b2bde39a439a630784411f",
    "main_test.go": "937077ddfa710e09ab19e8845fe2c112aab158fd1ba19edcaf2e3b54478efa83",
    "go.mod": "a79aea92f4f648bc37e9def1eefc8b91638ac1dd8ca7e7837f0e86eba6ed4af8",
    "go.sum": "be97bc40a8c81b3e893b438c10e084c63b912471a1b4adc24039c617a56e6975",
}
SOURCE_NAMES = ("main.go", "main_test.go", "go.mod", "go.sum")
HEX = re.compile(r"[0-9a-f]{64}")
GO_MODULE_VERSION = re.compile(r"v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9]{14}-[0-9a-f]{12})?")
MAX_GENERATIONS = 32
MAX_BINARY = 256 * 1024**2


def _directory(path: Path, *, root_owned: bool = True) -> None:
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and (not root_owned or os.name != "posix" or info.st_uid == 0 and not info.st_mode & 0o022),
            "Unsafe DNS Caddy directory", "integrity")


def _chain(layout: Layout, path: Path) -> None:
    require(path.is_absolute() and path.is_relative_to(layout.root), "Invalid DNS Caddy path", "integrity")
    for candidate in (path, *path.parents):
        _directory(candidate)
        if candidate == layout.root:
            return
    raise AssertionError("Managed path left its root")


def _read(path: Path, limit: int, *, executable: bool = False, root_owned: bool = True) -> bytes:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    try:
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= limit and
                not path.is_symlink() and (os.name != "posix" or (not root_owned or before.st_uid == 0 and not before.st_mode & 0o022) and
                (not executable or stat.S_IMODE(before.st_mode) == 0o755)), "Unsafe DNS Caddy file", "integrity")
        chunks, size = [], 0
        while data := os.read(descriptor, min(1024**2, limit + 1 - size)):
            chunks.append(data)
            size += len(data)
            require(size <= limit, "DNS Caddy file exceeds budget", "budget")
        after, current = os.fstat(descriptor), path.lstat()
        # Windows exposes different ctime meanings through stat and fstat.
        # Keep the complete descriptor comparison; compare every other field
        # against the pathname there. Linux retains the full ownership check.
        path_identity = stable_identity(current)
        descriptor_identity = stable_identity(after)
        if os.name != "posix":
            path_identity, descriptor_identity = path_identity[:-1], descriptor_identity[:-1]
        require(stable_identity(before) == stable_identity(after) and descriptor_identity == path_identity,
                "DNS Caddy file changed during verification", "integrity")
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def source_material() -> dict[str, bytes]:
    source = Path(__file__).resolve().parent / "caddy_dns_source"
    # First installation may read the explicitly invoked user's checkout. Exact
    # pinned bytes and stable ordinary files are required; installed control and
    # control-update callers additionally enforce root ownership themselves.
    _directory(source, root_owned=False)
    require(set(bounded_names(source, len(SOURCE_NAMES) + 1)) == set(SOURCE_NAMES) and set(SOURCE_HASHES) == set(SOURCE_NAMES),
            "DNS Caddy source set differs from reviewed recipe", "integrity")
    result = {name: _read(source / name, 1024**2, root_owned=False) for name in SOURCE_NAMES}
    require(all(hashlib.sha256(data).hexdigest() == SOURCE_HASHES[name] for name, data in result.items()),
            "DNS Caddy source differs from reviewed recipe", "integrity")
    return result


def recipe(arch: str) -> dict:
    require(arch in GO_HASHES, "Unsupported DNS Caddy architecture", "unsupported_platform")
    source_material()
    return {"format": 2, "providers": {name: dict(pin) for name, pin in PROVIDER_PINS.items()}, "caddyVersion": CADDY_VERSION,
            "goVersion": GO_VERSION, "goArchiveSha256": GO_HASHES[arch],
            "architecture": arch, "sources": dict(SOURCE_HASHES), "buildPolicy": "go-readonly-offline-v1"}


def _recipe_providers(wanted: dict) -> set[str]:
    common = {"format", "caddyVersion", "goVersion", "goArchiveSha256", "architecture", "sources", "buildPolicy"}
    require(isinstance(wanted, dict) and type(wanted.get("format")) is int and wanted["format"] in (1, 2),
            "Invalid DNS Caddy recipe binding", "integrity")
    legacy = wanted["format"] == 1
    require(set(wanted) == common | ({"provider", "providerVersion"} if legacy else {"providers"}) and
            isinstance(wanted["architecture"], str) and wanted["architecture"] in GO_HASHES and
            wanted["buildPolicy"] == "go-readonly-offline-v1" and
            all(isinstance(wanted[key], str) and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", wanted[key])
                for key in ("goVersion", "caddyVersion")) and
            isinstance(wanted["goArchiveSha256"], str) and HEX.fullmatch(wanted["goArchiveSha256"]) and
            isinstance(wanted["sources"], dict) and set(wanted["sources"]) == set(SOURCE_NAMES) and
            all(isinstance(value, str) and HEX.fullmatch(value) for value in wanted["sources"].values()),
            "Invalid DNS Caddy recipe binding", "integrity")
    if legacy:
        require(wanted["provider"] == "alidns" and isinstance(wanted["providerVersion"], str) and
                re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", wanted["providerVersion"]),
                "Invalid DNS Caddy recipe binding", "integrity")
        return {"alidns"}
    providers = wanted["providers"]
    require(isinstance(providers, dict) and providers and set(providers) <= set(PROVIDER_PINS) and
            all(isinstance(pin, dict) and set(pin) == {"module", "version"} and
                pin["module"] == PROVIDER_PINS[name]["module"] and isinstance(pin["version"], str) and
                GO_MODULE_VERSION.fullmatch(pin["version"]) for name, pin in providers.items()),
            "Invalid DNS Caddy provider capabilities", "integrity")
    return set(providers)


def _generation(layout: Layout, revision: str) -> tuple[Path, dict]:
    require(isinstance(revision, str) and HEX.fullmatch(revision), "Invalid DNS Caddy revision", "integrity")
    root = layout.control / "edge/caddy/dns" / revision
    _chain(layout, root)
    require(set(bounded_names(root, 3)) == {"caddy", "manifest.json"}, "Unexpected DNS Caddy generation entry", "integrity")
    try:
        record = json.loads(_read(root / "manifest.json", 16384))
    except (ValueError, UnicodeError) as error:
        raise DeployError("integrity", "Invalid DNS Caddy manifest") from error
    require(isinstance(record, dict) and set(record) == {"format", "recipe", "sha256"} and
            type(record["format"]) is int and record["format"] == 1,
            "Invalid DNS Caddy manifest", "integrity")
    wanted = record["recipe"]
    _recipe_providers(wanted)
    require(digest(wanted) == revision and isinstance(record["sha256"], str) and HEX.fullmatch(record["sha256"]),
            "Invalid DNS Caddy recipe binding", "integrity")
    target = root / "caddy"
    require(hashlib.sha256(_read(target, MAX_BINARY, executable=True)).hexdigest() == record["sha256"],
            "DNS Caddy binary changed", "integrity")
    return target, record


def dns_caddy_path(layout: Layout, metadata: dict) -> Path:
    target, record = _generation(layout, metadata.get("dnsBinaryRevision"))
    require(metadata.get("dnsBinarySha256") == record["sha256"], "DNS Caddy selection changed", "integrity")
    require(isinstance(metadata.get("dnsProvider"), str) and metadata["dnsProvider"] in _recipe_providers(record["recipe"]),
            "Selected DNS provider is absent from this Caddy generation", "integrity")
    return target


def verify_dns_caddy_generations(layout: Layout) -> None:
    root = layout.control / "edge/caddy/dns"
    if not root.exists() and not root.is_symlink():
        return
    _chain(layout, root)
    names = bounded_names(root, MAX_GENERATIONS + 1)
    require(len(names) <= MAX_GENERATIONS, "DNS Caddy generation retention budget exceeded", "budget")
    for name in names:
        _generation(layout, name)


def validate_download_proxy(value: str | None) -> str | None:
    if value is None:
        return None
    require(isinstance(value, str) and value.isascii() and not any(char.isspace() or ord(char) < 32 for char in value),
            "Download proxy must be a credential-free loopback HTTP URL")
    try:
        parsed = urlsplit(value)
        valid = (parsed.scheme == "http" and parsed.hostname is not None and ipaddress.ip_address(parsed.hostname).is_loopback and
                 parsed.port is not None and 1 <= parsed.port <= 65535 and "@" not in parsed.netloc and "%" not in parsed.hostname and
                 not parsed.path and not parsed.query and not parsed.fragment)
    except ValueError:
        valid = False
    require(valid, "Download proxy must be a credential-free loopback HTTP URL")
    return value


def _download_go(arch: str, target: Path, download_proxy: str | None = None) -> None:
    # Exact filenames and redirects only; no inherited proxies or credentials.
    name = f"go{GO_VERSION}.linux-{arch}.tar.gz"
    urls = {"https://go.dev/dl/" + name, "https://dl.google.com/go/" + name}
    proxy = validate_download_proxy(download_proxy)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": proxy, "https": proxy} if proxy else {}))
    sha, size, started = hashlib.sha256(), 0, time.monotonic()
    with opener.open("https://go.dev/dl/" + name, timeout=60) as response, target.open("xb") as output:
        require(response.url in urls, "Unexpected Go distribution origin", "integrity")
        while data := response.read(1024**2):
            require(time.monotonic() - started < 300, "Go distribution download deadline exceeded", "budget")
            size += len(data)
            require(size <= 256 * 1024**2, "Go distribution exceeds budget", "budget")
            sha.update(data)
            output.write(data)
        output.flush()
        os.fsync(output.fileno())
    require(sha.hexdigest() == GO_HASHES[arch], "Official Go distribution checksum mismatch", "integrity")


def _go_command(go: Path, workspace: Path, arch: str, *args: str, network: bool,
                download_proxy: str | None = None) -> list[str]:
    proxy = validate_download_proxy(download_proxy)
    proxies = ["HTTP_PROXY=" + proxy, "HTTPS_PROXY=" + proxy] if network and proxy else []
    return ["/usr/bin/env", "GOTOOLCHAIN=local", "GOENV=off", "GOWORK=off", "GOTELEMETRY=off", "GOVCS=*:off", "GOAUTH=off",
            # Go bounds concurrent module metadata requests by GOMAXPROCS.
            # Network fetching needs parallelism; systemd still caps CPU at two
            # cores. Compilers and tests retain their smaller working set.
            "GODEBUG=http2client=0", "GOMAXPROCS=" + ("16" if network else "2"),
            "GOFLAGS=-mod=readonly", "CGO_ENABLED=0", "GOOS=linux", "GOARCH=" + arch,
            "GOPROXY=" + ("https://proxy.golang.org" if network else "off"), "GOSUMDB=sum.golang.org https://sum.golang.org",
            "GOPRIVATE=", "GONOPROXY=none", "GONOSUMDB=none", "GOPATH=" + str(workspace / "gopath"),
            "GOMODCACHE=" + str(workspace / "modules"), "GOCACHE=" + str(workspace / "cache"),
            "TMPDIR=" + str(workspace / "tmp"), *proxies, str(go), *args]


def _fetch_dependencies(manager, identity: str, go: Path, source: Path, workspace: Path,
                        arch: str, download_proxy: str | None) -> None:
    # Keep authenticated cache progress across transient network failures. An
    # isolated candidate_failed is raised only after cgroup stop confirmation;
    # stop_unknown and every other failure must propagate without a retry.
    deadline = time.monotonic() + 900
    failure = None
    for attempt in range(3):
        remaining = int(deadline - time.monotonic())
        if remaining < 1:
            if failure is not None:
                raise failure
            raise DeployError("budget", "DNS dependency download deadline exceeded")
        suffix = identity if attempt == 0 else uuid.uuid4().hex
        try:
            manager.system.isolated(manager.layout, "dns-fetch-" + suffix,
                _go_command(go, workspace, arch, "mod", "download", network=True, download_proxy=download_proxy),
                source, workspace, network=True, timeout=remaining)
            return
        except DeployError as error:
            if error.code != "candidate_failed":
                raise
            failure = error
    assert failure is not None
    raise failure


def provision_dns_caddy(manager, *, download_proxy: str | None = None,
                        progress: Callable[[str], None] | None = None) -> dict:
    download_proxy = validate_download_proxy(download_proxy)
    def announce(phase: str) -> None:
        if progress is not None:
            progress(phase)
    layout = manager.layout
    arch = "amd64" if architecture() == "x64" else "arm64"
    selected = recipe(arch)
    revision = digest(selected)
    root = layout.control / "edge/caddy/dns"
    _chain(layout, root.parent)
    announce("inspect")
    verify_dns_caddy_generations(layout)
    target = root / revision
    if target.exists() or target.is_symlink():
        _, record = _generation(layout, revision)
        # A previous rename can have succeeded before its directory fsync
        # reported an error; a verified reuse must finish that durability work.
        durable_tree(target)
        fsync_directory(root)
        fsync_directory(root.parent)
        announce("reuse")
        return {"dnsBinaryRevision": revision, "dnsBinarySha256": record["sha256"]}
    if root.exists():
        require(len(bounded_names(root, MAX_GENERATIONS + 1)) < MAX_GENERATIONS,
                "DNS Caddy generation retention budget reached", "budget")
    _chain(layout, layout.work)
    require(len(list(layout.work.glob("dns-build-*"))) < 8,
            "DNS build workspace retention budget reached; inspect retained builds", "budget")
    uid, gid = manager.config["buildUid"], manager.config["buildGid"]
    require(type(uid) is int and type(gid) is int and uid > 0 and gid > 0, "Invalid DNS build identity", "integrity")
    identity = uuid.uuid4().hex
    stage = layout.work / ("dns-build-" + identity)
    mkdir(stage, 0o755)
    source = stage / "source"
    mkdir(source, 0o755)
    from .common import atomic_write
    for name, data in source_material().items():
        atomic_write(source / name, data, 0o644)
    archive = stage / "go.tar.gz"
    announce("download")
    _download_go(arch, archive, download_proxy)
    toolchain = stage / "go"
    extract_tar(archive, toolchain, strip=1)
    go = toolchain / "bin/go"
    _read(go, MAX_BINARY, executable=True)
    workspace = stage / "work"
    builder = Builder(layout, manager.system, uid, gid)
    image = builder.bounded_workspace(workspace, 8)
    for name in ("tmp", "output"):
        mkdir(workspace / name, 0o755, uid, gid)
    announce("fetch")
    _fetch_dependencies(manager, identity, go, source, workspace, arch, download_proxy)
    announce("verify")
    manager.system.isolated(layout, "dns-verify-" + identity,
        _go_command(go, workspace, arch, "mod", "verify", network=False), source, workspace, network=False, timeout=120)
    announce("test")
    manager.system.isolated(layout, "dns-test-" + identity,
        _go_command(go, workspace, arch, "test", "-p=2", "-count=1", ".", network=False),
        source, workspace, network=False, timeout=900)
    announce("build")
    manager.system.isolated(layout, "dns-build-" + identity,
        _go_command(go, workspace, arch, "build", "-p=2", "-trimpath", "-buildvcs=false", "-ldflags=-buildid=", "-o",
                    str(workspace / "output/caddy"), ".", network=False), source, workspace, network=False, timeout=900)
    # The reviewed main asserts the registered module and exact compiled module
    # versions from runtime/debug.
    announce("inspect")
    manager.system.isolated(layout, "dns-probe-" + identity,
        [str(workspace / "output/caddy"), "harness-dns-build-check"], source, workspace, network=False, timeout=30)
    exported = stage / "export"
    snapshot(workspace / "output", exported, producer_stopped=True, expected_uid=uid)
    require(set(bounded_names(exported, 2)) == {"caddy"}, "Unexpected DNS build output", "integrity")
    os.chmod(exported / "caddy", 0o755)
    sha = hashlib.sha256(_read(exported / "caddy", MAX_BINARY, executable=True)).hexdigest()
    write_json(exported / "manifest.json", {"format": 1, "recipe": selected, "sha256": sha})
    durable_tree(exported)
    # Stop confirmation is already required by isolated(), including its failures.
    run(["/usr/bin/umount", str(workspace)])
    image.unlink()
    fsync_directory(stage)
    mkdir(root, 0o755)
    _chain(layout, root)
    os.rename(exported, target)
    fsync_directory(root)
    fsync_directory(root.parent)
    fsync_directory(stage)
    metadata = {"dnsBinaryRevision": revision, "dnsBinarySha256": sha}
    _generation(layout, revision)
    return metadata
