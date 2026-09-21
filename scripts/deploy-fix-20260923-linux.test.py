#!/usr/bin/env python3
"""Real Linux regressions for provider rollback CAS and bounded ingress reads.

Only temporary provider homes, environment files, and locks are used. Service
commands are shell functions; no systemd, account, or production lock is touched.
Run as an unprivileged user to exercise the real provider transaction entry.
"""
import contextlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import tomllib
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
PROVIDERS = ROOT / "deploy" / "providers"
TRANSACTION = PROVIDERS / "provider_transaction.py"
OPENAI_SETUP = PROVIDERS / "openai" / "setup.sh"


@unittest.skipUnless(sys.platform.startswith("linux") and os.geteuid() != 0,
                     "Real provider setup requires an unprivileged Linux account")
class ProviderRollbackCASTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="provider-cas-regression-")
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.home = self.base / "home"
        self.home.mkdir(mode=0o700)
        self.env_file = self.home / "secrets.env"
        self.env_file.write_text("FIXTURE=retained\n", encoding="utf-8")
        self.env_file.chmod(0o600)
        self.environment = {
            key: value for key, value in os.environ.items()
            if not key.startswith(("PROVIDER_", "HARNESS_PROVIDER_", "CUSTOM_", "ZHIPU_"))
            and key not in ("PYTHONHOME", "PYTHONPATH")
        }
        self.environment.update(HOME=str(self.home), CODEX_HOME=str(self.home),
                                ENV_FILE=str(self.env_file), PYTHONDONTWRITEBYTECODE="1")

    def run_command(self, args, overrides=None, success=True):
        result = subprocess.run(args, env={**self.environment, **(overrides or {})},
                                text=True, capture_output=True, timeout=20, check=False)
        if success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def setup_provider(self, **overrides):
        return self.run_command(["bash", str(OPENAI_SETUP)], overrides)

    def transaction(self, *args, success=True):
        return self.run_command([sys.executable, "-I", str(TRANSACTION), *args], success=success)

    def active(self):
        return self.transaction("active-name").stdout.strip()

    def exercise_manage(self, scenario, migrated):
        # Each call owns a separate temporary home, including within subtests.
        self.home = self.base / f"{scenario}-{migrated}"
        self.home.mkdir(mode=0o700)
        self.env_file = self.home / "secrets.env"
        self.env_file.write_text("FIXTURE=retained\n", encoding="utf-8")
        self.env_file.chmod(0o600)
        (self.home / "config.toml").write_text('model = "legacy-fixture"\n', encoding="utf-8")
        (self.home / "config.toml").chmod(0o600)
        self.environment.update(HOME=str(self.home), CODEX_HOME=str(self.home), ENV_FILE=str(self.env_file))
        if migrated:
            self.setup_provider()
            previous = self.active()
        else:
            previous = None
        original_config = (self.home / "config.toml").read_bytes()
        original_environment = self.env_file.read_bytes()
        source = (ROOT / "deploy" / "manage.sh").read_text(encoding="utf-8")
        start = source.index("do_provider() {")
        provider_function = source[start:source.index("\ndo_edge() {", start)]
        runner = r'''set -euo pipefail
SCRIPT_DIR="$FIXTURE_REPO/deploy"
SERVICE_NAME=fixture-provider-never-a-real-unit
SERVICE_HOME="$CODEX_HOME"
need_root() { :; }
assert_instance_checkout() { :; }
die() { printf '%s\n' "$*" >&2; exit 1; }
log() { printf '%s\n' "$*"; }
active_provider() { printf 'fixture\n'; }
run_as_service() {
  if [ "$1" = bash ] && [ "$2" = "$SCRIPT_DIR/providers/openai/setup.sh" ]; then
    printf '%s\n' "$PROVIDER_NEW_GENERATION" > "$CODEX_HOME/candidate-record"
    printf '%s\n' "$PROVIDER_EXPECTED_ACTIVE" > "$CODEX_HOME/expected-record"
    if [ "$FIXTURE_SCENARIO" = setup-failure ]; then return 23; fi
  fi
  "$@"
}
publish_concurrent() {
  env -u PROVIDER_NEW_GENERATION -u PROVIDER_EXPECTED_ACTIVE bash "$SCRIPT_DIR/providers/openai/setup.sh"
  python3 -I "$SCRIPT_DIR/providers/provider_transaction.py" active-name > "$CODEX_HOME/concurrent-record"
}
restart_count=0
health_count=0
systemctl() {
  [ "$1" = restart ] && [ "$2" = "$SERVICE_NAME" ] || return 98
  restart_count=$((restart_count + 1))
  if [ "$restart_count" = 1 ]; then
    case "$FIXTURE_SCENARIO" in
      restart-failure) return 23 ;;
      concurrent-restart) publish_concurrent; return 23 ;;
    esac
  fi
}
health_after_update() {
  health_count=$((health_count + 1))
  if [ "$health_count" = 1 ]; then
    case "$FIXTURE_SCENARIO" in
      health-failure) return 24 ;;
      concurrent-health) publish_concurrent; return 24 ;;
    esac
  fi
}
@@FUNCTION@@
set +e
do_provider openai
status=$?
set -e
printf '%s %s %s\n' "$status" "$restart_count" "$health_count" > "$CODEX_HOME/result-record"
'''.replace("@@FUNCTION@@", provider_function)
        result = self.run_command(["bash", "-c", runner], {
            "FIXTURE_REPO": str(ROOT), "FIXTURE_SCENARIO": scenario,
        })
        status, restarts, health_checks = map(int, (self.home / "result-record").read_text().split())
        candidate = (self.home / "candidate-record").read_text().strip()
        self.assertRegex(candidate, r"^generation-[a-f0-9]{32}$")
        self.assertEqual((self.home / "expected-record").read_text().strip(), previous or "none")
        if scenario == "setup-failure":
            self.assertEqual((status, restarts, health_checks), (23, 0, 0))
            self.assertEqual((self.home / "config.toml").read_bytes(), original_config)
            self.assertEqual(self.env_file.read_bytes(), original_environment)
            if migrated:
                self.assertEqual(self.active(), previous)
            else:
                self.assertEqual(self.transaction("active-name", success=False).returncode, 3)
            return
        if scenario == "success":
            self.assertEqual((status, restarts, health_checks), (0, 1, 1))
            self.assertEqual(self.active(), candidate)
            return
        if scenario.startswith("concurrent-"):
            concurrent = (self.home / "concurrent-record").read_text().strip()
            self.assertNotEqual(concurrent, candidate)
            self.assertEqual(self.active(), concurrent)
            self.assertEqual(restarts, 1, "stale recovery must not restart the newer publisher")
            self.assertEqual(health_checks, 1 if scenario == "concurrent-health" else 0)
            self.assertEqual(status, 24 if scenario == "concurrent-health" else 23)
            self.assertIn("自动恢复未完成", result.stdout)
            return
        self.assertEqual(restarts, 2)
        self.assertEqual(status, 24 if scenario == "health-failure" else 23)
        self.assertEqual(health_checks, 2 if scenario == "health-failure" else 1)
        restored = self.active()
        self.assertNotEqual(restored, candidate)
        if migrated:
            self.assertEqual(restored, previous)
        else:
            predecessor = self.home / "providers" / ".versions" / candidate / ".previous-generation"
            self.assertEqual(predecessor.read_text().strip(), restored)
        if migrated:
            self.assertEqual((self.home / "config.toml").read_bytes(), original_config)
        else:
            # Legacy preservation serializes TOML and may quote bare keys.
            self.assertEqual(tomllib.loads((self.home / "config.toml").read_text()),
                             tomllib.loads(original_config.decode("utf-8")))
        self.assertEqual(self.env_file.read_bytes(), original_environment)
        self.assertIn("已恢复并验证上一代际", result.stdout)

    def test_successful_switch_keeps_its_exact_allocated_generation(self):
        for migrated in (False, True):
            with self.subTest(migrated=migrated):
                self.exercise_manage("success", migrated)

    def test_restart_and_health_failures_restore_existing_or_legacy_state(self):
        for migrated in (False, True):
            for scenario in ("restart-failure", "health-failure"):
                with self.subTest(migrated=migrated, scenario=scenario):
                    self.exercise_manage(scenario, migrated)

    def test_later_publisher_survives_stale_restart_and_health_rollback(self):
        for migrated in (False, True):
            for scenario in ("concurrent-restart", "concurrent-health"):
                with self.subTest(migrated=migrated, scenario=scenario):
                    self.exercise_manage(scenario, migrated)

    def test_setup_failure_never_restarts_or_attempts_recovery(self):
        for migrated in (False, True):
            with self.subTest(migrated=migrated):
                self.exercise_manage("setup-failure", migrated)

    def test_requested_generation_names_are_exclusive_and_cannot_escape(self):
        allocated = "generation-" + "a" * 32
        self.setup_provider(PROVIDER_NEW_GENERATION=allocated)
        versions = self.home / "providers" / ".versions"
        original_entries = sorted(path.name for path in versions.iterdir())
        original_config = (self.home / "config.toml").read_bytes()
        original_environment = self.env_file.read_bytes()
        for name in (allocated, "", "../escape", "generation-short", "generation-" + "A" * 32):
            with self.subTest(name=name):
                rejected = self.run_command(["bash", str(OPENAI_SETUP)], {"PROVIDER_NEW_GENERATION": name}, success=False)
                self.assertNotEqual(rejected.returncode, 0)
                self.assertEqual(self.active(), allocated)
                self.assertEqual(sorted(path.name for path in versions.iterdir()), original_entries)
                self.assertEqual((self.home / "config.toml").read_bytes(), original_config)
                self.assertEqual(self.env_file.read_bytes(), original_environment)
        self.assertFalse((self.home / "providers" / "escape").exists())

    def test_restore_and_predecessor_queries_compare_the_expected_active(self):
        self.setup_provider(PROVIDER_NEW_GENERATION="generation-" + "a" * 32)
        previous = self.active()
        self.setup_provider(PROVIDER_NEW_GENERATION="generation-" + "b" * 32)
        current = self.active()
        self.assertEqual(self.transaction("predecessor-name", current).stdout.strip(), previous)
        self.assertNotEqual(self.transaction("predecessor-name", previous, success=False).returncode, 0)
        rejected = self.transaction("restore-active", previous, previous, success=False)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertEqual(self.active(), current)
        self.transaction("restore-active", previous, current)
        self.assertEqual(self.active(), previous)


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux file semantics required")
class RegistrationIngressReaderTests(unittest.TestCase):
    LIMIT = 1024 * 1024

    @classmethod
    def setUpClass(cls):
        source = (ROOT / "deploy/register-service.sh").read_text(encoding="utf-8")
        match = re.search(r"<<'PY'\n(import json, os, re, shlex, stat, sys\n.*?)\nPY(?:\n|$)", source, re.S)
        if match is None:
            raise AssertionError("real registration ingress reader not found")
        cls.reader = compile(match.group(1), "register-service.sh:ingress-reader", "exec")

    def setUp(self):
        scratch = tempfile.TemporaryDirectory(prefix="registration-ingress-reader-")
        self.addCleanup(scratch.cleanup)
        self.base = Path(scratch.name)
        self.env_file = self.base / "worker.env"

    def read_ingress(self, path=None):
        output = io.StringIO()
        with patch.object(sys, "argv", ["ingress-reader", str(path or self.env_file)]), contextlib.redirect_stdout(output):
            exec(self.reader, {"__name__": "__main__"})
        return json.loads(output.getvalue())

    def write_normal(self):
        self.env_file.write_text("TRUSTED_HOSTS='fixture.example,localhost:8080'\nGATEWAY_HTTPS=true\n"
                                 "UNRELATED_SECRET=fixture-only-not-exported\n", encoding="utf-8")

    def test_missing_and_empty_files(self):
        self.assertEqual(self.read_ingress(), {})
        self.env_file.write_bytes(b"")
        self.assertEqual(self.read_ingress(), {})

    def test_normal_file_and_managed_symlink(self):
        self.write_normal()
        expected = {"TRUSTED_HOSTS": "fixture.example,localhost:8080", "GATEWAY_HTTPS": "true"}
        self.assertEqual(self.read_ingress(), expected)
        alias = self.base / "managed.env"
        alias.symlink_to(self.env_file)
        self.assertEqual(self.read_ingress(alias), expected)

    def test_limit_counts_utf8_bytes_and_accepts_exact_boundary(self):
        prefix = b"TRUSTED_HOSTS=fixture.example\n#"
        remaining = self.LIMIT - len(prefix)
        payload = prefix + "é".encode("utf-8") * (remaining // 2) + b" " * (remaining % 2)
        self.assertEqual(len(payload), self.LIMIT)
        self.env_file.write_bytes(payload)
        self.assertEqual(self.read_ingress(), {"TRUSTED_HOSTS": "fixture.example"})
        self.env_file.write_bytes(payload + b"x")
        with self.assertRaisesRegex(SystemExit, "migration limit"):
            self.read_ingress()

    def test_invalid_utf8_is_rejected(self):
        self.env_file.write_bytes(b"TRUSTED_HOSTS=fixture.example\n#\xff\n")
        with self.assertRaises(UnicodeDecodeError):
            self.read_ingress()

    def test_growth_and_truncation_after_size_check_are_rejected(self):
        for mutation in ("growth", "truncation"):
            with self.subTest(mutation=mutation):
                self.write_normal()
                real_fstat = os.fstat
                calls = 0

                def mutate_after_first_stat(fd):
                    nonlocal calls
                    snapshot = real_fstat(fd)
                    calls += 1
                    if calls == 1:
                        self.env_file.write_bytes(b"#" + b"x" * self.LIMIT if mutation == "growth" else b"")
                    return snapshot

                error = "migration limit" if mutation == "growth" else "changed during migration"
                with patch.object(os, "fstat", side_effect=mutate_after_first_stat), self.assertRaisesRegex(SystemExit, error):
                    self.read_ingress()

    def test_same_size_mutation_and_same_content_replacement_are_rejected(self):
        for mutation in ("same-size", "replacement"):
            with self.subTest(mutation=mutation):
                self.write_normal()
                before = self.env_file.stat()
                original = self.env_file.read_bytes()
                real_fstat = os.fstat
                calls = 0

                def mutate_before_second_stat(fd):
                    nonlocal calls
                    calls += 1
                    if calls == 2:
                        if mutation == "same-size":
                            changed = original.replace(b"fixture.example", b"changed.example")
                            self.assertEqual(len(changed), len(original))
                            self.env_file.write_bytes(changed)
                            os.utime(self.env_file, ns=(before.st_atime_ns, before.st_mtime_ns + 1_000_000_000))
                        else:
                            replacement = self.base / "replacement.env"
                            replacement.write_bytes(original)
                            os.utime(replacement, ns=(before.st_atime_ns, before.st_mtime_ns))
                            os.replace(replacement, self.env_file)
                    return real_fstat(fd)

                with patch.object(os, "fstat", side_effect=mutate_before_second_stat), self.assertRaisesRegex(SystemExit, "changed during migration"):
                    self.read_ingress()

    def test_invalid_ingress_values_fail_closed(self):
        for payload in ("TRUSTED_HOSTS='fixture.example;unexpected'\n", "GATEWAY_HTTPS=yes\n", "TRUSTED_HOSTS=" + "x" * 8193 + "\n"):
            with self.subTest(payload=payload[:70]):
                self.env_file.write_text(payload, encoding="utf-8")
                with self.assertRaises(SystemExit):
                    self.read_ingress()


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux FIFO, flock and timeout required")
class RegistrationIngressDeadlineTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(prefix="registration-ingress-deadline-")
        self.addCleanup(scratch.cleanup)
        self.base = Path(scratch.name)
        self.env_file = self.base / "worker.env"
        self.env_file.write_text("TRUSTED_HOSTS=fixture.example\nGATEWAY_HTTPS=true\n", encoding="utf-8")
        source = (ROOT / "deploy/register-service.sh").read_text(encoding="utf-8")
        start = source.index('INGRESS_TMP="$(mktemp ')
        self.ingress = source[start:source.index('\nTOOLS_BIN_DIR=', start)]
        self.bin = self.base / "bin"
        self.bin.mkdir()
        shim = self.bin / "runuser"
        shim.write_text("#!" + sys.executable + "\n" + r'''
import fcntl, os, pathlib, signal, subprocess, sys, time
assert sys.argv[1:4] == ["-u", "fixture-worker", "--"]
base = pathlib.Path(os.environ["FIXTURE_BASE"])
lock = base / "registration.lock"
for fd in os.listdir("/proc/self/fd"):
    try: target = os.readlink("/proc/self/fd/" + fd)
    except FileNotFoundError: continue
    if target == str(lock): raise SystemExit("reader inherited registration lock")
with lock.open("rb") as stream:
    try: fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError: pass
    else: raise SystemExit("parent stopped holding registration lock too early")
(base / "reader-lock-checked").write_text("yes")
(base / "output-path").write_text(os.readlink("/proc/self/fd/1"))
mode = os.environ["FIXTURE_MODE"]
if mode == "linger":
    child = subprocess.Popen([sys.executable, "-I", "-c",
        "import os,pathlib,time; time.sleep(1); os.write(1,b'{\"TRUSTED_HOSTS\":\"late.example\"}'); "
        "pathlib.Path(os.environ['FIXTURE_BASE'],'late-output-written').write_text('yes'); time.sleep(30)"],
        start_new_session=True, close_fds=False, stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    (base / "survivor-pid").write_text(str(child.pid))
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    time.sleep(30)
elif mode == "oversized-result":
    sys.stdout.write("x" * 65537)
else:
    os.execvp(sys.argv[4], sys.argv[4:])
''', encoding="utf-8")
        shim.chmod(0o700)
        self.environment = {**os.environ, "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
                            "RUN_USER": "fixture-worker", "ENV_FILE": str(self.env_file),
                            "FIXTURE_BASE": str(self.base), "FIXTURE_TIMEOUT": shutil.which("timeout") or "timeout",
                            "PYTHONDONTWRITEBYTECODE": "1"}

    def run_ingress(self, mode="normal"):
        script = r'''set -euo pipefail
exec {REGISTRATION_LOCK_FD}<>"$FIXTURE_BASE/registration.lock"
flock -x "$REGISTRATION_LOCK_FD"
timeout() {
  [ "$1" = --kill-after=2s ] && [ "$2" = 5s ] || return 96
  if [ "$FIXTURE_MODE" = linger ]; then
    shift 2
    command "$FIXTURE_TIMEOUT" --kill-after=0.15s 0.35s "$@"
  else
    command "$FIXTURE_TIMEOUT" "$@"
  fi
}
''' + self.ingress + '\nprintf "%s\\n" "$ingress"\nprintf completed > "$FIXTURE_BASE/completed"\n'
        started = time.monotonic()
        process = subprocess.Popen(["bash", "-c", script], env={**self.environment, "FIXTURE_MODE": mode},
                                   text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        survivor = None
        try:
            # wait() observes the registration shell itself. communicate()
            # alone could confuse a surviving pipe with shell termination.
            process.wait(timeout=3 if mode == "linger" else 8)
            elapsed = time.monotonic() - started
            if mode == "linger":
                survivor = int((self.base / "survivor-pid").read_text())
                os.kill(survivor, 0)
                import fcntl
                with (self.base / "registration.lock").open("rb") as stream:
                    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                deadline = time.monotonic() + 2
                while not (self.base / "late-output-written").exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue((self.base / "late-output-written").exists(), "fixture late output was not exercised")
            stdout, stderr = process.communicate(timeout=2)
            self.assertTrue((self.base / "reader-lock-checked").exists(), stderr)
            output = Path((self.base / "output-path").read_text())
            self.assertFalse(output.exists(), "temporary ingress output was not removed")
            return process.returncode, stdout, stderr, elapsed
        finally:
            pid_file = self.base / "survivor-pid"
            if survivor is None and pid_file.exists():
                survivor = int(pid_file.read_text())
            if survivor is not None:
                try: os.kill(survivor, signal.SIGKILL)
                except ProcessLookupError: pass
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
            process.communicate(timeout=3)

    def test_normal_and_managed_symlink_outputs_survive_the_bounded_wrapper(self):
        for symlink in (False, True):
            with self.subTest(symlink=symlink):
                if symlink:
                    target = self.base / "generation.env"
                    self.env_file.rename(target)
                    self.env_file.symlink_to(target)
                status, output, error, _ = self.run_ingress()
                self.assertEqual(status, 0, error)
                self.assertEqual(json.loads(output), {"TRUSTED_HOSTS": "fixture.example", "GATEWAY_HTTPS": "true"})
                self.assertTrue((self.base / "completed").exists())

    def test_fifo_and_nonregular_file_fail_promptly_without_a_writer(self):
        for kind in ("fifo", "directory"):
            with self.subTest(kind=kind):
                self.env_file.unlink()
                if kind == "fifo": os.mkfifo(self.env_file, 0o600)
                else: self.env_file.mkdir()
                status, output, error, elapsed = self.run_ingress()
                self.assertNotEqual(status, 0)
                self.assertIn("regular file", error)
                self.assertEqual(output, "")
                self.assertLess(elapsed, 2, "nonregular input waited for the five-second outer timeout")
                self.assertFalse((self.base / "completed").exists())

    def test_timeout_releases_parent_lock_despite_surviving_late_stdout(self):
        status, output, error, elapsed = self.run_ingress("linger")
        self.assertNotEqual(status, 0)
        self.assertIn("timed out", error)
        self.assertEqual(output, "")
        self.assertLess(elapsed, 3)
        self.assertFalse((self.base / "completed").exists())

    def test_oversized_success_result_is_rejected_and_cleaned_up(self):
        status, output, error, _ = self.run_ingress("oversized-result")
        self.assertNotEqual(status, 0)
        self.assertIn("ingress result exceeds limit", error)
        self.assertEqual(output, "")
        self.assertFalse((self.base / "completed").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
