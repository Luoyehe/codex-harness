"""Relocated root generations and actual unprivileged fixed-token execution."""
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

from deploy.common import Layout, mkdir, write_json
from deploy.install import stage_control
from deploy.provider import ProviderStore, validate_provider
from deploy.provider_layers import prepare_host_targets


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "Real Linux root and native UID boundary")
class ExtendedProviderGenerationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="provider-extended-"); self.addCleanup(self.temp.cleanup)
        self.layout = Layout("fixture", Path(self.temp.name)); os.chmod(self.layout.root, 0o755)
        mkdir(self.layout.config, 0o751)
        # Hosted runner homes can be 0700. Native execution imports the actual
        # reviewed helper from its readable, root-owned installation fixture;
        # permissions on the checkout and runner home remain unchanged.
        stage_control(self.layout, self.layout.control)
        self.current = {"revision": "a" * 32, "kind": "chatgpt", "models": []}
        self.selected = validate_provider({"expectedRevision": "a" * 32, "kind": "bedrock-runtime", "region": "us-east-1", "apiKey": "fixture-managed-bearer"}, self.current)
        prepare_host_targets(self.selected, self.layout, 65534)
        self.store = ProviderStore(self.layout, 65534)
        self.generation = self.store.prepare(self.selected, layered=True); self.store.select(self.generation)

    def test_generation_separates_bearer_from_config_and_clears_it_when_leaving_bedrock(self):
        directory = self.store.root / self.generation
        for name in ("config.toml", "system-config.toml", "requirements.toml"):
            self.assertNotIn(b"fixture-managed-bearer", (directory / name).read_bytes())
            info = (directory / name).stat(); self.assertEqual((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)), (0, 65534, 0o640))
        self.assertEqual(json.loads((directory / "native-env.json").read_text()), {"HARNESS_PROVIDER_API_KEY": "", "AWS_BEARER_TOKEN_BEDROCK": "fixture-managed-bearer", "AWS_REGION": "us-east-1"})
        self.assertEqual(stat.S_IMODE((directory / "provider.env").stat().st_mode), 0o600)
        changed = validate_provider({"expectedRevision": self.selected["revision"], "kind": "chatgpt"}, self.selected)
        generation = self.store.prepare(changed, layered=True)
        self.assertEqual(json.loads((self.store.root / generation / "native-env.json").read_text()), {"HARNESS_PROVIDER_API_KEY": ""})
        self.assertNotIn("AWS_", (self.store.root / generation / "provider.env").read_text())

    def invoke_token(self, *, native=True, verb="bedrock-token"):
        write_json(self.layout.config / "native.json", {"uid": 65534, "gid": 65534, "bin": "/not-executed", "home": "/not-opened", "cwd": "/not-opened"}, mode=0o644)
        code = "from pathlib import Path; import sys; from deploy.common import Layout; import deploy.native_launcher as launcher; root=Path(sys.argv[1]); verb=sys.argv[2]; launcher.Layout=lambda instance:Layout(instance,root); sys.argv=['native-launch',verb]; launcher.native_main('fixture')"
        def identity():
            os.setgroups([]); os.setgid(65534); os.setuid(65534)
        return subprocess.run([sys.executable, "-B", "-c", code, str(self.layout.root), verb],
                              cwd=self.layout.control, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10,
                              preexec_fn=identity if native else None)

    def test_fixed_native_token_verb_returns_only_managed_token_and_root_is_denied(self):
        result = self.invoke_token(); self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, b"fixture-managed-bearer\n")
        root = self.invoke_token(native=False); self.assertNotEqual(root.returncode, 0); self.assertEqual(root.stdout, b"")
        unknown = self.invoke_token(verb="bedrock-token extra"); self.assertNotEqual(unknown.returncode, 0); self.assertEqual(unknown.stdout, b"")

    def test_foreign_owned_environment_cannot_feed_token_command(self):
        path = self.store.root / self.generation / "native-env.json"; os.chown(path, 65534, 65534)
        result = self.invoke_token(); self.assertNotEqual(result.returncode, 0); self.assertEqual(result.stdout, b"")


if __name__ == "__main__": unittest.main()
