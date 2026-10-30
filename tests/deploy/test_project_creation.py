import errno
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import call, patch

from deploy.common import DeployError
from deploy.native_launcher import create_project_from_input, project_from_input


class ProjectCreation(unittest.TestCase):
    def test_project_and_both_parent_entries_are_durable_before_success(self):
        for existing_root in (False, True):
            with self.subTest(existing_root=existing_root), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary).resolve()
                root = home / "projects"
                project = root / "new"
                if existing_root:
                    root.mkdir()
                events = []
                original_mkdir = Path.mkdir
                def mkdir(path, *args, **kwargs):
                    original_mkdir(path, *args, **kwargs)
                    events.append(("mkdir", path))
                def sync(path):
                    self.assertTrue(path.is_dir())
                    if path == home:
                        self.assertFalse(project.exists())
                    events.append(("fsync", path))
                with patch.object(Path, "mkdir", mkdir), patch("deploy.native_launcher.fsync_directory", side_effect=sync):
                    result = create_project_from_input(b'{"directory":"new"}', home)
                self.assertEqual(result, {"path": str(project), "name": "new"})
                self.assertEqual(events, [("mkdir", root), ("fsync", home), ("mkdir", project),
                                          ("fsync", project), ("fsync", root)])

    def test_parent_sync_failure_leaves_no_project_and_retry_syncs_existing_root(self):
        for existing_root in (False, True):
            for failure in (PermissionError(errno.EACCES, "injected"), OSError(errno.EIO, "injected")):
                with self.subTest(existing_root=existing_root, failure=type(failure).__name__), tempfile.TemporaryDirectory() as temporary:
                    home = Path(temporary).resolve()
                    root = home / "projects"
                    if existing_root:
                        root.mkdir()
                    with patch("deploy.native_launcher.fsync_directory", side_effect=failure) as sync:
                        expected = DeployError if isinstance(failure, PermissionError) else OSError
                        with self.assertRaises(expected):
                            create_project_from_input(b'{"directory":"new"}', home)
                    self.assertEqual(sync.call_args_list, [call(home)])
                    self.assertTrue(root.is_dir())
                    self.assertFalse((root / "new").exists())
                    with patch("deploy.native_launcher.fsync_directory") as retry_sync:
                        create_project_from_input(b'{"directory":"new"}', home)
                    self.assertEqual(retry_sync.call_args_list, [call(home), call(root / "new"), call(root)])

    def test_sync_failure_after_project_creation_is_not_a_definite_failure(self):
        for stage in ("project", "root"):
            for failure in (PermissionError(errno.EACCES, "injected"), OSError(errno.EIO, "injected"),
                            FileExistsError(errno.EEXIST, "injected")):
                with self.subTest(stage=stage, failure=type(failure).__name__), tempfile.TemporaryDirectory() as temporary:
                    home = Path(temporary).resolve()
                    root = home / "projects"
                    project = root / "new"
                    def sync(path):
                        if path == (project if stage == "project" else root):
                            raise failure
                    with patch("deploy.native_launcher.fsync_directory", side_effect=sync):
                        # DeployError would produce a replayable not_sent response.
                        with self.assertRaises(OSError):
                            create_project_from_input(b'{"directory":"new"}', home)
                    self.assertTrue(project.is_dir())

    def test_managed_project_can_be_created_opened_and_edited(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            result = create_project_from_input(json.dumps({"directory": "项目-one"}).encode(), home)
            project = Path(result["path"])
            self.assertEqual(project.parent, home / "projects")
            (project / "example.txt").write_text("editable")
            self.assertEqual((project / "example.txt").read_text(), "editable")
            self.assertEqual(project_from_input(json.dumps({"path": str(project)}).encode()), result)
            with self.assertRaises(DeployError) as duplicate:
                create_project_from_input(json.dumps({"directory": "项目-one"}).encode(), home)
            self.assertEqual(duplicate.exception.code, "project_exists")

    def test_missing_and_inaccessible_existing_directories_are_actionable(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            with self.assertRaises(DeployError) as absent:
                project_from_input(json.dumps({"path": str(home / "absent")}).encode())
            self.assertEqual(absent.exception.code, "project_not_found")
            with patch("deploy.native_launcher.os.access", return_value=False):
                with self.assertRaises(DeployError) as denied:
                    project_from_input(json.dumps({"path": str(home)}).encode())
                self.assertEqual(denied.exception.code, "project_permission_denied")

    def test_directory_names_cannot_be_paths_and_existing_content_is_untouched(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            for name in ("..", "../outside", "/outside", "a/b", "a\\b", "bad\nname", "a" * 81, "name.", "name "):
                with self.subTest(name=name), self.assertRaises(DeployError):
                    create_project_from_input(json.dumps({"directory": name}).encode(), home)
            self.assertFalse((home / "projects").exists())

    def test_occupied_default_root_is_a_definite_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            (home / "projects").write_text("keep this file")
            with self.assertRaises(DeployError) as blocked:
                create_project_from_input(json.dumps({"directory": "new"}).encode(), home)
            self.assertEqual(blocked.exception.code, "project_root_unavailable")
            self.assertEqual((home / "projects").read_text(), "keep this file")


if __name__ == "__main__":
    unittest.main()
