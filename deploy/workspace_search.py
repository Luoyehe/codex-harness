"""Literal project search with descriptor containment and explicit partial results."""
from __future__ import annotations

import os
import stat
import time

from .common import DeployError, require
from .workspace_paths import Root, read_file, relative
from .workspace_resources import location

MAX_NODES = 10000
MAX_DEPTH = 24
MAX_BYTES = 32 * 1024 * 1024
MAX_FILE = 512 * 1024
MAX_SECONDS = 3.0
RESERVED = {".git", ".harness-workspace"}


def validate(params: dict) -> None:
    require(set(params) <= {"path", "query", "mode", "caseSensitive", "limit"}, "Unsupported search option")
    relative(params.get("path", ""), empty=True)
    query = params.get("query")
    require(isinstance(query, str) and 0 < len(query.encode()) <= 512 and not any(ord(char) < 32 or ord(char) == 127 for char in query), "Search requires a nonempty single-line literal query")
    require(params.get("mode", "path") in ("path", "text"), "Search mode must be path or text")
    require(isinstance(params.get("caseSensitive", False), bool), "Invalid case-sensitive option")
    limit = params.get("limit", 100)
    require(type(limit) is int and 1 <= limit <= 100, "Search result limit must be between 1 and 100")


def search(root: Root, params: dict) -> dict:
    validate(params)
    selected = params.get("path", "")
    query = params["query"] if params.get("caseSensitive", False) else params["query"].casefold()
    mode, limit = params.get("mode", "path"), params.get("limit", 100)
    results, reasons = [], set()
    visited = skipped = read_bytes = 0
    deadline = time.monotonic() + MAX_SECONDS

    def matches(value):
        return query in (value if params.get("caseSensitive", False) else value.casefold())

    def stopped():
        if len(results) >= limit:
            reasons.add("result_limit")
        if visited >= MAX_NODES:
            reasons.add("entry_limit")
        if read_bytes >= MAX_BYTES:
            reasons.add("byte_limit")
        if time.monotonic() >= deadline:
            reasons.add("time_limit")
        return bool(reasons.intersection({"result_limit", "entry_limit", "byte_limit", "time_limit"}))

    def walk(directory, prefix, depth):
        nonlocal visited, skipped, read_bytes
        location(directory, root.path / prefix)
        if depth > MAX_DEPTH:
            reasons.add("depth_limit")
            return
        with os.scandir(directory) as entries:
            for entry in entries:
                if stopped():
                    break
                visited += 1
                if entry.name in RESERVED:
                    continue
                name = prefix + "/" + entry.name if prefix else entry.name
                try:
                    relative(name)
                    info = entry.stat(follow_symlinks=False)
                    if stat.S_ISDIR(info.st_mode):
                        child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                        try:
                            walk(child, name, depth + 1)
                        finally:
                            os.close(child)
                    elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                        if mode == "path":
                            # Verify the location before publishing a path; opening a
                            # result later performs its own fresh containment checks.
                            location(directory, root.path / prefix)
                            if matches(name):
                                results.append({"path": name})
                        elif info.st_size <= MAX_FILE:
                            if read_bytes + info.st_size > MAX_BYTES:
                                reasons.add("byte_limit")
                                break
                            child = os.open(entry.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                            try:
                                data, _ = read_file(child, min(MAX_FILE, MAX_BYTES - read_bytes))
                                location(child, root.path / name)
                            finally:
                                os.close(child)
                            read_bytes += len(data)
                            try:
                                content = data.decode("utf-8", "strict")
                            except UnicodeDecodeError:
                                skipped += 1
                                continue
                            if "\0" in content:
                                skipped += 1
                                continue
                            for number, line in enumerate(content.splitlines(), 1):
                                if stopped():
                                    break
                                if matches(line):
                                    folded = line if params.get("caseSensitive", False) else line.casefold()
                                    offset = folded.find(query)
                                    # Case folding can change character count; the
                                    # preview is context, never an exact edit range.
                                    start = max(0, min(offset, len(line)) - 80)
                                    results.append({"path": name, "line": number, "preview": line[start:start + 320]})
                        else:
                            skipped += 1
                    else:
                        skipped += 1
                except (OSError, DeployError, UnicodeError):
                    skipped += 1
        location(directory, root.path / prefix)

    with root.directory(selected) as directory:
        walk(directory, selected, 0)
    location(root.fd, root.path)
    if skipped:
        reasons.add("unsupported_or_changed_entries")
    return {"path": selected, "query": params["query"], "mode": mode, "matches": results,
            "complete": not reasons, "reasons": sorted(reasons), "visitedEntries": visited,
            "readBytes": read_bytes, "skippedEntries": skipped,
            "excludedNames": sorted(RESERVED)}
