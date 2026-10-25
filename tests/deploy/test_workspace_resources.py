"""Read-only skill resources and project-directory containment under native UID."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy.common import DeployError, Layout
from deploy.workspace import blocked_paths, validate
from deploy.workspace_paths import MAX_FILE, Root
from deploy.workspace_resources import absolute_skill, preview_plugin, read_skill, resolve_directory


class ResourceValidationTests(unittest.TestCase):
    def test_only_catalog_absolute_skill_files_are_accepted(self):
        for name in ("relative/SKILL.md", "/a/auth.json", "/a/../b/SKILL.md", "/a//SKILL.md", "/a/./SKILL.md", "/a\\b/SKILL.md", "/a/.git/SKILL.md", "/a\n/SKILL.md"):
            with self.subTest(path=name), self.assertRaises(DeployError):
                absolute_skill(name)
        self.assertEqual(absolute_skill("/project/.agents/skills/demo/SKILL.md").as_posix(), "/project/.agents/skills/demo/SKILL.md")

    def test_resources_never_accept_operation_binding_or_arbitrary_root_lists(self):
        request = {"version": 1, "action": "resource/skill/read", "root": "/project", "params": {"path": "/skills/a/SKILL.md"}}
        validate(request)
        for extra in ({"operationId": "00000000-0000-0000-0000-000000000000"}, {"binding": {}}, {"allowedRoots": ["/"]}):
            with self.assertRaises(DeployError):
                validate({**request, **extra})
        for params in ({"path": "../outside"}, {"path": "/absolute"}, {"path": "a", "root": "/"}):
            with self.assertRaises(DeployError):
                validate({**request, "action": "resource/directory/resolve", "params": params})


@unittest.skipUnless(os.name == "posix", "Requires Linux descriptors and procfs")
class ResourceFilesystemTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="workspace-resource-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.layout = Layout("fixture", self.base / "host")
        native = self.layout.state / "worker"
        self.settings = {"cwd": str(native), "home": str(native / "codex")}
        self.project = self.base / "project"
        self.project.mkdir()
        self.forbidden = blocked_paths(self.layout, self.settings)
        self.root = Root(str(self.project), self.forbidden)
        self.addCleanup(self.root.close)

    def skill(self, directory, text="---\nname: example\n---\nInstructions\n"):
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / "SKILL.md"
        target.write_text(text, encoding="utf-8")
        return target

    def read(self, target):
        return read_skill(self.root, {"path": str(target)}, self.layout, self.settings, self.forbidden)

    def test_fixed_skill_scopes_read_without_opening_general_codex_home(self):
        bases = [self.project / ".agents/skills/example", Path(self.settings["cwd"]) / ".agents/skills/example",
                 Path(self.settings["home"]) / "skills/.system/example", Path(self.settings["home"]) / "plugins/cache/pkg/v1/skills/example",
                 self.layout.root / "etc/codex/skills/example"]
        for base in bases:
            result = self.read(self.skill(base))
            self.assertEqual(result["text"], "---\nname: example\n---\nInstructions\n")
            self.assertEqual(len(result["revision"]), 64)
            self.assertEqual(result["bytes"], len(result["text"].encode()))
        with self.assertRaises(DeployError):
            Root(self.settings["home"], self.forbidden)
        self.assertFalse((Path(self.settings["cwd"]) / "workspace-state").exists())

    def test_control_secret_and_nonallowlisted_global_locations_are_rejected(self):
        for base in (self.layout.config / "secrets", Path(self.settings["home"]) / "auth", self.base / "outside", self.layout.state / "supervisor"):
            with self.subTest(path=base), self.assertRaises(DeployError):
                self.read(self.skill(base))

    def test_symlink_hardlink_fifo_and_ancestor_links_are_refused(self):
        source = self.skill(self.project / ".agents/skills/source")
        for kind in ("link", "hard", "fifo"):
            directory = self.project / kind
            directory.mkdir()
            target = directory / "SKILL.md"
            if kind == "link": target.symlink_to(source)
            elif kind == "hard": os.link(source, target)
            else: os.mkfifo(target)
            with self.assertRaises((OSError, DeployError)):
                self.read(target)
            target.unlink()
        (self.project / "alias").symlink_to(source.parent, target_is_directory=True)
        with self.assertRaises((OSError, DeployError)):
            self.read(self.project / "alias/SKILL.md")

    def test_binary_invalid_utf8_and_byte_overflow_are_bounded(self):
        target = self.skill(self.project / "example")
        for data in (b"abc\0def", b"\xff", b"x" * (MAX_FILE + 1)):
            target.write_bytes(data)
            with self.assertRaises(DeployError):
                self.read(target)

    def test_directory_preflight_returns_pinned_project_identity_and_rejects_links(self):
        target = self.project / "marketplace"
        target.mkdir()
        result = resolve_directory(self.root, {"path": "marketplace"})
        self.assertEqual(result, {"path": str(target), "device": target.stat().st_dev, "inode": target.stat().st_ino})
        self.assertEqual(resolve_directory(self.root, {})["path"], str(self.project))
        outside = self.base / "outside"
        outside.mkdir()
        (self.project / "escape").symlink_to(outside, target_is_directory=True)
        with self.assertRaises((OSError, DeployError)):
            resolve_directory(self.root, {"path": "escape"})

    def test_skill_parent_moved_after_open_is_conflict_not_success(self):
        import deploy.workspace_resources as resources
        target = self.skill(self.project / "example")
        original = resources.read_file
        def race(fd):
            target.parent.rename(self.base / "moved")
            return original(fd)
        with patch.object(resources, "read_file", side_effect=race), self.assertRaises(DeployError) as caught:
            self.read(target)
        self.assertEqual(caught.exception.code, "conflict")

    def test_plugin_preview_hashes_relative_bytes_modes_and_empty_directories(self):
        directory = self.project / "plugin"
        target = self.skill(directory / "skills/example")
        first = preview_plugin(self.root, {"path": "plugin"})
        self.assertEqual([item["path"] for item in first["files"]], ["skills/example/SKILL.md"])
        self.assertEqual(first["totalBytes"], target.stat().st_size)
        target.chmod(0o700)
        second = preview_plugin(self.root, {"path": "plugin"})
        self.assertNotEqual(first["revision"], second["revision"])
        self.assertEqual(first["files"], second["files"])
        (directory / "empty").mkdir()
        self.assertNotEqual(second["revision"], preview_plugin(self.root, {"path": "plugin"})["revision"])
        target.write_text("changed")
        self.assertNotEqual(first["files"], preview_plugin(self.root, {"path": "plugin"})["files"])

    def test_plugin_preview_refuses_git_links_hardlinks_and_special_files(self):
        directory = self.project / "plugin"
        target = self.skill(directory / "skills/example")
        for kind in (".git", "symlink", "hardlink", "fifo"):
            child = directory / kind
            if kind == ".git": child.mkdir()
            elif kind == "symlink": child.symlink_to(target)
            elif kind == "hardlink": os.link(target, child)
            else: os.mkfifo(child)
            with self.subTest(kind=kind), self.assertRaises((OSError, DeployError)):
                preview_plugin(self.root, {"path": "plugin"})
            child.rmdir() if kind == ".git" else child.unlink()

    def test_plugin_file_count_depth_and_byte_budgets_are_explicit(self):
        directory = self.project / "plugin"
        directory.mkdir()
        large = directory / "large"
        large.write_bytes(b"x" * (2 * 1024 * 1024 + 1))
        with self.assertRaises(DeployError): preview_plugin(self.root, {"path": "plugin"})
        large.unlink()
        for index in range(513): (directory / str(index)).touch()
        with self.assertRaises(DeployError): preview_plugin(self.root, {"path": "plugin"})
        for child in directory.iterdir(): child.unlink()
        current = directory
        for _ in range(17):
            current /= "deep"
            current.mkdir()
        with self.assertRaises(DeployError): preview_plugin(self.root, {"path": "plugin"})
        aggregate = self.project / "aggregate"
        aggregate.mkdir()
        for index in range(9): (aggregate / str(index)).write_bytes(b"x" * (2 * 1024 * 1024))
        with self.assertRaises(DeployError): preview_plugin(self.root, {"path": "aggregate"})
