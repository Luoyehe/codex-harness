"""Operator-only, stop-confirmed replacement of the trusted Python control tree.

The executing checkout stays outside the tree being replaced. Recovery records,
old trees and persistent systemd start barriers survive a crash or host reboot.
No source archive, RPC parameter or service identity can select helper code.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import stat
import uuid
from pathlib import Path

from .common import DeployError, Layout, atomic_write, digest, fsync_directory, mkdir, read_json, require, write_json
from .install import stage_control, trusted_ancestors, write_control_launchers
from .journal import recover_as_owner
from .safe_fs import inspect_tree, snapshot
from .system import System, run
from .transactions import require_recovered
from .ownership import require_owned
from .service_proxy import PROXY_ROLES, active as service_active, roles as service_roles, selection as proxy_selection
from .units import sudo_rule

ROLES = ("worker", "gateway", "authelia", "caddy")
TERMINAL = ("committed", "recovered")
ID = re.compile(r"[0-9a-f]{32}\Z")
LAUNCHERS = ("manage", "native-launch")
# A delayed systemd/sudo invocation must not import Python while directories
# change. This durable gate also covers old helpers without condition properties.
BLOCKER = b"#!/bin/sh\n# Trusted control maintenance is pending.\nexit 75\n"


def durable_tree(path: Path) -> None:
    # A stopped legacy helper may have just created bytecode. The manifest and
    # rename parent fsync cannot make those nested files/directories durable.
    for parent, _, files in os.walk(path, topdown=False, followlinks=False):
        for name in files:
            # Windows's fixture runtime needs a writable descriptor for fsync;
            # production Linux uses read-only descriptors, including live edge
            # executables which cannot be opened for writing (ETXTBSY).
            with (Path(parent) / name).open("rb" if os.name == "posix" else "r+b") as source:
                os.fsync(source.fileno())
        fsync_directory(Path(parent))


def tree_manifest(path: Path) -> dict:
    trusted_ancestors(path)
    require(path.is_dir(), "Control generation is missing", "recovery_required")
    result = inspect_tree(path, root_owned=True)
    require(result and all(item["type"] != "link" for item in result.values()),
            "Control generations cannot contain symlinks", "unsafe_path")
    require(all(result.get(name, {}).get("type") == "file" for name in ("manage", "native-launch", "deploy/cli.py", "deploy/native_launcher.py")),
            "Control generation is incomplete", "integrity")
    return result


def assert_reviewed_checkout(layout: Layout) -> None:
    source = Path(__file__).resolve().parent
    require(not source.is_relative_to(layout.control.parent.resolve()),
            "Run control commands from a separate reviewed checkout, never an installed helper generation", "unsafe_path")
    trusted_ancestors(source)
    from .dns_caddy_build import source_material
    recipe = source / "caddy_dns_source"
    trusted_ancestors(recipe)
    paths = [*source.glob("*.py"), *(recipe / name for name in source_material())]
    for path in paths:
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022 and info.st_nlink == 1,
                "Reviewed deployment source must be exclusively root writable", "unsafe_path")


class ControlSystem(System):
    def control_healthy(self, layout: Layout, config: dict) -> None:
        from .manager import Manager
        Manager(layout, self, worker_gid=config["workerGid"]).healthy()

    def instance_units(self, layout: Layout) -> list[str]:
        prefix = "codex-harness-" + layout.instance + "-"
        result = run(["/usr/bin/systemctl", "list-units", "--all", "--plain", "--no-legend", "--no-pager", prefix + "*.service"])
        units = []
        for line in result.stdout.splitlines():
            fields = line.split()
            require(len(fields) >= 4 and fields[0].startswith(prefix) and fields[0].endswith(".service") and
                    bool(re.fullmatch(r"[a-zA-Z0-9_.@-]+", fields[0])), "Cannot enumerate instance services", "stop_unknown")
            suffix = fields[0][len(prefix):-len(".service")]
            # Instance names may contain '-': a broad main-* glob must never
            # stop main-other's services. Known transient suffixes end in a UUID.
            if suffix in (*ROLES, *PROXY_ROLES, "config-check") or re.fullmatch(r"(?:manage|fetch|install|tsc|web|gateway-check|worker-check|runtime-probe|sandbox|dns-fetch|dns-verify|dns-test|dns-build|dns-probe)-[0-9a-f]{32}", suffix):
                units.append(fields[0])
        return units

    def enabled_state(self, unit: str) -> str:
        # is-enabled reports some nonexistent units only on stderr. Establish
        # absence through the same complete state evidence used for stopping.
        state = self.state(unit)
        if state["LoadState"] == "not-found":
            require(state["stopped"], "Absent service has contradictory state", "stop_unknown")
            return "not-found"
        result = run(["/usr/bin/systemctl", "is-enabled", unit], check=False)
        state = result.stdout.strip()
        codes = {"enabled": (0,), "enabled-runtime": (0,), "static": (0,), "indirect": (0,),
                 "disabled": (1,), "masked": (1,), "masked-runtime": (1,), "not-found": (1, 4)}
        require(state in codes and result.returncode in codes[state], "Cannot establish service enablement", "stop_unknown")
        return state

    def no_instance_processes(self, layout: Layout, config: dict) -> None:
        import pwd
        uids = set()
        for role in ("gateway", "worker", "control", "build", "auth", "edge"):
            try:
                account = pwd.getpwnam(layout.prefix + "-" + role)
            except KeyError:
                require(role in ("auth", "edge"), "Instance service identity is missing", "stop_unknown")
                continue
            require(account.pw_uid > 0, "Unsafe instance identity", "identity_conflict")
            uids.add(account.pw_uid)
        for field in ("gatewayUid", "workerUid", "supervisorUid", "buildUid"):
            require(config.get(field) in uids, "Instance identity differs from configuration", "identity_conflict")
        control = os.fsencode(str(layout.control))
        for path in Path("/proc").iterdir():
            if not path.name.isdigit() or int(path.name) == os.getpid():
                continue
            try:
                # Includes escaped native/build processes outside service cgroups.
                status = dict(line.split(":", 1) for line in (path / "status").read_text().splitlines() if ":" in line)
                identities = {int(value) for value in status["Uid"].split()}
                require(not identities & uids, "Instance identity still owns a process; control tree retained", "stop_unknown")
                command = (path / "cmdline").read_bytes()
                require(not any(value == control or value.startswith(control + b"/") for value in command.split(b"\0")),
                        "An installed helper process remains; control tree retained", "stop_unknown")
                # Catches python -m deploy.cli launched from the installed tree.
                cwd = Path(os.readlink(path / "cwd"))
                require(not cwd.is_relative_to(layout.control), "A process still uses the control tree", "stop_unknown")
            except (FileNotFoundError, ProcessLookupError):
                continue  # Process exited while /proc was being inspected.
            except (OSError, KeyError, ValueError) as exc:
                raise DeployError("stop_unknown", "Cannot establish instance process termination") from exc


class ControlUpdater:
    def __init__(self, layout: Layout, system: ControlSystem | None = None):
        self.layout = layout
        self.system = system or ControlSystem()
        self.config = read_json(layout.config / "instance.json")
        self.records = layout.control.parent / ("." + layout.instance + "-control-transactions")
        self.barriers = layout.config / "control-maintenance"

    def prepare_paths(self) -> None:
        for path in (self.layout.control.parent, self.layout.config, self.layout.units):
            trusted_ancestors(path)
        mkdir(self.records, 0o700)
        mkdir(self.barriers, 0o700)
        fsync_directory(self.records.parent)
        fsync_directory(self.barriers.parent)

    def transactions(self) -> list[tuple[Path, dict]]:
        result = []
        if self.records.exists():
            for path in sorted(self.records.iterdir()):
                require(ID.fullmatch(path.name) is not None and path.is_dir() and not path.is_symlink(),
                        "Unexpected control recovery directory", "corrupt_state")
                if (path / "state.json").exists():
                    result.append((path, read_json(path / "state.json", 32 * 1024 * 1024)))
                else:
                    # Preparation may crash before its first journal. No installed
                    # tree or service state is touched until state.json is durable.
                    require(not (path / "old").exists(), "Missing control recovery journal", "corrupt_state")
        return result

    def pending(self) -> list[tuple[Path, dict]]:
        return [(path, state) for path, state in self.transactions() if state.get("phase") not in TERMINAL]

    def service_snapshot(self) -> dict:
        saved = {}
        for role in service_roles(self.config, ROLES):
            unit = self.layout.unit(role)
            state = self.system.state(unit)
            active = service_active(state, role)
            require(active or state["stopped"], "Control update requires stable service state", "stop_unknown")
            enabled = self.system.enabled_state(unit)
            require(not active or enabled not in ("masked", "masked-runtime", "not-found"),
                    "An active masked service cannot be restored without changing enablement", "stop_unknown")
            saved[role] = {"active": active, "enabled": enabled}
        return saved

    def guard_preflight(self, state: dict) -> list[tuple[Path, Path, bytes]]:
        dropins = []
        for role in service_roles(self.config, ROLES):
            directory = self.layout.units / (self.layout.unit(role) + ".d")
            trusted_ancestors(directory)
            path = directory / "90-codex-harness-control-maintenance.conf"
            content = f"[Unit]\nConditionPathExists=!{self.barriers / role}\n".encode()
            if path.exists() or path.is_symlink():
                require(not path.is_symlink() and path.read_bytes() == content,
                        "Control maintenance drop-in collision", "collision")
            dropins.append((directory, path, content))
        # Validate every collision and launcher before installing any barrier.
        if self.layout.control.exists():
            trusted_ancestors(self.layout.control)
            for name in LAUNCHERS:
                launcher = self.layout.control / name
                details = launcher.lstat()
                require(stat.S_ISREG(details.st_mode) and details.st_nlink == 1 and details.st_size <= 16384,
                        "Control launcher is not a regular bounded file", "integrity")
                expected = [base64.b64decode(state["launchers"][kind][name], validate=True) for kind in ("old", "candidate")]
                require(launcher.read_bytes() in (*expected, BLOCKER), "Control launcher changed before maintenance", "integrity")
        return dropins

    def guard(self, state: dict) -> None:
        # Persistent Conditions also inhibit Wants-driven and boot-time starts.
        # Keep one marker per role so restoring an active gateway does not start
        # a worker which the operator had intentionally left stopped.
        dropins = self.guard_preflight(state)
        for role in service_roles(self.config, ROLES):
            atomic_write(self.barriers / role, b"control maintenance\n")
        if self.layout.control.exists():
            trusted_ancestors(self.layout.control)
            for name in LAUNCHERS:
                atomic_write(self.layout.control / name, BLOCKER, 0o755)
        for directory, path, content in dropins:
            mkdir(directory, 0o755)
            if not path.exists():
                atomic_write(path, content, 0o644)
        fsync_directory(self.layout.units)
        self.system.reload()

    def stop_all(self) -> None:
        roles = service_roles(self.config, tuple(reversed(ROLES)))
        units = list(dict.fromkeys([self.layout.unit(role) for role in roles] + self.system.instance_units(self.layout)))
        self.system.stop(units)
        # Enumeration is repeated so a previously queued management transient is
        # included before any directory rename. stop() confirms cgroup emptiness.
        remaining = self.system.instance_units(self.layout)
        self.system.stop(list(dict.fromkeys(units + remaining)))
        self.system.no_instance_processes(self.layout, self.config)

    def save(self, path: Path, state: dict, phase: str) -> None:
        state["phase"] = phase
        write_json(path / "state.json", state)

    def verify_generation(self, path: Path, expected: dict, *, blocked: bool = False, legacy_cache: bool = False) -> dict:
        actual = tree_manifest(path)
        if blocked:
            for name in LAUNCHERS:
                if (path / name).read_bytes() == BLOCKER:
                    actual[name] = expected[name]
        def code(manifest):
            # Root-owned legacy launchers may write normal Python caches before
            # shutdown. Source and every non-cache file must still match exactly.
            return {name: item for name, item in manifest.items() if "__pycache__" not in Path(name).parts}
        require((code(actual) == code(expected)) if legacy_cache else actual == expected,
                "Retained control generation changed; inspect before recovery", "integrity")
        return actual

    def launcher_record(self, path: Path) -> dict:
        return {name: base64.b64encode((path / name).read_bytes()).decode("ascii") for name in LAUNCHERS}

    def restore_launchers(self, path: Path, state: dict, kind: str) -> None:
        for name in LAUNCHERS:
            content = base64.b64decode(state["launchers"][kind][name], validate=True)
            require((path / name).read_bytes() in (BLOCKER, content), "Control launcher changed", "integrity")
            atomic_write(path / name, content, state[kind][name]["mode"])

    def preserve_edge(self, candidate: Path, transaction: Path, current: dict) -> None:
        # Edge binaries and their config-side verification records have their own
        # lifecycle. A Python rollback must not undo a later edge installation.
        from .dns_caddy_build import verify_dns_caddy_generations
        verify_dns_caddy_generations(self.layout)
        self.validate_dns_selection()
        edge = self.layout.control / "edge"
        present = set(path.name for path in edge.iterdir()) if edge.exists() else set()
        require(present <= {"caddy", "authelia"}, "Unexpected managed edge binary directory", "integrity")
        for kind in ("caddy", "authelia"):
            record = self.layout.config / (kind + "-binary.json")
            require((kind in present) == record.exists(), "Edge binary and verification record are unpaired", "integrity")
            if kind in present:
                relative = f"edge/{kind}/{kind}"
                metadata = read_json(record)
                require(current.get(relative, {}).get("type") == "file" and
                        current[relative]["sha256"] == metadata.get("sha256"), "Edge binary differs from its verified record", "integrity")
        if (candidate / "edge").exists():
            self.rename(candidate / "edge", transaction / "rollback-source-edge")
        if edge.exists():
            snapshot(edge, candidate / "edge", producer_stopped=True, expected_uid=0)
        durable_tree(candidate)

    def rename(self, source: Path, target: Path) -> None:
        require(not target.exists() and not target.is_symlink(), "Control generation destination exists", "collision")
        os.rename(source, target)
        fsync_directory(source.parent)
        if target.parent != source.parent:
            fsync_directory(target.parent)

    def restore_services(self, state: dict) -> None:
        self.validate_dns_selection()
        self.validate_proxy_selection()
        services = state["services"]
        roles = service_roles(self.config, ROLES)
        require(set(services) == set(roles), "Service roles changed during control maintenance", "recovery_required")
        for role in roles:
            require(self.system.enabled_state(self.layout.unit(role)) == services[role]["enabled"],
                    "Service enablement changed during control maintenance", "recovery_required")
        journal = self.layout.state / "gateway/journal.sqlite"
        if journal.exists():
            recover_as_owner(journal, self.config["gatewayUid"], self.config["gatewayGid"])
        active = [role for role in roles if services[role]["active"]]
        for role in active:
            (self.barriers / role).unlink(missing_ok=True)
        fsync_directory(self.barriers)
        if active:
            self.system.start([self.layout.unit(role) for role in active])
        if "gateway" in active and "worker" in active:
            self.system.control_healthy(self.layout, self.config)
        for role in roles:
            current = self.system.state(self.layout.unit(role))
            if role in active:
                require(service_active(current, role),
                        "Original service activity was not restored", "health")
            else:
                require(current["stopped"], "Previously stopped service started during control maintenance", "health")
        for role in roles:
            (self.barriers / role).unlink(missing_ok=True)
        fsync_directory(self.barriers)

    def validate_state(self, state: dict) -> None:
        require(state.get("format") == 1 and state.get("kind") == "control" and state.get("instance") == self.layout.instance and
                isinstance(state.get("old"), dict) and isinstance(state.get("candidate"), dict) and
                isinstance(state.get("services"), dict) and set(state["services"]) in (set(ROLES), set(ROLES) | set(PROXY_ROLES)) and
                isinstance(state.get("launchers"), dict) and set(state["launchers"]) == {"old", "candidate"},
                "Invalid control recovery record", "corrupt_state")
        for service in state["services"].values():
            require(isinstance(service, dict) and type(service.get("active")) is bool and isinstance(service.get("enabled"), str),
                    "Invalid control service recovery record", "corrupt_state")
        for kind in ("old", "candidate"):
            values = state["launchers"][kind]
            require(isinstance(values, dict) and set(values) == set(LAUNCHERS), "Invalid control launcher record", "corrupt_state")
            for name in LAUNCHERS:
                value = values[name]
                require(isinstance(value, str) and len(value) <= 24000, "Invalid control launcher record", "corrupt_state")
                data = base64.b64decode(value, validate=True)
                require(hashlib.sha256(data).hexdigest() == state[kind][name]["sha256"],
                        "Control launcher record differs from manifest", "corrupt_state")

    def recover_transaction(self, path: Path, state: dict) -> dict:
        self.validate_state(state)
        require(set(state["services"]) == set(service_roles(self.config, ROLES)),
                "Service roles changed during control maintenance", "recovery_required")
        require_owned(self.layout, self.config)
        self.validate_proxy_selection()
        old = path / "old"
        source = old if old.exists() else self.layout.control
        # Recovery is a control selection too. Check the complete retained tree
        # before any guard, stop or journal write, including pre-rename crashes.
        try:
            self.verify_generation(source, state["old"], blocked=True, legacy_cache=not old.exists())
        except Exception:
            # Corrupt recovery material retains the existing fail-closed contract:
            # inhibit all launchers and prove stop, without selecting any tree.
            self.guard(state)
            self.stop_all()
            raise
        capability_file = source / "capabilities.json"
        capabilities = read_json(capability_file, 4096) if capability_file.exists() else {}
        try:
            self.require_account_guard(capabilities)
            self.require_dns_guard(capabilities)
        except DeployError as error:
            if error.code not in ("authentication_downgrade", "dns_downgrade", "execution_unsupported", "proxy_unsupported"):
                raise
            feature = {"authentication_downgrade": "account guard", "dns_downgrade": "selected DNS challenge support",
                       "execution_unsupported": "root execution support", "proxy_unsupported": "service proxy support"}[error.code]
            raise DeployError(error.code,
                              "Previous control tools lack " + feature + "; recovery has not changed services or selected code. "
                              "Correct any runtime prerequisite, then run control-recover --target candidate to validate and resume the original candidate.") from error
        self.guard(state)
        self.stop_all()
        self.save(path, state, "recovering")
        if old.exists():
            self.verify_generation(old, state["old"], blocked=True)
            self.restore_launchers(old, state, "old")
            if self.layout.control.exists():
                self.verify_generation(self.layout.control, state["candidate"], blocked=True)
                self.rename(self.layout.control, path / "failed")
                self.restore_launchers(path / "failed", state, "candidate")
            self.rename(old, self.layout.control)
        else:
            # Covers crashes before the first rename and after restoration of old.
            state["old"] = self.verify_generation(self.layout.control, state["old"], blocked=True, legacy_cache=True)
            self.restore_launchers(self.layout.control, state, "old")
        durable_tree(self.layout.control)
        self.save(path, state, "restoring_old_services")
        try:
            self.restore_services(state)
        except Exception:
            self.guard(state)
            self.stop_all()
            raise
        self.save(path, state, "recovered")
        return {"controlRecovered": True, "transaction": path.name, "controlDigest": digest(state["old"])}

    def recover_candidate(self, path: Path, state: dict) -> dict:
        """Resume only the sealed candidate already named by one pending journal."""
        self.validate_state(state)
        require(set(state["services"]) == set(service_roles(self.config, ROLES)),
                "Service roles changed during control maintenance", "recovery_required")
        require_owned(self.layout, self.config)
        self.validate_proxy_selection()
        staged, failed, old = path / "candidate", path / "failed", path / "old"
        if staged.exists():
            require(not failed.exists(), "Ambiguous retained control candidates", "recovery_required")
            candidate = staged
        elif failed.exists():
            candidate = failed
        else:
            candidate = self.layout.control
        require(candidate.exists(), "Original control candidate is unavailable", "recovery_required")
        if candidate == self.layout.control:
            require(old.exists(), "Original control recovery pair is incomplete", "recovery_required")
            previous = old
        elif self.layout.control.exists():
            require(not old.exists(), "Ambiguous retained control generations", "recovery_required")
            previous = self.layout.control
        else:
            require(old.exists(), "Original control recovery pair is incomplete", "recovery_required")
            previous = old
        self.verify_generation(candidate, state["candidate"], blocked=True)
        self.verify_generation(previous, state["old"], blocked=True, legacy_cache=previous == self.layout.control)
        capabilities = candidate / "capabilities.json"
        selected_capabilities = read_json(capabilities, 4096) if capabilities.exists() else {}
        self.require_account_guard(selected_capabilities)
        self.require_dns_guard(selected_capabilities)
        self.guard(state)
        self.stop_all()
        self.verify_generation(candidate, state["candidate"], blocked=True)
        state["old"] = self.verify_generation(previous, state["old"], blocked=True, legacy_cache=previous == self.layout.control)
        self.save(path, state, "recovering_candidate")
        try:
            if candidate != self.layout.control:
                if previous == self.layout.control:
                    self.rename(self.layout.control, old)
                self.rename(candidate, self.layout.control)
            self.restore_launchers(old, state, "old")
            self.restore_launchers(self.layout.control, state, "candidate")
            durable_tree(self.layout.control)
            self.save(path, state, "installed")
            self.restore_services(state)
        except Exception:
            self.guard(state)
            self.stop_all()
            raise
        # A replacement may publish the terminal journal before directory fsync
        # reports failure. Never block or stop verified services after that
        # publication; an earlier write failure retains the retryable phase.
        self.save(path, state, "committed")
        return {"controlRecovered": True, "target": "candidate", "transaction": path.name,
                "controlDigest": digest(state["candidate"])}

    def recover(self, *, target: str = "old") -> dict:
        require(target in ("old", "candidate"), "Invalid control recovery target")
        self.prepare_paths()
        pending = self.pending()
        require(len(pending) == 1, "Expected one unfinished control transaction; inspect retained records", "recovery_required")
        return self.recover_candidate(*pending[0]) if target == "candidate" else self.recover_transaction(*pending[0])

    def require_account_guard(self, capabilities: dict) -> None:
        """Retained legacy control must not remove the application's downgrade gate."""
        require(isinstance(capabilities, dict), "Invalid retained control capabilities", "integrity")
        if capabilities.get("authenticationGuard") == "account-v1":
            return
        bootstrap = self.layout.config / "auth-bootstrap.json"
        require(not bootstrap.exists() and not bootstrap.is_symlink(),
                "Rollback target lacks the built-in account downgrade guard", "authentication_downgrade")
        from .manager import Manager
        manager = Manager(self.layout, self.system, worker_gid=self.config["workerGid"])
        require(not manager.builtin_edge(), "Rollback target lacks the built-in account downgrade guard", "authentication_downgrade")
        selected = manager.selected()
        if selected is not None:
            # Browser initialization may create no root bootstrap. Read only the
            # verified root-owned release declaration, never the gateway's DB.
            manager.verify_release(selected)
            require(not manager.release_accounts(selected),
                    "Rollback target lacks the built-in account downgrade guard", "authentication_downgrade")

    def validate_dns_selection(self) -> None:
        path = self.layout.config / "https.json"
        if path.exists() or path.is_symlink():
            from .https import read_https_metadata
            from .dns_tls import validate_dns_selection
            validate_dns_selection(self.layout, read_https_metadata(self.layout))

    def validate_proxy_selection(self) -> None:
        # A healthy listener does not prove retained executable/config bytes.
        # Check them before control selection and immediately before restart.
        from .service_proxy import verify_selection
        verify_selection(self.layout, self.config)

    def require_dns_guard(self, capabilities: dict) -> None:
        """Control selection cannot discard installed DNS, identity or proxy support."""
        require(isinstance(capabilities, dict), "Invalid retained control capabilities", "integrity")
        from .execution_identity import require_control
        require_control(capabilities, self.config)
        if proxy_selection(self.config) is not None:
            require(capabilities.get("serviceProxy") == 1,
                    "Rollback target lacks service proxy support; select a compatible control generation",
                    "proxy_unsupported")
        from .dns_providers import PROVIDERS
        supported = set()
        if capabilities.get("dnsChallenge") == "caddy-dns-v1":
            if "dnsProviders" not in capabilities:
                # The original v1 implementation supported only AliDNS.
                supported = {"alidns"}
            else:
                values = capabilities["dnsProviders"]
                require(isinstance(values, list) and all(isinstance(value, str) and value in PROVIDERS for value in values) and
                        len(values) == len(set(values)), "Invalid retained DNS provider capabilities", "integrity")
                supported = set(values)
        elif "dnsProviders" in capabilities:
            raise DeployError("integrity", "DNS provider capabilities require the DNS challenge guard")

        def require_selection(metadata: dict, message: str) -> None:
            from .dns_tls import SELECTION_FIELDS
            fields = {name for name in metadata if name.startswith("dns")}
            if not fields:
                return
            provider = metadata.get("dnsProvider")
            require(isinstance(provider, str) and provider in supported and fields == set(SELECTION_FIELDS) and
                    metadata.get("tls") == "acme" and metadata.get("authentication") == "builtin" and
                    all(isinstance(metadata.get(name), str) and re.fullmatch(pattern, metadata[name]) for name, pattern in (
                        ("dnsCredentialsRevision", r"[0-9a-f]{32}"), ("dnsCredentialsSha256", r"[0-9a-f]{64}"),
                        ("dnsBinaryRevision", r"[0-9a-f]{64}"), ("dnsBinarySha256", r"[0-9a-f]{64}"))),
                    message, "dns_downgrade")

        path = self.layout.config / "https.json"
        if path.exists() or path.is_symlink():
            from .https import read_https_metadata
            metadata = read_https_metadata(self.layout)
            require_selection(metadata, "Rollback target lacks the selected DNS challenge support or its selection is invalid")
        # A pending HTTPS recovery may have already selected a non-DNS mode,
        # while its rollback snapshot still needs DNS credentials and modules.
        for record in (self.layout.state / "transactions").glob("*/state.json"):
            state = read_json(record)
            require(isinstance(state, dict), "Invalid management transaction", "corrupt_state")
            if state.get("kind") != "https" or state.get("phase") in TERMINAL:
                continue
            candidate = state.get("candidateHttps")
            if candidate is not None:
                require(isinstance(candidate, dict), "Invalid candidate HTTPS metadata snapshot", "corrupt_state")
                require_selection(candidate, "Rollback target lacks the pending DNS challenge recovery support or its selection is invalid")
            before = state.get("before")
            require(isinstance(before, dict) and isinstance(before.get("metadata"), dict),
                    "Invalid retained HTTPS metadata snapshot", "corrupt_state")
            try:
                metadata = json.loads(base64.b64decode(before["metadata"]["data"], validate=True))
            except (KeyError, TypeError, ValueError) as error:
                raise DeployError("corrupt_state", "Invalid retained HTTPS metadata snapshot") from error
            require(isinstance(metadata, dict), "Invalid retained HTTPS metadata snapshot", "corrupt_state")
            require_selection(metadata, "Rollback target lacks the pending DNS challenge recovery support or its selection is invalid")

    def update(self, rollback: str | None = None) -> dict:
        require_recovered(self.layout)
        require_owned(self.layout, self.config)
        self.validate_proxy_selection()
        self.prepare_paths()
        require(not self.pending(), "Run control-recover before another control update", "recovery_required")
        require(len(list(self.records.iterdir())) < 32, "Control generation retention budget reached; inspect and archive completed records", "budget")
        old_manifest = tree_manifest(self.layout.control)
        retained = None
        if rollback is not None:
            require(ID.fullmatch(rollback) is not None, "Invalid control rollback transaction")
            retained = self.records / rollback
            saved = read_json(retained / "state.json", 32 * 1024 * 1024)
            self.validate_state(saved)
            require(saved["phase"] == "committed", "Rollback requires a committed control transaction", "recovery_required")
            self.verify_generation(retained / "old", saved["old"])
            capability_file = retained / "old/capabilities.json"
            capabilities = read_json(capability_file, 4096) if capability_file.exists() else {}
            self.require_account_guard(capabilities)
            self.require_dns_guard(capabilities)
            require(self.config.get("providerConfigLayer") is None or capabilities.get("providerConfigLayer") == "system-v1",
                    "Rollback target predates system provider layers; roll back the configuration layer first", "configuration_conflict")
            require(capabilities.get("nativeWorkspace") == 1 or
                    (self.layout.root / "etc/sudoers.d" / ("codex-harness-" + self.layout.instance)).read_bytes() == sudo_rule(self.layout, config=self.config, workspace=False).encode(),
                    "Rollback target predates workspace policy; use config-layer-rollback to restore legacy control compatibility", "configuration_conflict")
        services = self.service_snapshot()
        path = self.records / uuid.uuid4().hex
        mkdir(path, 0o700)
        fsync_directory(self.records)
        candidate = path / "candidate"
        if retained:
            snapshot(retained / "old", candidate, producer_stopped=True, expected_uid=0)
            for parent, _, _ in os.walk(candidate, topdown=False):
                fsync_directory(Path(parent))
        else:
            stage_control(self.layout, candidate)
        candidate_manifest = tree_manifest(candidate)
        if retained:
            require(candidate_manifest == saved["old"], "Rollback snapshot differs from retained generation", "integrity")
            # Retained code may predate bytecode-write suppression. Always use
            # current fixed bootstrap semantics with the selected old modules.
            write_control_launchers(self.layout, candidate)
        self.preserve_edge(candidate, path, old_manifest)
        candidate_manifest = tree_manifest(candidate)
        # Only trusted Python is imported. -B avoids changing the sealed manifest.
        run(["/usr/bin/python3", "-I", "-B", "-c", "import sys; sys.path.insert(0, " + repr(str(candidate)) +
             "); import deploy.cli; import deploy.native_launcher"], timeout=30)
        state = {"format": 1, "kind": "control", "instance": self.layout.instance, "old": old_manifest,
                 "candidate": candidate_manifest, "services": services, "rollbackOf": rollback,
                 "launchers": {"old": self.launcher_record(self.layout.control), "candidate": self.launcher_record(candidate)}}
        # A predictable collision must not create a pending transaction that
        # would block the otherwise healthy gateway's fixed management launcher.
        self.guard_preflight(state)
        self.save(path, state, "prepared")
        try:
            self.guard(state)
            self.stop_all()
            old_manifest = self.verify_generation(self.layout.control, old_manifest, blocked=True, legacy_cache=True)
            state["old"] = old_manifest
            self.verify_generation(candidate, candidate_manifest)
            durable_tree(self.layout.control)
            self.save(path, state, "stopped")
            self.rename(self.layout.control, path / "old")
            self.restore_launchers(path / "old", state, "old")
            self.save(path, state, "old_moved")
            self.rename(candidate, self.layout.control)
            self.save(path, state, "installed")
            self.restore_services(state)
        except Exception as exc:
            # If any stop observation is uncertain, recover_transaction stops
            # here and preserves both generations, all barriers and the journal.
            if isinstance(exc, DeployError) and exc.code == "stop_unknown":
                raise
            self.recover_transaction(path, state)
            raise
        # Terminal publication is outside compensation: os.replace may succeed
        # even when its following directory fsync fails. Both possible on-disk
        # phases must describe these already verified services and generation.
        self.save(path, state, "committed")
        return {"controlUpdated": True, "transaction": path.name, "controlDigest": digest(candidate_manifest),
                "previousDigest": digest(old_manifest), "rollbackOf": rollback}


def control_command(layout: Layout, command: str, transaction: str | None = None, *, target: str = "old") -> dict:
    assert_reviewed_checkout(layout)
    updater = ControlUpdater(layout)
    if command == "control-recover":
        return updater.recover(target=target)
    return updater.update(transaction if command == "control-rollback" else None)


def require_no_pending_control(layout: Layout) -> None:
    require(not ControlUpdater(layout).pending(), "Trusted control maintenance is unfinished; run control-recover", "recovery_required")
