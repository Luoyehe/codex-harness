"""Operator-owned bootstrap/reset material for the single administrator account."""
from __future__ import annotations

import getpass
import hashlib
import hmac
import http.client
import json
import os
import re
import secrets
import stat
import sys
import uuid
from urllib.parse import urlsplit

from .common import DeployError, canonical, read_json, require, write_json
from .safe_fs import stable_identity


def validate_credentials(username: str, password: str) -> None:
    require(isinstance(username, str) and bool(re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", username)),
            "Username must contain 1-64 ASCII letters, digits, dots, underscores or hyphens")
    require(isinstance(password, str) and 12 <= len(password) <= 256 and "\0" not in password and
            not any(0xD800 <= ord(character) <= 0xDFFF for character in password) and len(password.encode("utf-8")) <= 1024,
            "Password must contain 12-256 characters and at most 1024 UTF-8 bytes")


def read_password(*, from_stdin: bool = False, confirm: bool = True) -> str:
    if from_stdin:
        # One bounded line permits a pipe without ever putting the secret in argv.
        value = sys.stdin.readline(1026)
        require(len(value) <= 1025, "Password input exceeds budget")
        value = value.removesuffix("\n").removesuffix("\r")
        require(sys.stdin.read(1) == "", "Password stdin must contain exactly one line")
        return value
    require(sys.stdin.isatty(), "Use --password-stdin for non-interactive account credentials")
    value = getpass.getpass("Administrator password: ")
    if confirm:
        require(value == getpass.getpass("Confirm password: "), "Passwords do not match")
    return value


def bootstrap(username: str, password: str) -> dict:
    validate_credentials(username, password)
    salt = secrets.token_bytes(32)
    hashed = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=32768, r=8, p=3,
                            dklen=64, maxmem=64 * 1024 * 1024)
    return {"schemaVersion": 1, "revision": str(uuid.uuid4()), "username": username,
            "passwordHash": {"algorithm": "scrypt", "salt": salt.hex(), "hash": hashed.hex(), "N": 32768, "r": 8, "p": 3}}


def write_bootstrap(layout, config: dict, value: dict) -> None:
    target = layout.config / "auth-bootstrap.json"
    if target.exists() or target.is_symlink():
        info = target.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
                (os.name != "posix" or info.st_uid == 0 and info.st_gid == config["gatewayGid"] and stat.S_IMODE(info.st_mode) == 0o640),
                "Account bootstrap ownership or permissions changed", "integrity")
    write_json(target, value, mode=0o640, uid=0, gid=config["gatewayGid"])


