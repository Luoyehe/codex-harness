# Release checks and test orchestration

Candidate **v2.2.0** completed one clean full-repository audit of 1,941 files on source `2fa91dccad09fdd474ec433628391235352afc8bde924f05a34608c0c314e36f`, following the user's latest one-clean-round requirement. See [round 4](audit-evidence/v220-round4/team.json). The [first hosted attempts](audit-evidence/v220-ci-repair/first-attempts.json) and [second complete attempt](audit-evidence/v220-ci-memory/ci2-failure.json) failed and remain recorded. CI2 passed Windows, Linux root and security checks; its Linux memory-settings fixture failed, so the complete result is not a pass.

Ten subsequent changes are confined to tests. Independent [first repair review](audit-evidence/v220-ci-repair/carry-forward.json) and [memory fixture review](audit-evidence/v220-ci-memory/carry-forward.json), with complete inventory hash comparisons, retain the actual audit for unchanged production/configuration/protocol files. No extra full audit round is claimed. Current source is `14158d3f46a6728c06fb33d7d7f0f2c5d628b8259178d2992f35d0bcc750965f`. The first Windows preview worker crash remains unexplained; that file passed the complete CI2 Windows run and has no exemption. The [exact-source authorization](audit-evidence/release-closeout/authorization.json) permits a fresh complete run. Full validation, publication and deployment remain pending.

