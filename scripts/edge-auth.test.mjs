import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
const deploy = fileURLToPath(new URL("../deploy/", import.meta.url));
const python = process.env.CODEX_TEST_PYTHON || "python3";
const options = { skip: spawnSync(python, ["-c", "import sys; assert sys.version_info >= (3,11)"], { windowsHide: true }).status !== 0 && "Python 3.11+ required" };
test("external policy review distinguishes a simple authenticated default, an unusable default and administrator-reviewed rules", options, () => {
  const result = spawnSync(python, ["-c", `from edge_auth import review_policy
for policy in ('one_factor', 'two_factor'):
    assert review_policy('access_control:\\n  default_policy: ' + policy + '\\n') == 'static-authenticated-default'
    assert review_policy('access_control:\\n  default_policy: ' + policy + '\\n  rules: []\\n') == 'static-authenticated-default'
for policy in ('deny', 'bypass'):
    for reviewed in (False, True):
        try: review_policy('access_control:\\n  default_policy: ' + policy + '\\n', reviewed)
        except ValueError: pass
        else: raise AssertionError('unusable default accepted')
for text in ('access_control:\\n  default_policy: deny\\n  rules:\\n    - domain: app.example.com\\n      policy: one_factor\\n', 'access_control:\\n  <<: *policy_defaults\\n  default_policy: one_factor\\n'):
    try: review_policy(text)
    except ValueError as error: assert 'AUTHELIA_POLICY_REVIEWED' in str(error)
    else: raise AssertionError('complex policy silently proven')
    assert review_policy(text, True) == 'administrator-reviewed-not-live-verified'
for text in ('session: {}\\n', 'access_control:\\n  default_policy: one_factor\\naccess_control:\\n  default_policy: bypass\\n'):
    try: review_policy(text, True)
    except ValueError: pass
    else: raise AssertionError('missing/duplicate policy accepted')
try: review_policy('access_control:\\n  default_policy: one_factor\\n"access_control": {default_policy: bypass}\\n')
except ValueError: pass
else: raise AssertionError('quoted duplicate silently proven')
`], { encoding: "utf8", windowsHide: true, timeout: 10000, env: { ...process.env, PYTHONPATH: deploy, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(result.status, 0, result.stderr);
});