def verify_bootstrap(layout, config: dict) -> bool:
    path = layout.config / "auth-bootstrap.json"
    if not path.exists() and not path.is_symlink():
        return False  # A legacy instance can initialize once through its old token.
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 4096 and
            (os.name != "posix" or info.st_uid == 0 and info.st_gid == config["gatewayGid"] and stat.S_IMODE(info.st_mode) == 0o640),
            "Account bootstrap ownership or permissions changed", "integrity")
    value = read_json(path, 4096)
    require(isinstance(value, dict) and set(value) == {"schemaVersion", "revision", "username", "passwordHash"} and
            value.get("schemaVersion") == 1 and isinstance(value.get("revision"), str) and
            bool(re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", value["revision"])) and
            isinstance(value.get("username"), str) and bool(re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", value["username"])),
            "Invalid account bootstrap", "integrity")
    password = value.get("passwordHash")
    require(isinstance(password, dict) and set(password) == {"algorithm", "salt", "hash", "N", "r", "p"} and
            password.get("algorithm") == "scrypt" and password.get("N") == 32768 and password.get("r") == 8 and password.get("p") == 3 and
            isinstance(password.get("salt"), str) and bool(re.fullmatch(r"[0-9a-f]{64}", password["salt"])) and
            isinstance(password.get("hash"), str) and bool(re.fullmatch(r"[0-9a-f]{128}", password["hash"])),
            "Invalid account password hash", "integrity")
    return True


def instance_proof_key(manager) -> bytes:
    path = manager.layout.config / "gateway-token"
    require(not path.is_symlink(), "Unsafe instance proof key", "integrity")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 4096 and
                (os.name != "posix" or info.st_uid == 0 and info.st_gid == manager.config["gatewayGid"] and
                 stat.S_IMODE(info.st_mode) == 0o640), "Unsafe instance proof key", "integrity")
        value = os.read(descriptor, 4097)
        require(stable_identity(info) == stable_identity(os.fstat(descriptor)) and len(value) <= 4096,
                "Instance proof key changed", "integrity")
        token = value.decode("utf-8").strip()
        require(32 <= len(token) <= 4096, "Invalid instance proof key", "integrity")
        return hashlib.sha256(token.encode("utf-8")).digest()
    finally:
        os.close(descriptor)


def verify_server(connection, manager, headers: dict) -> None:
    nonce = secrets.token_hex(32)
    key = instance_proof_key(manager)
    expected = hmac.new(key, ("codex-harness-account-proof-v1\0" + manager.config["origin"] + "\0" + nonce).encode(), hashlib.sha256).hexdigest()
    connection.request("GET", "/api/account/proof?nonce=" + nonce, headers=headers)
    # Do not permit http.client to reconnect after proof: a different process
    # could acquire the loopback port between authentication and password POST.
    connection.auto_open = 0
    response = connection.getresponse()
    body = response.read(4097)
    require(response.status == 200 and len(body) <= 4096 and not response.will_close and connection.sock is not None,
            "Gateway identity proof failed; no account credential was sent", "account_verification")
    value = json.loads(body)
    require(isinstance(value, dict) and value.get("nonce") == nonce and isinstance(value.get("proof"), str) and
            bool(re.fullmatch(r"[0-9a-f]{64}", value["proof"])) and hmac.compare_digest(value["proof"], expected),
            "Gateway identity proof failed; no account credential was sent", "account_verification")


def account_request(manager, method: str, value: dict | None = None, *, cookie: str | None = None,
                    csrf: str | None = None, timeout: int = 15) -> tuple[dict, str | None]:
    """Only fixed loopback and path; neither redirects nor proxy environment are used."""
    parsed = urlsplit(manager.config["origin"])
    headers = {"Host": parsed.netloc, "Origin": manager.config["origin"], "Accept": "application/json"}
    if cookie is not None:
        headers["Cookie"] = cookie
    if csrf is not None:
        headers["X-Harness-CSRF"] = csrf
    data = canonical(value) if value is not None else None
    if data is not None:
        headers["Content-Type"] = "application/json"
    connection = http.client.HTTPConnection("127.0.0.1", manager.config["port"], timeout=timeout)
    try:
        connection.connect()
        connection.auto_open = 0
        # Even initialization status must be authenticated; a fake "not set up"
        # response must not trick an operator into replacing an existing account.
        verify_server(connection, manager, {"Host": parsed.netloc, "Origin": manager.config["origin"], "Accept": "application/json"})
        connection.request(method, "/api/session", body=data, headers=headers)
        response = connection.getresponse()
        body = response.read(16 * 1024 + 1)
        require(response.status == 200 and len(body) <= 16 * 1024,
                "Built-in account verification failed; check account credentials and gateway status", "account_verification")
        result = json.loads(body)
        require(isinstance(result, dict), "Invalid account verification response", "account_verification")
        return result, response.getheader("Set-Cookie")
    except (OSError, http.client.HTTPException, ValueError) as exc:
        raise DeployError("account_verification", "Built-in account verification failed; check gateway status") from exc
    finally:
        connection.close()


def verify_account_login(manager, username: str, password: str, code: str | None = None) -> None:
    validate_credentials(username, password)
    status, _ = account_request(manager, "GET")
    require(status.get("authenticationMode") == "account" and status.get("initialized") is True,
            "Initialize and verify the built-in account before replacing the external identity service", "account_required")
    request = {"username": username, "password": password}
    if code:
        request["otp"] = code
    login, cookie = account_request(manager, "POST", request)
    require(login.get("authenticated") is True and isinstance(login.get("csrf"), str) and
            isinstance(cookie, str) and len(cookie) <= 4096,
            "Built-in account login was not confirmed", "account_verification")
    result, _ = account_request(manager, "DELETE", cookie=cookie.split(";", 1)[0], csrf=login["csrf"])
    require(result.get("authenticated") is False, "Account verification session was not revoked", "account_verification")


def configure_account(manager, username: str, password: str, *, reset: bool = False) -> dict:
    manager.require_recovered_transactions(None)
    manager.require_service_ownership()
    value = bootstrap(username, password)
    if not reset:
        status, _ = account_request(manager, "GET")
        require(status.get("authenticationMode") == "account" and status.get("initialized") is False,
                "An account already exists or the gateway does not support accounts; use account-reset explicitly", "account_exists")
    write_bootstrap(manager.layout, manager.config, value)
    # Once published, never silently restore an earlier password. An unavailable
    # gateway retains the reset for the next startup/request; the output says so.
    try:
        verify_account_login(manager, username, password)
        confirmed = True
    except DeployError:
        confirmed = False
    return {"accountBootstrapWritten": True, "loginVerified": confirmed, "existingSessionsRevokedOnLoad": True,
            "recoveryFile": str(manager.layout.config / "auth-bootstrap.json"),
            "nextStep": "Sign in with the account password." if confirmed else
                        "Start or update the gateway, then verify account login. The saved reset remains pending; do not repeat it automatically."}
