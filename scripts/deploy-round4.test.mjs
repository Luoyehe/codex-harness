import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const python = process.env.CODEX_TEST_PYTHON || "python3";
const available = spawnSync(python, ["-I", "-c", "import tomllib"], { windowsHide: true }).status === 0;
test("deployment rollback, provider predecessor retention and shared portal removal regressions", {
  skip: !available && "Python 3.11+ required",
}, () => {
  const result = spawnSync(python, ["-I", fileURLToPath(new URL("./deploy-round4.test.py", import.meta.url))], {
    encoding: "utf8", timeout: 60000, windowsHide: true,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
