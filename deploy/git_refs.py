"""Git check-ref-format rules for complete refs, without executing Git."""
from __future__ import annotations
from .common import require


def valid_ref(value: object, *, heads_only=False) -> str:
    require(isinstance(value, str) and 1 <= len(value.encode("utf-8")) <= 1024 and
            value.startswith("refs/heads/" if heads_only else "refs/") and
            not any(ord(c) < 33 or ord(c) == 127 or c in "~^:?*[\\" for c in value) and
            ".." not in value and "@{" not in value and not value.endswith("."),
            "Invalid Git reference", "invalid_input")
    parts = value.split("/")
    require(all(p and not p.startswith(".") and not p.endswith(".lock") for p in parts), "Invalid Git reference", "invalid_input")
    return value
