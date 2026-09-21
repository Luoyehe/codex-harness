#!/usr/bin/env python3
"""Linux fault-injection coverage for descriptor-confined provider generations."""
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
PROVIDERS = ROOT / "deploy" / "providers"
sys.path.insert(0, str(PROVIDERS))
import atomic_write as provider_writer
import provider_transaction as transaction


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux descriptor and fsync semantics required")
class ProviderTransactionFaultTests(unittest.TestCase):
    def make_layout(self, base):
        home = base / "home"
        providers = home / "providers"
        versions = providers / ".versions"
        versions.mkdir(parents=True, mode=0o700)
        os.chmod(home, 0o700)
        os.chmod(providers, 0o700)
        os.chmod(versions, 0o700)
        return home, providers, versions

    def make_generation(self, path):
        path.mkdir(mode=0o700)
        (path / "config.toml").write_text("", encoding="utf-8")
        (path / "secrets.env").write_text("FIXTURE=value\n", encoding="utf-8")
        os.chmod(path / "config.toml", 0o600)
        os.chmod(path / "secrets.env", 0o600)
        tree = path / "providers"
        tree.mkdir(mode=0o700)
        for mode in transaction.MODES:
            (tree / mode).mkdir(mode=0o700)

    def active_pair(self, base):
        home, providers, versions = self.make_layout(base)
        old = versions / "generation-old"
        candidate = versions / "generation-candidate"
        self.make_generation(old)
        self.make_generation(candidate)
        (providers / ".active").symlink_to(old, target_is_directory=True)
        return home, providers, versions, old, candidate

    def test_snapshot_rejects_unbounded_or_non_regular_legacy_entries(self):
        for kind in ("symlink", "hardlink", "fifo", "oversized"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                base = Path(directory)
                home = base / "home"
                source = home / "providers" / "custom"
                source.mkdir(parents=True)
                os.chmod(home / "providers", 0o700)
                (home / "config.toml").write_text("", encoding="utf-8")
                env_file = base / "secrets.env"
                env_file.write_text("FIXTURE=value\n", encoding="utf-8")
                outside = base / "outside"
                outside.write_text("keep", encoding="utf-8")
                entry = source / "entry"
                if kind == "symlink":
                    entry.symlink_to(outside)
                elif kind == "hardlink":
                    os.link(outside, entry)
                elif kind == "fifo":
                    os.mkfifo(entry, 0o600)
                else:
                    with entry.open("wb") as stream:
                        stream.truncate(transaction.MAX_SNAPSHOT_FILE_BYTES + 1)
                versions = home / "providers" / ".versions"
                with self.assertRaises((ValueError, RuntimeError)):
                    transaction.snapshot(home, env_file, versions)
                self.assertEqual(outside.read_text(encoding="utf-8"), "keep")
                self.assertEqual(list(versions.iterdir()), [])

    def test_snapshot_detects_growth_and_same_name_replacement(self):
        for mutation in ("grow", "replace"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                base = Path(directory)
                source = base / "source"
                target = base / "target"
                source.mkdir()
                target.mkdir()
                item = source / "item"
                item.write_bytes(b"original")
                source_fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY)
                target_fd = os.open(target, os.O_RDONLY | os.O_DIRECTORY)
                real_read = os.read
                changed = False

                def mutate_then_read(descriptor, amount):
                    nonlocal changed
                    if not changed:
                        changed = True
                        if mutation == "grow":
                            with item.open("ab") as stream:
                                stream.write(b"-growth")
                        else:
                            item.rename(source / "moved")
                            item.write_bytes(b"replacement")
                    return real_read(descriptor, amount)

                try:
                    with patch.object(transaction.os, "read", side_effect=mutate_then_read):
                        with self.assertRaises(RuntimeError):
                            transaction._copy_regular_at(
                                source_fd, "item", target_fd, "item",
                                transaction._new_snapshot_budget())
                    self.assertFalse((target / "item").exists())
                finally:
                    os.close(target_fd)
                    os.close(source_fd)

    def test_commit_rolls_back_candidate_replacement_and_fsync_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            _, providers, versions, old, candidate = self.active_pair(Path(directory))
            moved = versions / "moved-candidate"
            expected = os.stat(candidate, follow_symlinks=False)
            real_replace = os.replace
            injected = False

            def replace(source, destination, *args, **kwargs):
                nonlocal injected
                if (not injected and destination == ".active"
                        and str(source).startswith(".provider-link-commit-")):
                    injected = True
                    candidate.rename(moved)
                    candidate.mkdir(mode=0o700)
                return real_replace(source, destination, *args, **kwargs)

            with transaction._opened_versions(versions) as (providers_fd, versions_fd, canonical):
                with patch.object(transaction.os, "replace", side_effect=replace):
                    with self.assertRaises(RuntimeError):
                        transaction._commit_active(
                            providers_fd, versions_fd, canonical, candidate, expected)
            self.assertEqual((providers / ".active").resolve(), old.resolve())
            self.assertTrue(moved.is_dir() and candidate.is_dir())

        with tempfile.TemporaryDirectory() as directory:
            _, providers, versions, old, candidate = self.active_pair(Path(directory))
            expected = os.stat(candidate, follow_symlinks=False)
            real_fsync = os.fsync
            failed = False
            with transaction._opened_versions(versions) as (providers_fd, versions_fd, canonical):
                def fsync(descriptor):
                    nonlocal failed
                    if descriptor == providers_fd and not failed:
                        failed = True
                        raise OSError("synthetic directory fsync failure")
                    return real_fsync(descriptor)

                with patch.object(transaction.os, "fsync", side_effect=fsync):
                    with self.assertRaises(OSError):
                        transaction._commit_active(
                            providers_fd, versions_fd, canonical, candidate, expected)
            self.assertTrue(failed)
            self.assertEqual((providers / ".active").resolve(), old.resolve())

    def test_prune_isolates_poison_and_accounts_unknown_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            _, providers, versions = self.make_layout(Path(directory))
            generations = []
            for index in range(6):
                generation = versions / f"generation-{index}"
                generation.mkdir(mode=0o700)
                item = generation / "item"
                item.write_text("fixture", encoding="utf-8")
                os.chmod(item, 0o600)
                os.utime(generation, (index + 1, index + 1))
                generations.append(generation)
            os.chmod(generations[2] / "item", 0o644)
            active = providers / ".active"
            active.symlink_to(generations[0], target_is_directory=True)
            problems = []
            removed = set(transaction.prune_generations(
                versions, active, keep_history=2, problems=problems))
            self.assertEqual(removed, {"generation-1", "generation-3"})
            self.assertTrue(generations[2].is_dir())
            self.assertEqual(problems, ["unsafe"])

        with tempfile.TemporaryDirectory() as directory:
            _, _, versions = self.make_layout(Path(directory))
            unknown = versions / "operator-residue"
            with unknown.open("wb") as stream:
                stream.truncate(transaction.MAX_VERSIONS_BYTES + 1)
            with transaction._opened_versions(versions) as (_, versions_fd, _):
                with self.assertRaises(ValueError):
                    transaction._assert_versions_budget(versions_fd, reserve_generations=0)
            self.assertTrue(unknown.is_file())

    def test_publish_fsync_order_and_failure_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            home, providers, versions, _, candidate = self.active_pair(base)
            env_file = base / "service.env"
            expected = os.stat(candidate, follow_symlinks=False)
            labels = {}
            for label, path in (
                ("file", candidate / "config.toml"),
                ("leaf", candidate / "providers" / "custom"),
                ("provider-tree", candidate / "providers"),
                ("generation", candidate),
                ("versions", versions),
                ("active-parent", providers),
            ):
                info = os.stat(path, follow_symlinks=False)
                labels[(info.st_dev, info.st_ino)] = label
            events = []
            real_fsync = os.fsync

            def record(descriptor):
                info = os.fstat(descriptor)
                events.append(labels.get((info.st_dev, info.st_ino), "other"))
                return real_fsync(descriptor)

            with patch.object(transaction.os, "fsync", side_effect=record):
                transaction.publish(home, env_file, versions, candidate, expected)
            last = lambda label: len(events) - 1 - events[::-1].index(label)
            self.assertLess(last("file"), last("generation"))
            self.assertLess(last("leaf"), last("provider-tree"))
            self.assertLess(last("provider-tree"), last("generation"))
            self.assertLess(last("generation"), last("versions"))
            self.assertLess(last("versions"), last("active-parent"))

        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            home, providers, versions, old, candidate = self.active_pair(base)
            env_file = base / "service.env"
            expected = os.stat(candidate, follow_symlinks=False)
            target = os.stat(candidate / "config.toml")
            real_fsync = os.fsync
            failed = False

            def fail_file(descriptor):
                nonlocal failed
                info = os.fstat(descriptor)
                if (not failed and (info.st_dev, info.st_ino)
                        == (target.st_dev, target.st_ino)):
                    failed = True
                    raise OSError("synthetic candidate fsync failure")
                return real_fsync(descriptor)

            with patch.object(transaction.os, "fsync", side_effect=fail_file):
                with self.assertRaises(OSError):
                    transaction.publish(home, env_file, versions, candidate, expected)
            self.assertTrue(failed)
            self.assertEqual((providers / ".active").resolve(), old.resolve())

    def test_atomic_write_propagates_parent_fsync_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "config.toml"
            target.write_text("before", encoding="utf-8")
            real_fsync = os.fsync
            directory_fsync = False

            def fail_directory(descriptor):
                nonlocal directory_fsync
                if stat.S_ISDIR(os.fstat(descriptor).st_mode):
                    directory_fsync = True
                    raise OSError("synthetic parent fsync failure")
                return real_fsync(descriptor)

            with patch.object(provider_writer.os, "fsync", side_effect=fail_directory):
                with self.assertRaises(OSError):
                    provider_writer.atomic_write(target, "after")
            self.assertTrue(directory_fsync)

    def test_predecessor_metadata_supports_safe_restore(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            home = base / "home"
            env_file = base / "service.env"
            environment = {
                **os.environ,
                "CODEX_HOME": str(home),
                "ENV_FILE": str(env_file),
                "PYTHONDONTWRITEBYTECODE": "1",
            }
            if os.geteuid() == 0:
                import pwd
                account = pwd.getpwnam("nobody")
                os.chown(base, account.pw_uid, account.pw_gid)
                os.chmod(base, 0o700)
                environment["RUN_USER"] = account.pw_name
            setup = subprocess.run(
                ["bash", str(PROVIDERS / "openai" / "setup.sh")],
                env=environment, text=True, capture_output=True, check=False)
            self.assertEqual(setup.returncode, 0, setup.stderr + setup.stdout)
            active = subprocess.run(
                [sys.executable, str(PROVIDERS / "provider_transaction.py"), "active-name"],
                env=environment, text=True, capture_output=True, check=False)
            previous = subprocess.run(
                [sys.executable, str(PROVIDERS / "provider_transaction.py"), "predecessor-name"],
                env=environment, text=True, capture_output=True, check=False)
            self.assertEqual(active.returncode, 0, active.stderr)
            self.assertEqual(previous.returncode, 0, previous.stderr)
            self.assertNotEqual(active.stdout.strip(), previous.stdout.strip())
            restored = subprocess.run(
                [sys.executable, str(PROVIDERS / "provider_transaction.py"),
                 "restore-active", previous.stdout.strip()],
                env=environment, text=True, capture_output=True, check=False)
            self.assertEqual(restored.returncode, 0, restored.stderr + restored.stdout)
            self.assertEqual((home / "providers" / ".active").resolve().name,
                             previous.stdout.strip())

    def test_provider_switches_commit_atomically_and_bound_history(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            home = base / "home"
            env_file = base / "service.env"
            environment = {
                **os.environ,
                "CODEX_HOME": str(home),
                "ENV_FILE": str(env_file),
                "PYTHONDONTWRITEBYTECODE": "1",
                "CUSTOM_BASE_URL": "http://127.0.0.1:1/v1",
                "CUSTOM_MODEL": "fixture-model",
                "CUSTOM_EFFORT": "high",
                "CUSTOM_VISION": "0",
                "CUSTOM_API_KEY": "synthetic-fixture-key",
                "PROBE_REASONING": "0",
            }
            if os.geteuid() == 0:
                import pwd
                account = pwd.getpwnam("nobody")
                os.chown(base, account.pw_uid, account.pw_gid)
                os.chmod(base, 0o700)
                environment["RUN_USER"] = account.pw_name
            custom_setup = PROVIDERS / "custom-openai" / "setup.sh"
            openai_setup = PROVIDERS / "openai" / "setup.sh"
            activate = PROVIDERS / "activate-config.sh"
            initial = subprocess.run(
                ["bash", str(custom_setup)], env=environment, text=True,
                capture_output=True, check=False)
            self.assertEqual(initial.returncode, 0, initial.stderr + initial.stdout)
            old_config = (home / "config.toml").read_text(encoding="utf-8")
            old_secret = env_file.read_text(encoding="utf-8")
            old_active = (home / "providers" / ".active").resolve()
            failure = base / "failure.sh"
            failure.write_text(
                'set -eu\nprintf replacement > "$ENV_FILE"\nprintf broken > "$CODEX_HOME/config.toml"\nexit 9\n',
                encoding="utf-8")
            failed = subprocess.run(
                [sys.executable, str(PROVIDERS / "provider_transaction.py"),
                 "custom", str(failure)],
                env=environment, text=True, capture_output=True, check=False)
            self.assertEqual(failed.returncode, 9, failed.stderr + failed.stdout)
            self.assertEqual((home / "config.toml").read_text(encoding="utf-8"), old_config)
            self.assertEqual(env_file.read_text(encoding="utf-8"), old_secret)
            self.assertEqual((home / "providers" / ".active").resolve(), old_active)
            for command in (
                ["bash", str(openai_setup)],
                ["bash", str(activate), "custom"],
                ["bash", str(openai_setup)],
            ):
                result = subprocess.run(
                    command, env=environment, text=True, capture_output=True, check=False)
                self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            histories = [
                entry for entry in (home / "providers" / ".versions").iterdir()
                if entry.name.startswith("generation-")
            ]
            self.assertEqual(len(histories), 4)

    def test_manage_health_failure_restores_recorded_generation(self):
        manage = (ROOT / "deploy" / "manage.sh").read_text(encoding="utf-8")
        start = manage.index("do_provider() {")
        end = manage.index("\ndo_edge() {", start)
        provider_function = manage[start:end]
        runner_template = r'''set -euo pipefail
SCRIPT_DIR="$FIXTURE_REPO/deploy"
REPO_ROOT="$FIXTURE_REPO"
SERVICE_NAME=fixture-provider
SERVICE_USER=fixture
SERVICE_HOME="$FIXTURE_HOME"
CODEX_HOME="$FIXTURE_HOME"
ENV_FILE="$FIXTURE_HOME/secrets.env"
need_root() { :; }
assert_instance_checkout() { :; }
die() { printf '[manage] ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[manage] %s\n' "$*"; }
active_provider() { printf openai; }
run_as_service() {
  if [ "$1" = python3 ] && [ "$4" = active-name ]; then printf generation-old; return 0; fi
  if [ "$1" = python3 ] && [ "$4" = restore-active ]; then
    printf 'restore:%s\n' "$5" >> "$FIXTURE_LOG"
    [ "$FIXTURE_ROLLBACK_FAIL" != 1 ]
    return
  fi
  "$@"
}
systemctl() { printf 'systemctl:%s\n' "$*" >> "$FIXTURE_LOG"; return 0; }
health_after_update() {
  local count=0
  [ ! -f "$FIXTURE_HEALTH_COUNT" ] || count="$(cat "$FIXTURE_HEALTH_COUNT")"
  count=$((count + 1)); printf '%s' "$count" > "$FIXTURE_HEALTH_COUNT"
  [ "$count" -gt 1 ]
}
@@FUNCTION@@
set +e
do_provider openai
status=$?
set -e
printf 'status:%s\n' "$status" >> "$FIXTURE_LOG"
'''
        for rollback_fails in (False, True):
            with self.subTest(rollback_fails=rollback_fails), tempfile.TemporaryDirectory() as directory:
                base = Path(directory)
                repo = base / "repo"
                home = base / "home"
                setup = repo / "deploy" / "providers" / "openai" / "setup.sh"
                setup.parent.mkdir(parents=True)
                home.mkdir()
                setup.write_text(
                    'printf "setup:%s\\n" "$PROVIDER_EXPECTED_ACTIVE" >> "$FIXTURE_LOG"\n',
                    encoding="utf-8")
                runner = base / "runner.sh"
                runner.write_text(
                    runner_template.replace("@@FUNCTION@@", provider_function), encoding="utf-8")
                log = base / "calls"
                environment = {
                    **os.environ,
                    "FIXTURE_REPO": str(repo),
                    "FIXTURE_HOME": str(home),
                    "FIXTURE_LOG": str(log),
                    "FIXTURE_HEALTH_COUNT": str(base / "health-count"),
                    "FIXTURE_ROLLBACK_FAIL": "1" if rollback_fails else "0",
                }
                result = subprocess.run(
                    ["bash", str(runner)], env=environment, text=True,
                    capture_output=True, check=False)
                self.assertEqual(result.returncode, 0, result.stderr)
                calls = log.read_text(encoding="utf-8")
                self.assertIn("setup:generation-old", calls)
                self.assertIn("systemctl:restart fixture-provider", calls)
                self.assertIn("restore:generation-old", calls)
                self.assertIn("status:1", calls)
                if rollback_fails:
                    self.assertIn("恢复代际仍保留", result.stdout)
                else:
                    self.assertIn("已恢复并验证上一代际", result.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
