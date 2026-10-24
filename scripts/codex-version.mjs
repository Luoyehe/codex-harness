import assert from "node:assert/strict";

export const PINNED_CODEX_VERSION = "0.164.0";

// Only the upstream compatibility watch overrides this value. A candidate
// must still identify itself exactly; ordinary regressions keep the strict pin.
export function expectedCodexVersion(env = process.env) {
  const expected = env.HARNESS_EXPECTED_CODEX_VERSION ?? PINNED_CODEX_VERSION;
  assert.ok(typeof expected === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(expected),
    "HARNESS_EXPECTED_CODEX_VERSION must be an exact stable semantic version");
  return expected;
}

export function assertCodexVersion(stdout, expected) {
  assert.equal(stdout.trim(), `codex-cli ${expected}`, "isolated CLI version must match the expected version");
}
