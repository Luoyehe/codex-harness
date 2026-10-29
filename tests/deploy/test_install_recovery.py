"""First-start/enable retry boundaries; no systemd or downloaded tools required."""
import io
import json
import os
import secrets
import tempfile
import unittest
from contextlib import nullcontext, redirect_stderr
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from deploy import cli
from deploy.common import DeployError, Layout, fsync_directory, mkdir, read_json, write_json
from deploy.install_recovery import record_path
from deploy.manager import Manager


class FixtureSystem:
    def __init__(self):
        self.events, self.active, self.enabled = [], set(), set()
        self.fail_enable = self.stop_unknown = False

    def stop(self, units):
        self.events.append("stop")
        if self.stop_unknown:
            raise DeployError("stop_unknown", "Fixture stop is unconfirmed")
        self.active.difference_update(units)

    def start(self, units):
        self.events.append("start")
        self.active.update(units)

    def enable(self, units):
        self.events.append("enable")
        self.enabled.add(units[0])
        if self.fail_enable:
            self.fail_enable = False
            raise DeployError("enable_failed", "Fixture partial enable")
        self.enabled.update(units)


class InstallationRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.layout = Layout("fixture", Path(self.folder.name))
        mkdir(self.layout.config)
        mkdir(self.layout.app / "releases")
        mkdir(self.layout.state / "transactions")
        write_json(self.layout.config / "instance.json", {"port": 3300, "origin": "http://127.0.0.1:3300"})
        self.marker = self.layout.config / "installation.json"
        self.system = FixtureSystem()
        self.manager = Manager(self.layout, self.system, worker_gid=1)
        self.manager.require_service_ownership = lambda **kwargs: None  # This fixture isolates release/installation journals.
        self.manager.refresh_worker_unit = lambda: None
        self.manager.verify_release = lambda release: {"release": release}
        self.manager.recover_control = lambda: self.system.events.append("recover-control")
        self.manager.healthy = lambda: self.system.events.append("health")
        # Windows cannot create symlinks without an elevated token. Linux runs
        # the actual pointer implementation; Windows substitutes only creation
        # and reading, while real unlink and persisted transaction I/O remain.
        if os.name == "nt":
            def selected(name="current"):
                path = self.layout.app / name
                return path.read_text() if path.exists() else None
            self.manager.selected = selected
            self.manager.select = lambda release, name="current": (self.layout.app / name).write_text(release)

    def pending(self):
        write_json(self.marker, {"format": 1, "phase": "pending", "release": None})

    def test_transaction_parent_sync_failure_prevents_release_stop_and_selection(self):
        self.pending()
        records = self.layout.state / "transactions"
        def fail(path, **kwargs):
            if path == records:
                raise OSError("Injected transaction publication failure")
            return fsync_directory(path, **kwargs)
        with patch("deploy.common.fsync_directory", side_effect=fail), self.assertRaises(OSError):
            self.manager.activate("a" * 64)
        self.assertEqual(self.system.events, [])
        self.assertIsNone(self.manager.selected())
        self.assertEqual(list(records.glob("*/state.json")), [])

    def test_receipt_parent_sync_failure_prevents_first_restart_and_existing_retry(self):
        request = {"method": "restart", "params": {}, "operationId": "11111111-1111-4111-8111-111111111111"}
        def fail(path, **kwargs):
            if path == self.layout.state:
                raise OSError("Injected receipt collection publication failure")
            return fsync_directory(path, **kwargs)
        for attempt in range(2):
            with self.subTest(attempt=attempt), patch.object(self.manager, "preflight_mutation", return_value=None), \
                 patch.object(self.manager, "restart") as restart, patch("deploy.common.fsync_directory", side_effect=fail), \
                 self.assertRaises(OSError):
                self.manager.dispatch(request)
            restart.assert_not_called()
        self.assertEqual(list((self.layout.state / "receipts").iterdir()), [])

    def test_provider_journal_parent_failure_prevents_stop_and_provider_selection(self):
        old = {"revision": "a" * 32, "kind": "chatgpt", "models": []}
        new = {**old, "revision": "b" * 32}
        selected = []
        self.manager.providers = SimpleNamespace(read=lambda: old,
            validate_change=lambda params, current: ("provider", new), prepare=lambda value: value["revision"],
            select=selected.append, public=lambda value: value)
        def fail(path, **kwargs):
            if path == self.layout.state / "transactions":
                raise OSError("Injected provider journal publication failure")
            return fsync_directory(path, **kwargs)
        with patch("deploy.common.fsync_directory", side_effect=fail), self.assertRaises(OSError):
            self.manager.provider_change({})
        self.assertEqual(selected, [])
        self.assertEqual(self.system.events, [])

    def transaction(self, name, candidate, phase, old=None):
        folder = self.layout.state / "transactions" / name
        mkdir(folder)
        write_json(folder / "state.json", {"kind": "release", "old": old, "candidate": candidate, "phase": phase})
        return folder / "state.json"

    def test_prepare_retry_completes_enable_then_preserves_later_disabled_state(self):
        self.pending()  # Written by initialize before candidate preparation.
        self.manager.activate("a" * 64)
        self.assertEqual(read_json(self.marker)["phase"], "complete")
        self.assertEqual(self.system.enabled, set(self.manager.service_units))
        self.system.enabled.clear()  # A deliberate later operator disable.
        self.manager.activate("b" * 64)
        self.manager.restart()
        self.manager.activate("b" * 64)
        self.assertEqual(self.system.enabled, set())
        self.assertEqual(self.system.events.count("enable"), 1)
        self.assertEqual(self.manager.selected("previous"), "a" * 64)

    def test_failed_first_start_clears_current_and_never_becomes_previous(self):
        self.pending()
        with patch.object(self.manager, "healthy", side_effect=DeployError("health", "Fixture")):
            with self.assertRaises(DeployError):
                self.manager.activate("a" * 64)
        self.assertIsNone(self.manager.selected())
        self.assertIsNone(self.manager.selected("previous"))
        records = list((self.layout.state / "transactions").glob("*/state.json"))
        self.assertEqual(read_json(records[0])["phase"], "failed_first_start")
        self.assertEqual(self.system.enabled, set())
        result = self.manager.activate("b" * 64)
        self.assertIsNone(result["previous"])
        self.assertIsNone(self.manager.selected("previous"))
        self.assertTrue(records[0].exists())

    def test_unknown_stop_retains_pointer_until_a_confirmed_retry(self):
        self.pending()
        def fail_health():
            self.system.stop_unknown = True
            raise DeployError("health", "Fixture")
        with patch.object(self.manager, "healthy", side_effect=fail_health):
            with self.assertRaises(DeployError):
                self.manager.activate("a" * 64)
        record = next((self.layout.state / "transactions").glob("*/state.json"))
        self.assertEqual(read_json(record)["phase"], "selected")
        self.assertEqual(self.manager.selected(), "a" * 64)
        self.system.stop_unknown = False
        self.manager.activate("b" * 64)
        self.assertEqual(read_json(record)["phase"], "failed_first_start")
        self.assertIsNone(self.manager.selected("previous"))

    def test_legacy_failed_current_same_candidate_is_started_and_enabled(self):
        self.manager.select("a" * 64)
        self.transaction("legacy", "a" * 64, "failed_first_start")
        result = self.manager.activate("a" * 64)
        self.assertTrue(result["changed"])
        self.assertIsNone(result["previous"])
        self.assertEqual(read_json(self.marker)["phase"], "complete")
        self.assertIn("start", self.system.events)

    def test_legacy_successful_disabled_installation_is_not_reenabled(self):
        self.manager.select("a" * 64)
        self.transaction("legacy", "a" * 64, "committed")
        self.manager.activate("b" * 64)
        self.assertEqual(self.system.enabled, set())
        self.assertFalse(self.marker.exists())
        self.assertEqual(self.manager.selected("previous"), "a" * 64)

    def test_partial_enable_failure_retains_healthy_commit_and_retries(self):
        self.pending()
        self.system.fail_enable = True
        with self.assertRaises(DeployError):
            self.manager.activate("a" * 64)
        self.assertEqual(read_json(self.marker), {"format": 1, "phase": "healthy", "release": "a" * 64})
        self.assertEqual(self.manager.selected(), "a" * 64)
        record = next((self.layout.state / "transactions").glob("*/state.json"))
        self.assertEqual(read_json(record)["phase"], "committed")
        self.manager.activate("a" * 64)
        self.assertEqual(read_json(self.marker)["phase"], "complete")
        self.assertEqual(self.system.enabled, set(self.manager.service_units))
        self.assertIsNone(self.manager.selected("previous"))

    def test_completion_record_write_failure_can_retry_after_successful_enable(self):
        self.pending()
        def write(path, value, **kwargs):
            if path == self.marker and value.get("phase") == "complete":
                raise OSError("Fixture interrupted completion record")
            write_json(path, value, **kwargs)
        with patch("deploy.manager.write_json", side_effect=write):
            with self.assertRaises(OSError):
                self.manager.activate("a" * 64)
        self.assertEqual(read_json(self.marker)["phase"], "healthy")
        self.assertEqual(self.manager.selected(), "a" * 64)
        self.manager.activate("a" * 64)
        self.assertEqual(read_json(self.marker)["phase"], "complete")

    def test_restart_of_interrupted_initial_candidate_retires_old_transaction(self):
        self.pending()
        self.manager.select("a" * 64)
        record = self.transaction("interrupted", "a" * 64, "selected")
        self.manager.restart()
        self.assertEqual(read_json(record)["phase"], "failed_first_start")
        self.assertEqual(read_json(self.marker)["phase"], "complete")

    def test_corrupt_marker_fails_before_any_service_mutation(self):
        write_json(self.marker, {"format": 1, "phase": "complete", "release": None})
        with self.assertRaises(DeployError):
            self.manager.activate("a" * 64)
        self.assertEqual(self.system.events, [])

    def interrupted_upgrade(self, completed):
        self.pending()
        self.system.fail_enable = not completed
        if completed:
            self.manager.activate("a" * 64)
        else:
            with self.assertRaises(DeployError):
                self.manager.activate("a" * 64)
        with patch.object(self.manager, "healthy", side_effect=KeyboardInterrupt("Fixture process interruption")):
            with self.assertRaises(KeyboardInterrupt):
                self.manager.activate("b" * 64)
        self.assertEqual(self.manager.selected(), "b" * 64)
        events = list(self.system.events)
        for retry in (lambda: self.manager.activate("c" * 64), self.manager.restart):
            with self.assertRaises(DeployError) as raised:
                retry()
            self.assertEqual(raised.exception.code, "recovery_required")
            self.assertEqual(self.system.events, events)
        self.manager.repair()
        self.assertEqual(self.manager.selected(), "a" * 64)
        self.manager.activate("c" * 64)
        self.assertEqual(self.manager.selected("previous"), "a" * 64)
        self.assertEqual(read_json(self.marker)["phase"], "complete")

    def test_interrupted_upgrade_after_failed_enable_requires_recovery(self):
        self.interrupted_upgrade(completed=False)

    def test_interrupted_upgrade_of_completed_install_requires_recovery(self):
        self.interrupted_upgrade(completed=True)

    def test_unfinished_other_management_transaction_cannot_be_bypassed(self):
        self.pending()
        path = self.transaction("interrupted", "a" * 64, "selected")
        write_json(path, {"kind": "https", "phase": "selected"})
        with self.assertRaises(DeployError) as raised:
            self.manager.activate("a" * 64)
        self.assertEqual(raised.exception.code, "recovery_required")
        self.assertEqual(self.system.events, [])

    def failed_commit(self, interrupted):
        self.pending()
        self.manager.activate("a" * 64)
        self.manager.activate("b" * 64)
        self.assertEqual(self.manager.selected("previous"), "a" * 64)
        def write(path, value, **kwargs):
            if value.get("phase") == "committed" and value.get("candidate") == "c" * 64:
                if interrupted:
                    raise KeyboardInterrupt("Fixture power loss before commit")
                raise OSError("Fixture commit record failure")
            write_json(path, value, **kwargs)
        with patch("deploy.manager.write_json", side_effect=write):
            with self.assertRaises(KeyboardInterrupt if interrupted else OSError):
                self.manager.activate("c" * 64)
        # A failed terminal publication is ambiguous. The healthy candidate is
        # retained and explicit repair restores the two prior pointers.
        self.assertEqual(self.manager.selected(), "c" * 64)
        self.manager.repair()
        self.assertEqual(self.manager.selected(), "b" * 64)
        self.assertEqual(self.manager.selected("previous"), "a" * 64)

    def test_unpublished_commit_failure_can_repair_both_release_pointers(self):
        self.failed_commit(interrupted=False)

    def test_interrupted_commit_repair_restores_both_release_pointers(self):
        self.failed_commit(interrupted=True)

    def test_published_commit_error_keeps_the_healthy_release_running(self):
        self.pending()
        self.manager.activate('a' * 64)
        self.system.events.clear()
        def published(path, value, **kwargs):
            write_json(path, value, **kwargs)
            if value.get('phase') == 'committed':
                raise OSError('Directory fsync failed after terminal replace')
        with patch('deploy.manager.write_json', side_effect=published), self.assertRaises(OSError):
            self.manager.activate('b' * 64)
        self.assertEqual(self.manager.selected(), 'b' * 64)
        self.assertEqual(self.manager.selected('previous'), 'a' * 64)
        self.assertEqual(self.system.active, set(self.manager.service_units))
        self.assertEqual(self.system.events.count('stop'), 1)
        self.manager.restart()

    def test_forward_repair_terminal_publication_does_not_stop_a_healthy_candidate(self):
        self.pending()
        self.manager.activate('a' * 64)
        with patch.object(self.manager, 'healthy', side_effect=KeyboardInterrupt), self.assertRaises(KeyboardInterrupt):
            self.manager.activate('b' * 64)
        self.system.events.clear()
        def published(path, value, **kwargs):
            write_json(path, value, **kwargs)
            if value.get('phase') == 'committed':
                raise OSError('Directory fsync failed after terminal replace')
        with patch('deploy.manager.write_json', side_effect=published), self.assertRaises(OSError):
            self.manager.repair(target='candidate')
        self.assertEqual(self.manager.selected(), 'b' * 64)
        self.assertEqual(self.system.active, set(self.manager.service_units))
        self.assertEqual(self.system.events.count('stop'), 1)
        self.manager.restart()

    def test_published_provider_commit_never_rolls_back_or_stops_the_selected_provider(self):
        old = {'revision': 'a' * 32, 'kind': 'chatgpt', 'models': []}
        new = {**old, 'revision': 'b' * 32}
        selected = [old]
        self.manager.providers = SimpleNamespace(read=lambda: selected[0],
            validate_change=lambda params, current: ('provider', new), prepare=lambda value: value['revision'],
            select=lambda revision: selected.__setitem__(0, new if revision == new['revision'] else old), public=lambda value: value)
        def published(path, value, **kwargs):
            write_json(path, value, **kwargs)
            if value.get('phase') == 'committed':
                raise OSError('Directory fsync failed after terminal replace')
        with patch('deploy.manager.write_json', side_effect=published), self.assertRaises(OSError):
            self.manager.provider_change({})
        self.assertEqual(selected[0], new)
        self.assertEqual(self.system.active, set(self.manager.service_units))
        self.assertEqual(self.system.events.count('stop'), 1)
        self.manager.require_recovered_transactions(None)


