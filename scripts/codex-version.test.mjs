import assert from "node:assert/strict";
import test from "node:test";
import { assertCodexVersion, expectedCodexVersion, PINNED_CODEX_VERSION } from "./codex-version.mjs";

test("native regressions default to the strict supported CLI pin", () => {
  assert.equal(expectedCodexVersion({}), PINNED_CODEX_VERSION);
  assert.doesNotThrow(() => assertCodexVersion(`codex-cli ${PINNED_CODEX_VERSION}\r\n`, PINNED_CODEX_VERSION));
  assert.throws(() => assertCodexVersion("codex-cli 0.165.0", PINNED_CODEX_VERSION));
});

test("upstream compatibility candidates require an exact stable version and exact CLI output", () => {
  const expected = expectedCodexVersion({ HARNESS_EXPECTED_CODEX_VERSION: "0.165.0" });
  assert.equal(expected, "0.165.0");
  assert.doesNotThrow(() => assertCodexVersion("codex-cli 0.165.0\n", expected));
  for (const candidate of ["", "latest", "^0.165.0", "0.165.0-beta", "0.165.0 extra", "01.165.0", "0.165", " 0.165.0", "0.165.0\n", 164]) {
    assert.throws(() => expectedCodexVersion({ HARNESS_EXPECTED_CODEX_VERSION: candidate }));
  }
  for (const output of ["codex-cli 0.165.0-beta", "codex-cli 0.165.01", "wrapper 0.165.0", "codex-cli 0.165.0\nextra"]) {
    assert.throws(() => assertCodexVersion(output, expected));
  }
});
