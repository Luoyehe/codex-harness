"""Pure deployment decisions and atomic edge edits; no service commands."""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import tomllib
from urllib.parse import urlsplit


def provider_label(path):
    try:
        with open(path, "rb") as stream:
            config = tomllib.load(stream)
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


def atomic_text(path, content):
    path = Path(path).resolve()
    previous = path.stat() if path.exists() else None
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
        os.replace(temporary, path)
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


def sync_cookies(text, hosts, owned, verified_urls=()):
    """Edit only the cookie list in a project-owned generated YAML config.

    External config is never rewritten. Its simple scalar cookie domains are
    checked; YAML aliases/complex unsupported forms require manual integration.
    """
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
    # A canonical login portal may serve several sites. Retain it if its
    # origin is still routed to this Authelia, or the operator has verified an
    # external canonical portal. Domain coverage alone says nothing about its
    # port still being served after a migration.
    routes = {auth_origin("https://" + host + "/authelia/") for host in hosts if host}
    verified = {auth_origin(value) for value in verified_urls}
    entries = []
    for i in range(cookie + 1, cookie_end):
        match = re.match(r"^    - domain:\s*['\"]?([A-Za-z0-9.-]+)['\"]?\s*(?:#.*)?$", lines[i].rstrip())
        if match:
            entries.append((i, match.group(1).lower()))
        elif re.match(r"^\s*-\s*\S", lines[i]):
            raise ValueError("complex session.cookies requires manual Authelia integration")
    if not entries:
        raise ValueError("cannot verify simple Authelia session.cookies entries")
    domains = [domain for _, domain in entries]
    for index, (entry_start, domain) in enumerate(entries):
        candidates = [host for host in hosts if auth_origin("https://" + host + "/authelia/")[0] == domain
                      or auth_origin("https://" + host + "/authelia/")[0].endswith("." + domain)]
        if not candidates:
            continue
        entry_end = entries[index + 1][0] if index + 1 < len(entries) else cookie_end
        urls = [(i, re.match(r"^(      authelia_url:\s*)['\"]?(https://[^\s'\"]+)['\"]?(\s*(?:#.*)?)$", lines[i].rstrip()))
                for i in range(entry_start + 1, entry_end) if re.match(r"^      authelia_url:", lines[i])]
        if len(urls) != 1 or urls[0][1] is None:
            raise ValueError("cannot verify Authelia canonical URL; configure a scalar authelia_url")
        line_index, match = urls[0]
        origin = auth_origin(match.group(2))
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
    parser.add_argument("action", choices=["provider", "guard-delete", "remove", "upsert", "hosts", "auth-hosts", "auth-in-use", "cookies"])
    parser.add_argument("args", nargs="+")
    action, args = vars(parser.parse_args()).values()
    if action == "provider":
        print(provider_label(args[0]))
        return
    if action == "guard-delete":
        tree, home, env, workspace = args
        print(guard_delete(tree, {"CODEX_HOME": home, "ENV_FILE": env, "CODEX_WORKSPACE": workspace}))
        return
    path = Path(args[0])
    text = path.read_text(encoding="utf-8") if path.exists() else ""
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
            updated = edit_edge(text, instance, port, host, Path(replacement_path).read_text(encoding="utf-8"))
    if updated != text:
        atomic_text(path, updated)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        raise SystemExit(str(error)) from error
