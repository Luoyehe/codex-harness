"""Pure deployment decisions and atomic edge edits; no service commands."""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import tomllib
from urllib.parse import urlsplit

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from bounded_read import read_bytes_bounded, read_text_bounded


MAX_PROVIDER_CONFIG_BYTES = 1024 * 1024
MAX_SYSTEM_UNIT_BYTES = 1024 * 1024
MAX_EDGE_CONFIG_BYTES = 8 * 1024 * 1024
MAX_EDGE_REPLACEMENT_BYTES = 1024 * 1024
_CAPTURE_CURRENT = object()


def file_identity(path):
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return None
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def require_identity(path, expected):
    if file_identity(path) != expected:
        raise RuntimeError(f"configuration changed before atomic publication: {path}")


def provider_label(path):
    try:
        # Provider generations intentionally expose config.toml through one
        # managed symlink.  The descriptor still pins and bounds its target.
        config = tomllib.loads(read_bytes_bounded(
            path, MAX_PROVIDER_CONFIG_BYTES, nofollow=False
        ).decode("utf-8"))
    except FileNotFoundError:
        config = {}
    provider = config.get("model_provider", "openai")
    if not isinstance(provider, str):
        raise ValueError("model_provider must be a string")
    return {
        "ZAI": "zhipu（智谱 Coding Plan）",
        "custom": "custom（自定义 OpenAI 兼容 API）",
        "openai": "openai（原生默认模式）",
    }.get(provider, "其它模型源 " + json.dumps(provider, ensure_ascii=False))


def guard_delete(tree, preserved):
    target = Path(tree).resolve()
    for label, value in preserved.items():
        if not value:
            continue
        resolved = Path(value).resolve()
        if resolved == target or target in resolved.parents:
            raise ValueError(f"refusing to delete {target}: retained {label} is inside it: {resolved}")
    return str(target)


def registered_projects(home):
    """Do not claim project preservation when the registry cannot be read."""
    registry = Path(home) / "webui-projects.json"
    try:
        raw = read_bytes_bounded(registry, 1024 * 1024)
    except FileNotFoundError:
        # A missing/dangling registry cannot prove there were no registrations
        # before a failed startup or partial data loss. Require an explicit
        # valid inventory instead of making an unsafe preservation promise.
        raise ValueError(f"project registry is missing or unreadable: {registry}") from None
    registry_data = json.loads(raw)
    # ProjectRegistry persists an object, not the projects/list RPC's array.
    # Unknown/missing shapes must still fail closed: never interpret an invalid
    # inventory as proof that there are no retained projects.
    if not isinstance(registry_data, dict) or not isinstance(registry_data.get("projects"), list):
        raise ValueError(f"invalid project registry: {registry}")
    entries = registry_data["projects"]
    result = []
    for entry in entries:
        value = entry.get("path") if isinstance(entry, dict) else None
        if not isinstance(value, str) or not value or not Path(value).is_absolute():
            raise ValueError(f"invalid registered project path: {registry}")
        # resolve(strict=False) still reports loops, ENOTDIR and denied
        # ancestors. Those errors must block cleanup, not omit a project.
        result.append(str(Path(value).resolve()))
    return result


def masked_unit(path):
    """Recognize only systemd's stable root-owned, direct /dev/null mask."""
    before = file_identity(path)
    if before is None:
        raise FileNotFoundError(path)
    if (not stat.S_ISLNK(before[2]) or before[3] != 0 or before[5] != 1):
        return False
    target = os.readlink(path)
    require_identity(path, before)
    return target == "/dev/null"


