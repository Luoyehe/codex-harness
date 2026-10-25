"""One fixed prepared HEAD/ref fence; its critical section starts no children."""
from __future__ import annotations

import contextlib
import os
import selectors
import subprocess
import time
from contextlib import contextmanager

from .common import require
from .workspace_git import GIT_ENV, GIT_PREFIX
from .workspace_git_view import directory


@contextmanager
def prepared_refs(root, paths, current, lease, environment, *, new_commit=None, hash_length=40):
    from .native_launcher import clean_children, direct_children
    metadata, common = lease.metadata, directory(paths[1])
    child = selector = None
    try:
        require(not direct_children(), "Git publication requires exclusive helper child ownership", "busy")
        env = {**GIT_ENV, **environment, "GIT_DIR": f"/proc/self/fd/{metadata}", "GIT_COMMON_DIR": f"/proc/self/fd/{common}"}
        child = subprocess.Popen([*GIT_PREFIX, "-c", "core.logAllRefUpdates=true", "update-ref", "--stdin", "-m", "harness staged operation"],
                                 cwd=f"/proc/self/fd/{root.fd}", env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 close_fds=True, pass_fds=(root.fd, metadata, common), start_new_session=True)
        lease.safe = False
        selector = selectors.DefaultSelector()
        selector.register(child.stdout, selectors.EVENT_READ, "out")
        selector.register(child.stderr, selectors.EVENT_READ, "err")
        pending, total, deadline = bytearray(), 0, time.monotonic() + 15
        def send(data):
            require(len(data) < 1024 and time.monotonic() < deadline, "Git ref transaction exceeded its bounded input or time", "timeout")
            child.stdin.write(data)
            child.stdin.flush()
        def ack(value):
            nonlocal total
            while b"\n" not in pending:
                require(time.monotonic() < deadline and selector.get_map(), "Git ref transaction did not acknowledge", "timeout")
                for key, _ in selector.select(0.1):
                    data = os.read(key.fd, 4096)
                    if not data: selector.unregister(key.fileobj)
                    total += len(data)
                    require(total <= 8192, "Git ref transaction output exceeds budget", "budget")
                    if key.data == "out": pending.extend(data)
            line, _, remainder = pending.partition(b"\n")
            pending[:] = remainder
            require(line == value + b": ok", "Invalid Git ref transaction acknowledgement", "git_unavailable")
        require(hash_length in (40, 64), "Invalid Git object format")
        old = current["head"] or "0" * (len(new_commit) if new_commit else hash_length)
        command = "update HEAD " + new_commit + " " + old if new_commit else "verify HEAD " + old
        send(("start\n" + command + "\nprepare\n").encode())
        ack(b"start")
        ack(b"prepare")
        # The caller may only inspect descriptors and publish its fixed target.
        # A separate one-shot Git child would violate cleanup ownership.
        yield
        send(b"commit\n" if new_commit else b"abort\n")
        ack(b"commit" if new_commit else b"abort")
        with contextlib.suppress(OSError): child.stdin.close()
        require(child.wait(timeout=max(0.1, deadline - time.monotonic())) == 0, "Git ref transaction failed", "git_unavailable")
    finally:
        try:
            if selector is not None: selector.close()
            if child is not None:
                if child.stdin is not None and not child.stdin.closed:
                    with contextlib.suppress(OSError): child.stdin.close()
                try:
                    lease.safe = clean_children(child, time.monotonic() + 3)
                finally:
                    with contextlib.suppress(OSError): child.stdout.close()
                    with contextlib.suppress(OSError): child.stderr.close()
        finally:
            os.close(common)
        require(lease.safe, "Git descendants did not stop; index lock retained", "cleanup_unknown")
