"""Root-only retention boundaries with synthetic files and substituted units."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from deploy.common import DeployError, Layout, atomic_write, write_json


@unittest.skipUnless(os.name == 'posix' and os.geteuid() == 0, 'Requires POSIX root ownership')
class CrossAuditOperations(unittest.TestCase):
    @unittest.skipUnless(sys.platform == "linux", "DNS archive inspection requires Linux mountinfo")
    def test_dns_archive_retains_complete_tree_and_refuses_unknown_stop(self):
        from deploy.dns_archive import archive
        with tempfile.TemporaryDirectory(dir='/root') as temporary:
            layout = Layout('offlinefixture', Path(temporary))
            identity = 'a' * 32
            source = layout.work / ('dns-build-' + identity); source.mkdir(parents=True)
            (source / 'build.ext4').write_bytes(b'opaque unmounted evidence')
            manager = SimpleNamespace(layout=layout, system=Mock(), require_recovered_transactions=Mock(),
                                      require_service_ownership=Mock(), verify=Mock())
            manager.system.state.return_value = {'stopped': False}
            with self.assertRaises(DeployError) as caught:
                archive(manager, identity, confirm=True)
            self.assertEqual(caught.exception.code, 'stop_unknown')
            self.assertTrue(source.is_dir())
            manager.system.state.return_value = {'stopped': True}
            with patch('deploy.dns_archive.run', return_value=SimpleNamespace(stdout='')):
                result = archive(manager, identity, confirm=True)
                replay = archive(manager, identity, confirm=True)
            self.assertEqual(result['archive'], replay['archive'])
            self.assertFalse(source.exists())
            self.assertEqual((Path(result['archive']) / 'build.ext4').read_bytes(), b'opaque unmounted evidence')
            self.assertTrue(all('offlinefixture-dns-' in call.args[0][0] for call in manager.system.stop.call_args_list))

    def test_retained_dns_and_proxy_credentials_are_exactly_collected(self):
        from deploy.diagnostic_secrets import retained_secrets
        with tempfile.TemporaryDirectory() as temporary:
            layout = Layout('offlinefixture', Path(temporary)); layout.config.mkdir(parents=True)
            atomic_write(layout.config / 'gateway-token', b'test-token', 0o600)
            dns = layout.config / 'dns' / ('a' * 32); dns.mkdir(parents=True)
            atomic_write(dns / 'credentials.env', b'CLOUDFLARE_API_TOKEN=old-fixture-secret\n', 0o600)
            proxy = layout.config / 'proxy/configurations' / ('b' * 64); proxy.mkdir(parents=True)
            write_json(proxy / 'xray.json', {'outbounds': [{'settings': {'id': 'fake-proxy-id', 'secret': 'fake-proxy-secret'}}]}, mode=0o600)
            values = retained_secrets(layout)
            self.assertIn('old-fixture-secret', values)
            self.assertIn('fake-proxy-id', values)
            self.assertIn('fake-proxy-secret', values)
