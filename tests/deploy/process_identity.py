"""Linux fixture observations bind a process to its birth, not a reusable PID."""
from pathlib import Path


def process_start(pid: int) -> str | None:
    try:
        return Path('/proc', str(pid), 'stat').read_text().rsplit(')', 1)[1].split()[19]
    except (FileNotFoundError, ProcessLookupError):
        return None


def same_process(pid: int, start: str) -> bool:
    return process_start(pid) == start
