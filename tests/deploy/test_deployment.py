import io
import contextlib
import bz2
import gzip
import hashlib
import json
import lzma
import os
import sqlite3
import tarfile
import tempfile
import unittest
import uuid
import http.server
import threading
import subprocess
import sys
import tracemalloc
from pathlib import Path
from unittest.mock import MagicMock, patch

from deploy.archive import XzReader, open_archive
from deploy.build import APPROVED_OVERRIDES, WORKSPACE_SETTINGS, dependency_input, dependency_workspace, pack_source, pnpm_command
from deploy.catalog import fetch_ids, parse_ids
from deploy.common import DeployError, Layout, digest, mkdir, read_json, write_json
from deploy.journal import recover_journal
from deploy.manager import Manager
from deploy.native_launcher import project_from_input
from deploy.provider import native_config, redacted, validate_catalog, validate_provider, provider_url
from deploy.safe_fs import extract_tar, inspect_tree, safe_link, snapshot
from deploy.system import parse_unit_state
from deploy.units import render_units, sudo_rule


def state(load="loaded", active="inactive", sub="dead", pid="0", control="0"):
    return f"LoadState={load}\nActiveState={active}\nSubState={sub}\nMainPID={pid}\nControlPID={control}\n"


class UnitStateTests(unittest.TestCase):
    def test_loaded_stopped_and_collected_have_consistent_evidence(self):
        self.assertTrue(parse_unit_state(state())["stopped"])
        self.assertTrue(parse_unit_state(state(load="not-found"))["stopped"])
        self.assertFalse(parse_unit_state(state(active="active", sub="running", pid="24"))["stopped"])

    def test_empty_duplicate_failed_and_contradictory_queries_do_not_authorize_cleanup(self):
        for value, code in (("", 0), (state() + "MainPID=0\n", 0), (state(), 1), (state().replace("SubState=dead", "SubState="), 0)):
            with self.subTest(value=value, code=code), self.assertRaises(DeployError):
                parse_unit_state(value, code)
        self.assertFalse(parse_unit_state(state(load="not-found", active="active", sub="dead"))["stopped"])
        self.assertFalse(parse_unit_state(state(pid="25"))["stopped"])


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.current = {"revision": "a" * 32, "kind": "responses", "baseUrl": "https://provider.invalid/v1",
                        "model": "fixture-model", "apiKey": "fixture-key", "effort": "native-only", "models": []}

    def test_default_without_override_is_legal_and_repeat_catalog_is_noop(self):
        params = {"expectedRevision": self.current["revision"], "models": [{"id": "fixture-model", "defaultEffort": "native-only", "efforts": []}]}
        changed = validate_catalog(params, self.current)
        self.assertEqual(changed["effort"], "native-only")
        params["expectedRevision"] = changed["revision"]
        self.assertEqual(validate_catalog(params, changed), changed)

    def test_non_default_override_rejected_and_stale_revision_rejected(self):
        params = {"expectedRevision": self.current["revision"], "models": [{"id": "fixture-model", "defaultEffort": "different", "efforts": []}]}
        with self.assertRaises(DeployError):
            validate_catalog(params, self.current)
        params["expectedRevision"] = "b" * 32
        with self.assertRaises(DeployError):
            validate_catalog(params, self.current)

    def test_new_endpoint_never_inherits_old_key(self):
        params = {"expectedRevision": self.current["revision"], "kind": "responses", "model": "fixture-model", "baseUrl": "https://other.invalid/v1"}
        self.assertEqual(validate_provider(params, self.current)["apiKey"], "")
        params["apiKey"] = "new-fixture-key"
        self.assertEqual(validate_provider(params, self.current)["apiKey"], "new-fixture-key")

    def test_empty_key_means_no_auth_and_literal_empty_is_not_a_sentinel(self):
        params = {"expectedRevision": self.current["revision"], "kind": "responses", "model": "fixture-model", "baseUrl": "http://127.0.0.1:9000/v1", "apiKey": ""}
        value = validate_provider(params, self.current)
        self.assertNotIn("env_key", native_config(value).decode())
        params["apiKey"] = "EMPTY"
        with self.assertRaises(DeployError): validate_provider(params, self.current)
        params["allowInsecureHttp"] = True
        value = validate_provider(params, self.current)
        self.assertEqual(value["apiKey"], "EMPTY")
        self.assertIn('env_key = "HARNESS_PROVIDER_API_KEY"', native_config(value).decode())

    def test_public_http_is_rejected_even_when_insecure_is_confirmed(self):
        for endpoint in ("http://8.8.8.8/v1", "http://provider.invalid/v1", "http://169.254.169.254/v1"):
            with self.subTest(endpoint=endpoint), self.assertRaises(DeployError):
                provider_url(endpoint, "", True)
        self.assertEqual(provider_url("http://[fd12::1]:9000/v1", ""), "http://[fd12::1]:9000/v1")

    def test_confirmed_catalog_is_selected_by_the_native_configuration(self):
        value = validate_catalog({"expectedRevision": self.current["revision"], "models": [{"id": "fixture-model", "defaultEffort": "native-only", "efforts": []}]}, self.current)
        config = native_config(value, Layout("fixture")).decode()
        self.assertIn("model_catalog_json =", config)
        self.assertIn(value["revision"], config)
        self.assertEqual(value["nativeCatalog"]["models"][0]["slug"], "fixture-model")
        self.assertEqual(value["nativeCatalog"]["models"][0]["supported_reasoning_levels"], [])

    def test_secrets_are_not_in_native_config_or_read_response(self):
        self.assertNotIn("fixture-key", native_config(self.current).decode())
        self.assertNotIn("apiKey", redacted(self.current))
        self.assertTrue(redacted(self.current)["hasApiKey"])

    def test_zhipu_uses_official_responses_and_four_mcp_entries(self):
        params = {"expectedRevision": self.current["revision"], "kind": "zhipu-coding", "model": "glm-fixture", "apiKey": "fixture-key"}
        value = validate_provider(params, self.current)
        text = native_config(value, Layout("fixture")).decode()
        self.assertEqual(value["baseUrl"], "https://open.bigmodel.cn/api/v1")
        self.assertEqual(text.count("[mcp_servers."), 4)
        self.assertIn('env_vars = ["Z_AI_API_KEY", "Z_AI_MODE"]', text)
        self.assertNotIn("fixture-key", text)

    def test_urls_and_secret_control_characters_are_rejected(self):
        credential_url = "https://" + "user" + ":" + "pass" + "@provider.invalid"
        for url in ("http://provider.invalid", credential_url, "https://provider.invalid/?secret=x"):
            with self.subTest(url=url), self.assertRaises(DeployError):
                validate_provider({"expectedRevision": self.current["revision"], "kind": "responses", "baseUrl": url, "model": "x", "apiKey": "fixture"}, self.current)
        with self.assertRaises(DeployError):
            validate_provider({"expectedRevision": self.current["revision"], "kind": "responses", "baseUrl": self.current["baseUrl"], "model": "x", "apiKey": "line\nbreak"}, self.current)


