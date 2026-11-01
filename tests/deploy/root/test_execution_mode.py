"""Real root files/UID/capabilities; systemd, health and idle IO stay isolated."""
import contextlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy.common import DeployError, Layout, atomic_write, digest, mkdir, read_json, write_json
from deploy.execution_identity import native_settings, state
from deploy.execution_mode import change, paths, recover, snapshot
from deploy.manager import Manager
from deploy.provider_layers import prepare_host_targets
from deploy.safe_fs import inspect_tree
from deploy.units import render_units, sudo_rule
from tests.deploy.root.test_config_layer import FixtureSystem, PowerLoss


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "Real Linux root execution identity fixture")
class ExecutionModeRootTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="execution-mode-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name);self.root.chmod(0o755)
        self.layout = Layout("fixture", self.root)
        for directory in (self.layout.config, self.layout.units, self.layout.control, self.layout.state / "transactions",
                          self.layout.root / "etc/sudoers.d", self.layout.config / "manifests"):
            mkdir(directory)
        self.config = {"workerUid": 65534, "workerGid": 65534, "gatewayUid": 65532, "gatewayGid": 65532,
                       "supervisorUid": 65533, "port": 3300, "origin": "http://127.0.0.1:3300",
                       "providerConfigLayer": "system-v1", "codexRelative": "vendor/codex"}
        for role in ("gateway", "worker", "supervisor"):
            mkdir(self.layout.state / role, 0o700 if role == "gateway" else 0o750, self.config[role + "Uid"], self.config.get(role + "Gid", 65534))
        mkdir(self.layout.state / "worker/codex", 0o750, 65534, 65534)
        atomic_write(self.layout.state / "worker/codex/config.toml", b"# retained native config\n", 0o600, 65534, 65534)
        atomic_write(self.layout.state / "worker/codex/auth.json", b'{"fixture":"private-native-login"}\n', 0o600, 65534, 65534)
        write_json(self.layout.config / "instance.json", self.config)
        write_json(self.layout.config / "native.json", native_settings(self.layout, self.config), mode=0o644)
        atomic_write(self.layout.config / "gateway-token", b"fixture-token-not-personal" * 3, 0o640, 0, 65532)
        write_json(self.layout.control / "capabilities.json", {"executionMode": 1, "providerConfigLayer": "system-v1", "sharedChatgptAuth": 1, "threadHistoryRepair": 1}, mode=0o644)
        for name, content in render_units(self.layout, self.config, self.config["codexRelative"]).items():
            atomic_write(self.layout.units / name, content.encode(), 0o644)
        atomic_write(paths(self.layout)["sudo"], sudo_rule(self.layout).encode(), 0o440)
        release = self.layout.app / "releases/stage"
        mkdir(release / "app")
        write_json(release / "app/package.json", {"version": "2.2.0", "codexHarnessExecutionMode": 1}, mode=0o644)
        manifest = inspect_tree(release, root_owned=True);self.release = digest(manifest)
        release.rename(release.with_name(self.release))
        write_json(self.layout.config / "manifests" / (self.release + ".json"), manifest)
        os.symlink("releases/" + self.release, self.layout.app / "current")
        self.system = FixtureSystem(self.layout)
        self.manager = Manager(self.layout, self.system, worker_gid=65534)
        settings = {"kind": "responses", "revision": "a" * 32, "baseUrl": "https://fixture.invalid/v1", "model": "fixture", "apiKey": "fixture-only", "models": []}
        prepare_host_targets(settings, self.layout, 65534)
        self.manager.providers.select(self.manager.providers.prepare(settings, layered=True))
        self.manager.recover_control = lambda: self.system.events.append("recover-receipts")
        self.manager.healthy = lambda: self.system.events.append("health")
        self.stack = contextlib.ExitStack();self.addCleanup(self.stack.close)
        self.idle = self.stack.enter_context(patch("deploy.candidate_archive.require_idle"))
        self.stack.enter_context(patch("deploy.execution_mode.run"))
        self.stack.enter_context(patch.object(self.manager, "verify_https", return_value={"configured": False}))
        # The actual Manager.verify remains live: release manifest, ownership,
        # provider layers, native configuration, units and sudo are all checked.

    def params(self, mode):
        return {"mode": mode, "expectedRevision": state(self.manager.config)["revision"], "confirmRestart": True, "confirmRoot": mode == "root"}

    def grant(self):
        return change(self.manager, root_allowed=True, confirm_restart=True)

    def test_grant_does_not_enable_and_root_native_roundtrip_preserves_both_homes(self):
        original = (self.layout.state / "worker/codex/auth.json").read_bytes()
        granted = self.grant();self.assertEqual(granted["mode"], "native");self.assertTrue(granted["rootAllowed"])
        self.assertEqual(granted["sharedChatgptAuth"], {"shared": False})
        root = change(self.manager, self.params("root"));self.assertEqual(root["effectiveUid"], 0)
        home = self.layout.state / "worker-root/codex"
        self.assertEqual((home / "auth.json").read_bytes(), original)
        self.assertEqual((home / "auth.json").stat().st_uid, 0)
        self.assertFalse((self.layout.state / "worker/codex/auth.json").exists())
        atomic_write(home / "root-only-state", b"root-private", 0o600)
        change(self.manager, self.params("native"))
        self.assertEqual((self.layout.state / "worker/codex/auth.json").read_bytes(), original)
        self.assertEqual((self.layout.state / "worker/codex/auth.json").stat().st_uid, 65534)
        self.assertFalse((home / "auth.json").exists())
        self.assertEqual((home / "root-only-state").stat().st_uid, 0)
        self.assertEqual((home / "root-only-state").stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.system.active, {"gateway", "worker"})
        self.assertEqual(self.manager.verify()["executionMode"]["mode"], "native")
        with patch("deploy.https_health.https_health", return_value={"configured": False}):
            self.assertEqual(self.manager.status()["sharedChatgptAuth"]["ready"], True)

    def test_revoke_while_root_atomically_restores_native_and_denies_root(self):
        self.grant();change(self.manager, self.params("root"))
        result = change(self.manager, root_allowed=False, confirm_restart=True)
        self.assertEqual((result["mode"], result["rootAllowed"], result["effectiveUid"]), ("native", False, 65534))
        self.assertNotIn(b"ALL=(root) NOPASSWD:", next(line for line in paths(self.layout)["sudo"].read_bytes().splitlines() if b"-control ALL=" in line))
        with self.assertRaises(DeployError):change(self.manager, self.params("root"))

    def test_busy_revoke_does_not_change_authorization_or_configuration(self):
        self.grant();change(self.manager, self.params("root"));before=snapshot(self.layout);events=list(self.system.events)
        self.idle.side_effect=DeployError("busy", "Fixture active task")
        with self.assertRaises(DeployError):change(self.manager, root_allowed=False, confirm_restart=True)
        self.assertEqual(snapshot(self.layout), before);self.assertEqual(self.system.events, events)
        self.assertTrue(state(self.manager.config)["rootAllowed"])

    def test_nonfile_target_store_is_rejected_before_stop_or_auth_migration(self):
        from deploy.execution_mode import prepare_home
        from deploy.shared_auth import DIRECTORY
        self.grant()
        prepare_home(self.layout, {**self.manager.config, "executionMode": "root"})
        path = self.layout.state / "worker-root/codex/config.toml"
        atomic_write(path, b'cli_auth_credentials_store = "keyring"\n', 0o600)
        events, before = list(self.system.events), snapshot(self.layout)
        with self.assertRaises(DeployError) as error:
            change(self.manager, self.params("root"))
        self.assertEqual(error.exception.code, "auth_store_unsupported")
        self.assertEqual(self.system.events, events)
        self.assertEqual(snapshot(self.layout), before)
        self.assertFalse((self.layout.state / DIRECTORY).exists())
        self.assertEqual(path.read_bytes(), b'cli_auth_credentials_store = "keyring"\n')
        operation = "11111111-1111-4111-8111-111111111111"
        with self.assertRaises(DeployError) as preflight:
            self.manager.dispatch({"method": "execution-mode/write", "params": self.params("root"), "operationId": operation})
        self.assertEqual(preflight.exception.code, "auth_store_unsupported")
        self.assertFalse((self.layout.state / "receipts" / (operation + ".json")).exists())

    def test_start_failure_restores_exact_previous_definitions_and_policy(self):
        self.grant();before=snapshot(self.layout);self.system.fail_start=True
        with self.assertRaisesRegex(DeployError, "One-time start failure"):change(self.manager, self.params("root"))
        self.assertEqual(snapshot(self.layout), before);self.assertEqual(self.system.active, {"gateway", "worker"})
        self.manager.require_update_ready(persist=False)
        self.assertEqual(self.manager.verify()["executionMode"]["mode"], "native")

    def test_old_execution_snapshot_recovery_adds_only_fixed_history_helper(self):
        self.grant()
        capability_path = self.layout.control / "capabilities.json"
        capabilities = read_json(capability_path); capabilities.pop("threadHistoryRepair")
        write_json(capability_path, capabilities, mode=0o644)
        old = sudo_rule(self.layout, config=self.manager.config, legacy_thread_history=True).encode()
        atomic_write(paths(self.layout)["sudo"], old, 0o440)
        pending = []
        def crash(path, value, **kwargs):
            write_json(path, value, **kwargs)
            if path.name == "state.json" and value.get("phase") == "selected":
                pending.append(path); raise PowerLoss()
        with patch("deploy.execution_mode.write_json", side_effect=crash), self.assertRaises(PowerLoss):
            change(self.manager, self.params("root"))
        capabilities["threadHistoryRepair"] = 1; write_json(capability_path, capabilities, mode=0o644)
        recover(self.manager, pending[0], read_json(pending[0]))
        self.assertEqual(paths(self.layout)["sudo"].read_bytes(), sudo_rule(self.layout, config=self.manager.config).encode())
        self.assertEqual(self.manager.verify()["sudoPolicy"], "current")
        self.assertEqual(self.manager.config["executionMode"], "native")

    def test_first_root_to_native_migration_prefers_current_login_and_retains_other(self):
        from deploy.execution_mode import prepare_home
        from deploy.shared_auth import DIRECTORY
        # An existing installation predates shared authentication and has two logins.
        config = {**self.config, "executionMode": "root", "rootAllowed": True, "executionGeneration": "a" * 32}
        prepare_home(self.layout, config)
        atomic_write(self.layout.state / "worker-root/codex/auth.json", b'{"fixture":"current-root-login"}\n', 0o600)
        write_json(paths(self.layout)["instance"], config)
        write_json(paths(self.layout)["native"], native_settings(self.layout, config), mode=0o644)
        atomic_write(paths(self.layout)["worker"], render_units(self.layout, config, config["codexRelative"])[self.layout.unit("worker")].encode(), 0o644)
        atomic_write(paths(self.layout)["sudo"], sudo_rule(self.layout, config=config).encode(), 0o440)
        self.manager.config = config
        result = change(self.manager, self.params("native"))
        self.assertEqual(result["sharedChatgptAuth"]["archivedLegacyModes"], ["native"])
        self.assertFalse(result["sharedChatgptAuth"]["automaticRestore"])
        self.assertEqual((self.layout.state / "worker/codex/auth.json").read_bytes(), b'{"fixture":"current-root-login"}\n')
        retained = self.layout.state / DIRECTORY / "legacy-native.auth.json"
        self.assertEqual(retained.read_bytes(), b'{"fixture":"private-native-login"}\n')
        self.assertEqual((retained.stat().st_uid, retained.stat().st_mode & 0o777), (0, 0o600))

    def test_failed_start_returns_refreshed_auth_not_the_pre_switch_snapshot(self):
        self.grant()
        original = self.system.start
        refreshed = b'{"fixture":"refreshed-after-switch"}\n'
        attempted = False
        def start(units):
            nonlocal attempted
            if not attempted:
                attempted = True
                atomic_write(self.layout.state / "worker-root/codex/auth.json", refreshed, 0o600)
                raise DeployError("health", "fixture failure after native refresh")
            return original(units)
        with patch.object(self.system, "start", side_effect=start), self.assertRaisesRegex(DeployError, "after native refresh"):
            change(self.manager, self.params("root"))
        selected = self.layout.state / "worker/codex/auth.json"
        self.assertEqual(selected.read_bytes(), refreshed)
        self.assertEqual(selected.stat().st_uid, 65534)
        self.assertFalse((self.layout.state / "worker-root/codex/auth.json").exists())
        self.manager.verify()

    def test_failed_start_after_logout_keeps_both_modes_logged_out(self):
        self.grant()
        original = self.system.start
        attempted = False
        def start(units):
            nonlocal attempted
            if not attempted:
                attempted = True
                (self.layout.state / "worker-root/codex/auth.json").unlink()
                raise DeployError("health", "fixture failure after logout")
            return original(units)
        with patch.object(self.system, "start", side_effect=start), self.assertRaisesRegex(DeployError, "after logout"):
            change(self.manager, self.params("root"))
        self.assertFalse((self.layout.state / "worker/codex/auth.json").exists())
        self.assertFalse((self.layout.state / "worker-root/codex/auth.json").exists())
        change(self.manager, self.params("root"))
        self.assertFalse((self.layout.state / "worker-root/codex/auth.json").exists())

    def test_partial_publication_recovers_with_mixed_old_new_sudo_and_config(self):
        self.grant();before=snapshot(self.layout)
        original=atomic_write
        failed=False
        def fail(path, data, *args, **kwargs):
            nonlocal failed
            if path==paths(self.layout)["sudo"] and not failed:
                failed=True;raise OSError("fixture sudo publication failed")
            return original(path,data,*args,**kwargs)
        with patch("deploy.execution_mode.atomic_write",side_effect=fail),self.assertRaises(OSError):change(self.manager,self.params("root"))
        self.assertEqual(snapshot(self.layout), before);self.manager.require_update_ready(persist=False)

    def test_crash_then_explicit_candidate_recovery_and_default_verify(self):
        self.grant();observed=[]
        def crash(path,value,**kwargs):
            write_json(path,value,**kwargs)
            if path.name=="state.json" and value.get("kind")=="execution-mode" and value.get("phase")=="selected":
                observed.append(path);raise PowerLoss()
        with patch("deploy.execution_mode.write_json",side_effect=crash),self.assertRaises(PowerLoss):change(self.manager,self.params("root"))
        self.assertEqual(len(observed),1)
        with self.assertRaises(DeployError):self.manager.require_update_ready(persist=False)
        restored=recover(self.manager,observed[0],read_json(observed[0]),candidate=True)
        self.assertEqual(restored["mode"],"root");self.assertEqual(self.manager.verify()["sudoPolicy"],"current")

    def test_recovery_failure_keeps_barriers_pending_and_services_stopped(self):
        self.grant();self.system.fail_start=True
        with patch.object(self.manager,"healthy",side_effect=DeployError("health","fixture always unhealthy")),self.assertRaises(DeployError):change(self.manager,self.params("root"))
        self.assertFalse(self.system.active)
        self.assertTrue((self.layout.config/"config-layer-maintenance/worker").exists())
        self.assertTrue((self.layout.config/"config-layer-maintenance/gateway").exists())
        with self.assertRaises(DeployError):self.manager.require_update_ready(persist=False)

    def test_completed_request_replay_does_not_restart_or_reapply(self):
        self.grant()
        request={"method":"execution-mode/write","params":self.params("root"),"operationId":"11111111-1111-4111-8111-111111111111"}
        first=self.manager.dispatch(request);events=list(self.system.events)
        self.assertTrue(first["ok"]);self.assertEqual(self.manager.dispatch(request),first);self.assertEqual(self.system.events,events)

    def test_originally_stopped_remains_stopped(self):
        self.system.active.clear()
        self.grant();change(self.manager,self.params("root"))
        self.assertFalse(self.system.active)
        self.assertFalse(any(isinstance(e,tuple) and e[0]=="start" for e in self.system.events))

    def terminal_failure(self, *, published):
        self.grant();observed={}
        def fail(path,value,**kwargs):
            if path.name=="state.json" and value.get("kind")=="execution-mode" and value.get("phase")=="committed":
                if published:write_json(path,value,**kwargs)
                observed.update(path=path,events=list(self.system.events),config=snapshot(self.layout))
                raise OSError("fixture terminal publication failure")
            write_json(path,value,**kwargs)
        with patch("deploy.execution_mode.write_json",side_effect=fail),self.assertRaises(OSError):change(self.manager,self.params("root"))
        self.assertEqual(self.system.events,observed["events"])
        self.assertEqual(snapshot(self.layout),observed["config"])
        self.assertEqual(self.system.active,{"gateway","worker"})
        self.assertEqual(read_json(observed["path"])["phase"],"committed" if published else "selected")
        if not published:
            with self.assertRaises(DeployError):self.manager.require_update_ready(persist=False)
            recover(self.manager,observed["path"],read_json(observed["path"]),candidate=True)
        self.manager.require_update_ready(persist=False)
        self.assertEqual(self.manager.verify()["executionMode"]["mode"],"root")

    def test_terminal_failure_before_publication_retains_candidate_for_explicit_recovery(self):
        self.terminal_failure(published=False)

    def test_terminal_failure_after_publication_does_not_compensate_committed_root(self):
        self.terminal_failure(published=True)

    def test_real_launcher_pins_file_store_and_rejects_nonfile_before_native_dispatch(self):
        from deploy.execution_mode import prepare_home
        self.grant()
        prepare_home(self.layout, {**self.manager.config, "executionMode": "root"})
        write_json((self.layout.config / "providers/current").resolve() / "runtime.json",
                   {"connections": [{"enabled": True, "modelProvider": "fixture_catalog"}]}, mode=0o640, uid=0, gid=65534)
        for parent in [self.layout.state, self.layout.config, *self.layout.config.parents]:
            if parent == self.root or self.root in parent.parents:
                parent.chmod(0o755)
        for mode in ("native", "root"):
            with self.subTest(mode=mode):
                config = {**self.manager.config, "executionMode": mode}
                write_json(self.layout.config / "instance.json", config)
                write_json(self.layout.config / "native.json", native_settings(self.layout, config), mode=0o644)
                code = "import os,sys,json;from pathlib import Path;from deploy import native_launcher as n;from deploy.common import Layout;" + \
                       "n.Layout=lambda _:Layout('fixture',Path(" + repr(str(self.root)) + "));" + \
                       "n.supervise=lambda command,*args,**kwargs:(print(json.dumps(command)),0)[1];" + \
                       ("os.setgroups([65534]);os.setgid(65534);os.setuid(65534);" if mode == "native" else "os.setgroups([0]);") + \
                       "sys.argv=['native-launch',*sys.argv[1:]];n.native_main('fixture')"
                result = subprocess.run([sys.executable, "-B", "-c", code, "app-server"], capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                self.assertEqual(json.loads(result.stdout)[-2:], ["-c", 'cli_auth_credentials_store="file"'])
                self.assertIn('thread_unload_delay_secs=0', json.loads(result.stdout))
                catalog = subprocess.run([sys.executable, "-B", "-c", code, "catalog-server", "fixture_catalog"], capture_output=True, timeout=10)
                self.assertEqual(catalog.returncode, 0, catalog.stderr.decode())
                self.assertIn('cli_auth_credentials_store="file"', json.loads(catalog.stdout))
                self.assertIn('thread_unload_delay_secs=0', json.loads(catalog.stdout))
                self.assertEqual(json.loads(catalog.stdout)[-2:], ["-c", 'model_provider="fixture_catalog"'])
                user_config = Path(native_settings(self.layout, config)["home"]) / "config.toml"
                old = user_config.read_bytes()
                uid = 0 if mode == "root" else 65534
                atomic_write(user_config, b'cli_auth_credentials_store = "auto"\n', 0o600, uid, uid)
                for arguments in (["app-server"], ["catalog-server", "fixture_catalog"]):
                    denied = subprocess.run([sys.executable, "-B", "-c", code, *arguments], capture_output=True, timeout=10)
                    self.assertEqual(denied.returncode, 1)
                    self.assertEqual(denied.stdout, b"")
                    self.assertIn("不会自动读取或迁移 keyring", denied.stderr.decode())
                self.assertEqual(user_config.read_bytes(), b'cli_auth_credentials_store = "auto"\n')
                atomic_write(user_config, old, 0o600, uid, uid)

    def test_history_helper_uses_real_fixed_uid_without_provider_secrets_or_other_home_access(self):
        import gzip
        from deploy.execution_mode import prepare_home
        thread_id = "00000000-0000-4000-8000-000000000001"
        def record(kind, payload):
            return (json.dumps({"type": kind, "payload": payload}) + "\n").encode()
        self.grant()
        prepare_home(self.layout, {**self.manager.config, "executionMode": "root"})
        for parent in [self.layout.state, self.layout.config, *self.layout.config.parents]:
            if parent == self.root or self.root in parent.parents: parent.chmod(0o755)
        for mode in ("native", "root"):
            with self.subTest(mode=mode):
                uid = 0 if mode == "root" else 65534
                config = {**self.manager.config, "executionMode": mode}
                settings = native_settings(self.layout, config)
                write_json(self.layout.config / "instance.json", config)
                write_json(self.layout.config / "native.json", settings, mode=0o644)
                home = Path(settings["home"])
                mkdir(home / "sessions", 0o700, uid, uid)
                path = home / "sessions" / ("rollout-" + thread_id + ".jsonl")
                original = record("session_meta", {"id": thread_id, "history_mode": "paginated"}) + record("response_item", {
                    "type": "reasoning", "summary": [], "content": [{"type": "reasoning_text", "text": "synthetic private reasoning"}]})
                atomic_write(path, original, 0o600, uid, uid)
                code = "import os,sys;from pathlib import Path;from deploy import native_launcher as n;from deploy.common import Layout;" + \
                       "n.Layout=lambda _:Layout('fixture',Path(" + repr(str(self.root)) + "));" + \
                       "read=n.read_json;n.read_json=lambda p,*a:read(p,*a) if p.name!='native-env.json' else (_ for _ in ()).throw(AssertionError('provider secrets opened'));" + \
                       ("os.setgroups([65534]);os.setgid(65534);os.setuid(65534);" if mode == "native" else "os.setgroups([0]);") + \
                       "sys.argv=['native-launch','thread-history'];n.native_main('fixture')"
                def invoke(request):
                    return subprocess.run([sys.executable, "-B", "-c", code], input=json.dumps(request).encode(), capture_output=True, timeout=10)
                request = {"action": "inspect", "threadId": thread_id, "path": str(path), "mode": "foreign"}
                inspected = invoke(request); self.assertEqual(inspected.returncode, 0, inspected.stderr.decode())
                proof = json.loads(inspected.stdout); self.assertTrue(proof["needsRepair"])
                repaired = invoke({**request, "action": "repair", "expected": proof["expected"]})
                self.assertEqual(repaired.returncode, 0, repaired.stderr.decode())
                self.assertTrue(json.loads(repaired.stdout)["repaired"])
                backup = next((home / "harness-history-backups").glob("*.jsonl.gz"))
                self.assertEqual(gzip.decompress(backup.read_bytes()), original)
                self.assertEqual((backup.stat().st_uid, backup.stat().st_mode & 0o777), (uid, 0o600))
                self.assertEqual(path.stat().st_uid, uid)
                self.assertNotIn(b"synthetic private reasoning", inspected.stdout + repaired.stdout)
                outside = invoke({**request, "path": str(self.root / "outside.jsonl")})
                self.assertEqual(outside.returncode, 1)
                self.assertEqual(json.loads(outside.stdout)["error"]["delivery"], "not_sent")

    def test_real_uid_native_denied_root_private_project_root_allowed(self):
        self.grant()
        private=self.root/"private-project";private.mkdir(mode=0o700)
        # Only this disposable fixture's ancestors are made searchable.
        for p in [self.layout.state,self.layout.config,*self.layout.config.parents]:
            if p==self.root or self.root in p.parents:p.chmod(0o755)
        def invoke(mode,args,input_bytes=b""):
            config={**self.manager.config,"executionMode":mode}
            write_json(self.layout.config/"instance.json",config,mode=0o600)
            write_json(self.layout.config/"native.json",native_settings(self.layout,config),mode=0o644)
            code="import os,sys;from pathlib import Path;from deploy import native_launcher as n;from deploy.execution_identity import state;from deploy.common import Layout;"+\
                 "n.Layout=lambda _:Layout('fixture',Path("+repr(str(self.root))+"));"+\
                 ("os.setgroups([65534]);os.setgid(65534);os.setuid(65534);" if mode=="native" else "os.setgroups([0]);")+\
                 "sys.argv=['native-launch',*"+repr(args)+"];n.native_main('fixture')"
            return subprocess.run([sys.executable,"-B","-c",code],input=input_bytes,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
        request=json.dumps({"path":str(private)}).encode()
        native=invoke("native",["resolve-project"],request)
        self.assertEqual(native.returncode,1);self.assertEqual(json.loads(native.stdout)["error"]["code"],"project_permission_denied")
        identity_native=invoke("native",["identity"])
        self.assertEqual(identity_native.returncode,0,identity_native.stderr.decode());self.assertEqual(json.loads(identity_native.stdout)["effectiveUid"],65534)
        self.assertEqual((self.layout.config/"instance.json").stat().st_mode&0o777,0o600)
        root=invoke("root",["resolve-project"],request)
        self.assertEqual(root.returncode,0,root.stderr.decode());self.assertEqual(json.loads(root.stdout)["path"],str(private))
        identity=invoke("root",["identity"])
        self.assertEqual(identity.returncode,0,identity.stderr.decode());self.assertEqual(json.loads(identity.stdout)["effectiveUid"],0)
