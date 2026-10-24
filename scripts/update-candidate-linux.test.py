import importlib.util
import contextlib
import json
import os
from pathlib import Path
import shutil
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

    def test_dependency_cache_handoff_binds_inputs_and_rejects_extra_or_escaping_entries(self):
        for fault in (None, "digest", "extra", "escape", "cross-domain", "chain-escape"):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as directory:
                base = Path(directory)
                export = base / "export"
                payload = export / "payload"
                (payload / "store").mkdir(parents=True, mode=0o700)
                (payload / "cache").mkdir(mode=0o700)
                (payload / "store/package").write_bytes(b"package-data")
                (payload / "cache/registry-metadata").write_bytes(b"metadata")
                digest = "a" * 64
                (payload / "manifest.json").write_text(json.dumps({
                    "format": 1, "dependencyInputs": "b" * 64 if fault == "digest" else digest}))
                if fault == "extra":
                    (payload / "unexpected").write_text("not allowed")
                if fault == "escape":
                    (payload / "store/escape").symlink_to("../../../../etc/passwd")
                if fault == "cross-domain":
                    (payload / "store/escape").symlink_to("../cache/registry-metadata")
                if fault == "chain-escape":
                    (payload / "store/self").symlink_to(".")
                    (payload / "store/escape").symlink_to("self/../cache/registry-metadata")
                self.chown_tree(payload)
                descriptor = os.open(export, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    def materialize():
                        return update._materialize_payload(descriptor, base / "validated", None,
                                                           self.worker_uid, dependency_inputs=digest)
                    if fault:
                        with self.assertRaises(ValueError):
                            materialize()
                        self.assertFalse((base / "validated").exists())
                    else:
                        self.assertRegex(materialize(), r"^[a-f0-9]{64}$")
                        self.assertEqual((base / "validated/store/package").read_bytes(), b"package-data")
                        self.assertEqual((base / "validated/cache/registry-metadata").read_bytes(), b"metadata")
                finally:
                    os.close(descriptor)

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
        for relative, data in {
            "runtime/package.json": '{"dependencies":{"@openai/codex":"' + version + '"}}',
            "runtime/package-lock.json": '{"lockfileVersion":3}',
            "runtime/node_modules/.package-lock.json": '{"lockfileVersion":3,"hidden":true}',
            "runtime/.installation-metadata": "complete installer output\n",
        }.items():
            (payload / relative).write_text(data)
        optional = payload / "runtime/node_modules/@openai/codex-linux-x64/vendor/codex"
        optional.parent.mkdir(parents=True)
        optional.write_text("#!/bin/sh\nexit 0\n")
        optional.chmod(0o755)
        (package.parent / "platform").symlink_to("../codex-linux-x64/vendor")
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

    def test_complete_runtime_round_trip_preserves_real_fingerprint(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            exchange, payload = self.payload(base)
            trusted = base / "trusted-runtime"
            shutil.copytree(payload / "runtime", trusted, symlinks=True)
            _, expected = update.runtime_info(trusted, "0.149.0")
            workspace_link = payload / "artifacts/apps/gateway/node_modules/workspace"
            workspace_link.symlink_to("../../../node_modules/root")
            # Workspace package directories may refer back to each other. Only
            # the links resolving a particular path, not this directory graph,
            # must be acyclic and remain confined.
            package = payload / "artifacts/node_modules/pkg"
            package.mkdir()
            (package / "back").symlink_to("../../apps/gateway/node_modules")
            (workspace_link.parent / "workspace-dir").symlink_to("../../../node_modules/pkg")
            self.chown_tree(payload)
            validated = base / "validated"
            update.materialize(exchange, validated, "0.149.0")
            _, copied = update.runtime_info(validated / "runtime", "0.149.0")
            self.assertEqual(copied, expected)
            for relative in ("package.json", "package-lock.json", ".installation-metadata",
                             "node_modules/.package-lock.json"):
                self.assertEqual((trusted / relative).read_bytes(),
                                 (validated / "runtime" / relative).read_bytes())
            self.assertEqual((validated / "artifacts/apps/gateway/node_modules/workspace").read_bytes(),
                             b"artifacts/node_modules/root")
            self.assertTrue((validated / "artifacts/apps/gateway/node_modules/workspace-dir/back").is_dir())
            for path in validated.rglob("*"):
                info = path.lstat()
                self.assertEqual(info.st_uid, 0)
                if not stat.S_ISDIR(info.st_mode):
                    self.assertEqual(info.st_nlink, 1)
                if not stat.S_ISLNK(info.st_mode):
                    self.assertFalse(info.st_mode & 0o022)

    def test_real_runtime_fingerprint_detects_root_metadata_and_link_tampering(self):
        for fault in ("bytes", "addition", "removal", "executable", "link"):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as directory:
                base = Path(directory)
                exchange, _ = self.payload(base)
                update.materialize(exchange, base / "validated", "0.149.0")
                tree = base / "validated/runtime"
                _, expected = update.runtime_info(tree, "0.149.0")
                metadata = tree / ".installation-metadata"
                if fault == "bytes":
                    metadata.write_bytes(b"altered installer output\n")
                elif fault == "addition":
                    (tree / ".injected").write_bytes(b"extra")
                elif fault == "removal":
                    metadata.unlink()
                elif fault == "executable":
                    metadata.chmod(0o755)
                else:
                    platform = tree / "node_modules/@openai/codex/platform"
                    platform.unlink()
                    platform.symlink_to("bin")
                _, actual = update.runtime_info(tree, "0.149.0")
                self.assertNotEqual(actual, expected)

    def test_runtime_self_consistency_is_checked_after_copy(self):
        for fault in ("package-version", "cli-executable", "cli-missing"):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as directory:
                base = Path(directory)
                exchange, payload = self.payload(base)
                runtime = payload / "runtime/node_modules/@openai/codex"
                if fault == "package-version":
                    (runtime / "package.json").write_text('{"version":"0.150.0"}')
                elif fault == "cli-executable":
                    (runtime / "bin/codex.js").chmod(0o600)
                else:
                    (runtime / "bin/codex.js").unlink()
                with self.assertRaises((OSError, ValueError)):
                    update.materialize(exchange, base / "validated", "0.149.0")
                self.assertFalse((base / "validated").exists())

    def test_links_are_confined_to_each_relocated_publication_domain(self):
        for fault in ("artifacts-to-runtime", "runtime-to-artifacts", "semantic-escape", "service",
                      "cyclic-link", "excessive-chain"):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as directory:
                base = Path(directory)
                exchange, payload = self.payload(base)
                if fault == "artifacts-to-runtime":
                    bad = payload / "artifacts/node_modules/bad"
                    bad.symlink_to("../../runtime/package.json")
                elif fault == "runtime-to-artifacts":
                    bad = payload / "runtime/bad"
                    bad.symlink_to("../artifacts/node_modules/root")
                elif fault == "semantic-escape":
                    (payload / "runtime/self").symlink_to(".")
                    bad = payload / "runtime/bad"
                    bad.symlink_to("self/../artifacts/node_modules/root")
                elif fault == "service":
                    bad = payload / "service/worker_launcher.py"
                    bad.unlink()
                    bad.symlink_to("privileged-helper.sh")
                elif fault == "cyclic-link":
                    (payload / "artifacts/node_modules/one").symlink_to("two")
                    (payload / "artifacts/node_modules/two").symlink_to("one")
                else:
                    for index in range(41):
                        (payload / f"artifacts/node_modules/chain-{index}").symlink_to(
                            f"chain-{index + 1}" if index < 40 else "root")
                self.chown_tree(payload)
                with self.assertRaises(ValueError):
                    update.materialize(exchange, base / "validated", "0.149.0")
                self.assertFalse((base / "validated").exists())

    def test_source_mutation_after_precheck_cannot_bypass_copied_contract(self):
        for fault in ("manifest-version", "manifest-duplicate", "manifest-bool",
                      "outer-entry", "service-entry", "artifact-entry"):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as directory:
                base = Path(directory)
                exchange, payload = self.payload(base)
                original = update._copy_opened
                entered_copy = False

                def mutate(*args, **kwargs):
                    nonlocal entered_copy
                    entered_copy = True
                    if fault == "manifest-version":
                        (payload / "manifest.json").write_text('{"format":1,"version":"0.150.0"}')
                    elif fault == "manifest-duplicate":
                        (payload / "manifest.json").write_text(
                            '{"format":0,"format":1,"version":"0.149.0"}')
                    elif fault == "manifest-bool":
                        (payload / "manifest.json").write_text('{"format":true,"version":"0.149.0"}')
                    else:
                        extra = payload / {"outer-entry": "extra",
                                           "service-entry": "service/extra",
                                           "artifact-entry": "artifacts/apps/extra"}[fault]
                        extra.write_bytes(b"not in the fixed contract")
                        os.chown(extra, self.worker_uid, self.worker_uid)
                    return original(*args, **kwargs)

                with mock.patch.object(update, "_copy_opened", side_effect=mutate):
                    with self.assertRaises(ValueError):
                        update.materialize(exchange, base / "validated", "0.149.0")
                self.assertTrue(entered_copy)
                self.assertFalse((base / "validated").exists())

    def test_dependency_manifest_mutation_is_rejected_after_descriptor_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            export = base / "export"
            payload = export / "payload"
            (payload / "store").mkdir(parents=True)
            (payload / "cache").mkdir()
            manifest = payload / "manifest.json"
            inputs = "a" * 64
            manifest.write_text(json.dumps({"format": 1, "dependencyInputs": inputs}))
            self.chown_tree(payload)
            original = update._copy_opened

            def mutate(*args, **kwargs):
                manifest.write_text(json.dumps({"format": 1, "dependencyInputs": "b" * 64}))
                return original(*args, **kwargs)

            descriptor = os.open(export, os.O_RDONLY | os.O_DIRECTORY)
            try:
                with mock.patch.object(update, "_copy_opened", side_effect=mutate):
                    with self.assertRaises(ValueError):
                        update._materialize_payload(descriptor, base / "validated", None,
                                                    self.worker_uid, dependency_inputs=inputs)
            finally:
                os.close(descriptor)
            self.assertFalse((base / "validated").exists())

    def test_late_parent_fsync_failure_removes_only_created_output(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            exchange, _ = self.payload(base)
            parent_identity = update._identity(base.stat())
            real_fsync = os.fsync
            injected = False

            def fail_parent(descriptor):
                nonlocal injected
                if not injected and update._identity(os.fstat(descriptor)) == parent_identity:
                    injected = True
                    raise OSError("synthetic late parent fsync failure")
                return real_fsync(descriptor)

            with mock.patch.object(update.os, "fsync", side_effect=fail_parent):
                with self.assertRaises(OSError):
                    update.materialize(exchange, base / "validated", "0.149.0")
            self.assertTrue(injected)
            self.assertFalse((base / "validated").exists())

    def test_failure_cleanup_never_removes_replaced_or_preexisting_destination(self):
        for fault in ("collision", "replacement"):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as directory:
                base = Path(directory)
                exchange, _ = self.payload(base)
                destination = base / "validated"
                external = base / "unrelated"
                external.mkdir()
                (external / "sentinel").write_bytes(b"preserve unrelated data")
                original = update._copy_opened

                def collide(*args, **kwargs):
                    destination.symlink_to(external, target_is_directory=True)
                    return original(*args, **kwargs)

                real_fsync = os.fsync
                replaced = False

                def replace(descriptor):
                    nonlocal replaced
                    if not replaced and update._identity(os.fstat(descriptor)) == update._identity(base.stat()):
                        replaced = True
                        destination.rename(base / "own-moved-directory")
                        destination.symlink_to(external, target_is_directory=True)
                        raise OSError("synthetic replacement before late failure")
                    return real_fsync(descriptor)

                patch = (mock.patch.object(update, "_copy_opened", side_effect=collide)
                         if fault == "collision" else mock.patch.object(update.os, "fsync", side_effect=replace))
                with patch, self.assertRaises(OSError):
                    update.materialize(exchange, destination, "0.149.0")
                self.assertTrue(destination.is_symlink())
                self.assertEqual((external / "sentinel").read_bytes(), b"preserve unrelated data")

    def test_materialization_requires_root_private_destination_parent(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            exchange, _ = self.payload(base)
            public = base / "public"
            public.mkdir(mode=0o755)
            with self.assertRaisesRegex(ValueError, "root-private"):
                update.materialize(exchange, public / "validated", "0.149.0")
            self.assertFalse((public / "validated").exists())

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
