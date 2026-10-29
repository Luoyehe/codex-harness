from __future__ import annotations

import base64
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import tarfile
import urllib.request
import uuid
from pathlib import Path

from .common import CODEX_VERSION, NODE_VERSION, PNPM_VERSION, DeployError, Layout, canonical, digest, fsync_directory, mkdir, read_json, require, write_json
from .safe_fs import durable_tree, extract_tar, inspect_tree, snapshot, stable_identity
from .system import System, run

NODE_HASHES = {
    "x64": "6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6",
    "arm64": "dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e",
}
PNPM_INTEGRITY = "H/hwxMYTPf2I+yr8Rt0T1H8JyXlLQ4xv20fKmMrzvBY4HuC+k6CRuOOCTPAfiJ9G19niCRD7C+GrD7W6qA3WIQ=="
CODEX_INTEGRITIES = {
    "x64": "XLAoaWsGOT2khzl+P4FYDPTkzAr9W0VFXFaVkqlFdkM0soa1gH/4S0wSD57Ek3HHwkirAEGz2/Mwehseh+l5Mg==",
    "arm64": "LL5iTQjyDL4YRX44EWqhIfEQ5uGnmgxkQBJSxjZSeJ8L1Og83pdlzUJW/PRJ76oaVwOVgh6HXwuPEiBNEHU4lg==",
}
SOURCE_ROOTS = {"src", "web", "protocol"}
SOURCE_FILES = {"package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "tsconfig.server.json", "tsconfig.base.json"}
MAX_LOCK_BYTES = 8 * 1024**2
APPROVED_OVERRIDES = {"@z_ai/mcp-server@0.1.5>@modelcontextprotocol/sdk": "1.32.2", "zod": "4.6.7"}
WORKSPACE_SETTINGS = {"packages": ["."], "minimumReleaseAge": 1440, "blockExoticSubdeps": True,
                      "trustPolicy": "no-downgrade", "strictDepBuilds": True, "ignoreScripts": True,
                      "overrides": APPROVED_OVERRIDES}


def architecture() -> str:
    value = {"x86_64": "x64", "aarch64": "arm64"}.get(platform.machine())
    require(value is not None, "Linux x64 and arm64 are supported", "unsupported_platform")
    return value


def download(url: str, output: Path, expected: str, algorithm: str = "sha256") -> None:
    require(url.startswith(("https://nodejs.org/", "https://registry.npmjs.org/")), "Untrusted download origin")
    sha = hashlib.new(algorithm)
    total = 0
    # Deliberately ignore environment proxies and credentials.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=60) as response, output.open("xb") as target:
        require(response.url.startswith(("https://nodejs.org/", "https://registry.npmjs.org/")), "Untrusted download redirect")
        while data := response.read(1024**2):
            total += len(data)
            require(total <= 768 * 1024**2, "Download exceeds budget", "budget")
            sha.update(data)
            target.write(data)
    actual = sha.hexdigest() if algorithm == "sha256" else base64.b64encode(sha.digest()).decode()
    require(actual == expected, "Official distribution checksum mismatch", "integrity")


def pack_source(source: Path, output: Path) -> None:
    require(source.is_dir() and not output.exists(), "Invalid source or existing output")
    with tarfile.open(output, "x:gz") as archive:
        for path in sorted(source.rglob("*")):
            rel = path.relative_to(source)
            if rel.parts[0] not in SOURCE_ROOTS and rel.as_posix() not in SOURCE_FILES:
                continue
            if any(part in ("node_modules", "dist", ".git", ".DS_Store", "auth.json") or part.startswith(".env") for part in rel.parts):
                continue
            require(not path.is_symlink(), "Source archives do not accept symlinks", "unsafe_path")
            if path.is_file():
                info = archive.gettarinfo(str(path), rel.as_posix())
                info.uid = info.gid = info.mtime = 0
                info.uname = info.gname = ""
                info.mode = 0o644
                with path.open("rb") as data:
                    archive.addfile(info, data)


def dependency_workspace(source: Path) -> dict:
    # JSON is a strict YAML subset. Reject duplicate keys and every unreviewed
    # setting rather than executing arbitrary candidate pnpm configuration.
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "Duplicate workspace field")
            result[key] = value
        return result
    with (source / "pnpm-workspace.yaml").open("rb") as stream:
        data = stream.read(16385)
    require(len(data) <= 16384, "Workspace configuration exceeds budget")
    try:
        workspace = json.loads(data, object_pairs_hook=unique)
    except (ValueError, UnicodeError) as exc:
        raise DeployError("invalid_input", "Workspace must use the reviewed JSON subset of YAML") from exc
    require(canonical(workspace) == canonical(WORKSPACE_SETTINGS),
            "Workspace must contain only the reviewed single-root settings and exact security overrides")
    return json.loads(canonical(WORKSPACE_SETTINGS))


