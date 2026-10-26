from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import sys
import uuid
from pathlib import Path

from .build import Builder, pack_source
from .common import DeployError, Layout, exclusive, read_json, require
from .install import install, uninstall
from .manager import MUTATIONS, Manager, validate_request
from .requests import MAX_REQUEST, RequestSpool
from .system import System, require_linux, run

def read_request(stream) -> dict:
    data = stream.read(MAX_REQUEST + 1)
    require(len(data.encode()) <= MAX_REQUEST, "Management request exceeds budget", "budget")
    value = json.loads(data)
    require(isinstance(value, dict), "Management request must be an object")
    return value


def error_result(exc: Exception, delivery: str = "not_sent") -> dict:
    return {"ok": False, "error": {"code": exc.code if isinstance(exc, DeployError) else "management_error",
                                   "message": str(exc) if isinstance(exc, DeployError) else "Management operation failed; inspect retained transaction",
                                   "delivery": delivery}}


def helper_main(instance: str) -> None:
    """Installed wrapper binds the instance. sudoers permits ONLY the rpc argv."""
    dispatched = False
    try:
        require_linux()
        layout = Layout(instance)
        require(sys.argv[1:] in (["rpc"], ["config-check"]) or (len(sys.argv) == 3 and sys.argv[1] == "execute" and
                bool(re.fullmatch(r"[0-9a-f]{32}", sys.argv[2]))), "Invalid fixed management invocation")
        if sys.argv[1:] == ["config-check"]:
            # Read-only fixed root service, deliberately no management.lock:
            # the caller starting the worker may already hold that lock.
            from .provider_layers import verify_system_layers
            print(json.dumps({"ok": True, "result": verify_system_layers(layout)}))
            return
        if sys.argv[1] == "execute":
            request_id = sys.argv[2]
            spool = RequestSpool(layout)
            request = spool.load(request_id)
            try:
                with exclusive(layout.config / "management.lock"):
                    from .control_update import require_no_pending_control
                    require_no_pending_control(layout)
                    result = Manager(layout).dispatch(request)
            except Exception as exc:
                operation = request.get("operationId", "")
                has_receipt = isinstance(operation, str) and bool(re.fullmatch(r"[0-9a-f-]{36}", operation)) and (layout.state / "receipts" / (operation + ".json")).exists()
                result = error_result(exc, "unknown" if has_receipt else "not_sent")
            # Only a stopped/cgroup-confirmed collector removes input and output.
            # This executor never deletes a request while its unit is active.
            spool.publish(request_id, result)
            return
        request = read_request(sys.stdin)
        method, _ = validate_request(request)
        if method in MUTATIONS:
            # Reject invalid/stale input and replay durable receipts before any
            # staging write. The executor repeats admission under the same lock.
            with exclusive(layout.config / "management.lock"):
                from .control_update import require_no_pending_control
                require_no_pending_control(layout)
                result = Manager(layout).preflight_mutation(request)
            if result is not None:
                print(json.dumps(result, ensure_ascii=False))
                return
            # Mutation lives outside gateway's cgroup. A restart may kill this
            # waiting RPC process, but cannot kill the independently owned unit.
            spool = RequestSpool(layout)
            with spool.stage(request) as request_id:
                command = ["/usr/bin/systemd-run", "--quiet", "--wait", "--unit=codex-harness-" + instance + "-manage-" + request_id,
                           "--property=Type=exec", "--property=User=root", "--property=UMask=0077", "--property=TimeoutStartSec=180",
                           "--property=RuntimeMaxSec=180", "--property=KillMode=control-group", "--property=StandardOutput=null",
                           "--property=StandardError=journal", "--property=MemoryMax=512M", "--property=MemorySwapMax=0",
                           "--property=TasksMax=32", "--", str(layout.control / "manage"), "execute", request_id]
                failure = None
                dispatched = True
                try:
                    run(command, timeout=190)
                except Exception as exc:
                    failure = exc
                # A failed launch/wait may still have completed the operation.
                # Confirm the unit stopped before reading/removing its spool.
                result = spool.finish(request_id)
                if result is None:
                    if failure is not None:
                        raise failure
                    raise DeployError("unknown", "Management output is unavailable; query the original operation")
        else:
            with exclusive(layout.config / "management.lock"):
                from .control_update import require_no_pending_control
                require_no_pending_control(layout)
                result = Manager(layout).dispatch(request)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps(error_result(exc, "unknown" if dispatched else "not_sent"), ensure_ascii=False))
        raise SystemExit(1)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="Codex Harness Linux installation and transaction manager")
    root.add_argument("--instance", default="main")
    subs = root.add_subparsers(dest="command", required=True)
    pack = subs.add_parser("pack-source", help="Package allowed source inputs; does not include credentials or dependencies")
    pack.add_argument("--source", type=Path, default=Path.cwd())
    pack.add_argument("--output", type=Path, required=True)
    setup = subs.add_parser("install", help="Install a new isolated instance; failure preserves recovery materials")
    setup.add_argument("--source", type=Path, required=True)
    setup.add_argument("--origin")
    setup.add_argument("--port", type=int, default=3000)
    setup.add_argument("--username", default="admin")
    setup.add_argument("--password-stdin", action="store_true", help="Read one password line from stdin; never pass passwords in argv")
    for command in ("account-setup", "account-reset"):
        account = subs.add_parser(command, help="Operator only: initialize or reset the single administrator account")
        account.add_argument("--username", default="admin")
        account.add_argument("--password-stdin", action="store_true")
    for name in ("status", "verify", "restart", "repair", "rollback", "uninstall", "provider-read"):
        command = subs.add_parser(name)
        if name == "repair":
            command.add_argument("--target", choices=("old", "candidate"), default="old")
    subs.add_parser("provider-prune", help="Retain current and pending-recovery generations plus three recent unused generations")
    logs = subs.add_parser("logs")
    logs.add_argument("--service", choices=("gateway", "worker"), default="gateway")
    logs.add_argument("--lines", type=int, default=100)
    update = subs.add_parser("update")
    update.add_argument("--source", type=Path, required=True)
    subs.add_parser("control-update", help="Operator only: install trusted control code from this reviewed root-owned checkout")
    control_recover = subs.add_parser("control-recover", help="Operator only: recover one original control generation after interrupted maintenance")
    control_recover.add_argument("--target", choices=("old", "candidate"), default="old")
    subs.add_parser("config-layer-migrate", help="Operator only: migrate or refresh preserved host defaults and enforced provider requirements")
    subs.add_parser("config-layer-rollback", help="Operator only: restore legacy config mount and sudo compatibility, preserving user config bytes")
    layer_recover = subs.add_parser("config-layer-recover", help="Operator only: recover one interrupted configuration-layer transaction")
    layer_recover.add_argument("--target", choices=("old", "candidate"), default="old")
    control_rollback = subs.add_parser("control-rollback", help="Operator only: restore retained trusted control code as a new transaction")
    control_rollback.add_argument("--transaction", required=True)
    provider = subs.add_parser("provider-write", help="Read provider JSON from stdin; credentials never appear in argv")
    provider.add_argument("--operation-id", default=None)
    catalog = subs.add_parser("models-sync", help="Read catalog JSON from stdin; binds to provider revision")
    catalog.add_argument("--operation-id", default=None)
    operation = subs.add_parser("operation-read")
    operation.add_argument("operation_id")
    secure = subs.add_parser("https", help="Configure Caddy HTTPS with built-in accounts; migrate a retained Authelia edge safely")
    secure.add_argument("--host", required=True)
    secure.add_argument("--auth-host", help="Legacy migration compatibility only")
    secure.add_argument("--cookie-domain", help="Legacy migration compatibility only")
    secure.add_argument("--username", default="admin")
    secure.add_argument("--email", help="Legacy migration compatibility only")
    secure.add_argument("--password-stdin", action="store_true")
    secure.add_argument("--credentials-stdin", action="store_true", help="Read {username,password,otp?} JSON for login verification")
    secure.add_argument("--two-factor", action="store_true", help="Prompt securely for a TOTP or recovery code")
    secure.add_argument("--authelia-port", type=int, help="Legacy migration compatibility only")
    secure.add_argument("--tls", choices=("acme", "internal", "provided"), default="acme")
    secure.add_argument("--certificate", type=Path)
    secure.add_argument("--private-key", type=Path)
    secure.add_argument("--http-port", type=int, default=80)
    secure.add_argument("--https-port", type=int, default=443)
    return root


