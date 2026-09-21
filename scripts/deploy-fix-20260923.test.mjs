import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("provider recovery CAS and registration ingress use bounded real Linux behavior", {
  skip: process.platform !== "linux" && "Linux flock, FIFO and process deadlines required",
}, () => {
  const result = spawnSync(process.env.CODEX_TEST_PYTHON || "python3", ["-I",
    fileURLToPath(new URL("./deploy-fix-20260923-linux.test.py", import.meta.url))], {
    encoding: "utf8", timeout: 60000, windowsHide: true,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