def dependency_lock(path: Path) -> str:
    # Extraction owns this tree, but a size check alone must not authorize an
    # unbounded read if the file grows or is replaced during preparation.
    selected = path.stat()
    with path.open("rb") as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode), "Lock must be an ordinary file", "unsafe_path")
        data = stream.read(MAX_LOCK_BYTES + 1)
        require(len(data) <= MAX_LOCK_BYTES, "Lock file exceeds byte budget", "budget")
        # Compare each metadata API with itself: Windows stat/fstat ctime
        # fields differ, while device/inode still identify the same file.
        require(before.st_size == len(data) and os.path.samestat(selected, before) and
                stable_identity(before) == stable_identity(os.fstat(stream.fileno())) and
                stable_identity(selected) == stable_identity(path.stat()),
                "Lock file changed while reading", "integrity")
    try:
        # Preserve read_text's newline handling, with an explicit byte/UTF-8
        # contract that does not depend on the operator's locale.
        return data.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
    except UnicodeDecodeError as exc:
        raise DeployError("invalid_input", "Lock file must be valid UTF-8") from exc


def dependency_input(source: Path) -> tuple[dict, str, dict]:
    package = read_json(source / "package.json")
    require(isinstance(package, dict) and package.get("packageManager") == "pnpm@" + PNPM_VERSION,
            "packageManager must be the pinned pnpm version")
    require(package.get("codexVersion") == CODEX_VERSION, "Candidate Codex version does not match installer")
    minimal = {"name": "harness-fetch", "version": "1.0.0", "private": True}
    for section in ("dependencies", "devDependencies", "optionalDependencies"):
        values = package.get(section, {})
        require(isinstance(values, dict) and len(values) <= 500, "Invalid dependencies")
        for name, version in values.items():
            require(isinstance(name, str) and bool(re.fullmatch(r"(?:@[a-z0-9._-]+/)?[a-z0-9._-]+", name)), "Invalid dependency name")
            require(isinstance(version, str) and bool(re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?", version)),
                    "Dependencies must use exact registry versions")
        minimal[section] = values
    require(not set(package) & {"pnpm", "workspaces", "overrides", "resolutions"}, "Package-level dependency settings are not supported")
    workspace = dependency_workspace(source)
    lock = dependency_lock(source / "pnpm-lock.yaml")
    require(lock.startswith("lockfileVersion: '9.0'"), "Unsupported lock format")
    # Intentionally narrow registry-only lock contract. No YAML tags, aliases,
    # escaped keys, custom tarballs, patched/git/local dependencies or executable hooks.
    for token in ("http:", "https:", "git+", "tarball:", "directory:", "patcheddependencies:",
                  "pnpmfile", "!", "&", "\\", '"'):
        require(token not in lock.lower(), "Lock uses unsupported dependency resolution")
    require(not re.search(r"(?<![a-z0-9_-])(?:git|gitlab|github|bitbucket|ssh|file|link|workspace):|type:\s*'?git'?|\*[a-z0-9_]", lock, re.I),
            "Lock uses unsupported dependency resolution")
    require("\n  .:\n" in lock and not re.search(r"^  (?!\.:)[^ ].*:\s*$", lock.split("packages:", 1)[0].split("importers:", 1)[-1], re.M),
            "Only the single root importer is supported")
    blocks = re.findall(r"^overrides:\n((?:[ \t].*\n|\n)*)", lock, re.M)
    require(len(blocks) == 1, "Lock must bind the reviewed security overrides")
    selected = {}
    for line in blocks[0].splitlines():
        if not line:
            continue
        match = re.fullmatch(r"  (?:'([^']+)'|([a-z0-9._-]+)): ([0-9]+\.[0-9]+\.[0-9]+)", line)
        require(match is not None, "Unsupported lock override declaration")
        key = match[1] or match[2]
        require(key not in selected, "Duplicate lock override declaration")
        selected[key] = match[3]
    require(selected == APPROVED_OVERRIDES, "Lock security overrides differ from reviewed workspace")
    return minimal, lock, workspace


def chown_tree(path: Path, uid: int, gid: int) -> None:
    for parent, dirs, files in os.walk(path, followlinks=False):
        os.chown(parent, uid, gid)
        for name in dirs + files:
            os.chown(Path(parent) / name, uid, gid, follow_symlinks=False)


def pnpm_command(tools: Path, store: Path, project: Path, metadata: Path) -> list[str]:
    require(project.is_absolute(), "Dependency workspace must be absolute")
    return [str(tools / "node/bin/node"), str(tools / "pnpm/bin/pnpm.cjs"), "--dir", str(project), "--workspace-root",
            "--config.ignore-pnpmfile=true", "--config.registry=https://registry.npmjs.org",
            "--config.verify-store-integrity=true", "--config.manage-package-manager-versions=false",
            "--config.enable-global-virtual-store=false", "--config.node-linker=isolated", "--config.virtual-store-dir=node_modules/.pnpm",
            "--config.package-import-method=copy", "--config.cache-dir=" + str(metadata), "--store-dir", str(store)]


def publish_release(layout: Layout, export: Path, manifest: dict) -> str:
    release = digest(manifest)
    target = layout.app / "releases" / release
    record = layout.config / "manifests" / (release + ".json")
    if target.exists() or target.is_symlink():
        details = target.lstat()
        require(stat.S_ISDIR(details.st_mode) and (os.name != "posix" or
                (details.st_uid == 0 and not details.st_mode & 0o022)), "Unsafe existing release directory", "integrity")
        require(inspect_tree(target, root_owned=True) == manifest, "Existing release content changed", "integrity")
        if record.exists():
            require(read_json(record, 64 * 1024**2) == manifest, "Existing release manifest changed", "integrity")
        # A crash after rename but before manifest publication is recoverable
        # only by independently producing and verifying that exact tree again.
        durable_tree(target)
        fsync_directory(target.parent)
    else:
        require(not record.exists(), "Manifest exists without its release", "integrity")
        durable_tree(export)
        os.rename(export, target)
        fsync_directory(target.parent)
        if export.parent != target.parent:
            fsync_directory(export.parent)
    # The first build creates releases; persisting entries inside it alone does
    # not persist that directory's name in the already installed application.
    fsync_directory(layout.app)
    write_json(record, manifest)
    return release


class Builder:
    def __init__(self, layout: Layout, system: System, build_uid: int, build_gid: int):
        self.layout, self.system = layout, system
        self.uid, self.gid = build_uid, build_gid

    def bounded_workspace(self, path: Path, gib: int) -> Path:
        """A loop filesystem bounds aggregate disk use, not merely single files."""
        image = path.with_suffix(".ext4")
        with image.open("xb") as output:
            output.truncate(gib * 1024**3)
        os.chmod(image, 0o600)
        run(["/usr/sbin/mkfs.ext4", "-q", "-F", "-m", "0", str(image)])
        mkdir(path, 0o755)
        run(["/usr/bin/mount", "-o", "loop,nosuid,nodev", str(image), str(path)])
        os.chown(path, self.uid, self.gid)
        os.chmod(path, 0o755)
        return image

    def toolchain(self) -> Path:
        root = self.layout.work / "toolchain"
        if root.exists():
            actual = inspect_tree(root, root_owned=True)
            require(actual == read_json(self.layout.config / "toolchain-manifest.json", 32 * 1024**2), "Toolchain changed", "integrity")
            durable_tree(root)
            fsync_directory(root.parent)
            fsync_directory(self.layout.work.parent)
            fsync_directory(self.layout.work.parent.parent)
            return root
        arch = architecture()
        mkdir(self.layout.work, 0o755)
        # Both the per-instance cache and its codex-harness parent may be new.
        fsync_directory(self.layout.work.parent)
        fsync_directory(self.layout.work.parent.parent)
        incoming = self.layout.work / ("tools-" + uuid.uuid4().hex)
        mkdir(incoming)
        node_file = incoming / "node.tar.xz"
        download(f"https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux-{arch}.tar.xz", node_file, NODE_HASHES[arch])
        pnpm_file = incoming / "pnpm.tgz"
        download(f"https://registry.npmjs.org/pnpm/-/pnpm-{PNPM_VERSION}.tgz", pnpm_file, PNPM_INTEGRITY, "sha512")
        codex_file = incoming / "codex.tgz"
        download(f"https://registry.npmjs.org/@openai/codex/-/codex-{CODEX_VERSION}-linux-{arch}.tgz", codex_file, CODEX_INTEGRITIES[arch], "sha512")
        assembled = incoming / "assembled"
        mkdir(assembled)
        extract_tar(node_file, assembled / "node", strip=1)
        extract_tar(pnpm_file, assembled / "pnpm", strip=1)
        # The complete official platform package is the CLI runtime object. It is
        # installed as-is, not projected to just its executable/vendor subtree.
        extract_tar(codex_file, assembled / "codex", strip=1)
        durable_tree(assembled)
        write_json(self.layout.config / "toolchain-manifest.json", inspect_tree(assembled, root_owned=True))
        os.rename(assembled, root)
        fsync_directory(root.parent)
        fsync_directory(assembled.parent)
        return root

    def prepare(self, source_archive: Path) -> str:
        from .sandbox import require_host
        require_host()
        tools = self.toolchain()
        require(len(list(self.layout.work.glob("candidate-*"))) < 8,
                "Eight candidate workspaces retained; inspect and remove completed workspaces before another build", "budget")
        identity = uuid.uuid4().hex
        stage = self.layout.work / ("candidate-" + identity)
        mkdir(stage, 0o755)
        source = stage / "source"
        extract_tar(source_archive, source)
        for path in source.iterdir():
            require(path.name in SOURCE_ROOTS | SOURCE_FILES, "Unexpected source archive root")
        minimal, lock, workspace = dependency_input(source)
        input_manifest = inspect_tree(source)
        tx = self.layout.state / "transactions" / identity
        mkdir(tx, 0o700)
        dependency_digest = digest({"manifest": minimal, "lock": lock, "workspace": workspace})
        write_json(tx / "input.json", {"source": input_manifest, "dependencyDigest": dependency_digest})
        fetch = stage / "fetch"
        fetch_image = self.bounded_workspace(fetch, 4)
        write_json(fetch / "package.json", minimal, mode=0o644)
        write_json(fetch / "pnpm-workspace.yaml", workspace, mode=0o644)
        (fetch / "pnpm-lock.yaml").write_text(lock)
        # Only these sanitized dependency inputs are ever visible as the fetch cwd.
        chown_tree(fetch, self.uid, self.gid)
        node = str(tools / "node/bin/node")
        base = pnpm_command(tools, fetch / "store", fetch, fetch / "metadata")
        self.system.isolated(self.layout, "fetch-" + identity, base + ["fetch", "--ignore-scripts", "--frozen-lockfile"], fetch, fetch, network=True)
        # Root hashes all exported content after systemd confirmed producer exit.
        cache = stage / "cache"
        store_manifest = snapshot(fetch / "store", cache, producer_stopped=True, expected_uid=self.uid)
        # pnpm 11 rechecks age/trust policy during --offline installation. Package
        # tarballs alone are insufficient: export its dedicated public metadata
        # cache too, never the builder's whole home or an inherited user cache.
        metadata = stage / "metadata"
        metadata_manifest = snapshot(fetch / "metadata", metadata, producer_stopped=True, expected_uid=self.uid)
        write_json(tx / "cache.json", {"dependencyDigest": dependency_digest, "storeDigest": digest(store_manifest),
                                      "metadataDigest": digest(metadata_manifest)})
        build = stage / "build"
        build_image = self.bounded_workspace(build, 8)
        snapshot(source, build / "app", producer_stopped=True, expected_uid=0)
        write_json(build / "app/pnpm-workspace.yaml", workspace, mode=0o644)
        snapshot(cache, build / "store", producer_stopped=True, expected_uid=0)
        snapshot(metadata, build / "metadata", producer_stopped=True, expected_uid=0)
        chown_tree(build, self.uid, self.gid)
        offline = pnpm_command(tools, build / "store", build / "app", build / "metadata")
        self.system.isolated(self.layout, "install-" + identity,
                             offline + ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"], build / "app", build, network=False)
        for label, command in (("tsc", [node, "node_modules/typescript/bin/tsc", "-p", "tsconfig.server.json"]),
                               ("web", [node, "node_modules/vite/bin/vite.js", "build", "--config", "web/vite.config.ts"]),
                               ("gateway-check", [node, "--check", "dist/src/gateway/main.js"]),
                               ("worker-check", [node, "--check", "dist/src/runtime/main.js"])):
            self.system.isolated(self.layout, label + "-" + identity, command, build / "app", build, network=False)
        # Candidate-controlled success files are never read or used as attestations.
        releases = self.layout.app / "releases"
        mkdir(releases)
        export = releases / (".candidate-" + identity)
        mkdir(export)
        snapshot(build / "app", export / "app", producer_stopped=True, expected_uid=self.uid)
        for component in ("node", "codex"):
            snapshot(tools / component, export / component, producer_stopped=True, expected_uid=0)
        require((export / "app/web/dist/index.html").is_file(), "Web build output is absent", "candidate_failed")
        for name in ("package.json", "pnpm-lock.yaml"):
            require((export / "app" / name).read_bytes() == (source / name).read_bytes(), "Build changed dependency inputs", "integrity")
        require(dependency_workspace(export / "app") == workspace, "Build changed reviewed dependency workspace", "integrity")
        # Ensure the exact full runtime, metadata and executable bits survived export.
        for component in ("node", "codex"):
            require(inspect_tree(export / component) == inspect_tree(tools / component), "Full runtime handoff mismatch", "integrity")
        machine = "x86_64" if architecture() == "x64" else "aarch64"
        self.system.isolated(self.layout, "runtime-probe-" + identity,
            ["/usr/bin/python3", "-I", str(self.layout.control / "deploy/candidate_probe.py"),
             "--codex", str(export / "codex" / f"vendor/{machine}-unknown-linux-musl/bin/codex"),
             "--workspace", str(build), "--source", str(source), "--token", str(self.layout.config / "gateway-token")],
            build, build, network=False, timeout=60)
        from .sandbox import preflight
        preflight(self.layout, self.system, identity, export / "codex" / f"vendor/{machine}-unknown-linux-musl/bin/codex")
        manifest = inspect_tree(export, root_owned=True)
        release = publish_release(self.layout, export, manifest)
        write_json(tx / "prepared.json", {"release": release, "inputDigest": digest(input_manifest), "manifestDigest": digest(manifest),
                                         "nativeInitializationProbe": True, "offlineBoundaryProbe": True, "nativeSandboxProbe": True})
        # Both producers have been confirmed stopped by isolated() before import.
        # Failure paths retain mounts/images for diagnosis instead of guessing.
        for directory, image in ((fetch, fetch_image), (build, build_image)):
            run(["/usr/bin/umount", str(directory)])
            image.unlink()
        return release
