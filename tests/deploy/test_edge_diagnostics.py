"""The operator sees edge failures even while systemd reports active."""
import os
import io
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from deploy.common import DeployError, Layout, atomic_write, write_json
from deploy.https import caddy_configuration
from deploy.manager import Manager
from deploy.units import render_edge_units


class EdgeDiagnosticsTests(unittest.TestCase):
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

    def test_status_reports_edge_failure_independently_of_active_process(self):
        self.edge()
        failure = {'configured': True, 'ready': False, 'failure': 'certificate_validation_failed'}
        with patch('deploy.https_health.https_health', return_value=failure) as check:
            status = self.manager.status()
        self.assertEqual(status['services']['caddy']['ActiveState'], 'active')
        self.assertFalse(status['https']['ready'])
        check.assert_called_once_with(self.manager, connect_address='127.0.0.1', timeout=3)

    def test_unconfigured_edge_is_explicit_and_never_queries_an_unrelated_caddy_unit(self):
        status = self.manager.status()
        self.assertFalse(status['https']['configured'])
        self.assertEqual(status['https']['failure'], 'not_configured')
        self.assertNotIn('caddy', status['services'])
        self.assertFalse(self.manager.verify_https()['configured'])




    def test_lifecycle_repair_rejects_before_stopping_any_service(self):
        (self.layout.state / 'transactions/fixture').mkdir(parents=True)
        write_json(self.layout.state / 'transactions/fixture/state.json', {'kind': 'service-lifecycle', 'phase': 'prepared'})
        for target in ('old', 'candidate'):
            with self.assertRaisesRegex(DeployError, 'restore-services'):
                self.manager.repair(target=target)
        self.manager.system.stop.assert_not_called()

    def test_cli_rejects_unfinished_initialization_before_creating_a_management_lock(self):
        from deploy.cli import main
        for command in ('status', 'control-update', 'control-recover', 'restore-services'):
            with self.subTest(command=command), patch('deploy.cli.Layout', return_value=self.layout), \
                    patch('deploy.cli.require_linux'), patch('deploy.cli.exclusive') as lock, \
                    patch('deploy.transactions.require_initialization_complete', side_effect=DeployError('initialization_pending', 'Use install-resume')), \
                    patch('sys.stderr', new_callable=io.StringIO), self.assertRaises(SystemExit):
                main([command])
            lock.assert_not_called()
        self.assertFalse((self.layout.config / 'management.lock').exists())

    def test_only_fixed_edge_log_unit_is_allowed_and_known_secrets_are_redacted(self):
        atomic_write(self.layout.config / 'gateway-token', b'fixture-secret')
        profiles = self.layout.state / 'providers'
        profiles.mkdir(parents=True)
        self.manager.providers = SimpleNamespace(root=profiles)
        self.manager.system.logs.return_value = 'diagnostic fixture-secret fixture-api-key'
        with patch('deploy.provider_lifecycle.Profiles') as provider:
            provider.return_value.records.return_value = [{'settings': {'apiKey': 'fixture-api-key'}}]
            result = self.manager.dispatch({'method': 'logs', 'params': {'service': 'caddy', 'lines': 12}})
        self.assertTrue(result['ok'])
        self.assertEqual(result['result']['text'], 'diagnostic [redacted] [redacted]')
        self.manager.system.logs.assert_called_once_with(self.layout.unit('caddy'), 12)
        self.manager.system.logs.reset_mock()
        result = self.manager.dispatch({'method': 'logs', 'params': {'service': 'ssh'}})
        self.assertFalse(result['ok'])
        self.manager.system.logs.assert_not_called()


if __name__ == '__main__':
    unittest.main()
