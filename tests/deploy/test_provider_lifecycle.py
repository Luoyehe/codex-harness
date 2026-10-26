import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from deploy.common import DeployError, Layout, mkdir, write_json
from deploy.manager import Manager
from deploy.provider import ProviderStore, redacted
from deploy.provider_lifecycle import Profiles, collect_generations


class ProviderProfilesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.layout = Layout('fixture', Path(self.temp.name))
        mkdir(self.layout.config)
        self.profiles = Profiles(self.layout)
        self.store = ProviderStore(self.layout, 1)
        self.current = {'revision': 'a' * 32, 'kind': 'responses', 'baseUrl': 'https://example.invalid/v1',
                        'model': 'fixture-model', 'apiKey': 'profile-' + 'opaque', 'models': []}

    def test_profile_restores_entire_bound_endpoint_without_exposing_key(self):
        self.profiles.save('Test endpoint', self.current)
        profile = self.profiles.public()[0]
        self.assertNotIn('apiKey', profile)
        self.assertTrue(profile['hasApiKey'])
        different = {'revision': 'b' * 32, 'kind': 'chatgpt', 'models': []}
        action, restored = self.store.validate_change({'expectedRevision': different['revision'], 'profileId': profile['id']}, different)
        self.assertEqual(action, 'provider')
        self.assertEqual(restored['apiKey'], self.current['apiKey'])
        self.assertEqual(restored['baseUrl'], self.current['baseUrl'])
        self.assertNotEqual(restored['revision'], self.current['revision'])
        for extra in ({'baseUrl': 'https://different.invalid/v1'}, {'apiKey': ''}, {'kind': 'responses'}, {'saveProfileName': 'Other'}):
            with self.subTest(extra=extra), self.assertRaises(DeployError):
                self.store.validate_change({'expectedRevision': different['revision'], 'profileId': profile['id'], **extra}, different)

    def test_profile_names_are_immutable_and_capacity_can_be_released_explicitly(self):
        self.profiles.save('Primary', self.current)
        first = self.profiles.public()[0]
        with self.assertRaises(DeployError):
            self.profiles.save('Primary', {**self.current, 'baseUrl': 'https://different.invalid/v1'})
        for i in range(15):
            self.profiles.save('Additional ' + str(i), self.current)
        with self.assertRaises(DeployError):
            self.profiles.save('Over budget', self.current)
        self.profiles.remove(first['id'])
        self.profiles.save('Primary', self.current)
        self.assertEqual(len(self.profiles.public()), 16)
        with self.assertRaises(DeployError):
            self.profiles.read(first['id'])

    def test_profile_actions_recheck_current_revision(self):
        self.profiles.save('Primary', self.current)
        identity = self.profiles.public()[0]['id']
        for action in ({'profileId': identity}, {'saveProfileName': 'Secondary'}, {'deleteProfileId': identity}):
            with self.subTest(action=action), self.assertRaises(DeployError) as caught:
                self.store.validate_change({'expectedRevision': 'b' * 32, **action}, self.current)
            self.assertEqual(caught.exception.code, 'revision_conflict')

    def test_profile_names_allow_64_unicode_characters_without_crossing_byte_budget(self):
        for name in ('中' * 64, '🌟' * 64):
            self.profiles.save(name, self.current)
            self.assertIn(name, [profile['name'] for profile in self.profiles.public()])
        for name in ('中' * 65, '🌟' * 65, 'x' * 65, 'bad\x7fname', 'bad\nname'):
            with self.subTest(name=name), self.assertRaises(DeployError): self.profiles.validate_save(name)

    def test_profile_save_and_delete_do_not_restart_services_or_change_current_provider(self):
        write_json(self.layout.config / 'instance.json', {'port': 3300, 'origin': 'http://127.0.0.1:3300'})
        system = Mock()
        manager = Manager(self.layout, system, worker_gid=1)
        manager.require_recovered_transactions = lambda _value: None
        manager.require_service_ownership = lambda: None
        manager.providers.read = lambda: self.current
        saved = manager.provider_change({'expectedRevision': self.current['revision'], 'saveProfileName': 'Primary'})
        removed = manager.provider_change({'expectedRevision': self.current['revision'], 'deleteProfileId': saved['profiles'][0]['id']})
        self.assertEqual(removed['profiles'], [])
        self.assertEqual(saved['revision'], self.current['revision'])
        system.stop.assert_not_called()
        system.start.assert_not_called()

    def test_public_settings_and_logs_exclude_saved_credentials_and_unreviewed_fields(self):
        self.assertNotIn('futureSecret', redacted({**self.current, 'futureSecret': 'must not escape'}))
        self.profiles.save('Saved', self.current)
        write_json(self.layout.config / 'instance.json', {'port': 3300, 'origin': 'http://127.0.0.1:3300'})
        (self.layout.config / 'gateway-token').write_text('fixture-gateway-token')
        generation = self.layout.config / 'providers' / ('b' * 32)
        mkdir(generation)
        longer = self.current['apiKey'] + '-suffix'
        write_json(generation / 'settings.json', {**self.current, 'apiKey': longer})
        system = Mock()
        system.logs.return_value = 'fixture-gateway-token ' + self.current['apiKey'] + ' ' + longer
        manager = Manager(self.layout, system, worker_gid=1)
        result = manager.dispatch({'method': 'logs', 'params': {}})
        self.assertEqual(result['result']['text'], '[redacted] [redacted] [redacted]')