class ArchiveTests(unittest.TestCase):
    def make_archive(self, directory, members):
        archive = directory / "input.tar"
        with tarfile.open(archive, "w") as target:
            for name, kind, content in members:
                item = tarfile.TarInfo(name)
                if kind == "file":
                    item.size = len(content)
                    target.addfile(item, io.BytesIO(content))
                else:
                    item.type = {"symlink": tarfile.SYMTYPE, "hardlink": tarfile.LNKTYPE, "fifo": tarfile.FIFOTYPE, "dir": tarfile.DIRTYPE}[kind]
                    item.linkname = content
                    target.addfile(item)
        return archive

    @contextlib.contextmanager
    def counted_scandir(self):
        original = os.scandir
        consumed = []
        class Listing:
            def __init__(self, path): self.inner = original(path)
            def __enter__(self): return self
            def __exit__(self, *args): self.inner.close()
            def __iter__(self): return self
            def __next__(self):
                entry = next(self.inner)
                consumed.append(entry.name)
                return entry
        with patch('os.scandir', Listing):
            yield consumed

    def test_inspection_caps_enumeration_before_collecting_a_wide_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for index in range(12): (root / str(index)).write_bytes(b'')
            with patch('deploy.safe_fs.MAX_FILES', 3), self.counted_scandir() as consumed:
                with self.assertRaises(DeployError) as caught:
                    inspect_tree(root)
            self.assertEqual(caught.exception.code, 'budget')
            self.assertEqual(len(consumed), 4)

    def test_inspection_reserves_pending_siblings_before_descending(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ('a', 'b', 'c'):
                (root / name).mkdir()
                for index in range(12): (root / name / str(index)).write_bytes(b'')
            with patch('deploy.safe_fs.MAX_FILES', 3), self.counted_scandir() as consumed:
                with self.assertRaises(DeployError) as caught:
                    inspect_tree(root)
            self.assertEqual(caught.exception.code, 'budget')
            self.assertEqual(len(consumed), 4)

    @unittest.skipUnless(os.name == 'posix', 'Descriptor-safe import requires Linux')
    def test_snapshot_bounds_fd_enumeration_and_reserves_pending_siblings(self):
        for nested in (False, True):
            with self.subTest(nested=nested), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                source = root / 'source'
                source.mkdir()
                if nested:
                    for name in ('a', 'b', 'c'):
                        (source / name).mkdir()
                        for index in range(12): (source / name / str(index)).write_bytes(b'')
                else:
                    for index in range(12): (source / str(index)).write_bytes(b'')
                with patch('deploy.safe_fs.MAX_FILES', 3), self.counted_scandir() as consumed:
                    with self.assertRaises(DeployError) as caught:
                        snapshot(source, root / 'output', producer_stopped=True, expected_uid=os.geteuid())
                self.assertEqual(caught.exception.code, 'budget')
                self.assertEqual(len(consumed), 4)

    def test_implicit_directories_are_reserved_with_the_member_before_creation(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive = self.make_archive(root, [('keep', 'file', b'old'), ('a/b/file', 'file', b'new')])
            with patch('deploy.safe_fs.MAX_FILES', 3), self.assertRaises(DeployError) as caught:
                extract_tar(archive, root / 'output')
            self.assertEqual(caught.exception.code, 'budget')
            self.assertEqual((root / 'output/keep').read_bytes(), b'old')
            self.assertFalse((root / 'output/a').exists())

    def test_strip_and_late_explicit_directory_share_one_actual_entry_budget(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive = self.make_archive(root, [('package/a/file', 'file', b'x'), ('package/a', 'dir', ''), ('package/b', 'dir', '')])
            with patch('deploy.safe_fs.MAX_FILES', 3):
                extract_tar(archive, root / 'output', strip=1)
                self.assertEqual(set(inspect_tree(root / 'output')), {'a', 'a/file', 'b'})

    def test_files_and_delayed_links_cannot_replace_an_implicit_directory(self):
        for kind, value in (('file', b'x'), ('symlink', 'target')):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                archive = self.make_archive(root, [('a/child', 'file', b'kept'), ('a', kind, value)])
                with self.assertRaises(DeployError) as caught:
                    extract_tar(archive, root / 'output')
                self.assertEqual(caught.exception.code, 'unsafe_path')
                self.assertEqual((root / 'output/a/child').read_bytes(), b'kept')

    @unittest.skipUnless(os.name == 'posix', 'Real archive symlinks require Linux')
    def test_delayed_links_consume_entry_budget_before_parent_creation(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive = self.make_archive(root, [('target', 'file', b'x'), ('a/link', 'symlink', '../target')])
            with patch('deploy.safe_fs.MAX_FILES', 3):
                extract_tar(archive, root / 'accepted')
                self.assertEqual(set(inspect_tree(root / 'accepted')), {'target', 'a', 'a/link'})
            with patch('deploy.safe_fs.MAX_FILES', 2), self.assertRaises(DeployError) as caught:
                extract_tar(archive, root / 'rejected')
            self.assertEqual(caught.exception.code, 'budget')
            self.assertFalse((root / 'rejected/a').exists())

    def test_extensions_are_rejected_before_their_declared_payload_is_read(self):
        for kind in (tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.SOLARIS_XHDTYPE,
                     tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                header = tarfile.TarInfo('extension')
                header.type, header.size = kind, 65
                archive = root / 'input.tar'
                # No extension payload exists. A late check would instead let
                # tarfile read it and fail with a truncated-header error.
                archive.write_bytes(header.tobuf(format=tarfile.USTAR_FORMAT))
                with patch('deploy.archive.MAX_METADATA', 64), self.assertRaises(DeployError) as caught:
                    extract_tar(archive, root / 'output')
                self.assertEqual(caught.exception.code, 'budget')
                self.assertIn('extension', str(caught.exception))

    def test_small_compressed_pax_payload_cannot_escape_metadata_budget(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive = root / 'input.tgz'
            with tarfile.open(archive, 'w:gz', format=tarfile.PAX_FORMAT) as target:
                item = tarfile.TarInfo('package.json')
                item.size, item.pax_headers = 1, {'comment': 'x' * 65536}
                target.addfile(item, io.BytesIO(b'x'))
            self.assertLess(archive.stat().st_size, 1024)
            with self.assertRaises(DeployError) as caught:
                extract_tar(archive, root / 'output')
            self.assertEqual(caught.exception.code, 'budget')
            self.assertFalse((root / 'output/package.json').exists())

    def test_pax_and_gnu_long_names_survive_all_supported_compression_formats(self):
        name = 'a' * 75 + '/' + 'b' * 75 + '.txt'
        for format in (tarfile.PAX_FORMAT, tarfile.GNU_FORMAT):
            for mode, suffix in (('w', '.tar'), ('w:gz', '.tgz'), ('w:bz2', '.tar.bz2'), ('w:xz', '.tar.xz')):
                with self.subTest(format=format, mode=mode), tempfile.TemporaryDirectory() as folder:
                    root = Path(folder)
                    archive = root / ('input' + suffix)
                    with tarfile.open(archive, mode, format=format) as target:
                        item = tarfile.TarInfo('package/' + name)
                        item.size = 7
                        if format == tarfile.PAX_FORMAT:
                            item.pax_headers = {'comment': 'retained compatibility', 'mtime': '123.25'}
                        target.addfile(item, io.BytesIO(b'fixture'))
                    extract_tar(archive, root / 'output', strip=1)
                    self.assertEqual((root / 'output' / name).read_bytes(), b'fixture')

    def test_long_link_and_global_pax_metadata_remain_parseable(self):
        target_name = 'a' * 75 + '/' + 'b' * 75
        for format in (tarfile.PAX_FORMAT, tarfile.GNU_FORMAT):
            with self.subTest(format=format), tempfile.TemporaryDirectory() as folder:
                archive = Path(folder) / 'input.tar'
                with tarfile.open(archive, 'w', format=format,
                                  pax_headers={'comment': 'global fixture'} if format == tarfile.PAX_FORMAT else None) as target:
                    item = tarfile.TarInfo('alias')
                    item.type, item.linkname = tarfile.SYMTYPE, target_name
                    target.addfile(item)
                with open_archive(archive, max_file=1024, max_members=4, max_bytes=1024) as source:
                    item = source.next()
                    self.assertEqual(item.linkname, target_name)
                    if format == tarfile.PAX_FORMAT:
                        self.assertEqual(item.pax_headers['comment'], 'global fixture')
                    self.assertIsNone(source.next())

    def test_metadata_total_physical_headers_and_extension_chain_are_bounded(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive = root / 'metadata.tar'
            with tarfile.open(archive, 'w', format=tarfile.PAX_FORMAT) as target:
                for name in ('one', 'two'):
                    item = tarfile.TarInfo(name)
                    item.pax_headers = {'comment': 'x' * 32}
                    target.addfile(item)
            with patch('deploy.archive.MAX_METADATA_TOTAL', 64), self.assertRaises(DeployError) as caught:
                extract_tar(archive, root / 'metadata')
            self.assertIn('metadata', str(caught.exception))
            extension = tarfile.TarInfo('extension')
            extension.type = tarfile.XHDTYPE
            archive.write_bytes(extension.tobuf() * 3 + tarfile.TarInfo('file').tobuf() + b'\0' * 1024)
            with patch('deploy.safe_fs.MAX_FILES', 1), self.assertRaises(DeployError) as caught:
                extract_tar(archive, root / 'physical')
            self.assertIn('physical headers', str(caught.exception))
            with patch('deploy.archive.MAX_EXTENSION_DEPTH', 2), self.assertRaises(DeployError) as caught:
                extract_tar(archive, root / 'chain')
            self.assertIn('extension chain', str(caught.exception))

    def test_effective_pax_size_and_sparse_maps_do_not_bypass_admission(self):
        for metadata, code in (({'size': '65'}, 'budget'),
                               ({'GNU.sparse.major': '1', 'GNU.sparse.minor': '0'}, 'unsafe_path')):
            with self.subTest(metadata=metadata), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                archive = root / 'input.tar'
                with tarfile.open(archive, 'w', format=tarfile.PAX_FORMAT) as target:
                    item = tarfile.TarInfo('file')
                    item.size, item.pax_headers = 1, metadata
                    target.addfile(item, io.BytesIO(b'x'))
                with patch('deploy.safe_fs.MAX_FILE', 64), self.assertRaises(DeployError) as caught:
                    extract_tar(archive, root / 'output')
                self.assertEqual(caught.exception.code, code)

    def test_skipped_payload_still_consumes_decompressed_stream_budget(self):
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode='w') as target:
            item = tarfile.TarInfo('stripped')
            item.size = 65536
            target.addfile(item, io.BytesIO(b'\0' * item.size))
        for compress, suffix in ((gzip.compress, '.tgz'), (bz2.compress, '.bz2'), (lzma.compress, '.xz')):
            with self.subTest(suffix=suffix), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                archive = root / ('input' + suffix)
                archive.write_bytes(compress(raw.getvalue()))
                with patch('deploy.safe_fs.MAX_FILES', 1), patch('deploy.safe_fs.MAX_BYTES', 1), \
                     patch('deploy.archive.MAX_METADATA_TOTAL', 0), self.assertRaises(DeployError) as caught:
                    extract_tar(archive, root / 'output', strip=1)
                self.assertEqual(caught.exception.code, 'budget')
                self.assertIn('stream', str(caught.exception))

    def test_compressed_input_and_xz_decoder_memory_are_bounded(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive = self.make_archive(root, [('file', 'file', b'x')])
            with patch('deploy.archive.MAX_INPUT', 64), self.assertRaises(DeployError) as caught:
                extract_tar(archive, root / 'input-limit')
            self.assertEqual(caught.exception.code, 'budget')
            compressed = root / 'input.xz'
            compressed.write_bytes(lzma.compress(archive.read_bytes()))
            # Encoding the small fixture uses the ordinary default dictionary;
            # reducing the decoder limit verifies rejection without a big allocation.
            with patch('deploy.archive.XZ_MEMORY', 1024**2), self.assertRaises(lzma.LZMAError):
                extract_tar(compressed, root / 'dictionary-limit')

    def test_concatenated_compressed_streams_and_legacy_lzma_are_supported(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            raw = self.make_archive(root, [('file', 'file', b'fixture')]).read_bytes()
            for index, compress in enumerate((gzip.compress, bz2.compress, lzma.compress)):
                archive = root / ('joined-' + str(index))
                archive.write_bytes(compress(raw[:600]) + (b'\0' * 4 if index == 2 else b'') + compress(raw[600:]))
                output = root / ('output-' + str(index))
                extract_tar(archive, output)
                self.assertEqual((output / 'file').read_bytes(), b'fixture')
            archive = root / 'legacy.lzma'
            archive.write_bytes(lzma.compress(raw, format=lzma.FORMAT_ALONE))
            extract_tar(archive, root / 'legacy')
            self.assertEqual((root / 'legacy/file').read_bytes(), b'fixture')

    def test_global_pax_state_cannot_accumulate_across_small_headers(self):
        for value in ('x' * 30, '\u4e2d' * 12):
            with self.subTest(value=value), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                archive = root / 'input.tar'
                global_one = tarfile.TarInfo.create_pax_global_header({'first': value})
                global_two = tarfile.TarInfo.create_pax_global_header({'second': value})
                archive.write_bytes(global_one + global_two + tarfile.TarInfo('file').tobuf() + b'\0' * 1024)
                with patch('deploy.archive.MAX_METADATA', 64), self.assertRaises(DeployError) as caught:
                    extract_tar(archive, root / 'output')
                self.assertEqual(caught.exception.code, 'budget')
                self.assertIn('global metadata', str(caught.exception))

    def test_empty_xz_streams_do_not_accumulate_output_buffers(self):
        empty_streams = lzma.compress(b'') * 20000
        tracemalloc.start()
        try:
            self.assertEqual(XzReader(io.BytesIO(empty_streams)).read(1), b'')
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        # No big allocation or pressure test: only 640 KB compressed input,
        # with a generous bound above the reader's fixed 64 KB chunk buffers.
        self.assertLess(peak, 768 * 1024)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            raw = self.make_archive(root, [('file', 'file', b'fixture')]).read_bytes()
            archive = root / 'empty-prefix.xz'
            archive.write_bytes(empty_streams + lzma.compress(raw))
            extract_tar(archive, root / 'output')
            self.assertEqual((root / 'output/file').read_bytes(), b'fixture')

    def test_traversal_hardlink_duplicate_and_special_file_rejected(self):
        samples = [[("../outside", "file", b"x")], [("alias", "hardlink", "inside")], [("fifo", "fifo", "")],
                   [("duplicate", "file", b"x"), ("duplicate", "file", b"y")], [("link", "symlink", "../../outside")]]
        for sample in samples:
            with self.subTest(sample=sample), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                with self.assertRaises(DeployError):
                    extract_tar(self.make_archive(root, sample), root / "output")
                self.assertFalse((root.parent / "outside").exists())

    def test_root_metadata_is_part_of_the_full_runtime_manifest(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive = self.make_archive(root, [("package.json", "file", b"{}"), ("package-lock.json", "file", b"{}"),
                                              ("node_modules/.package-lock.json", "file", b"{}"),
                                              ("node_modules/platform/bin/codex", "file", b"fixture")])
            extract_tar(archive, root / "runtime")
            original = inspect_tree(root / "runtime")
            for name in ("package.json", "package-lock.json", "node_modules/.package-lock.json", "node_modules/platform/bin/codex"):
                path = root / "runtime" / name
                value = path.read_bytes()
                path.write_bytes(value + b"changed")
                self.assertNotEqual(inspect_tree(root / "runtime"), original)
                path.write_bytes(value)
            self.assertEqual(inspect_tree(root / "runtime"), original)

    def test_symlink_relative_scope(self):
        self.assertEqual(safe_link("node_modules/.bin/tool", "../pkg/bin/tool"), "node_modules/pkg/bin/tool")
        for target in ("/etc/shadow", "../../../etc/shadow", "C:\\file"):
            with self.assertRaises(DeployError):
                safe_link("dir/link", target)

    @unittest.skipUnless(os.name == "posix", "Descriptor-safe import requires Linux")
    def test_stopped_snapshot_preserves_full_tree_and_rejects_hardlinks(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "source"
            source.mkdir()
            (source / "package.json").write_text("{}")
            (source / "bin").write_text("fixture")
            os.chmod(source / "bin", 0o755)
            os.symlink("bin", source / "link")
            snapshot(source, root / "copy", producer_stopped=True)
            self.assertEqual(inspect_tree(source), inspect_tree(root / "copy"))
            with self.assertRaises(DeployError):
                snapshot(source, root / "running", producer_stopped=False)
            os.link(source / "bin", source / "hard")
            with self.assertRaises(DeployError):
                snapshot(source, root / "hard-copy", producer_stopped=True)

    @unittest.skipUnless(os.name == "posix", "Linux permissions")
    def test_umask_077_does_not_hide_published_input(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive = self.make_archive(root, [("nested/deep/file", "file", b"readable")])
            old = os.umask(0o077)
            try:
                extract_tar(archive, root / "output")
            finally:
                os.umask(old)
            for path in (root / "output", root / "output/nested", root / "output/nested/deep"):
                self.assertEqual(path.stat().st_mode & 0o777, 0o755)


class JournalTests(unittest.TestCase):
    def create(self, path):
        db = sqlite3.connect(path)
        db.executescript("""CREATE TABLE receipts(id TEXT PRIMARY KEY,method TEXT NOT NULL,scope TEXT NOT NULL,digest TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('pending','dispatching','accepted','not_sent','unknown')),result TEXT,error TEXT,bytes INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;
            CREATE TABLE projects(id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE,name TEXT NOT NULL) STRICT;
            CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;""")
        for value in ("pending", "dispatching", "accepted", "unknown"):
            db.execute("INSERT INTO receipts VALUES(?,?,?,?,?,NULL,NULL,0,0,0)", (value, "turn/start", "fixture", "fixture", value))
        db.execute("INSERT INTO metadata VALUES('activityUncertain','true')")
        db.commit()
        db.close()

    def test_unknown_receipts_survive_control_barrier_reset(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "journal.sqlite"
            self.create(path)
            with self.assertRaises(DeployError):
                recover_journal(path, services_stopped=False)
            self.assertEqual(recover_journal(path, services_stopped=True), {"notSent": 1, "unknown": 1})
            db = sqlite3.connect(path)
            self.assertEqual(dict(db.execute("SELECT id,state FROM receipts")), {"pending": "not_sent", "dispatching": "unknown", "accepted": "accepted", "unknown": "unknown"})
            self.assertEqual(db.execute("SELECT value FROM metadata WHERE key='activityUncertain'").fetchone()[0], "false")
            db.close()

    def test_unknown_schema_or_trigger_is_rejected_before_mutation(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "journal.sqlite"
            self.create(path)
            db = sqlite3.connect(path)
            db.execute("CREATE TRIGGER unexpected AFTER UPDATE ON receipts BEGIN DELETE FROM metadata; END")
            db.commit()
            db.close()
            with self.assertRaises(DeployError):
                recover_journal(path, services_stopped=True)


class FakeSystem:
    def __init__(self): self.events, self.stop_failure = [], False
    def stop(self, units):
        self.events.append("stop")
        if self.stop_failure: raise DeployError("stop_unknown", "fixture stop unknown")
    def start(self, units): self.events.append("start")
    def state(self, unit): return parse_unit_state(state())


class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.layout = Layout("fixture", Path(self.temp.name))
        mkdir(self.layout.config)
        mkdir(self.layout.state / "transactions")
        write_json(self.layout.config / "instance.json", {"port": 3000, "origin": "http://127.0.0.1:3000", "gatewayUid": 1, "gatewayGid": 1})
        self.system = FakeSystem()
        self.manager = Manager(self.layout, self.system, worker_gid=1)
        self.manager.require_service_ownership = lambda **kwargs: None  # Separate ownership fixtures exercise real units.
        self.manager.refresh_worker_unit = lambda: None
        self.current = "a" * 64
        self.manager.selected = lambda name="current": self.current
        self.manager.verify_release = lambda release: {"release": release}
        self.manager.recover_control = lambda: self.system.events.append("recover-control")
        def select(release, name="current"):
            self.system.events.append("select-" + name)
            if name == "current": self.current = release
        self.manager.select = select
        self.manager.healthy = lambda: self.system.events.append("health")

    def tearDown(self): self.temp.cleanup()

    def test_validation_failure_never_stops_the_old_service(self):
        def fail(release): raise DeployError("integrity", "fixture")
        self.manager.verify_release = fail
        with self.assertRaises(DeployError): self.manager.activate("b" * 64)
        self.assertEqual(self.system.events, [])

    def test_unconfirmed_stop_never_changes_pointer_or_recovery_barrier(self):
        self.system.stop_failure = True
        with self.assertRaises(DeployError): self.manager.activate("b" * 64)
        self.assertEqual(self.current, "a" * 64)
        self.assertEqual(self.system.events, ["stop"])
        self.assertTrue(list((self.layout.state / "transactions").glob("*/state.json")))

    def test_health_failure_confirms_stop_before_restoring_old_release(self):
        calls = 0
        def health():
            nonlocal calls
            calls += 1
            if calls == 1: raise DeployError("health", "fixture failed new service")
        self.manager.healthy = health
        with self.assertRaises(DeployError): self.manager.activate("b" * 64)
        self.assertEqual(self.current, "a" * 64)
        self.assertEqual(self.system.events, ["stop", "recover-control", "select-current", "start", "stop", "select-current", "select-previous", "start"])

    def test_unknown_recovery_stop_preserves_candidate_and_transaction(self):
        def health():
            self.system.stop_failure = True
            raise DeployError("health", "fixture")
        self.manager.healthy = health
        with self.assertRaises(DeployError): self.manager.activate("b" * 64)
        self.assertEqual(self.current, "b" * 64)
        saved = read_json(next((self.layout.state / "transactions").glob("*/state.json")))
        self.assertEqual(saved["phase"], "selected")

    def test_root_receipt_replays_without_running_mutation_twice(self):
        calls = []
        self.manager.restart = lambda: calls.append("restart") or {"restarted": True}
        operation = str(uuid.uuid4())
        request = {"method": "restart", "params": {}, "operationId": operation}
        first = self.manager.dispatch(request)
        self.assertEqual(self.manager.dispatch(request), first)
        self.assertEqual(calls, ["restart"])
        receipt = self.manager.dispatch({"method": "operation/read", "params": {"operationId": operation}})["result"]
        self.assertEqual(receipt["state"], "completed")
        self.assertEqual(receipt["requestDigest"], digest({"method": "restart", "params": {}}))
        with self.assertRaises(DeployError):
            self.manager.dispatch({**request, "params": {"unexpected": True}})

    def test_unexpected_interruption_keeps_running_receipt_unknown(self):
        def interrupted(): raise OSError("fixture interrupted after boundary")
        self.manager.restart = interrupted
        operation = str(uuid.uuid4())
        request = {"method": "restart", "params": {}, "operationId": operation}
        with self.assertRaises(OSError): self.manager.dispatch(request)
        result = self.manager.dispatch(request)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["delivery"], "unknown")

    def test_invalid_mutation_has_no_durable_unknown_receipt(self):
        operation = str(uuid.uuid4())
        with self.assertRaises(DeployError):
            self.manager.dispatch({"method": "restart", "params": {"command": "forbidden"}, "operationId": operation})
        self.assertFalse((self.layout.state / "receipts" / (operation + ".json")).exists())


class BoundaryTests(unittest.TestCase):
    def test_actual_dependency_command_disables_ancestor_workspace_and_hooks(self):
        project = Path.cwd() / ".work/isolated-dependency-fixture"
        command = pnpm_command(Path("/trusted/tools"), Path("/isolated/store"), project, project.parent / "metadata")
        self.assertEqual(command[2:5], ["--dir", str(project), "--workspace-root"])
        self.assertNotIn("--ignore-workspace", command)
        self.assertIn("--config.ignore-pnpmfile=true", command)
        self.assertIn("--config.manage-package-manager-versions=false", command)
        self.assertIn("--config.package-import-method=copy", command)
        self.assertIn("--config.cache-dir=" + str(project.parent / "metadata"), command)
        self.assertEqual(command[-2:], ["--store-dir", str(Path("/isolated/store"))])

    def test_units_have_distinct_worker_token_and_ipc_groups(self):
        layout = Layout("fixture")
        units = render_units(layout, {"origin": "http://127.0.0.1:3000", "port": 3000, "workerGid": 1002}, "vendor/fixture/bin/codex")
        worker, gateway = units[layout.unit("worker")], units[layout.unit("gateway")]
        self.assertIn("User=ch-fixture-control", worker)
        self.assertIn("\nGroup=ch-fixture-ipc\n", worker)
        self.assertIn("SupplementaryGroups=ch-fixture-control ch-fixture-worker", worker)
        self.assertNotIn("ExecStartPre=", worker)
        self.assertIn("Group=ch-fixture-gateway", gateway)
        self.assertIn("SupplementaryGroups=ch-fixture-ipc", gateway)
        self.assertNotIn("HARNESS_TOKEN_FILE=", worker)
        self.assertIn("NoNewPrivileges=no", worker)
        self.assertIn("--disable-sigusr1", worker)
        self.assertIn("HARNESS_NATIVE_USER=ch-fixture-worker", worker)
        rule = sudo_rule(layout)
        self.assertIn("manage rpc", rule)
        self.assertNotIn("*", rule)
        self.assertIn("ALL=(ch-fixture-worker)", rule)
        self.assertNotIn("ch-fixture-worker ALL=", rule)

    def test_real_current_dependency_inputs_pass_and_hook_resolution_fails(self):
        source = Path(__file__).resolve().parents[2]
        package, lock, workspace = dependency_input(source)
        self.assertTrue(package["dependencies"])
        self.assertNotIn("scripts", package)
        self.assertEqual(workspace, WORKSPACE_SETTINGS)
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder)
            (target / "package.json").write_bytes((source / "package.json").read_bytes())
            (target / "pnpm-workspace.yaml").write_bytes((source / "pnpm-workspace.yaml").read_bytes())
            (target / "pnpm-lock.yaml").write_text(lock + "\n  injected: {tarball: https://untrusted.invalid/code.tgz}\n")
            with self.assertRaises(DeployError): dependency_input(target)

    def test_workspace_rejects_hooks_catalogs_external_paths_and_unreviewed_overrides(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder)
            examples = [
                {**WORKSPACE_SETTINGS, "pnpmfile": "evil.cjs"},
                {**WORKSPACE_SETTINGS, "packages": [".."]},
                {**WORKSPACE_SETTINGS, "catalog": {"zod": "4.6.7"}},
                {**WORKSPACE_SETTINGS, "configDependencies": {"evil": "1.0.0"}},
                {**WORKSPACE_SETTINGS, "overrides": {**APPROVED_OVERRIDES, "ws": "8.22.0"}},
                {**WORKSPACE_SETTINGS, "overrides": {**APPROVED_OVERRIDES, "zod": "https://untrusted.invalid/zod.tgz"}},
                {**WORKSPACE_SETTINGS, "overrides": {**APPROVED_OVERRIDES, "zod": "^4.6.7"}},
                {**WORKSPACE_SETTINGS, "ignoreScripts": False},
                {**WORKSPACE_SETTINGS, "minimumReleaseAge": 0},
                {**WORKSPACE_SETTINGS, "blockExoticSubdeps": 1},
            ]
            for example in examples:
                with self.subTest(example=example):
                    write_json(target / "pnpm-workspace.yaml", example)
                    with self.assertRaises(DeployError): dependency_workspace(target)
            (target / "pnpm-workspace.yaml").write_text('{"packages":["."],"packages":["../evil"]}')
            with self.assertRaises(DeployError): dependency_workspace(target)
            (target / "pnpm-workspace.yaml").write_text("x" * 16385)
            with self.assertRaises(DeployError): dependency_workspace(target)

    def test_lock_overrides_cannot_diverge_from_the_reviewed_workspace(self):
        source = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder)
            for name in ("package.json", "pnpm-workspace.yaml"):
                (target / name).write_bytes((source / name).read_bytes())
            lock = (source / "pnpm-lock.yaml").read_text()
            for changed in (lock.replace("  zod: 4.6.7", "  zod: 3.25.76"),
                            lock.replace("  zod: 4.6.7", "  zod: 4.6.7\n  zod: 4.6.7"),
                            lock.replace("overrides:\n", "overrides:\n  ws: 8.22.0\n")):
                (target / "pnpm-lock.yaml").write_text(changed)
                with self.assertRaises(DeployError): dependency_input(target)

    def test_source_archive_includes_the_reviewed_workspace(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "source"
            source.mkdir()
            write_json(source / "package.json", {"name": "fixture"})
            write_json(source / "pnpm-workspace.yaml", WORKSPACE_SETTINGS)
            archive = root / "source.tgz"
            pack_source(source, archive)
            with tarfile.open(archive) as packed:
                self.assertIn("pnpm-workspace.yaml", packed.getnames())
                self.assertEqual(json.load(packed.extractfile("pnpm-workspace.yaml")), WORKSPACE_SETTINGS)


class ReadinessTests(unittest.TestCase):
    def test_gateway_http_success_cannot_mask_disconnected_worker(self):
        with tempfile.TemporaryDirectory() as folder:
            layout = Layout("fixture", Path(folder))
            mkdir(layout.config)
            write_json(layout.config / "instance.json", {"port": 3000, "origin": "http://127.0.0.1:3000"})
            system = FakeSystem()
            system.state = lambda unit: parse_unit_state(state(active="active", sub="running", pid="123"))
            manager = Manager(layout, system, worker_gid=1)
            connected = False
            def connection(host, *args, **kwargs):
                client = MagicMock()
                response = client.getresponse.return_value
                response.status = 200
                response.read.side_effect = lambda limit: json.dumps({"ok": True, "result": {"connected": connected}} if host == "localhost" else {"ok": True}).encode()
                return client
            with patch("deploy.manager.http.client.HTTPConnection", side_effect=connection), patch("deploy.manager.socket.socket"), patch("deploy.manager.socket.AF_UNIX", 1, create=True), patch("deploy.manager.time.sleep"):
                with self.assertRaises(DeployError): manager.healthy()
                connected = True
                manager.healthy()


class NativeLauncherTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == "linux", "Linux pipe backpressure and subreaper")
    def test_native_bridge_backpressures_without_losing_large_protocol_frames(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            fixture = root / "slow.py"
            # Saturation alone must not start the two-second EOF deadline:
            # this writer remains open while the native reader pauses longer.
            fixture.write_text("import sys,time,hashlib\ntime.sleep(3)\ndata=sys.stdin.buffer.read()\nprint(hashlib.sha256(data).hexdigest())\n")
            driver = "from deploy.native_launcher import security_process,supervise\nimport sys\nsecurity_process()\nraise SystemExit(supervise([sys.executable,sys.argv[1]], {'PATH':'/usr/bin:/bin'}, sys.argv[2], streaming=True))\n"
            command = [sys.executable, "-c", driver, str(fixture), str(root)]
            if os.geteuid() == 0:
                command = ["/usr/bin/setpriv", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", *command]
            payload = b"protocol-frame\n" * 900000
            result = subprocess.run(command, input=payload, timeout=15, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertEqual(result.stdout.decode().strip(), hashlib.sha256(payload).hexdigest())

    def test_project_resolution_is_bounded_and_checks_directory_as_caller(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            self.assertEqual(project_from_input(json.dumps({"path": str(root)}).encode())["path"], str(root))
            file = root / "ordinary-file"
            file.write_text("fixture")
            for value in ({"path": str(file)}, {"path": "relative"}, {"path": str(root), "command": "forbidden"}):
                with self.assertRaises(DeployError): project_from_input(json.dumps(value).encode())
            with self.assertRaises(DeployError): project_from_input(b"x" * 4097)

    @unittest.skipUnless(sys.platform == "linux", "Linux subreaper/process groups")
    def test_native_supervision_reaps_descendant_that_escaped_its_process_group(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            pidfile = root / "descendant-pid"
            fixture = root / "native.py"
            fixture.write_text("import subprocess,sys\nfrom pathlib import Path\nchild=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'],start_new_session=True)\nPath(sys.argv[1]).write_text(str(child.pid))\n")
            driver = "from deploy.native_launcher import security_process,supervise\nimport sys\nsecurity_process()\nraise SystemExit(supervise([sys.executable,sys.argv[1],sys.argv[2]], {'PATH':'/usr/bin:/bin'}, sys.argv[3], streaming=False))\n"
            command = [sys.executable, "-c", driver, str(fixture), str(pidfile), str(root)]
            if os.geteuid() == 0:
                command = ["/usr/bin/setpriv", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", *command]
            result = subprocess.run(command, timeout=10, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertFalse(Path("/proc", pidfile.read_text()).exists())


class CatalogDiscoveryTests(unittest.TestCase):
    def test_ids_do_not_inherit_unverified_capabilities(self):
        models = parse_ids(json.dumps({"data": [{"id": "fixture-model", "defaultEffort": "high", "inputModalities": ["image"]}]}).encode())
        self.assertEqual(models, [{"id": "fixture-model", "defaultEffort": None, "efforts": []}])
        for body in (b"not json", b'{"data":[],"has_more":true}', b'{"data":[{"id":"x"},{"id":"x"}]}', b"x" * (1024*1024+1)):
            with self.assertRaises(DeployError): parse_ids(body)

    def test_local_no_auth_discovery_and_redirect_rejection(self):
        seen = []
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append((self.path, self.headers.get("Authorization")))
                if self.path.startswith("/redirect"):
                    self.send_response(302); self.send_header("Location", "/target"); self.end_headers()
                else:
                    body = b'{"data":[{"id":"fixture-local-model"}]}'
                    self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
            def log_message(self, *args): pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            endpoint = "http://127.0.0.1:" + str(server.server_port)
            models = fetch_ids({"kind": "responses", "baseUrl": endpoint + "/v1", "apiKey": ""})
            self.assertEqual(models[0]["id"], "fixture-local-model")
            self.assertEqual(seen, [("/v1/models", None)])
            with self.assertRaises(DeployError):
                fetch_ids({"kind": "responses", "baseUrl": endpoint + "/redirect", "apiKey": "fixture", "allowInsecureHttp": True})
            self.assertEqual(len(seen), 2)
            self.assertNotIn("/target", [path for path, _ in seen])
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == "__main__":
    unittest.main()
