"""Bounded candidate lock reads, exact byte limits and stable file identity."""
import contextlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy.build import MAX_LOCK_BYTES, dependency_input
from deploy.common import DeployError


class DependencyLockTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dependency-lock-")
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name)
        repository = Path(__file__).resolve().parents[2]
        for name in ("package.json", "pnpm-workspace.yaml"):
            (self.source / name).write_bytes((repository / name).read_bytes())
        self.original = (repository / "pnpm-lock.yaml").read_bytes()
        self.path = self.source / "pnpm-lock.yaml"
        self.path.write_bytes(self.original)

    def payload(self, size):
        prefix = self.original + "\n# UTF-8 comment: \u96ea\n#".encode("utf-8")
        return prefix + b"x" * (size - len(prefix) - 1) + b"\n"

    @contextlib.contextmanager
    def observe(self, before_read=None, after_read=None):
        original_open, case = Path.open, self
        requests, handles = [], []

        class Observed:
            def __init__(self, stream):
                self.stream = stream
                handles.append(stream)

            def __enter__(self):
                self.stream.__enter__()
                return self

            def __exit__(self, *args):
                return self.stream.__exit__(*args)

            def fileno(self):
                return self.stream.fileno()

            def read(self, size=-1):
                # An eventual size exception cannot substitute for a bounded
                # read, including when fstat was taken before file growth.
                case.assertGreater(size, 0)
                case.assertLessEqual(size, MAX_LOCK_BYTES + 1)
                requests.append(size)
                if before_read:
                    before_read()
                data = self.stream.read(size)
                if after_read:
                    after_read()
                return data

        def opened(path, mode="r", *args, **kwargs):
            stream = original_open(path, mode, *args, **kwargs)
            if path == self.path:
                try:
                    self.assertEqual(mode, "rb")
                except BaseException:
                    stream.close()
                    raise
                return Observed(stream)
            return stream

        with patch.object(Path, "open", opened):
            yield requests, handles

    def test_utf8_lock_at_and_below_byte_limit_is_accepted_without_unbounded_read(self):
        for size in (len(self.original) + 64, MAX_LOCK_BYTES - 1, MAX_LOCK_BYTES):
            with self.subTest(bytes=size):
                data = self.payload(size)
                self.path.write_bytes(data)
                with self.observe() as (requests, handles):
                    _, lock, _ = dependency_input(self.source)
                self.assertEqual(lock, data.decode("utf-8"))
                self.assertEqual(requests, [MAX_LOCK_BYTES + 1])
                self.assertTrue(all(handle.closed for handle in handles))

    def test_cap_plus_one_rejects_before_utf8_decoding_and_closes_file(self):
        # Malformed UTF-8 deliberately distinguishes the byte cap from decoding.
        self.path.write_bytes(b"\xff" + b"x" * MAX_LOCK_BYTES)
        with self.observe() as (requests, handles), self.assertRaises(DeployError) as caught:
            dependency_input(self.source)
        self.assertEqual(caught.exception.code, "budget")
        self.assertEqual(requests, [MAX_LOCK_BYTES + 1])
        self.assertTrue(all(handle.closed for handle in handles))
        self.assertEqual(self.path.stat().st_size, MAX_LOCK_BYTES + 1)

    def test_growth_after_initial_fstat_is_still_read_only_to_cap_plus_one(self):
        def grow():
            with open(self.path, "ab") as target:
                target.write(b"x" * MAX_LOCK_BYTES)
        with self.observe(before_read=grow) as (requests, handles), self.assertRaises(DeployError) as caught:
            dependency_input(self.source)
        self.assertEqual(caught.exception.code, "budget")
        self.assertEqual(requests, [MAX_LOCK_BYTES + 1])
        self.assertTrue(all(handle.closed for handle in handles))

    def test_invalid_utf8_is_an_explicit_input_error(self):
        for invalid in (b"\xff", b"\xe9\x9b"):
            with self.subTest(invalid=invalid):
                self.path.write_bytes(self.original + invalid)
                with self.observe() as (_, handles), self.assertRaises(DeployError) as caught:
                    dependency_input(self.source)
                self.assertEqual(caught.exception.code, "invalid_input")
                self.assertIn("UTF-8", str(caught.exception))
                self.assertTrue(all(handle.closed for handle in handles))

    def test_crlf_and_cr_newlines_keep_the_existing_normalized_contract(self):
        text = self.original.decode("utf-8") + "\n# UTF-8 comment: \u96ea\n"
        for newline in ("\r\n", "\r"):
            with self.subTest(newline=newline):
                self.path.write_bytes(text.replace("\n", newline).encode("utf-8"))
                self.assertEqual(dependency_input(self.source)[1], text)

    def test_same_size_change_during_read_is_not_accepted(self):
        initial = self.path.stat()
        def change():
            with open(self.path, "r+b") as target:
                target.write(b"L")
            os.utime(self.path, ns=(initial.st_atime_ns, initial.st_mtime_ns + 1_000_000_000))
        with self.observe(after_read=change), self.assertRaises(DeployError) as caught:
            dependency_input(self.source)
        self.assertEqual(caught.exception.code, "integrity")
        self.assertEqual(self.path.stat().st_size, len(self.original))

    def test_replacement_before_open_or_after_read_cannot_select_different_file(self):
        replacement = self.source / "replacement"
        replacement.write_bytes(self.original)
        original_stat = Path.stat
        # Model both a lookup/open race and replacement after reading, without
        # requiring Linux unlink-of-open-file behavior on the test host.
        for replace_at in (1, 2):
            with self.subTest(replacedLookup=replace_at):
                lookups = []
                def replaced(path, *args, **kwargs):
                    if path == self.path:
                        lookups.append(path)
                        if len(lookups) == replace_at:
                            return original_stat(replacement, *args, **kwargs)
                    return original_stat(path, *args, **kwargs)
                with patch.object(Path, "stat", replaced), self.assertRaises(DeployError) as caught:
                    dependency_input(self.source)
                self.assertEqual(caught.exception.code, "integrity")
                self.assertEqual(len(lookups), replace_at)

    def test_read_error_closes_the_descriptor_without_returning_partial_input(self):
        def fail():
            raise OSError("injected candidate read failure")
        with self.observe(before_read=fail) as (_, handles), self.assertRaises(OSError):
            dependency_input(self.source)
        self.assertTrue(all(handle.closed for handle in handles))


if __name__ == "__main__":
    unittest.main()