def main(argv: list[str] | None = None) -> None:
    try:
        args = parser().parse_args(argv)
        layout = Layout(args.instance)
        if args.command == "pack-source":
            pack_source(args.source.resolve(), args.output.resolve())
            result = {"sourceArchive": str(args.output.resolve())}
        elif args.command == "install":
            require_linux()
            origin = args.origin
            if not origin:
                require(sys.stdin.isatty(), "--origin is required for non-interactive installation")
                print("Single administrator deployment. Default bind address is 127.0.0.1; use SSH forwarding or optional HTTPS.", file=sys.stderr)
                origin = input(f"Browser origin [http://127.0.0.1:{args.port}]: ").strip() or f"http://127.0.0.1:{args.port}"
            from .accounts import bootstrap, read_password
            account = bootstrap(args.username, read_password(from_stdin=args.password_stdin))
            result = install(layout, args.source.resolve(), origin=origin, port=args.port, account=account)
        elif args.command in ("control-update", "control-recover", "control-rollback"):
            require_linux()
            from .control_update import control_command
            with exclusive(layout.config / "management.lock"):
                result = control_command(layout, args.command, getattr(args, "transaction", None), target=getattr(args, "target", "old"))
        else:
            require_linux()
            with exclusive(layout.config / "management.lock"):
                from .control_update import require_no_pending_control
                require_no_pending_control(layout)
                manager = Manager(layout)
                if args.command == "status":
                    result = manager.status()
                elif args.command in ("account-setup", "account-reset"):
                    from .accounts import configure_account, read_password
                    result = configure_account(manager, args.username, read_password(from_stdin=args.password_stdin),
                                               reset=args.command == "account-reset")
                elif args.command in ("config-layer-migrate", "config-layer-rollback"):
                    from .config_layer import change_config_layer
                    result = change_config_layer(manager, layered=args.command == "config-layer-migrate")
                elif args.command == "config-layer-recover":
                    from .config_layer import recover_config_layer
                    pending = [(path, read_json(path)) for path in (layout.state / "transactions").glob("*/state.json")]
                    pending = [(path, state) for path, state in pending if state.get("phase") not in ("committed", "recovered", "failed_first_start")]
                    require(len(pending) == 1 and pending[0][1].get("kind") == "config-layer", "Expected one pending configuration-layer transaction", "recovery_required")
                    result = recover_config_layer(manager, *pending[0], candidate=args.target == "candidate")
                elif args.command == "verify":
                    result = manager.verify()
                elif args.command == "provider-prune":
                    from .provider_lifecycle import collect_generations
                    result = collect_generations(layout, manager.providers.root)
                elif args.command == "update":
                    manager.require_update_ready(persist=False)
                    config = manager.config
                    release = Builder(layout, manager.system, config["buildUid"], config["buildGid"]).prepare(args.source.resolve())
                    result = manager.activate(release)
                elif args.command == "rollback":
                    release = manager.selected("previous")
                    require(release is not None, "No previous release", "not_installed")
                    result = manager.activate(release)
                elif args.command == "restart":
                    result = manager.restart()
                elif args.command == "repair":
                    result = manager.repair(target=args.target)
                elif args.command == "uninstall":
                    result = uninstall(layout)
                elif args.command == "https":
                    from .https import setup_https
                    from .accounts import read_password
                    require(not (args.credentials_stdin and (args.password_stdin or args.two_factor)),
                            "Choose one credential input mode")
                    if args.credentials_stdin:
                        credentials = read_request(sys.stdin)
                        require(set(credentials) <= {"username", "password", "otp"} and
                                {"username", "password"} <= set(credentials) and
                                ("otp" not in credentials or isinstance(credentials["otp"], str) and len(credentials["otp"]) <= 128),
                                "Credentials JSON must contain username, password and optional otp")
                    else:
                        credentials = {"username": args.username, "password": read_password(from_stdin=args.password_stdin, confirm=False)}
                        if args.two_factor:
                            require(sys.stdin.isatty(), "Use --credentials-stdin for non-interactive two-factor verification")
                            credentials["otp"] = getpass.getpass("Two-factor or recovery code: ")
                    result = setup_https(manager, host=args.host, auth_host=args.auth_host, domain=args.cookie_domain,
                                         username=credentials["username"], password=credentials["password"], otp=credentials.get("otp"),
                                         email=args.email, auth_port=args.authelia_port, tls=args.tls,
                                         certificate=args.certificate, private_key=args.private_key,
                                         http_port=args.http_port, https_port=args.https_port)
                else:
                    method, params = {
                        "logs": ("logs", {"service": getattr(args, "service", "gateway"), "lines": getattr(args, "lines", 100)}),
                        "provider-read": ("provider/read", {}),
                        "operation-read": ("operation/read", {"operationId": getattr(args, "operation_id", "")}),
                        "provider-write": ("provider/write", None), "models-sync": ("models/refresh", None),
                    }[args.command]
                    if params is None:
                        params = read_request(sys.stdin)
                    request = {"method": method, "params": params}
                    if args.command in ("provider-write", "models-sync"):
                        request["operationId"] = args.operation_id or str(uuid.uuid4())
                    result = manager.dispatch(request)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as exc:
        # Operator commands have durable transaction journals, but no single
        # dispatch boundary. An exception may follow selection, startup or
        # partial enablement; it cannot safely assert RPC-style not_sent.
        failure = error_result(exc)
        failure["error"].pop("delivery")
        print(json.dumps(failure, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
