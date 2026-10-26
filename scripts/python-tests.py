"""Run an exact Python selection and retain per-case outcomes, including skips."""
from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
import unittest
from pathlib import Path


def run(output: Path, files: list[str]) -> int:
    if not files or len(set(files)) != len(files):
        raise ValueError("Expected unique nonempty test selection")
    root = Path.cwd().resolve()
    sys.path.insert(0, str(root))
    suite = unittest.TestSuite()
    cases: dict[str, dict] = {}

    def collect(selected, file):
        for test in selected:
            if isinstance(test, unittest.TestSuite):
                collect(test, file)
            else:
                key = test.id()
                if key in cases:
                    raise ValueError("Duplicate test identity")
                cases[key] = {"id": file + "::" + key.split(".", 1)[1], "file": file, "status": "not-run"}

    for index, name in enumerate(files):
        file = Path(name)
        if file.is_absolute() or ".." in file.parts or not file.is_file() or file.is_symlink():
            raise ValueError("Expected ordinary repository-relative test file")
        spec = importlib.util.spec_from_file_location("selected_deploy_" + str(index), root / file)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        selected = unittest.defaultTestLoader.loadTestsFromModule(module)
        if not selected.countTestCases():
            raise ValueError("Selected test file is empty: " + name)
        collect(selected, name)
        suite.addTests(selected)

    class Results(unittest.TextTestResult):
        def mark(self, test, status, reason=None):
            record = cases.get(test.id()) or cases.get(getattr(test, "test_case", test).id())
            if record is None:
                # unittest uses an ErrorHolder for setUpClass/Module failures
                # and skips. Attribute those outcomes to the collected cases.
                match = re.search(r"\((selected_deploy_\d+(?:\.[A-Za-z0-9_]+)?)\)$", test.id())
                affected = [value for key, value in cases.items() if match and key.startswith(match.group(1) + ".")]
                if not affected:
                    raise ValueError("Unrecognized unittest fixture outcome: " + test.id())
                for value in affected:
                    value["status"] = "failed" if status == "failed" or value["status"] == "failed" else "skipped"
                    if reason:
                        value["reason"] = str(reason)[:1024]
                return
            rank = {"not-run": 0, "passed": 1, "skipped": 2, "failed": 3}
            if rank[status] > rank[record["status"]]:
                record["status"] = status
            if reason:
                record["reason"] = str(reason)[:1024]

        def addSuccess(self, test):
            super().addSuccess(test)
            self.mark(test, "passed")

        def addSkip(self, test, reason):
            super().addSkip(test, reason)
            self.mark(test, "skipped", reason)

        def addFailure(self, test, err):
            super().addFailure(test, err)
            self.mark(test, "failed")

        def addError(self, test, err):
            super().addError(test, err)
            self.mark(test, "failed")

        def addExpectedFailure(self, test, err):
            super().addExpectedFailure(test, err)
            self.mark(test, "skipped", "expected-failure")

        def addUnexpectedSuccess(self, test):
            super().addUnexpectedSuccess(test)
            self.mark(test, "failed", "unexpected-success")

        def addSubTest(self, test, subtest, err):
            super().addSubTest(test, subtest, err)
            if err is not None:
                self.mark(test, "failed", "subtest-failed")

    result = unittest.TextTestRunner(verbosity=2, resultclass=Results).run(suite)
    values = list(cases.values())
    code = 1 if not result.wasSuccessful() or any(v["status"] in ("failed", "not-run") for v in values) else 3 if any(v["status"] == "skipped" for v in values) else 0
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"files": files, "cases": values, "exitCode": code, "platform": sys.platform, "uid": os.geteuid() if hasattr(os, "geteuid") else None}), encoding="utf-8")
    return code


if __name__ == "__main__":
    raise SystemExit(run(Path(sys.argv[1]), sys.argv[2:]))
