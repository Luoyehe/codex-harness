"""Offline TLS regressions: private fixtures, no service changes or listeners."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "deploy"))
import edge_tls as tls
import lifecycle


def fixture_helper():
    """Redirect only the shell helper's root path/identity into our fixture."""
    command, _unit, *args = sys.argv[3:]
    target = Path(os.environ["FIXTURE_TLS"])
    uid, gid = os.geteuid(), os.getegid()
    if command == "install":
        if not target.exists():
            tls._make_directory(target, uid, gid, 0o750)
        print(tls.install_managed(args[0], args[1], target, uid, gid))
    elif command == "snapshot":
        tls.snapshot_managed(target, args[0], uid, gid)
    elif command == "restore":
        tls.restore_managed(target, args[0], uid, gid)
    elif command == "remove":
        tls.remove_managed(target, uid, gid)
    elif command == "prune":
        tls.remove_managed(target, uid, gid, references=tls.referenced_paths(json.loads(Path(args[1]).read_text())))
    else:
        raise AssertionError(command)


class TLSFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="harness-tls-collection-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.target = self.base / "managed"
        self.uid, self.gid = os.geteuid(), os.getegid()
        tls._make_directory(self.target, self.uid, self.gid, 0o750)
        self.cert = self.base / "source-cert"
        self.key = self.base / "source-key"
        self.cert.write_text("fixture-certificate")
        self.key.write_text("fixture-key")
        self.cert.chmod(0o644)
        self.key.chmod(0o600)

    def install(self):
        return Path(tls.install_managed(self.cert, self.key, self.target, self.uid, self.gid))

    def prune(self, config):
        tls.remove_managed(self.target, self.uid, self.gid, references=tls.referenced_paths(config))

    def state(self):
        return {str(p.relative_to(self.target)): (p.read_bytes(), p.stat().st_mode & 0o777)
                for p in self.target.rglob("*") if p.is_file()}


