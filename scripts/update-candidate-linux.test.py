import importlib.util
import contextlib
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "update_candidate", ROOT / "deploy" / "update_candidate.py")
update = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(update)


@unittest.skipUnless(os.name == "posix" and os.geteuid() == 0,
                     "descriptor/ownership tests require Linux root")
class TrustedCandidateUpdateTests(unittest.TestCase):
    worker_uid = 65534

    def chown_tree(self, root):
        for directory, names, files in os.walk(root, followlinks=False):
            for name in (*names, *files):
                path = Path(directory) / name
                os.chown(path, self.worker_uid, self.worker_uid,
                         follow_symlinks=False)
            os.chown(directory, self.worker_uid, self.worker_uid)

    def payload(self, base, version="0.149.0"):
        exchange = base / "exchange"
        exchange.mkdir(mode=0o733)
        exchange.chmod(0o733)
        payload = exchange / "payload"
        for relative in (
            "artifacts/node_modules",
            "artifacts/apps/gateway/node_modules",
            "artifacts/apps/gateway/dist",
            "artifacts/apps/web/node_modules",
            "artifacts/apps/web/dist",
            "runtime/node_modules/.bin",
            "runtime/node_modules/@openai/codex/bin",
            "service",
        ):
            (payload / relative).mkdir(parents=True, exist_ok=True, mode=0o700)
        for relative in (
            "artifacts/node_modules/root",
            "artifacts/apps/gateway/node_modules/gateway",
            "artifacts/apps/gateway/dist/index.js",
            "artifacts/apps/web/node_modules/web",
            "artifacts/apps/web/dist/index.html",
            "service/privileged-helper.sh",
            "service/worker_launcher.py",
        ):
            (payload / relative).write_text(relative)
        package = payload / "runtime/node_modules/@openai/codex/package.json"
        package.write_text(json.dumps({"version": version}))
        cli = payload / "runtime/node_modules/@openai/codex/bin/codex.js"
        cli.write_text("#!/bin/sh\nexit 0\n")
        cli.chmod(0o700)
        (payload / "runtime/node_modules/.bin/codex").symlink_to(
            "../@openai/codex/bin/codex.js")
        (payload / "manifest.json").write_text(
            json.dumps({"format": 1, "version": version}))
        self.chown_tree(payload)
        return exchange, payload

    def test_strict_version_reader_does_not_execute_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            candidate = Path(directory) / "candidate"
            (candidate / "deploy").mkdir(parents=True)
            marker = Path(directory) / "executed"
            (candidate / "deploy/install.sh").write_text(
                f'CODEX_VERSION="0.149.0"\ntouch "{marker}"\n')
            candidate.chmod(0o700)
            self.assertEqual(update.candidate_version(candidate), "0.149.0")
            self.assertFalse(marker.exists())
            with (candidate / "deploy/install.sh").open("a") as stream:
                stream.write('CODEX_VERSION="0.150.0"\n')
            with self.assertRaises(ValueError):
                update.candidate_version(candidate)

    def test_materialize_accepts_confined_links_and_rejects_hostile_entries(self):
        for hostile in ("hardlink", "fifo", "escape"):
            with self.subTest(hostile=hostile), tempfile.TemporaryDirectory() as directory:
                base = Path(directory)
                exchange, payload = self.payload(base)
                source = payload / "artifacts/node_modules/root"
                bad = payload / "artifacts/node_modules/bad"
                if hostile == "hardlink":
                    os.link(source, bad)
                elif hostile == "fifo":
                    os.mkfifo(bad, 0o600)
                else:
                    bad.symlink_to("../../../../etc/passwd")
                os.chown(bad, self.worker_uid, self.worker_uid,
                         follow_symlinks=False)
                with self.assertRaises(ValueError):
                    update.materialize(exchange, base / "validated", "0.149.0")
                self.assertFalse((base / "validated").exists())
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            exchange, _ = self.payload(base)
            update.materialize(exchange, base / "validated", "0.149.0")
            cli, fingerprint = update.runtime_info(
                base / "validated/runtime", "0.149.0")
            self.assertTrue(cli.is_symlink())
            self.assertRegex(fingerprint, r"^[a-f0-9]{64}$")

    def test_copy_failure_is_not_left_as_validated_output(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            exchange, _ = self.payload(base)
            real_fsync = os.fsync
            failed = False

            def injected(descriptor):
                nonlocal failed
                if not failed:
                    failed = True
                    raise OSError("synthetic fsync failure")
                return real_fsync(descriptor)

            with mock.patch.object(update.os, "fsync", side_effect=injected):
                with self.assertRaises(OSError):
                    update.materialize(
                        exchange, base / "validated", "0.149.0")
            self.assertFalse((base / "validated").exists())

    def test_live_acknowledgement_is_root_owned_and_exclusive(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory) / "runtime"
            export = runtime / "export"
            export.mkdir(parents=True, mode=0o700)

            @contextlib.contextmanager
            def opened(_):
                unit_fd = os.open(runtime, os.O_RDONLY | os.O_DIRECTORY)
                output_fd = os.open(export, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    yield unit_fd, output_fd, self.worker_uid
                finally:
                    os.close(output_fd)
                    os.close(unit_fd)

            with mock.patch.object(update, "_live_output", opened):
                update.accept_live("/ignored")
                acknowledged = runtime / "accepted"
                info = acknowledged.lstat()
                self.assertEqual(info.st_uid, 0)
                self.assertEqual(stat.S_IMODE(info.st_mode), 0o444)
                with self.assertRaises(FileExistsError):
                    update.accept_live("/ignored")

    def test_entry_replacement_during_copy_is_detected(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            exchange, _ = self.payload(base)
            original = update._copy_file
            injected = False

            def replace(source_fd, name, target_fd, info, digest):
                nonlocal injected
                if name == "root" and not injected:
                    injected = True
                    os.rename(name, "moved-root", src_dir_fd=source_fd,
                              dst_dir_fd=source_fd)
                    descriptor = os.open(
                        name, os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                        0o600, dir_fd=source_fd)
                    os.fchown(descriptor, self.worker_uid, self.worker_uid)
                    os.write(descriptor, b"replacement")
                    os.close(descriptor)
                return original(source_fd, name, target_fd, info, digest)

            with mock.patch.object(update, "_copy_file", side_effect=replace):
                with self.assertRaises(RuntimeError):
                    update.materialize(
                        exchange, base / "validated", "0.149.0")
            self.assertTrue(injected)
            self.assertFalse((base / "validated").exists())

    def test_runtime_publication_collision_is_explicit_and_never_nests(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            runtime_base = base / "runtimes"
            runtime_base.mkdir()
            exchange, _ = self.payload(base)
            validated = base / "validated"
            update.materialize(exchange, validated, "0.149.0")
            source = validated / "runtime"
            _, fingerprint = update.runtime_info(source, "0.149.0")
            state, _, _ = update.publish_runtime(
                source, runtime_base, "0.149.0", fingerprint)
            self.assertEqual(state, "created")
            state, _, _ = update.publish_runtime(
                source, runtime_base, "0.149.0", fingerprint)
            self.assertEqual(state, "reused")
            (source / "node_modules/@openai/codex/bin/codex.js").write_text(
                "#!/bin/sh\nexit 7\n")
            _, changed = update.runtime_info(source, "0.149.0")
            with self.assertRaises(RuntimeError):
                update.publish_runtime(
                    source, runtime_base, "0.149.0", changed)
            self.assertFalse(
                (runtime_base / "0.149.0" / "runtime").exists())

    def test_rollback_cleanup_refuses_referenced_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            runtime_base = base / "runtimes"
            runtime_base.mkdir()
            exchange, _ = self.payload(base)
            validated = base / "validated"
            update.materialize(exchange, validated, "0.149.0")
            source = validated / "runtime"
            _, fingerprint = update.runtime_info(source, "0.149.0")
            update.publish_runtime(source, runtime_base, "0.149.0", fingerprint)
            with mock.patch.object(update, "_referenced", return_value=True):
                self.assertFalse(update.remove_runtime(
                    runtime_base, "0.149.0", fingerprint))
            self.assertTrue((runtime_base / "0.149.0").is_dir())


if __name__ == "__main__":
    unittest.main()
