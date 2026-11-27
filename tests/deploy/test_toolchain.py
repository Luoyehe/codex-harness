"""Offline pin-selection fixtures; official download verification stays enabled in production."""
import io
import os
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from deploy import build
from deploy.common import DeployError, Layout, canonical, digest, mkdir, read_json, write_json
from deploy.safe_fs import inspect_tree
from deploy.system import System


def archive_for(url):
    if 'nodejs.org' in url:
        pieces = build.NODE_VERSION.split('.')
        files = {'include/node/node_version.h': '\n'.join('#define NODE_' + part + '_VERSION ' + value
                 for part, value in zip(('MAJOR', 'MINOR', 'PATCH'), pieces)) + '\n', 'bin/node': 'node fixture'}
    elif '/pnpm/' in url:
        files = {'package.json': canonical({'version': build.PNPM_VERSION}).decode(), 'bin/pnpm.cjs': 'pnpm fixture'}
    else:
        arch = 'arm64' if 'arm64.tgz' in url else 'x64'
        files = {'package.json': canonical({'version': build.CODEX_VERSION + '-linux-' + arch}).decode(), 'bin/codex': 'codex fixture'}
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w:gz') as archive:
        for name, content in files.items():
            data = content.encode()
            entry = tarfile.TarInfo('package/' + name)
            entry.mode, entry.size = (0o755 if name.startswith('bin/') else 0o644), len(data)
            archive.addfile(entry, io.BytesIO(data))
    return stream.getvalue()


class ToolchainTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.layout = Layout('fixture', Path(self.temp.name))
        self.builder = build.Builder(self.layout, Mock(), 1, 1)
        self.downloads = []
        self.addCleanup(patch.stopall)
        patch('deploy.build.architecture', return_value='x64').start()
        patch('deploy.build.download', side_effect=self.download).start()
        if os.geteuid() != 0:
            # Ordinary tests retain all tree checks except the root UID; the
            # same inherited cases run with unmodified root ownership below.
            patch('deploy.build.inspect_tree', side_effect=lambda path, **_: inspect_tree(path)).start()

    def download(self, url, path, expected, algorithm='sha256'):
        self.downloads.append((url, expected, algorithm))
        path.write_bytes(archive_for(url))

    def test_legacy_cli_cache_is_retained_and_current_generation_is_reused(self):
        legacy = self.layout.work / 'toolchain'
        mkdir(legacy)
        (legacy / 'old-cli-version').write_text('0.164.0')
        mkdir(self.layout.config)
        write_json(self.layout.config / 'toolchain-manifest.json', inspect_tree(legacy))
        old_record = (self.layout.config / 'toolchain-manifest.json').read_bytes()
        selected = self.builder.toolchain()
        self.assertEqual(selected, self.layout.work / 'toolchains' / digest(build.toolchain_spec('x64')) / 'runtime')
        self.assertEqual(read_json(selected / 'codex/package.json')['version'], '0.169.0-linux-x64')
        self.assertEqual(len(self.downloads), 3)
        self.assertEqual(self.builder.toolchain(), selected)
        self.assertEqual(len(self.downloads), 3)
        self.assertEqual((legacy / 'old-cli-version').read_text(), '0.164.0')
        self.assertEqual((self.layout.config / 'toolchain-manifest.json').read_bytes(), old_record)
        self.assertEqual(list(self.layout.work.glob('tools-*')), [])

    def test_version_architecture_and_distribution_digest_each_select_a_separate_generation(self):
        first = self.builder.toolchain()
        first_data = (first.parent / 'manifest.json').read_bytes()
        with patch('deploy.build.CODEX_VERSION', '0.170.0'):
            second = self.builder.toolchain()
        with patch('deploy.build.architecture', return_value='arm64'):
            third = self.builder.toolchain()
        with patch.dict('deploy.build.NODE_HASHES', {'x64': '1' * 64}):
            fourth = self.builder.toolchain()
        self.assertEqual(len({first, second, third, fourth}), 4)
        self.assertEqual((first.parent / 'manifest.json').read_bytes(), first_data)
        self.assertEqual(self.builder.toolchain(), first)
        self.assertEqual(len(self.downloads), 12)

    def test_tampered_selected_tree_refuses_download_or_replacement(self):
        selected = self.builder.toolchain()
        (selected / 'node/bin/node').write_text('changed')
        with self.assertRaises(DeployError) as raised:
            self.builder.toolchain()
        self.assertEqual(raised.exception.code, 'integrity')
        self.assertEqual(len(self.downloads), 3)
        self.assertEqual((selected / 'node/bin/node').read_text(), 'changed')

    def test_self_consistent_wrong_version_and_wrong_manifest_pins_are_rejected(self):
        selected = self.builder.toolchain()
        record_path = selected.parent / 'manifest.json'
        original = read_json(record_path)
        record = {**original, 'spec': {**original['spec'], 'architecture': 'arm64'}}
        write_json(record_path, record)
        with self.assertRaises(DeployError): self.builder.toolchain()
        write_json(selected / 'codex/package.json', {'version': '0.164.0-linux-x64'})
        write_json(record_path, {**original, 'tree': inspect_tree(selected)})
        with self.assertRaises(DeployError) as raised: self.builder.toolchain()
        self.assertEqual(raised.exception.code, 'integrity')
        self.assertEqual(len(self.downloads), 3)

    def test_interrupted_publication_retains_preparation_and_retry_uses_only_complete_generation(self):
        original_rename = os.rename
        def fail_publish(source, target):
            if Path(source).name == 'assembled': raise OSError('fixture publication interruption')
            return original_rename(source, target)
        with patch('deploy.build.os.rename', side_effect=fail_publish), self.assertRaises(OSError):
            self.builder.toolchain()
        retained = next(self.layout.work.glob('tools-*'))
        retained_bytes = (retained / 'assembled/manifest.json').read_bytes()
        self.assertEqual(list((self.layout.work / 'toolchains').iterdir()), [])
        selected = self.builder.toolchain()
        self.assertEqual((retained / 'assembled/manifest.json').read_bytes(), retained_bytes)
        self.assertTrue((selected / 'node/bin/node').is_file())
        self.assertEqual(len(self.downloads), 6)

    def test_post_rename_interruption_reuses_and_resyncs_published_generation(self):
        actual = build.fsync_directory
        def fail_parent(path):
            if path.name == 'toolchains': raise OSError('fixture directory sync interruption')
            return actual(path)
        with patch('deploy.build.fsync_directory', side_effect=fail_parent), self.assertRaises(OSError):
            self.builder.toolchain()
        selected = self.builder.toolchain()
        self.assertTrue((selected.parent / 'manifest.json').is_file())
        self.assertEqual(len(self.downloads), 3)

    def test_wrong_archive_version_is_rejected_before_publication(self):
        def wrong_version(url, path, expected, algorithm='sha256'):
            with patch('deploy.build.CODEX_VERSION', '0.164.0'):
                path.write_bytes(archive_for(url))
        with patch('deploy.build.download', side_effect=wrong_version), self.assertRaises(DeployError):
            self.builder.toolchain()
        self.assertEqual(list((self.layout.work / 'toolchains').iterdir()), [])

    def test_isolated_path_uses_exact_selected_node_and_never_legacy_cache(self):
        selected = self.builder.toolchain()
        system = System()
        with patch('deploy.system.run') as run, patch.object(system, 'stop'):
            system.isolated(self.layout, 'fixture', ['node', '--version'], self.layout.work, self.layout.work,
                            network=False, toolchain=selected)
        command = run.call_args.args[0]
        self.assertIn('PATH=' + str(selected / 'node/bin') + ':/usr/bin:/bin', command)
        self.assertNotIn('PATH=' + str(self.layout.work / 'toolchain/node/bin') + ':/usr/bin:/bin', command)
        with patch('deploy.system.run') as run, self.assertRaises(DeployError):
            system.isolated(self.layout, 'fixture', ['node'], self.layout.work, self.layout.work,
                            network=False, toolchain=self.layout.work / 'toolchain')
        run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