class CollectionTests(TLSFixture):
    def test_pair_identity_never_overwrites_retained_reference(self):
        first = self.install()
        self.cert.write_text("second-certificate")
        second = self.install()
        self.assertNotEqual(first, second)
        self.assertEqual((first / "cert.pem").read_text(), "fixture-certificate")
        self.prune({"apps": {"tls": {"certificates": {"load_files": [{"certificate": str(first / "cert.pem")}]}},
                             "http": {"route": {"path": ["/"]}}}})
        self.assertTrue((first / "key.pem").exists())
        self.assertFalse(second.exists())

    def test_legacy_and_all_new_pairs_roundtrip_after_prune_or_publication_failure(self):
        tls.install_pair(self.cert, self.key, self.target, self.uid, self.gid)
        first = self.install()
        second = self.install()
        # Preserve trusted incomplete legacy/new material as well as full pairs.
        (second / "key.pem").unlink()
        before = self.state()
        backup = self.base / "backup"
        tls.snapshot_managed(self.target, backup, self.uid, self.gid)
        for path in backup.rglob("*"):
            self.assertEqual(path.stat().st_mode & 0o777, 0o700 if path.is_dir() else 0o600)
        self.prune({"key": str(first / "key.pem")})
        self.install()
        tls.restore_managed(self.target, backup, self.uid, self.gid)
        self.assertEqual(self.state(), before)
        tls.remove_managed(self.target, self.uid, self.gid)
        self.assertFalse(self.target.exists())
        tls.restore_managed(self.target, backup, self.uid, self.gid)
        self.assertEqual(self.state(), before)

    def test_legacy_refs_symlinks_and_folder_loaders_are_retained(self):
        tls.install_pair(self.cert, self.key, self.target, self.uid, self.gid)
        pair = self.install()
        alias = self.base / "certificate-alias"
        alias.symlink_to(self.target / "cert.pem")
        self.prune({"certificate": str(alias)})
        self.assertTrue((self.target / "cert.pem").exists())
        self.assertFalse(pair.exists())
        pair = self.install()
        self.prune({"apps": {"tls": {"certificates": {"load_folders": [str(self.target)]}}}})
        self.assertTrue((self.target / "key.pem").exists())
        self.assertTrue(pair.exists())
        self.prune({})
        self.assertFalse(self.target.exists())

    def test_failed_import_removes_only_its_unpublished_directory(self):
        first = self.install()
        before = self.state()
        self.key.chmod(0o644)
        with self.assertRaises(ValueError):
            self.install()
        self.assertEqual(self.state(), before)
        self.assertEqual(list(self.target.iterdir()), [first])
        self.key.chmod(0o600)
        real_replace = tls.os.replace

        def fail_second_publish(src, dst, **kwargs):
            if dst == "key.pem":
                raise OSError("injected key publication failure")
            return real_replace(src, dst, **kwargs)

        with patch.object(tls.os, "replace", side_effect=fail_second_publish):
            with self.assertRaises(OSError):
                self.install()
        self.assertEqual(self.state(), before)
        self.assertEqual(list(self.target.iterdir()), [first])

    def test_inventory_rejects_unsafe_child_before_deleting_other_pairs(self):
        first = self.install()
        unsafe = self.target / ("pair-" + "0" * 32)
        unsafe.symlink_to(self.base, target_is_directory=True)
        with self.assertRaises((ValueError, OSError)):
            self.prune({})
        self.assertTrue((first / "key.pem").exists())
        unsafe.unlink()
        unsafe.mkdir(mode=0o750)
        os.mkfifo(unsafe / "key.pem", 0o640)
        with self.assertRaises(ValueError):
            self.prune({})
        self.assertTrue((first / "cert.pem").exists())

    def test_invalid_backup_is_rejected_before_published_material_is_removed(self):
        first = self.install()
        before = self.state()
        backup = self.base / "backup"
        tls.snapshot_managed(self.target, backup, self.uid, self.gid)
        (backup / first.name / "key.pem").write_bytes(b"")
        with self.assertRaises(ValueError):
            tls.restore_managed(self.target, backup, self.uid, self.gid)
        self.assertEqual(self.state(), before)

    def test_collection_budgets_reject_growth_without_changing_published_pairs(self):
        first = self.install()
        before = self.state()
        with patch.object(tls, "COLLECTION_PAIR_LIMIT", 1):
            with self.assertRaises(ValueError):
                self.install()
        total = sum(len(content) for content, _mode in before.values())
        with patch.object(tls, "COLLECTION_BYTE_LIMIT", total + 1):
            with self.assertRaises(ValueError):
                self.install()
        self.assertEqual(self.state(), before)
        self.assertEqual(list(self.target.iterdir()), [first])


CADDY = os.environ.get("CADDY_BIN") or shutil.which("caddy")


