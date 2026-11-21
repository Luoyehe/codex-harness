"""Edit one user MCP server in the original native TOML document."""
from __future__ import annotations

from bisect import bisect_left
from dataclasses import dataclass, field
import re

from . import native_toml
from ._tomli import _parser as parser
from .provider_layers import equivalent, toml_value


_MISSING = object()
_QUOTE_OR_COMMENT = re.compile("""['"#]""")


def _key(path):
    return ".".join(part if part and all(c in parser.BARE_KEY_CHARS for c in part)
                    else toml_value(part) for part in path)


def _diff(path, old, new, edits, empty):
    if old is not _MISSING and new is not _MISSING and equivalent(old, new):
        return
    if isinstance(old, dict) and isinstance(new, dict):
        if not new:
            empty.add(path)
        for key in old:
            _diff(path + (key,), old[key], new.get(key, _MISSING), edits, empty)
        for key in new:
            if key not in old:
                edits[path + (key,)] = new[key]
    else:
        edits[path] = new


class _Source:
    """Tomli uses LF offsets; edits refer to slices of the original document."""

    def __init__(self, text):
        self.text = text
        self.bom = int(text.startswith("\ufeff"))
        content = text[self.bom:]
        self.crlf = [m.start() - i for i, m in enumerate(re.finditer("\r\n", content))]
        self.src = content.replace("\r\n", "\n")
        self.edits = []

    def offset(self, pos):
        return self.bom + pos + bisect_left(self.crlf, pos)

    def eol(self, pos):
        previous = self.src.rfind("\n", 0, pos)
        nearest = previous if previous >= 0 else self.src.find("\n", pos)
        if nearest == -1:
            return "\n"
        return self.text[self.offset(nearest):self.offset(nearest + 1)]

    def after_line(self, end):
        newline = self.src.find("\n", end)
        return len(self.src) if newline < 0 else newline + 1

    def preserve_comments(self, start, end, statement_line):
        # Comments inside a removed value (including multiline arrays) remain
        # standalone comments above the enclosing statement. Quoted hashes,
        # including those in multiline strings and quoted keys, are data.
        while hit := _QUOTE_OR_COMMENT.search(self.src, start, end):
            if hit[0] == "#":
                start = self.after_line(hit.start())
                self.edit(statement_line, statement_line,
                          self.text[self.offset(hit.start()):self.offset(start)])
            else:
                start, _ = parser.parse_value(self.src, hit.start(), float, 0)

    def edit(self, start, end, replacement=""):
        self.edits.append((start, end, replacement))

    def result(self):
        parts = []
        previous = 0
        for start, end, replacement in sorted(self.edits, key=lambda edit: edit[:2]):
            start, end = self.offset(start), self.offset(end)
            if previous > start:
                raise ValueError("Overlapping MCP configuration edits")
            parts.extend((self.text[previous:start], replacement))
            previous = end
        return "".join(parts) + self.text[previous:]


@dataclass
class _Scope:
    path: tuple
    insert: int
    inline: bool = False
    # One following comma (or None) and removal decision per inline member.
    members: list = field(default_factory=list)
    additions: list = field(default_factory=list)


