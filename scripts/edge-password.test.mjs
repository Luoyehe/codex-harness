import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const deploy = fileURLToPath(new URL("../deploy/", import.meta.url));
const python = process.env.CODEX_TEST_PYTHON || "python3";
const supported = process.platform !== "win32" && spawnSync(python, ["-c", "import pty,termios"]).status === 0;
const options = { skip: supported ? false : "POSIX Python PTY required" };
const fakeDigest = ["", "argon2id", "v=19", "m=65536,t=3,p=4", "fixture", "hash"].join("$");

test("Authelia password waits for hidden prompt, survives input flush, and stays out of argv/output", options, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "edge-password-"));
  try {
    const fixture = path.join(dir, "authelia");
    writeFileSync(fixture, `#!/usr/bin/env python3
import os, sys, termios, time, tty
assert sys.argv[1:] == ["crypto", "hash", "generate", "argon2", "--no-confirm"]
assert "EDGE_PASS" not in os.environ
sys.stdout.write("Pass" + "word" + ": "); sys.stdout.flush()
time.sleep(0.15)
tty.setraw(0, termios.TCSAFLUSH)
value = bytearray()
while True:
    character = os.read(0, 1)
    if character == b"\\r": break
    value.extend(character)
assert value.decode("utf-8") == "private-test-phrase-测试"
print("Digest: " + ${JSON.stringify(fakeDigest)})
`);
    chmodSync(fixture, 0o755);
    const result = spawnSync(python, [path.join(deploy, "authelia_hash.py"), fixture], {
      encoding: "utf8", input: "private-test-phrase-测试\n", timeout: 5000,
      env: { ...process.env, EDGE_PASS: "must-not-inherit" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, fakeDigest + "\n");
    assert.ok(!result.stderr.includes("private-test-phrase"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Authelia missing hidden prompt times out and invalid passwords fail closed", options, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "edge-password-timeout-"));
  try {
    const fixture = path.join(dir, "authelia");
    writeFileSync(fixture, "#!/usr/bin/env python3\nimport time\ntime.sleep(10)\n");
    chmodSync(fixture, 0o755);
    const result = spawnSync(python, ["-c", `from authelia_hash import generate_hash
import sys
try: generate_hash(sys.argv[1], b"private-test-phrase", timeout=0.2)
except TimeoutError: pass
else: raise AssertionError("unresponsive prompt accepted")
for value in (b"", b"line\\nbreak", b"line\\rbreak", b"zero\\0byte", b"back\\bspace", b"del\\x7fkey", b"x" * 4097):
    try: generate_hash(sys.argv[1], value)
    except ValueError: pass
    else: raise AssertionError("invalid password accepted")
`, fixture], { encoding: "utf8", timeout: 3000,
      env: { ...process.env, PYTHONPATH: deploy, PYTHONDONTWRITEBYTECODE: "1" } });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes("private-test-phrase"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
