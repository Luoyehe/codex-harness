import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("managed TLS collections preserve multiple domains, legacy references and rollback", {
  skip: process.platform !== "linux" && "Linux no-follow descriptors required",
}, () => {
  const result = spawnSync(process.env.CODEX_TEST_PYTHON || "python3", ["-I",
    fileURLToPath(new URL("./edge-tls-multidomain-linux.test.py", import.meta.url))], {
    encoding: "utf8", timeout: 120000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