class OperatorFailureTests(unittest.TestCase):
    def test_outer_cli_failures_do_not_claim_a_mutation_was_unsent(self):
        commands = [("install", ["--source", "fixture.tgz", "--origin", "http://127.0.0.1:3300"], "deploy.cli.install"),
                    ("update", ["--source", "fixture.tgz"], "deploy.cli.Manager"),
                    ("control-update", [], "deploy.control_update.control_command")]
        for command, arguments, target in commands:
            with self.subTest(command=command), tempfile.TemporaryDirectory() as folder:
                layout = Layout("fixture", Path(folder))
                self.assertFalse(record_path(layout).exists())
                changed = Path(folder) / "already-mutated"
                def fail(*args, **kwargs):
                    changed.write_text("The side effect happened before failure")
                    raise DeployError("fixture", "Failure after mutation")
                stderr = io.StringIO()
                with patch("deploy.cli.Layout", return_value=layout) as constructor, \
                     patch("deploy.cli.require_linux"), patch("deploy.cli.exclusive", side_effect=lambda path: nullcontext()), \
                     patch("deploy.control_update.require_no_pending_control"), patch("deploy.accounts.read_password", return_value=secrets.token_urlsafe(24)), \
                     patch(target, side_effect=fail) as mutation, redirect_stderr(stderr):
                    with self.assertRaises(SystemExit) as raised:
                        cli.main(["--instance", "fixture", command, *arguments])
                constructor.assert_called_once_with("fixture")
                mutation.assert_called_once()
                self.assertIs(mutation.call_args.args[0], layout)
                self.assertFalse(record_path(layout).exists())
                self.assertEqual(raised.exception.code, 1)
                self.assertTrue(changed.exists())
                result = json.loads(stderr.getvalue())
                self.assertEqual(result["error"]["code"], "fixture")
                self.assertNotIn("delivery", result["error"])

    def test_rpc_error_envelopes_retain_their_delivery_contract(self):
        failure = DeployError("fixture", "Fixture")
        self.assertEqual(cli.error_result(failure)["error"]["delivery"], "not_sent")
        self.assertEqual(cli.error_result(failure, "unknown")["error"]["delivery"], "unknown")


if __name__ == "__main__":
    unittest.main()
