# Release preflight for maintainers

Run the existing affected tests during development, including ordinary/root deployment pairs and the appropriate Windows/Linux native fixtures. A topic branch without a pull request does **not** automatically start GitHub checks: use local targeted verification or `workflow_dispatch` with an explicit reviewed base. `Reviewed checks` runs on pull requests and main pushes, so a topic push with an open PR no longer launches a redundant second matrix. Security checks remain separate; CodeQL findings are not dismissed by this change.

After the user-authorized clean audit gate, create the exact source-bound full-test authorization, commit the candidate and run:

```text
node scripts/release-preflight.mjs --head <candidate-commit> --push-base <previous-head> --pr-base <current-target-head> --authorization-sha256 <exact-authorization-file-sha256> --build
```

Use the pinned Node version from `deploy/common.py`, and install dependencies with the pinned pnpm and `pnpm install --frozen-lockfile --ignore-scripts` first. `--build` invokes the existing TypeScript and Vite entrypoints; it does not install dependencies, fetch credentials, push, create a workflow run, or execute any tests. Its fixed generated output directories `dist` and `web/dist` are rebuilt from empty directories. It refuses substituted output directories or parents.

The preflight:

- Requires the supplied commit to be checked out, and compares every source filename, raw Git blob hash and executable bit with that commit. Untracked/changed source cannot be hidden by a successful prior build or Git's `assume-unchanged` flag.
- Reuses `releaseAuthorization` for the complete current-source authorization, and requires its exact bytes to be committed at the candidate. It never invents audit rounds or silently accepts a stale authorization.
- Reuses `buildCiPlan` for the previous-head push plan and PR merge-base plan. It records both exact file lists and platform targets, and requires the release PR to select the authorized full inventory. The push plan is diagnostic for a topic branch, whose push trigger is disabled; it is not an extra requested CI run.
- Checks local Node, workflow Node pins, pnpm/deployment/package pins, exact CI Python and both official CLI package versions. It checks installed TypeScript/Vite package versions against package.json. This is not a fresh dependency-install or supply-chain integrity proof.
- Writes `.work/release-preflight-build.json` only after successful builds and a second source/commit check, with hashes of every emitted artifact. A later invocation without `--build` requires that source-bound record and identical outputs. Merely finding `dist` is not evidence. Evidence-only commits may reuse a build when the entire source digest and output bytes still match.

The result is `.work/release-preflight.json`. `ready-for-ci` means these preconditions passed; it explicitly says `testsExecuted:false` and `releaseGatePassed:false`. Missing build evidence, wrong pins, stale authorization or source changes return nonzero with `status:blocked`. It does not repeat the complete historical Git-object security scan, which remains a hosted plan-step responsibility. No preflight result substitutes for actual complete CI, skip reconciliation, security review, isolated upgrade acceptance or final deployed verification.

## Lessons behind these checks

v2.2.0's failures fell into distinct categories. Ordinary-user deployment fixtures incorrectly assumed root ownership or mocked `chown` when the implementation used `fchown`; malformed saved profiles no longer represented valid inputs. Several UI tests waited for visible text while preview consent, IndexedDB acceptance or a later operation-list read was still pending. Fix those with controlled promises, awaited `act`, actual enabled-state/fresh-consent assertions, and completion of the real mutation promise—not sleeps, retries, global timeout increases or relaxed assertions.

An automation interruption also exposed a real runtime history/lifecycle consistency gap; the exact hosted interleaving was not reproduced. Windows native worker crashes prompted alignment with the already pinned deployment Node runtime; upstream fixes were verified, but no crash dump established the exact historical cause. Preserve those distinctions when diagnosing a new red run.

A full PR run and a selected push run can differ: in v2.2.0 CI10, the complete 232-file/2468-case run passed while three cases failed in the separately selected run. Keep that historical failure; do not reinterpret it as success. The new trigger policy deliberately avoids paying for both topic matrices, while retaining every test in an authorized full PR run and retaining main/manual validation. Fewer duplicate runs are not permission to weaken test readiness or release gates.

For deployment changes, verify the entire supported old-state upgrade and recovery sequence in an isolated fixture. Legacy sudo and shared lock-mode incompatibilities were discovered after earlier full CI passes. Manual permission changes on the real server cannot stand in for a product migration test. Unknown mutations retain their original IDs; inspecting a receipt never authorizes replay.
