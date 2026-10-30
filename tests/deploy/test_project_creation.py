import errno
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import call, patch

from deploy.common import DeployError
from deploy.native_launcher import create_project_from_input, project_from_input


class ProjectCreation(unittest.TestCase):
    def test_native_normalizes_current_directory_prefix_and_trailing_slashes(self):
        for directory in ("new", "./new", "new/", "./new///"):
            with self.subTest(directory=directory), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary).resolve()
                result = create_project_from_input(json.dumps({"directory": directory}).encode(), home)
                self.assertEqual(result, {"path": str(home / "projects/new"), "name": "new"})
                self.assertEqual(list((home / "projects").iterdir()), [home / "projects/new"])

    def test_payload_cannot_select_identity_or_bypass_input_budget(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            for request in ({"directory": "/new", "mode": "root"},
                            {"directory": "new", "executionMode": "root"},
                            {"directory": "new" + "/" * 4096}):
                with self.subTest(request=list(request)), self.assertRaises(DeployError):
                    create_project_from_input(json.dumps(request).encode(), home)
            self.assertFalse((home / "projects").exists())

    def test_relative_nested_dot_and_parent_paths_use_existing_parents(self):
        for directory, expected in (("group/new", "projects/group/new"),
                                    ("./group//../new///", "projects/new"),
                                    ("../new", "new")):
            with self.subTest(directory=directory), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary).resolve()
                (home / "projects/group").mkdir(parents=True)
                result = create_project_from_input(json.dumps({"directory": directory}).encode(), home)
                self.assertEqual(result, {"path": str(home / expected), "name": "new"})
                self.assertEqual(project_from_input(json.dumps({"path": directory}).encode(), home), result)

    def test_resolve_relative_never_creates_default_root_or_missing_parents(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            with self.assertRaises(DeployError) as absent:
                project_from_input(b'{"path":"missing/project"}', home)
            self.assertEqual(absent.exception.code, "project_not_found")
            self.assertFalse((home / "projects").exists())
            self.assertEqual(project_from_input(b'{"path":".."}', home), {"path": str(home), "name": home.name})
            self.assertFalse((home / "projects").exists())

    def test_missing_or_file_parent_is_definite_and_never_recursively_created(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            (home / "projects").mkdir()
            (home / "projects/file").write_text("keep")
            for directory in ("missing/new", "file/new", "file/deeper/new"):
                with self.subTest(directory=directory), self.assertRaises(DeployError) as absent:
                    create_project_from_input(json.dumps({"directory": directory}).encode(), home)
                self.assertEqual(absent.exception.code, "project_parent_unavailable")
            self.assertFalse((home / "projects/missing").exists())
            self.assertEqual((home / "projects/file").read_text(), "keep")

    def test_precreation_filesystem_errors_are_actionable(self):
        cases = ((errno.EACCES, "project_permission_denied", "不可写"),
                 (errno.EPERM, "project_permission_denied", "不可写"),
                 (errno.EROFS, "project_read_only", "只读"),
                 (errno.ENAMETOOLONG, "invalid_project_directory", "长度"),
                 (errno.EINVAL, "invalid_project_directory", "名称"))
        for number, code, message in cases:
            with self.subTest(errno=number), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary).resolve()
                project = home / "projects/new"
                original_mkdir = Path.mkdir
                def mkdir(path, *args, **kwargs):
                    if path == project:
                        raise OSError(number, "injected precreation error")
                    return original_mkdir(path, *args, **kwargs)
                with patch.object(Path, "mkdir", mkdir), self.assertRaises(DeployError) as failed:
                    create_project_from_input(b'{"directory":"new"}', home)
                self.assertEqual(failed.exception.code, code)
                self.assertIn(message, str(failed.exception))
                self.assertFalse(project.exists())

    def test_unsearchable_parent_is_distinct_from_unwritable_parent(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            with patch("deploy.native_launcher.os.access", return_value=False), self.assertRaises(DeployError) as denied:
                create_project_from_input(b'{"directory":"new"}', home)
            self.assertEqual(denied.exception.code, "project_permission_denied")
            self.assertIn("无法进入", str(denied.exception))
            self.assertFalse((home / "projects/new").exists())

    def test_readback_and_deploy_errors_after_creation_remain_unknown(self):
        for stage in ("readback", "sync"):
            for failure in (PermissionError(errno.EACCES, "injected"), OSError(errno.EROFS, "injected"),
                            DeployError("project_not_found", "injected")):
                with self.subTest(stage=stage, failure=type(failure).__name__), tempfile.TemporaryDirectory() as temporary:
                    home = Path(temporary).resolve()
                    project = home / "projects/new"
                    original_resolve = Path.resolve
                    def resolve(path, *args, **kwargs):
                        if stage == "readback" and path == project:
                            raise failure
                        return original_resolve(path, *args, **kwargs)
                    def sync(path):
                        if stage == "sync" and path == project:
                            raise failure
                    with patch.object(Path, "resolve", resolve), patch("deploy.native_launcher.fsync_directory", side_effect=sync):
                        with self.assertRaises((OSError, RuntimeError)):
                            create_project_from_input(b'{"directory":"new"}', home)
                    self.assertTrue(project.is_dir())

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

    def test_invalid_path_text_and_oversized_requests_create_nothing(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            for name in ("", "bad\nname", "bad\x00name", "bad\x7fname", "bad\ud800name", 7, None):
                with self.subTest(name=repr(name)), self.assertRaises(DeployError):
                    create_project_from_input(json.dumps({"directory": name}).encode(), home)
                with self.subTest(resolve=repr(name)), self.assertRaises(DeployError):
                    project_from_input(json.dumps({"path": name}).encode(), home)
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
