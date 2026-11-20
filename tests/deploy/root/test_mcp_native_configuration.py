"""Exercise real Codex system and user layers in a private Linux mount namespace."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]


def exercise(directory, parent_namespace):
    if os.stat("/proc/self/ns/mnt").st_ino == parent_namespace:
        raise RuntimeError("Expected a separate mount namespace")
    host_etc = directory / "host-etc"
    host_etc.mkdir()
    subprocess.run(["mount", "--bind", "/etc", str(host_etc)], check=True)
    subprocess.run(["mount", "-t", "tmpfs", "-o", "mode=755,size=4m", "tmpfs", "/etc"], check=True)
    # Keep NSS and platform configuration visible, without copying host files
    # or writing a fixture into the real host's configuration directory.
    for source in host_etc.iterdir():
        if source.name != "codex":
            (Path("/etc") / source.name).symlink_to(source)
    system = Path("/etc/codex")
    system.mkdir()
    (system / "config.toml").write_text('[mcp_servers.systemfixture]\ncommand="/bin/true"\n'
                                        '[mcp_servers.systemfixture.env]\nFIXTURE_KEY="SYSTEM_FIXTURE_PRIVATE"\n')
    (system / "harness-private-fixture").write_text(str(directory))
    node = os.environ.get("HARNESS_TEST_NODE") or shutil.which("node")
    subprocess.run([node, "tests/fixtures/mcp-system-native.mjs", str(directory)], cwd=ROOT, check=True, timeout=60)


@unittest.skipUnless(sys.platform == "linux" and getattr(os, "geteuid", lambda: -1)() == 0, "Requires a real Linux root mount namespace")
class SystemMcpNativeTests(unittest.TestCase):
    def test_switches_survive_restart_without_copying_credentials_or_breaking_other_config_writes(self):
        with tempfile.TemporaryDirectory(prefix="harness-mcp-system-") as temporary:
            subprocess.run(["unshare", "--mount", "--propagation", "private", sys.executable, __file__,
                            "private", temporary, str(os.stat("/proc/self/ns/mnt").st_ino)],
                           cwd=ROOT, check=True, timeout=75)


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "private":
        exercise(Path(sys.argv[2]), int(sys.argv[3]))
    else:
        unittest.main()
