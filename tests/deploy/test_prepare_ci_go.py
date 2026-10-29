"""Portable Go preparation boundaries; no actual network or Go subprocesses."""
import hashlib
import importlib.util
import io
import json
import os
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("prepare_ci_go", Path(__file__).resolve().parents[2] / "scripts/prepare-ci-go.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class PrepareCiGoTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        (self.base / ".work").mkdir()

    def archive(self, entries=None):
        output = self.base / ".work/fixture.zip"
        with zipfile.ZipFile(output, "w") as bundle:
            for name, data in (entries or {"go/bin/go.exe": b"fixture Go runtime"}).items():
                bundle.writestr(name, data)
        return output

    def prepare(self, archive, action=None, seed_cache=None):
        calls = []

        def run(binary, arguments, source, env, log, timeout):
            calls.append((arguments, env, timeout))
            if action:
                action(arguments, source)
            return "go version go1.26.10 windows/amd64\n" if arguments == ["version"] else "verified\n"

        with patch.object(helper, "WINDOWS_SHA256", helper.sha256(archive)), patch.object(helper, "run_go", side_effect=run):
            result = helper.prepare(self.base, archive=archive, seed_cache=seed_cache, system="Windows", machine="AMD64")
        return result, calls

    def test_official_pins_and_unsupported_platforms(self):
        self.assertEqual(helper.pin("Linux", "x86_64")["archiveSha256"], helper.GO_HASHES["amd64"])
        self.assertEqual(helper.pin("Windows", "AMD64")["archiveSha256"], "7ecd2d7260e82c59bcbd7f1077a07cee2dea607295b858df67195a1e4e09629b")
        for system, machine in (("Darwin", "x86_64"), ("Linux", "aarch64"), ("Windows", "arm64")):
            with self.subTest(system=system, machine=machine), self.assertRaises(ValueError):
                helper.pin(system, machine)

    def test_preparation_seals_runtime_and_sources_and_isolates_credentials(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "fixture-secret", "HTTP_PROXY": "http://untrusted.invalid", "GOFLAGS": "-mod=mod", "HOME": "untrusted-home"}):
            output, calls = self.prepare(self.archive())
        value = json.loads(output.read_text())
        self.assertEqual(value["schemaVersion"], 1)
        self.assertEqual(value["sources"], {name: hashlib.sha256(data).hexdigest() for name, data in helper.source_material().items()})
        self.assertEqual(value["goBinarySha256"], helper.sha256(Path(value["binary"])))
        self.assertEqual([arguments for arguments, _, _ in calls], [["version"], ["mod", "download"], ["mod", "verify"]])
        for _, env, _ in calls:
            self.assertNotIn("OPENAI_API_KEY", env)
            self.assertEqual(env["GOFLAGS"], "-mod=readonly")
            self.assertEqual(env["GOTOOLCHAIN"], "local")
            self.assertEqual(env["GOAUTH"], "off")
            self.assertEqual(env["GOVCS"], "*:off")
            self.assertTrue(Path(env["HOME"]).is_relative_to(self.base / ".work/ci-go"))
        self.assertEqual(calls[1][1]["GOPROXY"], "https://proxy.golang.org")
        self.assertNotIn("HTTP_PROXY", calls[1][1])
        self.assertEqual(calls[2][1]["GOPROXY"], "off")

    def test_seed_cache_is_copied_without_modification_and_never_fetches(self):
        source = self.base / ".work/seed"
        source.mkdir()
        (source / "fixture.txt").write_bytes(b"cached dependency")
        output, calls = self.prepare(self.archive(), seed_cache=source)
        value = json.loads(output.read_text())
        copied = Path(value["moduleCache"]) / "fixture.txt"
        self.assertEqual(copied.read_bytes(), b"cached dependency")
        copied.write_bytes(b"isolated change")
        self.assertEqual((source / "fixture.txt").read_bytes(), b"cached dependency")
        self.assertTrue(all(env["GOPROXY"] == "off" for _, env, _ in calls))
        self.assertTrue(all(env["HTTPS_PROXY"] == "http://127.0.0.1:9" for _, env, _ in calls))

    def test_readonly_cache_file_with_windows_executable_suffix_copies_safely(self):
        source = self.base / ".work/Client-Cipher-aes128-gcm@openssh.com"
        destination = self.base / ".work/copied-fixture"
        source.write_bytes(b"readonly module fixture")
        source.chmod(0o444)
        try:
            self.assertEqual(helper.copy_file(source, destination, 1024), len(b"readonly module fixture"))
            self.assertEqual(destination.read_bytes(), source.read_bytes())
            self.assertFalse(source.stat().st_mode & 0o200)
        finally:
            source.chmod(0o644)

    def test_dependency_mutation_has_no_success_manifest(self):
        def mutate(arguments, source):
            if arguments == ["mod", "download"]:
                (source / "go.sum").write_bytes(b"changed lock")
        with self.assertRaisesRegex(ValueError, "changed the sealed source lock"):
            self.prepare(self.archive(), mutate)
        self.assertFalse((self.base / ".work/ci-go/prepared.json").exists())

    def test_wrong_archive_checksum_never_extracts_or_runs(self):
        archive = self.archive()
        with patch.object(helper, "extract") as extract, patch.object(helper, "run_go") as run:
            with self.assertRaisesRegex(ValueError, "checksum"):
                helper.prepare(self.base, archive=archive, system="Windows", machine="AMD64")
        extract.assert_not_called()
        run.assert_not_called()

    def test_archive_traversal_and_symlinks_are_rejected(self):
        for name in ("../escape", "go/../../escape", "other/bin/go.exe", "go/bin/../go.exe", "go\\escape"):
            archive = self.base / ".work/bad.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                member = zipfile.ZipInfo("placeholder")
                member.filename = name
                bundle.writestr(member, b"fixture")
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "Unsafe Go archive path"):
                helper.extract(archive, self.base / ".work/extracted", True)
        archive = self.base / ".work/link.zip"
        with zipfile.ZipFile(archive, "w") as bundle:
            link = zipfile.ZipInfo("go/link")
            link.create_system = 3
            link.external_attr = 0o120777 << 16
            bundle.writestr(link, "../../outside")
        with self.assertRaisesRegex(ValueError, "Special file"):
            helper.extract(archive, self.base / ".work/extracted", True)

    def test_cache_and_archive_inputs_must_be_in_task_owned_directories(self):
        outside = self.base / "outside"
        outside.mkdir()
        with self.assertRaisesRegex(ValueError, "task-owned"):
            helper.prepare(self.base, archive=outside / "go.zip", system="Windows", machine="AMD64")
        with self.assertRaisesRegex(ValueError, "task-owned"):
            helper.prepare(self.base, archive=self.archive(), seed_cache=outside, system="Windows", machine="AMD64")

    def test_download_refuses_unexpected_origin_and_inherited_proxy(self):
        response = io.BytesIO(b"fixture")
        response.url = "https://untrusted.invalid/go.zip"
        opener = SimpleNamespace(open=lambda *args, **kwargs: response)
        with patch.object(helper.urllib.request, "build_opener", return_value=opener) as build:
            with self.assertRaisesRegex(ValueError, "origin"):
                helper.download(helper.pin("Windows", "AMD64"), self.base / ".work/download.zip")
        self.assertEqual(build.call_args.args[0].proxies, {})
        redirect = build.call_args.args[1]
        with self.assertRaisesRegex(ValueError, "redirect"):
            redirect.redirect_request(None, None, 302, "found", {}, "https://untrusted.invalid/go.zip")

    def test_existing_preparation_is_never_overwritten(self):
        archive = self.archive()
        self.prepare(archive)
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.prepare(archive)

    def test_existing_verified_archive_directory_can_seed_a_fresh_runtime(self):
        archive = self.archive()
        original = archive.read_bytes()
        directory = self.base / "reference/runtime/go-1.26.10"
        directory.mkdir(parents=True)
        existing = directory / "go.zip"
        archive.rename(existing)
        output, _ = self.prepare(existing)
        self.assertEqual(existing.read_bytes(), original)
        self.assertEqual(Path(json.loads(output.read_text())["binary"]), self.base / "reference/runtime/ci-go/go/bin/go.exe")

    def test_explicit_download_proxy_is_bounded_and_cannot_enable_offline_network(self):
        selected = helper.pin("Windows", "AMD64")
        proxy = "http://127.0.0.1:18790"
        online = helper.environment(self.base, self.base, selected, network=True, download_proxy=proxy)
        offline = helper.environment(self.base, self.base, selected, network=False, download_proxy=proxy)
        self.assertEqual(online["HTTPS_PROXY"], proxy)
        self.assertEqual(offline["HTTPS_PROXY"], "http://127.0.0.1:9")
        self.assertEqual(offline["GOPROXY"], "off")
        credential_url = "http://" + ":".join(("fixture-user", "fixture-value")) + "@127.0.0.1:80"
        for value in ("https://127.0.0.1:80", credential_url, "http://proxy.example:80", "http://127.0.0.1:80/"):
            with self.subTest(value=value), self.assertRaises(helper.DeployError):
                helper.environment(self.base, self.base, selected, network=True, download_proxy=value)

    def test_failed_or_wrong_version_runtime_cannot_publish_success(self):
        archive = self.archive()
        with patch.object(helper, "WINDOWS_SHA256", helper.sha256(archive)), patch.object(helper, "run_go", return_value="go version go1.27.0 windows/amd64\n"):
            with self.assertRaisesRegex(ValueError, "version mismatch"):
                helper.prepare(self.base, archive=archive, system="Windows", machine="AMD64")
        self.assertFalse((self.base / ".work/ci-go/prepared.json").exists())

    def test_failed_subcommand_identifies_phase_and_retains_output_without_printing_it(self):
        work = self.base / ".work/ci-go"
        work.mkdir()
        for arguments, phase in ((["version"], "version"), (["mod", "download"], "download"), (["mod", "verify"], "verify")):
            with self.subTest(phase=phase):
                child = Mock(returncode=7)
                child.poll.return_value = 7
                diagnostic_output = b"fixture module failure details\n"

                def launch(*args, **kwargs):
                    kwargs["stdout"].write(diagnostic_output)
                    self.assertEqual(kwargs["stderr"], helper.subprocess.STDOUT)
                    return child

                log = work / (phase + ".log")
                with patch.object(helper.subprocess, "Popen", side_effect=launch), self.assertRaises(ValueError) as raised:
                    helper.run_go(Path("unused"), arguments, self.base, {}, log, 5)
                message = str(raised.exception)
                self.assertIn("command failed: go " + " ".join(arguments) + ";", message)
                self.assertIn("returncode=7", message)
                self.assertIn("log: .work/ci-go/" + phase + ".log", message)
                self.assertNotIn(diagnostic_output.decode().strip(), message)
                self.assertNotIn(str(self.base), message)
                self.assertEqual(log.read_bytes(), diagnostic_output)
                child.kill.assert_not_called()
                child.wait.assert_called_once_with()

    def test_budget_failure_remains_distinct_and_stops_the_child(self):
        work = self.base / ".work/ci-go"
        work.mkdir()
        for budget in ("time", "output"):
            with self.subTest(budget=budget):
                child = Mock()
                child.poll.return_value = None

                def launch(*args, **kwargs):
                    if budget == "output":
                        kwargs["stdout"].seek(8 * 1024**2 + 1)
                    return child

                with patch.object(helper.subprocess, "Popen", side_effect=launch), \
                     patch.object(helper.time, "monotonic", side_effect=[0, 6 if budget == "time" else 0]), \
                     self.assertRaises(ValueError) as raised:
                    helper.run_go(Path("unused"), ["mod", "download"], self.base, {}, work / "download.log", 5)
                self.assertIn("Go preparation " + budget + " budget exceeded: go mod download;", str(raised.exception))
                self.assertNotIn("command failed", str(raised.exception))
                child.kill.assert_called_once_with()
                child.wait.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
