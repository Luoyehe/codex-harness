"""Actual Linux process cleanup acknowledgements; no model or network calls."""
from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest


@unittest.skipUnless(sys.platform == "linux", "Linux subreaper and service signals")
class NativeShutdownTests(unittest.TestCase):
    def run_case(self, mode: str) -> tuple[int, list[int]]:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            marker = root / "ready.json"
            fixture = root / "native.py"
            fixture.write_text(
                "import json,os,signal,subprocess,sys,time\nfrom pathlib import Path\n"
                "def ready(pids):\n identities=[{'pid':pid,'start':Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[19]} for pid in pids]\n marker=Path(sys.argv[1]); temporary=marker.with_suffix('.tmp'); temporary.write_text(json.dumps(identities)); temporary.replace(marker)\n"
                "if sys.argv[2] == 'crash':\n ready([os.getpid()])\n time.sleep(.2)\n sys.exit(17)\n"
                "child=subprocess.Popen([sys.executable,'-c','import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(60)'],start_new_session=True)\n"
                "signal.signal(signal.SIGTERM,signal.SIG_IGN)\n"
                "ready([os.getpid(),child.pid])\n"
                "time.sleep(60)\n", encoding="utf-8")
            driver = (
                "from deploy import native_launcher as n\nimport sys\n"
                "n.security_process()\n"
                "if sys.argv[3] == 'unconfirmed':\n original=n.clean_children\n n.clean_children=lambda child,deadline: (original(child,deadline) and False)\n"
                "raise SystemExit(n.supervise([sys.executable,sys.argv[1],sys.argv[2],sys.argv[3]],{'PATH':'/usr/bin:/bin'},sys.argv[4],streaming=True))\n"
            )
            command = [sys.executable, "-c", driver, str(fixture), str(marker), mode, str(root)]
            if os.geteuid() == 0:
                command = ["/usr/bin/setpriv", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", *command]
            child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            pids = []; handles = {}
            try:
                deadline = time.monotonic() + 5
                while not marker.exists():
                    if child.poll() is not None or time.monotonic() >= deadline:
                        self.fail("Native shutdown fixture did not become ready")
                    time.sleep(.01)
                identities = json.loads(marker.read_text()); pids = [entry["pid"] for entry in identities]
                for entry in identities:
                    descriptor = None
                    try:
                        descriptor = os.pidfd_open(entry["pid"])
                        start = Path("/proc", str(entry["pid"]), "stat").read_text().rsplit(")", 1)[1].split()[19]
                        if start == entry["start"]:
                            handles[entry["pid"]] = descriptor; descriptor = None
                    except (ProcessLookupError, FileNotFoundError): pass
                    finally:
                        if descriptor is not None: os.close(descriptor)
                if mode == "signal":
                    child.send_signal(signal.SIGTERM)
                    # Match systemd: the supervised CLI receives the stop too.
                    if pids[0] in handles: signal.pidfd_send_signal(handles[pids[0]], signal.SIGTERM)
                elif mode != "crash":
                    child.stdin.close()
                code = child.wait(timeout=8)
                for pid in pids:
                    self.assertFalse(Path("/proc", str(pid)).exists(), "A supervised descendant survived shutdown")
                return code, pids
            finally:
                if child.poll() is None:
                    child.send_signal(signal.SIGTERM)
                    try: child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait(timeout=3)
                for descriptor in handles.values():
                    try: signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                    except ProcessLookupError: pass
                    finally: os.close(descriptor)
                for stream in (child.stdin, child.stdout, child.stderr):
                    if stream and not stream.closed: stream.close()

    def test_service_signal_acknowledges_confirmed_cleanup(self):
        self.assertEqual(self.run_case("signal")[0], 0)

    def test_eof_acknowledges_cleanup_even_when_native_ignores_eof_and_term(self):
        self.assertEqual(self.run_case("eof")[0], 0)

    def test_unrequested_native_crash_preserves_failure(self):
        self.assertEqual(self.run_case("crash")[0], 17)

    def test_unconfirmed_cleanup_cannot_acknowledge_success(self):
        self.assertNotEqual(self.run_case("unconfirmed")[0], 0)


if __name__ == "__main__":
    unittest.main()