@unittest.skipUnless(os.name == 'posix', 'Real Linux symlink generation pointers')
class ProviderRetentionTests(unittest.TestCase):
    def test_current_pending_recovery_and_recent_generations_are_retained(self):
        with tempfile.TemporaryDirectory() as folder:
            layout = Layout('fixture', Path(folder))
            root = layout.config / 'providers'
            mkdir(root)
            ids = [format(i, '032x') for i in range(9)]
            for i, identity in enumerate(ids):
                mkdir(root / identity)
                write_json(root / identity / 'settings.json', {'revision': identity})
                os.utime(root / identity, ns=(i + 1, i + 1))
            os.symlink(ids[0], root / 'current')
            tx = layout.state / 'transactions' / 'pending'
            mkdir(tx)
            write_json(tx / 'state.json', {'kind': 'config-layer', 'phase': 'prepared', 'oldProvider': ids[1], 'candidateProvider': ids[2]})
            result = collect_generations(layout, root)
            kept = {path.name for path in root.iterdir() if path.is_dir() and not path.is_symlink()}
            self.assertEqual(kept, {ids[0], ids[1], ids[2], *ids[-3:]})
            self.assertEqual(result['removed'], 3)
            self.assertEqual(os.readlink(root / 'current'), ids[0])

    def test_unexpected_material_refuses_cleanup_and_retired_cleanup_can_resume(self):
        with tempfile.TemporaryDirectory() as folder:
            layout = Layout('fixture', Path(folder))
            root = layout.config / 'providers'
            mkdir(root)
            for i in range(5):
                path = root / format(i, '032x')
                mkdir(path)
                write_json(path / 'settings.json', {})
                os.utime(path, ns=(i + 1, i + 1))
            unsafe = root / format(0, '032x')
            (unsafe / 'unrecognized').write_text('retain')
            # Adding the fixture must not accidentally promote this directory
            # into the recent-history set and bypass the intended removal path.
            os.utime(unsafe, ns=(1, 1))
            with self.assertRaises(DeployError):
                collect_generations(layout, root)
            self.assertTrue(unsafe.exists())
            (unsafe / 'unrecognized').unlink()
            retired = root / ('.retired-' + format(8, '032x'))
            mkdir(retired)
            write_json(retired / 'provider.env', {})
            collect_generations(layout, root)
            self.assertFalse(retired.exists())
            self.assertEqual(len([path for path in root.iterdir() if path.is_dir()]), 3)


if __name__ == '__main__':
    unittest.main()
