"""Offline regression fixtures. No system services, Git changes, or model calls."""
import contextlib
import io
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / "deploy"))
sys.path.insert(0, str(ROOT / "deploy/providers"))
import lifecycle
import provider_transaction as transaction


def shell_function(source, name, indent="      "):
    match = re.search(r"(?ms)^" + re.escape(indent + name) + r"\(\) \{\n.*?^" + re.escape(indent) + r"\}", source)
    if match is None:
        raise AssertionError("missing real shell function " + name)
    return match.group(0)


@unittest.skipUnless(sys.platform == "linux", "Linux shell fixtures required")
class UpdateRollbackTests(unittest.TestCase):
    def run_rollback(self, state="inactive", status=3, stop_status=0, was_active=1, failure=""):
        source = (ROOT / "deploy/manage.sh").read_text(encoding="utf-8")
        script = r'''set -euo pipefail
log() { printf 'LOG %s\n' "$*"; }
git() { printf 'GIT %s\n' "$*"; [ "$FIXTURE_FAILURE" != reset ]; }
rm() { printf 'REMOVE %s\n' "$*"; [ "$FIXTURE_FAILURE" != remove ]; }
cp() { printf 'COPY %s\n' "$*"; [ "$FIXTURE_FAILURE" != copy ]; }
mkdir() { [ "$FIXTURE_FAILURE" != mkdir ]; }
python3() { printf 'RUNTIME %s\n' "$*"; }
systemctl() {
  if [ "$1" = is-active ]; then printf '%s\n' "$FIXTURE_STATE"; return "$FIXTURE_STATE_STATUS"; fi
  printf 'SYSTEMCTL %s\n' "$*"
  if [ "$1" = stop ]; then return "$FIXTURE_STOP_STATUS"; fi
  [ "$1" != "$FIXTURE_FAILURE" ]
}
health_after_update() { printf 'HEALTH\n'; [ "$FIXTURE_FAILURE" != health ]; }
applying=1; was_active=$FIXTURE_WAS_ACTIVE; runtime_created=1
REPO_ROOT=/fixture/repo; local_ref=old; snapshot=$FIXTURE_SNAPSHOT
stage=/fixture/stage; stage_root=/fixture/root; SERVICE_NAME=fixture
trusted_apply=/fixture/trusted; runtime_base=/fixture/runtime
candidate_version=1.2.3; runtime_fingerprint=synthetic
artifacts=(apps/gateway/dist apps/web/dist)
system_files=(/fixture/unit /fixture/admin-helper)
'''
        script += shell_function(source, "stop_update_service") + "\n"
        script += shell_function(source, "cleanup_update_stage") + "\ntrap cleanup_update_stage EXIT\nexit 23\n"
        with tempfile.TemporaryDirectory(prefix="harness-rollback-events-") as directory:
            snapshot = Path(directory) / "snapshot"
            for item in ("artifacts/apps/gateway/dist", "artifacts/apps/web/dist", "system/fixture"):
                (snapshot / item).mkdir(parents=True)
            (snapshot / "system/fixture/unit").write_text("saved unit\n", encoding="utf-8")
            result = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=5,
                                    env={**os.environ, "FIXTURE_STATE": state, "FIXTURE_STATE_STATUS": str(status),
                                         "FIXTURE_STOP_STATUS": str(stop_status), "FIXTURE_WAS_ACTIVE": str(was_active),
                                         "FIXTURE_FAILURE": failure, "FIXTURE_SNAPSHOT": str(snapshot)})
            self.assertEqual(result.returncode, 23, result.stdout + result.stderr)
            self.assertEqual((snapshot / "system/fixture/unit").read_text(encoding="utf-8"), "saved unit\n")
            return result.stdout.replace(str(snapshot), "/fixture/snapshot").splitlines()

    def test_unconfirmed_stop_preserves_files_and_recovery(self):
        for state, status, stop in (("active", 0, 1), ("deactivating", 3, 1), ("", 1, 1), ("active", 0, 0)):
            with self.subTest(state=state, status=status, stop=stop):
                events = self.run_rollback(state, status, stop)
                self.assertIn("SYSTEMCTL stop fixture", events)
                self.assertFalse(any(line.startswith(("GIT ", "REMOVE ", "COPY ", "RUNTIME ")) for line in events), events)
                self.assertFalse(any(line == "SYSTEMCTL restart fixture" for line in events), events)
                self.assertTrue(any("/fixture/snapshot" in line for line in events), events)

    def test_confirmed_stop_precedes_all_rollback_mutations(self):
        for state, status, stop in (("inactive", 3, 0), ("inactive", 3, 1), ("failed", 3, 1), ("unknown", 4, 1)):
            with self.subTest(state=state, stop=stop):
                events = self.run_rollback(state, status, stop)
                stopped = events.index("SYSTEMCTL stop fixture")
                reset = next(i for i, event in enumerate(events) if "reset --hard" in event)
                self.assertLess(stopped, reset, events)
                self.assertIn("SYSTEMCTL restart fixture", events)
                self.assertTrue(any(line.startswith("RUNTIME ") for line in events), events)

    def assert_recovery_materials_retained(self, events):
        self.assertFalse(any(line.startswith("RUNTIME ") for line in events), events)
        self.assertNotIn("REMOVE -rf -- /fixture/root", events)
        self.assertFalse(any("worktree remove" in line for line in events), events)
        self.assertTrue(any(line.startswith("LOG ") and "自动恢复未完成" in line
                            and "/fixture/snapshot" in line for line in events), events)

    def test_failed_file_restore_or_reload_never_restarts_partial_service(self):
        for failure in ("reset", "copy", "remove", "mkdir", "daemon-reload"):
            with self.subTest(failure=failure):
                events = self.run_rollback(failure=failure)
                self.assertIn("SYSTEMCTL stop fixture", events)
                self.assertTrue(any("reset --hard" in line for line in events), events)
                if failure == "copy":
                    self.assertTrue(any(line.startswith("COPY ") for line in events), events)
                if failure == "daemon-reload":
                    self.assertIn("SYSTEMCTL daemon-reload", events)
                else:
                    self.assertNotIn("SYSTEMCTL daemon-reload", events)
                self.assertNotIn("SYSTEMCTL restart fixture", events)
                self.assertNotIn("HEALTH", events)
                self.assert_recovery_materials_retained(events)

    def test_failed_service_recovery_retains_runtime_and_snapshot(self):
        for failure in ("restart", "health"):
            with self.subTest(failure=failure):
                events = self.run_rollback(failure=failure)
                self.assertIn("SYSTEMCTL daemon-reload", events)
                self.assertIn("SYSTEMCTL restart fixture", events)
                self.assertEqual("HEALTH" in events, failure == "health", events)
                self.assert_recovery_materials_retained(events)

    def test_initial_stop_failure_does_not_arm_publication_rollback(self):
        source = (ROOT / "deploy/manage.sh").read_text(encoding="utf-8")
        start = source.index('      systemctl is-active --quiet "$SERVICE_NAME" && was_active=1')
        end = source.index('      git -C "$REPO_ROOT" merge --ff-only', start)
        script = r'''set -euo pipefail
applying=0; was_active=0; SERVICE_NAME=fixture
log() { :; }
die() { exit 19; }
systemctl() {
  if [ "$1" = stop ]; then return 1; fi
  if [ "${2:-}" != --quiet ]; then printf 'active\n'; fi
  return 0
}
trap 'printf "APPLYING=%s\n" "$applying"' EXIT
'''
        script += shell_function(source, "stop_update_service") + "\n" + source[start:end]
        result = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 19, result.stderr)
        self.assertEqual(result.stdout.strip(), "APPLYING=0")


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() != 0, "Unprivileged Linux filesystem fixtures required")
class ProviderRetentionTests(unittest.TestCase):
    def test_repeated_failed_switches_preserve_immediate_recovery_and_bound_history(self):
        with tempfile.TemporaryDirectory(prefix="harness-retention-regression-") as directory:
            base = Path(directory)
            home = base / "home"
            home.mkdir(mode=0o700)
            environment = {"HOME": str(base), "CODEX_HOME": str(home), "ENV_FILE": str(home / "secrets.env"),
                           "PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1", "LANG": "C.UTF-8"}
            with patch.dict(os.environ, environment, clear=True), contextlib.redirect_stdout(io.StringIO()):
                command = [str(ROOT / "deploy/providers/openai/setup.sh")]
                self.assertEqual(transaction.execute("openai", command), 0)
                stable = transaction.active_generation_name()
                versions = home / "providers/.versions"
                for attempt in range(1, 7):
                    candidate = "generation-" + format(attempt, "032x")
                    os.environ.update(PROVIDER_EXPECTED_ACTIVE=stable, PROVIDER_NEW_GENERATION=candidate)
                    self.assertEqual(transaction.execute("openai", command), 0)
                    self.assertTrue((versions / stable).is_dir())
                    self.assertLessEqual(len(list(versions.iterdir())), 1 + transaction.DEFAULT_GENERATION_HISTORY)
                    self.assertEqual(transaction.restore_generation(stable, candidate), 0)
                    self.assertEqual(transaction.active_generation_name(), stable)

    def test_zero_history_keeps_predecessor_and_invalid_metadata_cannot_trigger_pruning(self):
        with tempfile.TemporaryDirectory(prefix="harness-retention-metadata-") as directory:
            base = Path(directory)
            home = base / "home"
            home.mkdir(mode=0o700)
            environment = {"HOME": str(base), "CODEX_HOME": str(home), "ENV_FILE": str(home / "secrets.env"),
                           "PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"}
            with patch.dict(os.environ, environment, clear=True), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(transaction.execute("openai", [str(ROOT / "deploy/providers/openai/setup.sh")]), 0)
                versions = home / "providers/.versions"
                active = transaction.active_generation_name()
                previous = transaction.predecessor_generation_name(active)
                transaction.prune_generations(versions, home / "providers/.active", keep_history=0)
                self.assertEqual({path.name for path in versions.iterdir()}, {active, previous})
                metadata = versions / active / transaction.PREVIOUS_GENERATION_FILE
                for content in (b"../outside\n", b"generation-missing\n", b"\xff\n"):
                    metadata.write_bytes(content)
                    with self.assertRaises((ValueError, OSError, RuntimeError)):
                        transaction.prune_generations(versions, home / "providers/.active", keep_history=0)
                    self.assertEqual({path.name for path in versions.iterdir()}, {active, previous})


