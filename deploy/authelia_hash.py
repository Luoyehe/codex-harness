"""Feed Authelia's hidden password prompt without argv/environment disclosure."""
import errno
import fcntl
import os
import pty
import re
import select
import subprocess
import struct
import sys
import termios
import time


def generate_hash(binary, password, timeout=30):
    if not password or len(password) > 4096 or any(char < 32 or char == 127 for char in password):
        raise ValueError("password must be a nonempty single line without C0/DEL controls, at most 4096 bytes")
    master, slave = pty.openpty()
    child = None
    try:
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 120, 0, 0))
        environment = os.environ.copy()
        environment.pop("EDGE_PASS", None)
        child = subprocess.Popen(
            [binary, "crypto", "hash", "generate", "argon2", "--no-confirm"],
            stdin=slave, stdout=slave, stderr=slave, env=environment,
        )
        output = bytearray()
        sent = False
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            # Authelia/Go clears queued input while disabling terminal echo.
            # Sending earlier (e.g. printf | script) can lose the password.
            if not sent and not termios.tcgetattr(slave)[3] & termios.ECHO:
                # Go's interactive terminal uses carriage return as Enter in
                # raw mode. A line-feed byte alone does not submit the prompt.
                os.write(master, password + b"\r")
                sent = True
            readable, _, _ = select.select([master], [], [], 0.02)
            if readable:
                try:
                    chunk = os.read(master, 8192)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    chunk = b""
                output.extend(chunk)
                if len(output) > 65536:
                    raise RuntimeError("Authelia password hashing emitted excessive output")
            elif child.poll() is not None:
                break
        else:
            raise TimeoutError("Authelia password hashing timed out")
        if child.wait() != 0 or not sent:
            raise RuntimeError("Authelia password hashing failed")
        matches = re.findall(rb"\$argon2id\$[A-Za-z0-9$+/=.,_-]+", output)
        if len(matches) != 1:
            raise RuntimeError("Authelia did not return one valid Argon2id digest")
        return matches[0].decode("ascii")
    finally:
        if child is not None and child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
        os.close(slave)


if __name__ == "__main__":
    try:
        value = sys.stdin.buffer.read(4098)
        if value.endswith(b"\n"):
            value = value[:-1]
        print(generate_hash(sys.argv[1], value))
    except (OSError, ValueError, RuntimeError, TimeoutError) as error:
        raise SystemExit(str(error)) from error
