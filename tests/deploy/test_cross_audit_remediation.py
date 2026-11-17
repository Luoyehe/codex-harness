"""Regression coverage for the verified cross-audit boundaries (offline only)."""
import json
import os
import tempfile
import tomllib
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from deploy.common import DeployError, Layout, canonical, write_json
from deploy.manager import Manager
from deploy.provider import quote_toml, redacted
from deploy.provider_registry import change
from deploy.workspace_worktrees import ref


class CrossAuditContracts(unittest.TestCase):
    def test_toml_del_and_unicode_round_trip(self):
        value = '目录\\name\x7f\t"value'
        self.assertEqual(tomllib.loads('value = ' + quote_toml(value))['value'], value)

    def test_new_provider_requires_an_explicit_kind(self):
        with self.assertRaises(DeployError):
            change({'expectedRevision': 'a' * 32, 'providerId': 'new', 'name': 'New'}, {'revision': 'a' * 32, 'kind': 'chatgpt', 'models': []})

    def test_unicode_underscore_and_plus_refs_are_supported(self):
        for name in ('refs/heads/_draft', 'refs/heads/功能/修复+甲', 'refs/tags/v2+stable'):
            self.assertEqual(ref(name), name)
        for name in ('refs/heads/a..b', 'refs/heads/.secret', 'refs/heads/a@{1}', 'refs/heads/trailing.', 'refs/heads/a\\b'):
            with self.assertRaises(DeployError): ref(name)

    def test_public_catalog_does_not_duplicate_private_instructions(self):
        source = {'revision': 'a' * 32, 'kind': 'responses', 'apiKey': 'secret', 'models': [{'id': 'model', 'instructions': 'private' * 100000, 'supportsTools': True}]}
        result = redacted(source)
        self.assertNotIn('instructions', result['models'][0])
        self.assertTrue(result['models'][0]['supportsTools'])
        self.assertIn('instructions', source['models'][0])

    def test_oversized_completed_legacy_receipt_is_compacted_without_rewriting_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'receipt.json'
            source = {'state': 'completed', 'method': 'provider/write', 'operationId': str(uuid.uuid4()), 'requestDigest': 'f' * 64, 'result': {'revision': 'a' * 32, 'models': [{'instructions': 'x' * 2_000_000}]}}
            write_json(path, source)
            before = path.read_bytes()
            result = Manager.__new__(Manager).read_receipt(path)
            self.assertEqual(result['result'], {'revision': 'a' * 32})
            self.assertEqual(result['requestDigest'], source['requestDigest'])
            self.assertEqual(path.read_bytes(), before)

    def test_sudo_invalid_candidate_cannot_replace_published_policy(self):
        from deploy.sudo_publish import publish
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'policy'
            path.write_bytes(b'original')
            with patch('deploy.sudo_publish.run', side_effect=DeployError('command_failed', 'invalid')), self.assertRaises(DeployError):
                publish(path, b'invalid')
            self.assertEqual(path.read_bytes(), b'original')
            self.assertEqual([item.name for item in path.parent.iterdir()], ['policy'])

    def test_hsts_and_edge_identity_are_explicit(self):
        from deploy.https import render_caddy
        plain = render_caddy('example.test', None, 3300, 9091, tls='internal', http_port=18081, https_port=18443)
        enabled = render_caddy('example.test', None, 3300, 9091, tls='acme', http_port=18081, https_port=18443, client_identity=True, hsts=True)
        self.assertNotIn('Strict-Transport-Security', plain)
        self.assertIn('Strict-Transport-Security', enabled)
        self.assertIn('header_up X-Harness-Client-IP {remote_host}', enabled)
        self.assertIn('{$HARNESS_EDGE_PROXY_TOKEN}', enabled)

    def test_proxy_ports_reject_the_adjacent_gateway_before_probing(self):
        from deploy.service_proxy import require_available_ports
        with tempfile.TemporaryDirectory() as directory:
            manager = SimpleNamespace(config={'port': 3300}, layout=Layout('fixture', Path(directory)))
            with patch('deploy.service_proxy.socket.socket') as socket, self.assertRaises(DeployError) as caught:
                require_available_ports(manager, 3299)
            self.assertEqual(caught.exception.code, 'port_conflict')
            socket.assert_not_called()

    def test_ipv6_disabled_host_is_rejected_before_proxy_installation(self):
        from deploy.service_proxy import prerequisites
        with patch('deploy.service_proxy.socket.socket', side_effect=OSError('IPv6 disabled')), self.assertRaises(DeployError) as caught:
            prerequisites()
        self.assertEqual(caught.exception.code, 'proxy_unsupported')

    def test_missing_loopback_family_is_not_reported_as_an_occupied_port(self):
        import errno
        from deploy.service_proxy import require_available_ports
        with tempfile.TemporaryDirectory() as directory:
            manager = SimpleNamespace(config={'port': 3300}, layout=Layout('fixture', Path(directory)))
            with patch('deploy.service_proxy.socket.socket', side_effect=OSError(errno.EAFNOSUPPORT, 'IPv6 disabled')), self.assertRaises(DeployError) as caught:
                require_available_ports(manager, 18800)
            self.assertEqual(caught.exception.code, 'proxy_unsupported')