class SharedPortalTests(unittest.TestCase):
    @staticmethod
    def site(instance, domain, port):
        return (f"# codex-harness:begin {instance} {domain}:443\nhttps://{domain}:443 {{\n"
                "  forward_auth 127.0.0.1:9091 { uri /authelia/api/authz/forward-auth }\n"
                f"  reverse_proxy 127.0.0.1:{port}\n}}\n# codex-harness:end {instance} {domain}:443\n")

    def setUp(self):
        self.caddy = self.site("instance-a", "example.com", 8080) + self.site("instance-b", "sub.example.com", 8081)
        self.auth = ("session:\n  secret: fixture-only\n  cookies:\n    - domain: example.com\n"
                     "      authelia_url: https://example.com:443/authelia/\n")

    def guard(self, caddy=None, auth=None, instance="instance-a", port="8080"):
        return lifecycle.guard_edge_removal(self.caddy if caddy is None else caddy,
                                            self.auth if auth is None else auth, instance, port, "127.0.0.1:9091")

    def test_shared_parent_domain_portal_cannot_be_removed(self):
        self.assertEqual(lifecycle.sync_cookies(self.auth, ["example.com:443", "sub.example.com:443"], True), self.auth)
        with self.assertRaisesRegex(ValueError, "shared Authelia login portal"):
            self.guard()

    def test_migrated_or_external_portal_allows_removing_old_site(self):
        for portal in ("sub.example.com:443", "login.example.com:443"):
            with self.subTest(portal=portal):
                self.guard(auth=self.auth.replace("https://example.com:443/", "https://" + portal + "/"))
        self.guard(instance="instance-b", port="8081")
        self.guard(caddy=self.site("instance-a", "example.com", 8080), auth="")
        self.guard(instance="unregistered", port="9999", auth="")

    def test_independent_cookie_does_not_block_other_instance_removal(self):
        auth = (self.auth + "    - domain: other.example.org\n"
                "      authelia_url: https://other.example.org:443/authelia/\n")
        caddy = self.site("instance-a", "example.com", 8080) + self.site("instance-b", "other.example.org", 8081)
        self.guard(caddy=caddy, auth=auth)

    def test_imports_unmarked_consumers_and_unreadable_policy_fail_closed(self):
        for suffix in ("import other-sites/*\n", "other.example.com {\n  forward_auth 127.0.0.1:9091 { uri /authelia/api/authz/forward-auth }\n}\n"):
            with self.subTest(suffix=suffix), self.assertRaisesRegex(ValueError, "shared Authelia login portal"):
                self.guard(caddy=self.site("instance-a", "example.com", 8080) + suffix)
        with self.assertRaises(ValueError):
            self.guard(auth="")

    def test_cli_guard_rejects_without_changing_any_file(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            caddy, auth = base / "Caddyfile", base / "configuration.yml"
            caddy.write_text(self.caddy)
            auth.write_text(self.auth)
            result = subprocess.run([sys.executable, "-I", str(ROOT / "deploy/lifecycle.py"), "guard-edge-removal",
                                     str(caddy), "instance-a", "8080", "127.0.0.1:9091", str(auth)],
                                    capture_output=True, text=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("shared Authelia login portal", result.stderr)
            self.assertEqual(caddy.read_text(), self.caddy)
            self.assertEqual(auth.read_text(), self.auth)

    def test_disable_checks_dependencies_before_any_backup_or_publication(self):
        source = (ROOT / "deploy/setup-edge.sh").read_text(encoding="utf-8")
        branch = source.split('if [ "${EDGE_ACTION:-}" = "disable" ]; then', 1)[1].split('\nrandom_hex()', 1)[0]
        self.assertLess(branch.index("guard-edge-removal"), branch.index('DISABLE_BACKUP="$(mktemp -d)"'))
        self.assertLess(branch.index("guard-edge-removal"), branch.index('"$SCRIPT_DIR/lifecycle.py" remove'))
        # Both maintenance deletion flows must use this same protected entry.
        manage = (ROOT / "deploy/manage.sh").read_text(encoding="utf-8")
        for name, end in (("do_reinstall", "do_uninstall"), ("do_uninstall", "health_after_update")):
            block = manage.split(name + "() {", 1)[1].split(end + "() {", 1)[0]
            self.assertIn("EDGE_ACTION=disable EDGE_GATEWAY_STOPPED=1", block)


if __name__ == "__main__":
    unittest.main()