@unittest.skipUnless(CADDY and shutil.which("openssl") and shutil.which("bash"), "Caddy, OpenSSL and Bash required")
class CaddyTests(TLSFixture):
    def setUp(self):
        super().setUp()
        self.config = self.base / "Caddyfile"
        self.backup = self.base / "rollback"
        self.backup.mkdir(mode=0o700)
        self.env = {**os.environ, "HOME": str(self.base / "home"), "XDG_DATA_HOME": str(self.base / "data"),
                    "XDG_CONFIG_HOME": str(self.base / "config"), "SCRIPT_DIR": str(REPO / "deploy"),
                    "FIXTURE_TLS": str(self.target), "FIXTURE_HELPER": str(Path(__file__).resolve()),
                    "FIXTURE_PYTHON": sys.executable, "FIXTURE_CADDY": str(CADDY), "GATEWAY_UNIT": "fixture",
                    "CADDY_USER": "fixture", "CADDY_FILE": str(self.config), "RB_DIR": str(self.backup),
                    "AUTHELIA_ADDR": "127.0.0.1:9091", "GATEWAY_PORT": "8080", "LISTEN_PORT": "443",
                    "RB_TLS_PRESENT": "1", "FRESH_AUTHELIA": "0"}
        self.source = (REPO / "deploy/setup-edge.sh").read_text()
        self.site_function = re.search(r"(?ms)^site_block\(\) \{\n.*?^EOF\n\}\n", self.source).group()
        self.install_block = self.source[self.source.index('if [ "$TLS_MODE" = "own" ]; then\n  TLS_STATE_TOUCHED=1'):self.source.index("# --- 4. Authelia")]
        self.cleanup_block = self.source[self.source.index("# --- 6. validate + reload"):self.source.index("# --- 6.5 register")]
        self.shell_prefix = '''set -euo pipefail
log() { :; }
systemctl_do() { :; }
rollback() { exit 73; }
caddy() { "$FIXTURE_CADDY" "$@"; }
python3() {
  if [ "$2" = - ] || [ "${2##*/}" = lifecycle.py ]; then
    "$FIXTURE_PYTHON" "$@"
  else
    shift; "$FIXTURE_PYTHON" -I "$FIXTURE_HELPER" --helper "$@"
  fi
}
'''

    def make_pair(self, domain):
        cert, key = self.base / (domain + ".crt"), self.base / (domain + ".key")
        subprocess.run(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
                        "-nodes", "-days", "1", "-subj", "/CN=" + domain, "-addext", "subjectAltName=DNS:" + domain,
                        "-keyout", str(key), "-out", str(cert)], check=True, capture_output=True, timeout=20)
        key.chmod(0o600)
        return cert, key

    def shell(self, script, *, env=None, expected=0):
        result = subprocess.run(["bash", "-c", self.shell_prefix + script], env={**self.env, **(env or {})},
                                text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result.stdout

    def block(self, domain, line):
        return self.shell(self.site_function + "site_block", env={"DOMAIN": domain, "CERT_LINE": line})

    def add(self, domain, mode, pair=None):
        env = {"DOMAIN": domain, "TLS_MODE": mode, "CERT_LINE": "tls internal" if mode == "selfsigned" else ""}
        if pair:
            env.update(CERT_SOURCE=str(pair[0]), KEY_SOURCE=str(pair[1]))
        block = self.shell(self.install_block + self.site_function + "site_block", env=env)
        text = self.config.read_text() if self.config.exists() else ""
        self.config.write_text(lifecycle.edit_edge(text, "fixture", "8080", domain + ":443", block))
        self.shell(self.cleanup_block, env={"TLS_MODE": mode})

    def validate(self):
        result = subprocess.run([CADDY, "validate", "--config", str(self.config), "--adapter", "caddyfile"],
                                env=self.env, text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_actual_shell_independent_own_mixed_and_repeated_site_updates(self):
        a, b = self.make_pair("first.example.test"), self.make_pair("second.example.test")
        self.add("first.example.test", "own", a)
        first = next(self.target.glob("pair-*"))
        self.add("second.example.test", "own", b)
        self.assertEqual((first / "cert.pem").read_bytes(), a[0].read_bytes())
        self.assertEqual(len(list(self.target.glob("pair-*"))), 2)
        self.add("third.example.test", "selfsigned")
        self.add("fourth.example.test", "auto")
        self.assertTrue((first / "key.pem").exists())
        self.validate()
        for domain, pair in (("first.example.test", a), ("second.example.test", b)):
            installed = next(path for path in self.target.glob("pair-*/cert.pem") if path.read_bytes() == pair[0].read_bytes())
            hostname = subprocess.run(["openssl", "x509", "-in", str(installed), "-noout", "-checkhost", domain],
                                      text=True, capture_output=True, check=True)
            self.assertIn("does match", hostname.stdout)
        self.add("second.example.test", "own", b)
        self.assertEqual(len(list(self.target.glob("pair-*"))), 2)
        self.add("first.example.test", "selfsigned")
        self.assertFalse(first.exists())
        self.assertEqual(len(list(self.target.glob("pair-*"))), 1)
        self.add("second.example.test", "auto")
        self.assertFalse(self.target.exists())
        self.validate()

    def test_legacy_import_reference_survives_own_update_and_disable_prune(self):
        a, b = self.make_pair("first.example.test"), self.make_pair("second.example.test")
        tls.install_pair(*a, self.target, self.uid, self.gid)
        legacy_line = f"tls {self.target}/cert.pem {self.target}/key.pem"
        imported = self.base / "imported.caddy"
        imported.write_text(self.block("first.example.test", legacy_line).replace("# codex-harness:", "# outside-owner:"))
        self.config.write_text(f'import "{imported}"\n')
        self.add("second.example.test", "own", b)
        self.assertEqual((self.target / "cert.pem").read_bytes(), a[0].read_bytes())
        before = self.state()
        tls.snapshot_managed(self.target, self.backup / "tls", self.uid, self.gid)
        original = self.config.read_text()
        self.config.write_text(lifecycle.edit_edge(original, "fixture", "8080"))
        # Run the actual disable cleanup segment, with only service actions stubbed.
        start = self.source.index('  if [ "$DISABLE_TLS_PRESENT" = 1 ]; then')
        end = self.source.index("  # The state file selects", start)
        self.shell(self.source[start:end], env={"DISABLE_TLS_PRESENT": "1", "DISABLE_BACKUP": str(self.backup)})
        self.assertTrue((self.target / "key.pem").exists())
        self.assertEqual(list(self.target.glob("pair-*")), [])
        self.validate()
        # A later transaction failure restores every removed pair before reload.
        tls.restore_managed(self.target, self.backup / "tls", self.uid, self.gid)
        self.config.write_text(original)
        self.assertEqual(self.state(), before)
        self.validate()
        # Remove the imported site, then execute the actual final-site disable
        # edit/validation and pruning paths. No system command is executed.
        self.config.write_text(self.block("first.example.test", legacy_line))
        (self.backup / "Caddyfile").write_text(self.config.read_text())
        start = self.source.index('  if [ -f "$CADDY_FILE" ]; then\n    DISABLE_CADDY_CHANGED=1')
        end = self.source.index("  DISABLE_ENV_CHANGED=1", start)
        disable_edit = self.source[start:end]
        start = self.source.index('  if [ "$DISABLE_TLS_PRESENT" = 1 ]; then')
        end = self.source.index("  # The state file selects", start)
        self.shell(disable_edit + self.source[start:end],
                   env={"DISABLE_TLS_PRESENT": "1", "DISABLE_BACKUP": str(self.backup)})
        self.assertFalse(self.target.exists())
        self.validate()

    def test_failure_after_prune_restores_old_pair_and_removes_new_import(self):
        self.add("first.example.test", "own", self.make_pair("first.example.test"))
        before, original = self.state(), self.config.read_text()
        tls.snapshot_managed(self.target, self.backup / "tls", self.uid, self.gid)
        self.add("first.example.test", "own", self.make_pair("first.example.test"))
        self.assertNotEqual(self.state(), before)
        start = self.source.index('  if [ "${TLS_STATE_TOUCHED:-0}" = "1" ]; then')
        end = self.source.index("  systemctl_do daemon-reload", start)
        self.shell("rollback_failed=0\n" + self.source[start:end] + '\ntest "$rollback_failed" = 0\n',
                   env={"TLS_STATE_TOUCHED": "1", "RB_TLS_EXISTED": "1"})
        self.config.write_text(original)
        self.assertEqual(self.state(), before)
        self.validate()

    def test_last_site_normalization_does_not_hide_invalid_retained_configuration(self):
        invalid = "not-a-valid-directive }\n"
        self.config.write_text(self.block("first.example.test", "tls internal") + invalid)
        (self.backup / "Caddyfile").write_text(self.config.read_text())
        start = self.source.index('  if [ -f "$CADDY_FILE" ]; then\n    DISABLE_CADDY_CHANGED=1')
        end = self.source.index("  DISABLE_ENV_CHANGED=1", start)
        self.shell(self.source[start:end], env={"DISABLE_BACKUP": str(self.backup)}, expected=1)
        self.assertEqual(self.config.read_text(), invalid)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--helper":
        fixture_helper()
    else:
        unittest.main(verbosity=2)
