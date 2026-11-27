"""Validate an exact private candidate before publishing sudo policy."""
from __future__ import annotations
import os
import uuid
from .common import atomic_write, fsync_directory
from .system import run


def publish(path, data, mode=0o440):
    candidate = path.parent / (".codex-harness-sudo-" + uuid.uuid4().hex)
    try:
        atomic_write(candidate, data, mode)
        run(["/usr/sbin/visudo", "-cf", str(candidate)])
        os.replace(candidate, path)
        fsync_directory(path.parent)
        run(["/usr/sbin/visudo", "-cf", str(path)])
    finally:
        if candidate.exists():
            candidate.unlink()
            fsync_directory(candidate.parent)
