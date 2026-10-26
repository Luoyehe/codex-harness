from __future__ import annotations

import hashlib
import http.client
import json
import os
import re
import secrets
import socket
import stat
import time
import uuid
from pathlib import Path

from .common import CODEX_VERSION, NODE_VERSION, PNPM_VERSION, DeployError, Layout, atomic_write, canonical, digest, fsync_directory, mkdir, read_json, require, write_json
from .provider import ProviderStore, redacted, validate_catalog, validate_provider
from .journal import recover_as_owner
from .safe_fs import inspect_tree
from .system import System, run
from .units import render_units, sudo_rule
from .transactions import require_recovered
from .ownership import require_owned

MUTATIONS = ("restart", "provider/write", "models/refresh")


def validate_request(request: dict) -> tuple[str, dict]:
    require(isinstance(request, dict) and not set(request) - {"method", "params", "operationId"}, "Invalid management envelope")
    method, params = request.get("method"), request.get("params", {})
    require(isinstance(params, dict), "Management params must be an object")
    require(method in ("status", "logs", "provider/read", "operation/read", *MUTATIONS),
            "Management method is not permitted", "method_not_found")
    if method in MUTATIONS:
        operation = request.get("operationId")
        try:
            require(str(uuid.UUID(operation)) == operation, "operationId must be a canonical UUID")
        except (ValueError, TypeError, AttributeError):
            raise DeployError("invalid_input", "operationId must be a canonical UUID")
    return method, params