@unittest.skipUnless(os.name == 'posix', 'Real Linux descriptors and renameat2')
class CrossAuditWorkspace(unittest.TestCase):
    def setUp(self):
        from tests.deploy import test_workspace as fixture
        self.fixture = fixture.WorkspaceFilesystemTests('test_binary_download_is_exact_bounded_and_requires_current_bytes')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)

    def test_repeated_no_effect_failures_do_not_exhaust_receipts(self):
        item = self.fixture.path / 'exists'
        item.write_text('unchanged')
        for _ in range(270):
            with self.assertRaises(DeployError) as caught:
                self.fixture.call('mkdir', {'path': 'exists'})
            self.assertEqual(getattr(caught.exception, 'delivery', None), 'not_sent')
        self.assertEqual(item.read_text(), 'unchanged')
        self.assertTrue(self.fixture.call('mkdir', {'path': 'new'})['ok'])

    def test_staged_terminal_receipt_recovers_without_reexecuting(self):
        from deploy.workspace_store import Record, recover_pending, read_record, write_new
        path = self.fixture.path / 'record'; path.mkdir(mode=0o700)
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            running = {'requestDigest': 'c' * 64, 'state': 'running'}
            Record(fd, str(uuid.uuid4())).save(running)
            completed = {**running, 'state': 'completed', 'response': {'ok': True, 'result': {'changed': True}}}
            write_new(fd, '.state-next', canonical(completed) + b'\n')
            recover_pending(fd)
            self.assertEqual(read_record(fd), completed)
            self.assertFalse((path / '.state-next').exists())
            write_new(fd, '.state-next', canonical({**running, 'state': 'failed'}) + b'\n')
            with self.assertRaises(DeployError): recover_pending(fd)
            self.assertEqual(read_record(fd), completed)
        finally: os.close(fd)

    def test_search_exclusions_are_explicit_and_reported(self):
        (self.fixture.path / 'node_modules').mkdir()
        (self.fixture.path / 'node_modules/target.txt').write_text('target')
        (self.fixture.path / 'target.txt').write_text('target')
        all_rows = self.fixture.call('search', {'query': 'target'})['result']
        selected = self.fixture.call('search', {'query': 'target', 'excludeNames': ['node_modules']})['result']
        self.assertEqual(len(all_rows['matches']), 2)
        self.assertEqual([row['path'] for row in selected['matches']], ['target.txt'])
        self.assertIn('node_modules', selected['excludedNames'])

    def test_receipt_query_publishes_preexisting_terminal_state_without_repeating_write(self):
        from deploy.workspace_store import private_directory, Record, write_new
        store = self.fixture.workspace.store
        identity = str(uuid.uuid4())
        parent = store.open(create=True)
        directory = private_directory(parent, identity, create=True)
        try:
            running = {'requestDigest': 'c' * 64, 'state': 'running'}
            Record(directory, identity).save(running)
            complete = {**running, 'state': 'completed', 'response': {'ok': True, 'result': {'created': True}}}
            write_new(directory, '.state-next', canonical(complete) + b'\n')
        finally:
            os.close(directory); os.close(parent)
        self.assertEqual(store.read(identity, recover=True), {'operationId': identity, **complete})
        self.assertEqual(list(self.fixture.path.iterdir()), [])


@unittest.skipUnless(os.name == 'posix', 'Real Linux Git worktrees')
class CrossAuditWorktrees(unittest.TestCase):
    def setUp(self):
        from tests.deploy import test_workspace_worktrees as fixture
        self.fixture = fixture.WorktreeFilesystemTests('test_create_is_detached_scoped_and_materializes_raw_blobs_without_filters_or_hooks')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)

    def test_generated_symlink_keeps_readable_identity_but_blocks_archive(self):
        current = self.fixture.create()
        target = Path(current['path']); (target / 'node_modules').mkdir()
        os.symlink('../file', target / 'node_modules/bin')
        read = self.fixture.read(current)
        self.assertIsNone(read['revision'])
        self.assertEqual(read['path'], current['path'])
        self.assertEqual(read['mutationUnavailable']['code'], 'unsafe_path')
        with self.assertRaises(DeployError): self.fixture.move('archive', current)
        self.assertTrue((target / 'file').exists())

    def test_clean_retirement_frees_active_slot_and_keeps_checkout(self):
        current = self.fixture.create()
        result = self.fixture.move('retire', current)
        self.assertTrue(result['retired']); self.assertTrue(result['retained'])
        self.assertEqual((Path(result['path']) / 'file').read_text(), 'base\n')
        self.assertFalse(Path(current['path']).exists())
        self.assertTrue(self.fixture.create()['created'])


@unittest.skipUnless(os.name == 'posix', 'Real Linux Git index')
class CrossAuditGitAttributes(unittest.TestCase):
    def test_info_attributes_block_raw_staging_without_running_filter(self):
        from tests.deploy.test_workspace_index import IndexFilesystemTests
        fixture = IndexFilesystemTests('test_stage_unstage_and_commit_only_selected_paths_preserve_worktree_and_other_index_entries')
        fixture.setUp(); self.addCleanup(fixture.doCleanups)
        (fixture.path / 'a').write_text('updated\n')
        (fixture.path / '.git/info/attributes').write_text('a filter=private\n')
        fixture.git('config', 'filter.private.clean', 'touch FILTER_WAS_EXECUTED')
        before = (fixture.path / '.git/index').read_bytes()
        with self.assertRaises(DeployError) as caught:
            fixture.stage(['a'])
        self.assertEqual(caught.exception.code, 'git_conversion_required')
        self.assertFalse((fixture.path / 'FILTER_WAS_EXECUTED').exists())
        self.assertEqual((fixture.path / '.git/index').read_bytes(), before)
