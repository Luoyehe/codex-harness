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

The [complete historical failure review](../verification/reports/reviewed-checks-history.md) indexes workflow runs 1–59, including the former Affected checks name: 26 failures and 3 cancellations reviewed separately. Read its cause-specific evidence and remaining limits before selecting tests. This is a fixed historical snapshot, not an automatically refreshed dashboard.

The selector is a manual mapping, not a complete dependency graph. For shared fixtures, search imports, direct construction, `setUp()` composition, instance method replacements and cleanup, then add every actual affected consumer to the targeted plan. Known unmapped edges include control-update fixtures consumed by root configuration/lifecycle tests, root lifecycle setup consumed by candidate-archive tests, execution-mode setup consumed by proxy-transaction tests, and journal-schema fixtures consumed by root journal-recovery tests. Test-only edits and hand-picked targets also do not inherit the full Web partition. Before another candidate, explicitly map each previous failed assertion to its preserved review, repair, consumer checks and actual verification; the preflight does not currently enforce that mapping. Record the root system Python separately from the standard matrix's exact Python pin. These are required manual checks, not claims that the remaining automation gaps have been implemented.

Parameterized tests need a unique full name for every scenario. A status such as `completed` may describe several different cases, so include a distinct scenario label rather than only that shared status. Check the targeted runner's final evidence result, not just Vitest's passing assertions: duplicate case identities invalidate aggregation even when the assertions pass. Keep that failed evidence and rerun only the affected module after fixing the names.

History/sorting fixtures that create several independent operations must use distinct semantic scopes or finish the previous operation first. Reusing the same method and unresolved scope correctly trips duplicate-intent protection before the sorting assertion; fix the fixture rather than weakening that protection.

### Required review of every failed Reviewed checks run

Before submitting the next candidate, retain a failure review with the failed commit, run URL/ID, attempt, job IDs and complete-log evidence. Distinguish actual failed assertions from intentionally failing subprocess fixtures, upstream job failures and downstream jobs that correctly refuse incomplete evidence. Do not invent a test count or coverage result when the aggregation did not finish.

For each distinct cause, record:

1. What failed and the evidence establishing the cause. Separate a product defect, an invalid fixture, an environment mismatch and an external failure; mark an unconfirmed explanation as unconfirmed.
2. Why the previous affected-test selection, review or preflight missed it.
3. The repair and the search for analogous callers, fixtures and supported environments.
4. A concrete prevention measure, such as a regression assertion, a broader affected-test selection or an explicit preflight rule. "Be more careful" and "rerun CI" are not prevention measures.
5. The exact targeted verification, untested platforms/integrations and the next candidate's eventual CI result. Keep the original failed run and its evidence even after the repair passes.

Before choosing affected tests, consult the retained reviews and the rules below. Preserve expected behavior, privilege boundaries, recovery assertions and platform coverage. Do not solve fixture failures by dropping cases, broadly mocking validation, increasing timeouts, adding arbitrary sleeps or retries, or suppressing a failed gate. Waiting for an evidenced protocol prerequisite, such as the pinned CLI's activation-key guard, must be tied to the observed protocol state and documented separately from timeout inflation. Reopen the source-bound audit/authorization when a repair changes its snapshot; rerun the authorized full matrix only after that gate is satisfied. These records belong in repository audit evidence; the user README should remain deployment and usage guidance.

### v2.3.2 candidate: missed fixture dependencies

The first independent-conversation-copy candidate (commit `b1ffa2517112c9a61f0d6db05e9f9dbc10f1eafb`, Reviewed checks run `41316151654`) exposed gaps in affected-test selection. Its Security checks passed, but its test matrix failed; it was not deployable. The coverage job correctly rejected failed Linux evidence. The repairs below change fixtures and strengthen independence assertions; they do not establish a Linux pass until the subsequent Linux run completes.