class Manager:
    def __init__(self, layout: Layout, system: System | None = None, worker_gid: int | None = None):
        self.layout = layout
        self.system = system or System()
        self.config = read_json(layout.config / "instance.json")
        if worker_gid is None:
            import grp
            worker_gid = grp.getgrnam(layout.prefix + "-worker").gr_gid
        self.providers = ProviderStore(layout, worker_gid)

    @property
    def service_units(self) -> list[str]:
        return [self.layout.unit("gateway"), self.layout.unit("worker")]

    def selected(self, name: str = "current") -> str | None:
        path = self.layout.app / name
        if not path.is_symlink():
            require(not path.exists(), "Release pointer is not a symlink", "corrupt_state")
            return None
        target = os.readlink(path)
        require(bool(re.fullmatch(r"releases/[0-9a-f]{64}", target)), "Invalid release pointer", "corrupt_state")
        return target.split("/")[1]

    def select(self, release: str, name: str = "current") -> None:
        require(bool(re.fullmatch(r"[0-9a-f]{64}", release)), "Invalid release id")
        temp = self.layout.app / (".select-" + secrets.token_hex(8))
        os.symlink("releases/" + release, temp)
        os.replace(temp, self.layout.app / name)
        fsync_directory(self.layout.app)

    def verify_release(self, release: str) -> dict:
        require(bool(re.fullmatch(r"[0-9a-f]{64}", release)), "Invalid release id")
        expected = read_json(self.layout.config / "manifests" / (release + ".json"), 64 * 1024**2)
        actual = inspect_tree(self.layout.app / "releases" / release, root_owned=True)
        require(actual == expected and digest(actual) == release, "Release content or permissions changed", "integrity")
        return {"release": release, "files": len(actual), "integrity": True}

    def release_accounts(self, release: str | None) -> bool:
        """Compatibility declaration from the already verified root-owned release."""
        if release is None:
            return False
        require(bool(re.fullmatch(r"[0-9a-f]{64}", release)), "Invalid release id")
        path = self.layout.app / "releases" / release / "app/package.json"
        if not path.exists() and not path.is_symlink():
            return False
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 1024 * 1024 and
                (os.name != "posix" or info.st_uid == 0 and not info.st_mode & 0o022),
                "Unsafe release compatibility metadata", "integrity")
        value = read_json(path)
        return isinstance(value, dict) and value.get("harnessAuthentication") == "account-v1"

    def builtin_edge(self) -> bool:
        path = self.layout.config / "https.json"
        return path.exists() and read_json(path).get("authentication") == "builtin"

    def require_account_compatibility(self, candidate: str) -> None:
        # The selected application's declaration also covers accounts initialized
        # in the browser without a bootstrap file; never open its writable DB as root.
        required = ((self.layout.config / "auth-bootstrap.json").exists() or self.builtin_edge() or
                    self.release_accounts(self.selected()))
        require(not required or self.release_accounts(candidate),
                "This instance uses built-in accounts. A legacy token-only release requires an explicit complete authentication rollback.",
                "authentication_downgrade")

    def require_account_recovery(self, release: str) -> None:
        """A failed candidate must not make token-only recovery an auth bypass."""
        self.verify_release(release)
        current = self.selected()
        if current is not None:
            self.verify_release(current)
        try:
            self.require_account_compatibility(release)
        except DeployError as error:
            if error.code != "authentication_downgrade":
                raise
            raise DeployError("authentication_downgrade",
                              "Legacy authentication recovery is blocked. Services remain stopped; the candidate and transaction are retained. "
                              "Correct any runtime prerequisite, then run repair --target candidate to validate and restart the original account-v1 candidate.") from error

    def initial_installation(self, *, persist: bool = True) -> dict | None:
        path = self.layout.config / "installation.json"
        if path.exists():
            state = read_json(path, 16384)
            require(isinstance(state, dict) and set(state) == {"format", "phase", "release"} and state["format"] == 1 and
                    state["phase"] in ("pending", "healthy", "complete") and
                    ((state["phase"] == "pending" and state["release"] is None) or
                     (state["phase"] != "pending" and isinstance(state["release"], str) and
                      bool(re.fullmatch(r"[0-9a-f]{64}", state["release"])))),
                    "Invalid installation completion record", "corrupt_state")
            return state
        # A pre-marker installation is resumed only with evidence that it has
        # never committed a release. An established instance's disabled units
        # must not be enabled merely because its old installer had no marker.
        releases = []
        for record in (self.layout.state / "transactions").glob("*/state.json"):
            value = read_json(record)
            if value.get("kind") == "release":
                releases.append(value)
        current = self.selected()
        if self.selected("previous") is not None or any(value.get("old") or value.get("phase") == "committed" for value in releases):
            return None
        if current is not None and not any(value.get("candidate") == current and value.get("old") is None and
                                           value.get("phase") in ("prepared", "stopped", "selected", "failed_first_start") for value in releases):
            return None
        state = {"format": 1, "phase": "pending", "release": None}
        if persist:
            write_json(path, state)
        return state

    def complete_initial_installation(self, release: str) -> None:
        state = self.initial_installation()
        if state is None or state["phase"] == "complete":
            return
        # Health and boot enablement are separate durable facts. A failed or
        # interrupted enable is retryable without classifying this healthy
        # release as an unsuccessful first-start candidate.
        state = {"format": 1, "phase": "healthy", "release": release}
        write_json(self.layout.config / "installation.json", state)
        self.system.enable(list(reversed(self.service_units)))
        write_json(self.layout.config / "installation.json", {**state, "phase": "complete"})

    def retire_initial_attempts(self, except_transaction: Path | None = None) -> None:
        # Called only after confirming both service cgroups stopped. Retain the
        # complete attempt records, but do not leave an abandoned first start
        # masquerading as another live transaction during later repair.
        for path in (self.layout.state / "transactions").glob("*/state.json"):
            if path == except_transaction:
                continue
            state = read_json(path)
            if state.get("kind") == "release" and state.get("old") is None and state.get("phase") in ("prepared", "stopped", "selected"):
                write_json(path, {**state, "phase": "failed_first_start"})

    def require_recovered_transactions(self, installation: dict | None) -> None:
        require_recovered(self.layout, installation)

    def require_service_ownership(self, *, allow_absent: bool = False, prior_units: dict | None = None) -> None:
        require_owned(self.layout, self.config, allow_absent=allow_absent, prior_units=prior_units)

    def require_update_ready(self, *, persist: bool = True) -> dict | None:
        self.require_service_ownership()
        installation = self.initial_installation(persist=False)
        self.require_recovered_transactions(installation)
        if persist and installation is not None and not (self.layout.config / "installation.json").exists():
            write_json(self.layout.config / "installation.json", installation)
        return installation

    def refresh_worker_unit(self) -> None:
        """Only migrate the exact recognized runtime-directory group defect."""
        path = self.layout.units / self.layout.unit("worker")
        expected = render_units(self.layout, self.config, self.config["codexRelative"])[path.name].encode()
        recognized = {render_units(self.layout, self.config, self.config["codexRelative"], legacy_runtime_directory=runtime, legacy_native_home=home)[path.name].encode()
                      for runtime in (False, True) for home in (False, True)}
        actual = path.read_bytes()
        require(actual in recognized, "Worker service definition changed", "ownership_conflict")
        if actual != expected:
            atomic_write(path, expected, 0o644)
        # Reload even on a retry after atomic publication succeeded but reload
        # failed. Callers have confirmed the worker stopped before this method.
        self.system.reload()

    def restore_previous(self, journal: dict) -> None:
        if "oldPrevious" not in journal:
            # Older journals did not save this pointer. Do not invent a lost
            # rollback target; discard only a self-reference created by failure.
            if self.selected("previous") != journal.get("old"):
                return
            previous = None
        else:
            previous = journal["oldPrevious"]
        if previous is not None:
            self.select(previous, "previous")
        else:
            (self.layout.app / "previous").unlink(missing_ok=True)
            fsync_directory(self.layout.app)

    def healthy(self) -> None:
        last_error = None
        for _ in range(30):
            try:
                for unit in self.service_units:
                    state = self.system.state(unit)
                    require(state["ActiveState"] == "active" and state["SubState"] == "running" and state["MainPID"] != "0",
                            "Service is not running", "health")
                connection = http.client.HTTPConnection("127.0.0.1", self.config["port"], timeout=2)
                try:
                    connection.request("GET", "/health", headers={"Host": self.config["origin"].split("://", 1)[1]})
                    response = connection.getresponse()
                    body = response.read(65537)
                    require(response.status == 200 and len(body) <= 65536 and isinstance(json.loads(body), dict), "Gateway health failed", "health")
                finally:
                    connection.close()
                worker = http.client.HTTPConnection("localhost", timeout=2)
                try:
                    worker.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    worker.sock.settimeout(2)
                    worker.sock.connect(str(self.layout.run / "worker.sock"))
                    worker.request("GET", "/status")
                    response = worker.getresponse()
                    content = response.read(65537)
                    require(response.status == 200 and len(content) <= 65536, "Worker health failed", "health")
                    value = json.loads(content)
                    require(value.get("ok") is True and value.get("result", {}).get("connected") is True,
                            "Native runtime is not connected", "health")
                finally:
                    worker.close()
                if self.builtin_edge() or self.release_accounts(self.selected()):
                    from .accounts import account_request
                    account, _ = account_request(self, "GET", timeout=2)
                    require(account.get("authenticationMode") == "account" and isinstance(account.get("initialized"), bool),
                            "Gateway account authentication is unavailable", "health")
                    if self.builtin_edge() or (self.layout.config / "auth-bootstrap.json").exists():
                        require(account["initialized"] is True, "Administrator account was not initialized", "health")
                return
            except (DeployError, OSError, ValueError) as exc:
                last_error = exc
                time.sleep(1)
        raise DeployError("health", "Service health check failed") from last_error

    def recover_control(self) -> None:
        # Reconfirm immediately before changing the activity barrier. This never
        # changes an unknown operation into an unsent or accepted operation.
        require(all(self.system.state(unit)["stopped"] for unit in self.service_units),
                "Control recovery requires stopped services", "stop_unknown")
        recover_as_owner(self.layout.state / "gateway/journal.sqlite", self.config["gatewayUid"], self.config["gatewayGid"])

    def status(self) -> dict:
        return {"instance": self.layout.instance, "release": self.selected(), "previous": self.selected("previous"),
                "providerConfigLayer": self.config.get("providerConfigLayer", "legacy"),
                "origin": self.config["origin"], "nodeVersion": NODE_VERSION, "pnpmVersion": PNPM_VERSION, "codexVersion": CODEX_VERSION,
                "services": {role: self.system.state(self.layout.unit(role)) for role in ("gateway", "worker")}}

    def verify(self) -> dict:
        release = self.selected()
        require(release is not None, "No active release", "not_installed")
        result = self.verify_release(release)
        token = self.layout.config / "gateway-token"
        details = token.lstat()
        require(stat.S_ISREG(details.st_mode) and details.st_uid == 0 and details.st_gid == self.config["gatewayGid"] and
                stat.S_IMODE(details.st_mode) == 0o640, "Administrator token ownership/permissions changed", "integrity")
        from .accounts import verify_bootstrap
        account_bootstrap = verify_bootstrap(self.layout, self.config)
        for role in ("gateway", "worker", "supervisor"):
            path = self.layout.state / role
            details = path.lstat()
            require(stat.S_ISDIR(details.st_mode) and details.st_uid == self.config[role + "Uid"] and
                    stat.S_IMODE(details.st_mode) == (0o700 if role == "gateway" else 0o750), "Service state permissions changed", "integrity")
        inspect_tree(self.layout.control, root_owned=True)
        for name, value in render_units(self.layout, self.config, self.config["codexRelative"]).items():
            require((self.layout.units / name).read_text() == value, "Service unit differs from managed configuration", "integrity")
        sudo_path = self.layout.root / "etc/sudoers.d" / ("codex-harness-" + self.layout.instance)
        sudo_policies = {sudo_rule(self.layout)}
        if self.config.get("providerConfigLayer") is None:
            sudo_policies.add(sudo_rule(self.layout, workspace=False))
        require(sudo_path.read_text() in sudo_policies, "Fixed sudo policy changed", "integrity")
        settings = self.providers.read()
        from .provider import native_config
        require((self.providers.root / "current/config.toml").read_bytes() == native_config(settings, self.layout),
                "Provider configuration changed", "integrity")
        if settings.get("nativeCatalog"):
            require(read_json(self.providers.root / "current/models.json", 1024 * 1024) == settings["nativeCatalog"],
                    "Native provider catalog changed", "integrity")
        if self.config.get("providerConfigLayer") == "system-v1":
            from .provider_layers import verify_system_layers
            verify_system_layers(self.layout)
        return {**result, "permissions": True, "managedUnits": True, "accountBootstrap": account_bootstrap,
                "providerRevision": settings["revision"], "services": self.status()["services"]}

    def activate(self, candidate: str, transaction_id: str | None = None) -> dict:
        installation = self.require_update_ready()
        self.verify_release(candidate)
        old = self.selected()
        if installation is not None and installation["phase"] == "pending":
            # A pointer retained by an older failed first start is not a
            # rollback target. Its stopped tree and journal remain available.
            old = None
        if old == candidate:
            if installation is not None and installation["phase"] != "complete":
                self.restart()
            return {"release": candidate, "changed": False}
        if old:
            self.verify_release(old)
        self.require_account_compatibility(candidate)
        txid = transaction_id or uuid.uuid4().hex
        tx = self.layout.state / "transactions" / txid
        mkdir(tx, 0o700)
        journal = {"kind": "release", "old": old, "oldPrevious": self.selected("previous"), "candidate": candidate, "phase": "prepared"}
        write_json(tx / "state.json", journal)
        self.system.stop(self.service_units)
        self.recover_control()
        self.refresh_worker_unit()
        if old is None:
            self.retire_initial_attempts(tx / "state.json")
        journal["phase"] = "stopped"
        write_json(tx / "state.json", journal)
        try:
            self.select(candidate)
            journal["phase"] = "selected"
            write_json(tx / "state.json", journal)
            self.system.start(list(reversed(self.service_units)))
            self.healthy()
            if old:
                self.select(old, "previous")
            journal["phase"] = "committed"
            write_json(tx / "state.json", journal)
        except Exception:
            # If stop cannot be established, leave every byte and pointer in place.
            self.system.stop(self.service_units)
            if old:
                self.require_account_recovery(old)
                self.select(old)
                self.restore_previous(journal)
                self.system.start(list(reversed(self.service_units)))
                self.healthy()
                journal["phase"] = "recovered"
            else:
                (self.layout.app / "current").unlink(missing_ok=True)
                fsync_directory(self.layout.app)
                self.restore_previous(journal)
                journal["phase"] = "failed_first_start"
            write_json(tx / "state.json", journal)
            raise
        # Enable failure must not roll back a healthy release or erase its
        # commit. The installation marker remains retryable until enable wins.
        self.complete_initial_installation(candidate)
        return {"release": candidate, "previous": old, "changed": True}

    def provider_change(self, params: dict, *, catalog: bool = False) -> dict:
        self.require_recovered_transactions(None)
        self.require_service_ownership()
        old = self.providers.read()
        action, value = ("provider", validate_catalog(params, old)) if catalog else self.providers.validate_change(params, old)
        if action != "provider":
            from .provider_lifecycle import Profiles
            profiles = Profiles(self.layout)
            if action == "saveProfileName":
                profiles.save(value, old)
            else:
                profiles.remove(value)
            return self.providers.public(old)
        new = value
        if new == old:
            return self.providers.public(old)
        generation = self.providers.prepare(new)
        tx = self.layout.state / "transactions" / uuid.uuid4().hex
        mkdir(tx, 0o700)
        journal = {"kind": "provider", "old": old["revision"], "candidate": generation, "phase": "prepared"}
        write_json(tx / "state.json", journal)
        # Only worker needs to stop; gateway remains available to return the receipt.
        unit = [self.layout.unit("worker")]
        self.system.stop(unit)
        self.refresh_worker_unit()
        require(self.providers.read()["revision"] == old["revision"], "Provider changed during preparation", "revision_conflict")
        try:
            self.providers.select(generation)
            journal["phase"] = "selected"
            write_json(tx / "state.json", journal)
            self.system.start(unit)
            # Worker restart can stop Requires-bound gateway; start it explicitly.
            self.system.start([self.layout.unit("gateway")])
            self.healthy()
            journal["phase"] = "committed"
            write_json(tx / "state.json", journal)
        except Exception:
            self.system.stop(unit)
            self.providers.select(old["revision"])
            self.system.start(unit)
            self.system.start([self.layout.unit("gateway")])
            self.healthy()
            journal["phase"] = "recovered"
            write_json(tx / "state.json", journal)
            raise
        return self.providers.public(new)

    def refresh_models(self, params: dict) -> dict:
        require(not set(params) - {"expectedRevision", "models", "confirmCapabilities"}, "Invalid catalog refresh fields")
        current = self.providers.read()
        require(params.get("expectedRevision") == current["revision"], "Provider changed; read again", "revision_conflict")
        if "models" in params:
            require(params.get("confirmCapabilities") is True, "Confirm the model capabilities before applying the catalog", "confirmation_required")
            return {**self.provider_change({"expectedRevision": params["expectedRevision"], "models": params["models"]}, catalog=True),
                    "applied": True, "requiresConfirmation": False}
        require("confirmCapabilities" not in params, "Confirmation requires a model catalog")
        if current["kind"] in ("chatgpt", "chatgpt-gateway", "bedrock-runtime", "bedrock-mantle"):
            return {**redacted(current), "source": "native", "applied": False, "requiresConfirmation": False}
        from .catalog import fetch_ids
        models = fetch_ids(current)
        require(self.providers.read()["revision"] == current["revision"], "Provider changed during discovery", "revision_conflict")
        return {**redacted(current), "models": models, "source": "provider", "applied": False, "requiresConfirmation": True,
                "notice": "These model IDs are unverified. Confirm Responses/tool compatibility and reasoning settings before applying."}

    def restart(self) -> dict:
        installation = self.require_update_ready()
        self.system.stop(self.service_units)
        self.recover_control()
        self.refresh_worker_unit()
        if installation is not None and installation["phase"] == "pending":
            self.retire_initial_attempts()
        current = self.selected()
        require(current is not None, "No active release", "not_installed")
        self.verify_release(current)
        self.system.start(list(reversed(self.service_units)))
        self.healthy()
        self.complete_initial_installation(current)
        return {"restarted": True, "release": current}

    def repair_candidate(self, path: Path, state: dict) -> dict:
        require(state.get("kind") == "release", "Candidate recovery applies only to the original pending application release", "recovery_required")
        candidate, old = state.get("candidate"), state.get("old")
        require(isinstance(candidate, str) and (old is None or isinstance(old, str)), "Invalid release recovery record", "corrupt_state")
        self.require_service_ownership()
        self.verify_release(candidate)
        current = self.selected()
        require(current in (candidate, old), "Current release differs from the pending transaction", "recovery_required")
        if current is not None:
            self.verify_release(current)
        if old is not None:
            self.verify_release(old)
        self.require_account_compatibility(candidate)
        self.system.stop(self.service_units)
        self.recover_control()
        self.refresh_worker_unit()
        self.verify_release(candidate)
        try:
            if self.selected() != candidate:
                self.select(candidate)
            state["phase"] = "selected"
            write_json(path, state)
            self.system.start(list(reversed(self.service_units)))
            self.healthy()
            if old:
                self.select(old, "previous")
            state["phase"] = "committed"
            write_json(path, state)
        except Exception:
            self.system.stop(self.service_units)
            raise
        self.complete_initial_installation(candidate)
        return {"repaired": True, "recoveredTransactions": 1, "target": "candidate", "release": candidate}

    def repair(self, *, target: str = "old") -> dict:
        require(target in ("old", "candidate"), "Invalid recovery target")
        pending = []
        for path in sorted((self.layout.state / "transactions").glob("*/state.json")):
            state = read_json(path)
            if state.get("phase") not in ("committed", "recovered", "failed_first_start"):
                pending.append((path, state))
        require(len(pending) <= 1, "Multiple unfinished transactions require operator inspection", "recovery_required")
        if target == "candidate":
            require(len(pending) == 1, "Candidate recovery requires one unfinished application transaction", "recovery_required")
            return self.repair_candidate(*pending[0])
        if pending:
            path, state = pending[0]
            if state.get("kind") == "https":
                from .https import recover_https_transaction
                recover_https_transaction(self, path, state)
                return {"repaired": True, "recoveredTransactions": 1}
            if state.get("kind") == "config-layer":
                from .config_layer import recover_config_layer
                return recover_config_layer(self, path, state)
            self.require_service_ownership()
            self.system.stop(self.service_units)
            self.recover_control()
            self.refresh_worker_unit()
            if state["kind"] == "release":
                require(state.get("old"), "First install failed; retained candidate needs explicit update", "recovery_required")
                self.require_account_recovery(state["old"])
                self.select(state["old"])
                self.restore_previous(state)
            elif state["kind"] == "provider":
                self.providers.select(state["old"])
            else:
                raise DeployError("recovery_required", "Unknown transaction type")
            self.system.start(list(reversed(self.service_units)))
            self.healthy()
            state["phase"] = "recovered"
            write_json(path, state)
        else:
            self.restart()
        return {"repaired": True, "recoveredTransactions": len(pending)}

    def preflight_mutation(self, request: dict) -> dict | None:
        """Read-only admission, shared by the RPC spool and final dispatcher.

        Call under management.lock. Rechecking at execution prevents a staged
        request from relying on stale provider/recovery state. A receipt replay
        returns before staging a new file or launching another root unit.
        """
        method, params = validate_request(request)
        require(method in MUTATIONS, "Expected a management mutation")
        receipts = self.layout.state / "receipts"
        operation = request["operationId"]
        receipt = receipts / (operation + ".json")
        identity = digest({"method": method, "params": params})
        if receipt.exists():
            saved = read_json(receipt)
            require(saved["requestDigest"] == identity, "Operation ID reused with different input", "operation_conflict")
            if saved["state"] == "completed":
                return {"ok": True, "result": saved["result"]}
            return {"ok": False, "error": saved.get("error", {"code": "unknown", "message": "Management outcome needs inspection", "delivery": "unknown"})}
        require(len(list(receipts.glob("*.json"))) < 10000, "Management receipt retention budget reached", "budget")
        if method == "restart":
            self.require_update_ready(persist=False)
        else:
            self.require_recovered_transactions(None)
            if method == "provider/write" or "models" in params:
                self.require_service_ownership()
        if method == "provider/write":
            self.providers.validate_change(params, self.providers.read())
        elif method == "models/refresh":
            require(not set(params) - {"expectedRevision", "models", "confirmCapabilities"}, "Invalid catalog refresh fields")
            current = self.providers.read()
            require(params.get("expectedRevision") == current["revision"], "Provider changed; read again", "revision_conflict")
            if "models" in params:
                require(params.get("confirmCapabilities") is True, "Confirm model capabilities before applying", "confirmation_required")
                validate_catalog({"expectedRevision": params["expectedRevision"], "models": params["models"]}, current)
            else:
                require("confirmCapabilities" not in params, "Confirmation requires a model catalog")
        else:
            require(not params, "restart takes no parameters")
        return None

    def dispatch(self, request: dict) -> dict:
        method, params = validate_request(request)
        receipts = self.layout.state / "receipts"
        mutation = method in MUTATIONS
        if mutation:
            replay = self.preflight_mutation(request)
            if replay is not None:
                return replay
            operation = request["operationId"]
            receipt = receipts / (operation + ".json")
            identity = digest({"method": method, "params": params})
            # Persist only digest and delivery facts, never API keys or provider parameters.
            saved = {"operationId": operation, "method": method, "requestDigest": identity,
                     "gatewayRequestDigest": digest({"method": "system/" + method, "params": params}), "state": "running"}
            mkdir(receipts, 0o700)
            write_json(receipt, saved)
        try:
            if method == "status":
                require(not params, "status takes no parameters")
                value = self.status()
            elif method == "logs":
                require(not set(params) - {"service", "lines"} and params.get("service", "gateway") in ("gateway", "worker"), "Invalid logs parameters")
                text = self.system.logs(self.layout.unit(params.get("service", "gateway")), params.get("lines", 100))
                # Service diagnostics may accidentally include credentials. Remove exact known secrets.
                known_secrets = [(self.layout.config / "gateway-token").read_text().strip()]
                from .provider_lifecycle import Profiles
                known_secrets.extend(profile["settings"].get("apiKey") for profile in Profiles(self.layout).records())
                for generation in self.providers.root.iterdir():
                    if re.fullmatch(r"[0-9a-f]{32}", generation.name):
                        known_secrets.append(read_json(generation / "settings.json", 4 * 1024 * 1024).get("apiKey"))
                for secret in sorted({value for value in known_secrets if isinstance(value, str) and value}, key=len, reverse=True):
                    text = text.replace(secret, "[redacted]")
                value = {"text": text, "truncated": len(text) >= 131072}
            elif method == "provider/read":
                require(not params, "provider/read takes no parameters")
                value = self.providers.public()
            elif method == "provider/write":
                value = self.provider_change(params)
            elif method == "models/refresh":
                value = self.refresh_models(params)
            elif method == "operation/read":
                require(set(params) == {"operationId"} and isinstance(params["operationId"], str) and
                        bool(re.fullmatch(r"[0-9a-f-]{36}", params["operationId"])), "Invalid operation lookup")
                path = receipts / (params["operationId"] + ".json")
                value = read_json(path) if path.exists() else {"operationId": params["operationId"], "state": "not_received"}
            else:
                require(not params, "restart takes no parameters")
                value = self.restart()
            result = {"ok": True, "result": value}
        except DeployError as exc:
            discovery = method == "models/refresh" and "models" not in params
            result = {"ok": False, "error": {"code": exc.code, "message": str(exc), "delivery": "unknown" if mutation and not discovery else "not_sent"}}
        if mutation:
            saved["state"] = "completed" if result["ok"] else "failed"
            saved["result" if result["ok"] else "error"] = result["result" if result["ok"] else "error"]
            write_json(receipt, saved)
        return result