def guard_uninstall(tree, home, env, workspace, instance, unit_directory="/etc/systemd/system", control_home=None):
    preserved = {"CODEX_HOME": home, "ENV_FILE": env, "CODEX_WORKSPACE": workspace}
    if control_home:
        preserved["GATEWAY_CONTROL_HOME"] = control_home
    for index, project in enumerate(registered_projects(home)):
        preserved[f"registered project {index + 1}"] = project
    directory = Path(unit_directory)
    # scandir is intentional: a denied inventory must not silently become an
    # empty glob. Read all gateway units, including custom SERVICE_NAME values.
    for entry in directory.iterdir():
        if not entry.name.endswith(".service") or entry.name == instance + ".service":
            continue
        if masked_unit(entry):
            continue
        try:
            # Unit aliases can legitimately be root-owned symlinks.  Pin the
            # resolved regular inode, but never materialize an unbounded unit.
            text = read_text_bounded(entry, MAX_SYSTEM_UNIT_BYTES, nofollow=False)
        except FileNotFoundError:
            if entry.is_symlink():
                raise ValueError(f"cannot inspect service alias: {entry}") from None
            raise
        if not re.search(r"^WorkingDirectory=.*?/apps/gateway\s*$", text, re.M):
            continue
        values = {}
        for key in ("CODEX_HOME", "ENV_FILE", "CODEX_WORKSPACE"):
            matches = re.findall(r"^Environment=" + key + r"=(.+)$", text, re.M)
            if len(matches) != 1 or not Path(matches[0]).is_absolute():
                raise ValueError(f"cannot reliably inventory {key} for {entry}")
            values[key] = matches[0]
            preserved[f"{entry.name} {key}"] = matches[0]
        roots = re.findall(r"^WorkingDirectory=(.+)/apps/gateway\s*$", text, re.M)
        if len(roots) != 1:
            raise ValueError(f"cannot reliably inventory program directory for {entry}")
        preserved[f"{entry.name} program directory"] = roots[0]
        controls = re.findall(r"^Environment=GATEWAY_CONTROL_HOME=(.+)$", text, re.M)
        if len(controls) > 1 or (controls and not Path(controls[0]).is_absolute()):
            raise ValueError(f"cannot reliably inventory control directory for {entry}")
        if controls:
            preserved[f"{entry.name} control directory"] = controls[0]
        for index, project in enumerate(registered_projects(values["CODEX_HOME"])):
            preserved[f"{entry.name} project {index + 1}"] = project
    return guard_delete(tree, preserved)


def atomic_text(path, content, expected=_CAPTURE_CURRENT):
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("atomic configuration path must be absolute without traversal")
    if expected is _CAPTURE_CURRENT:
        expected = file_identity(path)
    require_identity(path, expected)
    previous = os.lstat(path) if expected is not None else None
    if previous is not None and not stat.S_ISREG(previous.st_mode):
        raise ValueError("atomic configuration target must be a regular file")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(fd, stat.S_IMODE(previous.st_mode) if previous else 0o644)
        if previous and hasattr(os, "fchown"):
            os.fchown(fd, previous.st_uid, previous.st_gid)
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        require_identity(path, expected)
        if expected is None:
            # A hard-link commit is the portable no-overwrite primitive for a
            # new file in the same directory.  A concurrently created target
            # fails rather than being silently replaced.
            os.link(temporary, path, follow_symlinks=False)
            os.unlink(temporary)
        else:
            os.replace(temporary, path)
        if os.name != "nt":
            directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def blocks(text):
    """Validate marker topology before returning opaque, lossless text chunks."""
    chunks, plain, current, marker = [], [], None, None
    for line in text.splitlines(keepends=True):
        stripped = line.strip()
        if stripped.startswith("# codex-harness:begin "):
            if current is not None:
                raise ValueError("nested codex-harness marker")
            chunks.append((None, "".join(plain)))
            plain = []
            marker = stripped.removeprefix("# codex-harness:begin ")
            if len(marker.split()) not in (1, 2):
                raise ValueError("invalid codex-harness marker")
            current = [line]
        elif stripped.startswith("# codex-harness:end "):
            if current is None or stripped.removeprefix("# codex-harness:end ") != marker:
                raise ValueError("unmatched codex-harness marker")
            current.append(line)
            chunks.append((marker, "".join(current)))
            current = None
        elif current is not None:
            current.append(line)
        else:
            plain.append(line)
    if current is not None:
        raise ValueError("unterminated codex-harness marker")
    chunks.append((None, "".join(plain)))
    return chunks


def owns(marker, body, instance, port):
    if marker is None:
        return False
    parts = marker.split()
    if len(parts) == 2:
        return parts[0] == instance
    # Old releases only recorded the public host. Adopt a legacy block only
    # when its literal gateway upstream matches this installed instance.
    upstreams = re.findall(r"^\s*reverse_proxy\s+127\.0\.0\.1:(\d+)(?:\s|$)", body, re.M)
    return str(port) in upstreams


def edit_edge(text, instance, port, host=None, replacement=None):
    chunks = blocks(text)
    output, changed = [], False
    for marker, body in chunks:
        if owns(marker, body, instance, port) and (host is None or marker.split()[-1] == host):
            if host is not None:
                if changed:
                    raise ValueError("duplicate target site")
                output.append(replacement)
            changed = True
        else:
            if host is not None and marker and marker.split()[-1] == host:
                raise ValueError(f"site {host} belongs to another instance")
            output.append(body)
    if host is not None and not changed:
        output.extend(["\n", replacement])
    return "".join(output)