class _Editor:
    def __init__(self, text, edits, empty):
        self.source = _Source(text)
        self.src = self.source.src
        self.edits = edits
        self.empty = empty
        self.parents = {path[:i] for path in (*edits, *empty) for i in range(len(path) + 1)}
        self.matched = set()
        self.scopes = {}

    def removed(self, path):
        return any(path[:i] in self.edits for i in range(1, len(path) + 1))

    def drop_statement(self, line, start, end):
        self.source.preserve_comments(start, end, line)
        tail = parser.skip_chars(self.src, end, parser.TOML_WS)
        if self.src[tail:tail + 1] == "#":
            self.source.edit(start, tail)
        else:
            self.source.edit(line, self.source.after_line(end))

    def pair(self, scope, start, line):
        key, value, end = native_toml._pair(self.src, start)
        path = scope.path + key
        remove = self.removed(path)
        if path in self.edits and self.edits[path] is not _MISSING:
            self.source.preserve_comments(value, end, line)
            self.source.edit(value, end, toml_value(self.edits[path]))
            self.matched.add(path)
            remove = False
        elif remove:
            if scope.inline:
                self.source.preserve_comments(start, end, line)
                self.source.edit(start, end)
            else:
                self.drop_statement(line, start, end)
        elif path in self.parents and self.src[value] == "{":
            self.inline(path, value, line)
        return end, remove

    def inline(self, path, value, line):
        scope = self.scopes[path] = _Scope(path, value + 1, inline=True)
        pos = parser.skip_comments_and_array_ws(self.src, value + 1)
        while self.src[pos] != "}":
            end, remove = self.pair(scope, pos, line)
            delimiter = parser.skip_comments_and_array_ws(self.src, end)
            comma = delimiter if self.src[delimiter] == "," else None
            scope.members.append((comma, remove))
            if comma is None:
                break
            pos = parser.skip_comments_and_array_ws(self.src, comma + 1)

    def scan(self):
        scope = self.scopes[()] = _Scope((), 0)
        pos = parser.skip_comments_and_array_ws(self.src, 0)
        while pos < len(self.src):
            line = self.src.rfind("\n", 0, pos) + 1
            if self.src[pos] == "[":
                brackets = 2 if self.src.startswith("[[", pos) else 1
                key_start = parser.skip_chars(self.src, pos + brackets, parser.TOML_WS)
                close, path = parser.parse_key(self.src, key_start)
                end = close + brackets
                scope = _Scope(path, self.source.after_line(end))
                if self.removed(path):
                    self.drop_statement(line, pos, end)
                elif path in self.parents:
                    self.scopes[path] = scope
            else:
                end, _ = self.pair(scope, pos, line)
                scope.insert = self.source.after_line(end)
            pos = parser.skip_comments_and_array_ws(self.src, end)

    def add(self, path, value):
        for length in range(len(path) - 1, -1, -1):
            if (scope := self.scopes.get(path[:length])) is not None:
                scope.additions.append(_key(path[length:]) + " = " + toml_value(value))
                return

    def finish_inline(self, scope):
        kept = [comma for comma, removed in scope.members if not removed]
        # A TOML 1.0 inline table must still parse when its last member is
        # removed. Preserve an existing TOML 1.1 trailing comma if present.
        trailing = scope.members and scope.members[-1][0] is not None
        for comma, removed in scope.members:
            if comma is not None and (removed or kept and comma == kept[-1] and not trailing):
                self.source.edit(comma, comma + 1)
        if scope.additions:
            # Put additions before existing whitespace and maintenance notes,
            # so a comment introducing an untouched member stays with it.
            pos = scope.insert
            separator = "," if self.src[pos] in parser.TOML_WS_AND_NEWLINE else ", "
            addition = ", ".join(scope.additions) + (separator if kept else "")
            self.source.edit(pos, pos, addition)

    def lines(self, pos, lines):
        newline = self.source.eol(pos)
        prefix = newline if pos and self.src[pos - 1] != "\n" else ""
        self.source.edit(pos, pos, prefix + newline.join(lines) + newline)

    def apply(self, created):
        self.scan()
        for path, value in self.edits.items():
            if value is _MISSING or path in self.matched:
                continue
            parent = self.scopes.get(path[:-1])
            if path == created and not (parent and parent.inline):
                self.lines(len(self.src), ["[" + _key(path) + "]",
                           *(_key((k,)) + " = " + toml_value(v) for k, v in value.items())])
            else:
                self.add(path, value)
        for path in sorted(self.empty):
            if path not in self.scopes:
                # A map represented solely by dotted children needs an explicit
                # empty value when its last child disappears.
                self.add(path, {})
        for scope in self.scopes.values():
            if scope.inline:
                self.finish_inline(scope)
            elif scope.additions:
                self.lines(scope.insert, scope.additions)
        return self.source.result()


def edit_server(text: str, name: str, changes: dict | None) -> str:
    """Patch specified fields. None removes a field, or the entire server."""
    original = native_toml.loads(text)
    servers = original.get("mcp_servers", {})
    if not isinstance(servers, dict) or not isinstance(name, str):
        raise ValueError("Invalid MCP server configuration")
    path = ("mcp_servers", name)
    old = servers.get(name, _MISSING)
    desired = dict(servers)
    if changes is None:
        if old is _MISSING:
            return text
        del desired[name]
        new = _MISSING
    else:
        if old is not _MISSING and not isinstance(old, dict):
            raise ValueError("MCP server must be a table")
        new = {} if old is _MISSING else old.copy()
        for key, value in changes.items():
            if value is None:
                new.pop(key, None)
            else:
                new[key] = value
        desired[name] = new

    edits, empty = {}, set()
    _diff(path, old, new, edits, empty)
    if not edits and not empty:
        return text
    result = _Editor(text, edits, empty).apply(path if old is _MISSING else None)
    actual = native_toml.loads(result)
    actual.setdefault("mcp_servers", {})
    if not equivalent(actual, {**original, "mcp_servers": desired}):
        raise ValueError("MCP configuration edit would change unrelated settings")
    return result
