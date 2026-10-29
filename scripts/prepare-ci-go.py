"""Explicit, credential-free preparation for the pinned portable Go checks."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import stat
import subprocess
import sys
import tarfile
import time
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from deploy.common import DeployError
from deploy.dns_caddy_build import GO_HASHES, GO_VERSION, source_material, validate_download_proxy

WINDOWS_SHA256 = "7ecd2d7260e82c59bcbd7f1077a07cee2dea607295b858df67195a1e4e09629b"
MAX_ARCHIVE = 256 * 1024**2
MAX_TREE = 3 * 1024**3
MAX_FILES = 150_000


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def pin(system: str, machine: str) -> dict:
    require(GO_VERSION == "1.26.10", "Reviewed Go version changed")
    require(system in ("Linux", "Windows") and machine.lower() in ("amd64", "x86_64"),
            "Go CI preparation requires a supported x64 runner")
    target = system.lower()
    suffix = "zip" if target == "windows" else "tar.gz"
    return {"goVersion": GO_VERSION, "platform": target, "architecture": "amd64",
            "archiveSha256": WINDOWS_SHA256 if target == "windows" else GO_HASHES["amd64"],
            "filename": f"go{GO_VERSION}.{target}-amd64.{suffix}"}


def ordinary(path: Path, base: Path, *, directory: bool = False) -> Path:
    path, base = path.absolute(), base.absolute()
    require(".." not in path.parts and path.is_relative_to(base), "Path must stay in its task-owned directory")
    for item in reversed((path, *path.parents)):
        if not item.is_relative_to(base):
            continue
        info = item.lstat()
        require(not stat.S_ISLNK(info.st_mode) and not getattr(info, "st_file_attributes", 0) & 0x400,
                "Symlink or junction is not a preparation input")
        require(stat.S_ISDIR(info.st_mode) if item != path or directory else stat.S_ISREG(info.st_mode),
                "Expected an ordinary preparation path")
    return path


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def owned_directory(path: Path, base: Path) -> None:
    require(".." not in path.parts and path.is_relative_to(base), "Path must stay in its task-owned directory")
    current = ordinary(base, base, directory=True)
    for name in path.relative_to(base).parts:
        current /= name
        if not current.exists() and not current.is_symlink():
            current.mkdir()
        ordinary(current, base, directory=True)


def copy_file(source: Path, destination: Path, limit: int) -> int:
    before = source.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= limit,
            "Unsafe or oversized preparation input")
    # Windows pathname stat infers executable bits from suffixes such as .com;
    # descriptor stat has no filename and omits those synthetic bits.
    identity = lambda value: (value.st_dev, value.st_ino, value.st_mode & (~0o111 if os.name == "nt" else ~0), value.st_nlink,
                              value.st_size, value.st_mtime_ns)
    with source.open("rb") as incoming, destination.open("xb") as outgoing:
        require(identity(os.fstat(incoming.fileno())) == identity(before), "Preparation input changed before copying")
        copied = 0
        while data := incoming.read(1024**2):
            copied += len(data)
            require(copied <= before.st_size, "Preparation input grew while copying")
            outgoing.write(data)
        after = os.fstat(incoming.fileno())
    # Access-time updates are harmless; all identity/content fields must agree.
    require(copied == before.st_size and identity(before) == identity(after) == identity(source.lstat()),
            "Preparation input changed while copying")
    return copied


def copy_cache(source: Path, destination: Path, base: Path) -> None:
    ordinary(source, base / ".work", directory=True)
    pending, count, total = [source], 0, 0
    while pending:
        parent = pending.pop()
        for entry in parent.iterdir():
            count += 1
            require(count <= MAX_FILES, "Module cache file budget exceeded")
            target = destination / entry.relative_to(source)
            info = entry.lstat()
            require(not stat.S_ISLNK(info.st_mode) and not getattr(info, "st_file_attributes", 0) & 0x400,
                    "Symlink or junction in module cache")
            if stat.S_ISDIR(info.st_mode):
                target.mkdir()
                pending.append(entry)
            else:
                require(stat.S_ISREG(info.st_mode), "Special file in module cache")
                total += copy_file(entry, target, MAX_ARCHIVE)
                require(total <= MAX_TREE, "Module cache byte budget exceeded")


def download(selected: dict, target: Path, download_proxy: str | None = None) -> None:
    filename = selected["filename"]
    allowed = {"https://go.dev/dl/" + filename, "https://dl.google.com/go/" + filename}

    class Redirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, response, code, message, headers, newurl):
            require(newurl in allowed, "Unexpected Go distribution redirect")
            return super().redirect_request(request, response, code, message, headers, newurl)

    proxy = validate_download_proxy(download_proxy)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": proxy, "https": proxy} if proxy else {}), Redirect())
    started, size = time.monotonic(), 0
    with opener.open("https://go.dev/dl/" + filename, timeout=60) as response, target.open("xb") as output:
        require(response.url in allowed, "Unexpected Go distribution origin")
        while data := response.read(1024**2):
            size += len(data)
            require(size <= MAX_ARCHIVE and time.monotonic() - started < 300, "Go download budget exceeded")
            output.write(data)


def extract(archive: Path, destination: Path, windows: bool) -> None:
    seen, count, total = set(), 0, 0

    def target(name: str, size: int, directory: bool) -> Path:
        nonlocal count, total
        parts = PurePosixPath(name.rstrip("/")).parts
        require(parts and parts[0] == "go" and all(part not in (".", "..", "") for part in name.rstrip("/").split("/")) and
                not name.startswith("/") and "\\" not in name and ":" not in name,
                "Unsafe Go archive path")
        key = "/".join(parts)
        require(key not in seen, "Duplicate Go archive entry")
        seen.add(key)
        count += 1
        total += size
        require(count <= MAX_FILES and 0 <= size <= MAX_ARCHIVE and total <= MAX_TREE,
                "Go extraction budget exceeded")
        output = destination.joinpath(*parts)
        output.parent.mkdir(parents=True, exist_ok=True)
        if directory:
            output.mkdir(exist_ok=True)
        return output

    def materialize(stream, output: Path, size: int, executable: bool) -> None:
        copied = 0
        with output.open("xb") as file:
            while data := stream.read(1024**2):
                copied += len(data)
                require(copied <= size, "Go archive member exceeded its declared size")
                file.write(data)
        require(copied == size, "Truncated Go archive member")
        output.chmod(0o755 if executable else 0o644)

    if windows:
        with zipfile.ZipFile(archive) as bundle:
            for member in bundle.infolist():
                mode = member.external_attr >> 16
                require(stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR), "Special file in Go archive")
                output = target(member.orig_filename, member.file_size, member.is_dir())
                if not member.is_dir():
                    with bundle.open(member) as stream:
                        materialize(stream, output, member.file_size, bool(mode & 0o111))
    else:
        with tarfile.open(archive, "r:gz") as bundle:
            for member in bundle:
                require(member.isfile() or member.isdir(), "Special file in Go archive")
                output = target(member.name, member.size, member.isdir())
                if member.isfile():
                    with bundle.extractfile(member) as stream:
                        materialize(stream, output, member.size, bool(member.mode & 0o111))


def environment(work: Path, runtime: Path, selected: dict, *, network: bool, download_proxy: str | None = None) -> dict:
    proxy = validate_download_proxy(download_proxy)
    env = {key: os.environ[key] for key in ("SystemRoot", "WINDIR") if key in os.environ}
    system_path = str(Path(env.get("SystemRoot", "C:/Windows")) / "System32") if os.name == "nt" else "/usr/bin:/bin"
    env.update({"PATH": str(runtime / "go/bin") + os.pathsep + system_path,
                "HOME": str(work / "home"), "USERPROFILE": str(work / "home"),
                "APPDATA": str(work / "home/appdata"), "LOCALAPPDATA": str(work / "home/localappdata"),
                "TMP": str(work / "tmp"), "TEMP": str(work / "tmp"), "TMPDIR": str(work / "tmp"),
                "GOTOOLCHAIN": "local", "GOENV": "off", "GOWORK": "off", "GOTELEMETRY": "off",
                "GOVCS": "*:off", "GOAUTH": "off", "GOFLAGS": "-mod=readonly", "CGO_ENABLED": "0",
                "GOOS": selected["platform"], "GOARCH": selected["architecture"], "GOMAXPROCS": "16" if network else "2",
                "GOPROXY": "https://proxy.golang.org" if network else "off",
                "GOSUMDB": "sum.golang.org https://sum.golang.org", "GOPRIVATE": "", "GONOPROXY": "none",
                "GONOSUMDB": "none", "GOPATH": str(work / "gopath"), "GOMODCACHE": str(work / "modules"),
                "GOCACHE": str(work / "cache"), "NO_PROXY": "", "LANG": "C.UTF-8"})
    if not network:
        env.update({name: "http://127.0.0.1:9" for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY")})
    elif proxy:
        env.update({"HTTP_PROXY": proxy, "HTTPS_PROXY": proxy})
    return env


def run_go(binary: Path, arguments: list[str], source: Path, env: dict, log: Path, timeout: int) -> str:
    with log.open("w+b") as output:
        child = subprocess.Popen([str(binary), *arguments], cwd=source, env=env, stdin=subprocess.DEVNULL,
                                 stdout=output, stderr=subprocess.STDOUT,
                                 creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        deadline = time.monotonic() + timeout
        try:
            while child.poll() is None:
                require(time.monotonic() < deadline and output.tell() <= 8 * 1024**2, "Go preparation process budget exceeded")
                time.sleep(0.05)
            require(child.returncode == 0 and output.tell() <= 8 * 1024**2, "Go preparation command failed: " + arguments[0])
        finally:
            if child.poll() is None:
                child.kill()
            child.wait()
        output.seek(0)
        return output.read().decode("utf-8", errors="replace")


def prepare(base: Path = ROOT, *, archive: Path | None = None, seed_cache: Path | None = None,
            download_proxy: str | None = None, system: str | None = None, machine: str | None = None) -> Path:
    base = base.absolute()
    proxy = validate_download_proxy(download_proxy)
    selected = pin(system or platform.system(), machine or platform.machine())
    sources = source_material()
    hashes = {name: hashlib.sha256(data).hexdigest() for name, data in sources.items()}
    runtime, work = base / "reference/runtime/ci-go", base / ".work/ci-go"
    for parent in (runtime.parent, work.parent):
        owned_directory(parent, base)
    require(not runtime.exists() and not work.exists() and not runtime.is_symlink() and not work.is_symlink(),
            "Go preparation output already exists; preserve or remove it explicitly before preparing again")
    if archive is not None:
        archive = archive.absolute()
        owner = base / ".work" if archive.is_relative_to(base / ".work") else base / "reference/runtime"
        ordinary(archive, owner)
    if seed_cache is not None:
        seed_cache = ordinary(seed_cache.absolute(), base / ".work", directory=True)
        require(not work.is_relative_to(seed_cache), "Module cache cannot contain its preparation destination")
    runtime.mkdir()
    work.mkdir()
    for folder in ("home", "home/appdata", "home/localappdata", "tmp", "gopath", "modules", "cache", "source"):
        (work / folder).mkdir(parents=True, exist_ok=True)
    for name, data in sources.items():
        (work / "source" / name).write_bytes(data)
    verified = runtime / selected["filename"]
    if archive is None:
        download(selected, verified, proxy)
    else:
        copy_file(archive, verified, MAX_ARCHIVE)
    require(sha256(verified) == selected["archiveSha256"], "Official Go distribution checksum mismatch")
    extract(verified, runtime, selected["platform"] == "windows")
    binary = ordinary(runtime / "go/bin" / ("go.exe" if selected["platform"] == "windows" else "go"), runtime)
    if seed_cache is not None:
        copy_cache(seed_cache, work / "modules", base)
    env = environment(work, runtime, selected, network=False)
    version = run_go(binary, ["version"], work / "source", env, work / "version.log", 15).strip()
    require(version == f"go version go{GO_VERSION} {selected['platform']}/amd64", "Prepared Go runtime version mismatch")
    for phase, arguments, network, timeout in (("download", ["mod", "download"], seed_cache is None, 900),
                                                ("verify", ["mod", "verify"], False, 120)):
        run_go(binary, arguments, work / "source", environment(work, runtime, selected, network=network, download_proxy=proxy), work / (phase + ".log"), timeout)
        require({name: sha256(work / "source" / name) for name in sources} == hashes,
                "Go dependency preparation changed the sealed source lock")
    require({name: hashlib.sha256(data).hexdigest() for name, data in source_material().items()} == hashes,
            "Reviewed Go source changed during preparation")
    manifest = {"schemaVersion": 1, **{name: selected[name] for name in ("goVersion", "platform", "architecture", "archiveSha256")},
                "goBinarySha256": sha256(binary), "archive": str(verified), "binary": str(binary),
                "moduleCache": str(work / "modules"), "sources": hashes}
    output = work / "prepared.json"
    output.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--seed-cache", type=Path)
    parser.add_argument("--download-proxy", help="Explicit credential-free loopback HTTP proxy for preparation downloads only")
    args = parser.parse_args()
    try:
        result = prepare(archive=args.archive, seed_cache=args.seed_cache, download_proxy=args.download_proxy)
        if os.environ.get("GITHUB_ENV"):
            with Path(os.environ["GITHUB_ENV"]).open("a", encoding="utf-8") as output:
                output.write("HARNESS_TEST_GO_MANIFEST=" + str(result) + "\n")
        print(json.dumps({"status": "prepared", "manifest": str(result)}))
    except (OSError, ValueError, DeployError, tarfile.TarError, zipfile.BadZipFile) as error:
        print("Go preparation refused: " + str(error), file=sys.stderr)
        sys.exit(1)