def edge_hosts(text, instance=None, port=None, auth=None):
    result = []
    for marker, body in blocks(text):
        if marker is None:
            continue
        if instance is not None and not owns(marker, body, instance, port):
            continue
        if auth is not None and not re.search(r"^\s*forward_auth\s+" + re.escape(auth) + r"\s*\{", body, re.M):
            continue
        host = marker.split()[-1]
        if host not in result:
            result.append(host)
    return result


def auth_origin(value):
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path != "/authelia/"):
        raise ValueError("Authelia canonical URL must be https://host[:port]/authelia/")
    return parsed.hostname.lower(), parsed.port or 443


def _cookie_layout(text):
    lines = text.splitlines(keepends=True)
    starts = [i for i, line in enumerate(lines) if re.match(r"^session:\s*(?:#.*)?$", line.rstrip())]
    if len(starts) != 1:
        raise ValueError("cannot locate a unique session section in Authelia configuration")
    start = starts[0]
    end = next((i for i in range(start + 1, len(lines)) if re.match(r"^[A-Za-z_][\w-]*:", lines[i])), len(lines))
    cookie = next((i for i in range(start + 1, end) if re.match(r"^  cookies:\s*(?:#.*)?$", lines[i].rstrip())), None)
    if cookie is None:
        raise ValueError("session.cookies must be configured before this edge can be activated")
    cookie_end = next((i for i in range(cookie + 1, end) if lines[i].strip() and not lines[i].lstrip().startswith("#") and len(lines[i]) - len(lines[i].lstrip()) <= 2), end)
    entries = []
    for i in range(cookie + 1, cookie_end):
        match = re.match(r"^    - domain:\s*['\"]?([A-Za-z0-9.-]+)['\"]?\s*(?:#.*)?$", lines[i].rstrip())
        if match:
            entries.append((i, match.group(1).lower()))
        elif re.match(r"^\s*-\s*\S", lines[i]):
            raise ValueError("complex session.cookies requires manual Authelia integration")
    if not entries:
        raise ValueError("cannot verify simple Authelia session.cookies entries")
    return lines, cookie_end, entries


def _cookie_url(lines, entry_start, entry_end):
    urls = [(i, re.match(r"^(      authelia_url:\s*)['\"]?(https://[^\s'\"]+)['\"]?(\s*(?:#.*)?)$", lines[i].rstrip()))
            for i in range(entry_start + 1, entry_end) if re.match(r"^      authelia_url:", lines[i])]
    if len(urls) != 1 or urls[0][1] is None:
        raise ValueError("cannot verify Authelia canonical URL; configure a scalar authelia_url")
    line_index, match = urls[0]
    return line_index, match, auth_origin(match.group(2))


def guard_edge_removal(text, authentication, instance, port, auth):
    """Refuse removal of a portal still used by a retained shared cookie."""
    remaining = edit_edge(text, instance, port)
    old_hosts = edge_hosts(text, auth=auth)
    hosts = edge_hosts(remaining, auth=auth)
    origins = lambda values: {auth_origin("https://" + host + "/authelia/") for host in values}
    removed = origins(old_hosts) - origins(hosts)
    # Unmarked routes and imports may have consumers outside our inventory.
    # Preserve their known canonical portal rather than guessing their domains.
    unmarked = "".join(body for marker, body in blocks(remaining) if marker is None)
    unknown_consumers = bool(re.search(r"^\s*import\s", remaining, re.M)
                             or re.search(r"^\s*forward_auth\s+" + re.escape(auth) + r"\s*\{", unmarked, re.M))
    if not removed or (not hosts and not unknown_consumers):
        return
    lines, cookie_end, entries = _cookie_layout(authentication)
    domains = [auth_origin("https://" + host + "/authelia/")[0] for host in hosts]
    for index, (entry_start, domain) in enumerate(entries):
        if not unknown_consumers and not any(host == domain or host.endswith("." + domain) for host in domains):
            continue
        entry_end = entries[index + 1][0] if index + 1 < len(entries) else cookie_end
        _line_index, _match, origin = _cookie_url(lines, entry_start, entry_end)
        if origin in removed:
            raise ValueError("cannot remove a shared Authelia login portal; migrate session.cookies.authelia_url for the retained sites first")