Release **v2.1.1** is validated for publication. The full Windows/Linux/Linux-root baseline passed **210 files, 2,148 distinct cases, zero failures and zero coverage gaps** on source `99521cf29d49d5e16142131ef1dad1f21ad73465ed478f0da6238669e9b1e561`. Five subsequent source-file changes are confined to test synchronization, portable expired-certificate fixtures and CI Go diagnostics. They passed focused local checks and [hosted validation](https://github.com/Luoyehe/codex-harness/actions/runs/40961333197) of **61 affected files, 708 distinct cases, zero coverage gaps** on `02c53be78839a7e585b962d7b81907ae774604b37e63ff09a089b5d70eddd723`; [Security checks](https://github.com/Luoyehe/codex-harness/actions/runs/40961314362) also passed. This preserves the actual scope of both results rather than claiming another full suite on the final digest.

[Final scope](audit-evidence/v211-release/final-scope.json), [hosted CI](audit-evidence/v211-release/hosted-ci.json), [first focused repair](audit-evidence/v211-release/ci-followup.json) and [portable expiry fixture](audit-evidence/v211-release/https-fixture-followup.json) preserve the failed attempts and their subsequent checks. The initial Windows Go preparation failure did not recur; its precise original cause remains unestablished. The cancelled single-fixture push run was superseded by the explicit all-followup selection.

Rounds 24 and 25 remain complete reviews of baseline `0b770f6c1a7323484af2db9ce2c7c7d0b90b8cafd474cc664cd649a60161c281`. The terminal-test [carry-forward judgment](audit-evidence/public-https-test-delta/carry-forward.json), later focused repairs and independent reviews add no full-audit rounds; `consecutiveClean` remains 0. The prior [full result](audit-evidence/public-https-full-attempt4/reconciled-result.json), [execution record and hashes](audit-evidence/public-https-full-attempt4/evidence-manifest.json), and source-bound authorization remain unchanged historical evidence; that authorization does not authorize a different source digest.

Host 120 remains active and enabled on HTTPS port **10000**. Application and deployment bytes are identical to the accepted deployed source; final changes affect only tests and CI, so no service restart was needed. Fresh AliDNS DNS-01 production issuance, strict public HTTPS, real edge WebSocket, login/logout and session recovery across an actual gateway/worker restart passed. Automatic renewal is configured; future aged renewal and live issuance by the other five providers were not tested. Earlier intermittent relay pre-TLS failures remain recorded; the final external acceptance used zero retries. See [deployment](audit-evidence/v211-release/deployment.json), [public acceptance](audit-evidence/v211-release/public-acceptance.json), [restart](audit-evidence/v211-release/restart.json), [transport history](audit-evidence/v211-release/transport-history.json), and [browser checks](audit-evidence/v211-release/browser.json). No paid inference or live external MCP acceptance is asserted.

The live CodeQL list has 14 open alerts: 11 current-source alerts received scoped review, and three belong to removed legacy paths. No actionable current defect was established; no alerts were dismissed. The new three alerts and updated location for alert 11 have [explicit evidence](audit-evidence/v211-release/codeql-review.json). Successful scanning is not presented as a zero-alert result. README and the deployment guide were rechecked against current CLI behavior, including six DNS providers, user-selected ports and upgrade steps.

Release acceptance (2026-10-27, v2.1.0): complete independent rounds 7 and 8 passed on unchanged source `69ed531f90c07a0dca44e876b0adafa009952a26a2133494e41bf636eb13b589`, covering all 1,862 files with matching boundary hashes, no findings and no skips. This satisfies the user's explicit two-round gate. Commit `a61ab4a9074232fdc75ad015d0ab789018bf9a8f` then passed the complete hosted Windows/Linux/Linux-root suite: **182 test files, 1,677 distinct cases and zero coverage gaps**. Platform skips retain their reported status and are complemented by passing cases on the appropriate platform. All security jobs passed; eight current-source CodeQL alerts received individual source review, not a zero-alert claim. See [audit evidence](audits.json), [hosted CI](audit-evidence/v210-release/hosted-ci.json) and [CodeQL review](audit-evidence/v210-release/codeql-review.json).

Host 120 runs the same source with built-in accounts. The actual HTTPS migration preserved its address and ports; strict TLS validation passed. Strict-TLS HTTPS and real gateway WebSocket acceptance passed 12 checks before and 4 after an independent root CLI restart, including the same remembered session and all 36 pre-migration accepted business receipts. Gateway, worker and Caddy remain active/enabled; the Authelia service was stopped and removed. Browser direct login, account settings, refresh persistence, logout/relogin, project files and service-status reads passed. Operator-only candidate-budget and HTTP-port guard refusals were inspected and retained before explicit corrected attempts; frozen product source was unchanged. See [deployment](audit-evidence/v210-release/deployment.json), [operator execution](audit-evidence/v210-release/operator-execution.json) and [browser evidence](audit-evidence/v210-release/browser.json). No paid inference, real external MCP, public DNS/ACME or third-party business success is asserted. Historical results below retain their original source scope.

Browser follow-up (2026-10-26): after the user handled the test certificate warnings, desktop interaction acceptance passed for two-layer login, workbench/settings, files/Git, receipt preview, a real shell roundtrip, draft/preference persistence, original-page reauthentication recovery, and the empty automation list. No product change was required; all four services remain active/enabled. The v2.0.1 tag and deployed source are unchanged. See [scoped browser evidence](audit-evidence/v201-release/browser.json), including untested interactions.

Release validation completed (2026-10-26, v2.0.1): commit `0466fb96a7b389e3631c060572cd0761db213f6d`, source digest `4ad01fbc1f966f25e9bfa6ede3c03ceefa1ef60d316dc256d9fca951e13cc289`, passed the complete hosted Windows/Linux/root suite: **170 test files, 1,478 distinct cases and zero coverage gaps**. Original platform skips remain recorded and are complemented by passing cases on the appropriate platform. Security jobs also passed; eight current-source CodeQL alerts have a separate manual review, not a zero-alert claim. The final 120 deployment passed integrity checks, an actual restart, and 22/24 HTTPS acceptance checks before/after restart; all four services remain active and enabled. See [hosted CI evidence](audit-evidence/v201-release/hosted-ci.json), [deployment evidence](audit-evidence/v201-release/deployment.json), and [CodeQL review](audit-evidence/v201-release/codeql-review.json). The earlier [local full-test summary](audit-evidence/v201-release/full-summary.json) and implementation-phase statements below retain their historical source scopes.

These tools were written for the clean-room repository. No archived source, test,
build file or Git history was used. They do not establish release readiness by
themselves. The authoritative acceptance catalogue remains
`PROBLEM-ACCEPTANCE.md`, especially QA-01, QA-02 and QA-03.

## Source and Git-object scans

```text
node scripts/release-audit.mjs --source
node scripts/release-audit.mjs --git-objects
```

The default/source inventory is this repository's tracked and non-ignored
untracked files. Tracked ignored files are still scanned; tracked working-tree
deletions are absent from the release source. Normal ignored dependency trees,
runtime homes and evidence are outside this inventory. The separate Git-object
mode scans all objects available in this repository, including dangling objects,
and reports object IDs instead of historical content. It is not a claim about
unfetched remote objects. It does not modify or delete Git history.
Tree names use NUL framing and complete parent paths, including shared and
dangling subtrees. Missing ordinary tree/blob members fail the scan; gitlinks
belong to external repositories and do not trigger implicit network fetches.

Every selected regular file is streamed in full, including binary files and long
lines. There is no size-based pass or truncation rule. Read failures, a changed or
missing inventory entry, symlinks and special files produce `incomplete` and a
nonzero exit. No source file or fixture is exempted from content rules. Generated
paths and private file names produce separate `artifacts` entries. Matches emit
only path, line and rule; failures add a bounded error code. No matching content,
credential or OS error text is printed. `clean` exits 0; `blocked` and
`incomplete` exit 1. `skipped` and `unreadable` are separately represented.
Abnormally long separators after credential labels, Bearer prefixes or Windows
drive/home prefixes are conservatively blocked before the retained streaming
window is exceeded. This avoids chunk-dependent misses without retaining an
unbounded line or treating a layout overflow as a pass.

Rules cover private-key headers, known token shapes, long literal credential
assignments, bearer values, credentials in URLs, personal Windows/POSIX home
paths, private credential files and generated residue. This is a defined
heuristic check, not a proof that every possible secret encoding has been found.
Fixtures that need recognizable malicious strings construct them at runtime in
ignored isolated directories; weakening scanner rules or excluding tests is not
the remedy for a fixture finding.

## Affected selection and CI

Current source must pass the unchanged scanner with zero findings. The full Git
object scan also retains all pre-rewrite branches/tags. Thirty-two findings in immutable old
blobs were inspected individually: synthetic rejection-test URLs/tokens, generic
path placeholders and one variable-based runtime path, not real credentials.
`scripts/reviewed-history.mjs` classifies only those exact blob/line/rule tuples,
refuses them in the current source tree, and retains both raw and reviewed reports.
Any changed object, additional finding, unreadable content, artifact or skipped
object blocks CI. It neither rewrites public history nor relaxes scanner rules.

```text
node scripts/select-tests.mjs --base <commit-id> --head <commit-id>
node scripts/select-tests.mjs --run unit --changed web/components/Composer.tsx
node scripts/select-tests.mjs --run deploy --changed deploy/install.py
node scripts/select-tests.mjs --run native --changed src/runtime/service.ts
```

`--changed` consumes the remaining arguments. The normal CI uses explicit base
and head commit IDs and `git diff --no-renames`: both sides of a rename remain
visible, and deleted source files retain their domain mapping. Unknown paths,
missing mapped regressions, deleted tests, privileged integration helpers,
dependency/build metadata, an unavailable base commit and an empty diff produce
`requires-full-audit` (exit 2). A selection covering the complete JavaScript or
repository test inventory also requires the audit gate. This status does not
authorize a full run automatically.

| Changed area | Selected behavior checks |
| --- | --- |
| `src/core` | Core, gateway and runtime regressions, including native boundaries |
| `src/gateway` | Gateway and gateway/native chain; manager client also maps Python deployment tests |
| `src/runtime`, `protocol` | Runtime and gateway regressions, including native smoke, gateway chain and approval suites |
| `web` | Browser behavior tests; web build configuration requires audit |
| `deploy` | `tests/deploy/**/test_*.py`, using Python, not Vitest |
| Existing test | That exact file; deleted tests require coverage review |
| Runtime fixture | Runtime regression domain |
| Release, selection, snapshot and test-runner scripts | Their tooling tests and dependent gate tests |
| Known CI workflow and source-inventory policy | Tooling checks; a new unmapped workflow requires audit |
| Recognized prose/audit evidence | `no-behavior-change`, explicitly no test pass |

The mapping is deliberately conservative within a domain, and it is a statement
of selected regressions rather than a line-coverage guarantee. If a group has no
affected test, its result is `not-affected`, not `passed`. Missing Python/native
dependencies or skipped platform tests produce `skipped` (exit 3). Test failures
exit 1. Python requires 3.11 or newer and can be located with
`HARNESS_TEST_PYTHON`; every selected Python file must collect at least one test.

`.github/workflows/affected.yml` runs source security, pinned dependency install,
type/build checks and selected JavaScript/Python tests on branch push and pull request.
The exact selected inventory runs on Linux and Windows; privileged fixtures run
separately as root on a disposable hosted Linux runner. A final job checks each
case identity, source digest and outcome: every skipped case needs a pass on an
appropriate platform, and missing or failed artifacts block completion. Actions
are pinned by commit; Node is 24.15.0 and pnpm is 11.22.0. A zero/missing base
requires an explicit reviewed comparison or the base from the source-bound
closeout authorization. It never silently substitutes `HEAD~1`. Tag pushes do
not start an invalid zero-base comparison. CI does not create audit records,
call a paid model or access a personal Codex home. Separate workflows run CodeQL,
dependency vulnerability checks and read-only upstream version detection.

Native jobs fetch official platform packages for CLI 0.164.0 into ignored
`reference/runtime`, verify pinned SHA-512 archive integrity, extract them and
derive the single native executable path. The runner requires the explicit
absolute `HARNESS_TEST_CODEX_BIN`, checks independent package metadata and
executes `--version` with separate isolated home and temporary directories. It
never guesses a binary from PATH. Local package provenance must already have
been established, as documented in `reference/PROTOCOL-CONTRACT.md`; a matching
version string alone is not proof of an untampered binary. CI additionally checks
the distribution bytes. Missing preparation is a skip/failure, never a native
test pass.

## Full-audit gate

`node scripts/run-tests.mjs --full` is the full-test entrypoint. It accepts no
test filters. `--targeted` accepts existing exact test files,
deduplicates them, and refuses empty, directory, traversal and complete-suite
selections. The Vitest invocation excludes unselected files because positional
Vitest filters are substring matches. JSON results must name exactly the selected
files and contain actual test assertions; skipped/todo assertions remain a
nonzero coverage gap. `.only` is disallowed.

The full mode snapshots the current source and normally validates the last three audit
rounds before executing either engine. An explicit maintainer-directed closeout
can instead use `--authorization <record.json> --sha256 <checksum>`: the record
must bind the current source digest/file count, package version, reviewed base,
actual user instructions, waived audit rounds, reviewed fixes and no unresolved
blockers. This is an authorization, not evidence of three clean audits. The
current release record is `verification/audit-evidence/release-closeout/authorization.json`.
CI uses the same validation and exact full inventory when metadata or change
scope requires a full run. Stale records cannot authorize a different source.
It requires native and Python prerequisites
up front, then includes all JavaScript/native tests and the Python deployment
suite. Fixture tests of this orchestrator replace both engines with spies; they
never execute a real full suite.

The existing `verification/audits.json` stays schema version 1. Each of the last
three rounds must contain:

- A distinct `id`, consecutive positive `sequence`, current source `digest`,
  `complete: true`, and empty `findings` and `skipped` arrays.
- Ordered `startedAt` and `completedAt` timestamps. The next round starts only
  after the previous round completes; future completion times are rejected.
- All four scopes: `gateway-core`, `runtime-protocol`, `web-ux` and
  `deployment-release`.
- `reviewers`, each with a distinct `id` across the three rounds, assigned
  `scopes`, an `evidence` path and its `sha256`. Every scope must be covered by
  reviewer evidence in every round.

Each evidence file must be a regular JSON file at
`verification/audit-evidence/<round-id>/<reviewer-id>.json`. It records
`schemaVersion: 1`, `roundId`, `reviewerId`, the source `digest`, `complete: true`,
empty `findings` and `skipped`, the claimed `scopes`, a concrete `method` description
and nonempty repository-relative `inspectedFiles`. The gate validates identity,
scope, source and checksum consistency. Claimed scopes must identify inspected
files in their relevant areas: core and gateway; runtime and generated protocol;
web; deployment and release scripts/workflows, respectively. Reviewers must attach evidence from their
actual independent review; distinct strings and checksums cannot by themselves
prove that a human or agent really performed an independent audit. That remains
an auditable process obligation. Neither scripts nor CI manufacture those records.

Snapshot identity includes file names, executable bits and content hashes.
Only `verification/audits.json`, `verification/WORKLOG.md`, this report, regular
audit-evidence JSON paths and `verification/reports/*.md` are excluded to avoid
self-referential hashes. Other files under `verification`, including executable
source or configuration, remain in the digest. Any source fix changes the digest
and invalidates previous clean rounds.

## Evidence and remaining limits

The tooling regressions cover streaming large/binary input, split token/line
boundaries, error redaction, unreadable/nonregular paths, forced tracked ignored
artifacts, deletion, dangling Git objects, rename mappings, missing coverage,
metadata/full-inventory refusal, dependency skips, audit evidence tampering,
reviewer/scope/order violations, source changes and executable files under
`verification`. Python negative fixtures prove zero-collection rejection and
nonzero skip handling. They are independent test data in `.work`.

The following implementation-phase record is historical (2026-10-25), not the current v2.0.1 test or GitHub Actions status.

The implementation run executes only `tests/tooling/release-audit.test.ts`,
`tests/tooling/select-tests.test.ts` and `tests/tooling/run-tests.test.ts`, plus
source scanning and safe CLI/prerequisite checks. It does not execute the full
suite or claim three clean audits. The GitHub workflow has not been run on GitHub
in this session; its Linux/Windows package preparation and actual native jobs
remain CI integration evidence to obtain. Local source scans must be repeated
after the final integration snapshot. Browser/IME, online account/provider/MCP,
isolated Linux/systemd and migration acceptance remain separate evidence.

Latest local directed evidence (2026-10-25, before final integration freeze):
all 26 tooling assertions in the three files passed under Node 24.15.0; the
machine-readable report is `.work/test-results/run-hXvz5c/vitest.json`. The
Python zero-collection and skip fixture diagnostics are expected negative-test
output; no project deployment suite was executed by those fixtures. The source
scan at the preceding integration checkpoint read 1,501 files / 5,949,811 bytes
and returned `clean`, with zero findings,
artifacts, unreadable entries or skips. The actual independently prepared Windows
CLI prerequisite reported `codex-cli 0.164.0` from the required runtime location;
this check only ran `--version`, not native integration tests.

The full-audit gate now also requires each round's combined inspected-file inventory to cover every file in the immutable source snapshot (including tests, configuration, documentation and generated protocol), rather than merely one example from each area. Independent provenance/contract regeneration may establish generated-file inspection; it must be described in that reviewer's method and supported by actual evidence, not inferred from scope labels. The new partial-inventory negative fixture passed together with the other gate tests (11 checks in `.work/test-results/run-9yHMUi/vitest.json`).

### 2026-10-26 — v2.0.0 complete platform verification

Frozen source `96cde170ad50eb50753feb3229881ce609f6d3328691ffee5c479105803963d1` passed complete case reconciliation: **1,343 distinct cases**, 148 test files, zero failing cases and zero coverage gaps. Windows and Linux unprivileged full runs retain their original exit 3 for platform skips; the independent Linux root subset passed 69/69. All 236 skipped observations have an exact passing counterpart on the same source. Both platform process controllers confirmed cleanup and unchanged source. Detailed counts, immutable raw-evidence hashes and limitations are in [the full-test summary](audit-evidence/v2-release/full-summary.json). This is the user's explicitly authorized direct-to-full workflow; historical audit rounds remain unchanged.

### 2026-10-26 — persistent 120 deployment

The reviewed control update, provider-layer migration and application update completed for `crtest-rw-20261025` on 120. Native user configuration was preserved. Release `57434193056c8166dc4786f3686564ae7ee0cff0566a5fb7d63be81bb24047a8` contains v2.0.0 with Codex 0.164.0. Verification checked 20131 files plus permissions and managed units. Twenty-two real internal-CA HTTPS checks passed, including edge-to-gateway WebSocket, double authentication, file/Git helpers, bundled CLI diagnostics, attachment replay and native PTY disconnect cleanup. Four services remain active and enabled; the worker is connected and idle with no pending transaction.

[Deployment evidence](audit-evidence/v2-release/deployment.json) retains exact results. Browser visual acceptance is separately pending user handling of the internal-CA warning. Real commercial providers, public DNS/ACME and external firewall access were not exercised. GitHub publication is recorded separately.

### 2026-10-26 — v2.0.1 complete platform verification

Frozen source `aaf648ede72d410cbebd6b66e11020024d7affc4f82d1cbe47929fa05f734803`, tested at commit `a3ec164b7c4c0aaf1f91b535ba4799e7a0fe2fb1`, passed the third complete platform reconciliation: **167 test files, 1,465 distinct cases, zero failing cases and zero coverage gaps**. All three raw reports bind the same source digest before and after execution. The source-bound closeout authorization covers 1,836 source files; it does not manufacture three clean audit rounds.

| Target | Files | Passed observations | Skipped observations | Original exit |
| --- | ---: | ---: | ---: | ---: |
| Windows | 158 | 1,299 | 93 | 3 |
| Linux ordinary user | 158 | 1,378 | 14 | 3 |
| Linux root fixtures | 9 | 73 | 0 | 0 |

These are 2,857 observations across the three targets, not 2,857 independent cases. Every one of the 107 skipped observations has an exact file/case match that passed on an applicable platform at the same source digest. Original skips, group results and exit codes remain unchanged. [The machine-readable summary](audit-evidence/v201-release/full-summary.json) retains all skipped identities and their passing targets, SHA-256 hashes of the original platform reports, the reconciliation result, test plan and authorization reference. Earlier failing attempts remain historical evidence and are not counted as this successful run.

Real pinned Codex CLI checks use isolated homes and loopback protocol substitutes; they do not establish commercial model, real external MCP, account/OAuth, voice or authenticated cloud acceptance. Browser/IME, public DNS/ACME and external firewall or third-party identity-provider checks need separate evidence. Final GitHub Actions acceptance, the v2.0.1 update on 120 and formal Release publication remain separate, ongoing closeout work at this checkpoint; the earlier v2.0.0 deployment entry does not prove those v2.0.1 steps complete.
