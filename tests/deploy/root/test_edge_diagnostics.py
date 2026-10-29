"""The operator sees edge failures even while systemd reports active."""
import os
import hashlib
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from deploy.common import DeployError, Layout, atomic_write, write_json
from deploy.https import caddy_configuration
from deploy.manager import Manager
from deploy.units import render_edge_units


@unittest.skipUnless(os.name == "posix" and os.geteuid() == 0, "Requires Linux root fixtures")
class EdgeConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.layout = Layout('edge-fixture', Path(self.temp.name))
        self.layout.config.mkdir(parents=True)
        self.layout.units.mkdir(parents=True)
        self.manager = Manager.__new__(Manager)
        self.manager.layout = self.layout
        self.manager.config = {'origin': 'https://edge.invalid', 'port': 3300}
        self.manager.selected = Mock(return_value=None)
        self.manager.system = Mock()
        self.manager.system.state.return_value = {'ActiveState': 'active', 'SubState': 'running', 'MainPID': '123'}
        self.metadata = {'host': 'edge.invalid', 'tls': 'acme', 'httpPort': 80, 'httpsPort': 443,
                         'authentication': 'builtin', 'phase': 'active'}


    def edge(self):
        write_json(self.layout.config / 'https.json', self.metadata)
        atomic_write(self.layout.config / 'Caddyfile', caddy_configuration(self.layout, self.manager.config, self.metadata).encode())
        unit = self.layout.unit('caddy')
        atomic_write(self.layout.units / unit, render_edge_units(self.layout, builtin=True)[unit].encode(), 0o644)
        self.manager.require_service_ownership = Mock()


    def test_changed_caddy_routes_fail_before_health_probe(self):
        self.edge()
        (self.layout.config / 'Caddyfile').write_text('https://edge.invalid { reverse_proxy 127.0.0.1:9999 }')
        with patch('deploy.https_health.https_health') as check, self.assertRaises(DeployError):
            self.manager.verify_https()
        check.assert_not_called()


    def test_preserving_stopped_edge_checks_config_without_attempting_tls(self):
        self.edge()
        with patch('deploy.https_health.https_health') as check:
            result = self.manager.verify_https(probe=False)
        self.assertFalse(result['ready'])
        self.assertEqual(result['failure'], 'not_probed')
        check.assert_not_called()
        (self.layout.config / 'Caddyfile').write_text('unrelated')
        with self.assertRaises(DeployError):
            self.manager.verify_https(probe=False)

    def test_stopped_verification_rejects_wrong_origin_or_modified_provided_material(self):
        self.edge()
        self.manager.config['origin'] = 'https://unrelated.invalid'
        with self.assertRaisesRegex(DeployError, 'origin'):
            self.manager.verify_https(probe=False)
        self.manager.config['origin'] = 'https://edge.invalid'
        pem_root = self.layout.config / 'tls'
        pem_root.mkdir()
        certificate = b'-----BEGIN CERTIFICATE-----\nfixture certificate\n'
        private_key = b'-----BEGIN ' + b'PRIVATE KEY-----\nfixture key\n'
        atomic_write(pem_root / 'certificate.pem', certificate)
        atomic_write(pem_root / 'private-key.pem', private_key)
        self.metadata.update(tls='provided', certificateSha256=hashlib.sha256(certificate).hexdigest(),
                             privateKeySha256=hashlib.sha256(private_key).hexdigest())
        self.edge()
        self.assertEqual(self.manager.verify_https(probe=False)['failure'], 'not_probed')
        with patch('deploy.https.tls_ca_path', side_effect=DeployError('integrity', 'Retained CA changed')):
            with self.assertRaisesRegex(DeployError, 'Retained CA changed'):
                self.manager.verify_https(probe=False)
        atomic_write(pem_root / 'private-key.pem', private_key, 0o644)
        with self.assertRaisesRegex(DeployError, 'Unsafe retained'):
            self.manager.verify_https(probe=False)
        atomic_write(pem_root / 'private-key.pem', private_key + b'changed')
        with self.assertRaisesRegex(DeployError, 'Retained TLS material changed'):
            self.manager.verify_https(probe=False)


    def test_verify_rejects_invalid_tls_or_legacy_identity_even_if_edge_is_active(self):
        self.edge()
        for failure in ('certificate_validation_failed', 'legacy_identity_requires_migration', 'instance_proof_failed'):
            with self.subTest(failure=failure), patch('deploy.https_health.https_health', return_value={
                    'configured': True, 'ready': False, 'failure': failure}):
                with self.assertRaises(DeployError) as caught:
                    self.manager.verify_https()
                self.assertEqual(caught.exception.code, 'https_health')
                self.assertIn(failure, str(caught.exception))


if __name__ == '__main__':
    unittest.main()
