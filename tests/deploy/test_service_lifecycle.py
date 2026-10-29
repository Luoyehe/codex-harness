"""Portable admission checks for retained service restoration."""
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy.common import DeployError, Layout, write_json
from deploy.service_lifecycle import bindings, identity_state, read_record


class ServiceLifecycleAdmissionTests(unittest.TestCase):
    def test_retained_bindings_reject_changed_dns_material_before_service_restore(self):
        with tempfile.TemporaryDirectory() as folder:
            layout = Layout("fixture", Path(folder))
            layout.config.mkdir(parents=True)
            metadata = {"tls": "acme", "dnsProvider": "cloudflare"}
            write_json(layout.config / "https.json", metadata)
            manager = types.SimpleNamespace(layout=layout)
            with patch("deploy.https.read_https_metadata", return_value=metadata) as reader, \
                 patch("deploy.dns_tls.validate_dns_selection", side_effect=DeployError("integrity", "changed DNS material")) as validate:
                with self.assertRaisesRegex(DeployError, "changed DNS material"):
                    bindings(manager)
                reader.assert_called_once_with(layout)
                validate.assert_called_once_with(layout, metadata)

    def test_legacy_or_path_selected_markers_do_not_authorize_restoration(self):
        with tempfile.TemporaryDirectory() as folder:
            layout = Layout("fixture", Path(folder))
            layout.config.mkdir(parents=True)
            (layout.config / "uninstalled.json").write_text("{}")
            for marker in ({"servicesRemoved": True}, {"transaction": "../../foreign"}, {"transaction": "a" * 31}):
                with self.subTest(marker=marker), patch("deploy.service_lifecycle.read_private", return_value=marker) as reader:
                    with self.assertRaises(DeployError): read_record(layout)
                    self.assertEqual(reader.call_count, 1)

    def test_supplementary_membership_and_numeric_aliases_change_identity_binding(self):
        user = types.SimpleNamespace(pw_name="ch-fixture-worker", pw_uid=800, pw_gid=801, pw_dir="/worker", pw_shell="/usr/sbin/nologin")
        group = types.SimpleNamespace(gr_name=user.pw_name, gr_gid=801, gr_mem=[])
        users, groups = [user], [group]
        def lookup(items, field, name):
            for item in items:
                if getattr(item, field) == name: return item
            raise KeyError(name)
        with patch.dict("sys.modules", {"pwd": types.SimpleNamespace(getpwall=lambda: users, getpwnam=lambda name: lookup(users, "pw_name", name)),
                                         "grp": types.SimpleNamespace(getgrall=lambda: groups, getgrnam=lambda name: lookup(groups, "gr_name", name))}):
            layout = Layout("fixture")
            initial = identity_state(layout)
            groups.append(types.SimpleNamespace(gr_name="foreign", gr_gid=900, gr_mem=[user.pw_name]))
            self.assertNotEqual(identity_state(layout), initial)
            groups.pop()
            users.append(types.SimpleNamespace(pw_name="alias", pw_uid=800, pw_gid=900, pw_dir="/alias", pw_shell="/bin/sh"))
            self.assertNotEqual(identity_state(layout), initial)


if __name__ == "__main__": unittest.main()