def sync_cookies(text, hosts, owned, verified_urls=()):
    """Edit only the cookie list in a project-owned generated YAML config.

    External config is never rewritten. Its simple scalar cookie domains are
    checked; YAML aliases/complex unsupported forms require manual integration.
    """
    lines, cookie_end, entries = _cookie_layout(text)
    # A canonical login portal may serve several sites. Retain it if its
    # origin is still routed to this Authelia, or the operator has verified an
    # external canonical portal. Domain coverage alone says nothing about its
    # port still being served after a migration.
    routes = {auth_origin("https://" + host + "/authelia/") for host in hosts if host}
    verified = {auth_origin(value) for value in verified_urls}
    domains = [domain for _, domain in entries]
    for index, (entry_start, domain) in enumerate(entries):
        candidates = [host for host in hosts if auth_origin("https://" + host + "/authelia/")[0] == domain
                      or auth_origin("https://" + host + "/authelia/")[0].endswith("." + domain)]
        if not candidates:
            continue
        entry_end = entries[index + 1][0] if index + 1 < len(entries) else cookie_end
        line_index, match, origin = _cookie_url(lines, entry_start, entry_end)
        if origin in routes or origin in verified:
            continue
        if not owned:
            raise ValueError("external Authelia canonical URL is not a known active ingress; verify it with AUTHELIA_CANONICAL_URL or update session.cookies.authelia_url")
        # Only reconcile the generated same-host portal automatically. A
        # shared portal on another host needs an explicit verified canonical
        # URL, even in an otherwise project-owned configuration.
        replacement = next((host for host in candidates if auth_origin("https://" + host + "/authelia/")[0] == origin[0]), None)
        if replacement is None:
            raise ValueError("shared Authelia canonical URL needs verification via AUTHELIA_CANONICAL_URL")
        lines[line_index] = match.group(1) + "https://" + replacement + "/authelia/" + match.group(3) + "\n"
    missing = []
    for host in hosts:
        domain = host.rsplit(":", 1)[0].lower()
        if not any(domain == old or domain.endswith("." + old) for old in domains):
            missing.append((domain, host))
            domains.append(domain)
    if missing and not owned:
        raise ValueError("external Authelia session.cookies does not cover: " + ", ".join(domain for domain, _ in missing))
    additions = []
    for domain, host in missing:
        additions.extend([f"    - domain: {domain}\n", f"      authelia_url: https://{host}/authelia/\n"])
    return "".join(lines[:cookie_end] + additions + lines[cookie_end:])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["provider", "guard-delete", "guard-uninstall", "guard-edge-removal", "remove", "upsert", "hosts", "auth-hosts", "auth-in-use", "cookies"])
    parser.add_argument("args", nargs="+")
    action, args = vars(parser.parse_args()).values()
    if action == "provider":
        print(provider_label(args[0]))
        return
    if action == "guard-delete":
        tree, home, env, workspace = args
        print(guard_delete(tree, {"CODEX_HOME": home, "ENV_FILE": env, "CODEX_WORKSPACE": workspace}))
        return
    if action == "guard-uninstall":
        print(guard_uninstall(*args))
        return
    path = Path(args[0])
    expected = file_identity(path)
    text = read_text_bounded(path, MAX_EDGE_CONFIG_BYTES, missing_ok=True)
    if action == "guard-edge-removal":
        instance, port, auth, configuration = args[1:]
        authentication = read_text_bounded(configuration, MAX_EDGE_CONFIG_BYTES, missing_ok=True)
        guard_edge_removal(text, authentication, instance, port, auth)
        return
    if action == "cookies":
        owned, *hosts = args[1:]
        canonical = os.environ.get("AUTHELIA_VERIFIED_CANONICAL_URL", "")
        updated = sync_cookies(text, hosts, owned == "owned", [canonical] if canonical else [])
    elif action == "auth-in-use":
        referenced = re.search(r"^\s*forward_auth\s+" + re.escape(args[1]) + r"\s*\{", text, re.M)
        # Imported Caddy fragments may contain other users of this service.
        print("yes" if referenced or re.search(r"^\s*import\s", text, re.M) else "")
        return
    elif action == "auth-hosts":
        print("\n".join(edge_hosts(text, auth=args[1])))
        return
    else:
        instance, port = args[1:3]
        if action == "hosts":
            print("\n".join(edge_hosts(text, instance, port)))
            return
        if action == "remove":
            updated = edit_edge(text, instance, port)
        else:
            host, replacement_path = args[3:]
            replacement = read_text_bounded(replacement_path, MAX_EDGE_REPLACEMENT_BYTES)
            updated = edit_edge(text, instance, port, host, replacement)
    if updated != text:
        atomic_text(path, updated, expected)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, RuntimeError) as error:
        raise SystemExit(str(error)) from error
