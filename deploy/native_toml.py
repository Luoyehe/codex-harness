"""Read the CLI's TOML dialect and remove migrated switches without reformatting the file."""
from __future__ import annotations

from bisect import bisect_left
import re

from . import _tomli
from ._tomli import _parser as parser
from ._tomli._re import NativeDateTime
from .common import require


def loads(text: str) -> dict:
    return _tomli.loads(text.removeprefix("\ufeff"))


def load(handle) -> dict:
    return loads(handle.read().decode("utf-8"))


def _pair(src, start):
    equals, key = parser.parse_key(src, start)
    value = parser.skip_chars(src, equals + 1, parser.TOML_WS)
    end, _ = parser.parse_value(src, value, float, 0)
    return key, value, end


def _inline_servers(src, start, names):
    pos = parser.skip_comments_and_array_ws(src, start + 1)
    members = []
    while src[pos] != "}":
        key, _, end = _pair(src, pos)
        delimiter = parser.skip_comments_and_array_ws(src, end)
        comma = delimiter if src[delimiter] == "," else None
        members.append((key[0], pos, end, comma))
        if comma is None:
            break
        pos = parser.skip_comments_and_array_ws(src, comma + 1)
    if not members:
        return
    last_kept = max((index for index, member in enumerate(members) if member[0] not in names), default=-1)
    trailing_comma = members[-1][3] is not None
    for index, (key, start, end, comma) in enumerate(members):
        if key in names:
            yield start, end
            if comma is not None:
                yield comma, comma + 1
        elif index == last_kept and comma is not None and not trailing_comma:
            yield comma, comma + 1


def _statement_span(src, start, end):
    # Keep the trailing comment on its own line, or consume the empty line.
    tail = parser.skip_chars(src, end, parser.TOML_WS)
    return src.rfind("\n", 0, start) + 1, tail + int(src[tail:tail + 1] == "\n")


def _switch_spans(src, names):
    # This walk is over a previously validated document. Use the same parser
    # for all keys and values, including unrelated multiline strings and arrays.
    header = ()
    pos = parser.skip_comments_and_array_ws(src, 0)
    while pos < len(src):
        if src[pos] == "[":
            brackets = 2 if src.startswith("[[", pos) else 1
            key_start = parser.skip_chars(src, pos + brackets, parser.TOML_WS)
            close, header = parser.parse_key(src, key_start)
            end = close + brackets
            if len(header) == 2 and header[0] == "mcp_servers" and header[1] in names:
                yield _statement_span(src, pos, end)
        else:
            key, value, end = _pair(src, pos)
            path = header + key
            if path == ("mcp_servers",):
                yield from _inline_servers(src, value, names)
            elif len(path) >= 2 and path[0] == "mcp_servers" and path[1] in names:
                yield _statement_span(src, pos, end)
        pos = parser.skip_comments_and_array_ws(src, end)


def _comments(src, start, end):
    # A removed inline table may itself contain comments. A '#' inside a
    # quoted server name is part of its key. Only boolean-only entries reach here.
    pos = start
    while pos < end:
        hit = _COMMENT_OR_QUOTE.search(src, pos, end)
        if not hit:
            break
        if hit[0] == "#":
            pos = min(parser.skip_comment(src, hit.start()) + 1, end)
            yield hit.start(), pos
        else:
            pos, _ = parser.parse_key_part(src, hit.start())


_COMMENT_OR_QUOTE = re.compile("""[#'"]""")


def remove_switches(text, names, settings):
    from .provider_layers import equivalent
    # Tomli normalizes CRLF internally. Translate its character offsets back
    # to slices of the untouched input, including mixed line endings and BOM.
    bom = int(text.startswith("\ufeff"))
    content = text[bom:]
    crlf = [match.start() - index for index, match in enumerate(re.finditer("\r\n", content))]
    src = content.replace("\r\n", "\n")
    def original(pos):
        return bom + pos + bisect_left(crlf, pos)

    parts = []
    previous = 0
    for start, end in _switch_spans(src, names):
        parts.append(text[previous:original(start)])
        parts.extend(text[original(a):original(b)] for a, b in _comments(src, start, end))
        previous = original(end)
    parts.append(text[previous:])
    result = "".join(parts)
    expected = {**settings, "mcp_servers": {k: v for k, v in settings["mcp_servers"].items() if k not in names}}
    actual = loads(result)
    actual.setdefault("mcp_servers", {})
    require(equivalent(actual, expected), "The native MCP flag could not be updated without changing unrelated settings", "config_conflict")
    return result