| Change that affected fixtures | Why it escaped earlier checks | Prevention before another candidate |
| --- | --- | --- |
| Native launch adds fixed Codex `-c` arguments | A lifecycle fixture launched Node with `-e`, so the appended `-c` became Node's conflicting `--check`; Windows job fixtures also asserted the obsolete argument list. | For launcher-argument changes, search every launcher caller and command wrapper. Run lifecycle and exact-argument/escaping tests, including Windows descendants and cleanup. Use a script file when the fake executable must accept arbitrary CLI arguments. Preserve delays, cleanup and quoting assertions. |
| Candidate installation now validates application capability metadata | Synthetic legacy packages lacked `app/package.json`; root-only verification also missed ordinary-UID ownership assumptions. | Trace archive, install, update, migration, recovery and journal fixture builders when package validation changes. Give synthetic packages explicit valid legacy metadata before sealing. Exercise affected ordinary/root pairs with real file ownership. Keep malformed-package and downgrade rejection tests. |
| Existing conversations filter models by their bound provider | A default-settings UI fixture supplied model IDs without the provider metadata now required by the real response contract. | For a filtering/selection change, inspect all mock catalog, thread and session responses against the protocol. Test defaults, inherited selection and outgoing model/effort together, including loading and missing metadata; do not remove the filter just to satisfy an incomplete fixture. |
| Failed upstream test jobs reach coverage aggregation | A downstream red check can be mistaken for another product or coverage defect. | Read the complete upstream job results first. Preserve coverage's refusal of missing or failed inputs; report incomplete deduplication/coverage as unavailable, never as zero gaps. |

The detailed retained CI1 review binds the complete job logs, API results, repair evidence and limitations. Subsequent failures must add their own review and update these rules when they reveal another reusable cause; this table is not a substitute for reviewing each run.

The next candidate (`a85e69161fec94fb9c9389536efe2c743ab5ccd5`, Reviewed checks run `41318007104`) exposed a composed-fixture dependency missed in that repair. The ordinary installation fixture replaced `release_accounts` with a token-only result; the root account-recovery suite calls that fixture's `setUp()` and reuses its manager. Restoring only `verify_release` left the account check replaced, so two real downgrade assertions failed. This was a fixture regression, not evidence that production allowed an authentication downgrade.

When changing a shared fixture, search imports, direct instantiation, `setUp()` calls, method rebinding and cleanup as well as class inheritance. Keep real boundary readers in consumers that exercise those boundaries, and run the affected ordinary and root consumers under their actual identities. The selector now groups installation recovery, root release reuse and root account recovery bidirectionally; its regression requires the exact group and refuses a missing companion. Preserve the failed run and original downgrade assertions; targeted results do not replace the next candidate's full CI.

v2.2.0's failures fell into distinct categories. Ordinary-user deployment fixtures incorrectly assumed root ownership or mocked `chown` when the implementation used `fchown`; malformed saved profiles no longer represented valid inputs. Several UI tests waited for visible text while preview consent, IndexedDB acceptance or a later operation-list read was still pending. Fix those with controlled promises, awaited `act`, actual enabled-state/fresh-consent assertions, and completion of the real mutation promise—not sleeps, retries, global timeout increases or relaxed assertions.

An automation interruption also exposed a real runtime history/lifecycle consistency gap; the exact hosted interleaving was not reproduced. Windows native worker crashes prompted alignment with the already pinned deployment Node runtime; upstream fixes were verified, but no crash dump established the exact historical cause. Preserve those distinctions when diagnosing a new red run.

A full PR run and a selected push run can differ: in v2.2.0 CI10, the complete 232-file/2468-case run passed while three cases failed in the separately selected run. Keep that historical failure; do not reinterpret it as success. The new trigger policy deliberately avoids paying for both topic matrices, while retaining every test in an authorized full PR run and retaining main/manual validation. Fewer duplicate runs are not permission to weaken test readiness or release gates.

For deployment changes, verify the entire supported old-state upgrade and recovery sequence in an isolated fixture. Legacy sudo and shared lock-mode incompatibilities were discovered after earlier full CI passes. Manual permission changes on the real server cannot stand in for a product migration test. Unknown mutations retain their original IDs; inspecting a receipt never authorizes replay.
